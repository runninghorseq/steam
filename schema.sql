-- Steam Account Scanner schema (SQLite)
-- Source of truth for steam_accounts.db. db.js loads this file on startup.
--
-- To create a fresh DB from another project:
--   sqlite3 steam_accounts.db < schema.sql
--
-- Conventions:
--   * All steam IDs (account_steam_id, friend_steam_id, sender_steam_id) are
--     SteamID64 strings (e.g. "76561198xxxxxxxxx"), not numbers.
--   * Wallet balances are stored in CENTS (smallest currency unit) as INTEGER.
--     Divide by 100 for the display value.
--   * Unix timestamps are INTEGER seconds since epoch (UTC).
--   * Scripts upsert by primary key, so re-running is idempotent.

-- ----------------------------------------------------------------------------
-- accounts: one row per logged-in Steam account (latest known state)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
    steam_id              TEXT PRIMARY KEY, -- SteamID64
    account_name          TEXT,             -- Steam login name (lowercase)
    persona               TEXT,             -- Display name on profile
    country               TEXT,             -- ISO country code, e.g. "US"
    email                 TEXT,             -- From client.emailInfo.address
    wallet_currency       TEXT,             -- e.g. "USD", "EUR" (ECurrencyCode name)
    wallet_balance_cents  INTEGER,          -- Cents, divide by 100 for display
    steam_level           INTEGER,          -- Profile level (0+)
    scanned_at            INTEGER,          -- Last scan unix epoch (seconds)
    created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at            INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ----------------------------------------------------------------------------
-- friends: friend list per account, with relationship + Steam level
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS friends (
    account_steam_id  TEXT,    -- FK -> accounts.steam_id
    friend_steam_id   TEXT,    -- SteamID64 of the friend
    friend_name       TEXT,    -- Display name (may be null if not yet loaded)
    friend_level      INTEGER, -- Friend's Steam profile level
    added_at          INTEGER, -- Unix epoch when friendship started (from Steam Web API)
    relationship      INTEGER, -- steam-user EFriendRelationship enum (3 = Friend)
    gifted_at         INTEGER, -- Unix epoch parsed from Steam's "sent_at" string (current year assumed)
    gifted_game       TEXT,    -- item_name of that gift (e.g. "Path of Exile 2")
    country           TEXT DEFAULT 'VN', -- ISO country code (from Steam profile loccountrycode)
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (account_steam_id, friend_steam_id)
);

-- ----------------------------------------------------------------------------
-- licenses: packages (sub IDs) owned by each account
--   Package ID 0 (Anonymous / system) is filtered out by the scanner.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS licenses (
    account_steam_id  TEXT,
    package_id        INTEGER,
    package_name      TEXT,    -- Resolved via PICS getProductInfo
    payment_method    TEXT,    -- EPaymentMethod name (e.g. "Wallet", "Complimentary")
    license_type     TEXT,    -- ELicenseType name (e.g. "SinglePurchase")
    purchased_at      INTEGER, -- Unix epoch (lic.time_created)
    territory_code    INTEGER,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (account_steam_id, package_id)
);

-- ----------------------------------------------------------------------------
-- license_apps: app IDs contained in each package, with resolved names
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS license_apps (
    account_steam_id  TEXT,
    package_id        INTEGER,
    app_id            INTEGER, -- Steam appid (e.g. 730 = CS2)
    app_name          TEXT,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (account_steam_id, package_id, app_id)
);

-- ----------------------------------------------------------------------------
-- pending_gifts: gifts received but not yet redeemed or declined
--   Scraped from steamcommunity.com inventory page (server-rendered).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_gifts (
    gift_id           TEXT PRIMARY KEY, -- Steam-assigned numeric ID (string, 64-bit)
    account_steam_id  TEXT,             -- Recipient
    item_name         TEXT,             -- e.g. "Path of Exile 2"
    detail            TEXT,             -- First description line, e.g. "PoE 2 Early Access Supporter Pack"
    sender_steam_id   TEXT,
    sender_name       TEXT,
    sent_at           TEXT,             -- Human-readable date string from Steam page, e.g. "26 May"
    status            TEXT,             -- "Unredeemed" | "Redeemed" | "Declined"
    store_url         TEXT,
    scanned_at        INTEGER,          -- Unix epoch
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ----------------------------------------------------------------------------
-- auth_tokens: per-account Steam refresh tokens (avoids re-prompting 2FA)
--   Long-lived JWTs (~200 days). Cleared automatically on auth errors.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_tokens (
    account_name   TEXT PRIMARY KEY,  -- Lowercase Steam login name
    refresh_token  TEXT NOT NULL,     -- JWT, ~800 chars
    created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
