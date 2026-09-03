// One-time catch-up: copy data stranded in the box's local steam_accounts.db
// (accumulated before the Turso cutover, so the D1->Turso import missed it) into
// Turso:
//   * management flags — skip_wallet, loan_id (UPDATE by steam_id), so e.g.
//     "Refresh wallets/levels" excludes skip_wallet accounts.
//   * auth_tokens + sent_gifts (INSERT OR IGNORE), which "sync sent gifts" and
//     every login job need — without them the sweep finds "no accounts …".
// INSERT OR IGNORE is additive: it fills gaps and never clobbers a newer Turso
// row. Idempotent; safe to re-run.
//
//   set -a; . /opt/steam/.env; set +a        # TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
//   node sync_flags_to_turso.js [--dry-run]

const path = require('path');
const Database = require('better-sqlite3');
const { createClient } = require('@libsql/client');

const url = (process.env.TURSO_DATABASE_URL || '').trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim() || undefined;
const dryRun = process.argv.includes('--dry-run');
if (!url) { console.error('✗ TURSO_DATABASE_URL not set (source /opt/steam/.env first).'); process.exit(1); }

const local = new Database(path.join(__dirname, 'steam_accounts.db'), { readonly: true, fileMustExist: true });
const skip = local.prepare('SELECT steam_id FROM accounts WHERE skip_wallet = 1 AND steam_id IS NOT NULL').all().map((r) => r.steam_id);
const loaned = local.prepare('SELECT steam_id, loan_id FROM accounts WHERE loan_id IS NOT NULL AND steam_id IS NOT NULL').all();
console.log(`Local flags — skip_wallet: ${skip.length}, loaned: ${loaned.length}${dryRun ? '  (DRY RUN)' : ''}`);

const turso = createClient({ url, authToken });
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

(async () => {
    if (dryRun) {
        const tState = (await turso.execute('SELECT (SELECT COUNT(*) c FROM accounts WHERE skip_wallet=1) skip, (SELECT COUNT(*) c FROM auth_tokens) tokens, (SELECT COUNT(*) c FROM sent_gifts) sent')).rows[0];
        const lTok = local.prepare('SELECT COUNT(*) c FROM auth_tokens').get().c;
        const lSg = local.prepare('SELECT COUNT(*) c FROM sent_gifts').get().c;
        console.log(`Turso now: skip_wallet=${tState.skip}, auth_tokens=${tState.tokens}, sent_gifts=${tState.sent}`);
        console.log(`Local has: skip_wallet=${skip.length}, auth_tokens=${lTok}, sent_gifts=${lSg}`);
        console.log('Re-run without --dry-run to sync the difference.');
        process.exit(0);
    }
    let n = 0;
    for (const c of chunk(skip, 100)) {
        await turso.batch(c.map((id) => ({ sql: 'UPDATE accounts SET skip_wallet = 1, updated_at = unixepoch() WHERE steam_id = ?', args: [id] })), 'write');
        n += c.length;
    }
    for (const c of chunk(loaned, 100)) {
        await turso.batch(c.map((r) => ({ sql: 'UPDATE accounts SET loan_id = ?, updated_at = unixepoch() WHERE steam_id = ?', args: [r.loan_id, r.steam_id] })), 'write');
    }
    const after = (await turso.execute('SELECT COUNT(*) c FROM accounts WHERE skip_wallet = 1')).rows[0].c;
    console.log(`Applied ${n} skip_wallet + ${loaned.length} loan flag(s). Turso now has skip_wallet=1: ${after}.`);

    // Cached login tokens + sent gifts stranded from the local-mode period. These
    // are what "sync sent gifts" and every login job need. INSERT OR IGNORE is
    // additive: it fills in rows Turso is missing and never clobbers a newer one.
    const tokens = local.prepare('SELECT account_name, refresh_token, created_at, updated_at FROM auth_tokens WHERE account_name IS NOT NULL').all();
    for (const c of chunk(tokens, 100)) {
        await turso.batch(c.map((t) => ({ sql: 'INSERT OR IGNORE INTO auth_tokens (account_name, refresh_token, created_at, updated_at) VALUES (?, ?, ?, ?)', args: [t.account_name, t.refresh_token, t.created_at, t.updated_at] })), 'write');
    }
    const gcols = ['gift_id', 'account_steam_id', 'recipient_steam_id', 'recipient_name', 'item_name', 'detail', 'sent_at', 'status', 'store_url', 'scanned_at', 'created_at', 'updated_at'];
    const gifts = local.prepare(`SELECT ${gcols.join(', ')} FROM sent_gifts`).all();
    for (const c of chunk(gifts, 100)) {
        await turso.batch(c.map((g) => ({ sql: `INSERT OR IGNORE INTO sent_gifts (${gcols.join(', ')}) VALUES (${gcols.map(() => '?').join(', ')})`, args: gcols.map((k) => g[k] ?? null) })), 'write');
    }
    const tks = (await turso.execute('SELECT COUNT(*) c FROM auth_tokens')).rows[0].c;
    const sg = (await turso.execute('SELECT COUNT(*) c FROM sent_gifts')).rows[0].c;
    console.log(`Synced tokens + sent_gifts. Turso now has auth_tokens: ${tks}, sent_gifts: ${sg}.`);
    process.exit(0);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
