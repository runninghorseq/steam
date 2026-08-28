// Mark accounts whose wallet/level nobody tracks, so update_wallet_level.js stops
// logging into them. The flag lives in accounts.skip_wallet (0/1) and only affects
// the modes that write those columns: '--mode=all' and '--mode=wallet' drop the
// flagged accounts, '--mode=gifts' still includes them.
//
// This is separate from accounts.loan_id (set by lend_account.js), which freezes
// wallet_balance_cents / wallet_currency / steam_level inside db.saveAccount()
// no matter which script is writing.
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

const { db } = require('./db');

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
function buildFilter() {
    const clauses = [];
    const params = [];
    const described = [];

    if (names.length) {
        clauses.push(`lower(account_name) IN (${names.map(() => '?').join(', ')})`);
        params.push(...names.map((n) => n.toLowerCase()));
        described.push(`names: ${names.join(', ')}`);
    }
    if (flags.level0) {
        clauses.push('(steam_level = 0 OR steam_level IS NULL)');
        described.push('level 0');
    }
    if (flags['zero-wallet']) {
        clauses.push('(wallet_balance_cents = 0 OR wallet_balance_cents IS NULL)');
        described.push('wallet 0');
    }
    if (typeof flags['max-wallet'] === 'string') {
        const cents = Math.round(Number(flags['max-wallet']) * 100);
        if (!Number.isFinite(cents)) {
            console.error(`--max-wallet must be a number, got '${flags['max-wallet']}'`);
            process.exit(1);
        }
        clauses.push('(wallet_balance_cents IS NULL OR wallet_balance_cents < ?)');
        params.push(cents);
        described.push(`wallet < ${flags['max-wallet']}`);
    }
    if (typeof flags.currency === 'string') {
        clauses.push('wallet_currency = ?');
        params.push(flags.currency);
        described.push(`currency ${flags.currency}`);
    }
    if (flags['no-token']) {
        clauses.push('(account_name IS NULL OR lower(account_name) NOT IN (SELECT lower(account_name) FROM auth_tokens))');
        described.push('no cached token');
    }
    if (typeof flags.where === 'string') {
        clauses.push(`(${flags.where})`);
        described.push(`where: ${flags.where}`);
    }
    if (flags.all) {
        clauses.push('1 = 1');
        described.push('ALL flagged accounts');
    }

    if (clauses.length === 0) return null;
    return { sql: clauses.join(' AND '), params, described: described.join(' AND ') };
}

function show(rows) {
    rows.forEach((r) => {
        const bal = r.wallet_balance_cents == null ? '-' : (r.wallet_balance_cents / 100).toFixed(2);
        console.log(`  ${String(r.account_name ?? r.steam_id).padEnd(24)} ${String(r.wallet_currency ?? '').padEnd(8)}${bal.padStart(9)}  lvl ${String(r.steam_level ?? '-').padStart(3)}${r.loan_id != null ? '  [loaned]' : ''}`);
    });
}

const SELECT_COLS = 'steam_id, account_name, wallet_currency, wallet_balance_cents, steam_level, loan_id, skip_wallet';

if (COMMAND === 'list') {
    const rows = db.prepare(`SELECT ${SELECT_COLS} FROM accounts WHERE skip_wallet = 1 ORDER BY account_name`).all();
    const total = db.prepare('SELECT COUNT(*) c FROM accounts').get().c;
    console.log(`\n=== skip_wallet accounts: ${rows.length}/${total} ===`);
    if (rows.length) show(rows);
    else console.log('  (none — every account is refreshed)');
    process.exit(0);
}

if (!['add', 'remove'].includes(COMMAND)) usage();

const filter = buildFilter();
if (!filter) {
    console.error('No account names or filters given — refusing to touch every row.');
    usage();
}

const target = COMMAND === 'add' ? 1 : 0;
// Only rows that would actually change, so the count reported is the real delta.
const rows = db
    .prepare(`SELECT ${SELECT_COLS} FROM accounts WHERE (${filter.sql}) AND skip_wallet != ? ORDER BY account_name`)
    .all(...filter.params, target);

console.log(`\nFilter: ${filter.described}`);
console.log(`${COMMAND === 'add' ? 'Would flag' : 'Would unflag'} ${rows.length} account(s):`);
if (rows.length) show(rows);

if (rows.length === 0) {
    console.log('Nothing to change.');
    process.exit(0);
}

if (flags['dry-run']) {
    console.log('\n--dry-run: nothing was changed.');
    process.exit(0);
}

const update = db.prepare(
    `UPDATE accounts SET skip_wallet = ?, updated_at = unixepoch() WHERE steam_id = ?`
);
const applyAll = db.transaction((list) => {
    list.forEach((r) => update.run(target, r.steam_id));
});
applyAll(rows);

const nowFlagged = db.prepare('SELECT COUNT(*) c FROM accounts WHERE skip_wallet = 1').get().c;
console.log(`\n${COMMAND === 'add' ? 'Flagged' : 'Unflagged'} ${rows.length} account(s). Total skip_wallet: ${nowFlagged}.`);
