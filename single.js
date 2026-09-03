const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const https = require('https');
const store = require('./store');
const { getUserCountry, getAccountPoints, fetchCommunityPage } = require('./steam_helpers');

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

function collapseWs(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
}

// Parse the "Sent Gifts" section of the inventory page: gifts this account sent
// to a friend that haven't been accepted yet (each carries a "Resend gift..."
// action). Distinct markup from received gifts (parsePendingGifts). Each block:
//   <div class="sent_gift">
//     ... <a href=".../checkout/sendgift/<gift_id>">Resend gift...</a> ...
//     <div class="gift_item_details"><b>item name</b><br>Steam Gift</div>
//     <div class="gift_status_area">Sent to <a .../profiles/<id>>name</a> on <date></div>
//   </div>
function parseSentGifts(html) {
    return html.split('<div class="sent_gift">').slice(1).map((raw) => {
        // Bound each block: the section ends at the next header or sent_gift block.
        const block = raw.split(/<div class="pending_gifts_header">/)[0];
        const idMatch = block.match(/checkout\/sendgift\/(\d+)/);
        if (!idMatch) return null;
        const nameMatch = block.match(/<div class="gift_item_details">\s*<b[^>]*>([\s\S]*?)<\/b>/);
        const detailMatch = block.match(/<\/b>\s*<br>\s*([\s\S]*?)\s*<\/div>/);
        const statusArea = (block.match(/<div class="gift_status_area">([\s\S]*?)<\/div>/) || [])[1] || '';
        const recipMatch = statusArea.match(/profiles\/(\d+)"[^>]*>([^<]+)<\/a>/);
        const dateMatch = statusArea.match(/<\/a>\s*on\s+([\s\S]+?)\s*$/);
        return {
            gift_id: idMatch[1],
            item_name: nameMatch ? collapseWs(nameMatch[1]) : '(unknown)',
            detail: detailMatch ? collapseWs(detailMatch[1]) : null,
            recipient_steam_id: recipMatch ? recipMatch[1] : null,
            recipient_name: recipMatch ? recipMatch[2].trim() : null,
            sent_at: dateMatch ? collapseWs(dateMatch[1]) : null,
            status: 'pending',
            store_url: `https://store.steampowered.com/${idMatch[0]}`
        };
    }).filter(Boolean);
}

/**
 * Scan a single account and persist its data to the DB.
 * Resolves with { ok, account, reason?, partial? } — never rejects.
 *
 * @param {{id?: any, username: string, password: string}} account
 * @param {{timeout?: number, log?: Function}} opts
 */
function scanAccount(account, opts = {}) {
    const { timeout = 60000, log = console.log, idOnly = false } = opts;
    const tag = `[${account.id ?? account.username}]`;

    return new Promise((resolve) => {
        const client = new SteamUser({
            picCacheSize: 100,
            picsCacheAll: true,
            changelistUpdateInterval: 10000,
            // Renew the refresh token after a refresh-token login so its ~200-day
            // expiry keeps sliding forward. Steam only actually renews once the
            // token is past ~half its lifetime; otherwise this is a no-op. On
            // success it re-emits 'refreshToken' → saveRefreshToken (below).
            renewRefreshTokens: true
        });
        const community = new SteamCommunity();

        const flags = { account: false, email: false, country: false, points: false, wallet: false, friends: false, licenses: false, gifts: false, levels: false };
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
            if (!Object.values(flags).every(Boolean)) return;
            log(`${tag} done`);
            finish({ ok: true, account });
        };

        // steam-user's EventEmitter does not await async handlers, so a rejected
        // store/D1 write inside one would become an unhandled rejection (which, en
        // masse, crashes the process). Route async handlers through this wrapper so
        // any failure is logged and contained to this account.
        const onSafe = (event, fn) => client.on(event, (...args) =>
            Promise.resolve().then(() => fn(...args)).catch((e) => log(`${tag} ${event} handler failed: ${e.message || e}`)));

        const timer = setTimeout(() => {
            log(`${tag} timeout — partial flags:`, flags);
            finish({ ok: false, reason: 'timeout', account, partial: { ...flags } });
        }, timeout);

        client.on('error', (err) => {
            log(`${tag} error:`, err.message);
            // If the saved refresh token was revoked/expired, drop it so the next run
            // falls back to password + 2FA prompt.
            if (/InvalidPassword|AccessDenied|Expired/i.test(err.message)) {
                store.clearRefreshToken(account.username).catch(() => {});
                log(`${tag} cleared cached refresh token`);
            }
            finish({ ok: false, reason: err.message, account });
        });

        // Steam is asking for a 2FA code (mobile authenticator or email). We have no
        // way to supply one in an unattended scan, so skip the account immediately —
        // not calling the callback and finishing here logs off before it can hang
        // until the timeout. Flagged skipped:true so callers can report it apart
        // from a hard failure.
        client.on('steamGuard', (domain) => {
            const kind = domain ? `email (${domain})` : 'mobile authenticator';
            log(`${tag} Steam Guard required (${kind}) — skipping`);
            finish({ ok: false, skipped: true, reason: `Steam Guard required (${kind})`, account });
        });

        // steam-user emits this once after a successful login; persist for next run.
        client.on('refreshToken', (token) => {
            store.saveRefreshToken(account.username, token).catch(() => {});
            log(`${tag} refresh token saved`);
        });

        client.on('loggedOn', () => {
            steamID = client.steamID.getSteamID64();
            log(`${tag} logged in: ${steamID}`);

            // "SteamID only": we just needed to log in to learn the SteamID64. Save
            // the id (+ login name / captured password) and finish — no persona,
            // wallet, friends, licenses, gifts, or the community-page fetch.
            if (idOnly) {
                store.saveAccount({ steam_id: steamID, account_name: account.username, source: account.source ?? null, steam_password: account.password ?? null })
                    .then(() => store.dropPendingStub(account.username)) // replace any pending:<username> placeholder
                    .then(() => { log(`${tag} steamID saved`); finish({ ok: true, account, steam_id: steamID }); })
                    .catch((e) => finish({ ok: false, reason: e.message, account }));
                return;
            }

            // Now that we have the real SteamID, drop any add-only placeholder row.
            store.dropPendingStub(account.username).catch(() => {});
            client.setPersona(SteamUser.EPersonaState.Online);
            client.gamesPlayed([]);

            // Real registered country — NOT accountInfo's ip_country (login-IP geolocation).
            getUserCountry(client, steamID).then(async (country) => {
                await store.saveAccount({ steam_id: steamID, country });
                log(`${tag} country: ${country ?? '(none)'}`);
                flags.country = true;
                check();
            }).catch((e) => { log(`${tag} country step failed: ${e.message || e}`); flags.country = true; check(); });

            getAccountPoints(client, steamID).then(async (points) => {
                await store.saveAccount({ steam_id: steamID, steam_points: points });
                log(`${tag} points: ${points ?? '(none)'}`);
                flags.points = true;
                check();
            }).catch((e) => { log(`${tag} points step failed: ${e.message || e}`); flags.points = true; check(); });
        });

        // accountInfo passes positional args (name, country, ...), NOT an object.
        // We persist persona here; country comes from getUserCountry (the ip_country
        // arg is the login-IP geolocation, not the account's real country).
        onSafe('accountInfo', async (name) => {
            await store.saveAccount({
                steam_id: steamID,
                account_name: account.username,
                persona: name,
                // Where this account was imported from (e.g. the uploaded file name),
                // if the caller supplied one. COALESCE keeps it on later re-scans.
                source: account.source ?? null,
                // Capture the login password on the initial (password) scan. Token-based
                // re-scans have no password, so COALESCE leaves the stored one intact.
                steam_password: account.password ?? null
            });
            flags.account = true;
            check();
        });

        // Email arrives in its own message (ClientEmailAddrInfo), independent of
        // accountInfo — so it must be persisted from this event, not from accountInfo.
        onSafe('emailInfo', async (address) => {
            await store.saveAccount({ steam_id: steamID, email: address });
            log(`${tag} email: ${address ?? '(none)'}`);
            flags.email = true;
            check();
        });

        onSafe('wallet', async (hasWallet, currency, balance) => {
            // steam-user emits `balance` already in main currency units (e.g. dollars),
            // not the smallest unit. Convert to integer cents for DB storage.
            const cents = balance == null ? null : Math.round(balance * 100);
            await store.saveAccount({
                steam_id: steamID,
                wallet_currency: SteamUser.ECurrencyCode[currency] || String(currency || ''),
                wallet_balance_cents: cents
            });
            log(`${tag} wallet: ${SteamUser.ECurrencyCode[currency] || currency} ${(balance ?? 0).toFixed(2)}`);
            flags.wallet = true;
            check();
        });

        onSafe('friendsList', async () => {
            if (idOnly) return;
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
            await store.saveFriends(steamID, dbFriends);
            log(`${tag} ${dbFriends.length} friends saved`);
            flags.friends = true;
            check();

            // Fetch Steam levels for self + friends (independent of friends flag)
            const ids = [steamID, ...dbFriends.map(f => f.steam_id)];
            client.getSteamLevels(ids, (err, results) => {
                if (!err && results) {
                    store.saveAccount({ steam_id: steamID, steam_level: results[steamID] ?? null }).catch(() => {});
                    store.saveFriends(steamID, dbFriends.map(f => ({ steam_id: f.steam_id, level: results[f.steam_id] ?? null }))).catch(() => {});
                    log(`${tag} levels saved (self=${results[steamID]})`);
                } else if (err) {
                    log(`${tag} getSteamLevels error:`, err.message);
                }
                flags.levels = true;
                check();
            });
        });

        onSafe('licenses', async (licenses) => {
            if (idOnly) return;
            licenses = licenses.filter(l => l.package_id !== 0);
            if (licenses.length === 0) {
                await store.saveLicenses(steamID, []);
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

                client.getProductInfo([...appIDs], [], true, async (err2, appInfos) => {
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
                    await store.saveLicenses(steamID, dbRows);
                    log(`${tag} ${dbRows.length} licenses saved`);
                    flags.licenses = true;
                    check();
                });
            });
        });

        onSafe('webSession', async (sessionID, cookies) => {
            if (idOnly) return;
            community.setCookies(cookies);
            const url = `https://steamcommunity.com/profiles/${steamID}/inventory/`;
            const { ok, status, data, error } = await fetchCommunityPage(community, url, { log, tag });
            if (!ok) {
                log(`${tag} inventory fetch failed:`, error?.message || `status ${status}`);
                flags.gifts = true;
                return check();
            }
            const gifts = parsePendingGifts(data);
            await store.saveGifts(steamID, gifts);
            const sent = parseSentGifts(data);
            await store.saveSentGifts(steamID, sent);
            log(`${tag} ${gifts.length} received gifts, ${sent.length} sent gifts saved`);
            flags.gifts = true;
            check();
        });

        store.getRefreshToken(account.username).then((cachedToken) => {
        if (cachedToken) {
            log(`${tag} using cached refresh token (no 2FA needed)`);
            client.logOn({ refreshToken: cachedToken });
        } else {
            log(`${tag} no cached token — using password (Steam Guard may prompt)`);
            client.logOn({ accountName: account.username, password: account.password });
        }
        }).catch((e) => finish({ ok: false, reason: e.message, account }));
    });
}

module.exports = { scanAccount, parsePendingGifts, parseSentGifts };
// nookstostazr----fungaLrmbQV3
// Run directly: node single.js
if (require.main === module) {
    const acc = { id: 1, username: 'johnkismetawjxr', password: 'FungadX1' };
    scanAccount(acc).then((r) => {
        console.log('Result:', r);
        process.exit(r.ok ? 0 : 1);
    });
}
