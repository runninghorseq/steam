const SteamUser = require('steam-user');
const https = require('https');

const client = new SteamUser({
    picCacheSize: 100,
    picsCacheAll: true,
    changelistUpdateInterval: 10000
});

// Login credentials - UPDATE THESE
const logOnOptions = {
    accountName: 'kienpoe222',
    password: 'jgMJ6hk8Km'
};

// Steam Web API Key - you can get one from https://steamcommunity.com/dev/apikey
const API_KEY = 'EFB5DCE316D3146FD6EFA3BECB8BCB80';

// Date threshold: ${DATE_REMOVAL.toLocaleDateString()} 00:00:00 UTC
DATE_REMOVAL = new Date('2025-01-01T00:00:00Z')
const REMOVE_TIMESTAMP = Math.floor(DATE_REMOVAL.getTime() / 1000);

// Date threshold for upper bound (remove friends added after this date)
DATE_REMOVAL_MAX = new Date('2025-11-22T23:59:59Z')
const REMOVE_TIMESTAMP_MAX = Math.floor(DATE_REMOVAL_MAX.getTime() / 1000);

// List of friend names to remove (case-insensitive matching)
// Friends in this list will be removed regardless of date
const FRIENDS_TO_REMOVE_BY_NAME = [
    // 'qf151033', 'tj152862','cw151033','nt152862','sd151033','ff902782','ey227146','lo436229','ju806321','lo024773','yw250534'
];

// List of friend names that should NOT be removed (exception list)
// Friends in this list will NOT be removed even if they were added between ${DATE_REMOVAL.toLocaleDateString()} and ${DATE_REMOVAL_MAX.toLocaleDateString()}
const FRIENDS_TO_KEEP = [
    // Add friend names here that should be kept, e.g.:
    // 'friendname1',
    // 'friendname2',
];

// Helper function to fetch friend list from Steam Web API
function fetchFriendsFromAPI(steamID64, callback) {
    const url = `https://api.steampowered.com/ISteamUser/GetFriendList/v0001/?key=${API_KEY}&steamid=${steamID64}&relationship=friend`;
    
    https.get(url, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
            data += chunk;
        });
        
        res.on('end', () => {
            // console.log('\n=== API Response ===');
            // console.log('Status Code:', res.statusCode);
            // console.log('Response Length:', data.length, 'bytes');
            
            if (res.statusCode !== 200 || data.trim().startsWith('<')) {
                // console.log('API Error - Response:', data.substring(0, 200));
                callback(new Error(`API returned error: ${res.statusCode}`), null);
                return;
            }
            
            try {
                const jsonData = JSON.parse(data);
                // console.log('Parsed JSON Data:', JSON.stringify(jsonData, null, 2));
                
                if (jsonData.friendslist && jsonData.friendslist.friends) {
                    // console.log(`\n=== API Friends Data ===`);
                    // console.log(`Total friends from API: ${jsonData.friendslist.friends.length}`);
                    // console.log('Friends array:', JSON.stringify(jsonData.friendslist.friends, null, 2));
                    callback(null, jsonData.friendslist.friends);
                } else {
                    console.log('No friends in API response');
                    console.log('Full JSON response:', JSON.stringify(jsonData, null, 2));
                    callback(null, []);
                }
            } catch (err) {
                console.log('JSON Parse Error - Response:', data.substring(0, 200));
                console.log('Parse Error:', err.message);
                callback(err, null);
            }
        });
    }).on('error', (err) => {
        callback(err, null);
    });
}

// Helper function to fetch friend names from Steam Web API
function fetchFriendNames(steamIDs, callback) {
    if (!steamIDs || steamIDs.length === 0) {
        callback(null, {});
        return;
    }
    
    // Steam API GetPlayerSummaries accepts up to 100 steamIDs at once
    const steamIDsStr = steamIDs.join(',');
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${API_KEY}&steamids=${steamIDsStr}`;
    
    https.get(url, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
            data += chunk;
        });
        
        res.on('end', () => {
            if (res.statusCode !== 200 || data.trim().startsWith('<')) {
                console.log('Error fetching friend names - Status Code:', res.statusCode);
                callback(new Error(`API returned error: ${res.statusCode}`), null);
                return;
            }
            
            try {
                const jsonData = JSON.parse(data);
                const namesMap = {};
                
                if (jsonData.response && jsonData.response.players) {
                    jsonData.response.players.forEach(player => {
                        namesMap[player.steamid] = player.personaname || 'Unknown';
                    });
                }
                
                callback(null, namesMap);
            } catch (err) {
                console.log('Error parsing friend names:', err.message);
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
    console.log('Your Steam ID:', client.steamID.toString());
    
    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed(440);
});

client.on('accountInfo', function(info) {
    console.log('\n=== Account Info ===');
    console.log('Account Name:', info.name);
    console.log('Profile URL:', `https://steamcommunity.com/profiles/${client.steamID.getSteamID64()}`);
});

// Get friend list and remove friends added between ${DATE_REMOVAL.toLocaleDateString()} and ${DATE_REMOVAL_MAX.toLocaleDateString()}
client.on('friendsList', function() {
    // console.log('\n=== Friend List ===');
    const friendsCount = Object.keys(client.myFriends).length;
    console.log('Total friends:', friendsCount);
    
    const steamID64 = client.steamID.getSteamID64();
    const friendSteamIDs = Object.keys(client.myFriends);
    
    // Fetch friend data from Steam Web API to get friend_since timestamps
    // console.log(`\n=== Fetching Friends from API ===`);
    // console.log(`Steam ID64: ${steamID64}`);
    // console.log(`API URL: https://api.steampowered.com/ISteamUser/GetFriendList/v0001/?key=${API_KEY}&steamid=${steamID64}&relationship=friend`);
    //
    fetchFriendsFromAPI(steamID64, (err, apiFriends) => {
        if (err) {
            console.log('Error fetching friends from API:', err.message);
            return;
        }
        
        // console.log(`\n=== API Callback Result ===`);
        // console.log(`API Friends received:`, apiFriends);
        // console.log(`API Friends count:`, apiFriends ? apiFriends.length : 0);
        //
        if (!apiFriends || apiFriends.length === 0) {
            console.log('No friends found or API returned empty list.');
            return;
        }
        
        // Create a map of API friend data by SteamID
        const apiFriendsMap = {};
        apiFriends.forEach(friend => {
            apiFriendsMap[friend.steamid] = friend;
        });
        
        // Fetch friend names from Steam Web API
        console.log('Fetching friend names from API...');
        fetchFriendNames(friendSteamIDs, (err, namesMap) => {
            if (err) {
                console.log('Error fetching friend names:', err.message);
                // Continue with Unknown names if API fails
            }
            
            console.log('\n=== Checking Friends for Removal ===');
            console.log(`Removing friends added between ${DATE_REMOVAL.toLocaleDateString()} and ${DATE_REMOVAL_MAX.toLocaleDateString()} (timestamp >= ${REMOVE_TIMESTAMP} && timestamp <= ${REMOVE_TIMESTAMP_MAX})`);
            console.log(`Lower threshold date: ${new Date(REMOVE_TIMESTAMP * 1000).toLocaleString()}`);
            console.log(`Upper threshold date: ${new Date(REMOVE_TIMESTAMP_MAX * 1000).toLocaleString()}`);
            console.log(`Friends to remove by name (regardless of date): ${FRIENDS_TO_REMOVE_BY_NAME.length > 0 ? FRIENDS_TO_REMOVE_BY_NAME.join(', ') : 'None'}`);
            console.log(`Friends to keep (exception list): ${FRIENDS_TO_KEEP.length > 0 ? FRIENDS_TO_KEEP.join(', ') : 'None'}\n`);
            
            let removedCount = 0;
            let checkedCount = 0;
            const friendsToRemove = [];
            
            // Check each friend in the client's friend list
            Object.keys(client.myFriends).forEach((steamIDStr) => {
                checkedCount++;
                const apiFriend = apiFriendsMap[steamIDStr];
                
                // Get friend name from API names map, fallback to client.users, then Unknown
                let friendName = 'Unknown';
                if (namesMap && namesMap[steamIDStr]) {
                    friendName = namesMap[steamIDStr];
                } else {
                    const user = client.users[steamIDStr];
                    friendName = user ? (user.player_name || user.persona_name || 'Unknown') : 'Unknown';
                }
            
            // Check if friend name is in the exception list (case-insensitive)
            // Friends in this list will NOT be removed
            const isNameInKeepList = FRIENDS_TO_KEEP.some(
                nameToKeep => friendName.toLowerCase() === nameToKeep.toLowerCase()
            );
            
            // Check if friend name is in the removal list (case-insensitive)
            // Friends in this list will be removed regardless of date
            const isNameInRemovalList = FRIENDS_TO_REMOVE_BY_NAME.some(
                nameToRemove => friendName.toLowerCase() === nameToRemove.toLowerCase()
            );
            
            let shouldRemove = false;
            let removalReason = '';
            
            // Priority 1: If friend is in keep list, don't remove them
            if (isNameInKeepList) {
                const dateAdded = apiFriend && apiFriend.friend_since 
                    ? new Date(apiFriend.friend_since * 1000) 
                    : null;
                console.log(`[${checkedCount}] Keeping friend: ${friendName} (in keep list${dateAdded ? `, added ${dateAdded.toLocaleString()}` : ''})`);
            } 
            // Priority 2: If friend is in removal list, remove them regardless of date
            else if (isNameInRemovalList) {
                shouldRemove = true;
                removalReason = 'Name in removal list';
            } 
            // Priority 3: Check date condition (only if not in keep list)
            else if (apiFriend && apiFriend.friend_since) {
                const friendSinceTimestamp = apiFriend.friend_since;
                const dateAdded = new Date(friendSinceTimestamp * 1000);
                
                // Check if friend was added between ${DATE_REMOVAL.toLocaleDateString()} and ${DATE_REMOVAL_MAX.toLocaleDateString()}
                if (friendSinceTimestamp >= REMOVE_TIMESTAMP && friendSinceTimestamp <= REMOVE_TIMESTAMP_MAX) {
                    shouldRemove = true;
                    removalReason = `Date between ${DATE_REMOVAL.toLocaleDateString()} and ${DATE_REMOVAL_MAX.toLocaleDateString()} (${dateAdded.toLocaleString()})`;
                } else {
                    console.log(`[${checkedCount}] Keeping friend: ${friendName} (added ${dateAdded.toLocaleString()})`);
                }
            } else {
                // If we can't get the friend_since date and name is not in any list, skip
                console.log(`[${checkedCount}] Skipping friend: ${friendName} (no friend_since data available and not in any list)`);
            }
            
            if (shouldRemove) {
                const dateAdded = apiFriend && apiFriend.friend_since 
                    ? new Date(apiFriend.friend_since * 1000) 
                    : null;
                
                console.log(`[${checkedCount}] Friend to remove:`);
                console.log(`   Steam ID: ${steamIDStr}`);
                console.log(`   Name: ${friendName}`);
                if (dateAdded) {
                    console.log(`   Date Added: ${dateAdded.toLocaleString()}`);
                }
                console.log(`   Reason: ${removalReason}`);
                
                friendsToRemove.push({
                    steamID: steamIDStr,
                    name: friendName,
                    dateAdded: dateAdded,
                    reason: removalReason
                });
            }
        });
        
        console.log(`\n=== Summary ===`);
        console.log(`Total friends checked: ${checkedCount}`);
        console.log(`Friends to remove: ${friendsToRemove.length}`);
        
        if (friendsToRemove.length > 0) {
            console.log(`\n=== Removing Friends ===`);
            
            // Remove friends one by one with a small delay to avoid rate limiting
            friendsToRemove.forEach((friend, index) => {
                setTimeout(() => {
                    console.log(`Removing friend ${index + 1}/${friendsToRemove.length}: ${friend.name} (${friend.steamID})`);
                    client.removeFriend(friend.steamID);
                    removedCount++;
                    
                    if (removedCount === friendsToRemove.length) {
                        console.log(`\n=== Completed ===`);
                        console.log(`Successfully removed ${removedCount} friend(s) added between ${DATE_REMOVAL.toLocaleDateString()} and ${DATE_REMOVAL_MAX.toLocaleDateString()}.`);
                    }
                }, index * 500); // 500ms delay between each removal
            });
        } else {
            console.log(`No friends to remove. All friends were added outside the range ${DATE_REMOVAL.toLocaleDateString()} - ${DATE_REMOVAL_MAX.toLocaleDateString()}.`);
        }
        }); // End of fetchFriendNames callback
    }); // End of fetchFriendsFromAPI callback
});

// Error handling
client.on('error', function(err) {
    console.log('Error:', err);
});

client.on('disconnected', function(errcode, msg) {
    console.log('Disconnected from Steam. Error code:', errcode, 'Message:', msg);
});
