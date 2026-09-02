// Turso (libSQL) client for Node — a drop-in for cf/d1_node.js so store.js can
// talk to a Turso database instead of Cloudflare D1. libSQL is a SQLite fork, so
// every query in store.js runs unchanged (and there's no D1 100-bound-param cap).
//
// Configure on the box (env / ~/.zshenv / pm2 env):
//   TURSO_DATABASE_URL=libsql://<db>-<org>.turso.io   (or file:local.db for testing)
//   TURSO_AUTH_TOKEN=<token from `turso db tokens create <db>`>
//
// enabled() is true when a URL is set; token is optional for file: URLs.

const clean = (v) => (v || '').trim().replace(/^["']|["']$/g, '');
const URL_ = clean(process.env.TURSO_DATABASE_URL);
const TOKEN = clean(process.env.TURSO_AUTH_TOKEN);

const enabled = () => !!URL_;

// Lazy so `require('./cf/turso')` is safe even when @libsql/client isn't needed
// (local/D1 modes) — the client is only constructed on first use.
let _client = null;
function client() {
    if (!_client) {
        const { createClient } = require('@libsql/client');
        _client = createClient({ url: URL_, authToken: TOKEN || undefined });
    }
    return _client;
}

// libSQL Row objects are array-like with named columns; spread to a plain object
// so callers (and JSON.stringify) see the same shape D1 returns.
const plain = (row) => (row ? { ...row } : row);

// Same signatures store.js expects from cf/d1_node.js.
async function d1all(sql, params = []) { const rs = await client().execute({ sql, args: params }); return rs.rows.map(plain); }
async function d1first(sql, params = []) { const rs = await client().execute({ sql, args: params }); return rs.rows[0] ? plain(rs.rows[0]) : null; }
async function d1run(sql, params = []) { const rs = await client().execute({ sql, args: params }); return { changes: Number(rs.rowsAffected || 0), lastInsertRowid: rs.lastInsertRowid }; }

module.exports = { d1all, d1first, d1run, enabled };
