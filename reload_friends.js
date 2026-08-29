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
const { db, saveFriends } = require('./db');

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

// Reload one account's friends from the Web API into the DB. Resolves with
// { ok, total, added } (never rejects here — the caller decides). Reused by the
// dashboard's per-account "Sync friends" action and the CLI below.
const existingFriendIDs = db.prepare('SELECT friend_steam_id FROM friends WHERE account_steam_id = ?');

async function reloadFriends(steamID, { log = () => {} } = {}) {
    const apiFriends = await fetchFriends(steamID);
    const ids = apiFriends.map((f) => f.steamid);
    const personas = await fetchPersonas(ids);
    const known = new Set(existingFriendIDs.all(steamID).map((r) => r.friend_steam_id));
    const added = ids.filter((id) => !known.has(id)).length;
    const dbFriends = apiFriends.map((f) => ({
        steam_id: f.steamid,
        name: personas[f.steamid] ?? null,
        added_at: f.friend_since || null
    }));
    saveFriends(steamID, dbFriends);
    log(`${dbFriends.length} friends (${added} new)`);
    return { ok: true, total: dbFriends.length, added };
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
