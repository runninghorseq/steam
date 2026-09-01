// Unified async data layer for the box's Steam-login job workers. Three modes,
// chosen by environment (checked in this order):
//
//   1. WORKER mode — WORKER_URL set: the box owns NO data. Every read/write is a
//      POST to the Worker's /api/ingest endpoint (auth: DASHBOARD_TOKEN), and the
//      Worker is the single writer to D1. The box needs no DB and no CF creds.
//   2. D1-direct mode — CF_* set: the box writes Cloudflare D1 itself over the
//      REST API (cf/d1_node.js). Kept for flexibility; not used by a stateless box.
//   3. Local mode — neither set: delegates to the local better-sqlite3 db.js, so
//      local dev and the CLIs keep working exactly as before.
//
// All functions are async; callers must await.

const parseGiftedAt = require('./parse_gifted_at');
const d1n = require('./cf/d1_node');

// db.js opens a SQLite file on require, so only load it in local mode — a
// stateless (WORKER) box must never touch a local database.
let _local = null;
const L = () => (_local || (_local = require('./db')));

const WORKER_URL = (process.env.WORKER_URL || '').trim().replace(/\/+$/, '');
const WORKER_TOKEN = (process.env.DASHBOARD_TOKEN || process.env.STEAM_API_TOKEN || '').trim();
const USE_WORKER = !!WORKER_URL;
const USE_D1 = !USE_WORKER && d1n.enabled();

const now = () => Math.floor(Date.now() / 1000);
// D1 caps bound parameters at 100 PER query (not SQLite's ~999), so size each
// multi-row INSERT to stay safely under that. e.g. 8-col friends -> 11 rows/stmt.
function chunk(rows, colsLen) {
    const per = Math.max(1, Math.floor(90 / colsLen));
    const out = [];
    for (let i = 0; i < rows.length; i += per) out.push(rows.slice(i, i + per));
    return out;
}

// --- WORKER mode transport --------------------------------------------------
// One generic endpoint takes {op, ...args} and returns {result}. Keeping it to a
// single call site means the box side of every function is one line.
async function wcall(op, args = {}) {
    const headers = {
        'Content-Type': 'application/json',
        // Cloudflare fronts the domain and blocks non-browser signatures.
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    };
    if (WORKER_TOKEN) headers['X-Dashboard-Token'] = WORKER_TOKEN;
    let res;
    try {
        res = await fetch(`${WORKER_URL}/api/ingest`, { method: 'POST', headers, body: JSON.stringify({ op, ...args }) });
    } catch (e) {
        throw new Error(`ingest ${op}: Worker unreachable at ${WORKER_URL} (${e.message})`);
    }
    if (res.status === 401) throw new Error(`ingest ${op}: 401 unauthorized — set DASHBOARD_TOKEN to match the Worker`);
    if (!res.ok) throw new Error(`ingest ${op} -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const j = await res.json().catch(() => ({}));
    return j.result;
}

// --- tokens -----------------------------------------------------------------

async function getRefreshToken(accountName) {
    if (USE_WORKER) return wcall('getRefreshToken', { accountName });
    if (!USE_D1) return L().getRefreshToken(accountName);
    const r = await d1n.d1first('SELECT refresh_token FROM auth_tokens WHERE account_name = ?', [accountName]);
    return r ? r.refresh_token : null;
}
async function saveRefreshToken(accountName, token) {
    if (USE_WORKER) return wcall('saveRefreshToken', { accountName, token });
    if (!USE_D1) return L().saveRefreshToken(accountName, token);
    const ts = now();
    await d1n.d1run(
        'INSERT INTO auth_tokens (account_name, refresh_token, created_at, updated_at) VALUES (?, ?, ?, ?) '
        + 'ON CONFLICT(account_name) DO UPDATE SET refresh_token = excluded.refresh_token, updated_at = excluded.updated_at',
        [accountName, token, ts, ts]);
}
async function clearRefreshToken(accountName) {
    if (USE_WORKER) return wcall('clearRefreshToken', { accountName });
    if (!USE_D1) return L().clearRefreshToken(accountName);
    await d1n.d1run('DELETE FROM auth_tokens WHERE account_name = ?', [accountName]);
}

// --- accounts ---------------------------------------------------------------

async function saveAccount(partial) {
    if (USE_WORKER) return wcall('saveAccount', { partial });
    if (!USE_D1) return L().saveAccount(partial);
    const p = { ...partial };
    // Loan freeze: a loaned account's wallet/level are the borrower's — don't overwrite.
    if (p.wallet_currency != null || p.wallet_balance_cents != null || p.steam_level != null) {
        const row = await d1n.d1first('SELECT loan_id FROM accounts WHERE steam_id = ?', [p.steam_id]);
        if (row && row.loan_id != null) { p.wallet_currency = null; p.wallet_balance_cents = null; p.steam_level = null; }
    }
    const ts = now();
    await d1n.d1run(
        'INSERT INTO accounts (steam_id, account_name, persona, country, email, wallet_currency, wallet_balance_cents, steam_level, steam_points, source, scanned_at, created_at, updated_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(steam_id) DO UPDATE SET '
        + '  account_name = COALESCE(excluded.account_name, accounts.account_name),'
        + '  persona = COALESCE(excluded.persona, accounts.persona),'
        + '  country = COALESCE(excluded.country, accounts.country),'
        + '  email = COALESCE(excluded.email, accounts.email),'
        + '  wallet_currency = COALESCE(excluded.wallet_currency, accounts.wallet_currency),'
        + '  wallet_balance_cents = COALESCE(excluded.wallet_balance_cents, accounts.wallet_balance_cents),'
        + '  steam_level = COALESCE(excluded.steam_level, accounts.steam_level),'
        + '  steam_points = COALESCE(excluded.steam_points, accounts.steam_points),'
        + '  source = COALESCE(excluded.source, accounts.source),'
        + '  scanned_at = excluded.scanned_at, updated_at = excluded.updated_at',
        [p.steam_id, p.account_name ?? null, p.persona ?? null, p.country ?? null, p.email ?? null,
         p.wallet_currency ?? null, p.wallet_balance_cents ?? null, p.steam_level ?? null, p.steam_points ?? null,
         p.source ?? null, ts, ts, ts]);
}

// --- friends (COALESCE upsert — preserves gifted_at/gifted_game/country) ------

async function saveFriends(accountSteamID, friends) {
    if (USE_WORKER) return wcall('saveFriends', { accountSteamID, friends });
    if (!USE_D1) return L().saveFriends(accountSteamID, friends);
    if (!friends.length) return;
    const ts = now();
    const cols = ['account_steam_id', 'friend_steam_id', 'friend_name', 'friend_level', 'added_at', 'relationship', 'created_at', 'updated_at'];
    const rows = friends.map((f) => ([accountSteamID, f.steam_id, f.name ?? null, f.level ?? null, f.added_at ?? null, f.relationship ?? null, ts, ts]));
    const tuple = `(${cols.map(() => '?').join(', ')})`;
    // Independent INSERT..ON CONFLICT rows — run the chunks concurrently to cut
    // the per-account wall-clock (a scan otherwise waits on ~18 serial POSTs).
    await Promise.all(chunk(rows, cols.length).map((c) => {
        const sql = `INSERT INTO friends (${cols.join(', ')}) VALUES ${c.map(() => tuple).join(', ')} `
            + 'ON CONFLICT(account_steam_id, friend_steam_id) DO UPDATE SET '
            + '  friend_name = COALESCE(excluded.friend_name, friends.friend_name),'
            + '  friend_level = COALESCE(excluded.friend_level, friends.friend_level),'
            + '  added_at = COALESCE(excluded.added_at, friends.added_at),'
            + '  relationship = COALESCE(excluded.relationship, friends.relationship),'
            + '  updated_at = excluded.updated_at';
        return d1n.d1run(sql, c.flat());
    }));
}

// --- licenses (+ apps): replace this account's set --------------------------

async function saveLicenses(accountSteamID, licenses) {
    if (USE_WORKER) return wcall('saveLicenses', { accountSteamID, licenses });
    if (!USE_D1) return L().saveLicenses(accountSteamID, licenses);
    const ts = now();
    // Deletes must land before the inserts; the insert chunks are independent.
    await Promise.all([
        d1n.d1run('DELETE FROM license_apps WHERE account_steam_id = ?', [accountSteamID]),
        d1n.d1run('DELETE FROM licenses WHERE account_steam_id = ?', [accountSteamID]),
    ]);
    const licRows = licenses.map((l) => [accountSteamID, l.package_id, l.package_name ?? null, l.payment_method ?? null, l.license_type ?? null, l.purchased_at ?? null, l.territory_code ?? null, ts, ts]);
    const licCols = ['account_steam_id', 'package_id', 'package_name', 'payment_method', 'license_type', 'purchased_at', 'territory_code', 'created_at', 'updated_at'];
    const appRows = [];
    for (const l of licenses) for (const a of (l.apps || [])) appRows.push([accountSteamID, l.package_id, a.app_id, a.app_name ?? null, ts, ts]);
    const appCols = ['account_steam_id', 'package_id', 'app_id', 'app_name', 'created_at', 'updated_at'];
    const licT = `(${licCols.map(() => '?').join(', ')})`;
    const appT = `(${appCols.map(() => '?').join(', ')})`;
    await Promise.all([
        ...chunk(licRows, licCols.length).map((c) => d1n.d1run(`INSERT OR REPLACE INTO licenses (${licCols.join(', ')}) VALUES ${c.map(() => licT).join(', ')}`, c.flat())),
        ...chunk(appRows, appCols.length).map((c) => d1n.d1run(`INSERT OR REPLACE INTO license_apps (${appCols.join(', ')}) VALUES ${c.map(() => appT).join(', ')}`, c.flat())),
    ]);
}

// --- game playtime: replace this account's snapshot -------------------------

async function saveGamePlaytime(accountSteamID, games) {
    if (USE_WORKER) return wcall('saveGamePlaytime', { accountSteamID, games });
    if (!USE_D1) return L().saveGamePlaytime(accountSteamID, games);
    const ts = now();
    await d1n.d1run('DELETE FROM game_playtime WHERE account_steam_id = ?', [accountSteamID]);
    const cols = ['account_steam_id', 'app_id', 'name', 'playtime_forever', 'playtime_2weeks', 'scanned_at', 'created_at', 'updated_at'];
    const rows = games.map((g) => [accountSteamID, g.app_id ?? g.appid, g.name ?? null, g.playtime_forever ?? 0, g.playtime_2weeks ?? 0, ts, ts, ts]);
    if (rows.length) {
        const t = `(${cols.map(() => '?').join(', ')})`;
        for (const c of chunk(rows, cols.length)) await d1n.d1run(`INSERT OR REPLACE INTO game_playtime (${cols.join(', ')}) VALUES ${c.map(() => t).join(', ')}`, c.flat());
    }
}

// --- pending gifts: replace, and stamp the friend's gifted_at ---------------

async function saveGifts(accountSteamID, gifts) {
    if (USE_WORKER) return wcall('saveGifts', { accountSteamID, gifts });
    if (!USE_D1) return L().saveGifts(accountSteamID, gifts);
    const ts = now();
    await d1n.d1run('DELETE FROM pending_gifts WHERE account_steam_id = ?', [accountSteamID]);
    for (const g of gifts) {
        await d1n.d1run(
            'INSERT OR REPLACE INTO pending_gifts (gift_id, account_steam_id, item_name, detail, sender_steam_id, sender_name, sent_at, status, store_url, scanned_at, created_at, updated_at) '
            + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [g.gift_id, accountSteamID, g.item_name ?? null, g.detail ?? null, g.sender_steam_id ?? null, g.sender_name ?? null, g.sent_at ?? null, g.status ?? null, g.store_url ?? null, ts, ts, ts]);
        if (g.sender_steam_id) {
            await d1n.d1run('UPDATE friends SET gifted_at = ?, gifted_game = ?, updated_at = ? WHERE account_steam_id = ? AND friend_steam_id = ?',
                [parseGiftedAt(g.sent_at), g.item_name ?? null, ts, accountSteamID, g.sender_steam_id]);
        }
    }
}

// --- sent gifts: replace this account's snapshot ----------------------------

async function saveSentGifts(accountSteamID, gifts) {
    if (USE_WORKER) return wcall('saveSentGifts', { accountSteamID, gifts });
    if (!USE_D1) return L().saveSentGifts(accountSteamID, gifts);
    const ts = now();
    await d1n.d1run('DELETE FROM sent_gifts WHERE account_steam_id = ?', [accountSteamID]);
    const cols = ['gift_id', 'account_steam_id', 'recipient_steam_id', 'recipient_name', 'item_name', 'detail', 'sent_at', 'status', 'store_url', 'scanned_at', 'created_at', 'updated_at'];
    const rows = gifts.map((g) => [g.gift_id, accountSteamID, g.recipient_steam_id ?? null, g.recipient_name ?? null, g.item_name ?? null, g.detail ?? null, parseGiftedAt(g.sent_at), g.status ?? null, g.store_url ?? null, ts, ts, ts]);
    const t = `(${cols.map(() => '?').join(', ')})`;
    await Promise.all(chunk(rows, cols.length).map((c) => d1n.d1run(`INSERT OR REPLACE INTO sent_gifts (${cols.join(', ')}) VALUES ${c.map(() => t).join(', ')}`, c.flat())));
}

// reconcile for the sent-gift sync: prune gift_ids no longer live, upsert live.
async function reconcileSentGifts(accountSteamID, liveGifts) {
    if (USE_WORKER) return wcall('reconcileSentGifts', { accountSteamID, liveGifts });
    if (!USE_D1) {
        const ts = now();
        const live = new Set(liveGifts.map((g) => g.gift_id));
        const existing = L().db.prepare('SELECT gift_id FROM sent_gifts WHERE account_steam_id = ?').all(accountSteamID).map((r) => r.gift_id);
        const deleted = existing.filter((id) => !live.has(id));
        const del = L().db.prepare('DELETE FROM sent_gifts WHERE account_steam_id = ? AND gift_id = ?');
        const up = L().db.prepare(
            'INSERT OR REPLACE INTO sent_gifts (gift_id, account_steam_id, recipient_steam_id, recipient_name, item_name, detail, sent_at, status, store_url, scanned_at, created_at, updated_at) '
            + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        L().db.transaction(() => {
            for (const id of deleted) del.run(accountSteamID, id);
            for (const g of liveGifts) up.run(g.gift_id, accountSteamID, g.recipient_steam_id ?? null, g.recipient_name ?? null, g.item_name ?? null, g.detail ?? null, parseGiftedAt(g.sent_at), g.status ?? null, g.store_url ?? null, ts, ts, ts);
        })();
        return { kept: liveGifts.length, deleted };
    }
    const ts = now();
    const live = new Set(liveGifts.map((g) => g.gift_id));
    const existing = (await d1n.d1all('SELECT gift_id FROM sent_gifts WHERE account_steam_id = ?', [accountSteamID])).map((r) => r.gift_id);
    const deleted = existing.filter((id) => !live.has(id));
    // Deleted ids and live ids are disjoint, so the prune and the upsert can run
    // concurrently. Batch the deletes into IN(...) chunks and the inserts multi-row.
    const cols = ['gift_id', 'account_steam_id', 'recipient_steam_id', 'recipient_name', 'item_name', 'detail', 'sent_at', 'status', 'store_url', 'scanned_at', 'created_at', 'updated_at'];
    const rows = liveGifts.map((g) => [g.gift_id, accountSteamID, g.recipient_steam_id ?? null, g.recipient_name ?? null, g.item_name ?? null, g.detail ?? null, parseGiftedAt(g.sent_at), g.status ?? null, g.store_url ?? null, ts, ts, ts]);
    const t = `(${cols.map(() => '?').join(', ')})`;
    await Promise.all([
        ...chunk(deleted, 1).map((ids) => d1n.d1run(`DELETE FROM sent_gifts WHERE account_steam_id = ? AND gift_id IN (${ids.map(() => '?').join(', ')})`, [accountSteamID, ...ids])),
        ...chunk(rows, cols.length).map((c) => d1n.d1run(`INSERT OR REPLACE INTO sent_gifts (${cols.join(', ')}) VALUES ${c.map(() => t).join(', ')}`, c.flat())),
    ]);
    return { kept: liveGifts.length, deleted };
}

// Delete specific friend rows for an account (used after remove-friends).
async function removeFriendRows(accountSteamID, friendSteamIDs) {
    if (USE_WORKER) return wcall('removeFriendRows', { accountSteamID, friendSteamIDs });
    if (!friendSteamIDs.length) return;
    if (!USE_D1) {
        const del = L().db.prepare('DELETE FROM friends WHERE account_steam_id = ? AND friend_steam_id = ?');
        L().db.transaction(() => { for (const id of friendSteamIDs) del.run(accountSteamID, id); })();
        return;
    }
    // Batch into IN(...) chunks (stay under D1's 100-param cap incl. the account id).
    await Promise.all(chunk(friendSteamIDs, 1).map((ids) =>
        d1n.d1run(`DELETE FROM friends WHERE account_steam_id = ? AND friend_steam_id IN (${ids.map(() => '?').join(', ')})`, [accountSteamID, ...ids])));
}

// --- small reads the job endpoints need -------------------------------------

async function accountNameBySteamID(steamID) {
    if (USE_WORKER) return wcall('accountNameBySteamID', { steamID });
    if (!USE_D1) { const r = L().db.prepare('SELECT account_name FROM accounts WHERE steam_id = ?').get(steamID); return r ? r.account_name : null; }
    const r = await d1n.d1first('SELECT account_name FROM accounts WHERE steam_id = ?', [steamID]);
    return r ? r.account_name : null;
}
async function accountBySteamID(steamID) {
    if (USE_WORKER) return wcall('accountBySteamID', { steamID });
    if (!USE_D1) return L().db.prepare('SELECT steam_id, account_name FROM accounts WHERE steam_id = ?').get(steamID) || null;
    return d1n.d1first('SELECT steam_id, account_name FROM accounts WHERE steam_id = ?', [steamID]);
}
async function accountByName(name) {
    if (USE_WORKER) return wcall('accountByName', { name });
    if (!USE_D1) return L().db.prepare('SELECT steam_id, account_name FROM accounts WHERE lower(account_name) = lower(?)').get(name) || null;
    return d1n.d1first('SELECT steam_id, account_name FROM accounts WHERE lower(account_name) = lower(?)', [name]);
}

// The friend_steam_ids already recorded for an account (used to count new adds).
async function friendSteamIDs(accountSteamID) {
    if (USE_WORKER) return wcall('friendSteamIDs', { accountSteamID });
    if (!USE_D1) return L().db.prepare('SELECT friend_steam_id FROM friends WHERE account_steam_id = ?').all(accountSteamID).map((r) => r.friend_steam_id);
    const rows = await d1n.d1all('SELECT friend_steam_id FROM friends WHERE account_steam_id = ?', [accountSteamID]);
    return rows.map((r) => r.friend_steam_id);
}

// Selection for the bulk wallet refresh (mirrors update_wallet_level.js CLI):
// every tokened account name, plus the sets to exclude (skip_wallet, loaned).
async function walletRefreshSelection() {
    if (USE_WORKER) return wcall('walletRefreshSelection', {});
    if (!USE_D1) {
        return {
            tokened: L().db.prepare('SELECT account_name AS username FROM auth_tokens ORDER BY account_name').all(),
            skip: L().db.prepare("SELECT account_name FROM accounts WHERE skip_wallet = 1 AND account_name IS NOT NULL").all(),
            lent: L().db.prepare("SELECT account_name FROM accounts WHERE loan_id IS NOT NULL AND account_name IS NOT NULL").all(),
        };
    }
    const [tokened, skip, lent] = await Promise.all([
        d1n.d1all('SELECT account_name AS username FROM auth_tokens ORDER BY account_name'),
        d1n.d1all("SELECT account_name FROM accounts WHERE skip_wallet = 1 AND account_name IS NOT NULL"),
        d1n.d1all("SELECT account_name FROM accounts WHERE loan_id IS NOT NULL AND account_name IS NOT NULL"),
    ]);
    return { tokened, skip, lent };
}

module.exports = {
    USE_D1, USE_WORKER,
    getRefreshToken, saveRefreshToken, clearRefreshToken,
    saveAccount, saveFriends, saveLicenses, saveGifts, saveSentGifts, saveGamePlaytime, reconcileSentGifts,
    accountNameBySteamID, accountBySteamID, accountByName, removeFriendRows,
    walletRefreshSelection, friendSteamIDs,
    parseGiftedAt,
};
