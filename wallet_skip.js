// Mark accounts whose wallet/level nobody tracks, so update_wallet_level.js stops
// logging into them. The flag lives in accounts.skip_wallet (0/1) and only affects
// the modes that write those columns: '--mode=all' and '--mode=wallet' drop the
// flagged accounts, '--mode=gifts' still includes them.
//
// This talks to the dashboard API (Cloudflare Worker over D1) — the source of
// truth — instead of a local DB. Override the base with STEAM_API_BASE; token via
// STEAM_API_TOKEN / DASHBOARD_TOKEN.
//
// Usage:
//   node wallet_skip.js list                          # show flagged accounts
//   node wallet_skip.js add <name> [name...]          # flag by account name
//   node wallet_skip.js remove <name> [name...]       # unflag
//   node wallet_skip.js add --level0                  # flag every level-0 account
//   node wallet_skip.js add --zero-wallet             # balance exactly 0
//   node wallet_skip.js add --max-wallet=1.00         # balance below 1.00 (any currency)
//   node wallet_skip.js add --currency=RUB
//   node wallet_skip.js add --no-token                # no cached refresh token
//   node wallet_skip.js add --where="steam_level = 0 AND wallet_currency = 'RUB'"
//   node wallet_skip.js add --level0 --dry-run        # preview, change nothing
//
// Filters combine with AND. Every command prints what it matched before touching
// anything, and --dry-run stops there.

const API_BASE = (process.env.STEAM_API_BASE || 'https://steam-dashboard.fungamingsteam.workers.dev').replace(/\/+$/, '');
const API_TOKEN = process.env.STEAM_API_TOKEN || process.env.DASHBOARD_TOKEN || '';

async function api(path, method, bodyObj) {
    const headers = {
        Accept: 'application/json',
        // Cloudflare fronts the domain and blocks non-browser signatures.
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    };
    if (bodyObj) headers['Content-Type'] = 'application/json';
    if (API_TOKEN) headers['X-Dashboard-Token'] = API_TOKEN;
    let resp;
    try {
        resp = await fetch(API_BASE + path, { method, headers, body: bodyObj ? JSON.stringify(bodyObj) : undefined });
    } catch (e) {
        throw new Error(`API unreachable at ${API_BASE} (${e.message})`);
    }
    if (resp.status === 401) throw new Error('API 401 unauthorized — set STEAM_API_TOKEN to match the server DASHBOARD_TOKEN');
    if (!resp.ok) throw new Error(`API ${path} -> HTTP ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
    return resp.json();
}

const argv = process.argv.slice(2);
const COMMAND = (argv.shift() || '').toLowerCase();
const flags = {};
const names = [];
argv.forEach((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
    else names.push(a);
});

function usage(code = 1) {
    console.log(`Usage:
  node wallet_skip.js list
  node wallet_skip.js add    <name...> | --level0 | --zero-wallet | --max-wallet=<amt>
                             | --currency=<CC> | --no-token | --where="<sql>"
  node wallet_skip.js remove <name...> | (same filters) | --all
  Add --dry-run to preview.`);
    process.exit(code);
}

// Build a WHERE clause from the given filters. Returns { sql, params, described }.
// The server plugs `sql` into a parameterized query; --where is your own input.
function buildFilter() {
    const clauses = [];
    const params = [];
    const described = [];

    if (names.length) {
        clauses.push(`lower(account_name) IN (${names.map(() => '?').join(', ')})`);
        params.push(...names.map((n) => n.toLowerCase()));
        described.push(`names: ${names.join(', ')}`);
    }
    if (flags.level0) { clauses.push('(steam_level = 0 OR steam_level IS NULL)'); described.push('level 0'); }
    if (flags['zero-wallet']) { clauses.push('(wallet_balance_cents = 0 OR wallet_balance_cents IS NULL)'); described.push('wallet 0'); }
    if (typeof flags['max-wallet'] === 'string') {
        const cents = Math.round(Number(flags['max-wallet']) * 100);
        if (!Number.isFinite(cents)) { console.error(`--max-wallet must be a number, got '${flags['max-wallet']}'`); process.exit(1); }
        clauses.push('(wallet_balance_cents IS NULL OR wallet_balance_cents < ?)'); params.push(cents); described.push(`wallet < ${flags['max-wallet']}`);
    }
    if (typeof flags.currency === 'string') { clauses.push('wallet_currency = ?'); params.push(flags.currency); described.push(`currency ${flags.currency}`); }
    if (flags['no-token']) { clauses.push('(account_name IS NULL OR lower(account_name) NOT IN (SELECT lower(account_name) FROM auth_tokens))'); described.push('no cached token'); }
    if (typeof flags.where === 'string') { clauses.push(`(${flags.where})`); described.push(`where: ${flags.where}`); }
    if (flags.all) { clauses.push('1 = 1'); described.push('ALL flagged accounts'); }

    if (clauses.length === 0) return null;
    return { sql: clauses.join(' AND '), params, described: described.join(' AND ') };
}

function show(rows) {
    rows.forEach((r) => {
        const bal = r.wallet_balance_cents == null ? '-' : (r.wallet_balance_cents / 100).toFixed(2);
        console.log(`  ${String(r.account_name ?? r.steam_id).padEnd(24)} ${String(r.wallet_currency ?? '').padEnd(8)}${bal.padStart(9)}  lvl ${String(r.steam_level ?? '-').padStart(3)}${r.loan_id != null ? '  [loaned]' : ''}`);
    });
}

(async () => {
    try {
        if (COMMAND === 'list') {
            const rows = await api('/api/accounts?filter=skip_wallet', 'GET');
            const all = await api('/api/summary', 'GET');
            console.log(`\n=== skip_wallet accounts: ${rows.length}/${all.accounts} ===`);
            if (rows.length) show(rows);
            else console.log('  (none — every account is refreshed)');
            return;
        }

        if (!['add', 'remove'].includes(COMMAND)) usage();

        const filter = buildFilter();
        if (!filter) {
            console.error('No account names or filters given — refusing to touch every row.');
            usage();
        }

        const target = COMMAND === 'add' ? 1 : 0;
        const res = await api('/api/accounts/skip-wallet-bulk', 'POST', {
            where: filter.sql, params: filter.params, target, commit: !flags['dry-run'],
        });

        console.log(`\nAPI: ${API_BASE}`);
        console.log(`Filter: ${filter.described}`);
        console.log(`${COMMAND === 'add' ? 'Would flag' : 'Would unflag'} ${res.rows.length} account(s):`);
        if (res.rows.length) show(res.rows);

        if (res.rows.length === 0) { console.log('Nothing to change.'); return; }
        if (flags['dry-run']) { console.log('\n--dry-run: nothing was changed.'); return; }
        console.log(`\n${COMMAND === 'add' ? 'Flagged' : 'Unflagged'} ${res.changed} account(s). Total skip_wallet: ${res.totalFlagged}.`);
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
})();
