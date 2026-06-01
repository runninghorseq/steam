const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'steam_accounts.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

const upsertAccount = db.prepare(`
INSERT INTO accounts (steam_id, account_name, persona, country, email, wallet_currency, wallet_balance_cents, steam_level, scanned_at, created_at, updated_at)
VALUES (@steam_id, @account_name, @persona, @country, @email, @wallet_currency, @wallet_balance_cents, @steam_level, @scanned_at, @now, @now)
ON CONFLICT(steam_id) DO UPDATE SET
    account_name = COALESCE(excluded.account_name, accounts.account_name),
    persona = COALESCE(excluded.persona, accounts.persona),
    country = COALESCE(excluded.country, accounts.country),
    email = COALESCE(excluded.email, accounts.email),
    wallet_currency = COALESCE(excluded.wallet_currency, accounts.wallet_currency),
    wallet_balance_cents = COALESCE(excluded.wallet_balance_cents, accounts.wallet_balance_cents),
    steam_level = COALESCE(excluded.steam_level, accounts.steam_level),
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

function saveAccount(partial) {
    const ts = now();
    upsertAccount.run({
        steam_id: partial.steam_id,
        account_name: partial.account_name ?? null,
        persona: partial.persona ?? null,
        country: partial.country ?? null,
        email: partial.email ?? null,
        wallet_currency: partial.wallet_currency ?? null,
        wallet_balance_cents: partial.wallet_balance_cents ?? null,
        steam_level: partial.steam_level ?? null,
        scanned_at: ts,
        now: ts
    });
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

module.exports = {
    db, saveAccount, saveFriends, saveLicenses, saveGifts,
    saveRefreshToken, getRefreshToken, clearRefreshToken
};
