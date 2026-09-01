-- Adds the game_playtime table to an existing D1 database (the Worker queries it
-- for game_count / playtime_minutes and the per-account games list). Idempotent.
--   npx wrangler d1 execute steam --remote --file=cf/migrate_game_playtime.sql
CREATE TABLE IF NOT EXISTS game_playtime (
    account_steam_id  TEXT,
    app_id            INTEGER,
    name              TEXT,
    playtime_forever  INTEGER,
    playtime_2weeks   INTEGER,
    scanned_at        INTEGER,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (account_steam_id, app_id)
);
