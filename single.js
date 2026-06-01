const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const https = require('https');
const {
    saveAccount, saveFriends, saveLicenses, saveGifts,
    saveRefreshToken, getRefreshToken, clearRefreshToken
} = require('./db');

const STEAM_API_KEY = 'EFB5DCE316D3146FD6EFA3BECB8BCB80';

function fetchFriendsFromAPI(steamID64) {
    return new Promise((resolve) => {
        const url = `https://api.steampowered.com/ISteamUser/GetFriendList/v0001/?key=${STEAM_API_KEY}&steamid=${steamID64}&relationship=friend`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                if (res.statusCode !== 200 || data.trim().startsWith('<')) return resolve([]);
                try {
                    const json = JSON.parse(data);
                    resolve(json.friendslist?.friends || []);
                } catch (_) { resolve([]); }
            });
        }).on('error', () => resolve([]));
    });
}

function parsePendingGifts(html) {
    const giftIDs = [...new Set(
        [...html.matchAll(/id="pending_gift_(\d+)"/g)].map(m => m[1])
    )];
    return giftIDs.map(gid => {
        const hoverRE = new RegExp(
            `BuildHover\\(\\s*'pending_gift_iteminfo_${gid}'\\s*,\\s*(\\{[\\s\\S]*?\\})\\s*,\\s*UserYou`
        );
        const hoverMatch = html.match(hoverRE);
        let item = {};
        if (hoverMatch) { try { item = JSON.parse(hoverMatch[1]); } catch (_) {} }

        const sectionRE = new RegExp(
            `<div id="pending_gift_${gid}"[\\s\\S]*?(?=<div id="pending_gift_\\d|$)`
        );
        const section = (html.match(sectionRE) || [''])[0];
        const senderProfileMatch = section.match(/href="https:\/\/steamcommunity\.com\/profiles\/(\d+)"[^>]*data-miniprofile/);
        const senderNameMatch = section.match(/<div class="signature_line">[\s\S]*?<p>([^<]+)<\/p>/);
        const dateMatch = section.match(/From\s+<a[^>]*>[^<]+<\/a>\s+on\s+([^<\n]+?)\s*<\/p>/);
        const statusMatch = section.match(/Status:\s*([^<\n]+?)\s*<\/p>/);
        const action = (item.actions || []).find(a => a.link);

        return {
            gift_id: gid,
            item_name: item.name || '(unknown)',
            detail: (item.descriptions || []).map(d => d.value).filter(Boolean)[0] || null,
            sender_steam_id: senderProfileMatch ? senderProfileMatch[1] : null,
            sender_name: senderNameMatch ? senderNameMatch[1].trim() : null,
            sent_at: dateMatch ? dateMatch[1].trim() : null,
            status: statusMatch ? statusMatch[1].trim() : null,
            store_url: action?.link || null
        };
    });
}

/**
 * Scan a single account and persist its data to the DB.
 * Resolves with { ok, account, reason?, partial? } — never rejects.
 *
 * @param {{id?: any, username: string, password: string}} account
 * @param {{timeout?: number, log?: Function}} opts
 */
function scanAccount(account, opts = {}) {
    const { timeout = 60000, log = console.log } = opts;
    const tag = `[${account.id ?? account.username}]`;

    return new Promise((resolve) => {
        const client = new SteamUser({
            picCacheSize: 100,
            picsCacheAll: true,
            changelistUpdateInterval: 10000
        });
        const community = new SteamCommunity();

        const flags = { account: false, wallet: false, friends: false, licenses: false, gifts: false, levels: false };
        let steamID = null;
        let resolved = false;

        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            try { client.logOff(); } catch (_) {}
            resolve(result);
        };

        const check = () => {
            if (Object.values(flags).every(Boolean)) {
                log(`${tag} done`);
                finish({ ok: true, account });
            }
        };

        const timer = setTimeout(() => {
            log(`${tag} timeout — partial flags:`, flags);
            finish({ ok: false, reason: 'timeout', account, partial: { ...flags } });
        }, timeout);

        client.on('error', (err) => {
            log(`${tag} error:`, err.message);
            // If the saved refresh token was revoked/expired, drop it so the next run
            // falls back to password + 2FA prompt.
            if (/InvalidPassword|AccessDenied|Expired/i.test(err.message)) {
                clearRefreshToken(account.username);
                log(`${tag} cleared cached refresh token`);
            }
            finish({ ok: false, reason: err.message, account });
        });

        // steam-user emits this once after a successful login; persist for next run.
        client.on('refreshToken', (token) => {
            saveRefreshToken(account.username, token);
            log(`${tag} refresh token saved`);
        });

        client.on('loggedOn', () => {
            steamID = client.steamID.getSteamID64();
            log(`${tag} logged in: ${steamID}`);
            client.setPersona(SteamUser.EPersonaState.Online);
            client.gamesPlayed([]);
        });

        client.on('accountInfo', (info) => {
            saveAccount({
                steam_id: steamID,
                account_name: account.username,
                persona: info.name,
                country: info.country,
                email: client.emailInfo?.address
            });
            flags.account = true;
            check();
        });

        client.on('wallet', (hasWallet, currency, balance) => {
            // steam-user emits `balance` already in main currency units (e.g. dollars),
            // not the smallest unit. Convert to integer cents for DB storage.
            const cents = balance == null ? null : Math.round(balance * 100);
            saveAccount({
                steam_id: steamID,
                wallet_currency: SteamUser.ECurrencyCode[currency] || String(currency || ''),
                wallet_balance_cents: cents
            });
            log(`${tag} wallet: ${SteamUser.ECurrencyCode[currency] || currency} ${(balance ?? 0).toFixed(2)}`);
            flags.wallet = true;
            check();
        });

        client.on('friendsList', async () => {
            const apiFriends = await fetchFriendsFromAPI(steamID);
            const apiMap = Object.fromEntries(apiFriends.map(f => [f.steamid, f]));
            const dbFriends = Object.keys(client.myFriends).map(sid => {
                const user = client.users[sid];
                const rel = client.myFriends[sid];
                return {
                    steam_id: sid,
                    name: user?.player_name || null,
                    added_at: apiMap[sid]?.friend_since || null,
                    relationship: typeof rel === 'number' ? rel : null
                };
            });
            saveFriends(steamID, dbFriends);
            log(`${tag} ${dbFriends.length} friends saved`);
            flags.friends = true;
            check();

            // Fetch Steam levels for self + friends (independent of friends flag)
            const ids = [steamID, ...dbFriends.map(f => f.steam_id)];
            client.getSteamLevels(ids, (err, results) => {
                if (!err && results) {
                    saveAccount({ steam_id: steamID, steam_level: results[steamID] ?? null });
                    saveFriends(steamID, dbFriends.map(f => ({ steam_id: f.steam_id, level: results[f.steam_id] ?? null })));
                    log(`${tag} levels saved (self=${results[steamID]})`);
                } else if (err) {
                    log(`${tag} getSteamLevels error:`, err.message);
                }
                flags.levels = true;
                check();
            });
        });

        client.on('licenses', (licenses) => {
            licenses = licenses.filter(l => l.package_id !== 0);
            if (licenses.length === 0) {
                saveLicenses(steamID, []);
                flags.licenses = true;
                return check();
            }
            const packageIDs = licenses.map(l => l.package_id);

            client.getProductInfo([], packageIDs, true, (err, _apps, packages) => {
                if (err) {
                    log(`${tag} licenses getProductInfo error:`, err.message);
                    flags.licenses = true;
                    return check();
                }
                const appIDs = new Set();
                Object.values(packages).forEach(pkg => {
                    (pkg?.packageinfo?.appids || []).forEach(id => appIDs.add(id));
                });

                client.getProductInfo([...appIDs], [], true, (err2, appInfos) => {
                    const appNames = {};
                    if (!err2 && appInfos) {
                        Object.entries(appInfos).forEach(([id, info]) => {
                            appNames[id] = info?.appinfo?.common?.name || null;
                        });
                    }
                    const dbRows = licenses.map(lic => {
                        const pkgInfo = packages[lic.package_id]?.packageinfo;
                        return {
                            package_id: lic.package_id,
                            package_name: pkgInfo?.name || '(unknown)',
                            payment_method: SteamUser.EPaymentMethod[lic.payment_method] || String(lic.payment_method),
                            license_type: SteamUser.ELicenseType[lic.license_type] || String(lic.license_type),
                            purchased_at: lic.time_created || null,
                            territory_code: lic.territory_code,
                            apps: (pkgInfo?.appids || []).map(id => ({ app_id: id, app_name: appNames[id] || null }))
                        };
                    });
                    saveLicenses(steamID, dbRows);
                    log(`${tag} ${dbRows.length} licenses saved`);
                    flags.licenses = true;
                    check();
                });
            });
        });

        client.on('webSession', (sessionID, cookies) => {
            community.setCookies(cookies);
            const url = `https://steamcommunity.com/profiles/${steamID}/inventory/`;
            community.httpRequestGet(url, (err, res, data) => {
                if (err || res.statusCode !== 200) {
                    log(`${tag} inventory fetch failed:`, err?.message || `status ${res.statusCode}`);
                    flags.gifts = true;
                    return check();
                }
                const gifts = parsePendingGifts(data);
                saveGifts(steamID, gifts);
                log(`${tag} ${gifts.length} pending gifts saved`);
                flags.gifts = true;
                check();
            });
        });

        const cachedToken = getRefreshToken(account.username);
        if (cachedToken) {
            log(`${tag} using cached refresh token (no 2FA needed)`);
            client.logOn({ refreshToken: cachedToken });
        } else {
            log(`${tag} no cached token — using password (Steam Guard may prompt)`);
            client.logOn({ accountName: account.username, password: account.password });
        }
    });
}

module.exports = { scanAccount };
// nookstostazr----fungaLrmbQV3
// Run directly: node single.js
if (require.main === module) {
    const acc = { id: 1, username: 'nookstostazr', password: 'fungaLrmbQV3' };
    scanAccount(acc).then((r) => {
        console.log('Result:', r);
        process.exit(r.ok ? 0 : 1);
    });
}
