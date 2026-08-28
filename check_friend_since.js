// Check exactly when a friend was added, and whether the friendship is old enough
// (default: 30 days, the Steam gifting cooldown).
//
// Usage:
//   node check_friend_since.js <account> <friendSteamID> [moreFriendIDs...] [--days=30]
//   node check_friend_since.js --all <friendSteamID> [moreFriendIDs...] [--days=30]
//
//   <account>  steam login name from steam_accounts.js, or a raw steamID64
//   --all      scan every account in steam_accounts.js until the friend is found
//
// Examples:
//   node check_friend_since.js daicaso1122 76561198707730443
//   node check_friend_since.js daicaso1122 76561198707730443 76561199123456789 --days=14
//   node check_friend_since.js --all 76561198707730443

const https = require('https');
const ACCOUNTS = require('./steam_accounts');

const API_KEY = 'EFB5DCE316D3146FD6EFA3BECB8BCB80';
const CONCURRENCY = 5;

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

async function fetchPlayerNames(steamIDs) {
    const names = {};
    for (let i = 0; i < steamIDs.length; i += 100) {
        const batch = steamIDs.slice(i, i + 100);
        const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${API_KEY}&steamids=${batch.join(',')}`;
        const jsonData = await httpsGetJSON(url);
        ((jsonData.response && jsonData.response.players) || []).forEach(p => {
            names[p.steamid] = p.personaname;
        });
    }
    return names;
}

function formatDuration(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
}

function report(friend, name, thresholdDays) {
    const since = friend.friend_since;
    const nowSeconds = Math.floor(Date.now() / 1000);

    console.log(`  Friend:       ${friend.steamid}${name ? ` (${name})` : ''}`);
    if (!since) {
        console.log('  friend_since: unknown (API returned no timestamp)');
        return null;
    }

    const elapsed = nowSeconds - since;
    const days = elapsed / 86400;
    const enough = days >= thresholdDays;

    console.log(`  friend_since: ${since}`);
    console.log(`  Added (local): ${new Date(since * 1000).toString()}`);
    console.log(`  Added (UTC):   ${new Date(since * 1000).toISOString()}`);
    console.log(`  Elapsed:      ${formatDuration(elapsed)} (${days.toFixed(3)} days)`);
    console.log(`  >= ${thresholdDays} days?  ${enough ? 'YES' : 'NO'}`);
    if (!enough) {
        const remaining = thresholdDays * 86400 - elapsed;
        console.log(`  Remaining:    ${formatDuration(remaining)}`);
        console.log(`  Eligible at:  ${new Date((since + thresholdDays * 86400) * 1000).toString()}`);
    }
    return enough;
}

function resolveAccount(nameOrID) {
    if (/^\d{17}$/.test(nameOrID)) return { name: nameOrID, steamID: nameOrID };
    const acc = ACCOUNTS[nameOrID];
    if (!acc || !acc.steamID) return null;
    return { name: nameOrID, steamID: acc.steamID };
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}

function parseArgs(argv) {
    const positional = [];
    let scanAll = false;
    let thresholdDays = 30;

    argv.forEach(arg => {
        if (arg === '--all') {
            scanAll = true;
        } else if (arg.startsWith('--days=')) {
            const value = Number(arg.slice('--days='.length));
            if (Number.isFinite(value) && value > 0) thresholdDays = value;
        } else {
            positional.push(arg);
        }
    });

    return { positional, scanAll, thresholdDays };
}

(async () => {
    const { positional, scanAll, thresholdDays } = parseArgs(process.argv.slice(2));

    const accountArg = scanAll ? null : positional.shift();
    const friendIDs = positional.filter(id => /^\d{17}$/.test(id));

    if (friendIDs.length === 0 || (!scanAll && !accountArg)) {
        console.log('Usage:');
        console.log('  node check_friend_since.js <account> <friendSteamID> [more...] [--days=30]');
        console.log('  node check_friend_since.js --all <friendSteamID> [more...] [--days=30]');
        process.exit(1);
    }

    const namesByID = await fetchPlayerNames(friendIDs).catch(() => ({}));

    // Which accounts to look in, and their (lazily fetched) friend lists.
    let accounts;
    if (scanAll) {
        accounts = Object.keys(ACCOUNTS).map(resolveAccount).filter(Boolean);
        console.log(`Scanning ${accounts.length} account(s) from steam_accounts.js ...`);
    } else {
        const acc = resolveAccount(accountArg);
        if (!acc) {
            console.log(`Account "${accountArg}" not found in steam_accounts.js (or not a 17-digit steamID64)`);
            process.exit(1);
        }
        accounts = [acc];
    }

    const lists = await mapLimit(accounts, CONCURRENCY, async (acc) => {
        try {
            return { acc, friends: await fetchFriendsFromAPI(acc.steamID) };
        } catch (err) {
            return { acc, error: err.message };
        }
    });

    if (!scanAll) {
        const { acc, friends, error } = lists[0];
        if (error) {
            console.log(`[${acc.name}] Error: ${error}`);
            process.exit(1);
        }
        console.log(`\nAccount: ${acc.name} (${acc.steamID}) - total friends: ${friends.length}\n`);
    } else {
        lists.filter(l => l.error).forEach(l => console.log(`[${l.acc.name}] Error: ${l.error}`));
        console.log('');
    }

    let allEnough = true;
    for (const friendID of friendIDs) {
        const hits = lists
            .filter(l => l.friends)
            .map(l => ({ acc: l.acc, friend: l.friends.find(f => f.steamid === friendID) }))
            .filter(h => h.friend);

        if (hits.length === 0) {
            const label = namesByID[friendID] ? `${friendID} (${namesByID[friendID]})` : friendID;
            console.log(`${label}: NOT in friend list${scanAll ? ' of any account' : ''}`);
            console.log('');
            allEnough = false;
            continue;
        }

        hits.forEach(({ acc, friend }) => {
            console.log(`Account ${acc.name} (${acc.steamID}):`);
            const enough = report(friend, namesByID[friendID], thresholdDays);
            if (enough !== true) allEnough = false;
            console.log('');
        });
    }

    process.exit(allEnough ? 0 : 1);
})();
