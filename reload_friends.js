// Reload the friends table for every tracked account using the public Steam Web
// API — no per-account login required. For each account in the `accounts` table
// we fetch its current friend list (GetFriendList) plus each friend's persona
// name (GetPlayerSummaries), then upsert into `friends` via saveFriends().
//
// This picks up newly-added friends (e.g. freshly-created accounts that have
// befriended a hub account) so that name-based tooling — like
// update_friend_country_from_file.js — can match them.
//
// Usage:
//   node steam/reload_friends.js                 # all accounts in the DB
//   node steam/reload_friends.js <steamID> ...   # only the given account steamIDs

const https = require('https');
const { db } = require('./db');
const store = require('./store');

const API_KEY = 'EFB5DCE316D3146FD6EFA3BECB8BCB80';

function httpsGetJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                if (res.statusCode !== 200 || data.trim().startsWith('<')) {
                    return reject(new Error(`API status ${res.statusCode}`));
                }
                try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
            });
        }).on('error', reject);
    });
}

async function fetchFriends(steamID64) {
    const url = `https://api.steampowered.com/ISteamUser/GetFriendList/v0001/?key=${API_KEY}&steamid=${steamID64}&relationship=friend`;
    const json = await httpsGetJSON(url);
    return (json.friendslist && json.friendslist.friends) || [];
}

// GetPlayerSummaries accepts up to 100 steamIDs per call. Returns steamid -> personaname.
async function fetchPersonas(steamIDs) {
    const names = {};
    for (let i = 0; i < steamIDs.length; i += 100) {
        const batch = steamIDs.slice(i, i + 100);
        const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${API_KEY}&steamids=${batch.join(',')}`;
        try {
            const json = await httpsGetJSON(url);
            const players = (json.response && json.response.players) || [];
            players.forEach((p) => { names[p.steamid] = p.personaname || null; });
        } catch (err) {
            console.log(`  ! persona batch failed: ${err.message}`);
        }
    }
    return names;
}

// Reload one account's friends from the Web API into the DB, reconciling both
// ways: new friends are upserted, and friends no longer on the account are pruned
// from the DB. Resolves with { ok, total, added, deleted } (never rejects here —
// the caller decides). Reused by the dashboard's per-account "Sync friends"
// action and the CLI below.
//
// fetchFriends only returns a list for a public/reachable friend list; a private
// profile makes it throw (401) before we get here, so we never prune to empty on
// an error — an empty live list means the account genuinely has no friends.
async function reloadFriends(steamID, { log = () => {} } = {}) {
    const apiFriends = await fetchFriends(steamID);
    const ids = apiFriends.map((f) => f.steamid);
    const personas = await fetchPersonas(ids);
    const known = new Set(await store.friendSteamIDs(steamID));
    const liveSet = new Set(ids);
    const added = ids.filter((id) => !known.has(id)).length;
    let deleted = [...known].filter((id) => !liveSet.has(id)); // in DB, gone from Steam
    // Guard: a 200-but-empty response (transient API glitch) would prune every
    // friend. Refuse the total wipe; a normal reload that drops some friends still
    // prunes. The next good reload reconciles if the account really hit zero.
    if (ids.length === 0 && known.size > 0) {
        log(`skipping prune — API returned 0 friends but DB has ${known.size} (treating as untrusted)`);
        deleted = [];
    }
    const dbFriends = apiFriends.map((f) => ({
        steam_id: f.steamid,
        name: personas[f.steamid] ?? null,
        added_at: f.friend_since || null
    }));
    await store.saveFriends(steamID, dbFriends);
    if (deleted.length) await store.removeFriendRows(steamID, deleted);
    log(`${dbFriends.length} friends (${added} new, ${deleted.length} pruned)`);
    return { ok: true, total: dbFriends.length, added, deleted };
}

async function runCli() {
    const argIDs = process.argv.slice(2).filter((a) => /^\d{17}$/.test(a));
    const accounts = argIDs.length
        ? argIDs.map((id) => ({ steam_id: id, account_name: null }))
        : db.prepare('SELECT steam_id, account_name FROM accounts ORDER BY account_name').all();

    console.log(`=== Reloading friends for ${accounts.length} account(s) ===\n`);

    let grandNew = 0;
    let grandTotal = 0;
    const errors = [];

    for (const acc of accounts) {
        const label = acc.account_name ? `${acc.account_name} (${acc.steam_id})` : acc.steam_id;
        try {
            const { total, added } = await reloadFriends(acc.steam_id);
            grandNew += added;
            grandTotal += total;
            console.log(`[${label}] ${total} friends (${added} new)`);
        } catch (err) {
            errors.push({ label, msg: err.message });
            console.log(`[${label}] ERROR - ${err.message}`);
        }
    }

    console.log('\n=== Summary ===');
    console.log(`Accounts processed: ${accounts.length - errors.length}/${accounts.length}`);
    console.log(`Total friends seen: ${grandTotal}`);
    console.log(`New friends added:  ${grandNew}`);
    if (errors.length) {
        console.log(`Errors (${errors.length}):`);
        errors.forEach((e) => console.log(`  - ${e.label}: ${e.msg}`));
    }
}

if (require.main === module) runCli();

module.exports = { reloadFriends };
