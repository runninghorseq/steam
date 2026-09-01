// Sync the sent_gifts table against Steam: re-scan every account that has
// recorded sent gifts, then delete any gift that no longer appears on Steam.
//
// A sent gift stays on the inventory page's "Sent Gifts" section only while it
// is pending; once the recipient accepts it, the row drops off the page. So we
// log into each account that currently has sent_gifts rows, scrape the live
// list, and reconcile: gift IDs present on Steam are upserted, gift IDs in the
// DB but absent from Steam are deleted. Unlike a full re-scan, this only logs
// into accounts that actually have sent gifts and reports each deleted gift_id.
//
// Login uses the cached refresh token (auth_tokens, keyed by account_name), so
// no 2FA prompt. Accounts without a token (or whose token is dead) are skipped.
//
// Usage:
//   node sync_sent_gifts.js                  # all accounts with sent_gifts rows
//   node sync_sent_gifts.js DeanaIsabel      # just that account (by name)
//   node sync_sent_gifts.js --names=a,b,c    # several accounts
//   node sync_sent_gifts.js -c 5 -t 180000   # concurrency / per-account timeout

const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const { parseSentGifts } = require('./single');
const { fetchCommunityPage } = require('./steam_helpers');
const store = require('./store');

const now = () => Math.floor(Date.now() / 1000);

/**
 * Log into one account, scrape its live sent-gift list, and reconcile the DB.
 * Resolves with { ok, username, kept?, deleted?, reason? } — never rejects.
 */
function syncAccount(account, opts = {}) {
    const { timeout = 120000, log = console.log } = opts;
    const tag = `[${account.username}]`;

    return new Promise((resolve) => {
        const client = new SteamUser({ renewRefreshTokens: true });
        // steamcommunity waits 50s per request by default, which is longer than a
        // dead socket is worth: a healthy inventory page answers in seconds. Cap it
        // low enough that fetchCommunityPage's 4 retries + backoff still fit inside
        // the per-account timeout instead of being cut off mid-retry.
        const community = new SteamCommunity({ timeout: 15000 });
        let steamID = null;
        let resolved = false;

        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            try { client.logOff(); } catch (_) {}
            resolve(result);
        };

        const timer = setTimeout(() => {
            log(`${tag} timeout`);
            finish({ ok: false, reason: 'timeout', username: account.username });
        }, timeout);

        client.on('error', (err) => {
            log(`${tag} error:`, err.message);
            if (/InvalidPassword|AccessDenied|Expired/i.test(err.message)) {
                store.clearRefreshToken(account.username).catch(() => {});
                log(`${tag} cleared cached refresh token`);
            }
            finish({ ok: false, reason: err.message, username: account.username });
        });

        client.on('refreshToken', (token) => { store.saveRefreshToken(account.username, token).catch(() => {}); });

        client.on('loggedOn', () => {
            steamID = client.steamID.getSteamID64();
            log(`${tag} logged in: ${steamID}`);
            client.setPersona(SteamUser.EPersonaState.Online);
            client.gamesPlayed([]);
        });

        client.on('webSession', async (sessionID, cookies) => {
            community.setCookies(cookies);
            const url = `https://steamcommunity.com/profiles/${steamID}/inventory/`;
            const { ok, status, data, error, rateLimited } = await fetchCommunityPage(community, url, { log, tag });
            if (!ok) {
                log(`${tag} inventory fetch failed:`, error?.message || `status ${status}`);
                const reason = rateLimited ? 'rate limited (HTTP 429) — try this account later' : 'inventory fetch failed';
                return finish({ ok: false, reason, username: account.username });
            }
            const sent = parseSentGifts(data);
            try {
                const { kept, deleted } = await store.reconcileSentGifts(steamID, sent);
                log(`${tag} ${kept} sent gift(s) on Steam, ${deleted.length} pruned${deleted.length ? `: ${deleted.join(', ')}` : ''}`);
                finish({ ok: true, username: account.username, kept, deleted });
            } catch (e) {
                // A failed D1/store write must resolve this account (not become an
                // unhandled rejection or hang until timeout).
                log(`${tag} reconcile failed: ${e.message || e}`);
                finish({ ok: false, reason: `reconcile failed: ${e.message || e}`, username: account.username });
            }
        });

        store.getRefreshToken(account.username).then((cachedToken) => {
        if (cachedToken) {
            log(`${tag} using cached refresh token`);
            client.logOn({ refreshToken: cachedToken });
        } else {
            log(`${tag} no cached token — skipping`);
            finish({ ok: false, reason: 'no cached token', username: account.username });
        }
        }).catch((e) => finish({ ok: false, reason: e.message, username: account.username }));
    });
}

async function runWithConcurrency(items, n, worker) {
    let cursor = 0;
    const results = [];
    const workers = Array.from({ length: Math.max(1, n) }, async () => {
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
    let concurrency = 3;
    let timeout = 120000;
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

    // Resolve account_name for the accounts we'll scan. By default: every account
    // that has at least one sent_gifts row, mapped to its login name via the
    // accounts table (and required to have a cached token).
    const tokenNames = db.prepare('SELECT account_name FROM auth_tokens').all().map((r) => r.account_name);
    const byLower = new Map(tokenNames.map((n) => [n.toLowerCase(), n]));

    let accounts;
    if (names.length) {
        accounts = names.map((n) => ({ username: byLower.get(n.toLowerCase()) || n }));
        const missing = names.filter((n) => !byLower.has(n.toLowerCase()));
        if (missing.length) {
            console.log(`Warning: no cached token for: ${missing.join(', ')} (will be skipped)`);
        }
    } else {
        const rows = db.prepare(`
            SELECT DISTINCT a.account_name AS username
            FROM sent_gifts s
            JOIN accounts a ON a.steam_id = s.account_steam_id
            WHERE a.account_name IS NOT NULL
            ORDER BY a.account_name
        `).all();
        accounts = rows.filter((r) => byLower.has(r.username.toLowerCase()))
            .map((r) => ({ username: byLower.get(r.username.toLowerCase()) }));
        const skipped = rows.length - accounts.length;
        console.log(`${accounts.length} account(s) with sent gifts and a cached token${skipped ? ` (${skipped} skipped: no token)` : ''}.`);
    }

    if (accounts.length === 0) {
        console.log('Nothing to sync.');
        process.exit(0);
    }

    console.log(`Syncing ${accounts.length} account(s). Concurrency: ${concurrency}.`);
    runWithConcurrency(accounts, concurrency, (acc) => syncAccount(acc, { timeout }))
        .then(async (results) => {
            const ok = results.filter((r) => r?.ok);
            const failed = results.filter((r) => !r?.ok);
            const totalDeleted = ok.reduce((sum, r) => sum + (r.deleted?.length || 0), 0);
            console.log(`\n=== Done: ${ok.length}/${results.length} ok, ${totalDeleted} sent gift(s) pruned ===`);
            failed.forEach((r) => console.log(`  FAIL ${r.username}: ${r.reason}`));
            await require('./d1_mirror').flushNow();
            process.exit(0);
        });
}

module.exports = { syncAccount, reconcileSentGifts: store.reconcileSentGifts };
