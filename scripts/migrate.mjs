/**
 * Apply migrations/*.sql to the Turso (libSQL) database.
 *
 * Importing _cfenv.mjs for its side effect loads TURSO_DATABASE_URL /
 * TURSO_AUTH_TOKEN from .env.deploy (or the environment) so a bare
 * `npm run migrate` authenticates without any interactive setup.
 *
 *   node scripts/migrate.mjs                     apply pending migrations
 *   node scripts/migrate.mjs --list              show applied / pending
 *   node scripts/migrate.mjs --baseline <name>   mark every migration up to and
 *                                                including <name> as applied
 *                                                WITHOUT running it — for a DB
 *                                                already carrying that schema
 *                                                (e.g. imported from D1).
 *
 * Point at a throwaway local file for testing:
 *   TURSO_DATABASE_URL=file:./local.db node scripts/migrate.mjs
 *
 * Tracking lives in the `d1_migrations` table with the SAME shape wrangler d1
 * uses (id / name / applied_at), so migrations already recorded there — e.g.
 * carried over when the D1 data was imported into Turso — are not re-run.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import './_cfenv.mjs';
import { createClient } from '@libsql/client';

const url = (process.env.TURSO_DATABASE_URL || '').trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim() || undefined;
const list = process.argv.includes('--list');
const baselineIdx = process.argv.indexOf('--baseline');
const baseline = baselineIdx >= 0 ? process.argv[baselineIdx + 1] : null;

if (!url) {
  console.error('✗ TURSO_DATABASE_URL not set. Put TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN) in .env.deploy (see .env.deploy.example) or the environment.');
  process.exit(1);
}

const migDir = fileURLToPath(new URL('../migrations/', import.meta.url));
const files = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();

const client = createClient({ url, authToken });

// Same tracking table wrangler d1 migrations creates, so state is interchangeable.
await client.execute(
  'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)'
);
const applied = new Set((await client.execute('SELECT name FROM d1_migrations')).rows.map((r) => r.name));
const pending = files.filter((f) => !applied.has(f));

const label = url.startsWith('file:') ? url : url.replace(/^libsql:\/\//, '');

// Baseline: record migrations up to <name> as applied without executing them.
if (baseline) {
  if (!files.includes(baseline)) {
    console.error(`✗ no such migration: ${baseline}\n  known: ${files.join(', ')}`);
    process.exit(1);
  }
  const upto = files.filter((f) => f <= baseline);
  for (const f of upto) await client.execute({ sql: 'INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)', args: [f] });
  console.log(`Baselined ${upto.length} migration(s) as applied on ${label} (up to ${baseline}), ran none:`);
  upto.forEach((f) => console.log(`  ✓ ${f}`));
  console.log(`\nNext: npm run migrate  — applies anything after ${baseline}.`);
  process.exit(0);
}

if (list) {
  console.log(`Database: ${label}`);
  for (const f of files) console.log(`  ${applied.has(f) ? '✓ applied' : '• pending'}  ${f}`);
  console.log(`\n${applied.size} applied, ${pending.length} pending.`);
  process.exit(0);
}

if (!pending.length) {
  console.log(`No pending migrations (${applied.size} already applied on ${label}).`);
  process.exit(0);
}

console.log(`Applying ${pending.length} migration(s) to ${label}:`);
for (const f of pending) {
  process.stdout.write(`  ${f} … `);
  try {
    await client.executeMultiple(readFileSync(join(migDir, f), 'utf8'));
    await client.execute({ sql: 'INSERT INTO d1_migrations (name) VALUES (?)', args: [f] });
    console.log('ok');
  } catch (e) {
    console.log('FAILED');
    console.error(`\n✗ ${f}: ${e.message}`);
    process.exit(1);
  }
}
console.log(`\nApplied ${pending.length} migration(s).`);
process.exit(0);
