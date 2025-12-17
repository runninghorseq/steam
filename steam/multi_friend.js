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
        
        const accounts = lines.slice(0,15).map((line, index) => {
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

const inviteLinks1 = parseInviteLinks('quick_invite_link.txt');
const inviteLinks2 = parseInviteLinks('quick_invite_link2.txt');
console.log(`Loaded ${inviteLinks1.length} invite links from quick_invite_link.txt`);
console.log(`Loaded ${inviteLinks2.length} invite links from quick_invite_link2.txt\n`);

// Helper function to fetch friend list from Steam Web API
function fetchFriendsFromAPI(steamID64, callback) {
    // Steam Web API Key - you can get one from https://steamcommunity.com/dev/apikey
    const apiKey = 'EFB5DCE316D3146FD6EFA3BECB8BCB80';
    const url = `https://api.steampowered.com/ISteamUser/GetFriendList/v0001/?key=${apiKey}&steamid=${steamID64}&relationship=friend`;
    
    https.get(url, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
            data += chunk;
        });
        
        res.on('end', () => {
            // Check if response is HTML (error page)
            if (res.statusCode !== 200 || data.trim().startsWith('<')) {
                console.log('API Error - Response:', data.substring(0, 200));
                console.log('Status Code:', res.statusCode);
                callback(new Error(`API returned error: ${res.statusCode}`), null);
                return;
            }
            
            try {
                const jsonData = JSON.parse(data);
                if (jsonData.friendslist && jsonData.friendslist.friends) {
                    callback(null, jsonData.friendslist.friends);
                } else {
                    callback(null, []);
                }
            } catch (err) {
                console.log('JSON Parse Error - Response:', data.substring(0, 200));
                callback(err, null);
            }
        });
    }).on('error', (err) => {
        callback(err, null);
    });
}

console.log('\n=== Account List with Invite Links ===');
accounts.forEach((acc, index) => {
    const assignedLink1 = inviteLinks1[index % inviteLinks1.length];
    const assignedLink2 = inviteLinks2[index % inviteLinks2.length];
    console.log(`[${acc.id}] Username: ${acc.username}, password: ${acc.password}`);
    console.log(`    → Will redeem link 1: ${assignedLink1}`);
    console.log(`    → Will redeem link 2: ${assignedLink2}`);
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
    
    // Assign 2 invite links in order (cycle through links if more accounts than links)
    accClient.inviteLink1 = inviteLinks1[index % inviteLinks1.length];
    accClient.inviteLink2 = inviteLinks2[index % inviteLinks2.length];

    
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
        
        // Redeem first quick invite link
        if (accClient.inviteLink1) {
            console.log(`[${account.id}] Using invite link 1: ${accClient.inviteLink1}`);
            accClient.redeemQuickInviteLink(accClient.inviteLink1, function(err) {
                if (!err) {
                    console.log(`[${account.id}] Successfully sent friend request via link 1`);
                } else {
                    console.log(`[${account.id}] Error redeeming invite link 1:`, err.message);
                }
                
                // Redeem second quick invite link after first one completes
                if (accClient.inviteLink2) {
                    setTimeout(() => {
                        console.log(`[${account.id}] Using invite link 2: ${accClient.inviteLink2}`);
                        accClient.redeemQuickInviteLink(accClient.inviteLink2, function(err2) {
                            if (!err2) {
                                console.log(`[${account.id}] Successfully sent friend request via link 2`);
                            } else {
                                console.log(`[${account.id}] Error redeeming invite link 2:`, err2.message);
                            }
                        });
                    }, 2000); // Wait 2 seconds between redeems
                }
            });
        } else {
            console.log(`[${account.id}] No invite links assigned for this account`);
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
        
        // Fetch friend data from Steam Web API to get friend_since timestamps
        /**
        fetchFriendsFromAPI(steamID64, (err, apiFriends) => {
            if (err) {
                console.log(`[${account.id}] Error fetching friends from API:`, err.message);
            }
            
            // Create a map of API friend data by SteamID
            const apiFriendsMap = {};
            if (apiFriends) {
                apiFriends.forEach(friend => {
                    apiFriendsMap[friend.steamid] = friend;
                });
            }
            
            console.log(`\n[${account.id}] === All Friends ===`);
            Object.keys(accClient.myFriends).forEach((steamIDStr, index) => {
                const friend = accClient.myFriends[steamIDStr];
                
                console.log(`\n[${account.id}] ${index + 1}. Friend:`);
                console.log(`[${account.id}]    Steam ID: ${steamIDStr}`);
                
                // Get friend name and data from accClient.users
                const user = accClient.users[steamIDStr];
                if (user) {
                    console.log(`[${account.id}]    Name: ${user.player_name || 'Unknown'}`);
                    console.log(`[${account.id}]    Persona Name: ${user.persona_name || 'N/A'}`);
                }
                
                // Get friend_since from API data
                const apiFriend = apiFriendsMap[steamIDStr];
                if (apiFriend && apiFriend.friend_since) {
                    const dateAdded = new Date(apiFriend.friend_since * 1000);
                    console.log(`[${account.id}]    Date Added: ${dateAdded.toLocaleString()}`);
                } else {
                    console.log(`[${account.id}]    Date Added: N/A`);
                }
                
                console.log(`[${account.id}]    Relationship: ${friend || 'N/A'}`);
                
                if (user) {
                    console.log(`[${account.id}]    Online: ${user.persona_state !== 0 ? 'Yes' : 'No'}`);
                }
            });
        });
         **/
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
