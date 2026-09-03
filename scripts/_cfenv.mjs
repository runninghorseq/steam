/**
 * Cloudflare credentials for scripts that shell out to `wrangler … --remote`.
 *
 * Importing this module puts CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID into
 * process.env, so the wrangler child process authenticates with the deploy token
 * instead of an OAuth session (there is none on this box) and `migrations apply
 * --remote` can reach D1.
 *
 * Precedence (an explicit env var wins, so `TURSO_DATABASE_URL=file:… npm run
 * migrate` or `migrate:local` targets what you asked for — NOT the prod URL in
 * .env.deploy):
 *   1. the environment — a value exported or set inline for this run.
 *   2. .env.deploy     — the deploy token / prod URL for the normal flow.
 *   3. .env            — last resort, so the repo still reaches the service and
 *                        fails with a permissions error that says so.
 */

import { readFileSync } from 'node:fs';

const KEYS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'];

function readEnvFile(name) {
  const found = {};
  let text;
  try {
    text = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
  } catch {
    return found;
  }
  for (const line of text.split(/\r?\n/)) {
    // `export FOO=bar` as well as `FOO=bar`: .env is also sourced by a shell.
    const m = /^[ \t]*(?:export[ \t]+)?([A-Z_][A-Z0-9_]*)[ \t]*=[ \t]*(.*?)[ \t]*$/.exec(line);
    if (m && KEYS.includes(m[1]) && m[2]) found[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return found;
}

const deploy = readEnvFile('.env.deploy');
const fallback = readEnvFile('.env');

/** Where each value came from, for a script that wants to say so. */
export const sources = {};

for (const key of KEYS) {
  const candidates = [
    ['environment', process.env[key]],
    ['.env.deploy', deploy[key]],
    ['.env', fallback[key]],
  ];
  const hit = candidates.find(([, value]) => value);
  if (!hit) continue;
  [sources[key], process.env[key]] = hit;
}

export const token = process.env.CLOUDFLARE_API_TOKEN ?? null;
export const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? null;
