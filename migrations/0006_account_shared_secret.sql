-- Steam Guard mobile-authenticator shared_secret, so accounts with 2FA can be
-- added (and later logged into) without a manual code. Base64 (20 bytes). Stored
-- as-is; used with steam-totp to generate the current Guard code at login time.
ALTER TABLE accounts ADD COLUMN shared_secret TEXT;
