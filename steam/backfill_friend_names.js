// Fill in friends.friend_name for rows where Steam never pushed persona info.
// Uses Steam Web API GetPlayerSummaries — up to 100 profiles per request.
//
// Usage: node steam/backfill_friend_names.js [--all]
//   --all   Re-fetch even friends that already have a name (refreshes renamed users)

const https = require('https');
const { db } = require('./db');

const STEAM_API_KEY = 'EFB5DCE316D3146FD6EFA3BECB8BCB80';
const BATCH = 100;
const refreshAll = process.argv.includes('--all');

function fetchPlayerSummaries(steamIDs) {
    return new Promise((resolve) => {
        const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamIDs.join(',')}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    console.log(`API status ${res.statusCode}:`, data.substring(0, 200));
                    return resolve([]);
                }
                try {
                    const json = JSON.parse(data);
                    resolve(json.response?.players || []);
                } catch (err) {
                    console.log('JSON parse error:', err.message);
                    resolve([]);
                }
            });
        }).on('error', (err) => {
            console.log('Request error:', err.message);
            resolve([]);
        });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const sql = refreshAll
        ? 'SELECT DISTINCT friend_steam_id FROM friends'
        : "SELECT DISTINCT friend_steam_id FROM friends WHERE friend_name IS NULL OR friend_name = ''";
    const rows = db.prepare(sql).all();
    const ids = rows.map((r) => r.friend_steam_id);

    console.log(`${ids.length} friend(s) to look up${refreshAll ? ' (--all mode)' : ''}`);
    if (ids.length === 0) return;

    const updateName = db.prepare('UPDATE friends SET friend_name = ? WHERE friend_steam_id = ?');
    const updateCountry = db.prepare('UPDATE friends SET country = ? WHERE friend_steam_id = ?');
    let filled = 0;

    for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH);
        process.stdout.write(`  batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(ids.length / BATCH)} (${batch.length} ids)... `);

        const players = await fetchPlayerSummaries(batch);
        const tx = db.transaction(() => {
            for (const p of players) {
                if (p.personaname) {
                    updateName.run(p.personaname, p.steamid);
                    filled++;
                }
                if (p.loccountrycode) {
                    updateCountry.run(p.loccountrycode, p.steamid);
                }
            }
        });
        tx();
        console.log(`got ${players.length} profiles`);

        // Be polite to the API
        if (i + BATCH < ids.length) await sleep(500);
    }

    console.log(`\nDone. Filled/updated ${filled} friend names.`);
})();
