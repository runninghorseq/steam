// Make a consistent backup of one or more SQLite databases.
//
// Uses better-sqlite3's online backup API, which (unlike a plain `cp` of the
// .db file) captures data still sitting in the WAL, so the copy is a complete,
// self-contained snapshot. Each backup lands in a "backups/" dir next to its
// source database, named "<dbname>.bak-<timestamp>", and the newest --keep are
// kept (older ones pruned).
//
// With no --db/positional arg, every database in DEFAULT_DBS is backed up.
//
// Usage:
//   node steam/backup_db.js                 # backup all DEFAULT_DBS, keep last 10 each
//   node steam/backup_db.js --db=/path.db   # backup just that database
//   node steam/backup_db.js <path.db>       # same, as a bare positional arg
//   node steam/backup_db.js --out=/path.db  # backup to an explicit destination (single db only)
//   node steam/backup_db.js --keep=20       # keep the last 20 timestamped backups
//   node steam/backup_db.js --keep=0        # keep all (no pruning)

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Databases backed up when no specific --db/positional is given.
const DEFAULT_DBS = [
    path.join(__dirname, 'steam_accounts.db'),
    '/Users/lequangha/fungaming/fungame/poe/poe_accounts.db',
];

const args = process.argv.slice(2);
const dbFlag = args.find((a) => a.startsWith('--db='));
const outFlag = args.find((a) => a.startsWith('--out='));
const keepFlag = args.find((a) => a.startsWith('--keep='));
const positional = args.find((a) => !a.startsWith('--'));
const KEEP = keepFlag ? parseInt(keepFlag.slice('--keep='.length), 10) : 10;

const explicit = dbFlag ? dbFlag.slice('--db='.length) : positional;
const DB_PATHS = (explicit ? [explicit] : DEFAULT_DBS).map((p) => path.resolve(p));

if (outFlag && DB_PATHS.length > 1) {
    console.error('--out can only be used with a single database (pass --db=/path or a positional path).');
    process.exit(1);
}

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function backupOne(dbPath) {
    if (!fs.existsSync(dbPath)) {
        console.error(`Database not found: ${dbPath}`);
        return false;
    }
    const dbName = path.basename(dbPath);
    const backupDir = path.join(path.dirname(dbPath), 'backups');
    const outPath = outFlag ? outFlag.slice('--out='.length) : path.join(backupDir, `${dbName}.bak-${stamp()}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const db = new Database(dbPath, { readonly: true });
    try {
        await db.backup(outPath);

        // Verify the backup, then collapse it to a single self-contained file:
        // journal_mode=DELETE folds any WAL back in and removes the -shm/-wal
        // sidecars the verification connection would otherwise leave behind.
        const check = new Database(outPath);
        const result = check.pragma('integrity_check', { simple: true });
        check.pragma('journal_mode = DELETE');
        check.close();
        if (result !== 'ok') {
            console.error(`Backup integrity check FAILED for ${dbName}: ${result}`);
            return false;
        }

        const size = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
        console.log(`Backup OK: ${outPath} (${size} MB, integrity: ok)`);
    } finally {
        db.close();
    }

    // Prune old timestamped backups for this db (skip when --out or --keep=0).
    if (!outFlag && KEEP > 0 && fs.existsSync(backupDir)) {
        const escaped = dbName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`^${escaped}\\.bak-\\d{8}-\\d{6}$`);
        const backups = fs.readdirSync(backupDir).filter((f) => re.test(f)).sort();
        const stale = backups.slice(0, Math.max(0, backups.length - KEEP));
        for (const f of stale) {
            fs.unlinkSync(path.join(backupDir, f));
            console.log(`Pruned old backup: ${f}`);
        }
    }
    return true;
}

(async () => {
    let ok = true;
    for (const dbPath of DB_PATHS) {
        ok = (await backupOne(dbPath)) && ok;
    }
    process.exit(ok ? 0 : 1);
})().catch((err) => {
    console.error(`Backup failed: ${err.message}`);
    process.exit(1);
});
