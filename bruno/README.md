# Steam Dashboard API — Bruno collection

Requests for the dashboard/API served by the Cloudflare Worker (and, where a
route is proxied, the Debian box). Open this folder in [Bruno](https://usebruno.com).

## Setup
1. Open the collection in Bruno (File → Open Collection → pick this `bruno/` folder).
2. Pick an environment (top-right): **Worker (prod)**, **Box**, or **Local**.
3. Set the `token` variable in that environment to your `DASHBOARD_TOKEN`.
   It ships **blank** on purpose — the token is a secret, don't commit it.

Every request sends `X-Dashboard-Token: {{token}}`; `{{baseUrl}}` comes from the
environment.

## Environments
- **Worker (prod)** — `https://steam-dashboard.fungamingsteam.workers.dev` (the main API; DB reads on Turso, Steam-login actions proxied to the box).
- **Box** — `https://steam.fungamingvn.space` (the box directly; reads may be stale — prefer the Worker).
- **Local** — `http://127.0.0.1:3011` (a local `node server.js`).

## Notes
- POST bodies are example payloads — edit before sending.
- `Delete Account` returns 501 on the Worker (box-only).
- `Accounts Feed` can also be read with a scoped `FEED_TOKEN` instead of the dashboard token.
- `Internal/Ingest` is the box→Worker data plane; you normally won't call it by hand.
