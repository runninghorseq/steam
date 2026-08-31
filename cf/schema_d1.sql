CREATE TABLE friends (
    account_steam_id TEXT,
    friend_steam_id TEXT,
    friend_name TEXT,
    friend_level INTEGER,
    added_at INTEGER,
    relationship INTEGER, country TEXT DEFAULT 'VN', gifted_at INTEGER, gifted_game TEXT, created_at INTEGER, updated_at INTEGER,
    PRIMARY KEY (account_steam_id, friend_steam_id)
);
CREATE TABLE licenses (
    account_steam_id TEXT,
    package_id INTEGER,
    package_name TEXT,
    payment_method TEXT,
    license_type TEXT,
    purchased_at INTEGER,
    territory_code INTEGER, created_at INTEGER, updated_at INTEGER,
    PRIMARY KEY (account_steam_id, package_id)
);
CREATE TABLE license_apps (
    account_steam_id TEXT,
    package_id INTEGER,
    app_id INTEGER,
    app_name TEXT, created_at INTEGER, updated_at INTEGER,
    PRIMARY KEY (account_steam_id, package_id, app_id)
);
CREATE TABLE pending_gifts (
    gift_id TEXT PRIMARY KEY,
    account_steam_id TEXT,
    item_name TEXT,
    detail TEXT,
    sender_steam_id TEXT,
    sender_name TEXT,
    sent_at TEXT,
    status TEXT,
    store_url TEXT,
    scanned_at INTEGER
, created_at INTEGER, updated_at INTEGER);
CREATE TABLE auth_tokens (
    account_name TEXT PRIMARY KEY,
    refresh_token TEXT NOT NULL,
    updated_at INTEGER NOT NULL
, created_at INTEGER);
CREATE TABLE IF NOT EXISTS "accounts"
(
    steam_id             TEXT
        primary key,
    account_name         TEXT,
    wallet_currency      TEXT,
    wallet_balance_cents INTEGER,
    steam_level          INTEGER,
    scanned_at           INTEGER,
    created_at           INTEGER,
    updated_at           INTEGER
, persona text, country text, email text, steam_points INTEGER, loan_id INTEGER, skip_wallet INTEGER NOT NULL DEFAULT 0, source TEXT);
CREATE INDEX idx_friends_friend_gift  ON friends(friend_steam_id, gifted_game);
CREATE INDEX idx_friends_acct_gift_added ON friends(account_steam_id, gifted_game, added_at);
CREATE TABLE account_loans (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    account_name      TEXT NOT NULL,     -- Steam login name
    account_steam_id  TEXT,              -- SteamID64 (from the snapshot)
    borrower          TEXT,              -- Who has it
    note              TEXT,
    lent_at           INTEGER NOT NULL,  -- Unix epoch
    due_at            INTEGER NOT NULL,  -- Unix epoch (lent_at + days)
    returned_at       INTEGER,           -- Set once the password has been rotated
    password_changed  INTEGER NOT NULL DEFAULT 0, -- 1 = old password verified dead
    snapshot_json     TEXT,              -- Account state captured at hand-over
    return_json       TEXT,              -- Account state captured on return
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS "sent_gifts" (
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
CREATE TABLE feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rating      INTEGER NOT NULL,   -- 1..5 stars
    comment     TEXT,               -- optional free text
    author      TEXT,               -- optional name/handle
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Supplemental indexes for heavy gift-candidate + lookup queries over 27k friends.
CREATE INDEX IF NOT EXISTS idx_friends_name       ON friends (friend_name);
CREATE INDEX IF NOT EXISTS idx_friends_steamid    ON friends (friend_steam_id);
CREATE INDEX IF NOT EXISTS idx_friends_account    ON friends (account_steam_id);
CREATE INDEX IF NOT EXISTS idx_friends_giftedat   ON friends (gifted_at);
CREATE INDEX IF NOT EXISTS idx_sent_recipient_id  ON sent_gifts (recipient_steam_id);
CREATE INDEX IF NOT EXISTS idx_sent_recipient_nm  ON sent_gifts (recipient_name);
CREATE INDEX IF NOT EXISTS idx_sent_account       ON sent_gifts (account_steam_id);
CREATE INDEX IF NOT EXISTS idx_accounts_name      ON accounts (account_name);
