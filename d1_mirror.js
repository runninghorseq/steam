// Mirror local DB writes to Cloudflare D1 over the HTTP API, so a box that runs
// the Steam-login jobs keeps D1 (the dashboard's source of truth) in sync.
//
// No-op unless ALL of these are set:
//   D1_MIRROR=1
//   CLOUDFLARE_ACCOUNT_ID=<account id>
//   D1_DATABASE_ID=<d1 database uuid>
//   CLOUDFLARE_API_TOKEN=<token with D1 Edit on that account>
//
// db.js calls this after each local write. Enqueue is synchronous (never blocks
// the Steam job); statements are batched and POSTed to D1 in the background.
// Call flushNow() before a short-lived CLI process exits so nothing is dropped.

const https = require('https');
const http = require('http');
// Override the API host for testing/self-hosted (e.g. 127.0.0.1:9999 uses http).

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const DB_ID = process.env.D1_DATABASE_ID || '';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const active = process.env.D1_MIRROR === '1' && !!(ACCOUNT_ID && DB_ID && TOKEN);

const MAX_BATCH = 200;
const FLUSH_MS = 2000;
let queue = [];
let flushing = false;
let flushTimer = null;
let dropped = 0;

function esc(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'bigint') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
}
function upsertStmt(table, row) {
    const cols = Object.keys(row);
    if (!cols.length) return '';
    return `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => esc(row[c])).join(', ')});`;
}
function deleteStmt(table, col, val) {
    return `DELETE FROM ${table} WHERE ${col} = ${esc(val)};`;
}

function enqueue(sql) {
    if (!active || !sql) return;
    queue.push(sql);
    if (queue.length >= MAX_BATCH) flush();
    else scheduleFlush();
}
function scheduleFlush() {
    if (flushTimer || !queue.length) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();
}

const API_HOST = process.env.D1_API_HOST || 'api.cloudflare.com';
function d1Query(sql) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ sql });
        const [host, port] = API_HOST.split(':');
        const isLocal = host === '127.0.0.1' || host === 'localhost';
        const transport = isLocal ? http : https;
        const req = transport.request({
            host,
            port: port ? Number(port) : (isLocal ? 80 : 443),
            path: `/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`,
            method: 'POST',
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                let j;
                try { j = JSON.parse(data); } catch (_) { return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 160)}`)); }
                if (j.success) resolve(j);
                else reject(new Error((j.errors || []).map((e) => e.message).join('; ') || `HTTP ${res.statusCode}`));
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error('timeout')));
        req.write(body);
        req.end();
    });
}

async function flush() {
    if (!active || flushing || queue.length === 0) return;
    flushing = true;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const batch = queue.splice(0, MAX_BATCH);
    try {
        await d1Query(batch.join('\n'));
    } catch (err) {
        // Re-queue for one retry cycle; cap total backlog so a persistent D1
        // outage can't grow memory unbounded.
        console.error(`[d1-mirror] flush failed (${batch.length} stmts): ${err.message}`);
        if (queue.length < 5000) queue.unshift(...batch);
        else { dropped += batch.length; console.error(`[d1-mirror] backlog full — dropped ${batch.length} (total dropped ${dropped})`); }
    } finally {
        flushing = false;
        if (queue.length) scheduleFlush();
    }
}

// Public API used by db.js. Each accepts the CURRENT local rows (post-write) and
// mirrors them idempotently to D1.
module.exports = {
    active,
    // Upsert one row (e.g. the accounts row after saveAccount).
    upsert(table, row) { if (row) enqueue(upsertStmt(table, row)); },
    // Replace every row a table holds for one account (delete-then-insert).
    replaceForAccount(table, col, val, rows) {
        enqueue(deleteStmt(table, col, val));
        for (const r of rows || []) enqueue(upsertStmt(table, r));
    },
    // Delete matching rows.
    deleteWhere(table, col, val) { enqueue(deleteStmt(table, col, val)); },
    // Run raw statements (used for the loan/skip-wallet single-column updates).
    raw(sql) { enqueue(sql.endsWith(';') ? sql : sql + ';'); },
    esc,
    _upsertStmt: upsertStmt,
    _deleteStmt: deleteStmt,
    // Flush everything and wait — call before a CLI process exits.
    async flushNow() { if (!active) return; while (queue.length || flushing) { await flush(); if (flushing) await new Promise((r) => setTimeout(r, 50)); } },
    pending() { return queue.length; },
};
