// Reusable "remove friends" worker for one account — the shared logic behind
// remove_friends_by_name.js and remove_friends_by_date.js, callable by the
// dashboard (server.js -> proxied from the Cloudflare Worker).
//
// Logs in with the account's cached refresh token (no 2FA), lists friends via
// the Steam Web API (for friend_since + persona names), selects which to remove,
// removes them, then deletes the removed rows from the local friends table and
// mirrors the account's friends into D1 so the dashboard reflects the change.
//
// removeFriends({ username }, {
//   mode: 'name' | 'date',
//   names: [...],                 // mode 'name': persona names and/or 17-digit steamIDs
//   dateFrom, dateTo,             // mode 'date': unix epoch bounds (inclusive) on friend_since
//   excludeNames: [...],          // never remove these (case-insensitive) — mode 'date'
//   dryRun: true,                 // select + report, remove nothing (DEFAULT true — destructive)
//   delay: 500, timeout: 120000, log
// })
//   -> { ok, dryRun, matched, removed: [{steamID,name}], notFound: [...], reason? }  (never rejects)

const SteamUser = require('steam-user');
const https = require('https');
const store = require('./store');

const API_KEY = 'EFB5DCE316D3146FD6EFA3BECB8BCB80';
const STEAMID64_RE = /^\d{17}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpsGetJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                if (res.statusCode !== 200 || data.trim().startsWith('<')) return reject(new Error(`API returned error: ${res.statusCode}`));
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function fetchFriendsFromAPI(steamID64) {
    const j = await httpsGetJSON(`https://api.steampowered.com/ISteamUser/GetFriendList/v0001/?key=${API_KEY}&steamid=${steamID64}&relationship=friend`);
    return (j.friendslist && j.friendslist.friends) || [];
}

async function fetchFriendNames(steamIDs) {
    const names = {};
    for (let i = 0; i < steamIDs.length; i += 100) {
        const batch = steamIDs.slice(i, i + 100);
        const j = await httpsGetJSON(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${API_KEY}&steamids=${batch.join(',')}`);
        ((j.response && j.response.players) || []).forEach((p) => { names[p.steamid] = p.personaname || 'Unknown'; });
    }
    return names;
}

function removeFriends(account, opts = {}) {
    const {
        mode = 'name', names = [], dateFrom = null, dateTo = null,
        excludeNames = [], dryRun = true, delay = 500, timeout = 120000, log = console.log,
    } = opts;
    const username = account && account.username;

    return new Promise((resolve) => { (async () => {
        const row = username && await store.accountByName(username);
        if (!row) return resolve({ ok: false, reason: `account '${username}' not found` });
        const token = await store.getRefreshToken(row.account_name);
        if (!token) return resolve({ ok: false, reason: 'no cached refresh token — run a scan/login first' });

        if (mode === 'date') {
            if (!(Number.isFinite(dateFrom) && Number.isFinite(dateTo) && dateTo >= dateFrom)) {
                return resolve({ ok: false, reason: 'mode=date needs numeric dateFrom <= dateTo (unix epoch)' });
            }
        } else if (!names.length) {
            return resolve({ ok: false, reason: 'mode=name needs at least one name/steamID' });
        }

        const tag = `[${row.account_name}]`;
        const client = new SteamUser({ renewRefreshTokens: true });
        let resolved = false;
        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            try { client.logOff(); } catch (_) {}
            resolve(result);
        };
        const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', username: row.account_name }), timeout);

        client.on('refreshToken', (t) => store.saveRefreshToken(row.account_name, t).catch(() => {}));
        client.on('error', (err) => {
            log(`${tag} error: ${err.message}`);
            if (/InvalidPassword|AccessDenied|Expired/i.test(err.message)) { store.clearRefreshToken(row.account_name).catch(() => {}); log(`${tag} cleared cached refresh token`); }
            finish({ ok: false, reason: err.message, username: row.account_name });
        });
        client.on('loggedOn', () => {
            log(`${tag} logged in: ${client.steamID.getSteamID64()}`);
            client.setPersona(SteamUser.EPersonaState.Online);
            client.gamesPlayed([]);
        });

        let handled = false;
        client.on('friendsList', async () => {
            if (handled) return;
            handled = true;
            try {
                const steamID64 = client.steamID.getSteamID64();
                const friendIDs = Object.keys(client.myFriends).filter((id) => client.myFriends[id] === SteamUser.EFriendRelationship.Friend);
                log(`${tag} ${friendIDs.length} friends`);

                const apiFriends = await fetchFriendsFromAPI(steamID64);
                const sinceMap = {};
                apiFriends.forEach((f) => { sinceMap[f.steamid] = f.friend_since || null; });
                let nameMap = {};
                try { nameMap = await fetchFriendNames(friendIDs); } catch (e) { log(`${tag} name fetch failed: ${e.message}`); }
                const nameFor = (id) => nameMap[id] || (client.users[id] ? (client.users[id].player_name || client.users[id].persona_name) : null) || 'Unknown';

                const excludeSet = new Set(excludeNames.map((n) => String(n).toLowerCase()).filter(Boolean));
                const targetSet = new Set(names.map((n) => String(n).toLowerCase()));
                const matchedTargets = new Set();
                const toRemove = [];

                for (const id of friendIDs) {
                    const nm = nameFor(id);
                    if (excludeSet.has(nm.toLowerCase())) continue;
                    let hit = false, reason = '';
                    if (mode === 'name') {
                        const byName = targetSet.has(nm.toLowerCase());
                        const byID = targetSet.has(id.toLowerCase());
                        if (byName) { matchedTargets.add(nm.toLowerCase()); hit = true; reason = 'name'; }
                        if (byID) { matchedTargets.add(id.toLowerCase()); hit = true; reason = 'steamID'; }
                    } else {
                        const since = sinceMap[id];
                        if (since != null && since >= dateFrom && since <= dateTo) { hit = true; reason = `since ${new Date(since * 1000).toISOString().slice(0, 10)}`; }
                    }
                    if (hit) toRemove.push({ steamID: id, name: nm, reason });
                }

                const notFound = mode === 'name'
                    ? names.filter((n) => !matchedTargets.has(String(n).toLowerCase()))
                    : [];

                log(`${tag} matched ${toRemove.length} friend(s) for removal${notFound.length ? `, ${notFound.length} target(s) not found` : ''}`);
                toRemove.forEach((f) => log(`${tag}   - ${f.name} (${f.steamID}) [${f.reason}]`));

                if (toRemove.length === 0) return finish({ ok: true, dryRun, matched: 0, removed: [], notFound, username: row.account_name });
                if (dryRun) return finish({ ok: true, dryRun: true, matched: toRemove.length, removed: [], notFound, username: row.account_name });

                for (let i = 0; i < toRemove.length; i++) {
                    const f = toRemove[i];
                    log(`${tag} removing ${i + 1}/${toRemove.length}: ${f.name} (${f.steamID})`);
                    client.removeFriend(f.steamID);
                    if (i < toRemove.length - 1) await sleep(delay);
                }
                await sleep(2000); // let Steam process the last removals

                // Reflect the removal in the data store (D1 or local).
                try {
                    await store.removeFriendRows(row.steam_id, toRemove.map((f) => f.steamID));
                } catch (e) { log(`${tag} store update after removal failed: ${e.message}`); }

                log(`${tag} removed ${toRemove.length} friend(s)`);
                finish({ ok: true, dryRun: false, matched: toRemove.length, removed: toRemove.map((f) => ({ steamID: f.steamID, name: f.name })), notFound, username: row.account_name });
            } catch (err) {
                log(`${tag} error: ${err.message}`);
                finish({ ok: false, reason: err.message, username: row.account_name });
            }
        });

        log(`${tag} logging in via cached refresh token…`);
        client.logOn({ refreshToken: token });
    })().catch((e) => resolve({ ok: false, reason: e.message }));
    });
}

module.exports = { removeFriends };
