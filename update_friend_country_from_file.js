// Update friends.country from an external account list file. Supports two formats:
//
//   Pipe format (6 cols, matched by email prefix against friends.friend_name):
//     id|email|extra|username|password|country
//     e.g. 67|DoreenWinnie7199814@hotmail.com|AmeliaKristy836|DoreenWinnie|fugaPhlRk125|AZ
//
//   Hyphen format (4 cols, matched by email prefix of column 3 against friends.friend_name):
//     username----password----email----<steamID32>|<country>
//     e.g. fuqeo62876----exucb07839----ku170662@cscoen51.icu----70488229|BR
//          -> match key: "ku170662", country: "BR"
//
// Usage:
//   node steam/update_friend_country_from_file.js <file>            # dry run — preview only
//   node steam/update_friend_country_from_file.js <file> --commit   # apply changes

const fs = require('fs');
const { db } = require('./db');

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const FILE = args.find((a) => !a.startsWith('--'));

if (!FILE) {
    console.error('Usage: node update_friend_country_from_file.js <file> [--commit]');
    process.exit(1);
}
if (!fs.existsSync(FILE)) {
    console.error(`File not found: ${FILE}`);
    process.exit(1);
}

const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim());
const mapping = [];
const skipped = [];

const isCountryCode = (s) => /^[A-Z]{2}$/.test(s);

for (const line of lines) {
    // Hyphen format (contains "----" separator)
    if (line.includes('----')) {
        const parts = line.split('----');
        if (parts.length !== 4) {
            skipped.push({ line, reason: `hyphen format: expected 4 columns, got ${parts.length}` });
            continue;
        }
        const tail = parts[3].split('|');
        if (tail.length !== 2) {
            skipped.push({ line, reason: `hyphen format: last column must be "<steamID>|<country>"` });
            continue;
        }
        const country = tail[1].trim();
        if (!isCountryCode(country)) {
            skipped.push({ line, reason: `hyphen format: invalid country code "${country}"` });
            continue;
        }
        const email = (parts[2] || '').trim();
        const prefix = email.split('@')[0].trim();
        if (!prefix) {
            skipped.push({ line, reason: 'hyphen format: empty email prefix in column 3' });
            continue;
        }
        mapping.push({ matchBy: 'name', key: prefix, country, raw: line });
        continue;
    }

    // Pipe format
    const parts = line.split('|');
    if (parts.length !== 6) {
        skipped.push({ line, reason: `pipe format: expected exactly 6 columns, got ${parts.length}` });
        continue;
    }
    const email = parts[1] || '';
    const country = (parts[5] || '').trim();
    const prefix = email.split('@')[0].trim();
    if (!prefix) {
        skipped.push({ line, reason: 'pipe format: empty email prefix' });
        continue;
    }
    if (!isCountryCode(country)) {
        skipped.push({ line, reason: `pipe format: invalid country code "${country}"` });
        continue;
    }
    mapping.push({ matchBy: 'name', key: prefix, country, raw: line });
}

if (skipped.length > 0) {
    console.log(`\nSkipped ${skipped.length} malformed line(s):`);
    skipped.slice(0, 10).forEach((s) => console.log(`  - ${s.reason}: ${s.line.substring(0, 80)}`));
    if (skipped.length > 10) console.log(`  ...and ${skipped.length - 10} more`);
}

console.log(`Parsed ${mapping.length} rows from ${FILE}`);
console.log(COMMIT ? 'Mode: COMMIT (writes will be saved)' : 'Mode: DRY RUN (no changes will be written — re-run with --commit to apply)\n');

const findByName = db.prepare(
    'SELECT account_steam_id, friend_steam_id, friend_name, country FROM friends WHERE lower(friend_name) = lower(?)'
);
const findBySteamID = db.prepare(
    'SELECT account_steam_id, friend_steam_id, friend_name, country FROM friends WHERE friend_steam_id = ?'
);

const updateByName = db.prepare('UPDATE friends SET country = ? WHERE lower(friend_name) = lower(?)');
const updateBySteamID = db.prepare('UPDATE friends SET country = ? WHERE friend_steam_id = ?');

let willChange = 0;
let alreadyCorrect = 0;
const unmatched = [];
const changes = [];

for (const m of mapping) {
    const rows = m.matchBy === 'steamid' ? findBySteamID.all(m.key) : findByName.all(m.key);
    if (rows.length === 0) {
        unmatched.push(m);
        continue;
    }
    const rowChanges = rows.map((r) => ({
        friend_name: r.friend_name,
        account_steam_id: r.account_steam_id,
        current: r.country,
        new: m.country,
        will_change: r.country !== m.country
    }));
    const changing = rowChanges.filter((r) => r.will_change).length;
    willChange += changing;
    alreadyCorrect += rowChanges.length - changing;
    if (rowChanges.length > 0) changes.push({ ...m, rows: rowChanges });
}

// Preview
console.log('=== Preview ===');
for (const c of changes) {
    const changingRows = c.rows.filter((r) => r.will_change);
    if (changingRows.length === 0) continue;
    const label = c.matchBy === 'steamid' ? `SteamID ${c.key}` : c.key;
    console.log(`\n${label} -> ${c.country}`);
    changingRows.forEach((r) => {
        console.log(`  [${r.account_steam_id}] ${r.friend_name}: ${r.current || '(null)'} -> ${r.new}`);
    });
}

console.log('\n=== Summary ===');
console.log(`Rows that would change:  ${willChange}`);
console.log(`Already correct:         ${alreadyCorrect}`);
console.log(`Unmatched:               ${unmatched.length}`);
if (unmatched.length > 0) {
    unmatched.slice(0, 10).forEach((u) => {
        const label = u.matchBy === 'steamid' ? `SteamID ${u.key}` : u.key;
        console.log(`  - ${label}`);
    });
    if (unmatched.length > 10) console.log(`  ...and ${unmatched.length - 10} more`);
}

if (!COMMIT) {
    console.log('\nDry run only. Re-run with --commit to save changes.');
    process.exit(0);
}

const tx = db.transaction(() => {
    let totalChanges = 0;
    for (const m of mapping) {
        const stmt = m.matchBy === 'steamid' ? updateBySteamID : updateByName;
        totalChanges += stmt.run(m.country, m.key).changes;
    }
    return totalChanges;
});
const totalChanges = tx();
console.log(`\nCommitted. ${totalChanges} friend rows updated.`);
