// Mark friends as "can NOT send gift" (already gifted before) from an external
// account list file. These are friends who already received a gift in a prior
// run, so the gifting bot should skip them. We record that by stamping
// friends.gifted_at + friends.gifted_game (the same fields mark_gifted.js sets).
//
// Input formats (matched by email prefix against friends.friend_name, same
// match key as update_friend_country_from_file.js):
//
//   Hyphen format (4 cols), email is column 3:
//     username----password----email----<steamID32>
//     e.g. tgmea59959----yrrxc31530----cp250422@mpmail.club----14292424
//          -> match key: "cp250422"
//
//   Pipe format (id|email|extra|username|password), email is column 2:
//     e.g. 37|Marisol15516Freda1994@hotmail.com|Whitney2Shelley|MarisolFreda|fugaIl9tD8
//          -> match key: "Marisol15516Freda1994"
//
// Trailing annotations after the data (e.g. " -> poe1 gift -> fb 5 acc") are
// ignored. The hyphen format also carries a SteamID32 in column 4; with
// --by-steamid we convert it to SteamID64 and match friends.friend_steam_id
// instead (not available for the pipe format).
//
// What it writes (only with --commit):
//   gifted_game = <game tag>            (default: poe1, override with --game=)
//   gifted_at   = COALESCE(existing, <stamp>)   -- never clobbers a real gift date
//
// Source file path defaults to DEFAULT_FILE below. Override with the
// GIFT_FILE env var, a --file=<path> flag, or a bare positional path.
//
// Usage:
//   node steam/mark_cant_gift_from_file.js <file>                    # dry run, game=poe1
//   node steam/mark_cant_gift_from_file.js <file> --commit           # apply
//   node steam/mark_cant_gift_from_file.js <file> --game=poe2 --commit
//   node steam/mark_cant_gift_from_file.js <file> --date=20260530 --commit
//   node steam/mark_cant_gift_from_file.js <file> --by-steamid --commit
//   GIFT_FILE=<path> node steam/mark_cant_gift_from_file.js --commit

const fs = require('fs');
const { db } = require('./db');
//steam_ukraine_gift
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
const DEFAULT_FILE =
    '/Users/lequangha/Library/Mobile Documents/com~apple~CloudDocs/fungaming/acc_new_steam/20251208_accsteam_OPJEUW69FU_79_alen_kadic.txt';

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const BY_STEAMID = args.includes('--by-steamid');
const fileFlag = args.find((a) => a.startsWith('--file='));
const gameFlag = args.find((a) => a.startsWith('--game='));
const dateFlag = args.find((a) => a.startsWith('--date='));
const positional = args.find((a) => !a.startsWith('--'));
const FILE = (fileFlag ? fileFlag.slice('--file='.length) : positional) || process.env.GIFT_FILE || DEFAULT_FILE;
const GAME = (gameFlag ? gameFlag.slice('--game='.length) : '').trim() || 'poe1';

// gifted_at stamp: --date=YYYYMMDD (local midnight) or now.
function parseDate(s) {
    const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
    if (!m) {
        console.error(`bad --date '${s}', expected YYYYMMDD`);
        process.exit(1);
    }
    return Math.floor(new Date(+m[1], +m[2] - 1, +m[3]).getTime() / 1000);
}
const STAMP = dateFlag ? parseDate(dateFlag.slice('--date='.length)) : Math.floor(Date.now() / 1000);

function fmtDate(ts) {
    if (!ts) return '(null)';
    const d = new Date(ts * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

// SteamID32 (account ID) -> SteamID64 string.
const STEAMID64_BASE = 76561197960265728n;
function steamID32to64(id32) {
    const n = BigInt(String(id32).trim());
    return String(STEAMID64_BASE + n);
}

if (!fs.existsSync(FILE)) {
    console.error(`File not found: ${FILE}`);
    process.exit(1);
}

console.log(`Source file: ${FILE}`);
console.log(`Game tag:    ${GAME}`);
console.log(`Match by:    ${BY_STEAMID ? 'friend_steam_id (from SteamID32 column)' : 'friend_name (email prefix)'}`);
console.log(`gifted_at:   ${fmtDate(STAMP)} (only applied where currently null)`);

const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim());
const mapping = [];
const skipped = [];

for (const line of lines) {
    // Hyphen format: username----password----email----<steamID32>
    if (line.includes('----')) {
        const parts = line.split('----');
        if (parts.length !== 4) {
            skipped.push({ line, reason: `hyphen format: expected 4 columns, got ${parts.length}` });
            continue;
        }
        if (BY_STEAMID) {
            // The 4th column may carry trailing annotations after a space/pipe; take the leading digits.
            const raw = (parts[3] || '').trim().split(/[\s|]/)[0];
            if (!/^\d+$/.test(raw)) {
                skipped.push({ line, reason: `hyphen format: column 4 is not a numeric SteamID32: "${raw}"` });
                continue;
            }
            mapping.push({ matchBy: 'steamid', key: steamID32to64(raw), raw: line });
            continue;
        }
        const email = (parts[2] || '').trim();
        const prefix = email.split('@')[0].trim();
        if (!prefix) {
            skipped.push({ line, reason: 'hyphen format: empty email prefix in column 3' });
            continue;
        }
        mapping.push({ matchBy: 'name', key: prefix, raw: line });
        continue;
    }

    // Pipe format: id|email|extra|username|password (email prefix is the match key).
    // Trailing annotations (e.g. " -> poe1 gift -> fb 5 acc") are ignored.
    if (line.includes('|')) {
        if (BY_STEAMID) {
            skipped.push({ line, reason: 'pipe format has no SteamID32 column (drop --by-steamid)' });
            continue;
        }
        const parts = line.split('|');
        if (parts.length < 2) {
            skipped.push({ line, reason: 'pipe format: expected at least 2 columns' });
            continue;
        }
        const email = (parts[1] || '').trim().split(/\s/)[0];
        const prefix = email.split('@')[0].trim();
        if (!prefix) {
            skipped.push({ line, reason: 'pipe format: empty email prefix in column 2' });
            continue;
        }
        mapping.push({ matchBy: 'name', key: prefix, raw: line });
        continue;
    }

    skipped.push({ line, reason: 'unrecognized format (no "----" or "|")' });
}

if (skipped.length > 0) {
    console.log(`\nSkipped ${skipped.length} malformed line(s):`);
    skipped.slice(0, 10).forEach((s) => console.log(`  - ${s.reason}: ${s.line.substring(0, 80)}`));
    if (skipped.length > 10) console.log(`  ...and ${skipped.length - 10} more`);
}

console.log(`\nParsed ${mapping.length} rows from ${FILE}`);
console.log(COMMIT ? 'Mode: COMMIT (writes will be saved)' : 'Mode: DRY RUN (no changes will be written — re-run with --commit to apply)\n');

const findByName = db.prepare(
    'SELECT account_steam_id, friend_steam_id, friend_name, gifted_at, gifted_game FROM friends WHERE lower(friend_name) = lower(?)'
);
const findBySteamID = db.prepare(
    'SELECT account_steam_id, friend_steam_id, friend_name, gifted_at, gifted_game FROM friends WHERE friend_steam_id = ?'
);
// Set the game tag; preserve any existing real gift date, otherwise stamp it.
const updateGift = db.prepare(`
    UPDATE friends
    SET gifted_game = ?, gifted_at = COALESCE(gifted_at, ?), updated_at = unixepoch()
    WHERE account_steam_id = ? AND friend_steam_id = ?
`);

let willChange = 0;
let alreadyMarked = 0;
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
        friend_steam_id: r.friend_steam_id,
        account_steam_id: r.account_steam_id,
        current_game: r.gifted_game,
        current_at: r.gifted_at,
        // "Already marked" = already carries this exact game tag; nothing to do.
        will_change: r.gifted_game !== GAME
    }));
    rowChanges.forEach((r) => (r.will_change ? willChange++ : alreadyMarked++));
    changes.push({ ...m, rows: rowChanges });
}

// Preview
console.log('=== Preview ===');
for (const c of changes) {
    const changingRows = c.rows.filter((r) => r.will_change);
    if (changingRows.length === 0) continue;
    const label = c.matchBy === 'steamid' ? `SteamID ${c.key}` : c.key;
    console.log(`\n${label} -> gifted_game=${GAME}`);
    changingRows.forEach((r) => {
        const wasGame = r.current_game || '(null)';
        const wasAt = fmtDate(r.current_at);
        console.log(`  [${r.account_steam_id}] ${r.friend_name}: ${wasGame}@${wasAt} -> ${GAME}@${fmtDate(r.current_at || STAMP)}`);
    });
}

console.log('\n=== Summary ===');
console.log(`Rows that would change:  ${willChange}`);
console.log(`Already marked (${GAME}):  ${alreadyMarked}`);
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
    for (const c of changes) {
        for (const r of c.rows) {
            if (!r.will_change) continue;
            totalChanges += updateGift.run(GAME, STAMP, r.account_steam_id, r.friend_steam_id).changes;
        }
    }
    return totalChanges;
});
const totalChanges = tx();
console.log(`\nCommitted. ${totalChanges} friend rows marked as gifted (${GAME}).`);
