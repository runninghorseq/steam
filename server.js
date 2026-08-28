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
const { db, setAccountLoan, addAccountStub, saveRefreshToken } = require('./db');
const { scanAccount } = require('./single');
const { parseSteamAccounts } = require('./multi_scan');
const { syncAccount } = require('./sync_sent_gifts');
const { updateWalletLevel } = require('./update_wallet_level');
const gift = require('./gift_api');
const { removeAccount } = require('./remove_account');

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
        saveRefreshToken(accountName, token);
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

async function runScanJob(job, accounts, timeout) {
    job.status = 'running';
    job.started_at = now();
    jobLog(job, `Scanning ${accounts.length} account(s), ${timeout}ms timeout each, sequential.`);
    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        jobLog(job, `>> [${i + 1}/${accounts.length}] ${acc.username}`);
        let res;
        try {
            res = await scanAccount(acc, { timeout, log: (...a) => jobLog(job, a.join(' ')) });
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
    a.loan_id, a.skip_wallet, a.source, a.scanned_at,
    (SELECT COUNT(*) FROM auth_tokens t WHERE lower(t.account_name) = lower(a.account_name)) AS has_token,
    (SELECT COUNT(*) FROM friends f WHERE f.account_steam_id = a.steam_id) AS friend_count,
    (SELECT COUNT(*) FROM sent_gifts s WHERE s.account_steam_id = a.steam_id) AS sent_gift_count,
    (SELECT COUNT(*) FROM pending_gifts p WHERE p.account_steam_id = a.steam_id) AS pending_gift_count,
    (SELECT COUNT(*) FROM licenses l WHERE l.account_steam_id = a.steam_id) AS license_count
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

function listAccounts({ q, sort, dir, filter, currency, walletMin, walletMax }) {
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

    return db.prepare(`
        SELECT ${ACCOUNT_COLS}
        FROM accounts a
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY ${orderCol} ${orderDir}
    `).all(params);
}

function accountDetail(steamID) {
    const account = db.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts a WHERE a.steam_id = ?`).get(steamID);
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
            SELECT package_id, package_name, payment_method, license_type, purchased_at
            FROM licenses WHERE account_steam_id = ? ORDER BY purchased_at DESC
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

function readBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (c) => {
            raw += c;
            if (raw.length > 1e6) reject(new Error('body too large'));
        });
        req.on('end', () => {
            if (!raw) return resolve({});
            try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
        });
        req.on('error', reject);
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
        return sendJSON(res, 200, listAccounts({
            q: url.searchParams.get('q') || '',
            sort: url.searchParams.get('sort') || 'account_name',
            dir: url.searchParams.get('dir') || 'asc',
            filter: url.searchParams.get('filter') || '',
            currency: url.searchParams.get('currency') || '',
            walletMin: url.searchParams.get('wallet_min') !== null && url.searchParams.get('wallet_min') !== '' ? Number(url.searchParams.get('wallet_min')) : null,
            walletMax: url.searchParams.get('wallet_max') !== null && url.searchParams.get('wallet_max') !== '' ? Number(url.searchParams.get('wallet_max')) : null
        }));
    }

    let m = /^\/api\/accounts\/(\d{17})$/.exec(p);
    if (method === 'GET' && m) {
        const detail = accountDetail(m[1]);
        return detail ? sendJSON(res, 200, detail) : sendJSON(res, 404, { error: 'account not found' });
    }

    // Start a password login to (re)cache a refresh token for one account.
    m = /^\/api\/accounts\/(\d{17})\/login$/.exec(p);
    if (method === 'POST' && m) {
        const b = await readBody(req);
        if (!b.password) return sendJSON(res, 400, { error: 'password required' });
        const acc = db.prepare('SELECT account_name FROM accounts WHERE steam_id = ?').get(m[1]);
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

    m = /^\/api\/accounts\/(\d{17})\/run$/.exec(p);
    if (method === 'POST' && m) {
        const { action, mode, timeout } = await readBody(req);
        if (!['scan', 'wallet', 'sync'].includes(action)) {
            return sendJSON(res, 400, { error: "action must be one of: scan, wallet, sync" });
        }
        const acc = db.prepare('SELECT account_name FROM accounts WHERE steam_id = ?').get(m[1]);
        if (!acc || !acc.account_name) {
            return sendJSON(res, 400, { error: 'account not found, or has no login name to run against' });
        }
        const to = Number(timeout) >= 10000 ? Number(timeout) : (action === 'sync' ? 120000 : 60000);
        const job = makeJob(action, { total: 1, usernames: [acc.account_name] });
        enqueueSteamJob(job, () => runSingleAccountJob(job, { username: acc.account_name }, action, { timeout: to, mode }));
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

    if (method === 'GET' && p === '/api/loans') {
        return sendJSON(res, 200, db.prepare('SELECT * FROM account_loans ORDER BY returned_at IS NOT NULL, due_at ASC').all());
    }

    if (method === 'POST' && p === '/api/loans') {
        const { account_name, borrower, days, note } = await readBody(req);
        const acc = db.prepare('SELECT steam_id, account_name FROM accounts WHERE lower(account_name) = lower(?)').get(account_name || '');
        if (!acc) return sendJSON(res, 400, { error: `no account named '${account_name}'` });
        const open = db.prepare('SELECT id FROM account_loans WHERE lower(account_name) = lower(?) AND returned_at IS NULL').get(acc.account_name);
        if (open) return sendJSON(res, 409, { error: `already lent (loan #${open.id})` });

        const d = Number(days) > 0 ? Number(days) : 1;
        const lent_at = now();
        const info = db.prepare(`
            INSERT INTO account_loans (account_name, account_steam_id, borrower, note, lent_at, due_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(acc.account_name, acc.steam_id, borrower || null, note || null, lent_at, lent_at + Math.round(d * 86400), lent_at, lent_at);
        // Same freeze lend_account.js applies: wallet/level stop being overwritten.
        setAccountLoan(acc.steam_id, info.lastInsertRowid);
        return sendJSON(res, 201, db.prepare('SELECT * FROM account_loans WHERE id = ?').get(info.lastInsertRowid));
    }

    m = /^\/api\/loans\/(\d+)\/return$/.exec(p);
    if (method === 'POST' && m) {
        const changes = db.prepare('UPDATE account_loans SET returned_at = ?, updated_at = ? WHERE id = ? AND returned_at IS NULL')
            .run(now(), now(), m[1]).changes;
        return changes
            ? sendJSON(res, 200, db.prepare('SELECT * FROM account_loans WHERE id = ?').get(m[1]))
            : sendJSON(res, 404, { error: 'no open loan with that id' });
    }

    m = /^\/api\/loans\/(\d+)$/.exec(p);
    if (method === 'PATCH' && m) {
        const { note } = await readBody(req);
        db.prepare('UPDATE account_loans SET note = ?, updated_at = ? WHERE id = ?').run(note ?? null, now(), m[1]);
        return sendJSON(res, 200, db.prepare('SELECT * FROM account_loans WHERE id = ?').get(m[1]));
    }

    if (method === 'GET' && p === '/api/gifts/sent') {
        return sendJSON(res, 200, db.prepare(`
            SELECT s.*, a.account_name FROM sent_gifts s
            LEFT JOIN accounts a ON a.steam_id = s.account_steam_id
            ORDER BY s.sent_at IS NULL, s.sent_at ASC
        `).all());
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

    if (method === 'GET' && p === '/api/gifts/pending') {
        return sendJSON(res, 200, db.prepare(`
            SELECT g.*, a.account_name FROM pending_gifts g
            LEFT JOIN accounts a ON a.steam_id = g.account_steam_id
            ORDER BY g.scanned_at DESC
        `).all());
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

    if (method === 'POST' && p === '/api/scan') {
        const { text, timeout, rescan, source, addOnly } = await readBody(req);
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

        const to = Number(timeout) >= 10000 ? Number(timeout) : 60000;
        const job = makeJob('scan', {
            total: accounts.length, usernames: accounts.map((a) => a.username),
            skipped_existing: skippedExisting, skipped_failed: skippedFailed
        });
        if (skippedFailed.length) jobLog(job, `Skipped ${skippedFailed.length} failed/invalid line(s): ${skippedFailed.join(', ')}`);
        if (skippedExisting.length) jobLog(job, `Skipped ${skippedExisting.length} already in DB: ${skippedExisting.join(', ')}`);
        enqueueSteamJob(job, () => runScanJob(job, accounts, to));
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
