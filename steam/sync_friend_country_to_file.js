// Inverse of update_friend_country_from_file.js.
// Reads the DB and rewrites the country field of each matching line in a file.
//
// Supports both formats (auto-detected per line):
//   Pipe:   id|email|extra|username|password|country
//   Hyphen: username----password----email----<steamID32>|<country>
//
// Match key: email prefix (column 2 for pipe format, column 3 for hyphen format),
// looked up in friends.friend_name (case-insensitive).
//
// Usage:
//   node steam/sync_friend_country_to_file.js <file>            # dry run — preview only
//   node steam/sync_friend_country_to_file.js <file> --commit   # rewrite file (backup saved as <file>.bak.<ts>)

const fs = require('fs');
const path = require('path');
const { db } = require('./db');

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const FILE = args.find((a) => !a.startsWith('--'));

if (!FILE) {
    console.error('Usage: node sync_friend_country_to_file.js <file> [--commit]');
    process.exit(1);
}
if (!fs.existsSync(FILE)) {
    console.error(`File not found: ${FILE}`);
    process.exit(1);
}

const original = fs.readFileSync(FILE, 'utf8');
const lines = original.split('\n');

const lookupByName = db.prepare(
    'SELECT country FROM friends WHERE lower(friend_name) = lower(?) AND country IS NOT NULL LIMIT 1'
);

const isCountryCode = (s) => /^[A-Z]{2}$/.test(s);

const outLines = [];
const changes = [];
let changed = 0;
let unchanged = 0;
let malformed = 0;
let noDbMatch = 0;

function rewriteHyphen(line) {
    const parts = line.split('----');
    if (parts.length !== 4) return { ok: false, reason: 'malformed (col count)' };
    const tail = parts[3].split('|');
    if (tail.length !== 2) return { ok: false, reason: 'malformed (tail)' };
    const fileCountry = tail[1].trim();
    if (!isCountryCode(fileCountry)) return { ok: false, reason: `invalid country "${fileCountry}"` };
    const prefix = (parts[2] || '').split('@')[0].trim();
    if (!prefix) return { ok: false, reason: 'empty email prefix' };

    const row = lookupByName.get(prefix);
    if (!row) return { ok: true, line, prefix, dbMissing: true };
    if (row.country === fileCountry) return { ok: true, line, prefix, fileCountry, dbCountry: row.country };

    const newLine = `${parts[0]}----${parts[1]}----${parts[2]}----${tail[0]}|${row.country}`;
    return { ok: true, line: newLine, prefix, fileCountry, dbCountry: row.country, changed: true };
}

function rewritePipe(line) {
    const parts = line.split('|');
    if (parts.length !== 6) return { ok: false, reason: 'malformed (col count)' };
    const fileCountry = (parts[5] || '').trim();
    if (!isCountryCode(fileCountry)) return { ok: false, reason: `invalid country "${fileCountry}"` };
    const prefix = (parts[1] || '').split('@')[0].trim();
    if (!prefix) return { ok: false, reason: 'empty email prefix' };

    const row = lookupByName.get(prefix);
    if (!row) return { ok: true, line, prefix, dbMissing: true };
    if (row.country === fileCountry) return { ok: true, line, prefix, fileCountry, dbCountry: row.country };

    parts[5] = row.country;
    return { ok: true, line: parts.join('|'), prefix, fileCountry, dbCountry: row.country, changed: true };
}

for (const rawLine of lines) {
    if (!rawLine.trim()) {
        outLines.push(rawLine);
        continue;
    }
    const result = rawLine.includes('----') ? rewriteHyphen(rawLine) : rewritePipe(rawLine);

    if (!result.ok) {
        outLines.push(rawLine);
        malformed++;
        continue;
    }
    outLines.push(result.line);
    if (result.changed) {
        changed++;
        changes.push({ prefix: result.prefix, old: result.fileCountry, new: result.dbCountry });
    } else if (result.dbMissing) {
        noDbMatch++;
    } else {
        unchanged++;
    }
}

console.log(COMMIT ? 'Mode: COMMIT (file will be rewritten)' : 'Mode: DRY RUN (preview only)\n');

console.log('=== Preview ===');
if (changes.length === 0) {
    console.log('(no rows differ from DB)');
} else {
    changes.slice(0, 50).forEach((c) => console.log(`  ${c.prefix}: ${c.old} -> ${c.new}`));
    if (changes.length > 50) console.log(`  ...and ${changes.length - 50} more`);
}

console.log('\n=== Summary ===');
console.log(`Lines that would change:        ${changed}`);
console.log(`Lines already in sync with DB:  ${unchanged}`);
console.log(`Lines with no matching friend:  ${noDbMatch}`);
console.log(`Malformed / skipped:            ${malformed}`);

if (!COMMIT) {
    console.log('\nDry run. Re-run with --commit to rewrite the file.');
    process.exit(0);
}
if (changed === 0) {
    console.log('\nNothing to write.');
    process.exit(0);
}

// Backup then write
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${FILE}.bak.${stamp}`;
fs.copyFileSync(FILE, backupPath);
fs.writeFileSync(FILE, outLines.join('\n'));
console.log(`\nWrote ${changed} updates to ${FILE}`);
console.log(`Backup: ${path.basename(backupPath)}`);
