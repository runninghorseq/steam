# thuegame ⇄ steam server — FEED_TOKEN integration

How the shop/rental service (**thuegame**) reads inventory and delivers Steam
accounts from this server, using a scoped `FEED_TOKEN`.

- **Base URL:** `https://steam-dashboard.fungamingsteam.workers.dev`
  (This is the **Worker**, which serves the shop/feed API from Turso and knows
  `FEED_TOKEN`. Do **not** point thuegame at `steam.fungamingvn.space` — that's
  the box/server, whose auth is token-only and rejects the `FEED_TOKEN`.)
- **Auth:** send the `FEED_TOKEN` on **every** request as a header:
  ```
  X-Dashboard-Token: <FEED_TOKEN>
  ```
  (`Authorization: Bearer <FEED_TOKEN>` and `?token=<FEED_TOKEN>` also work.)

The `FEED_TOKEN` is a **separate secret** from the dashboard login. It is **not**
subject to the dashboard password — thuegame sends only this one token. It can
reach **only** the four endpoints below; everything else returns `401`.

> Set it once on the server: `npx wrangler secret put FEED_TOKEN`, then put the
> same value in thuegame's environment. Rotate by repeating on both sides.

---

## 1. List products + stock — `GET /api/shop/gift-items`

Gift items you can build products around, each with how many **available**
accounts hold one right now. Use this to show a real, in-stock product list
instead of a free-text box (a typo'd item looks identical to out-of-stock).

```
GET /api/shop/gift-items            # default: gifts with status 'pending'
GET /api/shop/gift-items?status=any # every item
```
```json
{ "items": [
  { "item_name": "Path of Exile 2 - Early Access Supporter Pack", "status": "pending", "available": 137 },
  { "item_name": "The Isle", "status": "pending", "available": 12 }
] }
```

---

## 2. Deliver on a paid order — `POST /api/shop/claim`  ← use this

Atomically hands **N available accounts** to one order and returns their
credentials. This is the correct delivery call — **do not** read the feed and
POST a status yourself (that can double-sell the same account).

```
POST /api/shop/claim
Content-Type: application/json
{ "order": "<your order id>", "count": 1 }
```
Optional filters (query string) to sell a specific kind of account:
| Param | Meaning |
|---|---|
| `?app=<appid>` | account owns that Steam app (license) |
| `?gift_item=<name>` | account received that gift item (substring match) |
| `?gift_status=pending\|any` | status of that gift (default `pending`) |
| `?country=<CC>` | account's country |
| `?wallet_min=<usd>` | wallet ≥ that many USD |

```json
{
  "order": "SEPAY#12345",
  "requested": 1,
  "delivered": 1,
  "short": false,
  "accounts": [
    {
      "steam_id": "76561199…",
      "account_name": "loginname",
      "steam_password": "…",
      "email": "mailbox@outlook.com",
      "email_password": "…",
      "shared_secret": "…",
      "country": "US",
      "wallet_currency": "USD",
      "wallet_balance_cents": 250,
      "status": "sold"
    }
  ]
}
```

**Guarantees**
- **No double-sell:** the claim runs `UPDATE … WHERE status='available'`, so
  exactly one caller wins each account; concurrent orders never get the same one.
- **Idempotent per `order`:** call it again with the same `order` and you get the
  **same accounts back** — it never buys extra. Safe to retry when a payment
  webhook fires twice.
- **Always `200`.** `delivered` = how many you got; `short: true` means it
  couldn't fully fill the order (not enough stock matching the filters). What to
  do about a shortfall (refund, partial, wait) is thuegame's decision.

**Deliver these credentials to the customer:** `account_name` + `steam_password`
(Steam login), `email` + `email_password` (mailbox, for Steam Guard / recovery),
and `shared_secret` if you generate 2FA codes.

---

## 3. (Optional) Raw feed — `GET /api/accounts/feed`

The account list by status. `claim` is preferred for delivery; use the feed for
inventory views / reconciliation.

```
GET /api/accounts/feed?status=available            # basic fields, no credentials
GET /api/accounts/feed?status=sold                 # sold accounts, credentials auto-included
GET /api/accounts/feed?status=available,sold       # multiple statuses
GET /api/accounts/feed?status=available&credentials=1  # force credentials
GET /api/accounts/feed?status=sold&credentials=0       # suppress credentials
```
```json
{ "count": 42, "credentials": true, "statuses": ["available","renting","sold","reserved","disabled"],
  "accounts": [ { "steam_id":"…","account_name":"…","status":"sold","email":"…","email_password":"…","sent_gifts":[…] } ] }
```
> ⚠ `credentials=1` returns **plaintext passwords**. Only request them when you're
> delivering; prefer `claim`, which returns credentials only for what it sold.

---

## 4. (Optional) Set a status — `POST /api/accounts/<steam_id>/status`

```
POST /api/accounts/76561199…/status
{ "status": "available" }   # one of: available, renting, sold, reserved, disabled
```
Use to hand an account back (`available`), mark `reserved`/`renting`, etc. Not
needed for normal delivery — `claim` already stamps `sold` + the order.

---

## Errors
| Code | Meaning |
|---|---|
| `401 {"error":"unauthorized"}` | missing/wrong token, or you sent the **dashboard** token (which now needs a password). Send the **`FEED_TOKEN`**. |
| `400` | bad input (unknown status, invalid `order`, …) |
| `200` with `short:true` | order under-filled — decide server-side |

## Quick smoke test
```
curl -H "X-Dashboard-Token: $FEED_TOKEN" https://steam-dashboard.fungamingsteam.workers.dev/api/shop/gift-items
curl -H "X-Dashboard-Token: $FEED_TOKEN" -H 'Content-Type: application/json' \
     -d '{"order":"test-1","count":1}' https://steam-dashboard.fungamingsteam.workers.dev/api/shop/claim
```
JSON back = working. (The second one really sells one account to order `test-1`;
re-running returns the same account, and you can set it back with the status
endpoint.)
