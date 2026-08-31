// Export DB rows as plain INSERT statements (D1-safe — no unistr()).
// Usage: node cf/export_data.js <out.sql> [friendsLimit]
const { db } = require('../db');
const fs = require('fs');
const out = process.argv[2] || 'cf/data.sql';
const friendsLimit = process.argv[3] ? parseInt(process.argv[3], 10) : 0;

const esc = (v) => v === null || v === undefined ? 'NULL'
    : typeof v === 'number' ? String(v)
    : typeof v === 'bigint' ? String(v)
    : `'${String(v).replace(/'/g, "''")}'`;

function dump(table, limit) {
    const rows = db.prepare(`SELECT * FROM ${table}${limit ? ` LIMIT ${limit}` : ''}`).all();
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    const lines = rows.map((r) => `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => esc(r[c])).join(', ')});`);
    return lines.join('\n') + '\n';
}

const tables = [
    ['accounts'], ['auth_tokens'], ['licenses'], ['license_apps'],
    ['pending_gifts'], ['sent_gifts'], ['account_loans'], ['feedback'],
    ['friends', friendsLimit],
];
let sql = 'PRAGMA defer_foreign_keys = true;\n';
for (const [t, lim] of tables) sql += dump(t, lim);
fs.writeFileSync(out, sql);
const n = (sql.match(/^INSERT/gm) || []).length;
console.log(`wrote ${n} INSERT statements to ${out}`);
