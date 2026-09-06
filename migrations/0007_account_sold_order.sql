-- Which order bought an account, for the shop claim endpoint (/api/shop/claim).
--
-- Two jobs, both of them about not selling one account twice:
--
--   1. Idempotency. A claim is keyed on the buyer's order token, so a retried or
--      concurrent request for the same order returns the accounts already given
--      to it instead of taking fresh ones. telegram-shop-bot retries delivery on
--      its own (SePay can confirm the same transfer more than once), so this is
--      load-bearing, not belt-and-braces.
--
--   2. Provenance. `status = 'sold'` alone cannot say WHO bought it, so a refund
--      or a complaint has nothing to look up.
--
-- NULL means "not sold through the shop" — hand-sold accounts and every existing
-- row keep it, which is why the column is nullable with no default.
--
-- The index is what makes the idempotency lookup a lookup rather than a scan of
-- every account on every claim. Not UNIQUE: one order can buy several accounts.
ALTER TABLE accounts ADD COLUMN sold_order TEXT;

CREATE INDEX IF NOT EXISTS idx_accounts_sold_order ON accounts (sold_order);

-- The claim itself selects on this. 6k+ rows today and growing, and the claim
-- runs on the checkout path, so it should not read them all to find ten.
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts (status);
