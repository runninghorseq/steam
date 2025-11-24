const SteamUser = require('steam-user');
const fs = require('fs');
const path = require('path');
const https = require('https');

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


// Helper function to fetch friend list from Steam Web API

console.log('\n=== Account List with Invite Links ===');
accounts.forEach((acc, index) => {
    console.log(`[${acc.id}] Username: ${acc.username}, password: ${acc.password}`);
    // console.log(`    → Will redeem: ${assignedLink}`);
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

        // Remove specific friend with SteamID: 76561198074581626
        const targetSteamID = '76561198074581626';
        const friendIDs = Object.keys(accClient.myFriends);
        const friendExists = friendIDs.some(steamID => steamID === targetSteamID || steamID.toString() === targetSteamID.toString());
        
        if (friendExists) {
            console.log(`[${account.id}] Removing friend with SteamID: ${targetSteamID}`);
            accClient.removeFriend(targetSteamID);
            console.log(`[${account.id}] Removed friend: ${targetSteamID}`);
        } else {
            console.log(`[${account.id}] Friend with SteamID ${targetSteamID} not found in friends list.`);
        }
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
