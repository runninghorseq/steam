-- Kill the two remaining giant scans seen in Turso analytics (10.34M + 7.09M
-- rows read on the gift-candidate queries; 1.30M on the licenses rollup).
--
--   * The gift-candidate NOT EXISTS guards match a friend against accounts by
--     `(ax.steam_id = f.friend_steam_id OR lower(ax.persona) = lower(f.friend_name))`.
--     steam_id is the PK, but lower(persona) had NO index, so SQLite could not do
--     an OR-by-union and full-scanned `accounts` once PER candidate friend. This
--     index makes the persona branch a seek, so the whole guard uses two indexes.
CREATE INDEX IF NOT EXISTS idx_accounts_persona_lower ON accounts (lower(persona));

--   * The licenses tab rolls up by package_id and, per group, runs
--     `SELECT group_concat(app_name) FROM license_apps WHERE package_id = ?`.
--     license_apps' PK leads with account_steam_id, so package_id had no usable
--     index -> a license_apps scan per package group. Also give the outer rollup a
--     (package_id, account_steam_id) index for the GROUP BY + COUNT(DISTINCT ...).
CREATE INDEX IF NOT EXISTS idx_license_apps_package     ON license_apps (package_id);
CREATE INDEX IF NOT EXISTS idx_licenses_package_account ON licenses (package_id, account_steam_id);
