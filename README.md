# Steam Account Scanner

Logs into Steam accounts, collects account / friends / licenses / wallet / pending-gifts / Steam-levels data, and persists it to a local SQLite database.

## Files

| File | Purpose |
| --- | --- |
| `single.js` | Exports `scanAccount(account, opts)` — scans one account. Can also run standalone. |
| `multi_scan.js` | CLI driver that scans many accounts in parallel with a concurrency limit. |
| `db.js` | SQLite schema + prepared `saveAccount` / `saveFriends` / `saveLicenses` / `saveGifts` helpers. |
| `steam_accounts.db` | SQLite database (created on first run). |

## Setup

```bash
cd steam
npm install steam-user steamcommunity better-sqlite3
```

Node 18+ recommended.

## Usage

### Scan one account

Edit the `acc` constant at the bottom of `single.js`, then:

```bash
node steam/single.js
```

Or use the function programmatically:

```js
const { scanAccount } = require('./single');

const result = await scanAccount(
    { id: 1, username: 'foo', password: 'bar' },
    { timeout: 60000 }
);
// result = { ok: true, account } | { ok: false, reason, account, partial? }
```

`scanAccount` never rejects — failures come back as `{ ok: false }`.

### Scan many accounts

```bash
node steam/multi_scan.js <accounts.txt> [concurrency=5] [timeout_ms=60000]
```

Example:

```bash
node steam/multi_scan.js steam_accounts.txt 10 90000
```

#### Account file formats

`multi_scan.js` accepts two line formats (matching `multi_friend.js`):

```
# Pipe-separated (index|hotmail|steamID|username|password):
1|user@hotmail.com|76561198xxx|myusername|mypassword

# Hyphen-separated:
myusername----mypassword----user@hotmail.com----76561198xxx
```

Mixed lines in the same file are fine.

## Data captured

Per account, persisted via [`db.js`](db.js):

| Table | Key | Contents |
| --- | --- | --- |
| `accounts` | `steam_id` | account_name, persona, country, email, wallet_currency, wallet_balance_cents, steam_level, scanned_at |
| `friends` | (account_steam_id, friend_steam_id) | friend_name, friend_level, added_at, relationship |
| `licenses` | (account_steam_id, package_id) | package_name, payment_method, license_type, purchased_at, territory_code |
| `license_apps` | (account_steam_id, package_id, app_id) | app_name |
| `pending_gifts` | `gift_id` | account_steam_id, item_name, detail, sender_steam_id, sender_name, sent_at, status, store_url |

Re-running upserts — wallet/level are merged via `COALESCE`, friends/licenses/gifts are refreshed per account.

### Useful queries

```bash
sqlite3 steam/steam_accounts.db
```

```sql
-- All scanned accounts with wallet balance
SELECT account_name, wallet_currency, wallet_balance_cents/100.0 AS balance, steam_level
FROM accounts ORDER BY scanned_at DESC;

-- Pending POE2 (or any) gifts received
SELECT a.account_name, g.item_name, g.sender_name, g.status, g.store_url
FROM pending_gifts g
JOIN accounts a ON a.steam_id = g.account_steam_id
WHERE g.item_name LIKE '%Path of Exile%';

-- Total games owned per account
SELECT a.account_name, COUNT(DISTINCT la.app_id) AS games
FROM accounts a
LEFT JOIN license_apps la ON la.account_steam_id = a.steam_id
GROUP BY a.steam_id ORDER BY games DESC;

-- High-level friends across all accounts
SELECT f.friend_name, MAX(f.friend_level) AS lvl
FROM friends f
GROUP BY f.friend_steam_id
ORDER BY lvl DESC LIMIT 20;
```

## How it works

`scanAccount` waits for six Steam events to complete:

1. `accountInfo` — persona name, country, email
2. `wallet` — currency + balance
3. `friendsList` — friends (enriched with `friend_since` from Steam Web API)
4. `licenses` — packages owned (names resolved via PICS `getProductInfo`)
5. `webSession` → inventory HTML scrape — pending gifts not yet redeemed (`steam-user`'s built-in `gifts` event is unreliable; we parse `/profiles/<id>/inventory/` directly using the authenticated `steamcommunity` http client)
6. `getSteamLevels` callback — self level + per-friend levels

When all six tick, the client logs off and the promise resolves. A master timeout (default 60s) prevents hung accounts from blocking the batch.

## Notes

- `Package ID 0` ("Anonymous" — the system-default package every account gets) is filtered out of license listings.
- The Steam Web API key in `single.js` is shared across all accounts — it only affects the public-profile friend-list lookup (used to get `friend_since`), so any valid key works.
- `pending_gifts` inventory page scraping requires the account to have at least one pending gift; the page must render server-side (it does for the logged-in account's own inventory). No public-inventory privacy change needed.
- The `wallet` event also fires for accounts with no wallet (`hasWallet=false`); the row is still saved with `wallet_balance_cents=0`.

## Cross-project access

The database is intentionally a plain SQLite file with no app-private encoding — any project (or any Claude session) can read it directly without depending on this codebase.

**Schema source of truth**: [`schema.sql`](schema.sql). Column-level comments live there; `db.js` reads it on startup, so JS and the standalone DDL never drift.

### Starting a new project against this DB

```bash
# Option A — read an existing populated DB (most common):
sqlite3 /Users/lequangha/fungaming/steam/steam/steam_accounts.db

# Option B — create an empty DB with the same schema elsewhere:
sqlite3 /path/to/new.db < /Users/lequangha/fungaming/steam/steam/schema.sql
```

From Node, Python, Go etc., just open the file with any standard SQLite driver — no migrations to run, the schema is `CREATE TABLE IF NOT EXISTS` so it's safe to attach to.

### Account status feed & webhook (HTTP)

Each account carries a business **status** — one of `available` (default), `renting`, `sold`, `reserved`, `disabled` (`accounts.status`, with `accounts.status_updated_at`). Set it in the dashboard (account detail → **Status**) or via the API. Another project can consume it two ways; base URL is the Worker, e.g. `https://steam-dashboard.fungamingsteam.workers.dev`.

**Pull — status feed**

```
GET /api/accounts/feed[?status=<available|renting|sold|reserved|disabled>]
Authorization: Bearer <FEED_TOKEN>      # or ?token=<FEED_TOKEN>, or the dashboard token
```

```json
{
  "count": 12,
  "statuses": ["available", "renting", "sold", "reserved", "disabled"],
  "accounts": [
    { "steam_id": "765...", "account_name": "...", "persona": "...", "country": "US",
      "wallet_currency": "USD", "wallet_balance_cents": 1234, "steam_level": 10,
      "status": "renting", "status_updated_at": 1788400000 }
  ]
}
```

**Push — status webhook**

When a status changes, the app POSTs to `STATUS_WEBHOOK_URL` (if configured), with `Authorization: Bearer <STATUS_WEBHOOK_TOKEN>`:

```json
{ "event": "account.status", "at": 1788400000,
  "account": { "steam_id": "765...", "account_name": "...", "persona": "...",
               "country": "US", "status": "sold", "status_updated_at": 1788400000 } }
```

Pushes are best-effort (fire-and-forget). Treat the **pull feed as authoritative** — re-pull periodically and upsert by `steam_id`, rather than relying on every push landing.

**Set a status** — `POST /api/accounts/<steamID64>/status` with `{"status":"renting"}` (dashboard token). Unknown values return 400.

**Config** — Worker secrets, all optional:

| Var | Purpose |
| --- | --- |
| `FEED_TOKEN` | Scoped read token for the feed (else the full dashboard token is required) |
| `STATUS_WEBHOOK_URL` | Where to POST on each change (unset = no push, feed still works) |
| `STATUS_WEBHOOK_TOKEN` | Bearer token sent with the webhook |

### Conventions a consumer must know

| Topic | Detail |
| --- | --- |
| Steam IDs | Always stored as TEXT (SteamID64 string). Do NOT compare against numbers. |
| Wallet balances | INTEGER cents. Display = `wallet_balance_cents / 100.0`. |
| Timestamps | INTEGER unix epoch seconds (UTC). Exception: `pending_gifts.sent_at` is a free-form string from the Steam page (e.g. "26 May"). |
| Package ID 0 | Filtered out — the scanner skips Steam's system-default "Anonymous" package. |
| Re-runs | Upsert by primary key; `accounts.scanned_at` is the timestamp of the most recent scan. |
| `auth_tokens` | Treat as secrets. Don't expose, log, or commit. Refresh tokens grant full account access. |
| `accounts.status` | Business status: `available` (default), `renting`, `sold`, `reserved`, `disabled`. Also served over HTTP — see the status feed & webhook above. |

### Concurrent access

`better-sqlite3` is opened in WAL mode (`journal_mode = WAL`), so:

- Multiple processes can read simultaneously without blocking each other.
- One writer at a time — concurrent writes from a different process will get `SQLITE_BUSY`. Retry with backoff, or have the consumer be read-only.
- The scanner is the only writer in this repo; other projects should ideally open the DB read-only:

```js
const db = new Database(DB_PATH, { readonly: true });
```

```python
import sqlite3
conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
```

### Future schema changes

`CREATE TABLE IF NOT EXISTS` won't add new columns to an existing DB. When adding a column:

1. Edit `schema.sql` so fresh DBs get it.
2. Apply the change to existing DBs manually:
   ```sql
   ALTER TABLE accounts ADD COLUMN new_column TEXT;
   ```
3. Notify any consuming project, since their queries may need to be updated.

For breaking changes (rename / drop column), bump a schema version comment at the top of `schema.sql` and write a one-off migration script.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `timeout — partial flags: { ... gifts: false }` | Inventory page returned no HTML (cookies expired or session not granted) | Increase `timeout`, or re-run; steam-user re-issues webSession on retry |
| `error: SteamGuard...` in failures list | Account requires Steam Guard | Not handled — these accounts need a code passed via `logOn({...twoFactorCode})` |
| `client.getUserInventoryContents is not a function` | Old code path | Make sure you're on the latest `single.js` — inventory uses `community.httpRequestGet` |
| SQLite `SQLITE_BUSY` under high concurrency | Too many parallel writers | Reduce concurrency arg; WAL mode handles ~10 fine |
