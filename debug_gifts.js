// Debug: log into one account, dump the inventory page, show parse result.
// Usage: node debug_gifts.js <username>
const fs = require('fs');
const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const { getRefreshToken } = require('./db');
const { parsePendingGifts } = require('./single');

const username = process.argv[2];
if (!username) { console.error('usage: node debug_gifts.js <username>'); process.exit(1); }

const client = new SteamUser();
const community = new SteamCommunity();
const token = getRefreshToken(username);
if (!token) { console.error(`no cached token for ${username}`); process.exit(1); }

client.on('error', (e) => { console.error('error:', e.message); process.exit(1); });
client.on('loggedOn', () => {
    console.log('logged in:', client.steamID.getSteamID64());
});
client.on('webSession', (sid, cookies) => {
    const steamID = client.steamID.getSteamID64();
    community.setCookies(cookies);
    const url = `https://steamcommunity.com/profiles/${steamID}/inventory/`;
    console.log('GET', url);
    community.httpRequestGet(url, (err, res, data) => {
        if (err) { console.error('fetch err:', err.message); process.exit(1); }
        console.log('status:', res.statusCode, 'bytes:', data.length);
        fs.writeFileSync('/tmp/inv.html', data);
        console.log('wrote /tmp/inv.html');
        console.log('contains "pending_gift":', data.includes('pending_gift'));
        console.log('count of id="pending_gift_":', (data.match(/id="pending_gift_\d+"/g) || []).length);
        console.log('contains "g_rgWalletInfo":', data.includes('g_rgWalletInfo'));
        const gifts = parsePendingGifts(data);
        console.log('parsed gifts:', JSON.stringify(gifts, null, 2));
        client.logOff();
        process.exit(0);
    });
});

client.logOn({ refreshToken: token });
