const https = require('https');

const ACCOUNTS = require('./steam_accounts');

// const run = Object.keys(ACCOUNTS);

run = ['ceirahoisld', 'rymutghani', 'cereocaiusmq']
// const run = ['rogersazumavbu', 'tarzidceydapd', 'radioyroepepii'];
// const run = ['ahnerblissv', 'urcialunana', 'woithsuhardy', 'konzehodorhq', 'mamermidhag', 'hovisneacexa', 'skiefarini', 'tylkahycheq', 'dibbaachenf', 'alanaawreyys', 'mekeezekaso', 'sausezamerfq', 'rietashaut', 'bootskiriln', 'lairybovisls'];
const STEAM_IDS = run.map(name => ACCOUNTS[name] && ACCOUNTS[name].steamID).filter(Boolean);

const API_KEY = 'EFB5DCE316D3146FD6EFA3BECB8BCB80';

function httpsGetJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200 || data.trim().startsWith('<')) {
                    return reject(new Error(`API returned status ${res.statusCode}`));
                }
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject(err);
                }
            });
        }).on('error', reject);
    });
}

async function fetchFriendsFromAPI(steamID64) {
    const url = `https://api.steampowered.com/ISteamUser/GetFriendList/v0001/?key=${API_KEY}&steamid=${steamID64}&relationship=friend`;
    const jsonData = await httpsGetJSON(url);
    return (jsonData.friendslist && jsonData.friendslist.friends) || [];
}

async function fetchPlayerName(steamID64) {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${API_KEY}&steamids=${steamID64}`;
    const jsonData = await httpsGetJSON(url);
    const players = (jsonData.response && jsonData.response.players) || [];
    return players[0] ? players[0].personaname : null;
}

(async () => {
    console.log(`\n=== Counting friends for ${STEAM_IDS.length} account(s) ===\n`);

    const ONE_WEEK_SECONDS = 7 * 24 * 60 * 60;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const week1Cutoff = nowSeconds - ONE_WEEK_SECONDS;
    const week2Cutoff = nowSeconds - 2 * ONE_WEEK_SECONDS;
    const week3Cutoff = nowSeconds - 3 * ONE_WEEK_SECONDS;
    const week4Cutoff = nowSeconds - 4 * ONE_WEEK_SECONDS;

    const results = [];
    for (const steamID of STEAM_IDS) {
        try {
            const [friends, name] = await Promise.all([
                fetchFriendsFromAPI(steamID),
                fetchPlayerName(steamID)
            ]);
            const displayName = name || 'Unknown';

            let week1 = 0, week2 = 0, week3 = 0, week4 = 0;
            let beforeMonth = 0;
            let unknownDate = 0;
            friends.forEach(f => {
                if (!f.friend_since) {
                    unknownDate++;
                } else if (f.friend_since >= week1Cutoff) {
                    week1++;
                } else if (f.friend_since >= week2Cutoff) {
                    week2++;
                } else if (f.friend_since >= week3Cutoff) {
                    week3++;
                } else if (f.friend_since >= week4Cutoff) {
                    week4++;
                } else {
                    beforeMonth++;
                }
            });
            const withinMonth = week1 + week2 + week3 + week4;

            console.log(`[${steamID}] ${displayName} - Total friends: ${friends.length}`);
            console.log(`[${steamID}]    Added before 1 month: ${beforeMonth} friends`);
            console.log(`[${steamID}]    Added within 1 month: ${withinMonth} friends`);
            console.log(`[${steamID}]       week 1 (0-7d):   ${week1}`);
            console.log(`[${steamID}]       week 2 (7-14d):  ${week2}`);
            console.log(`[${steamID}]       week 3 (14-21d): ${week3}`);
            console.log(`[${steamID}]       week 4 (21-28d): ${week4}`);
            if (unknownDate > 0) {
                console.log(`[${steamID}]    Unknown date: ${unknownDate} friends`);
            }

            results.push({
                steamID,
                name: displayName,
                count: friends.length,
                beforeMonth,
                withinMonth,
                week1,
                week2,
                week3,
                week4,
                unknownDate
            });
        } catch (err) {
            console.log(`[${steamID}] Error: ${err.message}`);
            results.push({ steamID, name: null, count: null, error: err.message });
        }
    }

    console.log('\n=== Summary ===');
    const total = results.reduce((sum, r) => sum + (r.count || 0), 0);
    const totalBefore = results.reduce((sum, r) => sum + (r.beforeMonth || 0), 0);
    const totalWithin = results.reduce((sum, r) => sum + (r.withinMonth || 0), 0);
    const totalWeek1 = results.reduce((sum, r) => sum + (r.week1 || 0), 0);
    const totalWeek2 = results.reduce((sum, r) => sum + (r.week2 || 0), 0);
    const totalWeek3 = results.reduce((sum, r) => sum + (r.week3 || 0), 0);
    const totalWeek4 = results.reduce((sum, r) => sum + (r.week4 || 0), 0);
    const totalUnknown = results.reduce((sum, r) => sum + (r.unknownDate || 0), 0);

    results.forEach(r => {
        const label = r.name ? `${r.name} (${r.steamID})` : r.steamID;
        if (r.count === null) {
            console.log(`${label}: ERROR - ${r.error}`);
            return;
        }
        const parts = [
            `${r.count} friends`,
            `before 1 month: ${r.beforeMonth}`,
            `within 1 month: ${r.withinMonth}`,
            `w1:${r.week1}`,
            `w2:${r.week2}`,
            `w3:${r.week3}`,
            `w4:${r.week4}`
        ];
        if (r.unknownDate > 0) parts.push(`unknown: ${r.unknownDate}`);
        console.log(`${label}: ${parts.join(' | ')}`);
    });

    console.log(`\nGrand total: ${total} friends`);
    console.log(`  Added before 1 month: ${totalBefore}`);
    console.log(`  Added within 1 month: ${totalWithin}`);
    console.log(`     week 1 (0-7d):   ${totalWeek1}`);
    console.log(`     week 2 (7-14d):  ${totalWeek2}`);
    console.log(`     week 3 (14-21d): ${totalWeek3}`);
    console.log(`     week 4 (21-28d): ${totalWeek4}`);
    if (totalUnknown > 0) console.log(`  Unknown date: ${totalUnknown}`);
})();