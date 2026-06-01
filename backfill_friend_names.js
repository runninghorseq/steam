// Fill in friends.friend_name for rows where Steam never pushed persona info.
// Uses Steam Web API GetPlayerSummaries — up to 100 profiles per request.
//
// Usage: node steam/backfill_friend_names.js [--all] [--account <name_or_steamid>]
//   --all                          Re-fetch even friends that already have a name (refreshes renamed users)
//   --account <name_or_steamid>    Only refresh friends of the given account (matches accounts.account_name or accounts.steam_id)

const https = require('https');
const { db } = require('./db');

const STEAM_API_KEY = 'EFB5DCE316D3146FD6EFA3BECB8BCB80';
const BATCH = 100;
const args = process.argv.slice(2);
const refreshAll = args.includes('--all');

function readArg(flag) {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
    return null;
}

const accountArg = readArg('--account');

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
    let accountFilter = null;
    if (accountArg) {
        const acc = db
            .prepare('SELECT steam_id, account_name FROM accounts WHERE steam_id = ? OR account_name = ?')
            .get(accountArg, accountArg);
        if (!acc) {
            console.log(`No account found matching "${accountArg}" (checked steam_id and account_name).`);
            return;
        }
        accountFilter = acc.steam_id;
        console.log(`Filtering to account ${acc.account_name} (${acc.steam_id})`);
    }

    const where = [];
    if (!refreshAll) where.push("(friend_name IS NULL OR friend_name = '')");
    if (accountFilter) where.push('account_steam_id = ?');
    const sql = `SELECT DISTINCT friend_steam_id FROM friends${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
    const params = accountFilter ? [accountFilter] : [];
    const rows = db.prepare(sql).all(...params);
    const ids = rows.map((r) => r.friend_steam_id);

    const modeLabel = [refreshAll ? '--all mode' : null, accountFilter ? `account=${accountFilter}` : null]
        .filter(Boolean)
        .join(', ');
    console.log(`${ids.length} friend(s) to look up${modeLabel ? ` (${modeLabel})` : ''}`);
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
