const SteamUser = require('steam-user');
const https = require('https');
const fs = require('fs');
const readline = require('readline');
const { db, getRefreshToken, saveRefreshToken, clearRefreshToken } = require('./db');

// Remove friends whose persona name is in a given list.
//
// Usage:
//   node remove_friends_by_name.js <accountName> <friendName> [moreNames...] [options]
//   node remove_friends_by_name.js <accountName> --file=names.txt [options]
//
// Names are matched case-insensitively against the friend's current persona name.
// A 17-digit steamID64 may be given instead of a name and is matched directly.
//
// Options:
//   --file=<path>   read names/steamIDs from a file (one per line, # starts a comment)
//   --dry-run       show what would be removed, remove nothing
//   --yes           skip the confirmation prompt
//   --delay=<ms>    delay between removals (default 500)
//
// Examples:
//   node remove_friends_by_name.js daicaso1122 qf151033 tj152862 --dry-run
//   node remove_friends_by_name.js daicaso1122 --file=remove_names.txt --yes

const API_KEY = 'EFB5DCE316D3146FD6EFA3BECB8BCB80';

function parseArgs(argv) {
    const positional = [];
    const opts = { dryRun: false, yes: false, delay: 500, file: null };

    argv.forEach(arg => {
        if (arg === '--dry-run') opts.dryRun = true;
        else if (arg === '--yes' || arg === '-y') opts.yes = true;
        else if (arg.startsWith('--file=')) opts.file = arg.slice('--file='.length);
        else if (arg.startsWith('--delay=')) {
            const value = Number(arg.slice('--delay='.length));
            if (Number.isFinite(value) && value >= 0) opts.delay = value;
        } else positional.push(arg);
    });

    return { positional, opts };
}

const { positional, opts } = parseArgs(process.argv.slice(2));

const ACCOUNT_NAME = (positional.shift() || '').trim();
if (!ACCOUNT_NAME) {
    console.error('Usage: node remove_friends_by_name.js <accountName> <friendName> [more...] [--file=names.txt] [--dry-run] [--yes] [--delay=500]');
    process.exit(1);
}

// Build the target list from CLI args and/or a file.
const targets = [...positional];
if (opts.file) {
    let raw;
    try {
        raw = fs.readFileSync(opts.file, 'utf8');
    } catch (err) {
        console.error(`Cannot read --file=${opts.file}: ${err.message}`);
        process.exit(1);
    }
    raw.split(/\r?\n/).forEach(line => {
        const name = line.split('#')[0].trim();
        if (name) targets.push(name);
    });
}

// De-duplicate case-insensitively, keeping the first spelling seen.
const TARGET_NAMES = [];
const seenTargets = new Set();
targets.forEach(name => {
    const key = name.toLowerCase();
    if (!seenTargets.has(key)) {
        seenTargets.add(key);
        TARGET_NAMES.push(name);
    }
});

if (TARGET_NAMES.length === 0) {
    console.error('No friend names given. Pass them as arguments or via --file=<path>.');
    process.exit(1);
}

const accountRow = db
    .prepare('SELECT steam_id, account_name FROM accounts WHERE lower(account_name) = lower(?)')
    .get(ACCOUNT_NAME);
if (!accountRow) {
    console.error(`Account '${ACCOUNT_NAME}' not found in accounts DB.`);
    process.exit(1);
}

const refreshToken = getRefreshToken(accountRow.account_name);
if (!refreshToken) {
    console.error(
        `No cached refresh token for '${accountRow.account_name}'. ` +
        `Run single.js to log in and cache a token first.`
    );
    process.exit(1);
}

const client = new SteamUser({
    picCacheSize: 100,
    picsCacheAll: true,
    changelistUpdateInterval: 10000
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function httpsGetJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200 || data.trim().startsWith('<')) {
                    return reject(new Error(`API returned error: ${res.statusCode}`));
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

// GetPlayerSummaries accepts at most 100 steamIDs per call, so batch them.
async function fetchFriendNames(steamIDs) {
    const namesMap = {};
    for (let i = 0; i < steamIDs.length; i += 100) {
        const batch = steamIDs.slice(i, i + 100);
        const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${API_KEY}&steamids=${batch.join(',')}`;
        const jsonData = await httpsGetJSON(url);
        ((jsonData.response && jsonData.response.players) || []).forEach(player => {
            namesMap[player.steamid] = player.personaname || 'Unknown';
        });
    }
    return namesMap;
}

function confirm(question) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, answer => {
            rl.close();
            resolve(/^y(es)?$/i.test(answer.trim()));
        });
    });
}

console.log(`Logging in as '${accountRow.account_name}' (steam_id ${accountRow.steam_id}) via cached refresh token...`);
client.logOn({ refreshToken });

// Persist a fresh refresh token whenever Steam issues one.
client.on('refreshToken', (token) => {
    saveRefreshToken(accountRow.account_name, token);
    console.log('Refresh token updated.');
});

client.on('loggedOn', () => {
    console.log('Logged into Steam successfully!');
    console.log('Your Steam ID:', client.steamID.toString());

    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed(440);
});

client.on('accountInfo', function (info) {
    console.log('\n=== Account Info ===');
    console.log('Account Name:', info.name);
    console.log('Profile URL:', `https://steamcommunity.com/profiles/${client.steamID.getSteamID64()}`);
});

let handled = false;

client.on('friendsList', async function () {
    if (handled) return; // friendsList can fire more than once per session
    handled = true;

    try {
        const friendSteamIDs = Object.keys(client.myFriends).filter(
            id => client.myFriends[id] === SteamUser.EFriendRelationship.Friend
        );
        console.log('Total friends:', friendSteamIDs.length);

        const steamID64 = client.steamID.getSteamID64();

        console.log('Fetching friend_since data from API...');
        const apiFriends = await fetchFriendsFromAPI(steamID64);
        const apiFriendsMap = {};
        apiFriends.forEach(friend => { apiFriendsMap[friend.steamid] = friend; });

        console.log('Fetching friend names from API...');
        let namesMap = {};
        try {
            namesMap = await fetchFriendNames(friendSteamIDs);
        } catch (err) {
            console.log('Error fetching friend names:', err.message, '- falling back to client cache');
        }

        const nameFor = (steamIDStr) => {
            if (namesMap[steamIDStr]) return namesMap[steamIDStr];
            const user = client.users[steamIDStr];
            return user ? (user.player_name || user.persona_name || 'Unknown') : 'Unknown';
        };

        console.log('\n=== Matching Friends by Name ===');
        console.log(`Target list (${TARGET_NAMES.length}): ${TARGET_NAMES.join(', ')}`);

        const targetSet = new Set(TARGET_NAMES.map(n => n.toLowerCase()));
        const matchedTargets = new Set();
        const friendsToRemove = [];

        friendSteamIDs.forEach(steamIDStr => {
            const friendName = nameFor(steamIDStr);
            const byName = targetSet.has(friendName.toLowerCase());
            const byID = targetSet.has(steamIDStr.toLowerCase());
            if (!byName && !byID) return;

            if (byName) matchedTargets.add(friendName.toLowerCase());
            if (byID) matchedTargets.add(steamIDStr.toLowerCase());

            const apiFriend = apiFriendsMap[steamIDStr];
            const dateAdded = apiFriend && apiFriend.friend_since
                ? new Date(apiFriend.friend_since * 1000)
                : null;

            friendsToRemove.push({
                steamID: steamIDStr,
                name: friendName,
                dateAdded,
                matchedBy: byName ? 'name' : 'steamID'
            });
        });

        const notFound = TARGET_NAMES.filter(n => !matchedTargets.has(n.toLowerCase()));

        console.log('');
        friendsToRemove.forEach((friend, i) => {
            console.log(`[${i + 1}] ${friend.name} (${friend.steamID})`);
            console.log(`    Date Added: ${friend.dateAdded ? friend.dateAdded.toLocaleString() : 'unknown'}`);
            console.log(`    Matched by: ${friend.matchedBy}`);
        });

        console.log(`\n=== Summary ===`);
        console.log(`Total friends checked: ${friendSteamIDs.length}`);
        console.log(`Friends matched for removal: ${friendsToRemove.length}`);
        if (notFound.length > 0) {
            console.log(`Not found in friend list (${notFound.length}): ${notFound.join(', ')}`);
        }

        if (friendsToRemove.length === 0) {
            console.log('\nNothing to remove.');
            client.logOff();
            return;
        }

        if (opts.dryRun) {
            console.log('\n--dry-run: no friends were removed.');
            client.logOff();
            return;
        }

        if (!opts.yes) {
            const ok = await confirm(`\nRemove these ${friendsToRemove.length} friend(s) from '${accountRow.account_name}'? [y/N] `);
            if (!ok) {
                console.log('Aborted - no friends were removed.');
                client.logOff();
                return;
            }
        }

        console.log(`\n=== Removing Friends ===`);
        let removedCount = 0;
        for (const friend of friendsToRemove) {
            console.log(`Removing friend ${removedCount + 1}/${friendsToRemove.length}: ${friend.name} (${friend.steamID})`);
            client.removeFriend(friend.steamID);
            removedCount++;
            if (removedCount < friendsToRemove.length) await sleep(opts.delay);
        }

        // Give Steam a moment to process the last removals before logging off.
        await sleep(2000);

        console.log(`\n=== Completed ===`);
        console.log(`Sent removal for ${removedCount} friend(s) on '${accountRow.account_name}'.`);
        client.logOff();
    } catch (err) {
        console.log('Error:', err.message);
        client.logOff();
        process.exitCode = 1;
    }
});

// Steam confirms each removal here.
client.on('friendRelationship', function (steamID, relationship) {
    if (relationship === SteamUser.EFriendRelationship.None) {
        console.log(`   Confirmed removed: ${steamID.getSteamID64()}`);
    }
});

client.on('error', function (err) {
    console.log('Error:', err);
    if (/InvalidPassword|AccessDenied|Expired/i.test(err.message || '')) {
        clearRefreshToken(accountRow.account_name);
        console.log('Cleared cached refresh token.');
    }
    process.exitCode = 1;
});

client.on('disconnected', function (errcode, msg) {
    console.log('Disconnected from Steam. Error code:', errcode, 'Message:', msg);
});
