#!/usr/bin/env bash
# Migrate D1, then deploy the steam-dashboard Worker — authenticating with an
# API token read from a gitignored .env.deploy at the repo root.
#
# The token is exported here so `npm run deploy` behaves the same whatever is in
# your shell. `wrangler login` refuses to run when any CLOUDFLARE_API_TOKEN is
# set (it thinks you are already logged in), so a scoped deploy token in
# .env.deploy is the reliable way to authenticate a non-interactive deploy.
#
# There is no build step: the Worker is cf/worker.js and it serves the static
# dashboard straight out of web/ (see wrangler.jsonc `assets.directory`).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -f .env.deploy ]; then
  set -a
  . ./.env.deploy
  set +a
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  cat >&2 <<'MSG'
✗ No CLOUDFLARE_API_TOKEN.

  Create .env.deploy at the repo root (see .env.deploy.example) with a token
  scoped for this project:

    Account · Workers Scripts · Edit    upload the worker + its assets
    Account · D1 · Edit                 wrangler d1 migrations apply --remote

  Dashboard → My Profile → API Tokens → Create Token → Create Custom Token.
  Then `npm run deploy:check` names any permission the token is still missing.
MSG
  exit 1
fi

# Apply any pending D1 migrations to production BEFORE the new worker goes live,
# so the code never runs against a schema that predates it.
npm run migrate
npx wrangler deploy
