-- Business status for accounts that get rented out or sold. Default 'available';
-- allowed values enforced by the API: available, renting, sold, reserved, disabled.
-- status_updated_at (unix epoch) records the last change, for the feed + webhook.
ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'available';
ALTER TABLE accounts ADD COLUMN status_updated_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts (status);
