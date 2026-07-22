// Remove an account and all of its data from the DB.
//
// An account is identified by SteamID64 (17 digits, 7656119…) or by login name
// (case-insensitive). For each identifier the script resolves the matching
// (steam_id, account_name) via the accounts/auth_tokens tables, then deletes the
// rows the account OWNS:
//   accounts, auth_tokens, friends, licenses, license_apps,
//   pending_gifts (as recipient), sent_gifts (as sender)
//
// References to the account that live inside OTHER accounts' data are NOT
// removed by default (they're history you usually want to keep):
//   friends.friend_steam_id, sent_gifts.recipient_steam_id,
//   pending_gifts.sender_steam_id
// The script reports how many such references exist; pass --purge-refs to delete
// them too.
//
// Usage:
//   node remove_account.js <id> [<id> ...]      # remove each account
//   node remove_account.js --name=a,b,c         # comma list of names/ids
//   node remove_account.js --dry-run <id>       # preview, delete nothing
//   node remove_account.js --purge-refs <id>    # also delete cross-references
//
// Everything for a single account is deleted inside one transaction.

const { db } = require('./db');

const STEAMID64_RE = /^7656119\d{10}$/;

// Tables the account owns, keyed by account_steam_id.
const OWNED_BY_STEAMID = ['friends', 'licenses', 'license_apps', 'pending_gifts', 'sent_gifts'];

// Places the account is referenced from OTHER accounts' data: [table, column].
const REF_COLUMNS = [
    ['friends', 'friend_steam_id'],
    ['sent_gifts', 'recipient_steam_id'],
    ['pending_gifts', 'sender_steam_id']
];

// Resolve any identifier to { steam_id, account_name, persona } — fields are null
// when unknown. Tries SteamID64, then accounts.account_name, then auth_tokens.
function resolveAccount(ident) {
    if (STEAMID64_RE.test(ident)) {
        const row = db.prepare('SELECT steam_id, account_name, persona FROM accounts WHERE steam_id = ?').get(ident);
        const tok = db.prepare('SELECT account_name FROM auth_tokens WHERE lower(account_name) = lower(?)').get(row?.account_name ?? '');
        return { steam_id: ident, account_name: row?.account_name ?? tok?.account_name ?? null, persona: row?.persona ?? null };
    }
    const acc = db.prepare('SELECT steam_id, account_name, persona FROM accounts WHERE lower(account_name) = lower(?)').get(ident);
    if (acc) return { steam_id: acc.steam_id, account_name: acc.account_name, persona: acc.persona };
    const tok = db.prepare('SELECT account_name FROM auth_tokens WHERE lower(account_name) = lower(?)').get(ident);
    if (tok) return { steam_id: null, account_name: tok.account_name, persona: null };
    return { steam_id: null, account_name: null, persona: null };
}

function countOwned(steam_id) {
    const counts = {};
    if (!steam_id) return counts;
    for (const t of OWNED_BY_STEAMID) {
        counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE account_steam_id = ?`).get(steam_id).c;
    }
    counts.accounts = db.prepare('SELECT COUNT(*) AS c FROM accounts WHERE steam_id = ?').get(steam_id).c;
    return counts;
}

function countRefs(steam_id) {
    const counts = {};
    if (!steam_id) return counts;
    for (const [t, col] of REF_COLUMNS) {
        counts[`${t}.${col}`] = db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE ${col} = ?`).get(steam_id).c;
    }
    return counts;
}

function removeAccount(ident, { dryRun = false, purgeRefs = false } = {}) {
    const resolved = resolveAccount(ident);
    const { steam_id, account_name } = resolved;

    if (!steam_id && !account_name) {
        return { ident, resolved, found: false };
    }

    const owned = countOwned(steam_id);
    const refs = countRefs(steam_id);
    const tokenCount = account_name
        ? db.prepare('SELECT COUNT(*) AS c FROM auth_tokens WHERE lower(account_name) = lower(?)').get(account_name).c
        : 0;

    if (!dryRun) {
        const tx = db.transaction(() => {
            if (steam_id) {
                for (const t of OWNED_BY_STEAMID) {
                    db.prepare(`DELETE FROM ${t} WHERE account_steam_id = ?`).run(steam_id);
                }
                db.prepare('DELETE FROM accounts WHERE steam_id = ?').run(steam_id);
                if (purgeRefs) {
                    for (const [t, col] of REF_COLUMNS) {
                        db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(steam_id);
                    }
                }
            }
            if (account_name) {
                db.prepare('DELETE FROM auth_tokens WHERE lower(account_name) = lower(?)').run(account_name);
            }
        });
        tx();
    }

    return { ident, resolved, found: true, owned, refs, tokenCount, purgeRefs };
}

function parseArgs(argv) {
    const out = { dryRun: false, purgeRefs: false, idents: [] };
    for (const a of argv) {
        if (a === '--dry-run' || a === '-n') out.dryRun = true;
        else if (a === '--purge-refs') out.purgeRefs = true;
        else if (a.startsWith('--name=')) out.idents.push(...a.slice('--name='.length).split(',').map((s) => s.trim()).filter(Boolean));
        else if (a.startsWith('--names=')) out.idents.push(...a.slice('--names='.length).split(',').map((s) => s.trim()).filter(Boolean));
        else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
        else out.idents.push(a);
    }
    return out;
}

function runCli() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
    if (args.idents.length === 0) {
        console.error('usage: node remove_account.js [--dry-run] [--purge-refs] <steamid|name> [...]');
        process.exit(1);
    }

    if (args.dryRun) console.log('DRY RUN — nothing will be deleted.\n');

    let removed = 0;
    let notFound = 0;
    for (const ident of args.idents) {
        const res = removeAccount(ident, { dryRun: args.dryRun, purgeRefs: args.purgeRefs });
        if (!res.found) {
            console.log(`'${ident}': not found (no accounts/auth_tokens match)`);
            notFound++;
            continue;
        }
        removed++;
        const { resolved, owned, refs, tokenCount } = res;
        const label = resolved.persona ? ` "${resolved.persona}"` : '';
        console.log(`'${ident}' -> steam_id=${resolved.steam_id ?? '(unknown)'} name=${resolved.account_name ?? '(unknown)'}${label}`);
        const ownedParts = Object.entries(owned).map(([t, c]) => `${t}=${c}`);
        ownedParts.push(`auth_tokens=${tokenCount}`);
        console.log(`  ${args.dryRun ? 'would delete' : 'deleted'} owned: ${ownedParts.join(' ')}`);
        const refTotal = Object.values(refs).reduce((a, b) => a + b, 0);
        if (refTotal > 0) {
            const refParts = Object.entries(refs).map(([k, c]) => `${k}=${c}`);
            if (args.purgeRefs) {
                console.log(`  ${args.dryRun ? 'would delete' : 'deleted'} references: ${refParts.join(' ')}`);
            } else {
                console.log(`  kept ${refTotal} reference(s) in other accounts: ${refParts.join(' ')} (use --purge-refs to remove)`);
            }
        }
    }
    console.log(`\n=== ${args.dryRun ? 'Would remove' : 'Removed'} ${removed} account(s), ${notFound} not found ===`);
}

if (require.main === module) runCli();

module.exports = { removeAccount, resolveAccount };
