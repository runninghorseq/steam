/**
 * Tells you which deploy permission your API token is missing.
 *
 * Cloudflare's own errors do not: a token with no D1 grant fails the deploy with
 * "The given account is not valid or is not authorized to access this service
 * [code: 7403]", which reads like a wrong account id and is not one. This probes
 * each endpoint `npm run deploy` actually calls and names the permission behind it.
 *
 * The steam-dashboard Worker is served on its *.workers.dev hostname (no custom
 * routes / zone), so only two account-level grants matter.
 *
 * Usage:  npm run deploy:check
 */

import { accountId as account, sources, token } from './_cfenv.mjs';

const API = 'https://api.cloudflare.com/client/v4';

if (!token) {
  console.error('✗ No CLOUDFLARE_API_TOKEN (checked the environment and .env.deploy).');
  process.exit(1);
}
if (!account) {
  console.error('✗ No CLOUDFLARE_ACCOUNT_ID (checked the environment and .env.deploy).');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${token}` };
async function probe(path) {
  const resp = await fetch(`${API}${path}`, { headers });
  const data = await resp.json().catch(() => ({}));
  const errs = (data.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ');
  return { ok: data.success === true, status: resp.status, errs };
}

const checks = [
  ['Account · Workers Scripts · Edit', `/accounts/${account}/workers/scripts`, 'upload the worker + its assets'],
  ['Account · D1 · Edit             ', `/accounts/${account}/d1/database`, 'wrangler d1 migrations apply --remote'],
];

console.log(
  `Token   from ${sources.CLOUDFLARE_API_TOKEN}\n` +
    `Account ${account}\n`
);

let missing = 0;
for (const [label, path, why] of checks) {
  const r = await probe(path);
  if (r.ok) {
    console.log(`${label}  ✓`);
  } else {
    missing++;
    console.log(`${label}  ✗ ${why}\n    ${r.status} ${r.errs || '(no detail)'}`);
  }
}

if (missing) {
  console.error(`\n✗ ${missing} permission(s) missing. Dashboard → My Profile → API Tokens → Create Custom Token.`);
  process.exit(1);
}
console.log('\n✓ Token can deploy the worker and migrate D1.');
