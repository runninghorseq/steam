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

(async () => {
    const argIDs = process.argv.slice(2).filter((a) => /^\d{17}$/.test(a));
    const accounts = argIDs.length
        ? argIDs.map((id) => ({ steam_id: id, account_name: null }))
        : db.prepare('SELECT steam_id, account_name FROM accounts ORDER BY account_name').all();

    console.log(`=== Reloading friends for ${accounts.length} account(s) ===\n`);

    const existingForAccount = db.prepare(
        'SELECT friend_steam_id FROM friends WHERE account_steam_id = ?'
    );

    let grandNew = 0;
    let grandTotal = 0;
    const errors = [];

    for (const acc of accounts) {
        const label = acc.account_name ? `${acc.account_name} (${acc.steam_id})` : acc.steam_id;
        try {
            const apiFriends = await fetchFriends(acc.steam_id);
            const ids = apiFriends.map((f) => f.steamid);
            const personas = await fetchPersonas(ids);

            const known = new Set(existingForAccount.all(acc.steam_id).map((r) => r.friend_steam_id));
            const newCount = ids.filter((id) => !known.has(id)).length;

            const dbFriends = apiFriends.map((f) => ({
                steam_id: f.steamid,
                name: personas[f.steamid] ?? null,
                added_at: f.friend_since || null
            }));
            saveFriends(acc.steam_id, dbFriends);

            grandNew += newCount;
            grandTotal += dbFriends.length;
            console.log(`[${label}] ${dbFriends.length} friends (${newCount} new)`);
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
})();
