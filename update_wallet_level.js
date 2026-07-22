const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const { db, saveAccount, saveGifts, saveSentGifts, saveRefreshToken, getRefreshToken, clearRefreshToken } = require('./db');
const { getUserCountry, getAccountPoints, fetchCommunityPage } = require('./steam_helpers');
const { parsePendingGifts, parseSentGifts } = require('./single');

/**
 * Log into a single account and update only its wallet balance + Steam level.
 * Resolves with { ok, username, reason?, partial? } — never rejects.
 */
function updateWalletLevel(account, opts = {}) {
    const { timeout = 60000, log = console.log, mode = 'all' } = opts;
    const tag = `[${account.username}]`;
    // mode: 'all'    = wallet + level/country/points + gift scan;
    //       'wallet' = wallet balance only (skip level/country/points and gifts);
    //       'gifts'  = sent/received gift scan only.
    const isAll = mode === 'all';
    const doWallet = mode === 'all' || mode === 'wallet';
    const doGifts = mode === 'all' || mode === 'gifts';

    return new Promise((resolve) => {
        const client = new SteamUser({
            // Renew the refresh token after a refresh-token login so its ~200-day
            // expiry keeps sliding forward. Steam only actually renews once the
            // token is past ~half its lifetime; otherwise this is a no-op. On
            // success it re-emits 'refreshToken' → saveRefreshToken (below).
            renewRefreshTokens: true
        });
        const community = new SteamCommunity();
        const flags = { account: false, email: false, wallet: false, level: false, country: false, points: false, gifts: false };
        // Only the flags relevant to the active mode gate completion. 'wallet'
        // mode waits on the wallet balance alone; level/country/points/email are
        // full-scan ('all') extras.
        const need = {
            account: isAll, email: isAll, wallet: doWallet,
            level: isAll, country: isAll, points: isAll,
            gifts: doGifts
        };
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
            if (Object.keys(need).every((k) => !need[k] || flags[k])) {
                log(`${tag} done`);
                finish({ ok: true, username: account.username });
            }
        };

        const timer = setTimeout(() => {
            log(`${tag} timeout — partial:`, flags);
            finish({ ok: false, reason: 'timeout', username: account.username, partial: { ...flags } });
        }, timeout);

        client.on('error', (err) => {
            log(`${tag} error:`, err.message);
            if (/InvalidPassword|AccessDenied|Expired/i.test(err.message)) {
                clearRefreshToken(account.username);
                log(`${tag} cleared cached refresh token`);
            }
            finish({ ok: false, reason: err.message, username: account.username });
        });

        client.on('refreshToken', (token) => {
            saveRefreshToken(account.username, token);
            log(`${tag} refresh token saved`);
        });

        client.on('loggedOn', () => {
            steamID = client.steamID.getSteamID64();
            log(`${tag} logged in: ${steamID}`);
            client.setPersona(SteamUser.EPersonaState.Online);
            client.gamesPlayed([]);

            if (!isAll) return;

            // Real registered country — NOT accountInfo's ip_country (login-IP geolocation).
            getUserCountry(client, steamID).then((country) => {
                saveAccount({ steam_id: steamID, country });
                log(`${tag} country: ${country ?? '(none)'}`);
                flags.country = true;
                check();
            });

            getAccountPoints(client, steamID).then((points) => {
                saveAccount({ steam_id: steamID, steam_points: points });
                log(`${tag} points: ${points ?? '(none)'}`);
                flags.points = true;
                check();
            });
        });

        // accountInfo passes positional args (name, country, ...), NOT an object.
        // We persist persona here, but country comes from getUserCountry (the ip_country
        // arg is the login-IP geolocation, not the account's real country).
        client.on('accountInfo', (name) => {
            saveAccount({
                steam_id: steamID,
                account_name: account.username,
                persona: name
            });
            flags.account = true;
            check();

            if (!isAll) return;

            // Fetch the Steam level once the session is established (calling this
            // too early in loggedOn can return empty results).
            client.getSteamLevels([steamID], (err, results) => {
                const level = results?.[steamID];
                if (!err && level != null) {
                    saveAccount({ steam_id: steamID, steam_level: level });
                    log(`${tag} level: ${level}`);
                } else if (err) {
                    log(`${tag} getSteamLevels error:`, err.message);
                } else {
                    log(`${tag} getSteamLevels returned no level`);
                }
                flags.level = true;
                check();
            });
        });

        // Email arrives in its own message (ClientEmailAddrInfo), independent of
        // accountInfo — so it must be persisted from this event, not from accountInfo.
        client.on('emailInfo', (address) => {
            if (!isAll) return;

            saveAccount({ steam_id: steamID, email: address });
            log(`${tag} email: ${address ?? '(none)'}`);
            flags.email = true;
            check();
        });

        client.on('wallet', (hasWallet, currency, balance) => {
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

        // Scrape the server-rendered inventory page for pending (unredeemed) gifts,
        // same as single.js's full scan.
        client.on('webSession', async (sessionID, cookies) => {
            if (!doGifts) return;
            community.setCookies(cookies);
            const url = `https://steamcommunity.com/profiles/${steamID}/inventory/`;
            const { ok, status, data, error } = await fetchCommunityPage(community, url, { log, tag });
            if (!ok) {
                log(`${tag} inventory fetch failed:`, error?.message || `status ${status}`);
                flags.gifts = true;
                return check();
            }
            const gifts = parsePendingGifts(data);
            saveGifts(steamID, gifts);
            const sent = parseSentGifts(data);
            saveSentGifts(steamID, sent);
            log(`${tag} ${gifts.length} received gifts, ${sent.length} sent gifts saved`);
            flags.gifts = true;
            check();
        });

        const cachedToken = getRefreshToken(account.username);
        if (cachedToken) {
            log(`${tag} using cached refresh token`);
            client.logOn({ refreshToken: cachedToken });
        } else if (account.password) {
            log(`${tag} no cached token — using password (Steam Guard may prompt)`);
            client.logOn({ accountName: account.username, password: account.password });
        } else {
            finish({ ok: false, reason: 'no token and no password', username: account.username });
        }
    });
}

async function runWithConcurrency(items, n, worker) {
    let cursor = 0;
    const results = [];
    const workers = Array.from({ length: n }, async () => {
        while (cursor < items.length) {
            const idx = cursor++;
            console.log(`>> [${idx + 1}/${items.length}] starting ${items[idx].username}`);
            results[idx] = await worker(items[idx]);
        }
    });
    await Promise.all(workers);
    return results;
}

if (require.main === module) {
    // Usage:
    //   node update_wallet_level.js                          # all accounts with cached tokens
    //   node update_wallet_level.js DeanaIsabel              # just that account
    //   node update_wallet_level.js DeanaIsabel JamiNina     # several accounts
    //   node update_wallet_level.js --names=a,b,c            # several accounts (comma list)
    //   node update_wallet_level.js DeanaIsabel -c 1 -t 90000
    //   node update_wallet_level.js --mode=wallet           # wallet balance only
    //   node update_wallet_level.js --mode=gifts            # sent/received gift scan only
    // Bare positional args are account names (an account name may itself be
    // numeric, so concurrency/timeout are flags, not positionals).
    let concurrency = 5;
    let timeout = 60000;
    let mode = 'all';
    const names = [];
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-c' || a === '--concurrency') concurrency = parseInt(argv[++i], 10);
        else if (a.startsWith('--concurrency=')) concurrency = parseInt(a.split('=')[1], 10);
        else if (a === '-t' || a === '--timeout') timeout = parseInt(argv[++i], 10);
        else if (a.startsWith('--timeout=')) timeout = parseInt(a.split('=')[1], 10);
        else if (a === '-m' || a === '--mode') mode = argv[++i];
        else if (a.startsWith('--mode=')) mode = a.split('=')[1];
        else if (a.startsWith('--names=')) names.push(...a.slice('--names='.length).split(',').map((s) => s.trim()).filter(Boolean));
        else if (a.startsWith('--')) { console.error(`unknown flag: ${a}`); process.exit(1); }
        else names.push(a);
    }

    if (!['all', 'wallet', 'gifts'].includes(mode)) {
        console.error(`invalid --mode '${mode}', expected one of: all, wallet, gifts`);
        process.exit(1);
    }

    // Map lowercased name -> canonical stored account_name, so callers can type
    // any case and still hit the cached token.
    const tokenNames = db.prepare('SELECT account_name FROM auth_tokens').all().map((r) => r.account_name);
    const byLower = new Map(tokenNames.map((n) => [n.toLowerCase(), n]));

    let accounts;
    if (names.length) {
        accounts = names.map((n) => ({ username: byLower.get(n.toLowerCase()) || n }));
        const missing = names.filter((n) => !byLower.has(n.toLowerCase()));
        if (missing.length) {
            console.log(`Warning: no cached token for: ${missing.join(', ')} (will fail without a password)`);
        }
        console.log(`Refreshing ${accounts.length} specified account(s). Mode: ${mode}. Concurrency: ${concurrency}.`);
    } else {
        // Every account we hold a refresh token for (login without 2FA).
        accounts = db.prepare('SELECT account_name AS username FROM auth_tokens ORDER BY account_name').all();
        console.log(`Loaded ${accounts.length} accounts with cached tokens. Mode: ${mode}. Concurrency: ${concurrency}.`);
    }

    runWithConcurrency(accounts, concurrency, (acc) => updateWalletLevel(acc, { timeout, mode }))
        .then((results) => {
            const ok = results.filter(r => r?.ok).length;
            const failed = results.filter(r => !r?.ok);
            console.log(`\n=== Done: ${ok}/${results.length} ok ===`);
            failed.forEach(r => console.log(`  FAIL ${r.username}: ${r.reason}`));
            process.exit(0);
        });
}

module.exports = { updateWalletLevel };
