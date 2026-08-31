// Fetch each account's owned games + playtime and store them in game_playtime.
//
// The Steam Web API (GetOwnedGames) only returns data for profiles whose "game
// details" are public — most farmed accounts are private, so it comes back
// empty. This logs into the account with its cached token and scrapes the
// account's OWN community games page, which shows playtime regardless of the
// public privacy setting. Playtime is stored in MINUTES.
//
// Usage:
//   node steam_playtime.js                       # all accounts with a cached token
//   node steam_playtime.js DeanaIsabel           # one account
//   node steam_playtime.js a b c                 # several
//   node steam_playtime.js --names=a,b,c
//   node steam_playtime.js -c 3 -t 90000         # concurrency / per-account timeout

const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const { db, saveGamePlaytime, getRefreshToken, saveRefreshToken, clearRefreshToken } = require('./db');
const { fetchCommunityPage } = require('./steam_helpers');

// Parse the community games page. The new React page embeds the games as a
// multiply-escaped JSON blob; this pulls appid/name/playtime tolerant of any
// backslash-escaping depth, then de-dups by appid.
function parseGamesPage(html) {
    const games = [];
    const re = /\\*"appid\\*":(\d+),\\*"name\\*":\\*"((?:[^"\\]|\\+.)*?)\\*"/g;
    let m;
    while ((m = re.exec(html))) {
        const appid = Number(m[1]);
        const name = m[2].replace(/\\+(.)/g, '$1');
        const win = html.slice(m.index, m.index + 3000); // same game object
        const pf = win.match(/\\*"playtime_forever\\*":(\d+)/);
        const p2 = win.match(/\\*"playtime_2weeks\\*":(\d+)/);
        games.push({ appid, name, playtime_forever: pf ? Number(pf[1]) : 0, playtime_2weeks: p2 ? Number(p2[1]) : 0 });
    }
    const seen = new Set();
    return games.filter((g) => g.appid && !seen.has(g.appid) && seen.add(g.appid));
}

/**
 * Log into one account, scrape its games page, save playtime to the DB.
 * Resolves with { ok, username, count?, total_minutes?, reason? } — never rejects.
 */
function fetchPlaytime(account, opts = {}) {
    const { timeout = 90000, log = console.log } = opts;
    const tag = `[${account.username}]`;
    return new Promise((resolve) => {
        const client = new SteamUser({ renewRefreshTokens: true });
        const community = new SteamCommunity({ timeout: 15000 });
        let steamID = null;
        let resolved = false;
        const finish = (r) => { if (resolved) return; resolved = true; clearTimeout(timer); try { client.logOff(); } catch (_) {} resolve(r); };
        const timer = setTimeout(() => { log(`${tag} timeout`); finish({ ok: false, reason: 'timeout', username: account.username }); }, timeout);

        client.on('error', (err) => {
            log(`${tag} error:`, err.message);
            if (/InvalidPassword|AccessDenied|Expired/i.test(err.message)) { clearRefreshToken(account.username); log(`${tag} cleared cached refresh token`); }
            finish({ ok: false, reason: err.message, username: account.username });
        });
        client.on('refreshToken', (token) => saveRefreshToken(account.username, token));
        client.on('loggedOn', () => {
            steamID = client.steamID.getSteamID64();
            log(`${tag} logged in: ${steamID}`);
            client.setPersona(SteamUser.EPersonaState.Online);
            client.gamesPlayed([]);
        });
        client.on('webSession', async (sessionID, cookies) => {
            community.setCookies(cookies);
            const url = `https://steamcommunity.com/profiles/${steamID}/games/?tab=all`;
            const { ok, status, data, error, rateLimited } = await fetchCommunityPage(community, url, { log, tag });
            if (!ok) {
                const reason = rateLimited ? 'rate limited (HTTP 429) — try later' : `games page fetch failed (${error?.message || 'status ' + status})`;
                log(`${tag} ${reason}`);
                return finish({ ok: false, reason, username: account.username });
            }
            const games = parseGamesPage(data);
            saveGamePlaytime(steamID, games);
            const totalMin = games.reduce((s, g) => s + (g.playtime_forever || 0), 0);
            const played = games.filter((g) => (g.playtime_forever || 0) > 0).length;
            log(`${tag} ${games.length} games (${played} played), ${(totalMin / 60).toFixed(1)} h total`);
            finish({ ok: true, username: account.username, count: games.length, played, total_minutes: totalMin });
        });

        const token = getRefreshToken(account.username);
        if (token) { log(`${tag} using cached refresh token`); client.logOn({ refreshToken: token }); }
        else if (account.password) { log(`${tag} no token — using password`); client.logOn({ accountName: account.username, password: account.password }); }
        else finish({ ok: false, reason: 'no token and no password', username: account.username });
    });
}

async function runWithConcurrency(items, n, worker) {
    let cursor = 0;
    const results = [];
    const workers = Array.from({ length: Math.max(1, n) }, async () => {
        while (cursor < items.length) {
            const idx = cursor++;
            console.log(`>> [${idx + 1}/${items.length}] ${items[idx].username}`);
            results[idx] = await worker(items[idx]);
        }
    });
    await Promise.all(workers);
    return results;
}

if (require.main === module) {
    let concurrency = 3;
    let timeout = 90000;
    const names = [];
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-c' || a === '--concurrency') concurrency = parseInt(argv[++i], 10);
        else if (a.startsWith('--concurrency=')) concurrency = parseInt(a.split('=')[1], 10);
        else if (a === '-t' || a === '--timeout') timeout = parseInt(argv[++i], 10);
        else if (a.startsWith('--timeout=')) timeout = parseInt(a.split('=')[1], 10);
        else if (a.startsWith('--names=')) names.push(...a.slice('--names='.length).split(',').map((s) => s.trim()).filter(Boolean));
        else if (a.startsWith('--')) { console.error(`unknown flag: ${a}`); process.exit(1); }
        else names.push(a);
    }

    const tokenNames = db.prepare('SELECT account_name FROM auth_tokens').all().map((r) => r.account_name);
    const byLower = new Map(tokenNames.map((n) => [n.toLowerCase(), n]));
    let accounts;
    if (names.length) {
        accounts = names.map((n) => ({ username: byLower.get(n.toLowerCase()) || n }));
        const missing = names.filter((n) => !byLower.has(n.toLowerCase()));
        if (missing.length) console.log(`Warning: no cached token for: ${missing.join(', ')} (will fail without a password)`);
        console.log(`Fetching playtime for ${accounts.length} account(s). Concurrency: ${concurrency}.`);
    } else {
        accounts = db.prepare('SELECT account_name AS username FROM auth_tokens ORDER BY account_name').all();
        console.log(`Loaded ${accounts.length} accounts with cached tokens. Concurrency: ${concurrency}.`);
    }
    if (accounts.length === 0) { console.log('Nothing to do.'); process.exit(0); }

    runWithConcurrency(accounts, concurrency, (acc) => fetchPlaytime(acc, { timeout }))
        .then((results) => {
            const ok = results.filter((r) => r?.ok);
            const failed = results.filter((r) => !r?.ok);
            const totalGames = ok.reduce((s, r) => s + (r.count || 0), 0);
            console.log(`\n=== Done: ${ok.length}/${results.length} ok, ${totalGames} games recorded ===`);
            failed.forEach((r) => console.log(`  FAIL ${r.username}: ${r.reason}`));
            process.exit(0);
        });
}

module.exports = { fetchPlaytime, parseGamesPage };
