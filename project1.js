const SteamUser = require('steam-user');
const fs = require('fs');
const path = require('path');

const client = new SteamUser({
    picCacheSize: 100, // Enable PICS cache with a size limit
    picsCacheAll: true, // Cache all apps and packages, not just known ones
    changelistUpdateInterval: 10000 // 10 seconds - how often to check for updates
});

// Parse steam_china.txt file
function parseSteamAccounts(filePath) {
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        const lines = data.split('\n').filter(line => line.trim());
        
        const accounts = lines.map((line, index) => {
            const parts = line.split('----');
            return {
                id: index + 1,
                username: parts[0],
                password: parts[1],
                email: parts[2],
                steamID: parts[3]
            };
        });
        
        return accounts;
    } catch (err) {
        console.error('Error reading file:', err);
        return [];
    }
}

// Parse all accounts
const accounts = parseSteamAccounts('steam_cis_export.txt');
console.log(`Loaded ${accounts.length} accounts from file`);

// Parse invite links
function parseInviteLinks(filePath) {
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        const lines = data.split('\n').filter(line => line.trim());
        return lines;
    } catch (err) {
        console.error('Error reading invite links file:', err);
        return [];
    }
}

const inviteLinks = parseInviteLinks('quick_invite_link.txt');
console.log(`Loaded ${inviteLinks.length} invite links from quick_invite_link.txt\n`);

console.log('\n=== Account List with Invite Links ===');
accounts.forEach((acc, index) => {
    const assignedLink = inviteLinks[index % inviteLinks.length];
    console.log(`[${acc.id}] Username: ${acc.username}, SteamID: ${acc.steamID}`);
    console.log(`    → Will redeem: ${assignedLink}`);
});

// Create a Steam client for each account
const clients = accounts.map((account, index) => {
    const accClient = new SteamUser({
        picCacheSize: 100,
        picsCacheAll: true,
        changelistUpdateInterval: 10000
    });
    
    // Assign account info to client
    accClient.accountData = account;
    
    // Assign invite link in order (cycle through links if more accounts than links)
    accClient.inviteLink = inviteLinks[index % inviteLinks.length];
    
    return accClient;
});

// Login all accounts
console.log('\n=== Logging in all accounts ===');
clients.forEach((accClient, index) => {
    const account = accounts[index];
    
    accClient.on('loggedOn', function() {
        console.log(`\n[${account.id}] ${account.username} - Logged in successfully!`);
        console.log(`[${account.id}] Steam ID:`, accClient.steamID.toString());
        
        accClient.setPersona(SteamUser.EPersonaState.Online);
        accClient.gamesPlayed(440);
        
        // Redeem quick invite link for each account (in order)
        if (accClient.inviteLink) {
            console.log(`[${account.id}] Using invite link: ${accClient.inviteLink}`);
            accClient.redeemQuickInviteLink(accClient.inviteLink, function(err) {
                if (!err) {
                    console.log(`[${account.id}] Successfully sent friend request via link`);
                } else {
                    console.log(`[${account.id}] Error redeeming invite link:`, err.message);
                }
            });
        } else {
            console.log(`[${account.id}] No invite link assigned for this account`);
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
        console.log(`[${account.id}] Friends: ${Object.keys(accClient.myFriends).length}`);
    });
    
    accClient.on('error', function(err) {
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
