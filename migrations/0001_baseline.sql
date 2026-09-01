-- Baseline schema for the steam-dashboard D1 database (`steam`).
--
-- This is the state the remote database was hand-built up to before migrations
-- existed (it was seeded with `wrangler d1 execute --file=cf/schema_d1.sql` plus
-- ad-hoc ALTERs). Every statement is IF NOT EXISTS, so `migrations apply` on the
-- already-populated remote DB is a no-op that only records the baseline, while a
-- brand-new/local DB gets the full schema. Later migrations carry real changes.
--
-- Apply:
--   npm run migrate:local     # local .wrangler DB
--   npm run migrate           # remote (production)

CREATE TABLE IF NOT EXISTS accounts (
    steam_id             TEXT PRIMARY KEY,
    account_name         TEXT,
    persona              TEXT,
    country              TEXT,
    email                TEXT,
    wallet_currency      TEXT,
    wallet_balance_cents INTEGER,
    steam_level          INTEGER,
    steam_points         INTEGER,
    loan_id              INTEGER,
    skip_wallet          INTEGER NOT NULL DEFAULT 0,
    source               TEXT,
    scanned_at           INTEGER,
    created_at           INTEGER,
    updated_at           INTEGER
);

CREATE TABLE IF NOT EXISTS friends (
    account_steam_id TEXT,
    friend_steam_id  TEXT,
    friend_name      TEXT,
    friend_level     INTEGER,
    added_at         INTEGER,
    relationship     INTEGER,
    country          TEXT DEFAULT 'VN',
    gifted_at        INTEGER,
    gifted_game      TEXT,
    created_at       INTEGER,
    updated_at       INTEGER,
    PRIMARY KEY (account_steam_id, friend_steam_id)
);

CREATE TABLE IF NOT EXISTS licenses (
    account_steam_id TEXT,
    package_id       INTEGER,
    package_name     TEXT,
    payment_method   TEXT,
    license_type     TEXT,
    purchased_at     INTEGER,
    territory_code   INTEGER,
    created_at       INTEGER,
    updated_at       INTEGER,
    PRIMARY KEY (account_steam_id, package_id)
);

CREATE TABLE IF NOT EXISTS license_apps (
    account_steam_id TEXT,
    package_id       INTEGER,
    app_id           INTEGER,
    app_name         TEXT,
    created_at       INTEGER,
    updated_at       INTEGER,
    PRIMARY KEY (account_steam_id, package_id, app_id)
);

CREATE TABLE IF NOT EXISTS pending_gifts (
    gift_id          TEXT PRIMARY KEY,
    account_steam_id TEXT,
    item_name        TEXT,
    detail           TEXT,
    sender_steam_id  TEXT,
    sender_name      TEXT,
    sent_at          TEXT,
    status           TEXT,
    store_url        TEXT,
    scanned_at       INTEGER,
    created_at       INTEGER,
    updated_at       INTEGER
);

CREATE TABLE IF NOT EXISTS sent_gifts (
    gift_id            TEXT PRIMARY KEY,
    account_steam_id   TEXT,
    recipient_steam_id TEXT,
    recipient_name     TEXT,
    item_name          TEXT,
    detail             TEXT,
    sent_at            INTEGER,
    status             TEXT,
    store_url          TEXT,
    scanned_at         INTEGER,
    created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS auth_tokens (
    account_name  TEXT PRIMARY KEY,
    refresh_token TEXT NOT NULL,
    created_at    INTEGER,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_loans (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    account_name     TEXT NOT NULL,
    account_steam_id TEXT,
    borrower         TEXT,
    note             TEXT,
    lent_at          INTEGER NOT NULL,
    due_at           INTEGER NOT NULL,
    returned_at      INTEGER,
    password_changed INTEGER NOT NULL DEFAULT 0,
    snapshot_json    TEXT,
    return_json      TEXT,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS game_playtime (
    account_steam_id TEXT,
    app_id           INTEGER,
    name             TEXT,
    playtime_forever INTEGER,
    playtime_2weeks  INTEGER,
    scanned_at       INTEGER,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (account_steam_id, app_id)
);

CREATE TABLE IF NOT EXISTS feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rating     INTEGER NOT NULL,
    comment    TEXT,
    author     TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes for the gift-candidate + lookup queries.
CREATE INDEX IF NOT EXISTS idx_friends_friend_gift     ON friends (friend_steam_id, gifted_game);
CREATE INDEX IF NOT EXISTS idx_friends_acct_gift_added ON friends (account_steam_id, gifted_game, added_at);
CREATE INDEX IF NOT EXISTS idx_friends_name            ON friends (friend_name);
CREATE INDEX IF NOT EXISTS idx_friends_steamid         ON friends (friend_steam_id);
CREATE INDEX IF NOT EXISTS idx_friends_account         ON friends (account_steam_id);
CREATE INDEX IF NOT EXISTS idx_friends_giftedat        ON friends (gifted_at);
CREATE INDEX IF NOT EXISTS idx_sent_recipient_id       ON sent_gifts (recipient_steam_id);
CREATE INDEX IF NOT EXISTS idx_sent_recipient_nm       ON sent_gifts (recipient_name);
CREATE INDEX IF NOT EXISTS idx_sent_account            ON sent_gifts (account_steam_id);
CREATE INDEX IF NOT EXISTS idx_accounts_name           ON accounts (account_name);
CREATE INDEX IF NOT EXISTS idx_playtime_account        ON game_playtime (account_steam_id);
