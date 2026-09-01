/**
 * `wrangler d1 migrations` with the deploy token loaded first.
 *
 * Importing _cfenv.mjs for its side effect puts CLOUDFLARE_API_TOKEN /
 * CLOUDFLARE_ACCOUNT_ID into the environment (from .env.deploy), so a bare
 * `npm run migrate` authenticates without a wrangler OAuth session — there is
 * none on the box.
 *
 *   node scripts/migrate.mjs --remote        apply pending migrations to prod
 *   node scripts/migrate.mjs --local         apply to the local .wrangler DB
 *   node scripts/migrate.mjs --list --remote  show applied/unapplied
 *
 * The D1 database is `steam` (wrangler.jsonc d1_databases[0].database_name).
 */

import { spawnSync } from 'node:child_process';
import { token } from './_cfenv.mjs';

const DB = 'steam';
const target = process.argv.includes('--local') ? '--local' : '--remote';
const list = process.argv.includes('--list');

if (target === '--remote' && !token) {
  console.error('✗ No CLOUDFLARE_API_TOKEN for a --remote migration. Put it in .env.deploy (see .env.deploy.example), or run --local.');
  process.exit(1);
}

const args = list
  ? ['wrangler', 'd1', 'migrations', 'list', DB, target]
  : ['wrangler', 'd1', 'migrations', 'apply', DB, target];

const r = spawnSync('npx', args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
