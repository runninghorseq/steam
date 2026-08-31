// pm2 config for the dashboard. Start on the server with:
//   DASHBOARD_TOKEN=<your-secret> pm2 start ecosystem.config.js
//   pm2 save          # persist across reboots
// pm2 inherits the shell environment at start, so DASHBOARD_TOKEN is picked up.
// The token is NOT stored here — never commit secrets.
module.exports = {
  apps: [{
    name: 'steam',
    script: 'server.js',
    cwd: __dirname,
    env_file: '/opt/steam/.env',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    max_memory_restart: '500M',
    time: true,
  }],
};
