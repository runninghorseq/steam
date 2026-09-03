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
    steam_points          INTEGER,          -- Steam Points balance (LoyaltyRewards.GetSummary)
    loan_id               INTEGER,          -- FK -> account_loans.id: this account has been
                                            -- lent out. Set by lend_account.js and KEPT after
                                            -- return, so "has ever been lent" stays knowable.
                                            -- While set, saveAccount() refuses to overwrite
                                            -- wallet_balance_cents / wallet_currency /
                                            -- steam_level, because those numbers were moved
                                            -- by whoever borrowed it. Clear with:
                                            --   node lend_account.js unlink <account>
    skip_wallet           INTEGER NOT NULL DEFAULT 0, -- 1 = never refresh this account's
                                            -- wallet/level. update_wallet_level.js drops it
                                            -- from --mode=all and --mode=wallet runs (gift
                                            -- scans still include it). Managed by
                                            -- wallet_skip.js; unrelated to loan_id, which
                                            -- also freezes the columns in saveAccount().
    source                TEXT,             -- Where this account came from, e.g. the
                                            -- uploaded file's name. Set on the scan that
                                            -- first imported it; kept on later re-scans.
    steam_password        TEXT,             -- Steam login password (managed in the dashboard;
                                            -- captured on the initial upload/scan). Plaintext.
    email_password        TEXT,             -- Password for the account's `email` inbox. Plaintext.
    email_refresh_token   TEXT,             -- OAuth refresh token for the mailbox (Outlook/Hotmail
                                            -- `email:pass:refresh_token:client_id` format), used to
                                            -- read Steam Guard emails. Rotate ~every 2 months.
    email_client_id       TEXT,             -- OAuth client_id paired with email_refresh_token.
    email_token_refreshed_at INTEGER,       -- Unix epoch the mailbox OAuth token was last refreshed;
                                            -- the dashboard flags it "due" after ~60 days.
    status                TEXT NOT NULL DEFAULT 'available', -- business status: available,
                                            -- renting, sold, reserved, disabled. Published via
                                            -- the /api/accounts/feed + status webhook.
    status_updated_at     INTEGER,          -- Unix epoch the status last changed
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
-- sent_gifts: gifts this account SENT to a friend that haven't been accepted yet
--   Scraped from the "Sent Gifts" section of the steamcommunity.com inventory
--   page (each row carries a "Resend gift..." action until the recipient accepts).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sent_gifts (
    gift_id             TEXT PRIMARY KEY, -- Steam gift ID from the sendgift checkout URL
    account_steam_id    TEXT,             -- Sender (the logged-in account)
    recipient_steam_id  TEXT,
    recipient_name      TEXT,
    item_name           TEXT,             -- e.g. "Path of Exile 2 - Early Access Supporter Pack (Special)"
    detail              TEXT,             -- Secondary line, e.g. "Steam Gift"
    sent_at             INTEGER,          -- Unix epoch, parsed from Steam's "7 Jun" string (current year assumed)
    status              TEXT,             -- "pending" (sent, awaiting acceptance)
    store_url           TEXT,             -- The sendgift/resend checkout URL
    scanned_at          INTEGER,          -- Unix epoch
    created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ----------------------------------------------------------------------------
-- account_loans: accounts temporarily handed to someone else, with the
--   pre-handover snapshot used to diff the account state on return.
--   Written by lend_account.js. A loan is "open" until returned_at is set.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_loans (
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

-- ----------------------------------------------------------------------------
-- game_playtime: per-account owned games + playtime, scraped from the account's
--   own community games page (works for private profiles when logged in as the
--   owner). Written by steam_playtime.js. Playtime is stored in MINUTES.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS game_playtime (
    account_steam_id  TEXT,
    app_id            INTEGER,
    name              TEXT,
    playtime_forever  INTEGER,  -- minutes, all time
    playtime_2weeks   INTEGER,  -- minutes, last 2 weeks
    scanned_at        INTEGER,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (account_steam_id, app_id)
);

-- ----------------------------------------------------------------------------
-- feedback: 1-5 star reviews left through the dashboard's Feedback form.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rating      INTEGER NOT NULL,   -- 1..5 stars
    comment     TEXT,               -- optional free text
    author      TEXT,               -- optional name/handle
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
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

-- ----------------------------------------------------------------------------
-- jobs: persisted background job runs (scan / sync / wallet / playtime / ...).
--   Written by the box's job runner; the dashboard reads history from here so
--   jobs survive a restart. `summary` is the job's JSON view (counts, timestamps,
--   usernames, results — everything except the log); `lines` is the newline-
--   joined log. Progress is flushed on a throttle while running, and forced once
--   the job reaches a terminal status.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,  -- 12-hex job id
    type        TEXT,              -- scan | scan-id | sync | wallet | email-refresh | ...
    status      TEXT,              -- queued | running | done | error | cancelled
    created_at  INTEGER,
    updated_at  INTEGER,
    summary     TEXT,              -- JSON: the job view without log lines
    lines       TEXT               -- newline-joined log
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (created_at);
