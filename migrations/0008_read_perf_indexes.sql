-- Cut row reads on the hot paths. Without these, correlated subqueries full-scan
-- their tables once PER account row (accounts list / feed) or PER candidate friend
-- (gift bot), which is what drove Turso reads to hundreds of millions.
--
--   * has_token in the accounts list matched lower(auth_tokens.account_name) with
--     no index -> full scan of auth_tokens per account row.
--   * pending_gifts / licenses had no account_steam_id index -> full scan per row.
--   * the gift-candidate subqueries match lower(sent_gifts.recipient_name), which
--     the raw idx_sent_recipient_nm can't serve -> full scan per candidate.
CREATE INDEX IF NOT EXISTS idx_auth_tokens_name_lower ON auth_tokens (lower(account_name));
CREATE INDEX IF NOT EXISTS idx_pending_account        ON pending_gifts (account_steam_id);
CREATE INDEX IF NOT EXISTS idx_licenses_account       ON licenses (account_steam_id);
CREATE INDEX IF NOT EXISTS idx_sent_recipient_nm_lower ON sent_gifts (lower(recipient_name));
