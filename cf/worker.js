// Cloudflare Worker: dashboard UI (web/ static assets) + the DB-only API,
// backed by D1. The Steam-login jobs (scan/sync/wallet/login) need a persistent
// Node process and are NOT here — they run on the Debian box and write to this
// same D1. Those routes return 501 here so the UI degrades gracefully.
//
// Auth mirrors server.js: a shared token (DASHBOARD_TOKEN secret) required on
// every request, via ?token= (sets a cookie), the dash_token cookie, an
// X-Dashboard-Token header, or Authorization: Bearer.

import { createClient } from '@libsql/client/web';

const now = () => Math.floor(Date.now() / 1000);

// Business status an account can be published with (default 'available').
const STATUSES = ['available', 'renting', 'sold', 'reserved', 'disabled'];

function json(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
    });
}
const notOnWorker = (what) => json({ error: `${what} runs on the server (Steam login) — not available on the Cloudflare Worker`, on_worker: false }, 501);

// Forward a request to the Debian box (steam.fungamingvn.space), which runs the
// Steam-login jobs. The box shares the same DASHBOARD_TOKEN. Streams the box's
// response straight back (works for JSON and the job-log polling).
async function proxyToBox(req, env, url) {
    const base = (env.BOX_URL || 'https://steam.fungamingvn.space').replace(/\/+$/, '');
    const headers = new Headers(req.headers);
    headers.delete('host');
    if (env.DASHBOARD_TOKEN) headers.set('X-Dashboard-Token', env.DASHBOARD_TOKEN);
    // The box may sit behind Cloudflare too — a browser UA avoids the 1010 block.
    headers.set('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
    const init = { method: req.method, headers, redirect: 'manual' };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();
    try {
        return await fetch(base + url.pathname + url.search, init);
    } catch (err) {
        return json({ error: `box unreachable at ${base} (${err.message})`, on_worker: false }, 502);
    }
}

// --- auth -------------------------------------------------------------------

function parseCookies(req) {
    const out = {};
    (req.headers.get('cookie') || '').split(';').forEach((p) => {
        const i = p.indexOf('=');
        if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
}
function tokenMatches(given, expected) {
    if (!given || !expected || given.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
}
function checkAuth(req, url, env) {
    const TOKEN = env.DASHBOARD_TOKEN || '';
    if (!TOKEN) return null;
    const q = url.searchParams.get('token');
    if (q && tokenMatches(q, TOKEN)) {
        const cookie = `dash_token=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=2592000`;
        if (url.pathname.startsWith('/api/')) return null;
        url.searchParams.delete('token');
        return new Response(null, { status: 302, headers: { Location: url.pathname + (url.search || ''), 'Set-Cookie': cookie } });
    }
    const cookie = parseCookies(req).dash_token;
    const header = req.headers.get('x-dashboard-token') || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (tokenMatches(cookie, TOKEN) || tokenMatches(header, TOKEN)) return null;
    // The status feed can also be read with a scoped FEED_TOKEN (given to the
    // other repo) instead of the full dashboard token.
    if (url.pathname === '/api/accounts/feed' && env.FEED_TOKEN && (tokenMatches(q, env.FEED_TOKEN) || tokenMatches(header, env.FEED_TOKEN))) return null;
    if (url.pathname.startsWith('/api/')) return json({ error: 'unauthorized' }, 401);
    return new Response(
        '<!doctype html><meta charset=utf-8><body style="font:15px system-ui;max-width:34rem;margin:12vh auto;padding:0 1rem;color:#333"><h2>Authorization required</h2><p>Open this dashboard with <code>?token=YOUR_TOKEN</code> appended once. It is then remembered in a cookie.</p></body>',
        { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
}
function maybeSetCookie(req, url, env, res) {
    const TOKEN = env.DASHBOARD_TOKEN || '';
    if (TOKEN && url.searchParams.get('token') && tokenMatches(url.searchParams.get('token'), TOKEN)) {
        res.headers.append('Set-Cookie', `dash_token=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=2592000`);
    }
    return res;
}

// --- D1 helpers -------------------------------------------------------------

const rowsOf = async (stmt) => (await stmt.all()).results;

// Turso (libSQL) as a drop-in for the D1 binding: a shim that mimics D1's
// prepare().bind().all()/.first()/.run() + batch(), so all query code below is
// unchanged. Active when the TURSO_DATABASE_URL secret is set; the libSQL client
// is created once and cached across requests.
let _tursoDB = null;
function tursoDB(env) {
    if (_tursoDB) return _tursoDB;
    const client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
    const plain = (r) => (r ? { ...r } : r);
    const mk = (sql) => {
        const st = { sql, args: [] };
        st.bind = (...a) => { st.args = a; return st; };
        st.all = async () => ({ results: (await client.execute({ sql: st.sql, args: st.args })).rows.map(plain) });
        st.first = async () => { const rs = await client.execute({ sql: st.sql, args: st.args }); return rs.rows[0] ? plain(rs.rows[0]) : null; };
        st.run = async () => { const rs = await client.execute({ sql: st.sql, args: st.args }); return { meta: { changes: Number(rs.rowsAffected || 0), last_row_id: rs.lastInsertRowid } }; };
        return st;
    };
    _tursoDB = {
        prepare: (sql) => mk(sql),
        batch: (stmts) => client.batch(stmts.map((s) => ({ sql: s.sql, args: s.args })), 'write'),
    };
    return _tursoDB;
}

const ACCOUNT_COLS = `
    a.steam_id, a.account_name, a.persona, a.country, a.email,
    a.wallet_currency, a.wallet_balance_cents, a.steam_level, a.steam_points,
    a.loan_id, a.skip_wallet, a.source, a.email_token_refreshed_at, a.scanned_at,
    a.status, a.status_updated_at,
    (SELECT COUNT(*) FROM auth_tokens t WHERE lower(t.account_name) = lower(a.account_name)) AS has_token,
    (SELECT COUNT(*) FROM friends f WHERE f.account_steam_id = a.steam_id) AS friend_count,
    (SELECT COUNT(*) FROM sent_gifts s WHERE s.account_steam_id = a.steam_id) AS sent_gift_count,
    (SELECT COUNT(*) FROM pending_gifts p WHERE p.account_steam_id = a.steam_id) AS pending_gift_count,
    (SELECT COUNT(*) FROM licenses l WHERE l.account_steam_id = a.steam_id) AS license_count,
    (SELECT COUNT(*) FROM game_playtime gp WHERE gp.account_steam_id = a.steam_id) AS game_count,
    (SELECT COALESCE(SUM(playtime_forever),0) FROM game_playtime gp WHERE gp.account_steam_id = a.steam_id) AS playtime_minutes`;

const SORTABLE = {
    account_name: 'a.account_name COLLATE NOCASE', persona: 'a.persona COLLATE NOCASE',
    country: 'a.country', wallet: 'a.wallet_balance_cents', level: 'a.steam_level',
    points: 'a.steam_points', friends: 'friend_count', sent: 'sent_gift_count',
    pending: 'pending_gift_count', licenses: 'license_count', scanned: 'a.scanned_at',
};

async function listAccounts(env, { q, sort, dir, filter, currency, walletMin, walletMax, page, per }) {
    const where = [];
    const params = [];
    if (q) { where.push('(a.account_name LIKE ? OR a.persona LIKE ? OR a.email LIKE ? OR a.steam_id LIKE ?)'); const like = `%${q}%`; params.push(like, like, like, like); }
    if (filter === 'loaned') where.push('a.loan_id IS NOT NULL');
    if (filter === 'skip_wallet') where.push('a.skip_wallet = 1');
    if (filter === 'tracked') where.push('a.skip_wallet = 0');
    if (filter === 'no_token') where.push('(a.account_name IS NULL OR lower(a.account_name) NOT IN (SELECT lower(account_name) FROM auth_tokens))');
    if (filter === 'funded') where.push('a.wallet_balance_cents > 0');
    if (STATUSES.includes(filter)) { where.push('a.status = ?'); params.push(filter); }
    // Wallet filters: amounts arrive in major units, compared in cents; currency
    // is an exact ECurrencyCode match (only meaningful together with an amount).
    if (currency) { where.push('a.wallet_currency = ?'); params.push(currency); }
    if (walletMin != null) { where.push('a.wallet_balance_cents >= ?'); params.push(Math.round(walletMin * 100)); }
    if (walletMax != null) { where.push('a.wallet_balance_cents <= ?'); params.push(Math.round(walletMax * 100)); }
    const orderCol = SORTABLE[sort] || SORTABLE.account_name;
    const orderDir = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // Backward compatible: no `page` -> full array (wallet_skip.js et al. rely on
    // that). With `page` -> one page + the total count.
    if (page == null) {
        return rowsOf(env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts a ${whereSql} ORDER BY ${orderCol} ${orderDir}`).bind(...params));
    }
    const perN = Math.min(Math.max(1, per || 50), 500);
    const total = (await env.DB.prepare(`SELECT COUNT(*) AS c FROM accounts a ${whereSql}`).bind(...params).first()).c;
    const pages = Math.max(1, Math.ceil(total / perN));
    const pageN = Math.min(Math.max(1, page), pages);
    const rows = await rowsOf(env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts a ${whereSql} ORDER BY ${orderCol} ${orderDir} LIMIT ? OFFSET ?`).bind(...params, perN, (pageN - 1) * perN));
    return { rows, total, page: pageN, per: perN, pages };
}

async function accountDetail(env, steamID) {
    // Detail includes the managed credentials + the raw refresh token; the list
    // (ACCOUNT_COLS) deliberately does not, so secrets ship only for one account.
    const account = await env.DB.prepare(
        `SELECT ${ACCOUNT_COLS}, a.email_password, a.steam_password, a.email_refresh_token, a.email_client_id, `
        + '(SELECT refresh_token FROM auth_tokens t WHERE lower(t.account_name) = lower(a.account_name)) AS refresh_token '
        + 'FROM accounts a WHERE a.steam_id = ?').bind(steamID).first();
    if (!account) return null;
    const q = (sql) => rowsOf(env.DB.prepare(sql).bind(steamID));
    return {
        account,
        friends: await q('SELECT friend_steam_id, friend_name, friend_level, added_at, relationship, gifted_at, gifted_game, country FROM friends WHERE account_steam_id = ? ORDER BY added_at DESC'),
        sent_gifts: await q('SELECT * FROM sent_gifts WHERE account_steam_id = ? ORDER BY sent_at IS NULL, sent_at ASC'),
        pending_gifts: await q('SELECT * FROM pending_gifts WHERE account_steam_id = ? ORDER BY scanned_at DESC'),
        licenses: await q(`SELECT l.package_id, l.package_name, l.payment_method, l.license_type, l.purchased_at, (SELECT group_concat(DISTINCT la.app_name) FROM license_apps la WHERE la.account_steam_id = l.account_steam_id AND la.package_id = l.package_id) AS app_names FROM licenses l WHERE l.account_steam_id = ? ORDER BY l.purchased_at DESC`),
        loans: await rowsOf(env.DB.prepare('SELECT * FROM account_loans WHERE lower(account_name) = lower(?) ORDER BY lent_at DESC').bind(account.account_name || '')),
    };
}

async function summary(env) {
    const c = async (sql) => (await env.DB.prepare(sql).first()).c;
    const wallets = await rowsOf(env.DB.prepare(
        'SELECT wallet_currency AS currency, COUNT(*) AS accounts, SUM(wallet_balance_cents) AS cents FROM accounts WHERE wallet_balance_cents > 0 GROUP BY wallet_currency ORDER BY cents DESC'));
    return {
        accounts: await c('SELECT COUNT(*) c FROM accounts'),
        with_token: await c('SELECT COUNT(*) c FROM auth_tokens'),
        skip_wallet: await c('SELECT COUNT(*) c FROM accounts WHERE skip_wallet = 1'),
        loaned: await c('SELECT COUNT(*) c FROM accounts WHERE loan_id IS NOT NULL'),
        open_loans: await c('SELECT COUNT(*) c FROM account_loans WHERE returned_at IS NULL'),
        overdue_loans: await c(`SELECT COUNT(*) c FROM account_loans WHERE returned_at IS NULL AND due_at < ${now()}`),
        friends: await c('SELECT COUNT(*) c FROM friends'),
        sent_gifts: await c('SELECT COUNT(*) c FROM sent_gifts'),
        pending_gifts: await c('SELECT COUNT(*) c FROM pending_gifts'),
        wallets,
    };
}

// --- gift API (ported from gift_api.js, async D1) ---------------------------

// Names are inlined as escaped literals (not bound) — D1 caps bound variables
// at 100, and the exclude list alone is larger than that.
const sqlLit = (v) => `'${String(v).replace(/'/g, "''")}'`;
function excludeNamesClause(alias, excludeNames) {
    const names = (excludeNames || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
    if (!names.length) return { sql: '', params: [] };
    return { sql: `  AND lower(${alias}.friend_name) NOT IN (${names.map(sqlLit).join(',')}) `, params: [] };
}
function priorityOrderClause(alias, priorityNames) {
    const names = (priorityNames || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
    if (!names.length) return { sql: '', params: [] };
    const whens = names.map((n, i) => `WHEN ${sqlLit(n)} THEN ${i}`).join(' ');
    return { sql: `CASE lower(${alias}.friend_name) ${whens} ELSE ${names.length} END, `, params: [] };
}

async function getOldestFriendNames(env, { account, limit, gameName, game, excludeNames, priorityNames }) {
    if (!(await env.DB.prepare('SELECT 1 FROM accounts WHERE account_name = ?').bind(account).first())) return { candidates: [], reason: `Account '${account}' does not exist` };
    const exN = excludeNamesClause('f', excludeNames);
    const prio = priorityOrderClause('f', priorityNames);
    const params = [account];
    let giftedClause;
    if (game.exclude_if_any_gifted) {
        giftedClause = '  AND NOT EXISTS (    SELECT 1 FROM friends f2     WHERE (f2.friend_steam_id = f.friend_steam_id            OR lower(f2.friend_name) = lower(f.friend_name))       AND f2.gifted_at IS NOT NULL AND f2.gifted_at > 0  ) ';
    } else {
        giftedClause = '  AND NOT EXISTS (    SELECT 1 FROM friends f2     WHERE lower(f2.friend_name) = lower(f.friend_name)       AND f2.gifted_at IS NOT NULL AND f2.gifted_at > 0       AND f2.gifted_game = ?  ) ';
        params.push(gameName);
    }
    let anySentClause = '';
    if (game.exclude_if_any_sent_gift) anySentClause = '  AND NOT EXISTS (    SELECT 1 FROM sent_gifts sg     WHERE (sg.recipient_steam_id = f.friend_steam_id            OR lower(sg.recipient_name) = lower(f.friend_name))  ) ';
    const excludeSentItems = game.exclude_if_sent_items || [];
    let sentItemsClause = '';
    for (let i = 0; i < excludeSentItems.length; i++) sentItemsClause += '  AND NOT EXISTS (    SELECT 1 FROM sent_gifts sgi     WHERE sgi.item_name = ?       AND (sgi.recipient_steam_id = f.friend_steam_id            OR lower(sgi.recipient_name) = lower(f.friend_name))  ) ';
    params.push(...excludeSentItems, ...exN.params, ...prio.params, limit);
    const rows = await rowsOf(env.DB.prepare(
        'SELECT f.friend_name FROM accounts a JOIN friends f ON f.account_steam_id = a.steam_id WHERE a.account_name = ? '
        + "  AND f.added_at IS NOT NULL AND f.added_at > 0   AND f.gifted_at IS NULL   AND f.country != 'VN' "
        + giftedClause + anySentClause + sentItemsClause + exN.sql + 'ORDER BY ' + prio.sql + 'f.added_at ASC LIMIT ?'
    ).bind(...params));
    return { candidates: rows.map((r) => ({ friend_name: r.friend_name, friend_steam_id: null })), reason: rows.length ? null : `Account '${account}' has no giftable friends left` };
}

async function getGame2Friends(env, { account, limit, game, excludeNames, priorityNames }) {
    if (!(await env.DB.prepare('SELECT 1 FROM accounts WHERE account_name = ?').bind(account).first())) return { candidates: [], reason: `Account '${account}' does not exist` };
    const priorItem = game.requires_prior_sent_item;
    const itemName = game.item_name;
    const params = [account];
    let priorClause = '';
    if (priorItem) { priorClause = '  AND EXISTS (    SELECT 1 FROM sent_gifts sg1     WHERE sg1.item_name = ?       AND (sg1.recipient_steam_id = f.friend_steam_id            OR lower(sg1.recipient_name) = lower(f.friend_name))  ) '; params.push(priorItem); }
    let excludeGiftedClause = '';
    if (game.exclude_prior_gifted) excludeGiftedClause = '  AND NOT EXISTS (    SELECT 1 FROM friends f3     WHERE f3.gifted_at IS NOT NULL AND f3.gifted_at > 0       AND (f3.friend_steam_id = f.friend_steam_id            OR lower(f3.friend_name) = lower(f.friend_name))  ) ';
    const excludeSentItems = game.exclude_if_sent_items || [];
    let excludeSentClause = '';
    for (let i = 0; i < excludeSentItems.length; i++) excludeSentClause += '  AND NOT EXISTS (    SELECT 1 FROM sent_gifts sg3     WHERE sg3.item_name = ?       AND (sg3.recipient_steam_id = f.friend_steam_id            OR lower(sg3.recipient_name) = lower(f.friend_name))  ) ';
    params.push(...excludeSentItems);
    let excludeAnySentClause = '';
    if (game.exclude_if_any_sent_gift) excludeAnySentClause = '  AND NOT EXISTS (    SELECT 1 FROM sent_gifts sg4     WHERE (sg4.recipient_steam_id = f.friend_steam_id            OR lower(sg4.recipient_name) = lower(f.friend_name))  ) ';
    const excludeFailedClause = '  AND NOT EXISTS (    SELECT 1 FROM friends ff     WHERE ff.gifted_at = -1       AND (ff.friend_steam_id = f.friend_steam_id            OR lower(ff.friend_name) = lower(f.friend_name))  ) ';
    const exN = excludeNamesClause('f', excludeNames);
    const prio = priorityOrderClause('f', priorityNames);
    params.push(itemName, ...exN.params, ...prio.params, limit);
    const rows = await rowsOf(env.DB.prepare(
        'SELECT f.friend_name, f.friend_steam_id FROM accounts a JOIN friends f ON f.account_steam_id = a.steam_id WHERE a.account_name = ? '
        + "  AND f.country != 'VN'   AND f.friend_steam_id IS NOT NULL AND f.friend_steam_id != '' "
        + priorClause + excludeGiftedClause + excludeSentClause + excludeAnySentClause + excludeFailedClause
        + '  AND NOT EXISTS (    SELECT 1 FROM sent_gifts sg2     WHERE sg2.item_name = ?       AND (sg2.recipient_steam_id = f.friend_steam_id            OR lower(sg2.recipient_name) = lower(f.friend_name))  ) '
        + exN.sql + 'ORDER BY ' + prio.sql + 'f.gifted_at ASC LIMIT ?'
    ).bind(...params));
    return { candidates: rows.map((r) => ({ friend_name: r.friend_name, friend_steam_id: r.friend_steam_id })), reason: rows.length ? null : `Account '${account}' has no ${itemName}-eligible friends left` };
}

async function recordGift(env, account, friend_name, game_name) {
    const gifter = await env.DB.prepare('SELECT steam_id FROM accounts WHERE account_name = ?').bind(account).first();
    if (!gifter) return 0;
    const row = await env.DB.prepare('SELECT friend_steam_id FROM friends WHERE account_steam_id = ? AND friend_name = ?').bind(gifter.steam_id, friend_name).first();
    const ts = now();
    if (!row || !row.friend_steam_id) {
        return (await env.DB.prepare('UPDATE friends SET gifted_at = ?, gifted_game = ? WHERE account_steam_id = ? AND friend_name = ?').bind(ts, game_name, gifter.steam_id, friend_name).run()).meta.changes;
    }
    return (await env.DB.prepare('UPDATE friends SET gifted_at = ?, gifted_game = ? WHERE friend_steam_id = ? AND gifted_at IS NULL').bind(ts, game_name, row.friend_steam_id).run()).meta.changes;
}
async function recordGame2Gift(env, account, friend_name, friend_steam_id, item_name, subid, status) {
    const gifter = await env.DB.prepare('SELECT steam_id FROM accounts WHERE account_name = ?').bind(account).first();
    const accId = gifter ? gifter.steam_id : null;
    const gid = `local-${subid}-${accId}-${friend_steam_id}-${now()}`;
    return (await env.DB.prepare('INSERT OR IGNORE INTO sent_gifts (gift_id, account_steam_id, recipient_steam_id, recipient_name, item_name, detail, sent_at, status, store_url, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(gid, accId, friend_steam_id, friend_name, item_name, 'Steam Gift', null, status || 'pending', null, now()).run()).meta.changes;
}

// --- API routing ------------------------------------------------------------

// Parse a Steam gift date string to a unix epoch (year omitted by Steam).
// Kept in sync with parse_gifted_at.js on the box.
function ingestGiftedAt(s) {
    if (!s) return null;
    const d = new Date(`${s} ${new Date().getFullYear()}`);
    return Number.isFinite(d.getTime()) ? Math.floor(d.getTime() / 1000) : null;
}

// The single write path for the stateless box: it POSTs {op, ...args} here and
// the Worker performs the D1 write/read, so the Worker is D1's only writer. The
// SQL mirrors store.js's D1-direct branch (COALESCE upserts preserve gifted_at).
async function handleIngest(env, b) {
    const DB = env.DB;
    const ts = Math.floor(Date.now() / 1000);
    const run = (sql, ...pp) => DB.prepare(sql).bind(...pp).run();
    const all = async (sql, ...pp) => (await DB.prepare(sql).bind(...pp).all()).results;
    const first = (sql, ...pp) => DB.prepare(sql).bind(...pp).first();
    // Batch writes in large chunks so a big scan stays well under the Worker's
    // subrequest cap (each DB.batch is one subrequest; Turso has no param limit).
    const batchAll = async (stmts) => { for (let i = 0; i < stmts.length; i += 500) await DB.batch(stmts.slice(i, i + 500)); };

    switch (b.op) {
        case 'getRefreshToken': {
            const r = await first('SELECT refresh_token FROM auth_tokens WHERE account_name = ?', b.accountName);
            return r ? r.refresh_token : null;
        }
        case 'saveRefreshToken':
            await run('INSERT INTO auth_tokens (account_name, refresh_token, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_name) DO UPDATE SET refresh_token = excluded.refresh_token, updated_at = excluded.updated_at', b.accountName, b.token, ts, ts);
            return true;
        case 'saveJob': {
            const r = b.row;
            await run('INSERT INTO jobs (id, type, status, created_at, updated_at, summary, lines) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, summary = excluded.summary, lines = excluded.lines', r.id, r.type, r.status, r.created_at, r.updated_at, r.summary, r.lines);
            return true;
        }
        case 'clearRefreshToken':
            await run('DELETE FROM auth_tokens WHERE account_name = ?', b.accountName);
            return true;
        case 'saveAccount': {
            const p = { ...(b.partial || {}) };
            if (p.wallet_currency != null || p.wallet_balance_cents != null || p.steam_level != null) {
                const row = await first('SELECT loan_id FROM accounts WHERE steam_id = ?', p.steam_id);
                if (row && row.loan_id != null) { p.wallet_currency = null; p.wallet_balance_cents = null; p.steam_level = null; }
            }
            await run('INSERT INTO accounts (steam_id, account_name, persona, country, email, wallet_currency, wallet_balance_cents, steam_level, steam_points, source, steam_password, email_password, scanned_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(steam_id) DO UPDATE SET account_name = COALESCE(excluded.account_name, accounts.account_name), persona = COALESCE(excluded.persona, accounts.persona), country = COALESCE(excluded.country, accounts.country), email = COALESCE(excluded.email, accounts.email), wallet_currency = COALESCE(excluded.wallet_currency, accounts.wallet_currency), wallet_balance_cents = COALESCE(excluded.wallet_balance_cents, accounts.wallet_balance_cents), steam_level = COALESCE(excluded.steam_level, accounts.steam_level), steam_points = COALESCE(excluded.steam_points, accounts.steam_points), source = COALESCE(excluded.source, accounts.source), steam_password = COALESCE(excluded.steam_password, accounts.steam_password), email_password = COALESCE(excluded.email_password, accounts.email_password), scanned_at = excluded.scanned_at, updated_at = excluded.updated_at',
                p.steam_id, p.account_name ?? null, p.persona ?? null, p.country ?? null, p.email ?? null, p.wallet_currency ?? null, p.wallet_balance_cents ?? null, p.steam_level ?? null, p.steam_points ?? null, p.source ?? null, p.steam_password ?? null, p.email_password ?? null, ts, ts, ts);
            return true;
        }
        case 'addAccountStub': {
            const p = b.partial || {};
            await run('INSERT INTO accounts (steam_id, account_name, email, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(steam_id) DO UPDATE SET account_name = COALESCE(excluded.account_name, accounts.account_name), email = COALESCE(excluded.email, accounts.email), source = COALESCE(excluded.source, accounts.source), updated_at = excluded.updated_at',
                p.steam_id, p.account_name ?? null, p.email ?? null, p.source ?? null, ts, ts);
            return true;
        }
        case 'dropPendingStub':
            if (b.accountName) await run("DELETE FROM accounts WHERE steam_id LIKE 'pending:%' AND lower(account_name) = lower(?)", b.accountName);
            return true;
        case 'accountNames':
            return all('SELECT lower(account_name) AS n FROM accounts WHERE account_name IS NOT NULL');
        case 'tokenAccountNames':
            return all('SELECT account_name FROM auth_tokens');
        case 'accountsWithSentGifts':
            return all('SELECT DISTINCT a.account_name AS username FROM sent_gifts s JOIN accounts a ON a.steam_id = s.account_steam_id WHERE a.account_name IS NOT NULL ORDER BY a.account_name');
        case 'saveFriends': {
            const friends = b.friends || [];
            if (!friends.length) return true;
            const sql = 'INSERT INTO friends (account_steam_id, friend_steam_id, friend_name, friend_level, added_at, relationship, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_steam_id, friend_steam_id) DO UPDATE SET friend_name = COALESCE(excluded.friend_name, friends.friend_name), friend_level = COALESCE(excluded.friend_level, friends.friend_level), added_at = COALESCE(excluded.added_at, friends.added_at), relationship = COALESCE(excluded.relationship, friends.relationship), updated_at = excluded.updated_at';
            await batchAll(friends.map((f) => DB.prepare(sql).bind(b.accountSteamID, f.steam_id, f.name ?? null, f.level ?? null, f.added_at ?? null, f.relationship ?? null, ts, ts)));
            return true;
        }
        case 'saveLicenses': {
            const licenses = b.licenses || [];
            const stmts = [
                DB.prepare('DELETE FROM license_apps WHERE account_steam_id = ?').bind(b.accountSteamID),
                DB.prepare('DELETE FROM licenses WHERE account_steam_id = ?').bind(b.accountSteamID),
            ];
            const licSQL = 'INSERT OR REPLACE INTO licenses (account_steam_id, package_id, package_name, payment_method, license_type, purchased_at, territory_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
            for (const l of licenses) stmts.push(DB.prepare(licSQL).bind(b.accountSteamID, l.package_id, l.package_name ?? null, l.payment_method ?? null, l.license_type ?? null, l.purchased_at ?? null, l.territory_code ?? null, ts, ts));
            const appSQL = 'INSERT OR REPLACE INTO license_apps (account_steam_id, package_id, app_id, app_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)';
            for (const l of licenses) for (const a of (l.apps || [])) stmts.push(DB.prepare(appSQL).bind(b.accountSteamID, l.package_id, a.app_id, a.app_name ?? null, ts, ts));
            await batchAll(stmts);
            return true;
        }
        case 'saveGifts': {
            const gifts = b.gifts || [];
            await run('DELETE FROM pending_gifts WHERE account_steam_id = ?', b.accountSteamID);
            for (const g of gifts) {
                await run('INSERT OR REPLACE INTO pending_gifts (gift_id, account_steam_id, item_name, detail, sender_steam_id, sender_name, sent_at, status, store_url, scanned_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    g.gift_id, b.accountSteamID, g.item_name ?? null, g.detail ?? null, g.sender_steam_id ?? null, g.sender_name ?? null, g.sent_at ?? null, g.status ?? null, g.store_url ?? null, ts, ts, ts);
                if (g.sender_steam_id) await run('UPDATE friends SET gifted_at = ?, gifted_game = ?, updated_at = ? WHERE account_steam_id = ? AND friend_steam_id = ?', ingestGiftedAt(g.sent_at), g.item_name ?? null, ts, b.accountSteamID, g.sender_steam_id);
            }
            return true;
        }
        case 'saveSentGifts': {
            const gifts = b.gifts || [];
            await run('DELETE FROM sent_gifts WHERE account_steam_id = ?', b.accountSteamID);
            for (const g of gifts) {
                await run('INSERT OR REPLACE INTO sent_gifts (gift_id, account_steam_id, recipient_steam_id, recipient_name, item_name, detail, sent_at, status, store_url, scanned_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    g.gift_id, b.accountSteamID, g.recipient_steam_id ?? null, g.recipient_name ?? null, g.item_name ?? null, g.detail ?? null, ingestGiftedAt(g.sent_at), g.status ?? null, g.store_url ?? null, ts, ts, ts);
            }
            return true;
        }
        case 'reconcileSentGifts': {
            const liveGifts = b.liveGifts || [];
            const live = new Set(liveGifts.map((g) => g.gift_id));
            const existing = (await all('SELECT gift_id FROM sent_gifts WHERE account_steam_id = ?', b.accountSteamID)).map((r) => r.gift_id);
            const deleted = existing.filter((id) => !live.has(id));
            for (let i = 0; i < deleted.length; i += 500) { const c = deleted.slice(i, i + 500); await run(`DELETE FROM sent_gifts WHERE account_steam_id = ? AND gift_id IN (${c.map(() => '?').join(', ')})`, b.accountSteamID, ...c); }
            for (const g of liveGifts) {
                await run('INSERT OR REPLACE INTO sent_gifts (gift_id, account_steam_id, recipient_steam_id, recipient_name, item_name, detail, sent_at, status, store_url, scanned_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    g.gift_id, b.accountSteamID, g.recipient_steam_id ?? null, g.recipient_name ?? null, g.item_name ?? null, g.detail ?? null, ingestGiftedAt(g.sent_at), g.status ?? null, g.store_url ?? null, ts, ts, ts);
            }
            return { kept: liveGifts.length, deleted };
        }
        case 'saveGamePlaytime': {
            const games = b.games || [];
            const stmts = [DB.prepare('DELETE FROM game_playtime WHERE account_steam_id = ?').bind(b.accountSteamID)];
            const sql = 'INSERT OR REPLACE INTO game_playtime (account_steam_id, app_id, name, playtime_forever, playtime_2weeks, scanned_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
            for (const g of games) stmts.push(DB.prepare(sql).bind(b.accountSteamID, g.app_id ?? g.appid, g.name ?? null, g.playtime_forever ?? 0, g.playtime_2weeks ?? 0, ts, ts, ts));
            await batchAll(stmts);
            return true;
        }
        case 'removeFriendRows': {
            // One DELETE per chunk, not per friend — over Turso each query is a
            // Worker subrequest, and a big prune would blow the subrequest cap.
            const ids = b.friendSteamIDs || [];
            for (let i = 0; i < ids.length; i += 500) {
                const c = ids.slice(i, i + 500);
                await run(`DELETE FROM friends WHERE account_steam_id = ? AND friend_steam_id IN (${c.map(() => '?').join(', ')})`, b.accountSteamID, ...c);
            }
            return true;
        }
        case 'accountNameBySteamID': {
            const r = await first('SELECT account_name FROM accounts WHERE steam_id = ?', b.steamID);
            return r ? r.account_name : null;
        }
        case 'accountBySteamID':
            return (await first('SELECT steam_id, account_name FROM accounts WHERE steam_id = ?', b.steamID)) || null;
        case 'accountByName':
            return (await first('SELECT steam_id, account_name FROM accounts WHERE lower(account_name) = lower(?)', b.name)) || null;
        case 'friendSteamIDs':
            return (await all('SELECT friend_steam_id FROM friends WHERE account_steam_id = ?', b.accountSteamID)).map((r) => r.friend_steam_id);
        case 'mailTokenAccounts': {
            const sel = "SELECT steam_id, account_name, email, email_refresh_token, email_client_id, email_token_refreshed_at FROM accounts WHERE email_refresh_token IS NOT NULL AND email_refresh_token != '' AND email_client_id IS NOT NULL AND email_client_id != ''";
            if (b.dueDays == null) return all(sel);
            const cutoff = ts - b.dueDays * 86400;
            return all(sel + ' AND (email_token_refreshed_at IS NULL OR email_token_refreshed_at <= ?)', cutoff);
        }
        case 'saveEmailRefreshToken':
            await run('UPDATE accounts SET email_refresh_token = ?, email_token_refreshed_at = ?, updated_at = ? WHERE steam_id = ?', b.refreshToken, ts, ts, b.steamID);
            return true;
        case 'walletRefreshSelection': {
            const [tokened, skip, lent] = await Promise.all([
                all('SELECT account_name AS username FROM auth_tokens ORDER BY account_name'),
                all("SELECT account_name FROM accounts WHERE skip_wallet = 1 AND account_name IS NOT NULL"),
                all("SELECT account_name FROM accounts WHERE loan_id IS NOT NULL AND account_name IS NOT NULL"),
            ]);
            return { tokened, skip, lent };
        }
        default:
            throw new Error(`unknown ingest op: ${b.op}`);
    }
}

// Push an account's new status to another repo's webhook (best-effort; the pull
// feed at /api/accounts/feed stays the source of truth if a push is missed).
async function pushStatusWebhook(env, account) {
    if (!env.STATUS_WEBHOOK_URL) return;
    try {
        await fetch(env.STATUS_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(env.STATUS_WEBHOOK_TOKEN ? { Authorization: `Bearer ${env.STATUS_WEBHOOK_TOKEN}` } : {}) },
            body: JSON.stringify({ event: 'account.status', account, at: now() }),
        });
    } catch (_) { /* swallow — the feed is authoritative */ }
}

async function handleApi(req, env, url, ctx) {
    const p = url.pathname;
    const method = req.method;
    const body = async () => req.json().catch(() => ({}));

    // Stateless-box write/read path: the box POSTs {op, ...args}; Worker owns D1.
    if (method === 'POST' && p === '/api/ingest') {
        try { return json({ result: await handleIngest(env, await body()) }); }
        catch (e) { return json({ error: e.message }, 400); }
    }

    if (method === 'GET' && p === '/api/summary') return json(await summary(env));

    // Per-filter record counts for the accounts page chips (each is that filter
    // alone, across all accounts). Matches the WHERE clauses in listAccounts.
    if (method === 'GET' && p === '/api/accounts/filter-counts') {
        const c = async (sql) => (await env.DB.prepare(sql).first()).c;
        return json({
            total: await c('SELECT COUNT(*) c FROM accounts'),
            funded: await c('SELECT COUNT(*) c FROM accounts WHERE wallet_balance_cents > 0'),
            skip_wallet: await c('SELECT COUNT(*) c FROM accounts WHERE skip_wallet = 1'),
            tracked: await c('SELECT COUNT(*) c FROM accounts WHERE skip_wallet = 0'),
            loaned: await c('SELECT COUNT(*) c FROM accounts WHERE loan_id IS NOT NULL'),
            no_token: await c('SELECT COUNT(*) c FROM accounts WHERE account_name IS NULL OR lower(account_name) NOT IN (SELECT lower(account_name) FROM auth_tokens)'),
            renting: await c("SELECT COUNT(*) c FROM accounts WHERE status = 'renting'"),
            sold: await c("SELECT COUNT(*) c FROM accounts WHERE status = 'sold'"),
            reserved: await c("SELECT COUNT(*) c FROM accounts WHERE status = 'reserved'"),
        });
    }

    if (method === 'GET' && p === '/api/accounts') {
        const numParam = (k) => { const v = url.searchParams.get(k); return v !== null && v !== '' ? Number(v) : null; };
        return json(await listAccounts(env, {
            q: url.searchParams.get('q') || '', sort: url.searchParams.get('sort') || 'account_name',
            dir: url.searchParams.get('dir') || 'asc', filter: url.searchParams.get('filter') || '',
            currency: url.searchParams.get('currency') || '', walletMin: numParam('wallet_min'), walletMax: numParam('wallet_max'),
            page: numParam('page'), per: numParam('per'),
        }));
    }

    // A real SteamID64, or a `pending:<username>` stub added without a SteamID —
    // openable so the admin can review it before scanning to resolve it.
    let m = /^\/api\/accounts\/(\d{17}|pending:[^/]+)$/.exec(p);
    if (method === 'GET' && m) { const d = await accountDetail(env, m[1]); return d ? json(d) : json({ error: 'account not found' }, 404); }

    m = /^\/api\/accounts\/(\d{17})\/playtime$/.exec(p);
    if (method === 'GET' && m) {
        const rows = await rowsOf(env.DB.prepare('SELECT app_id, name, playtime_forever, playtime_2weeks, scanned_at FROM game_playtime WHERE account_steam_id = ? ORDER BY playtime_forever DESC').bind(m[1]));
        const total = rows.reduce((s, r) => s + (r.playtime_forever || 0), 0);
        return json({ games: rows, count: rows.length, played: rows.filter((r) => r.playtime_forever > 0).length, total_minutes: total });
    }

    // Playtime leaderboard: accounts with game data, most playtime first.
    if (method === 'GET' && p === '/api/playtime') {
        const q = url.searchParams.get('q') || '';
        const like = `%${q}%`;
        return json(await rowsOf(env.DB.prepare(
            "SELECT a.steam_id, a.account_name, a.persona, COUNT(gp.app_id) AS game_count, "
            + "COALESCE(SUM(gp.playtime_forever),0) AS playtime_minutes, COALESCE(SUM(gp.playtime_2weeks),0) AS playtime_2weeks_minutes "
            + "FROM accounts a JOIN game_playtime gp ON gp.account_steam_id = a.steam_id "
            + "WHERE (? = '' OR a.account_name LIKE ? OR a.persona LIKE ? OR EXISTS (SELECT 1 FROM game_playtime g2 WHERE g2.account_steam_id = a.steam_id AND g2.name LIKE ?)) "
            + "GROUP BY a.steam_id ORDER BY playtime_minutes DESC LIMIT 1000")
            .bind(q, like, like, like)));
    }
    if (method === 'DELETE' && m) return notOnWorker('Account deletion');

    // Bulk skip_wallet apply from a client-built filter (used by wallet_skip.js).
    if (method === 'POST' && p === '/api/accounts/skip-wallet-bulk') {
        const b = await body();
        const where = String(b.where || '').trim();
        const params = Array.isArray(b.params) ? b.params : [];
        const target = b.target ? 1 : 0;
        if (!where) return json({ error: 'where clause required' }, 400);
        const cols = 'steam_id, account_name, wallet_currency, wallet_balance_cents, steam_level, loan_id, skip_wallet';
        const rows = await rowsOf(env.DB.prepare(`SELECT ${cols} FROM accounts WHERE (${where}) AND skip_wallet != ? ORDER BY account_name`).bind(...params, target));
        let changed = 0;
        if (b.commit) {
            const r = await env.DB.prepare(`UPDATE accounts SET skip_wallet = ?, updated_at = unixepoch() WHERE (${where}) AND skip_wallet != ?`).bind(target, ...params, target).run();
            changed = r.meta.changes;
        }
        const totalFlagged = (await env.DB.prepare('SELECT COUNT(*) c FROM accounts WHERE skip_wallet = 1').first()).c;
        return json({ rows, changed, committed: !!b.commit, totalFlagged });
    }

    m = /^\/api\/accounts\/(\d{17})\/skip-wallet$/.exec(p);
    if (method === 'POST' && m) {
        const { value } = await body();
        const changes = (await env.DB.prepare('UPDATE accounts SET skip_wallet = ?, updated_at = unixepoch() WHERE steam_id = ?').bind(value ? 1 : 0, m[1]).run()).meta.changes;
        return changes ? json({ steam_id: m[1], skip_wallet: value ? 1 : 0 }) : json({ error: 'account not found' }, 404);
    }

    // Set an account's business status (available/renting/sold/reserved/disabled)
    // and push it to the other repo's webhook if one is configured.
    m = /^\/api\/accounts\/(\d{17})\/status$/.exec(p);
    if (method === 'POST' && m) {
        const { status } = await body();
        if (!STATUSES.includes(status)) return json({ error: `status must be one of: ${STATUSES.join(', ')}` }, 400);
        const changes = (await env.DB.prepare('UPDATE accounts SET status = ?, status_updated_at = unixepoch(), updated_at = unixepoch() WHERE steam_id = ?').bind(status, m[1]).run()).meta.changes;
        if (!changes) return json({ error: 'account not found' }, 404);
        const account = await env.DB.prepare('SELECT steam_id, account_name, persona, country, status, status_updated_at FROM accounts WHERE steam_id = ?').bind(m[1]).first();
        if (env.STATUS_WEBHOOK_URL && ctx) ctx.waitUntil(pushStatusWebhook(env, account));
        return json({ steam_id: m[1], status, pushed: !!env.STATUS_WEBHOOK_URL });
    }

    // Public feed for another repo: accounts + their status (optionally filtered by
    // ?status=). Readable with the dashboard token or a scoped FEED_TOKEN.
    if (method === 'GET' && p === '/api/accounts/feed') {
        const status = url.searchParams.get('status');
        if (status && !STATUSES.includes(status)) return json({ error: `unknown status '${status}'` }, 400);
        const rows = await rowsOf(env.DB.prepare(
            `SELECT steam_id, account_name, persona, country, wallet_currency, wallet_balance_cents, steam_level, status, status_updated_at
             FROM accounts ${status ? 'WHERE status = ?' : ''} ORDER BY status_updated_at DESC, account_name COLLATE NOCASE`
        ).bind(...(status ? [status] : [])));
        return json({ count: rows.length, statuses: STATUSES, accounts: rows });
    }

    // Manage credentials: email / email_password / steam_password (accounts) and
    // the refresh token (auth_tokens). Only the keys present in the body change;
    // '' clears a field. Direct set (not COALESCE), so edits and clears both apply.
    m = /^\/api\/accounts\/(\d{17})\/credentials$/.exec(p);
    if (method === 'POST' && m) {
        const b = await body();
        const acc = await env.DB.prepare('SELECT account_name FROM accounts WHERE steam_id = ?').bind(m[1]).first();
        if (!acc) return json({ error: 'account not found' }, 404);
        const cols = ['email', 'email_password', 'steam_password', 'email_refresh_token', 'email_client_id'].filter((k) => k in b);
        const vals = cols.map((k) => (b[k] === '' ? null : (b[k] ?? null)));
        const assign = cols.map((k) => `${k} = ?`);
        // Stamp the mailbox-token rotation time on a new token or an explicit mark.
        if ((cols.includes('email_refresh_token') && b.email_refresh_token) || b.stamp_refreshed) {
            assign.push('email_token_refreshed_at = unixepoch()');
        }
        if (assign.length) {
            await env.DB.prepare(`UPDATE accounts SET ${assign.join(', ')}, updated_at = unixepoch() WHERE steam_id = ?`).bind(...vals, m[1]).run();
        }
        if ('refresh_token' in b && acc.account_name) {
            const ts = Math.floor(Date.now() / 1000);
            if (b.refresh_token) await env.DB.prepare('INSERT INTO auth_tokens (account_name, refresh_token, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_name) DO UPDATE SET refresh_token = excluded.refresh_token, updated_at = excluded.updated_at').bind(acc.account_name, b.refresh_token, ts, ts).run();
            else await env.DB.prepare('DELETE FROM auth_tokens WHERE account_name = ?').bind(acc.account_name).run();
        }
        return json({ steam_id: m[1], updated: true });
    }
    m = /^\/api\/accounts\/(\d{17})\/unlink-loan$/.exec(p);
    if (method === 'POST' && m) {
        const changes = (await env.DB.prepare('UPDATE accounts SET loan_id = NULL, updated_at = unixepoch() WHERE steam_id = ?').bind(m[1]).run()).meta.changes;
        return changes ? json({ steam_id: m[1], loan_id: null }) : json({ error: 'account not found' }, 404);
    }
    // Steam-login per-account actions -> box only
    if (method === 'POST' && (/^\/api\/accounts\/\d{17}\/(run|login|remove-friends)$/.test(p))) return proxyToBox(req, env, url);
    if (/^\/api\/accounts\/login\//.test(p)) return proxyToBox(req, env, url);

    if (method === 'GET' && p === '/api/gifts/sent') return json(await rowsOf(env.DB.prepare('SELECT s.*, a.account_name, ra.steam_id AS recipient_account_id, ra.account_name AS recipient_account_name FROM sent_gifts s LEFT JOIN accounts a ON a.steam_id = s.account_steam_id LEFT JOIN accounts ra ON ra.steam_id = s.recipient_steam_id ORDER BY s.sent_at IS NULL, s.sent_at ASC')));
    // Admin: delete sent-gift rows by gift_id (DB-only cleanup; a live gift that is
    // still pending on Steam will reappear on the next sync).
    if (method === 'POST' && p === '/api/gifts/sent/delete') {
        const b = await body();
        const ids = Array.isArray(b.gift_ids) ? b.gift_ids.map(String).filter(Boolean) : [];
        if (!ids.length) return json({ error: 'gift_ids[] required' }, 400);
        let deleted = 0;
        for (let i = 0; i < ids.length; i += 90) { // D1 caps bound params at 100/query
            const c = ids.slice(i, i + 90);
            deleted += (await env.DB.prepare(`DELETE FROM sent_gifts WHERE gift_id IN (${c.map(() => '?').join(', ')})`).bind(...c).run()).meta.changes;
        }
        return json({ deleted });
    }
    if (method === 'POST' && p === '/api/gifts/sync') return proxyToBox(req, env, url);

    if (method === 'GET' && p === '/api/friends') {
        const q = url.searchParams.get('q') || '';
        const like = `%${q}%`;
        return json(await rowsOf(env.DB.prepare(
            "SELECT f.*, a.account_name FROM friends f LEFT JOIN accounts a ON a.steam_id = f.account_steam_id WHERE (? = '' OR f.friend_name LIKE ? OR f.friend_steam_id LIKE ? OR a.account_name LIKE ?) ORDER BY f.added_at DESC LIMIT 2000")
            .bind(q, like, like, like)));
    }

    // Licenses aggregated by package (one row per package_id, across all accounts).
    if (method === 'GET' && p === '/api/licenses') {
        const q = url.searchParams.get('q') || '';
        const like = `%${q}%`;
        return json(await rowsOf(env.DB.prepare(
            "SELECT l.package_id, MAX(l.package_name) AS package_name, "
            + "COUNT(DISTINCT l.account_steam_id) AS account_count, "
            + "(SELECT group_concat(DISTINCT la.app_name) FROM license_apps la WHERE la.package_id = l.package_id AND la.app_name IS NOT NULL) AS app_names "
            + "FROM licenses l "
            + "WHERE (? = '' OR l.package_name LIKE ? OR CAST(l.package_id AS TEXT) LIKE ? "
            + "OR EXISTS (SELECT 1 FROM license_apps la2 WHERE la2.package_id = l.package_id AND la2.app_name LIKE ?)) "
            + "GROUP BY l.package_id ORDER BY account_count DESC, package_name LIMIT 2000")
            .bind(q, like, like, like)));
    }
    // Which accounts own a given package.
    if (method === 'GET' && p === '/api/licenses/owners') {
        const pkg = parseInt(url.searchParams.get('package_id'), 10);
        if (!Number.isFinite(pkg)) return json({ error: 'package_id required' }, 400);
        return json(await rowsOf(env.DB.prepare(
            "SELECT l.account_steam_id, a.account_name, l.payment_method, l.license_type, l.purchased_at "
            + "FROM licenses l LEFT JOIN accounts a ON a.steam_id = l.account_steam_id "
            + "WHERE l.package_id = ? ORDER BY a.account_name")
            .bind(pkg)));
    }

    if (method === 'POST' && p === '/api/scan') return proxyToBox(req, env, url);

    // Attach/refresh mailbox OAuth tokens on accounts that already exist, matching
    // each `mail|pass|refresh_token|app_id` line by its stored email. Handled HERE
    // against D1 (not proxied to the box): the dashboard's accounts live in D1, and
    // some are D1-only — never on the box — so box matching returned "not found".
    // email_refresh_token is consumed only by refresh_email_token.js, which reads
    // D1 through the Worker's /api/ingest, so D1 is the right and only target.
    if (method === 'POST' && p === '/api/email-tokens') {
        const b = await body();
        if (!b.text || !String(b.text).trim()) return json({ error: 'no lines provided' }, 400);
        const lines = String(b.text).split('\n').map((l) => l.trim()).filter(Boolean);
        const parsed = [], invalid = [];
        for (const line of lines) {
            // refresh_token may itself contain '|', so app_id is the LAST field and
            // the token is everything between pass and app_id.
            const parts = line.split('|');
            const email = (parts[0] || '').trim();
            const pass = (parts[1] || '').trim();
            const app_id = parts.length >= 4 ? (parts[parts.length - 1] || '').trim() : '';
            const refresh_token = parts.length >= 4 ? parts.slice(2, -1).join('|').trim() : '';
            if (parts.length < 4 || !/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(email) || !refresh_token) { invalid.push(line.slice(0, 60)); continue; }
            parsed.push({ email, pass, refresh_token, app_id });
        }
        // One read to map email -> account (avoids a SELECT per line and D1's
        // 100-variable IN() cap); first row wins if an email repeats.
        const byEmail = new Map();
        for (const r of await rowsOf(env.DB.prepare("SELECT steam_id, account_name, lower(email) AS le FROM accounts WHERE email IS NOT NULL AND email != ''"))) {
            if (!byEmail.has(r.le)) byEmail.set(r.le, r);
        }
        const updated = [], notFound = [], stmts = [];
        for (const it of parsed) {
            const acc = byEmail.get(it.email.toLowerCase());
            if (!acc) { notFound.push(it.email); continue; }
            stmts.push(env.DB.prepare('UPDATE accounts SET email_password = ?, email_refresh_token = ?, email_client_id = ?, email_token_refreshed_at = unixepoch(), updated_at = unixepoch() WHERE steam_id = ?')
                .bind(it.pass || null, it.refresh_token, it.app_id || null, acc.steam_id));
            updated.push(acc.account_name || it.email);
        }
        for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50)); // D1 batch cap
        return json({ updated: updated.length, updated_names: updated, not_found: notFound, invalid });
    }
    if (method === 'POST' && p === '/api/email-tokens/refresh') return proxyToBox(req, env, url); // box calls Microsoft to rotate tokens
    if (method === 'POST' && p === '/api/wallets/refresh') return proxyToBox(req, env, url);
    // Cancel needs the box's live in-memory job (cooperative stop) — proxy it.
    if (method === 'POST' && /^\/api\/jobs\/[0-9a-f]{12}\/cancel$/.test(p)) return proxyToBox(req, env, url);
    // Job list + detail are read from the DB (persisted by the box), so history
    // survives a box restart and shows even if the box is briefly unreachable.
    // A missing `jobs` table means migrations aren't applied — say so, don't 500.
    const jobsTableHint = (e) => /no such table/i.test(e.message)
        ? json({ error: `the "jobs" table doesn't exist in the database — apply migrations: npm run migrate (${e.message})` }, 503)
        : json({ error: `jobs read failed: ${e.message}` }, 500);
    if (method === 'GET' && p === '/api/jobs') {
        try {
            const rows = await rowsOf(env.DB.prepare('SELECT summary FROM jobs ORDER BY created_at DESC LIMIT 100'));
            return json(rows.map((r) => { try { return JSON.parse(r.summary); } catch { return null; } }).filter(Boolean));
        } catch (e) { return jobsTableHint(e); }
    }
    m = /^\/api\/jobs\/([0-9a-f]{12})$/.exec(p);
    if (method === 'GET' && m) {
        let row;
        try { row = await env.DB.prepare('SELECT summary, lines FROM jobs WHERE id = ?').bind(m[1]).first(); }
        catch (e) { return jobsTableHint(e); }
        if (!row) return json({ error: `job ${m[1]} isn't in the database yet. The box records job state as it runs — this means the box hasn't persisted it (its code may be outdated, or it isn't connected to this same database). Check the box: pm2 logs steam` }, 404);
        let view = {};
        try { view = JSON.parse(row.summary); } catch { /* keep {} */ }
        view.lines = row.lines ? row.lines.split('\n') : [];
        return json(view);
    }
    // Anything else under /api/jobs/ (future box-only routes) still proxies.
    if (/^\/api\/jobs\//.test(p)) return proxyToBox(req, env, url);

    // --- gift API (the bot + CLI scripts call these) ---
    if (method === 'POST' && p === '/api/gift/candidates') {
        const b = await body();
        if (!b.account) return json({ error: 'account required' }, 400);
        const opts = { account: b.account, limit: Number(b.limit) > 0 ? Number(b.limit) : 10, gameName: b.gameName || null, game: b.game || {}, excludeNames: b.excludeNames || [], priorityNames: b.priorityNames || [] };
        return json(b.usesSentGifts ? await getGame2Friends(env, opts) : await getOldestFriendNames(env, opts));
    }
    if (method === 'POST' && p === '/api/gift/record-success') {
        const b = await body();
        if (!b.account || !b.friend_name) return json({ error: 'account and friend_name required' }, 400);
        if (b.usesSentGifts) {
            const sent = await recordGame2Gift(env, b.account, b.friend_name, b.friend_steam_id || null, b.item_name || null, b.subid || null, 'pending');
            const marked = await recordGift(env, b.account, b.friend_name, b.gifted_game || b.item_name || b.gameName);
            return json({ ok: true, sent_gifts_rows: sent, friends_rows: marked });
        }
        return json({ ok: true, sent_gifts_rows: 0, friends_rows: await recordGift(env, b.account, b.friend_name, b.gameName) });
    }
    if (method === 'POST' && p === '/api/gift/record-failure') {
        const b = await body();
        if (!b.account || !b.friend_name) return json({ error: 'account and friend_name required' }, 400);
        if (b.usesSentGifts) {
            const status = `FAILED: ${b.reason || 'unknown'}`.slice(0, 200);
            return json({ ok: true, rows: await recordGame2Gift(env, b.account, b.friend_name, b.friend_steam_id || null, b.item_name || null, b.subid || null, status) });
        }
        const label = `FAILED: ${b.reason || 'unknown'}`.slice(0, 200);
        const rows = (await env.DB.prepare('UPDATE friends SET gifted_at = -1, gifted_game = ? WHERE account_steam_id = (SELECT steam_id FROM accounts WHERE account_name = ?) AND friend_name = ?').bind(label, b.account, b.friend_name).run()).meta.changes;
        return json({ ok: true, rows });
    }

    if (method === 'GET' && p === '/api/gifted') {
        const start = Number(url.searchParams.get('start'));
        const end = Number(url.searchParams.get('end'));
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return json({ error: 'start and end (unix epoch seconds) required, end > start' }, 400);
        const sent = await rowsOf(env.DB.prepare("SELECT DISTINCT recipient_name AS friend_name, item_name AS game FROM sent_gifts WHERE created_at >= ? AND created_at < ? AND (status IS NULL OR status NOT LIKE 'FAILED%') AND recipient_name IS NOT NULL AND trim(recipient_name) <> ''").bind(start, end));
        const gifted = await rowsOf(env.DB.prepare("SELECT DISTINCT friend_name, gifted_game AS game FROM friends WHERE gifted_at >= ? AND gifted_at < ? AND friend_name IS NOT NULL AND trim(friend_name) <> ''").bind(start, end));
        return json({ sent, gifted });
    }

    // Mark a friend (by 17-digit SteamID64, else by name) as gifted across every
    // account, setting gifted_at + gifted_game. Replaces mark_gifted.js's direct
    // DB access so the script needs no database, only this API.
    if (method === 'POST' && p === '/api/friends/mark-gifted') {
        const b = await body();
        const friend = String(b.friend || '').trim();
        const games = Array.isArray(b.games) ? b.games.filter(Boolean) : (b.game ? [String(b.game)] : []);
        const ts = Number(b.ts);
        if (!friend || !games.length || !Number.isFinite(ts)) return json({ error: 'friend, games[] and ts required' }, 400);
        const canonical = games[0];
        const bySteam = /^7656119\d{10}$/.test(friend);
        const rows = await rowsOf(env.DB.prepare(
            `SELECT account_steam_id, friend_steam_id, friend_name, gifted_at, gifted_game FROM friends WHERE ${bySteam ? 'friend_steam_id = ?' : 'lower(friend_name) = lower(?)'}`).bind(friend));
        const gameSet = new Set(games);
        let updated = 0, alreadyMarked = 0;
        const stmts = [], results = [];
        for (const r of rows) {
            if (r.gifted_at === ts && gameSet.has(r.gifted_game)) { alreadyMarked++; results.push({ account_steam_id: r.account_steam_id, friend_name: r.friend_name, gifted_at: r.gifted_at, gifted_game: r.gifted_game, status: 'already-marked' }); continue; }
            stmts.push(env.DB.prepare('UPDATE friends SET gifted_at = ?, gifted_game = ?, updated_at = unixepoch() WHERE account_steam_id = ? AND friend_steam_id = ?').bind(ts, canonical, r.account_steam_id, r.friend_steam_id));
            updated++;
            results.push({ account_steam_id: r.account_steam_id, friend_name: r.friend_name, gifted_at: r.gifted_at, gifted_game: r.gifted_game, status: 'updated', new_gifted_at: ts, new_gifted_game: canonical });
        }
        for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
        return json({ lookup: bySteam ? 'steamid' : 'name', matched: rows.length, updated, alreadyMarked, rows: results, names: [...new Set(rows.map((r) => r.friend_name).filter(Boolean))] });
    }

    if (method === 'POST' && p === '/api/friends/country') {
        const b = await body();
        const updates = Array.isArray(b.updates) ? b.updates : [];
        if (updates.length === 0) return json({ error: 'updates[] required' }, 400);

        // Read/write in BULK, not one query per update: over Turso each query is a
        // Worker subrequest, and Workers cap subrequests — a per-row loop 500s on a
        // large file. Name matches stay case-insensitive (keyed by lowercase, with
        // the original preserved for reporting).
        const nameWant = new Map();  // lowerName -> { country, key }
        const steamWant = new Map(); // steamid   -> { country, key }
        for (const u of updates) {
            const country = String(u.country || '').trim();
            const key = String(u.key || '');
            if (!country || !key) continue;
            if (u.matchBy === 'steamid') steamWant.set(key, { country, key });
            else nameWant.set(key.toLowerCase(), { country, key });
        }

        // Turso has no bound-param cap (large IN chunks -> few round trips); D1 caps
        // at 100/query. Either way this is a handful of subrequests, not N.
        const CH = env.TURSO_DATABASE_URL ? 450 : 90;
        const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
        const selectIn = async (col, keys, lower) => {
            const out = [];
            for (const c of chunk(keys, CH)) {
                out.push(...await rowsOf(env.DB.prepare(
                    `SELECT account_steam_id, friend_steam_id, friend_name, country FROM friends WHERE ${lower ? `lower(${col})` : col} IN (${c.map(() => '?').join(',')})`).bind(...c)));
            }
            return out;
        };
        const nameRows = nameWant.size ? await selectIn('friend_name', [...nameWant.keys()], true) : [];
        const steamRows = steamWant.size ? await selectIn('friend_steam_id', [...steamWant.keys()], false) : [];

        let willChange = 0, alreadyCorrect = 0;
        const unmatched = [], changes = [];
        const report = (rows, keyOf, want, matchBy) => {
            const grouped = new Map();
            for (const r of rows) { const k = keyOf(r); if (!grouped.has(k)) grouped.set(k, []); grouped.get(k).push(r); }
            for (const [k, { country, key }] of want) {
                const rs = grouped.get(k) || [];
                if (!rs.length) { unmatched.push({ matchBy, key }); continue; }
                const rc = rs.map((r) => ({ friend_name: r.friend_name, account_steam_id: r.account_steam_id, current: r.country, new: country, will_change: r.country !== country }));
                willChange += rc.filter((r) => r.will_change).length;
                alreadyCorrect += rc.filter((r) => !r.will_change).length;
                changes.push({ matchBy, key, country, rows: rc });
            }
        };
        report(nameRows, (r) => String(r.friend_name || '').toLowerCase(), nameWant, 'name');
        report(steamRows, (r) => r.friend_steam_id, steamWant, 'steamid');

        let totalChanges = 0;
        if (b.commit) {
            const stmts = [];
            for (const [k, { country }] of nameWant) stmts.push(env.DB.prepare('UPDATE friends SET country = ?, updated_at = unixepoch() WHERE lower(friend_name) = ?').bind(country, k));
            for (const [k, { country }] of steamWant) stmts.push(env.DB.prepare('UPDATE friends SET country = ?, updated_at = unixepoch() WHERE friend_steam_id = ?').bind(country, k));
            for (const c of chunk(stmts, 500)) {
                const res = await env.DB.batch(c);
                totalChanges += res.reduce((s, r) => s + Number(r?.rowsAffected ?? r?.meta?.changes ?? 0), 0);
            }
        }
        return json({ willChange, alreadyCorrect, unmatched, changes, committed: !!b.commit, totalChanges });
    }

    return json({ error: `no route for ${method} ${p}` }, 404);
}

export default {
    async fetch(req, env, ctx) {
        // Route DB access to Turso (libSQL) when configured; otherwise the D1 binding.
        if (env.TURSO_DATABASE_URL) env.DB = tursoDB(env);
        const url = new URL(req.url);
        const authRes = checkAuth(req, url, env);
        if (authRes) return authRes;
        if (url.pathname.startsWith('/api/')) {
            try { return maybeSetCookie(req, url, env, await handleApi(req, env, url, ctx)); }
            catch (err) { return json({ error: err.message }, 500); }
        }
        return env.ASSETS.fetch(req);
    },
};
