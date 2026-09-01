// Local web dashboard for the Steam account project.
//
//   node server.js [--port=3011]
//   -> http://127.0.0.1:3011
//
// Reads steam_accounts.db through db.js (so the schema migrations run) and serves
// a single-page UI from web/. Bound to 127.0.0.1 only and deliberately has no
// auth — it is a local admin tool, do not expose it to a network.
//
// It performs DB-only actions: toggling accounts.skip_wallet, recording/closing
// loans, unlinking accounts.loan_id, editing loan notes. It never logs into
// Steam — the login-based work stays in the CLI scripts (lend_account.js does the
// snapshot + password verification a real loan needs; this only moves DB rows).
//
// Credentials are never exposed: auth_tokens is reported as a has_token boolean.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const SteamUser = require('steam-user');
const { db, setAccountLoan, addAccountStub, updateCredentials, saveRefreshToken, clearRefreshToken } = require('./db');
const store = require('./store');
const { scanAccount } = require('./single');
const { parseSteamAccounts } = require('./multi_scan');
const { syncAccount } = require('./sync_sent_gifts');
const { updateWalletLevel } = require('./update_wallet_level');
const { reloadFriends } = require('./reload_friends');
const { fetchPlaytime } = require('./steam_playtime');
const { removeFriends } = require('./remove_friends');
const { refreshMailTokens } = require('./refresh_email_token');
const gift = require('./gift_api');
const { removeAccount } = require('./remove_account');

// Backstop: a single misbehaving Steam login — steam-user throwing while it
// processes a huge persona list, or a D1 write rejecting inside an async event
// handler — must never take down the long-running dashboard process. Log and
// keep serving; pm2 stays a last resort for truly fatal states.
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', (reason && reason.stack) || reason);
});
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', (err && err.stack) || err);
});

// In-memory job registry for background scan runs. Jobs live only as long as the
// server process — they are progress trackers for a long Steam-login sweep, not
// durable records (the scan results themselves are persisted to the DB by
// scanAccount). Only one scan runs at a time; more are queued, so we never open
// a burst of Steam logins that trips rate limiting.
const jobs = new Map();
const MAX_LINES = 4000;
// One Steam-login job runs at a time (scan or sync); the rest queue, so we never
// open two bursts of logins into Steam's rate limiter at once.
let steamBusy = false;
const steamQueue = [];

// Interactive password logins to (re)cache a refresh token. Each holds a live
// SteamUser between HTTP calls so a Steam Guard code can be supplied mid-login.
// Passwords are used to log in and then dropped — never stored or logged.
const loginSessions = new Map();
const LOGIN_TTL_MS = 5 * 60 * 1000;

function sweepLoginSessions() {
    const cutoff = Date.now() - LOGIN_TTL_MS;
    for (const [sid, sess] of loginSessions) {
        const terminal = sess.status === 'done' || sess.status === 'error';
        if (sess.created_at < cutoff || (terminal && sess.finished_at && sess.finished_at < Date.now() - 60000)) {
            try { sess.client.logOff(); } catch (_) {}
            loginSessions.delete(sid);
        }
    }
}

function startLogin(steamID, accountName, password) {
    sweepLoginSessions();
    const sid = crypto.randomBytes(8).toString('hex');
    const client = new SteamUser({ renewRefreshTokens: true });
    const sess = {
        sid, client, account_name: accountName, steam_id: steamID,
        status: 'pending', reason: null, guard_type: null, guard_cb: null,
        created_at: Date.now(), finished_at: null
    };
    loginSessions.set(sid, sess);

    const finish = (status, reason) => {
        if (sess.status === 'done' || sess.status === 'error') return;
        sess.status = status;
        sess.reason = reason || null;
        sess.finished_at = Date.now();
        sess.guard_cb = null;
        try { client.logOff(); } catch (_) {}
    };

    const timer = setTimeout(() => finish('error', 'timed out'), LOGIN_TTL_MS);
    sess._timer = timer;

    client.on('steamGuard', (domain, callback) => {
        sess.guard_type = domain ? `email (${domain})` : 'mobile authenticator';
        sess.guard_cb = callback;
        sess.status = 'need_guard';
    });
    // A successful credential login yields a refresh token — the whole point here.
    client.on('refreshToken', (token) => {
        store.saveRefreshToken(accountName, token).catch(() => {});
        clearTimeout(timer);
        finish('done');
    });
    client.on('loggedOn', () => {
        if (sess.status === 'pending' || sess.status === 'need_guard') sess.status = 'logging_in';
    });
    client.on('error', (err) => {
        clearTimeout(timer);
        finish('error', err.message);
    });

    client.logOn({ accountName, password });
    return sess;
}

function makeJob(type, meta) {
    const id = crypto.randomBytes(6).toString('hex');
    const job = {
        id, type, ...meta,
        status: 'queued', created_at: now(), started_at: null, finished_at: null,
        total: meta.total || 0, done: 0, ok: 0, failed: 0, guard_skipped: 0, pruned: 0,
        lines: [], results: []
    };
    jobs.set(id, job);
    return job;
}

function jobLog(job, line) {
    job.lines.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
}

// Public view of a job — omit the per-account result objects' bulk, keep counts.
function jobView(job, withLines) {
    const v = {
        id: job.id, type: job.type, status: job.status,
        created_at: job.created_at, started_at: job.started_at, finished_at: job.finished_at,
        total: job.total, done: job.done, ok: job.ok, failed: job.failed, guard_skipped: job.guard_skipped, pruned: job.pruned,
        usernames: job.usernames || [],
        skipped_existing: job.skipped_existing || [],
        skipped_failed: job.skipped_failed || [],
        results: job.results
    };
    if (withLines) v.lines = job.lines;
    return v;
}

async function runScanJob(job, accounts, timeout, opts = {}) {
    const { idOnly = false } = opts;
    job.status = 'running';
    job.started_at = now();
    jobLog(job, `${idOnly ? 'Logging in for SteamID only' : 'Scanning'} ${accounts.length} account(s), ${timeout}ms timeout each, sequential.`);
    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        jobLog(job, `>> [${i + 1}/${accounts.length}] ${acc.username}`);
        let res;
        try {
            res = await scanAccount(acc, { timeout, idOnly, log: (...a) => jobLog(job, a.join(' ')) });
        } catch (err) {
            res = { ok: false, account: acc, reason: err.message };
        }
        job.done++;
        if (res?.ok) {
            job.ok++;
            jobLog(job, `   OK ${acc.username}`);
        } else if (res?.skipped) {
            // Steam Guard (or any other explicit skip) — reported apart from failures.
            job.guard_skipped++;
            jobLog(job, `   SKIP ${acc.username}: ${res.reason}`);
        } else {
            job.failed++;
            jobLog(job, `   FAIL ${acc.username}: ${res?.reason || 'unknown'}`);
        }
        job.results.push({ username: acc.username, ok: !!res?.ok, skipped: !!res?.skipped, reason: res?.reason || null, partial: res?.partial || null });
    }
    job.status = 'done';
    job.finished_at = now();
    jobLog(job, `Done: ${job.ok}/${job.total} ok, ${job.failed} failed${job.guard_skipped ? `, ${job.guard_skipped} Steam-Guard-skipped` : ''}.`);
}

// Sync one batch of accounts' sent-gift lists against Steam, reusing syncAccount
// from sync_sent_gifts.js so the reconcile logic stays in one place.
async function runSyncJob(job, accounts, timeout, concurrency) {
    job.status = 'running';
    job.started_at = now();
    jobLog(job, `Syncing sent gifts for ${accounts.length} account(s), concurrency ${concurrency}.`);
    let cursor = 0;
    const worker = async () => {
        while (cursor < accounts.length) {
            const i = cursor++;
            const acc = accounts[i];
            jobLog(job, `>> [${i + 1}/${accounts.length}] ${acc.username}`);
            let res;
            try {
                res = await syncAccount(acc, { timeout, log: (...a) => jobLog(job, a.join(' ')) });
            } catch (err) {
                res = { ok: false, username: acc.username, reason: err.message };
            }
            job.done++;
            if (res?.ok) {
                job.ok++;
                job.pruned += res.deleted?.length || 0;
                jobLog(job, `   OK ${acc.username}: ${res.kept} on Steam, ${res.deleted?.length || 0} pruned`);
            } else {
                job.failed++;
                jobLog(job, `   FAIL ${acc.username}: ${res?.reason || 'unknown'}`);
            }
            job.results.push({ username: acc.username, ok: !!res?.ok, kept: res?.kept ?? null, deleted: res?.deleted || [], reason: res?.reason || null });
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    job.status = 'done';
    job.finished_at = now();
    jobLog(job, `Done: ${job.ok}/${job.total} ok, ${job.pruned} sent gift(s) pruned, ${job.failed} failed.`);
}

// Run ONE action against ONE account, reusing the same worker the CLI uses:
//   scan   -> scanAccount        (multi_scan.js)
//   wallet -> updateWalletLevel  (update_wallet_level.js, mode 'all')
//   sync   -> syncAccount        (sync_sent_gifts.js)
async function runSingleAccountJob(job, account, action, opts) {
    job.status = 'running';
    job.started_at = now();
    const log = (...a) => jobLog(job, a.join(' '));
    jobLog(job, `Running '${action}' on ${account.username}`);
    let res;
    try {
        if (action === 'scan') res = await scanAccount(account, { timeout: opts.timeout, log });
        else if (action === 'wallet') res = await updateWalletLevel(account, { timeout: opts.timeout, log, mode: opts.mode || 'all' });
        else if (action === 'sync') res = await syncAccount(account, { timeout: opts.timeout, log });
        else if (action === 'friends') res = await reloadFriends(account.steam_id, { log });
        else if (action === 'playtime') res = await fetchPlaytime(account, { timeout: opts.timeout, log });
        else res = { ok: false, reason: `unknown action '${action}'` };
    } catch (err) {
        res = { ok: false, reason: err.message };
    }
    job.done = 1;
    if (res?.ok) {
        job.ok = 1;
        if (res.deleted) job.pruned += res.deleted.length;
        jobLog(job, `   OK ${account.username}${res.deleted ? ` (${res.deleted.length} pruned)` : ''}`);
    } else if (res?.skipped) {
        job.guard_skipped = 1;
        jobLog(job, `   SKIP ${account.username}: ${res.reason}`);
    } else {
        job.failed = 1;
        jobLog(job, `   FAIL ${account.username}: ${res?.reason || 'unknown'}`);
    }
    job.results.push({ username: account.username, ok: !!res?.ok, skipped: !!res?.skipped, reason: res?.reason || null, kept: res?.kept ?? null, deleted: res?.deleted || [] });
    job.status = 'done';
    job.finished_at = now();
    jobLog(job, 'Done.');
}

// Refresh wallet/level across many accounts, reusing updateWalletLevel. Runs a
// few logins in parallel (like the CLI), but the whole batch is one queued job.
async function runWalletJob(job, accounts, { mode, timeout, concurrency }) {
    job.status = 'running';
    job.started_at = now();
    jobLog(job, `Refreshing wallet/level for ${accounts.length} account(s), mode ${mode}, concurrency ${concurrency}.`);
    let cursor = 0;
    const worker = async () => {
        while (cursor < accounts.length) {
            const i = cursor++;
            const acc = accounts[i];
            jobLog(job, `>> [${i + 1}/${accounts.length}] ${acc.username}`);
            let res;
            try {
                res = await updateWalletLevel(acc, { timeout, mode, log: (...a) => jobLog(job, a.join(' ')) });
            } catch (err) {
                res = { ok: false, username: acc.username, reason: err.message };
            }
            job.done++;
            if (res?.ok) { job.ok++; jobLog(job, `   OK ${acc.username}`); }
            else { job.failed++; jobLog(job, `   FAIL ${acc.username}: ${res?.reason || 'unknown'}`); }
            job.results.push({ username: acc.username, ok: !!res?.ok, reason: res?.reason || null });
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    job.status = 'done';
    job.finished_at = now();
    jobLog(job, `Done: ${job.ok}/${job.total} ok, ${job.failed} failed.`);
}

// Run a "remove friends" job (by name list or by friend_since date range).
async function runRemoveFriendsJob(job, account, opts) {
    job.status = 'running';
    job.started_at = now();
    const log = (...a) => jobLog(job, a.join(' '));
    jobLog(job, `Remove friends on ${account.username} — mode=${opts.mode}, dryRun=${opts.dryRun}`);
    let res;
    try { res = await removeFriends(account, { ...opts, log }); }
    catch (err) { res = { ok: false, reason: err.message }; }
    job.done = 1;
    if (res?.ok) {
        job.ok = 1;
        jobLog(job, res.dryRun ? `   OK (dry-run): ${res.matched} matched` : `   OK: removed ${res.removed.length}`);
    } else {
        job.failed = 1;
        jobLog(job, `   FAIL: ${res?.reason || 'unknown'}`);
    }
    job.results.push({ username: account.username, ok: !!res?.ok, dryRun: !!res?.dryRun, matched: res?.matched ?? 0, removed: res?.removed || [], notFound: res?.notFound || [], reason: res?.reason || null });
    job.status = 'done';
    job.finished_at = now();
    jobLog(job, 'Done.');
}

// Queue any Steam-login job (scan or sync) so only one runs at a time.
function enqueueSteamJob(job, run) {
    const start = async () => {
        steamBusy = true;
        try { await run(); }
        catch (err) {
            job.status = 'error';
            job.finished_at = now();
            jobLog(job, `Job crashed: ${err.message}`);
        } finally {
            steamBusy = false;
            if (steamQueue.length) steamQueue.shift()();
        }
    };
    if (steamBusy) {
        jobLog(job, 'Queued behind a running Steam job.');
        steamQueue.push(start);
    } else {
        start();
    }
}

const args = process.argv.slice(2);
const portFlag = args.find((a) => a.startsWith('--port='));
const PORT = Number(portFlag ? portFlag.slice('--port='.length) : process.env.PORT || 3011);
const hostFlag = args.find((a) => a.startsWith('--host='));
const HOST = hostFlag ? hostFlag.slice('--host='.length) : (process.env.HOST || '127.0.0.1');
// Shared-secret gate. Prefer the env var (a --token= flag is visible in `ps`).
// Empty = auth disabled (only allowed on loopback; see the startup guard).
const tokenFlag = args.find((a) => a.startsWith('--token='));
const AUTH_TOKEN = process.env.DASHBOARD_TOKEN || (tokenFlag ? tokenFlag.slice('--token='.length) : '') || '';
const INSECURE = args.includes('--insecure');
const isLoopback = (h) => h === '127.0.0.1' || h === '::1' || h === 'localhost';
const WEB_DIR = path.join(__dirname, 'web');
const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

const ACCOUNT_COLS = `
    a.steam_id, a.account_name, a.persona, a.country, a.email,
    a.wallet_currency, a.wallet_balance_cents, a.steam_level, a.steam_points,
    a.loan_id, a.skip_wallet, a.source, a.email_token_refreshed_at, a.scanned_at,
    (SELECT COUNT(*) FROM auth_tokens t WHERE lower(t.account_name) = lower(a.account_name)) AS has_token,
    (SELECT COUNT(*) FROM friends f WHERE f.account_steam_id = a.steam_id) AS friend_count,
    (SELECT COUNT(*) FROM sent_gifts s WHERE s.account_steam_id = a.steam_id) AS sent_gift_count,
    (SELECT COUNT(*) FROM pending_gifts p WHERE p.account_steam_id = a.steam_id) AS pending_gift_count,
    (SELECT COUNT(*) FROM licenses l WHERE l.account_steam_id = a.steam_id) AS license_count,
    (SELECT COUNT(*) FROM game_playtime gp WHERE gp.account_steam_id = a.steam_id) AS game_count,
    (SELECT COALESCE(SUM(playtime_forever),0) FROM game_playtime gp WHERE gp.account_steam_id = a.steam_id) AS playtime_minutes
`;

// Whitelist of sortable columns — the value goes into SQL, so it can never come
// straight from the query string.
const SORTABLE = {
    account_name: 'a.account_name COLLATE NOCASE',
    persona: 'a.persona COLLATE NOCASE',
    country: 'a.country',
    wallet: 'a.wallet_balance_cents',
    level: 'a.steam_level',
    points: 'a.steam_points',
    friends: 'friend_count',
    sent: 'sent_gift_count',
    pending: 'pending_gift_count',
    licenses: 'license_count',
    scanned: 'a.scanned_at'
};

function listAccounts({ q, sort, dir, filter, currency, walletMin, walletMax, page, per }) {
    const where = [];
    const params = {};
    if (q) {
        where.push('(a.account_name LIKE @q OR a.persona LIKE @q OR a.email LIKE @q OR a.steam_id LIKE @q)');
        params.q = `%${q}%`;
    }
    if (filter === 'loaned') where.push('a.loan_id IS NOT NULL');
    if (filter === 'skip_wallet') where.push('a.skip_wallet = 1');
    if (filter === 'tracked') where.push('a.skip_wallet = 0');
    if (filter === 'no_token') where.push("(a.account_name IS NULL OR lower(a.account_name) NOT IN (SELECT lower(account_name) FROM auth_tokens))");
    if (filter === 'funded') where.push('a.wallet_balance_cents > 0');

    // Wallet filters. Amounts arrive in major currency units and are compared in
    // cents. currency is an exact ECurrencyCode match; only meaningful together
    // with an amount range since balances span many currencies.
    if (currency) { where.push('a.wallet_currency = @currency'); params.currency = currency; }
    if (walletMin != null) { where.push('a.wallet_balance_cents >= @walletMin'); params.walletMin = Math.round(walletMin * 100); }
    if (walletMax != null) { where.push('a.wallet_balance_cents <= @walletMax'); params.walletMax = Math.round(walletMax * 100); }

    const orderCol = SORTABLE[sort] || SORTABLE.account_name;
    const orderDir = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // Backward compatible: without a `page`, return the full array (wallet_skip.js
    // and other callers rely on that). With `page`, return one page + the total.
    if (page == null) {
        return db.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts a ${whereSql} ORDER BY ${orderCol} ${orderDir}`).all(params);
    }
    const perN = Math.min(Math.max(1, per || 50), 500);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM accounts a ${whereSql}`).get(params).c;
    const pages = Math.max(1, Math.ceil(total / perN));
    const pageN = Math.min(Math.max(1, page), pages);
    const rows = db.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts a ${whereSql} ORDER BY ${orderCol} ${orderDir} LIMIT @_per OFFSET @_off`)
        .all({ ...params, _per: perN, _off: (pageN - 1) * perN });
    return { rows, total, page: pageN, per: perN, pages };
}

function accountDetail(steamID) {
    // Detail carries the managed credentials + raw refresh token; the list
    // (ACCOUNT_COLS) does not, so secrets ship only for a single account.
    const account = db.prepare(
        `SELECT ${ACCOUNT_COLS}, a.email_password, a.steam_password, a.email_refresh_token, a.email_client_id,
                (SELECT refresh_token FROM auth_tokens t WHERE lower(t.account_name) = lower(a.account_name)) AS refresh_token
         FROM accounts a WHERE a.steam_id = ?`).get(steamID);
    if (!account) return null;
    return {
        account,
        friends: db.prepare(`
            SELECT friend_steam_id, friend_name, friend_level, added_at, relationship, gifted_at, gifted_game, country
            FROM friends WHERE account_steam_id = ? ORDER BY added_at DESC
        `).all(steamID),
        sent_gifts: db.prepare('SELECT * FROM sent_gifts WHERE account_steam_id = ? ORDER BY sent_at IS NULL, sent_at ASC').all(steamID),
        pending_gifts: db.prepare('SELECT * FROM pending_gifts WHERE account_steam_id = ? ORDER BY scanned_at DESC').all(steamID),
        licenses: db.prepare(`
            SELECT l.package_id, l.package_name, l.payment_method, l.license_type, l.purchased_at,
                   (SELECT group_concat(DISTINCT la.app_name) FROM license_apps la
                    WHERE la.account_steam_id = l.account_steam_id AND la.package_id = l.package_id) AS app_names
            FROM licenses l WHERE l.account_steam_id = ? ORDER BY l.purchased_at DESC
        `).all(steamID),
        loans: db.prepare('SELECT * FROM account_loans WHERE lower(account_name) = lower(?) ORDER BY lent_at DESC')
            .all(account.account_name || '')
    };
}

function summary() {
    const one = (sql) => db.prepare(sql).get();
    const wallets = db.prepare(`
        SELECT wallet_currency AS currency, COUNT(*) AS accounts, SUM(wallet_balance_cents) AS cents
        FROM accounts WHERE wallet_balance_cents > 0 GROUP BY wallet_currency ORDER BY cents DESC
    `).all();
    return {
        accounts: one('SELECT COUNT(*) c FROM accounts').c,
        with_token: one('SELECT COUNT(*) c FROM auth_tokens').c,
        skip_wallet: one('SELECT COUNT(*) c FROM accounts WHERE skip_wallet = 1').c,
        loaned: one('SELECT COUNT(*) c FROM accounts WHERE loan_id IS NOT NULL').c,
        open_loans: one('SELECT COUNT(*) c FROM account_loans WHERE returned_at IS NULL').c,
        overdue_loans: one(`SELECT COUNT(*) c FROM account_loans WHERE returned_at IS NULL AND due_at < ${now()}`).c,
        friends: one('SELECT COUNT(*) c FROM friends').c,
        sent_gifts: one('SELECT COUNT(*) c FROM sent_gifts').c,
        pending_gifts: one('SELECT COUNT(*) c FROM pending_gifts').c,
        wallets
    };
}

// ---------------------------------------------------------------------------
// http plumbing
// ---------------------------------------------------------------------------

function parseCookies(req) {
    const out = {};
    (req.headers.cookie || '').split(';').forEach((p) => {
        const i = p.indexOf('=');
        if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
}

// Constant-time token comparison (length-guarded so timingSafeEqual won't throw).
function tokenMatches(given) {
    if (!given || given.length !== AUTH_TOKEN.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(AUTH_TOKEN));
    } catch (_) {
        return false;
    }
}

// Gate every request behind the shared secret. Returns true to proceed; when it
// returns false it has already answered (401 or a redirect). No-op when no token
// is configured. The token is accepted from ?token= (once — it's then stored in
// an HttpOnly cookie and stripped from the URL), a dash_token cookie, an
// X-Dashboard-Token header, or Authorization: Bearer.
function checkAuth(req, res, url) {
    if (!AUTH_TOKEN) return true;

    const q = url.searchParams.get('token');
    if (q && tokenMatches(q)) {
        res.setHeader('Set-Cookie', `dash_token=${encodeURIComponent(AUTH_TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
        if (url.pathname.startsWith('/api/')) return true;
        url.searchParams.delete('token');
        res.writeHead(302, { Location: url.pathname + (url.search ? url.search : '') });
        res.end();
        return false;
    }

    const cookie = parseCookies(req).dash_token;
    const header = req.headers['x-dashboard-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (tokenMatches(cookie) || tokenMatches(header)) return true;

    if (url.pathname.startsWith('/api/')) {
        sendJSON(res, 401, { error: 'unauthorized' });
    } else {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset=utf-8><body style="font:15px system-ui;max-width:34rem;margin:12vh auto;padding:0 1rem;color:#333"><h2>Authorization required</h2><p>Open this dashboard with <code>?token=YOUR_TOKEN</code> appended once. It is then remembered in a cookie for this browser.</p></body>');
    }
    return false;
}

function sendJSON(res, code, body) {
    const payload = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
}

// 10 MB cap: bulk uploads (account lists, and email-token batches whose OAuth
// refresh tokens are ~1 KB each) are large but bounded. Abort cleanly when over.
const MAX_BODY_BYTES = 10e6;
function readBody(req, maxBytes = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        let raw = '';
        let aborted = false;
        req.on('data', (c) => {
            if (aborted) return;
            raw += c;
            if (raw.length > maxBytes) { aborted = true; req.destroy(); reject(new Error(`body too large (max ${Math.round(maxBytes / 1e6)} MB)`)); }
        });
        req.on('end', () => {
            if (aborted) return;
            if (!raw) return resolve({});
            try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
        });
        req.on('error', (err) => { if (!aborted) reject(err); });
    });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serveStatic(res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const full = path.join(WEB_DIR, rel);
    // Keep path traversal out of the static handler.
    if (!full.startsWith(WEB_DIR)) {
        res.writeHead(403).end('forbidden');
        return;
    }
    fs.readFile(full, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
    });
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

async function handleAPI(req, res, url) {
    const p = url.pathname;
    const method = req.method;

    if (method === 'GET' && p === '/api/summary') return sendJSON(res, 200, summary());

    if (method === 'GET' && p === '/api/accounts') {
        const num = (k) => url.searchParams.get(k) !== null && url.searchParams.get(k) !== '' ? Number(url.searchParams.get(k)) : null;
        return sendJSON(res, 200, listAccounts({
            q: url.searchParams.get('q') || '',
            sort: url.searchParams.get('sort') || 'account_name',
            dir: url.searchParams.get('dir') || 'asc',
            filter: url.searchParams.get('filter') || '',
            currency: url.searchParams.get('currency') || '',
            walletMin: num('wallet_min'), walletMax: num('wallet_max'),
            page: num('page'), per: num('per')
        }));
    }

    let m = /^\/api\/accounts\/(\d{17})$/.exec(p);
    if (method === 'GET' && m) {
        const detail = accountDetail(m[1]);
        return detail ? sendJSON(res, 200, detail) : sendJSON(res, 404, { error: 'account not found' });
    }

    // Bulk-refresh wallet/level for all tokened accounts, minus skip_wallet + loaned.
    if (method === 'POST' && p === '/api/wallets/refresh') {
        const b = await readBody(req);
        const mode = ['all', 'wallet', 'gifts'].includes(b.mode) ? b.mode : 'all';
        const includeSkipped = !!b.includeSkipped;
        const includeLent = !!b.includeLent;
        const concurrency = Number(b.concurrency) >= 1 ? Math.min(Number(b.concurrency), 8) : 5;

        // Same selection as the update_wallet_level.js CLI default.
        const sel = await store.walletRefreshSelection();
        let accounts = sel.tokened;
        let droppedSkip = [];
        if (!includeSkipped && (mode === 'all' || mode === 'wallet')) {
            const skip = new Set(sel.skip.map((r) => r.account_name.toLowerCase()));
            droppedSkip = accounts.filter((a) => skip.has(a.username.toLowerCase())).map((a) => a.username);
            accounts = accounts.filter((a) => !skip.has(a.username.toLowerCase()));
        }
        let droppedLent = [];
        if (!includeLent) {
            const lent = new Set(sel.lent.map((r) => r.account_name.toLowerCase()));
            droppedLent = accounts.filter((a) => lent.has(a.username.toLowerCase())).map((a) => a.username);
            accounts = accounts.filter((a) => !lent.has(a.username.toLowerCase()));
        }
        if (accounts.length === 0) {
            return sendJSON(res, 200, { queued: 0, message: 'No accounts to refresh (all tokened accounts are skip_wallet or loaned).', skipped_wallet: droppedSkip, skipped_loaned: droppedLent });
        }
        const job = makeJob('wallet-bulk', { total: accounts.length, usernames: accounts.map((a) => a.username) });
        if (droppedSkip.length) jobLog(job, `Excluded ${droppedSkip.length} skip_wallet account(s).`);
        if (droppedLent.length) jobLog(job, `Excluded ${droppedLent.length} loaned account(s).`);
        enqueueSteamJob(job, () => runWalletJob(job, accounts, { mode, timeout: 60000, concurrency }));
        return sendJSON(res, 202, { ...jobView(job, false), skipped_wallet: droppedSkip.length, skipped_loaned: droppedLent.length });
    }

    // Read an account's stored game playtime.
    m = /^\/api\/accounts\/(\d{17})\/playtime$/.exec(p);
    if (method === 'GET' && m) {
        const rows = db.prepare('SELECT app_id, name, playtime_forever, playtime_2weeks, scanned_at FROM game_playtime WHERE account_steam_id = ? ORDER BY playtime_forever DESC').all(m[1]);
        const total = rows.reduce((s, r) => s + (r.playtime_forever || 0), 0);
        return sendJSON(res, 200, { games: rows, count: rows.length, played: rows.filter((r) => r.playtime_forever > 0).length, total_minutes: total });
    }

    // Start a password login to (re)cache a refresh token for one account.
    m = /^\/api\/accounts\/(\d{17})\/login$/.exec(p);
    if (method === 'POST' && m) {
        const b = await readBody(req);
        if (!b.password) return sendJSON(res, 400, { error: 'password required' });
        const acc = { account_name: await store.accountNameBySteamID(m[1]) };
        if (!acc || !acc.account_name) return sendJSON(res, 400, { error: 'account not found, or has no login name' });
        const sess = startLogin(m[1], acc.account_name, String(b.password));
        return sendJSON(res, 202, { session_id: sess.sid, status: sess.status, account_name: acc.account_name });
    }

    // Poll a login session's status.
    m = /^\/api\/accounts\/login\/([0-9a-f]{16})$/.exec(p);
    if (method === 'GET' && m) {
        const sess = loginSessions.get(m[1]);
        if (!sess) return sendJSON(res, 404, { error: 'no such login session (it may have expired)' });
        return sendJSON(res, 200, { status: sess.status, guard_type: sess.guard_type, reason: sess.reason, account_name: sess.account_name });
    }

    // Supply a Steam Guard code to a waiting login session.
    m = /^\/api\/accounts\/login\/([0-9a-f]{16})\/guard$/.exec(p);
    if (method === 'POST' && m) {
        const sess = loginSessions.get(m[1]);
        if (!sess) return sendJSON(res, 404, { error: 'no such login session' });
        const b = await readBody(req);
        if (sess.status !== 'need_guard' || !sess.guard_cb) return sendJSON(res, 409, { error: `not awaiting a code (status: ${sess.status})` });
        if (!b.code) return sendJSON(res, 400, { error: 'code required' });
        const cb = sess.guard_cb;
        sess.guard_cb = null;
        sess.status = 'logging_in';
        cb(String(b.code).trim());
        return sendJSON(res, 200, { status: sess.status });
    }

    m = /^\/api\/accounts\/(\d{17})\/remove-friends$/.exec(p);
    if (method === 'POST' && m) {
        const b = await readBody(req);
        const acc = { account_name: await store.accountNameBySteamID(m[1]) };
        if (!acc || !acc.account_name) return sendJSON(res, 400, { error: 'account not found, or has no login name' });
        const mode = b.mode === 'date' ? 'date' : 'name';
        const names = Array.isArray(b.names) ? b.names : (b.names ? String(b.names).split(/[\n,]+/).map((x) => x.trim()).filter(Boolean) : []);
        const excludeNames = Array.isArray(b.excludeNames) ? b.excludeNames : [];
        const opts = {
            mode, names, excludeNames,
            dateFrom: Number(b.dateFrom), dateTo: Number(b.dateTo),
            dryRun: b.dryRun !== false, // dry-run is the default; must send dryRun:false to actually remove
            timeout: 120000,
        };
        const job = makeJob('remove-friends', { total: 1, usernames: [acc.account_name] });
        enqueueSteamJob(job, () => runRemoveFriendsJob(job, { username: acc.account_name, steam_id: m[1] }, opts));
        return sendJSON(res, 202, jobView(job, false));
    }

    m = /^\/api\/accounts\/(\d{17})\/run$/.exec(p);
    if (method === 'POST' && m) {
        const { action, mode, timeout } = await readBody(req);
        if (!['scan', 'wallet', 'sync', 'friends', 'playtime'].includes(action)) {
            return sendJSON(res, 400, { error: "action must be one of: scan, wallet, sync, friends, playtime" });
        }
        const acc = { account_name: await store.accountNameBySteamID(m[1]) };
        if (!acc || !acc.account_name) {
            return sendJSON(res, 400, { error: 'account not found, or has no login name to run against' });
        }
        const to = Number(timeout) >= 10000 ? Number(timeout) : (action === 'sync' ? 120000 : 60000);
        const job = makeJob(action, { total: 1, usernames: [acc.account_name] });
        enqueueSteamJob(job, () => runSingleAccountJob(job, { username: acc.account_name, steam_id: m[1] }, action, { timeout: to, mode }));
        return sendJSON(res, 202, jobView(job, false));
    }

    m = /^\/api\/accounts\/(\d{17})\/skip-wallet$/.exec(p);
    if (method === 'POST' && m) {
        const { value } = await readBody(req);
        const changes = db.prepare('UPDATE accounts SET skip_wallet = ?, updated_at = unixepoch() WHERE steam_id = ?')
            .run(value ? 1 : 0, m[1]).changes;
        return changes
            ? sendJSON(res, 200, { steam_id: m[1], skip_wallet: value ? 1 : 0 })
            : sendJSON(res, 404, { error: 'account not found' });
    }

    // Manage credentials: email / email_password / steam_password + refresh token.
    m = /^\/api\/accounts\/(\d{17})\/credentials$/.exec(p);
    if (method === 'POST' && m) {
        const b = await readBody(req);
        const acc = db.prepare('SELECT account_name FROM accounts WHERE steam_id = ?').get(m[1]);
        if (!acc) return sendJSON(res, 404, { error: 'account not found' });
        updateCredentials(m[1], b);
        if ('refresh_token' in b && acc.account_name) {
            if (b.refresh_token) saveRefreshToken(acc.account_name, b.refresh_token);
            else clearRefreshToken(acc.account_name);
        }
        return sendJSON(res, 200, { steam_id: m[1], updated: true });
    }

    m = /^\/api\/accounts\/(\d{17})\/unlink-loan$/.exec(p);
    if (method === 'POST' && m) {
        const changes = setAccountLoan(m[1], null);
        return changes
            ? sendJSON(res, 200, { steam_id: m[1], loan_id: null })
            : sendJSON(res, 404, { error: 'account not found' });
    }

    m = /^\/api\/accounts\/(\d{17})$/.exec(p);
    if (method === 'DELETE' && m) {
        // Reuse remove_account.js: transactional cascade over the account's owned
        // rows (friends, licenses, license_apps, pending/sent gifts) + its
        // auth_tokens. Cross-references in OTHER accounts' data are kept unless
        // ?purge_refs=1, matching the CLI default.
        const purgeRefs = url.searchParams.get('purge_refs') === '1';
        // removeAccount reports found:true for any well-formed SteamID64 even when
        // no row exists (it deletes 0). Treat "nothing owned and no token" as 404.
        const result = removeAccount(m[1], { purgeRefs });
        const actuallyDeleted = (result.owned?.accounts || 0) + (result.tokenCount || 0)
            + Object.entries(result.owned || {}).filter(([k]) => k !== 'accounts').reduce((n, [, c]) => n + c, 0);
        if (!result.found || actuallyDeleted === 0) return sendJSON(res, 404, { error: 'account not found' });
        return sendJSON(res, 200, {
            steam_id: result.resolved.steam_id,
            account_name: result.resolved.account_name,
            deleted: result.owned,
            auth_tokens: result.tokenCount,
            refs: result.refs,
            purged_refs: purgeRefs
        });
    }

    if (method === 'GET' && p === '/api/gifts/sent') {
        return sendJSON(res, 200, db.prepare(`
            SELECT s.*, a.account_name FROM sent_gifts s
            LEFT JOIN accounts a ON a.steam_id = s.account_steam_id
            ORDER BY s.sent_at IS NULL, s.sent_at ASC
        `).all());
    }

    // Admin: delete sent-gift rows by gift_id (DB-only; still-pending gifts return
    // on the next sync).
    if (method === 'POST' && p === '/api/gifts/sent/delete') {
        const b = await readBody(req);
        const ids = Array.isArray(b.gift_ids) ? b.gift_ids.map(String).filter(Boolean) : [];
        if (!ids.length) return sendJSON(res, 400, { error: 'gift_ids[] required' });
        const del = db.prepare('DELETE FROM sent_gifts WHERE gift_id = ?');
        const deleted = db.transaction(() => ids.reduce((n, id) => n + del.run(id).changes, 0))();
        return sendJSON(res, 200, { deleted });
    }

    if (method === 'POST' && p === '/api/gifts/sync') {
        const { account_name, concurrency, timeout } = await readBody(req);
        // Same account selection as sync_sent_gifts.js: accounts that have
        // sent_gifts rows AND a cached token, or one named account (token required).
        const tokenNames = db.prepare('SELECT account_name FROM auth_tokens').all().map((r) => r.account_name);
        const byLower = new Map(tokenNames.map((n) => [n.toLowerCase(), n]));

        let accounts;
        if (account_name) {
            const canonical = byLower.get(String(account_name).toLowerCase());
            if (!canonical) return sendJSON(res, 400, { error: `no cached token for '${account_name}' — cannot sync it` });
            accounts = [{ username: canonical }];
        } else {
            const rows = db.prepare(`
                SELECT DISTINCT a.account_name AS username
                FROM sent_gifts s JOIN accounts a ON a.steam_id = s.account_steam_id
                WHERE a.account_name IS NOT NULL ORDER BY a.account_name
            `).all();
            accounts = rows.filter((r) => byLower.has(r.username.toLowerCase()))
                .map((r) => ({ username: byLower.get(r.username.toLowerCase()) }));
        }
        if (accounts.length === 0) {
            return sendJSON(res, 200, { queued: 0, message: 'No accounts with sent gifts and a cached token to sync.' });
        }

        const to = Number(timeout) >= 10000 ? Number(timeout) : 120000;
        const conc = Number(concurrency) >= 1 ? Math.min(Number(concurrency), 5) : 3;
        const job = makeJob('sync', { total: accounts.length, usernames: accounts.map((a) => a.username) });
        enqueueSteamJob(job, () => runSyncJob(job, accounts, to, conc));
        return sendJSON(res, 202, jobView(job, false));
    }

    if (method === 'GET' && p === '/api/friends') {
        const q = url.searchParams.get('q') || '';
        return sendJSON(res, 200, db.prepare(`
            SELECT f.*, a.account_name FROM friends f
            LEFT JOIN accounts a ON a.steam_id = f.account_steam_id
            WHERE (@q = '' OR f.friend_name LIKE @like OR f.friend_steam_id LIKE @like OR a.account_name LIKE @like)
            ORDER BY f.added_at DESC LIMIT 2000
        `).all({ q, like: `%${q}%` }));
    }

    // Licenses aggregated by package (one row per package_id, across all accounts).
    if (method === 'GET' && p === '/api/licenses') {
        const q = url.searchParams.get('q') || '';
        return sendJSON(res, 200, db.prepare(`
            SELECT l.package_id, MAX(l.package_name) AS package_name,
                   COUNT(DISTINCT l.account_steam_id) AS account_count,
                   (SELECT group_concat(DISTINCT la.app_name) FROM license_apps la WHERE la.package_id = l.package_id AND la.app_name IS NOT NULL) AS app_names
            FROM licenses l
            WHERE (@q = '' OR l.package_name LIKE @like OR CAST(l.package_id AS TEXT) LIKE @like
                   OR EXISTS (SELECT 1 FROM license_apps la2 WHERE la2.package_id = l.package_id AND la2.app_name LIKE @like))
            GROUP BY l.package_id ORDER BY account_count DESC, package_name LIMIT 2000
        `).all({ q, like: `%${q}%` }));
    }
    // Which accounts own a given package.
    if (method === 'GET' && p === '/api/licenses/owners') {
        const pkg = parseInt(url.searchParams.get('package_id'), 10);
        if (!Number.isFinite(pkg)) return sendJSON(res, 400, { error: 'package_id required' });
        return sendJSON(res, 200, db.prepare(`
            SELECT l.account_steam_id, a.account_name, l.payment_method, l.license_type, l.purchased_at
            FROM licenses l LEFT JOIN accounts a ON a.steam_id = l.account_steam_id
            WHERE l.package_id = ? ORDER BY a.account_name
        `).all(pkg));
    }

    if (method === 'POST' && p === '/api/scan') {
        const { text, timeout, rescan, source, addOnly, idOnly } = await readBody(req);
        if (!text || !String(text).trim()) return sendJSON(res, 400, { error: 'no account lines provided' });

        // Reuse multi_scan's parser via a short-lived temp file, so upload parsing
        // and CLI parsing stay identical. The file holds plaintext credentials, so
        // it is written 0600 and unlinked immediately after parsing.
        const tmp = path.join(os.tmpdir(), `steam-upload-${crypto.randomBytes(6).toString('hex')}.txt`);
        let parsed;
        try {
            fs.writeFileSync(tmp, String(text), { mode: 0o600 });
            parsed = parseSteamAccounts(tmp);
        } catch (err) {
            return sendJSON(res, 400, { error: `parse failed: ${err.message}` });
        } finally {
            try { fs.unlinkSync(tmp); } catch (_) {}
        }

        // A line is "failed/invalid" when it has no usable credentials: missing
        // username or password, or a password that is the creation-failure marker
        // (e.g. "16|email|persona||FAILED|VN"). These are dropped and reported,
        // never attempted as logins.
        const src = typeof source === 'string' && source.trim() ? source.trim().slice(0, 255) : null;
        parsed.forEach((a) => { a.source = src; });
        const isFailed = (a) => !a.username || !a.password || /^failed$/i.test(a.password.trim());
        const skippedFailed = parsed.filter(isFailed).map((a) => `#${a.id}${a.username ? ' ' + a.username : ''}`);
        let accounts = parsed.filter((a) => !isFailed(a));

        if (accounts.length === 0) {
            return sendJSON(res, 400, {
                error: 'no valid username/password pairs found',
                skipped_failed: skippedFailed,
                hint: 'expected user----pass, user:pass, or id|email|x|user|pass (lines marked FAILED or with an empty username/password are skipped)'
            });
        }

        // Skip accounts already scanned (present in the accounts table) unless the
        // caller explicitly asks to rescan. Matching is by login name, case-insensitive.
        const parsedCount = accounts.length;
        let skippedExisting = [];
        if (!rescan) {
            const existing = new Set(
                db.prepare('SELECT lower(account_name) AS n FROM accounts WHERE account_name IS NOT NULL').all().map((r) => r.n)
            );
            skippedExisting = accounts.filter((a) => existing.has(a.username.toLowerCase())).map((a) => a.username);
            accounts = accounts.filter((a) => !existing.has(a.username.toLowerCase()));
        }
        if (accounts.length === 0) {
            return sendJSON(res, 200, {
                skipped_existing: skippedExisting, skipped_failed: skippedFailed, parsed: parsedCount, queued: 0,
                message: `All ${parsedCount} account(s) already exist in the DB. Enable "rescan existing" to force.`
            });
        }

        // "Just add, don't scan": pull the steamID (and email) straight out of each
        // line and upsert a stub row — no Steam login. Lines with no 17-digit
        // SteamID64 can't be added this way (the accounts PK is steam_id) and are
        // reported back. Synchronous: there is no job.
        if (addOnly) {
            const added = [];
            const noSteamID = [];
            const addTx = db.transaction(() => {
                for (const a of accounts) {
                    const idm = /\b(765611\d{11})\b/.exec(a.rawLine || '');
                    if (!idm) { noSteamID.push(a.username); continue; }
                    // Find the email by splitting on the line delimiters, so a dash
                    // run ("----") can't be swallowed into the local part.
                    const email = (a.rawLine || '').split(/----|[|:]/)
                        .map((f) => f.trim())
                        .find((f) => /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(f)) || null;
                    addAccountStub({ steam_id: idm[1], account_name: a.username, email, source: a.source });
                    added.push(a.username);
                }
            });
            addTx();
            return sendJSON(res, 200, {
                mode: 'add-only', added: added.length, added_names: added,
                skipped_no_steamid: noSteamID, skipped_existing: skippedExisting, skipped_failed: skippedFailed
            });
        }

        // "SteamID only" logins are quick (no community fetch), so a shorter default.
        const to = Number(timeout) >= 10000 ? Number(timeout) : (idOnly ? 30000 : 60000);
        const job = makeJob(idOnly ? 'scan-id' : 'scan', {
            total: accounts.length, usernames: accounts.map((a) => a.username),
            skipped_existing: skippedExisting, skipped_failed: skippedFailed
        });
        if (skippedFailed.length) jobLog(job, `Skipped ${skippedFailed.length} failed/invalid line(s): ${skippedFailed.join(', ')}`);
        if (skippedExisting.length) jobLog(job, `Skipped ${skippedExisting.length} already in DB: ${skippedExisting.join(', ')}`);
        enqueueSteamJob(job, () => runScanJob(job, accounts, to, { idOnly: !!idOnly }));
        return sendJSON(res, 202, jobView(job, false));
    }

    // Attach/refresh mailbox OAuth tokens on accounts that already exist. Each
    // line is `mail|pass|refresh_token|app_id`; the account is matched by its
    // stored email and only the four email_* columns are touched (never wallet,
    // level, friends). updateCredentials() stamps email_token_refreshed_at and
    // mirrors the row to D1. No Steam login, so this runs synchronously.
    if (method === 'POST' && p === '/api/email-tokens') {
        const { text } = await readBody(req);
        if (!text || !String(text).trim()) return sendJSON(res, 400, { error: 'no lines provided' });
        const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
        const findByEmail = db.prepare('SELECT steam_id, account_name FROM accounts WHERE lower(email) = lower(?)');
        const updated = [], notFound = [], invalid = [];
        const tx = db.transaction(() => {
            for (const line of lines) {
                // refresh_token may itself contain '|', so app_id is the LAST field
                // and the token is everything between pass and app_id.
                const parts = line.split('|');
                const email = (parts[0] || '').trim();
                const pass = (parts[1] || '').trim();
                const app_id = parts.length >= 4 ? (parts[parts.length - 1] || '').trim() : '';
                const refresh_token = parts.length >= 4 ? parts.slice(2, -1).join('|').trim() : '';
                if (parts.length < 4 || !/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(email) || !refresh_token) {
                    invalid.push(line.slice(0, 60));
                    continue;
                }
                const acc = findByEmail.get(email);
                if (!acc) { notFound.push(email); continue; }
                updateCredentials(acc.steam_id, {
                    email_password: pass || null,
                    email_refresh_token: refresh_token,
                    email_client_id: app_id || null,
                });
                updated.push(acc.account_name || email);
            }
        });
        tx();
        return sendJSON(res, 200, { updated: updated.length, updated_names: updated, not_found: notFound, invalid });
    }

    // Rotate stored mailbox OAuth tokens against Microsoft before they expire.
    if (method === 'POST' && p === '/api/email-tokens/refresh') {
        const b = await readBody(req);
        const dueDays = b.dueDays != null && b.dueDays !== '' ? Number(b.dueDays) : null;
        const emails = Array.isArray(b.emails) && b.emails.length ? b.emails : null;
        const job = makeJob('email-refresh', { total: 0 });
        enqueueSteamJob(job, async () => {
            job.status = 'running'; job.started_at = now();
            const r = await refreshMailTokens({ dueDays, emails, dryRun: !!b.dryRun, log: (...a) => jobLog(job, a.join(' ')) });
            job.total = r.total; job.done = r.total; job.ok = r.ok; job.failed = r.failed.length;
            r.failed.forEach((f) => job.results.push({ username: f.email, ok: false, reason: f.reason }));
            job.status = 'done'; job.finished_at = now();
            jobLog(job, `Done: ${r.ok}/${r.total} rotated, ${r.failed.length} failed.`);
        });
        return sendJSON(res, 202, jobView(job, false));
    }

    if (method === 'GET' && p === '/api/jobs') {
        const list = [...jobs.values()].sort((a, b) => b.created_at - a.created_at).map((j) => jobView(j, false));
        return sendJSON(res, 200, list);
    }

    let mj = /^\/api\/jobs\/([0-9a-f]{12})$/.exec(p);
    if (method === 'GET' && mj) {
        const job = jobs.get(mj[1]);
        return job ? sendJSON(res, 200, jobView(job, true)) : sendJSON(res, 404, { error: 'no such job' });
    }

    // --- gifting RPC for steam_profile_login.py (moves its DB access here) -----
    if (method === 'POST' && p === '/api/gift/candidates') {
        const b = await readBody(req);
        if (!b.account) return sendJSON(res, 400, { error: 'account required' });
        const r = gift.giftCandidates({
            account: b.account,
            limit: Number(b.limit) > 0 ? Number(b.limit) : 10,
            usesSentGifts: !!b.usesSentGifts,
            gameName: b.gameName || null,
            game: b.game || {},
            excludeNames: b.excludeNames || [],
            priorityNames: b.priorityNames || []
        });
        return sendJSON(res, 200, r);
    }

    if (method === 'POST' && p === '/api/gift/record-success') {
        const b = await readBody(req);
        if (!b.account || !b.friend_name) return sendJSON(res, 400, { error: 'account and friend_name required' });
        return sendJSON(res, 200, gift.recordSuccess({
            account: b.account, friend_name: b.friend_name, friend_steam_id: b.friend_steam_id || null,
            usesSentGifts: !!b.usesSentGifts, item_name: b.item_name || null,
            gifted_game: b.gifted_game || null, subid: b.subid || null, gameName: b.gameName || null
        }));
    }

    if (method === 'POST' && p === '/api/gift/record-failure') {
        const b = await readBody(req);
        if (!b.account || !b.friend_name) return sendJSON(res, 400, { error: 'account and friend_name required' });
        return sendJSON(res, 200, gift.recordFailure({
            account: b.account, friend_name: b.friend_name, friend_steam_id: b.friend_steam_id || null,
            usesSentGifts: !!b.usesSentGifts, item_name: b.item_name || null,
            subid: b.subid || null, reason: b.reason || 'unknown'
        }));
    }

    // --- update friends.country from a mapping (used by
    //     update_friend_country_from_file.js — remote DB is the source of truth) --
    if (method === 'POST' && p === '/api/friends/country') {
        const b = await readBody(req);
        const updates = Array.isArray(b.updates) ? b.updates : [];
        const commit = !!b.commit;
        if (updates.length === 0) return sendJSON(res, 400, { error: 'updates[] required' });

        const findByName = db.prepare('SELECT account_steam_id, friend_steam_id, friend_name, country FROM friends WHERE lower(friend_name) = lower(?)');
        const findBySteamID = db.prepare('SELECT account_steam_id, friend_steam_id, friend_name, country FROM friends WHERE friend_steam_id = ?');
        const updByName = db.prepare('UPDATE friends SET country = ?, updated_at = unixepoch() WHERE lower(friend_name) = lower(?)');
        const updBySteamID = db.prepare('UPDATE friends SET country = ?, updated_at = unixepoch() WHERE friend_steam_id = ?');

        let willChange = 0;
        let alreadyCorrect = 0;
        const unmatched = [];
        const changes = [];
        for (const u of updates) {
            const country = String(u.country || '').trim();
            const key = String(u.key || '');
            if (!country || !key) continue;
            const bySteam = u.matchBy === 'steamid';
            const rows = (bySteam ? findBySteamID : findByName).all(key);
            if (rows.length === 0) { unmatched.push({ matchBy: u.matchBy, key }); continue; }
            const rowChanges = rows.map((r) => ({
                friend_name: r.friend_name, account_steam_id: r.account_steam_id,
                current: r.country, new: country, will_change: r.country !== country
            }));
            willChange += rowChanges.filter((r) => r.will_change).length;
            alreadyCorrect += rowChanges.filter((r) => !r.will_change).length;
            changes.push({ matchBy: u.matchBy, key, country, rows: rowChanges });
        }

        let totalChanges = 0;
        if (commit) {
            const tx = db.transaction(() => {
                let t = 0;
                for (const u of updates) {
                    const country = String(u.country || '').trim();
                    const key = String(u.key || '');
                    if (!country || !key) continue;
                    const stmt = u.matchBy === 'steamid' ? updBySteamID : updByName;
                    t += stmt.run(country, key).changes;
                }
                return t;
            });
            totalChanges = tx();
        }
        return sendJSON(res, 200, { willChange, alreadyCorrect, unmatched, changes, committed: commit, totalChanges });
    }

    // --- gifted recipients for a day range (used by mark_gifted.js --auto) ----
    if (method === 'GET' && p === '/api/gifted') {
        const start = Number(url.searchParams.get('start'));
        const end = Number(url.searchParams.get('end'));
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            return sendJSON(res, 400, { error: 'start and end (unix epoch seconds) required, end > start' });
        }
        // Mirrors mark_gifted.js's findAllSentInRange + findAllGiftedInRange.
        const sent = db.prepare(`
            SELECT DISTINCT recipient_name AS friend_name, item_name AS game
            FROM sent_gifts
            WHERE created_at >= ? AND created_at < ?
              AND (status IS NULL OR status NOT LIKE 'FAILED%')
              AND recipient_name IS NOT NULL AND trim(recipient_name) <> ''
        `).all(start, end);
        const gifted = db.prepare(`
            SELECT DISTINCT friend_name, gifted_game AS game
            FROM friends
            WHERE gifted_at >= ? AND gifted_at < ?
              AND friend_name IS NOT NULL AND trim(friend_name) <> ''
        `).all(start, end);
        return sendJSON(res, 200, { sent, gifted });
    }

    return sendJSON(res, 404, { error: `no route for ${method} ${p}` });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!checkAuth(req, res, url)) return;
    if (url.pathname.startsWith('/api/')) {
        handleAPI(req, res, url).catch((err) => {
            console.error(`${req.method} ${url.pathname}:`, err.message);
            sendJSON(res, 500, { error: err.message });
        });
        return;
    }
    serveStatic(res, url.pathname);
});

// Refuse to expose an unauthenticated admin panel — it has full access to the
// account fleet. Loopback stays open for convenience.
if (!isLoopback(HOST) && !AUTH_TOKEN && !INSECURE) {
    console.error(`Refusing to bind ${HOST}:${PORT} with no auth — this dashboard controls all your accounts.`);
    console.error('Set a token, e.g.:  DASHBOARD_TOKEN=$(openssl rand -hex 16) node server.js --host=0.0.0.0');
    console.error('Override at your own risk:  node server.js --host=0.0.0.0 --insecure');
    process.exit(1);
}

server.listen(PORT, HOST, () => {
    const s = summary();
    const shown = isLoopback(HOST) ? '127.0.0.1' : HOST;
    console.log(`Steam project dashboard -> http://${shown}:${PORT}`);
    console.log(AUTH_TOKEN
        ? '  auth: token required (append ?token=... once, then it is cookied)'
        : '  auth: DISABLED — loopback only');
    if (!isLoopback(HOST) && !AUTH_TOKEN) console.log('  WARNING: bound to a network interface with NO auth (--insecure)');
    if (!isLoopback(HOST) && AUTH_TOKEN) console.log('  NOTE: plain HTTP — the token travels in clear; put TLS (tunnel/proxy) in front for real exposure.');
    console.log(`  ${s.accounts} accounts | ${s.friends} friends | ${s.sent_gifts} sent gifts | ${s.open_loans} open loan(s)`);
});
