CREATE TABLE game_playtime (
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
CREATE INDEX IF NOT EXISTS idx_playtime_account ON game_playtime (account_steam_id);
