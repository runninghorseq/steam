// Minimal Cloudflare D1 HTTP client for Node (the Debian box), so the Steam-login
// jobs can write their results into the SAME D1 the Cloudflare Worker reads —
// keeping the deployed dashboard consistent with what the box does.
//
// Configure on the box (env or ~/.zshenv / systemd Environment=):
//   CF_ACCOUNT_ID=37280e9eb5701c9a72e1eb8d815c614a
//   CF_D1_DATABASE_ID=5d137a2b-599b-4621-99c1-aef4b0ebd93d
//   CF_API_TOKEN=<token with D1 Edit on that account>
//
// When those aren't set, mirroring is a no-op (the box just uses its local DB),
// so nothing breaks in a local-only setup.

const https = require('https');

// Reuse TLS connections across the many D1 calls a single scan makes — without
// keep-alive each call pays a fresh TCP+TLS handshake (~100ms). maxSockets bounds
// how many run concurrently (store.js fires chunks with Promise.all).
const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });

// Trim whitespace/CR and strip surrounding quotes so a stray char in the id
// can't land in the request path (ERR_UNESCAPED_CHARACTERS).
const clean = (v) => (v || '').trim().replace(/^["']|["']$/g, '');
const CF_ACCOUNT_ID = clean(process.env.CF_ACCOUNT_ID);
const CF_D1_DATABASE_ID = clean(process.env.CF_D1_DATABASE_ID);
const CF_API_TOKEN = clean(process.env.CF_API_TOKEN);

const enabled = () => !!(CF_ACCOUNT_ID && CF_D1_DATABASE_ID && CF_API_TOKEN);

// Run one SQL statement against D1. Resolves with the D1 result array.
function d1(sql, params = []) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ sql, params });
        const req = https.request({
            host: 'api.cloudflare.com',
            path: `/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_D1_DATABASE_ID}/query`,
            method: 'POST',
            agent,
            headers: {
                Authorization: `Bearer ${CF_API_TOKEN}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                let j;
                try { j = JSON.parse(body); } catch (e) { return reject(new Error(`D1 non-JSON (${res.statusCode}): ${body.slice(0, 120)}`)); }
                if (!j.success) return reject(new Error(`D1 error: ${JSON.stringify(j.errors)}`));
                resolve(j.result);
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}

// Replace one account's rows in a D1 table with the given local rows: delete the
// account's rows, then INSERT OR REPLACE each. Columns come from the first row.
// Statements run sequentially (per-job volumes are small). No-op when disabled.
async function mirrorAccountTable(table, accountCol, accountSteamID, rows, { log = () => {} } = {}) {
    if (!enabled()) return { mirrored: false, reason: 'D1 mirror not configured' };
    try {
        await d1(`DELETE FROM ${table} WHERE ${accountCol} = ?`, [accountSteamID]);
        if (rows.length) {
            const cols = Object.keys(rows[0]);
            // Multi-row INSERT in chunks to keep bound params < ~900 (SQLite cap)
            // and cut the number of HTTP round-trips (friends can be hundreds).
            const perChunk = Math.max(1, Math.floor(90 / cols.length)); // D1 caps bound params at 100/query
            const tuple = `(${cols.map(() => '?').join(', ')})`;
            for (let i = 0; i < rows.length; i += perChunk) {
                const chunk = rows.slice(i, i + perChunk);
                const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES ${chunk.map(() => tuple).join(', ')}`;
                const params = [];
                for (const r of chunk) for (const c of cols) params.push(r[c] ?? null);
                await d1(sql, params);
            }
        }
        log(`mirrored ${rows.length} row(s) -> D1.${table} for ${accountSteamID}`);
        return { mirrored: true, rows: rows.length };
    } catch (err) {
        log(`D1 mirror failed for ${table}/${accountSteamID}: ${err.message}`);
        return { mirrored: false, reason: err.message };
    }
}

// Upsert a single row keyed by its primary key(s). Used for the accounts row.
async function mirrorUpsertRow(table, row, { log = () => {} } = {}) {
    if (!enabled()) return { mirrored: false };
    try {
        const cols = Object.keys(row);
        const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
        await d1(sql, cols.map((c) => row[c] ?? null));
        log(`mirrored 1 row -> D1.${table}`);
        return { mirrored: true };
    } catch (err) {
        log(`D1 upsert failed for ${table}: ${err.message}`);
        return { mirrored: false, reason: err.message };
    }
}

// Convenience wrappers around d1(): rows / first-row / run.
async function d1all(sql, params = []) { const r = await d1(sql, params); return (r[0] && r[0].results) || []; }
async function d1first(sql, params = []) { return (await d1all(sql, params))[0] || null; }
async function d1run(sql, params = []) { const r = await d1(sql, params); return (r[0] && r[0].meta) || {}; }

module.exports = { d1, d1all, d1first, d1run, enabled, mirrorAccountTable, mirrorUpsertRow, CF_D1_DATABASE_ID };
