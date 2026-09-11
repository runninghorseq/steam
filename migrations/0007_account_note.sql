-- Free-text note on an account (set from the dashboard, e.g. bulk-tagged from the
-- sent-gifts page). Shown in the account detail.
ALTER TABLE accounts ADD COLUMN note TEXT;
