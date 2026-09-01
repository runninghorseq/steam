// pm2 config for the box. Start with:
//   pm2 start ecosystem.config.js
//   pm2 save                       # persist across reboots
//   pm2 restart steam --update-env # after changing env below or the .env file
//
// This runs server.js — the box's job runner that the Cloudflare Worker proxies
// Steam-login actions (Refresh wallet / Scan / Sync / Playtime) to. The D1
// write-through is NOT a separate process: it lives inside server.js (via
// db.js -> d1_mirror.js) and activates when the D1_* vars below are present, so
// every wallet/scan/sync/playtime write also lands in D1 and the dashboard
// reflects it.
//
// Secrets (DASHBOARD_TOKEN, CLOUDFLARE_API_TOKEN) go in /opt/steam/.env — never
// commit them. The non-secret D1 identifiers live here for visibility.
module.exports = {
  apps: [{
    name: 'steam',
    script: 'server.js',
    cwd: __dirname,
    env_file: '/opt/steam/.env',   // DASHBOARD_TOKEN=... and CLOUDFLARE_API_TOKEN=...
    env: {
      // D1 write-through (mirror local writes to Cloudflare D1). The API token
      // must ALSO be set (in the .env file) or the mirror stays inactive.
      D1_MIRROR: '1',
      CLOUDFLARE_ACCOUNT_ID: '37280e9eb5701c9a72e1eb8d815c614a',
      D1_DATABASE_ID: '5d137a2b-599b-4621-99c1-aef4b0ebd93d',
    },
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    max_memory_restart: '500M',
    time: true,
  }],
};
