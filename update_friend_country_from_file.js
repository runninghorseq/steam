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
// Source file path defaults to DEFAULT_FILE below, so the common case needs no
// argument. Override with the COUNTRY_FILE env var, a --file=<path> flag, or a
// bare positional path.
//
// Usage:
//   node steam/update_friend_country_from_file.js                   # dry run on DEFAULT_FILE
//   node steam/update_friend_country_from_file.js --commit          # apply DEFAULT_FILE
//   node steam/update_friend_country_from_file.js <file>            # dry run on <file>
//   node steam/update_friend_country_from_file.js <file> --commit   # apply <file>
//   node steam/update_friend_country_from_file.js --file=<path> --commit
//   COUNTRY_FILE=<path> node steam/update_friend_country_from_file.js --commit

const fs = require('fs');
const { db } = require('./db');

// Most-recent country list (6-col pipe format with trailing |<country>). Other
// recent candidates in the same dir:
//   .../acc_new_steam/20260503_2k_outlook.txt
//   .../acc_new_steam/20260502_2k_outlook_20260420.txt
//   .../acc_new_steam/20251123_accsteam_LICN16HSJX_85_deale.txt
//   .../acc_new_steam/20251218_accsteamvn_EGTT97H1H9_110_tepo.txt
//   .../acc_new_steam/20260304_accsteam_QUDT1772289980_f800.txt
//   .../acc_new_steam/dataloifb_04242026.txt
//   .../acc_new_steam/steam_cis_gift.txt
//   .../acc_new_steam/20260427_OPFH1777198116_444.txt
//   .../acc_new_steam/20260409_PTGO1774415483_f40.txt
//   .../acc_new_steam/20251128_accsteam_ZL0OBRNNXJ1_190_kienpoe222.txt
//   .../acc_new_steam/steam_hotmail_Marcow.txt
//   .../acc_new_steam/20251021_steam_A4EFUPVYPJ_35.txt
//   .../acc_new_steam/20251018_accsteam_7II9NJA22W_30.txt
//   .../acc_new_steam/20260507_1910_from_2k.txtresult.txt
//   .../acc_new_steam/20251204_accsteam_SPHFWLDOLN_90_duan.txt
//   .../acc_new_steam/20251106_accsteam_MZGSS5TD4B_60_towaj.txt
//   .../acc_new_steam/20260302_accsteam_QUDT1772289980_51_pro.txt
//   .../acc_new_steam/20251031_accsteam_MCO2RAIFV1_50_meoqua.txt
//   .../acc_new_steam/20251124_accsteam_CZ2LNYHQ4F_135_sovikjrollexq.txt
//   .../acc_new_steam/20251208_accsteam_OPJEUW69FU_79_alen_kadic.txt
//   .../acc_new_steam/20260412_PTGO1774415483_f500_macpro.txt
//   .../acc_new_steam/20260319_YOKT1773745893_f600.txt
//   .../acc_new_steam/steam_brasil.txt
//   .../acc_new_steam/20260504_PTGO1774415483.txtresult.txt
//   .../acc_new_steam/20260513_2650_outlook.txtresult.txt
//   .../acc_new_steam/20260526_1k_outlook_2005.txtresult.txt
//   .../acc_new_steam/20260604_2650_outlook.txt.missing.txtresult.txt
//   .../acc_new_steam/20260606_1491_of_3k_outlook.txtresult.txt
const DEFAULT_FILE =
    '/Users/lequangha/Library/Mobile Documents/com~apple~CloudDocs/fungaming/acc_new_steam/20260526_1k_outlook_2005.txtresult.txt';

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const fileFlag = args.find((a) => a.startsWith('--file='));
const positional = args.find((a) => !a.startsWith('--'));
const FILE = (fileFlag ? fileFlag.slice('--file='.length) : positional) || process.env.COUNTRY_FILE || DEFAULT_FILE;

if (!fs.existsSync(FILE)) {
    console.error(`File not found: ${FILE}`);
    process.exit(1);
}

console.log(`Source file: ${FILE}`);

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
        if (country === 'VN') {
            skipped.push({ line, reason: 'country is VN — skipped' });
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
    if (country === 'VN') {
        skipped.push({ line, reason: 'country is VN — skipped' });
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
