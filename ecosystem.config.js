// pm2 config for the box. Start with:
//   pm2 start ecosystem.config.js
//   pm2 save                       # persist across reboots
//   pm2 restart steam --update-env # after changing env below or the .env file
//
// Runs server.js — the box's job runner that the Cloudflare Worker proxies
// Steam-login actions (Refresh wallet / Scan / Sync / Playtime) to. The box
// writes job results straight to Turso (libSQL) — the SAME database the
// dashboard Worker reads — so a scan/wallet/sync/playtime immediately shows up
// in the dashboard. The box is a Node process, so these (often large, chunked)
// writes have no Cloudflare Worker subrequest limit.
//
// Secrets (DASHBOARD_TOKEN, TURSO_AUTH_TOKEN) go in /opt/steam/.env — never
// commit them. The non-secret Turso URL lives here for visibility.
//
// store.js backend precedence: WORKER_URL (push to the Worker) > TURSO_DATABASE_URL
// (write Turso directly, this setup) > CF_* (legacy D1) > local file. So do NOT
// set WORKER_URL or the CF_*/D1_* vars here — their presence would divert writes.
module.exports = {
  apps: [{
    name: 'steam',
    script: 'server.js',
    cwd: __dirname,
    env_file: '/opt/steam/.env',   // DASHBOARD_TOKEN=... and TURSO_AUTH_TOKEN=...
    env: {
      TURSO_DATABASE_URL: 'libsql://steam-phamtuyenhien.aws-ap-northeast-1.turso.io',
    },
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    max_memory_restart: '500M',
    time: true,
  }],
};
