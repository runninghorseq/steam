const SteamUser = require('steam-user');
const fs = require('fs');
const path = require('path');
const https = require('https');

const client = new SteamUser({
    picCacheSize: 100, // Enable PICS cache with a size limit
    picsCacheAll: true, // Cache all apps and packages, not just known ones
    changelistUpdateInterval: 10000 // 10 seconds - how often to check for updates
});

const BATCH_SIZE = 15;

// Parse steam_china.txt file
function parseSteamAccounts(filePath) {
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        const lines = data.split('\n').filter(line => line.trim());

        const accounts = lines.map((line, index) => {
            if (line.includes('|')) {
                // Format: Index|hotmail|password|steamID|password
                const parts = line.split('|');
                return {
                    id: index + 1,
                    username: parts[3],
                    password: parts[4],
                    email: parts[1],
                    steamID: parts[2],
                    rawLine: line
                };
            }
            const parts = line.split('----');
            return {
                id: index + 1,
                username: parts[0],
                password: parts[1],
                email: parts[2],
                steamID: parts[3],
                rawLine: line
            };
        });

        return accounts;
    } catch (err) {
        console.error('Error reading file:', err);
        return [];
    }
}

// Collect every rawLine that appears in any prior "Original lines run" section
function readProcessedRawLines(fileName) {
    const baseName = fileName.replace(/\.[^.]+$/, '');
    const logPath = path.join('logs', `${baseName}.logs`);
    if (!fs.existsSync(logPath)) return new Set();
    const data = fs.readFileSync(logPath, 'utf8');
    const lines = data.split('\n');
    const processed = new Set();
    let inSection = false;
    for (const line of lines) {
        if (/^Original lines run \(\d+\):.*$/.test(line)) {
            inSection = true;
            continue;
        }
        if (inSection) {
            if (line.startsWith('  ')) {
                processed.add(line.slice(2));
            } else {
                inSection = false;
            }
        }
    }
    return processed;
}

// Parse all accounts
// FILE_NAME = 'steam_accounts.txt'
FILE_NAME = '/Users/lequangha/Library/Mobile Documents/com~apple~CloudDocs/fungaming/smb/1k_outlook_2005.txtresult.txt'
// FILE_NAME = '/Users/lequangha/fungaming/fungame/steam/2650_outlook.txt.missing.txtresult.txt'
const allAccounts = parseSteamAccounts(FILE_NAME);
console.log(`Loaded ${allAccounts.length} accounts from file`);

const ACCOUNTS = require('./steam_accounts');

// Which steamIDs to add — each entry resolves to one invite link via QUICK_INVITE_LINKS
// const run = ['daicaso1122', 'sisloraquevm', 'lomaywoldeba', 'DeanaIsabel', 'LidiaOlivia'];

// const run = ['forssmelsoey','tepozreams','tichvan1742000', 'duaneunger'];


run = ['ceirahoisld', 'rymutghani', 'cereocaiusmq']
    // ['butayflyteos', 'nookstostazr', 'pittafridyc'],
    // ['mooteclaesl', 'polindobekhl', 'yahneolsano'],
    // ['']

// Mode: 'redeem' to redeem invite links from `run`, 'create' to create new quick invite links
// const MODE = 'create';
const MODE = 'redeem';

const LOGING_TIMEOUT = 20000;

// Drop accounts whose rawLine was already processed in any previous run, then take the next batch
const processedRawLines = readProcessedRawLines(FILE_NAME);
const remaining = allAccounts.filter(a => !processedRawLines.has(a.rawLine));
const accounts = remaining.slice(0, BATCH_SIZE);
console.log(`Already processed: ${processedRawLines.size} | Remaining: ${remaining.length} | This batch: ${accounts.length}`);
if (accounts.length === 0) {
    console.log('No accounts left to process. Exiting.');
    process.exit(0);
}


console.log('\n=== Account List with Invite Links ===');
const runLinks = run.map(id => ACCOUNTS[id] && ACCOUNTS[id].quickInviteLink).filter(Boolean);
accounts.forEach((acc) => {
    console.log(`[${acc.id}] Username: ${acc.username}, password: ${acc.password}`);
    runLinks.forEach((link, i) => console.log(`    → Will redeem link ${i + 1}: ${link}`));
    if (runLinks.length === 0) console.log(`    → No invite links configured`);
});

// Create a Steam client for each account
const clients = accounts.map((account) => {
    const accClient = new SteamUser({
        picCacheSize: 100,
        picsCacheAll: true,
        changelistUpdateInterval: 10000
    });

    accClient.accountData = account;
    accClient.inviteLinks = run.map(id => ACCOUNTS[id] && ACCOUNTS[id].quickInviteLink).filter(Boolean);


    return accClient;
});

// Track login results
const loginResults = { success: [], failed: [], skipped: [] };
let settled = 0;


function checkAllSettled() {
    settled++;
    if (settled === accounts.length) {
        setTimeout(() => {
            const successLine = `Success (${loginResults.success.length}): ${loginResults.success.map(a => a.username).join(', ') || 'none'}`;
            const skippedLine = `Skipped (${loginResults.skipped.length}) — Steam Guard App required: ${loginResults.skipped.map(a => a.username).join(', ') || 'none'}`;
            const failedLine = `Failed  (${loginResults.failed.length}): ${loginResults.failed.map(f => `[${f.id}] ${f.username} — ${f.reason}`).join('; ') || 'none'}`;

            console.log('\n=== Login Summary ===');
            console.log(successLine);
            console.log(skippedLine);
            console.log(`Failed  (${loginResults.failed.length}):`);
            loginResults.failed.forEach(f => console.log(`  [${f.id}] ${f.username} — ${f.reason}`));

            // Export results to file
            const timestamp = new Date().toISOString();
            const baseName = FILE_NAME.replace(/\.[^.]+$/, '');
            const outPath = path.join('logs', `${baseName}.logs`);
            const header = `[${timestamp}] run=${JSON.stringify(run)} | ${failedLine}`;
            const body = [
                header,
                successLine,
                skippedLine,
                `Failed  (${loginResults.failed.length}):`,
                ...loginResults.failed.map(f => `  [${f.id}] ${f.username} — ${f.reason}`),
                `Original lines run (${accounts.length}):`,
                ...accounts.map(a => `  ${a.rawLine}`),
                ''
            ].join('\n');
            try {
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
                fs.appendFileSync(outPath, body + '\n');
                console.log(`\nExported results to ${outPath}`);
            } catch (err) {
                console.log(`Error writing log file:`, err.message);
            }

            // Log off all active clients then exit
            console.log('\n=== Logging off all accounts ===');
            clients.forEach((c, i) => {
                if (loginResults.success.find(a => a.id === accounts[i].id)) {
                    console.log(`Logging off: ${accounts[i].username}`);
                    c.logOff();
                }
            });
            setTimeout(() => process.exit(0), LOGING_TIMEOUT);
        }, LOGING_TIMEOUT);
    }
}

// Login all accounts
console.log('\n=== Logging in all accounts ===');
clients.forEach((accClient, index) => {
    const account = accounts[index];

    accClient.on('loggedOn', function() {
        loginResults.success.push(account);
        checkAllSettled();
        console.log(`\n[${account.id}] ${account.username} - Logged in successfully!`);
        console.log(`[${account.id}] Steam ID:`, accClient.steamID.toString());

        accClient.setPersona(SteamUser.EPersonaState.Online);

        // Auto add games to library
        const gameIds = [730, 440, 238960, 613100, 1590840, 599140, 3027490];
        accClient.requestFreeLicense(gameIds, function(err, grantedApps, grantedPackages) {
            if (!err) {
                console.log(`[${account.id}] Games added to library:`, grantedApps);
            } else {
                console.log(`[${account.id}] Error adding games to library:`, err.message);
            }
        });

        // accClient.gamesPlayed(440);
        // accClient.gamesPlayed(730);
        // accClient.gamesPlayed(238960); //path of exile
        // accClient.gamesPlayed(613100);
        // accClient.gamesPlayed(1590840);

        if (MODE === 'create') {
            // Create a quick invite link for this account
            accClient.createQuickInviteLink({
                inviteLimit: 1000,
                inviteDuration: null
            }, function(err, response) {
                if (!err) {
                    console.log(`\n[${account.id}] === Your Quick Invite Link ===`);
                    console.log(`[${account.id}] Link:`, response.token.invite_link);
                    console.log(`[${account.id}] Uses Remaining:`, response.token.invite_limit);
                    console.log(`[${account.id}] Time Remaining:`, response.token.invite_duration ? `${response.token.invite_duration} seconds` : 'Never expires');
                    console.log(`[${account.id}] Created:`, response.token.time_created);
                    console.log(`[${account.id}] Valid:`, response.token.valid);
                } else {
                    console.log(`[${account.id}] Error creating invite link:`, err);
                }
            });
        } else if (MODE === 'redeem') {
            // Redeem quick invite links sequentially (2s apart)
            const links = accClient.inviteLinks;
            if (links.length === 0) {
                console.log(`[${account.id}] No invite links configured`);
            } else {
                links.forEach((link, i) => {
                    setTimeout(() => {
                        console.log(`[${account.id}] Using invite link ${i + 1}: ${link}`);
                        accClient.redeemQuickInviteLink(link, function(err) {
                            if (!err) {
                                console.log(`[${account.id}] Successfully sent friend request via link ${i + 1}`);
                            } else {
                                console.log(`[${account.id}] Error redeeming invite link ${i + 1}:`, err.message);
                            }
                        });
                    }, i * 2000);
                });
            }
        } else {
            console.log(`[${account.id}] Unknown MODE: ${MODE}`);
        }
    });

    accClient.on('accountInfo', function(info) {
        console.log(`\n[${account.id}] === Account Info ===`);
        console.log(`[${account.id}] Name:`, info.name);
        console.log(`[${account.id}] Profile URL:`, `https://steamcommunity.com/profiles/${accClient.steamID.getSteamID64()}`);

        if (accClient.emailInfo && accClient.emailInfo.address) {
            console.log(`[${account.id}] Email:`, accClient.emailInfo.address);
        }
    });

    accClient.on('friendsList', function() {
        const friendsCount = Object.keys(accClient.myFriends).length;
        console.log(`\n[${account.id}] === Friend List ===`);
        console.log(`[${account.id}] Total friends: ${friendsCount}`);

        const onlineFriends = Object.values(accClient.myFriends).filter(f => f && f.rich_presence && f.rich_presence.length > 0).length;
        console.log(`[${account.id}] Friends online: ${onlineFriends}`);

        // Get Steam ID64 for API call
        const steamID64 = accClient.steamID.getSteamID64();

    });

    accClient.on('steamGuard', function(domain, callback) {
        if (domain === null) {
            // Mobile authenticator required — skip this account
            console.log(`[${account.id}] ${account.username} - Skipping: Steam Guard App Code required`);
            loginResults.skipped.push(account);
            checkAllSettled();
            accClient.logOff();
        } else {
            // Email Steam Guard — also skip
            console.log(`[${account.id}] ${account.username} - Skipping: Steam Guard email required (${domain})`);
            loginResults.skipped.push(account);
            checkAllSettled();
            accClient.logOff();
        }
    });

    accClient.on('error', function(err) {
        loginResults.failed.push({ ...account, reason: err.message });
        checkAllSettled();
        console.log(`[${account.id}] Error:`, err.message);
    });

    accClient.on('disconnected', function(errcode, msg) {
        console.log(`[${account.id}] Disconnected. Error code:`, errcode);
    });

    // Login to this account
    console.log(`Logging in account ${account.id}/${accounts.length}: ${account.username}`);
    accClient.logOn({
        accountName: account.username,
        password: account.password
    });
});

// Note: Event handlers for all clients are already set up above in the forEach loop
// Each client will automatically log in and redeem the invite link
