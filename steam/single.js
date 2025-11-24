const SteamUser = require('steam-user');
const https = require('https');
const client = new SteamUser({
    picCacheSize: 100, // Enable PICS cache with a size limit
    picsCacheAll: true, // Cache all apps and packages, not just known ones
    changelistUpdateInterval: 10000 // 10 seconds - how often to check for updates
});

const logOnOptions = {
    accountName: 'pearlebonyh',
    password: '',
};

// const logOnOptions = {
//     accountName: 'lucprozz1',
//     password: 'jgMJ6hk8Km'
// };

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

client.logOn(logOnOptions);

client.on('loggedOn', () => {
    console.log('Logged into Steam successfully!');

    // Set online status and display name
    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed([]); // Set no games playing
    // client.gamesPlayed(["Steam Client"]); // Or play a game

    // Get your account info
    console.log('Your Steam ID:', client.steamID.toString());
    console.log('Account Name:', client.accountInfo?.accountName || 'Loading...');
    console.log('Persona State:', SteamUser.EPersonaState[client.personaState] || 'Loading...');
});

// Account info loaded
client.on('accountInfo', function(info) {
    console.log('\n=== Account Info ===');
    console.log('Account Name:', info.name);
    console.log('Country:', info.country);
    console.log('Display Name:', info.accountName); // Usually same as accountName
    console.log('Profile URL:', `https://steamcommunity.com/profiles/${client.steamID.getSteamID64()}`);

    // Get email info
    if (client.emailInfo && client.emailInfo.address) {
        console.log('Email Address:', client.emailInfo.address);
    }

    client.setPersona(SteamUser.EPersonaState.Online, 'fuga' + logOnOptions.accountName);
    client.gamesPlayed(440);

    // Example: Convert quick-invite link (add your own link to test)
    // convertQuickInviteLink('https://s.team/p/xxxx-xxxx/jrtxmvqcw');

    // Create a quick invite link for this account
    client.createQuickInviteLink({
        inviteLimit: 1000, // How many times this link can be used
        inviteDuration: null // Valid for 24 hours (86400 seconds)
    }, function(err, response) {
        if (!err) {
            console.log('\n=== Your Quick Invite Link ===');
            console.log('Link:', response.token.invite_link);
            console.log('Uses Remaining:', response.token.invite_limit);
            console.log('Time Remaining:', response.token.invite_duration ? `${response.token.invite_duration} seconds` : 'Never expires');
            console.log('Created:', response.token.time_created);
            console.log('Valid:', response.token.valid);
        } else {
            console.log('Error creating invite link:', err);
        }
    });
});

// Account limitations loaded
client.on('accountLimitations', function() {
    if (client.accountLimitations) {
        console.log('\n=== Account Limitations ===');
        console.log('Limited Account:', client.accountLimitations.limited ? 'Yes' : 'No');
        console.log('Community Banned:', client.accountLimitations.communityBanned ? 'Yes' : 'No');
        console.log('Locked Account:', client.accountLimitations.locked ? 'Yes' : 'No');
        console.log('Can Invite Friends:', client.accountLimitations.canInviteFriends ? 'Yes' : 'No');
    }
});

// VAC ban info loaded
client.on('vacBans', function() {
    if (client.vacBans) {
        console.log('\n=== VAC Ban Status ===');
        console.log('Number of Bans:', client.vacBans.numBans);
        if (client.vacBans.appids && client.vacBans.appids.length > 0) {
            console.log('Banned from AppIDs:', client.vacBans.appids.join(', '));
        } else {
            console.log('No VAC bans');
        }
    }
});

// Wallet info loaded
client.on('wallet', function() {
    if (client.wallet) {
        console.log('\n=== Wallet Info ===');
        console.log('Has Wallet:', client.wallet.hasWallet ? 'Yes' : 'No');
        console.log('Currency:', client.wallet.currency || 'N/A');
        console.log('Balance:', client.wallet.balance || '0');
    }
});

// Get your owned games after PICS cache is ready
client.on('appOwnershipCached', function() {
    client.getOwnedApps(function(err, apps) {
        if (!err) {
            console.log(`You own ${apps.length} games/apps`);
            // console.log('App IDs:', apps.slice(0, 10)); // Show first 10
        } else {
            console.log('Error getting owned apps:', err);
        }
    });
});

// Get friend list
client.on('friendsList', function() {
    console.log('\n=== Friend List ===');
    const friendsCount = Object.keys(client.myFriends).length;
    console.log('Total friends:', friendsCount);
    
    const onlineFriends = Object.values(client.myFriends).filter(f => f && f.rich_presence && f.rich_presence.length > 0).length;
    console.log('Friends online:', onlineFriends);
    
    // Get Steam ID64 for API call
    const steamID64 = client.steamID.getSteamID64();
    
    // Fetch friend data from Steam Web API to get friend_since timestamps
    fetchFriendsFromAPI(steamID64, (err, apiFriends) => {
        if (err) {
            console.log('Error fetching friends from API:', err.message);
        }
        
        // Create a map of API friend data by SteamID
        const apiFriendsMap = {};
        if (apiFriends) {
            apiFriends.forEach(friend => {
                apiFriendsMap[friend.steamid] = friend;
            });
        }
        
        console.log('\n=== All Friends ===');
        Object.keys(client.myFriends).forEach((steamIDStr, index) => {
            const friend = client.myFriends[steamIDStr];
            
            console.log(`\n${index + 1}. Friend:`);
            console.log('   Steam ID:', steamIDStr);
            
            // Get friend name and data from client.users
            const user = client.users[steamIDStr];
            if (user) {
                console.log('   Name:', user.player_name || 'Unknown');
                console.log('   Persona Name:', user.persona_name || 'N/A');
            }
            
            // Get friend_since from API data
            const apiFriend = apiFriendsMap[steamIDStr];
            if (apiFriend && apiFriend.friend_since) {
                const dateAdded = new Date(apiFriend.friend_since * 1000);
                console.log('   Date Added:', dateAdded.toLocaleString());
            } else {
                console.log('   Date Added: N/A');
            }
            
            console.log('   Relationship:', friend || 'N/A');
            
            if (user) {
                console.log('   Online:', user.persona_state !== 0 ? 'Yes' : 'No');
            }
        });
    });
});

// When a friend changes their state
client.on('personaState', function(steamID, persona) {
    const friend = client.users[steamID];
    console.log(`Friend ${friend?.name} (${steamID.getNickname()}) is now ${persona.player_name || 'offline'}`);
});

// Receive messages
client.on('message', function(steamID, message, flags) {
    const sender = client.users[steamID];
    console.log(`\nMessage from ${sender?.name}: ${message}`);

    // Auto-reply example
    // client.chatMessage(steamID, 'Hello! I received your message.');
});

// Friend requests
client.on('friendRelationship', function(steamID, relationship) {
    console.log(`\nFriend relationship changed for ${steamID.getSteamID64()}`);
    console.log('Relationship:', relationship);

    if (relationship === 2) {
        console.log('You received a friend request!');
        // Automatically accept
        client.addFriend(steamID);
    }
});

// Error handling
client.on('error', function(err) {
    console.log('Error:', err);
});

client.on('disconnected', function(errcode, msg) {
    console.log('Disconnected from Steam. Error code:', errcode, 'Message:', msg);
});



// Example usage (uncomment to use):
// convertQuickInviteLink('https://s.team/p/qrsx-vtdf/jrtxmvqcw');