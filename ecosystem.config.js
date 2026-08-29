// pm2 config for the dashboard. Start on the server with:
//   DASHBOARD_TOKEN=<your-secret> pm2 start ecosystem.config.js
//   pm2 save          # persist across reboots
// pm2 inherits the shell environment at start, so DASHBOARD_TOKEN is picked up.
// The token is NOT stored here — never commit secrets.
module.exports = {
  apps: [{
    name: 'steam',
    script: 'server.js',
    args: '--host=0.0.0.0',   // expose on the network (Cloudflare/nginx sits in front)
    cwd: __dirname,
    autorestart: true,
    max_restarts: 10,
    env: {
      // DASHBOARD_TOKEN: '...'  // provide via the shell instead, e.g.
      //   DASHBOARD_TOKEN=xxxx pm2 start ecosystem.config.js
    },
  }],
};
