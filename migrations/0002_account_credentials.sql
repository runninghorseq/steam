-- Credential columns on accounts, so the box's D1 mirror can write them.
--
-- The box stores these per account and mirrors the whole accounts row to D1 on
-- every scan / wallet refresh / credential edit (db.js -> d1_mirror.js does an
-- `INSERT OR REPLACE INTO accounts (<all columns>) …`). Until D1's accounts table
-- has these columns, that write fails with "table accounts has no column named
-- email_password" and the mirror stalls — which is exactly what the dashboard's
-- new "Update email tokens" upload (mail|pass|refresh_token|app_id) feeds in.
--
-- ALTER … ADD COLUMN is not IF-NOT-EXISTS-able, but wrangler records applied
-- migrations, so this runs exactly once per database.
--
--   steam_password           Steam login password (captured on upload/scan)
--   email_password           password for the account's mailbox
--   email_refresh_token      mailbox OAuth refresh token (read Steam Guard mail)
--   email_client_id          OAuth client_id paired with the refresh token
--   email_token_refreshed_at unix epoch the mailbox token was last refreshed

ALTER TABLE accounts ADD COLUMN steam_password TEXT;
ALTER TABLE accounts ADD COLUMN email_password TEXT;
ALTER TABLE accounts ADD COLUMN email_refresh_token TEXT;
ALTER TABLE accounts ADD COLUMN email_client_id TEXT;
ALTER TABLE accounts ADD COLUMN email_token_refreshed_at INTEGER;
