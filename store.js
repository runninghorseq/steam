// Unified async data layer for the box's Steam-login job workers.
//
//   - If CF_* env is set (CF_ACCOUNT_ID / CF_D1_DATABASE_ID / CF_API_TOKEN),
//     everything reads/writes Cloudflare D1 directly — the box touches NO local
//     database, and the dashboard (also on D1) stays consistent.
//   - Otherwise it delegates to the local better-sqlite3 db.js, so local dev and
//     the CLI keep working exactly as before.
//
// All functions are async; callers must await. The D1 SQL mirrors db.js's
// upserts (COALESCE where db.js preserves fields like friends.gifted_at, so a
// scan never wipes gift history).

const local = require('./db');
const d1n = require('./cf/d1_node');
const parseGiftedAt = local.parseGiftedAt;

const USE_D1 = d1n.enabled();
const now = () => Math.floor(Date.now() / 1000);

// Chunk helper so multi-row INSERTs stay under D1's bound-param cap (~900).
function chunk(rows, colsLen) {
    const per = Math.max(1, Math.floor(900 / colsLen));
    const out = [];
    for (let i = 0; i < rows.length; i += per) out.push(rows.slice(i, i + per));
    return out;
}

// --- tokens -----------------------------------------------------------------

async function getRefreshToken(accountName) {
    if (!USE_D1) return local.getRefreshToken(accountName);
    const r = await d1n.d1first('SELECT refresh_token FROM auth_tokens WHERE account_name = ?', [accountName]);
    return r ? r.refresh_token : null;
}
async function saveRefreshToken(accountName, token) {
    if (!USE_D1) return local.saveRefreshToken(accountName, token);
    const ts = now();
    await d1n.d1run(
        'INSERT INTO auth_tokens (account_name, refresh_token, created_at, updated_at) VALUES (?, ?, ?, ?) '
        + 'ON CONFLICT(account_name) DO UPDATE SET refresh_token = excluded.refresh_token, updated_at = excluded.updated_at',
        [accountName, token, ts, ts]);
}
async function clearRefreshToken(accountName) {
    if (!USE_D1) return local.clearRefreshToken(accountName);
    await d1n.d1run('DELETE FROM auth_tokens WHERE account_name = ?', [accountName]);
}

// --- accounts ---------------------------------------------------------------

async function saveAccount(partial) {
    if (!USE_D1) return local.saveAccount(partial);
    const p = { ...partial };
    // Loan freeze: a loaned account's wallet/level are the borrower's — don't
    // overwrite. Only need the check when those fields are actually present.
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
    if (!USE_D1) return local.saveFriends(accountSteamID, friends);
    if (!friends.length) return;
    const ts = now();
    const cols = ['account_steam_id', 'friend_steam_id', 'friend_name', 'friend_level', 'added_at', 'relationship', 'created_at', 'updated_at'];
    const rows = friends.map((f) => ([accountSteamID, f.steam_id, f.name ?? null, f.level ?? null, f.added_at ?? null, f.relationship ?? null, ts, ts]));
    const tuple = `(${cols.map(() => '?').join(', ')})`;
    for (const c of chunk(rows, cols.length)) {
        const sql = `INSERT INTO friends (${cols.join(', ')}) VALUES ${c.map(() => tuple).join(', ')} `
            + 'ON CONFLICT(account_steam_id, friend_steam_id) DO UPDATE SET '
            + '  friend_name = COALESCE(excluded.friend_name, friends.friend_name),'
            + '  friend_level = COALESCE(excluded.friend_level, friends.friend_level),'
            + '  added_at = COALESCE(excluded.added_at, friends.added_at),'
            + '  relationship = COALESCE(excluded.relationship, friends.relationship),'
            + '  updated_at = excluded.updated_at';
        await d1n.d1run(sql, c.flat());
    }
}

// --- licenses (+ apps): replace this account's set --------------------------

async function saveLicenses(accountSteamID, licenses) {
    if (!USE_D1) return local.saveLicenses(accountSteamID, licenses);
    const ts = now();
    await d1n.d1run('DELETE FROM license_apps WHERE account_steam_id = ?', [accountSteamID]);
    await d1n.d1run('DELETE FROM licenses WHERE account_steam_id = ?', [accountSteamID]);
    const licRows = licenses.map((l) => [accountSteamID, l.package_id, l.package_name ?? null, l.payment_method ?? null, l.license_type ?? null, l.purchased_at ?? null, l.territory_code ?? null, ts, ts]);
    const licCols = ['account_steam_id', 'package_id', 'package_name', 'payment_method', 'license_type', 'purchased_at', 'territory_code', 'created_at', 'updated_at'];
    if (licRows.length) {
        const t = `(${licCols.map(() => '?').join(', ')})`;
        for (const c of chunk(licRows, licCols.length)) await d1n.d1run(`INSERT OR REPLACE INTO licenses (${licCols.join(', ')}) VALUES ${c.map(() => t).join(', ')}`, c.flat());
    }
    const appRows = [];
    for (const l of licenses) for (const a of (l.apps || [])) appRows.push([accountSteamID, l.package_id, a.app_id, a.app_name ?? null, ts, ts]);
    const appCols = ['account_steam_id', 'package_id', 'app_id', 'app_name', 'created_at', 'updated_at'];
    if (appRows.length) {
        const t = `(${appCols.map(() => '?').join(', ')})`;
        for (const c of chunk(appRows, appCols.length)) await d1n.d1run(`INSERT OR REPLACE INTO license_apps (${appCols.join(', ')}) VALUES ${c.map(() => t).join(', ')}`, c.flat());
    }
}

// --- pending gifts: replace, and stamp the friend's gifted_at ---------------

async function saveGifts(accountSteamID, gifts) {
    if (!USE_D1) return local.saveGifts(accountSteamID, gifts);
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
    if (!USE_D1) return local.saveSentGifts(accountSteamID, gifts);
    const ts = now();
    await d1n.d1run('DELETE FROM sent_gifts WHERE account_steam_id = ?', [accountSteamID]);
    for (const g of gifts) {
        await d1n.d1run(
            'INSERT OR REPLACE INTO sent_gifts (gift_id, account_steam_id, recipient_steam_id, recipient_name, item_name, detail, sent_at, status, store_url, scanned_at, created_at, updated_at) '
            + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [g.gift_id, accountSteamID, g.recipient_steam_id ?? null, g.recipient_name ?? null, g.item_name ?? null, g.detail ?? null, parseGiftedAt(g.sent_at), g.status ?? null, g.store_url ?? null, ts, ts, ts]);
    }
}

// reconcile for the sent-gift sync: prune gift_ids no longer live, upsert live.
async function reconcileSentGifts(accountSteamID, liveGifts) {
    if (!USE_D1) {
        const ts = now();
        const live = new Set(liveGifts.map((g) => g.gift_id));
        const existing = local.db.prepare('SELECT gift_id FROM sent_gifts WHERE account_steam_id = ?').all(accountSteamID).map((r) => r.gift_id);
        const deleted = existing.filter((id) => !live.has(id));
        const del = local.db.prepare('DELETE FROM sent_gifts WHERE account_steam_id = ? AND gift_id = ?');
        const up = local.db.prepare(
            'INSERT OR REPLACE INTO sent_gifts (gift_id, account_steam_id, recipient_steam_id, recipient_name, item_name, detail, sent_at, status, store_url, scanned_at, created_at, updated_at) '
            + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        local.db.transaction(() => {
            for (const id of deleted) del.run(accountSteamID, id);
            for (const g of liveGifts) up.run(g.gift_id, accountSteamID, g.recipient_steam_id ?? null, g.recipient_name ?? null, g.item_name ?? null, g.detail ?? null, parseGiftedAt(g.sent_at), g.status ?? null, g.store_url ?? null, ts, ts, ts);
        })();
        return { kept: liveGifts.length, deleted };
    }
    const ts = now();
    const live = new Set(liveGifts.map((g) => g.gift_id));
    const existing = (await d1n.d1all('SELECT gift_id FROM sent_gifts WHERE account_steam_id = ?', [accountSteamID])).map((r) => r.gift_id);
    const deleted = existing.filter((id) => !live.has(id));
    for (const id of deleted) await d1n.d1run('DELETE FROM sent_gifts WHERE account_steam_id = ? AND gift_id = ?', [accountSteamID, id]);
    for (const g of liveGifts) {
        await d1n.d1run(
            'INSERT OR REPLACE INTO sent_gifts (gift_id, account_steam_id, recipient_steam_id, recipient_name, item_name, detail, sent_at, status, store_url, scanned_at, created_at, updated_at) '
            + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [g.gift_id, accountSteamID, g.recipient_steam_id ?? null, g.recipient_name ?? null, g.item_name ?? null, g.detail ?? null, parseGiftedAt(g.sent_at), g.status ?? null, g.store_url ?? null, ts, ts, ts]);
    }
    return { kept: liveGifts.length, deleted };
}

// Delete specific friend rows for an account (used after remove-friends).
async function removeFriendRows(accountSteamID, friendSteamIDs) {
    if (!friendSteamIDs.length) return;
    if (!USE_D1) {
        const del = local.db.prepare('DELETE FROM friends WHERE account_steam_id = ? AND friend_steam_id = ?');
        local.db.transaction(() => { for (const id of friendSteamIDs) del.run(accountSteamID, id); })();
        return;
    }
    for (const id of friendSteamIDs) await d1n.d1run('DELETE FROM friends WHERE account_steam_id = ? AND friend_steam_id = ?', [accountSteamID, id]);
}

// --- small reads the job endpoints need -------------------------------------

async function accountNameBySteamID(steamID) {
    if (!USE_D1) { const r = local.db.prepare('SELECT account_name FROM accounts WHERE steam_id = ?').get(steamID); return r ? r.account_name : null; }
    const r = await d1n.d1first('SELECT account_name FROM accounts WHERE steam_id = ?', [steamID]);
    return r ? r.account_name : null;
}
async function accountBySteamID(steamID) {
    if (!USE_D1) return local.db.prepare('SELECT steam_id, account_name FROM accounts WHERE steam_id = ?').get(steamID) || null;
    return d1n.d1first('SELECT steam_id, account_name FROM accounts WHERE steam_id = ?', [steamID]);
}
async function accountByName(name) {
    if (!USE_D1) return local.db.prepare('SELECT steam_id, account_name FROM accounts WHERE lower(account_name) = lower(?)').get(name) || null;
    return d1n.d1first('SELECT steam_id, account_name FROM accounts WHERE lower(account_name) = lower(?)', [name]);
}

// The friend_steam_ids already recorded for an account (used to count new adds).
async function friendSteamIDs(accountSteamID) {
    if (!USE_D1) return local.db.prepare('SELECT friend_steam_id FROM friends WHERE account_steam_id = ?').all(accountSteamID).map((r) => r.friend_steam_id);
    const rows = await d1n.d1all('SELECT friend_steam_id FROM friends WHERE account_steam_id = ?', [accountSteamID]);
    return rows.map((r) => r.friend_steam_id);
}

// Selection for the bulk wallet refresh (mirrors update_wallet_level.js CLI):
// every tokened account name, plus the sets to exclude (skip_wallet, loaned).
async function walletRefreshSelection() {
    if (!USE_D1) {
        return {
            tokened: local.db.prepare('SELECT account_name AS username FROM auth_tokens ORDER BY account_name').all(),
            skip: local.db.prepare("SELECT account_name FROM accounts WHERE skip_wallet = 1 AND account_name IS NOT NULL").all(),
            lent: local.db.prepare("SELECT account_name FROM accounts WHERE loan_id IS NOT NULL AND account_name IS NOT NULL").all(),
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
    USE_D1,
    getRefreshToken, saveRefreshToken, clearRefreshToken,
    saveAccount, saveFriends, saveLicenses, saveGifts, saveSentGifts, reconcileSentGifts,
    accountNameBySteamID, accountBySteamID, accountByName, removeFriendRows,
    walletRefreshSelection, friendSteamIDs,
    parseGiftedAt,
};
