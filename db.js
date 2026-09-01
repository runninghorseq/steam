const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const mirror = require('./d1_mirror'); // D1 write-through (no-op unless configured)

const DB_PATH = path.join(__dirname, 'steam_accounts.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Stateless box: when WORKER_URL is set, all real data lives in the Worker/D1 and
// this process must keep NO local database file. Open an in-memory DB instead —
// it still satisfies the synchronous `db` handle that server.js and the CLIs
// expect, but nothing is persisted to disk (those local reads are unused in
// production, where the Worker serves them).
const STATELESS = !!(process.env.WORKER_URL || '').trim();
const db = new Database(STATELESS ? ':memory:' : DB_PATH);
if (!STATELESS) db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

// Lightweight migrations: add columns introduced after a DB was first created
// (CREATE TABLE IF NOT EXISTS won't add them to an existing table).
const accountCols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
if (!accountCols.includes('steam_points')) {
    db.exec('ALTER TABLE accounts ADD COLUMN steam_points INTEGER');
}
if (!accountCols.includes('loan_id')) {
    db.exec('ALTER TABLE accounts ADD COLUMN loan_id INTEGER');
}
if (!accountCols.includes('skip_wallet')) {
    db.exec('ALTER TABLE accounts ADD COLUMN skip_wallet INTEGER NOT NULL DEFAULT 0');
}
if (!accountCols.includes('source')) {
    db.exec('ALTER TABLE accounts ADD COLUMN source TEXT');
}

const upsertAccount = db.prepare(`
INSERT INTO accounts (steam_id, account_name, persona, country, email, wallet_currency, wallet_balance_cents, steam_level, steam_points, source, scanned_at, created_at, updated_at)
VALUES (@steam_id, @account_name, @persona, @country, @email, @wallet_currency, @wallet_balance_cents, @steam_level, @steam_points, @source, @scanned_at, @now, @now)
ON CONFLICT(steam_id) DO UPDATE SET
    account_name = COALESCE(excluded.account_name, accounts.account_name),
    persona = COALESCE(excluded.persona, accounts.persona),
    source = COALESCE(excluded.source, accounts.source),
    country = COALESCE(excluded.country, accounts.country),
    email = COALESCE(excluded.email, accounts.email),
    wallet_currency = COALESCE(excluded.wallet_currency, accounts.wallet_currency),
    wallet_balance_cents = COALESCE(excluded.wallet_balance_cents, accounts.wallet_balance_cents),
    steam_level = COALESCE(excluded.steam_level, accounts.steam_level),
    steam_points = COALESCE(excluded.steam_points, accounts.steam_points),
    scanned_at = excluded.scanned_at,
    updated_at = excluded.updated_at
`);

const upsertFriend = db.prepare(`
INSERT INTO friends (account_steam_id, friend_steam_id, friend_name, friend_level, added_at, relationship, created_at, updated_at)
VALUES (@account_steam_id, @friend_steam_id, @friend_name, @friend_level, @added_at, @relationship, @now, @now)
ON CONFLICT(account_steam_id, friend_steam_id) DO UPDATE SET
    friend_name = COALESCE(excluded.friend_name, friends.friend_name),
    friend_level = COALESCE(excluded.friend_level, friends.friend_level),
    added_at = COALESCE(excluded.added_at, friends.added_at),
    relationship = COALESCE(excluded.relationship, friends.relationship),
    updated_at = excluded.updated_at
`);

const deleteLicenses = db.prepare('DELETE FROM licenses WHERE account_steam_id = ?');
const deleteLicenseApps = db.prepare('DELETE FROM license_apps WHERE account_steam_id = ?');
const upsertLicense = db.prepare(`
INSERT INTO licenses (account_steam_id, package_id, package_name, payment_method, license_type, purchased_at, territory_code, created_at, updated_at)
VALUES (@account_steam_id, @package_id, @package_name, @payment_method, @license_type, @purchased_at, @territory_code, @now, @now)
ON CONFLICT(account_steam_id, package_id) DO UPDATE SET
    package_name = excluded.package_name,
    payment_method = excluded.payment_method,
    license_type = excluded.license_type,
    purchased_at = excluded.purchased_at,
    territory_code = excluded.territory_code,
    updated_at = excluded.updated_at
`);
const upsertLicenseApp = db.prepare(`
INSERT INTO license_apps (account_steam_id, package_id, app_id, app_name, created_at, updated_at)
VALUES (@account_steam_id, @package_id, @app_id, @app_name, @now, @now)
ON CONFLICT(account_steam_id, package_id, app_id) DO UPDATE SET
    app_name = excluded.app_name,
    updated_at = excluded.updated_at
`);
const deleteLicenseByID = db.prepare('DELETE FROM licenses WHERE account_steam_id = ? AND package_id = ?');
const deleteLicenseAppByID = db.prepare('DELETE FROM license_apps WHERE account_steam_id = ? AND package_id = ?');
const listLicensePkgs = db.prepare('SELECT package_id FROM licenses WHERE account_steam_id = ?');

const deleteGifts = db.prepare('DELETE FROM pending_gifts WHERE account_steam_id = ?');
const insertGift = db.prepare(`
INSERT INTO pending_gifts (gift_id, account_steam_id, item_name, detail, sender_steam_id, sender_name, sent_at, status, store_url, scanned_at, created_at, updated_at)
VALUES (@gift_id, @account_steam_id, @item_name, @detail, @sender_steam_id, @sender_name, @sent_at, @status, @store_url, @scanned_at, @now, @now)
ON CONFLICT(gift_id) DO UPDATE SET
    item_name = excluded.item_name,
    detail = excluded.detail,
    sender_steam_id = excluded.sender_steam_id,
    sender_name = excluded.sender_name,
    sent_at = excluded.sent_at,
    status = excluded.status,
    store_url = excluded.store_url,
    scanned_at = excluded.scanned_at,
    updated_at = excluded.updated_at
`);

// Stamp the gift's sender on the friends row (denormalized snapshot of latest gift)
const updateFriendGift = db.prepare(`
UPDATE friends
SET gifted_at = ?, gifted_game = ?, updated_at = unixepoch()
WHERE account_steam_id = ? AND friend_steam_id = ?
`);

// Parse the Steam-page sent_at string (e.g. "26 May") to a unix epoch.
// Steam omits the year, so we assume the current calendar year. Returns null on parse failure.
function parseGiftedAt(sentAt) {
    if (!sentAt) return null;
    const d = new Date(`${sentAt} ${new Date().getFullYear()}`);
    return Number.isFinite(d.getTime()) ? Math.floor(d.getTime() / 1000) : null;
}

const now = () => Math.floor(Date.now() / 1000);

// One-time migration: sent_gifts.sent_at used to hold Steam's human string
// ("7 Jun") in a TEXT column; it now holds a unix epoch in an INTEGER column.
// Two steps, both idempotent and safe to run every startup:
//   1. Parse any value that still has letters ("13 Aug") into an epoch integer.
//   2. If the column is still TEXT-affinity, rebuild the table as INTEGER so
//      values store as real integers (a TEXT-affinity column coerces every
//      number to text, which is what we're fixing).
{
    const letterRows = db.prepare("SELECT gift_id, sent_at FROM sent_gifts WHERE sent_at IS NOT NULL AND sent_at GLOB '*[A-Za-z]*'").all();
    if (letterRows.length) {
        const upd = db.prepare('UPDATE sent_gifts SET sent_at = ? WHERE gift_id = ?');
        db.transaction(() => { for (const r of letterRows) upd.run(parseGiftedAt(r.sent_at), r.gift_id); })();
    }

    const sentAtCol = db.prepare('PRAGMA table_info(sent_gifts)').all().find((c) => c.name === 'sent_at');
    if (sentAtCol && /TEXT/i.test(sentAtCol.type)) {
        db.transaction(() => db.exec(`
            CREATE TABLE sent_gifts__new (
                gift_id             TEXT PRIMARY KEY,
                account_steam_id    TEXT,
                recipient_steam_id  TEXT,
                recipient_name      TEXT,
                item_name           TEXT,
                detail              TEXT,
                sent_at             INTEGER,
                status              TEXT,
                store_url           TEXT,
                scanned_at          INTEGER,
                created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
                updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
            );
            INSERT INTO sent_gifts__new
                SELECT gift_id, account_steam_id, recipient_steam_id, recipient_name, item_name,
                       detail, CAST(ROUND(sent_at) AS INTEGER), status, store_url, scanned_at,
                       created_at, updated_at
                FROM sent_gifts;
            DROP TABLE sent_gifts;
            ALTER TABLE sent_gifts__new RENAME TO sent_gifts;
        `))();
    }
}

// Accounts linked to a loan (accounts.loan_id) have been handed to someone else,
// so their wallet balance and Steam level are whatever the borrower left behind.
// Those three columns are frozen for them: every writer goes through saveAccount,
// so blocking it here covers update_wallet_level.js, single.js, multi_scan.js and
// anything added later, instead of relying on each caller to remember.
const getAccountLoanID = db.prepare('SELECT loan_id FROM accounts WHERE steam_id = ?');
const setAccountLoanID = db.prepare('UPDATE accounts SET loan_id = ?, updated_at = unixepoch() WHERE steam_id = ?');

function isLoanedAccount(steamID) {
    const row = getAccountLoanID.get(steamID);
    return !!(row && row.loan_id != null);
}

// Link an account to a loan (or pass null to unlink it and unfreeze the columns).
function setAccountLoan(steamID, loanID) {
    const changes = setAccountLoanID.run(loanID ?? null, steamID).changes;
    if (mirror.active && changes) mirror.upsert('accounts', db.prepare('SELECT * FROM accounts WHERE steam_id = ?').get(steamID));
    return changes;
}

function saveAccount(partial) {
    const ts = now();
    // COALESCE in the upsert keeps the stored value when a field comes in as null,
    // so nulling these is exactly "leave what is already there alone".
    if (isLoanedAccount(partial.steam_id)) {
        const frozen = ['wallet_currency', 'wallet_balance_cents', 'steam_level'].filter(
            (k) => partial[k] != null
        );
        if (frozen.length) {
            partial = { ...partial };
            frozen.forEach((k) => { partial[k] = null; });
            console.log(
                `[db] ${partial.account_name || partial.steam_id}: loaned account — ` +
                `not updating ${frozen.join(', ')}`
            );
        }
    }
    upsertAccount.run({
        steam_id: partial.steam_id,
        account_name: partial.account_name ?? null,
        persona: partial.persona ?? null,
        country: partial.country ?? null,
        email: partial.email ?? null,
        wallet_currency: partial.wallet_currency ?? null,
        wallet_balance_cents: partial.wallet_balance_cents ?? null,
        steam_level: partial.steam_level ?? null,
        steam_points: partial.steam_points ?? null,
        source: partial.source ?? null,
        scanned_at: ts,
        now: ts
    });
    if (mirror.active) mirror.upsert('accounts', db.prepare('SELECT * FROM accounts WHERE steam_id = ?').get(partial.steam_id));
}

// Add an account WITHOUT scanning it: record only what a raw upload line carries
// (steam_id, login name, email, source). Unlike saveAccount it does NOT set
// scanned_at — the row is a stub until a real scan fills wallet/level/etc. All
// fields COALESCE, so importing an already-known account never erases scan data.
const upsertAccountStub = db.prepare(`
INSERT INTO accounts (steam_id, account_name, email, source, created_at, updated_at)
VALUES (@steam_id, @account_name, @email, @source, @now, @now)
ON CONFLICT(steam_id) DO UPDATE SET
    account_name = COALESCE(excluded.account_name, accounts.account_name),
    email = COALESCE(excluded.email, accounts.email),
    source = COALESCE(excluded.source, accounts.source),
    updated_at = excluded.updated_at
`);
function addAccountStub({ steam_id, account_name, email, source }) {
    const ts = now();
    return upsertAccountStub.run({
        steam_id,
        account_name: account_name ?? null,
        email: email ?? null,
        source: source ?? null,
        now: ts
    }).changes;
}

const saveFriends = db.transaction((accountSteamID, friends) => {
    const ts = now();
    for (const f of friends) {
        upsertFriend.run({
            account_steam_id: accountSteamID,
            friend_steam_id: f.steam_id,
            friend_name: f.name ?? null,
            friend_level: f.level ?? null,
            added_at: f.added_at ?? null,
            relationship: f.relationship ?? null,
            now: ts
        });
    }
    if (mirror.active) mirror.replaceForAccount('friends', 'account_steam_id', accountSteamID, db.prepare('SELECT * FROM friends WHERE account_steam_id = ?').all(accountSteamID));
});

const saveLicenses = db.transaction((accountSteamID, licenses) => {
    const ts = now();
    const seenPkgs = new Set(licenses.map((l) => l.package_id));

    // Drop licenses (and their apps) the account no longer owns
    const current = listLicensePkgs.all(accountSteamID).map((r) => r.package_id);
    for (const pkgID of current) {
        if (!seenPkgs.has(pkgID)) {
            deleteLicenseAppByID.run(accountSteamID, pkgID);
            deleteLicenseByID.run(accountSteamID, pkgID);
        }
    }

    for (const lic of licenses) {
        upsertLicense.run({
            account_steam_id: accountSteamID,
            package_id: lic.package_id,
            package_name: lic.package_name ?? null,
            payment_method: lic.payment_method ?? null,
            license_type: lic.license_type ?? null,
            purchased_at: lic.purchased_at ?? null,
            territory_code: lic.territory_code ?? null,
            now: ts
        });
        // Refresh apps for this package (drop missing, upsert present)
        deleteLicenseAppByID.run(accountSteamID, lic.package_id);
        for (const a of (lic.apps || [])) {
            upsertLicenseApp.run({
                account_steam_id: accountSteamID,
                package_id: lic.package_id,
                app_id: a.app_id,
                app_name: a.app_name ?? null,
                now: ts
            });
        }
    }
    if (mirror.active) {
        mirror.replaceForAccount('licenses', 'account_steam_id', accountSteamID, db.prepare('SELECT * FROM licenses WHERE account_steam_id = ?').all(accountSteamID));
        mirror.replaceForAccount('license_apps', 'account_steam_id', accountSteamID, db.prepare('SELECT * FROM license_apps WHERE account_steam_id = ?').all(accountSteamID));
    }
});

const saveGifts = db.transaction((accountSteamID, gifts) => {
    deleteGifts.run(accountSteamID);
    const ts = now();
    for (const g of gifts) {
        insertGift.run({
            gift_id: g.gift_id,
            account_steam_id: accountSteamID,
            item_name: g.item_name ?? null,
            detail: g.detail ?? null,
            sender_steam_id: g.sender_steam_id ?? null,
            sender_name: g.sender_name ?? null,
            sent_at: g.sent_at ?? null,
            status: g.status ?? null,
            store_url: g.store_url ?? null,
            scanned_at: ts,
            now: ts
        });
        if (g.sender_steam_id) {
            updateFriendGift.run(parseGiftedAt(g.sent_at), g.item_name ?? null, accountSteamID, g.sender_steam_id);
        }
    }
    if (mirror.active) mirror.replaceForAccount('pending_gifts', 'account_steam_id', accountSteamID, db.prepare('SELECT * FROM pending_gifts WHERE account_steam_id = ?').all(accountSteamID));
});

const deleteSentGifts = db.prepare('DELETE FROM sent_gifts WHERE account_steam_id = ?');
const insertSentGift = db.prepare(`
INSERT INTO sent_gifts (gift_id, account_steam_id, recipient_steam_id, recipient_name, item_name, detail, sent_at, status, store_url, scanned_at, created_at, updated_at)
VALUES (@gift_id, @account_steam_id, @recipient_steam_id, @recipient_name, @item_name, @detail, @sent_at, @status, @store_url, @scanned_at, @now, @now)
ON CONFLICT(gift_id) DO UPDATE SET
    account_steam_id = excluded.account_steam_id,
    recipient_steam_id = excluded.recipient_steam_id,
    recipient_name = excluded.recipient_name,
    item_name = excluded.item_name,
    detail = excluded.detail,
    sent_at = excluded.sent_at,
    status = excluded.status,
    store_url = excluded.store_url,
    scanned_at = excluded.scanned_at,
    updated_at = excluded.updated_at
`);

// Replace this account's sent-gift snapshot wholesale: a gift that's no longer
// pending (recipient accepted it) drops off the page, so we delete-then-insert.
const saveSentGifts = db.transaction((accountSteamID, gifts) => {
    deleteSentGifts.run(accountSteamID);
    const ts = now();
    for (const g of gifts) {
        insertSentGift.run({
            gift_id: g.gift_id,
            account_steam_id: accountSteamID,
            recipient_steam_id: g.recipient_steam_id ?? null,
            recipient_name: g.recipient_name ?? null,
            item_name: g.item_name ?? null,
            detail: g.detail ?? null,
            sent_at: parseGiftedAt(g.sent_at),
            status: g.status ?? null,
            store_url: g.store_url ?? null,
            scanned_at: ts,
            now: ts
        });
    }
    if (mirror.active) mirror.replaceForAccount('sent_gifts', 'account_steam_id', accountSteamID, db.prepare('SELECT * FROM sent_gifts WHERE account_steam_id = ?').all(accountSteamID));
});

const upsertToken = db.prepare(`
INSERT INTO auth_tokens (account_name, refresh_token, created_at, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(account_name) DO UPDATE SET
    refresh_token = excluded.refresh_token,
    updated_at = excluded.updated_at
`);
const selectToken = db.prepare('SELECT refresh_token FROM auth_tokens WHERE account_name = ?');
const deleteToken = db.prepare('DELETE FROM auth_tokens WHERE account_name = ?');

function saveRefreshToken(accountName, token) {
    const ts = now();
    upsertToken.run(accountName, token, ts, ts);
}
function getRefreshToken(accountName) {
    return selectToken.get(accountName)?.refresh_token ?? null;
}
function clearRefreshToken(accountName) {
    deleteToken.run(accountName);
}

// Replace an account's game-playtime snapshot (delete-then-insert), like saveGifts.
const deletePlaytime = db.prepare('DELETE FROM game_playtime WHERE account_steam_id = ?');
const insertPlaytime = db.prepare(`
INSERT INTO game_playtime (account_steam_id, app_id, name, playtime_forever, playtime_2weeks, scanned_at, created_at, updated_at)
VALUES (@account_steam_id, @app_id, @name, @playtime_forever, @playtime_2weeks, @now, @now, @now)
`);
const saveGamePlaytime = db.transaction((accountSteamID, games) => {
    const ts = now();
    deletePlaytime.run(accountSteamID);
    for (const g of games) {
        insertPlaytime.run({
            account_steam_id: accountSteamID,
            app_id: g.app_id ?? g.appid,
            name: g.name ?? null,
            playtime_forever: g.playtime_forever ?? 0,
            playtime_2weeks: g.playtime_2weeks ?? 0,
            now: ts
        });
    }
    if (mirror.active) mirror.replaceForAccount('game_playtime', 'account_steam_id', accountSteamID, db.prepare('SELECT * FROM game_playtime WHERE account_steam_id = ?').all(accountSteamID));
    return games.length;
});

module.exports = {
    db, saveAccount, saveFriends, saveLicenses, saveGifts, saveSentGifts,
    saveRefreshToken, getRefreshToken, clearRefreshToken,
    isLoanedAccount, setAccountLoan, parseGiftedAt, addAccountStub, saveGamePlaytime
};
