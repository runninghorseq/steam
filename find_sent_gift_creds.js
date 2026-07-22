// Find the username/password for sent_gifts recipients inside an external
// account list file. For every distinct recipient in the sent_gifts table we
// look the recipient up in the file and, on a match, print/export the account's
// login credentials (username + password).
//
// Match order (first hit wins, most reliable first):
//   1. SteamID  — file's SteamID32 (hyphen col 4) converted to SteamID64,
//                 compared against sent_gifts.recipient_steam_id.
//   2. Name     — recipient_name (case-insensitive) against the file's email
//                 prefix AND username column (covers both naming conventions).
//
// Supported file formats (same as update_friend_country_from_file.js /
// mark_cant_gift_from_file.js):
//
//   Hyphen format (4 cols):
//     username----password----email----<steamID32>[|country]
//     -> username=col1, password=col2, emailPrefix=col3, steamID32=col4
//
//   Pipe format (5-6+ cols):
//     id|email|extra|username|password[|country]
//     -> emailPrefix=col2, username=col4, password=col5
//
// By default it scans DEFAULT_DIR and filters to DEFAULT_SENT_AT (both below).
// Override the source with --dir=<path> (add --recurse for subfolders) or a
// single --file=<path> / bare positional path. Override the date filter with
// --sent-at='<value>' (pass an empty string to match all dates). Use
// --out=<path> to also write matches to a file.
//
// Usage:
//   node steam/find_sent_gift_creds.js                              # defaults
//   node steam/find_sent_gift_creds.js --sent-at='5 Jun' --out=creds.txt
//   node steam/find_sent_gift_creds.js --dir=<path> --recurse
//   node steam/find_sent_gift_creds.js --file=<path>

const fs = require('fs');
const { db } = require('./db');

// Defaults used when no --dir / --sent-at flag is given.
const DEFAULT_DIR =
    '/Users/lequangha/Library/Mobile Documents/com~apple~CloudDocs/fungaming/acc_new_steam/';
const DEFAULT_SENT_AT = '12 Jun';

const args = process.argv.slice(2);
const fileFlag = args.find((a) => a.startsWith('--file='));
const dirFlag = args.find((a) => a.startsWith('--dir='));
const outFlag = args.find((a) => a.startsWith('--out='));
const sentAtFlag = args.find((a) => a.startsWith('--sent-at='));
const recurse = args.includes('--recurse');
const positional = args.find((a) => !a.startsWith('--'));
// A single file (--file=/positional) overrides the dir; otherwise scan DEFAULT_DIR.
const FILE = fileFlag ? fileFlag.slice('--file='.length) : positional || null;
const DIR = FILE ? null : dirFlag ? dirFlag.slice('--dir='.length) : DEFAULT_DIR;
const OUT = outFlag ? outFlag.slice('--out='.length) : DEFAULT_SENT_AT + ".txt";
// --sent-at='' (explicit empty) means "all dates"; absent flag uses the default.
const SENT_AT = (sentAtFlag ? sentAtFlag.slice('--sent-at='.length).trim() : DEFAULT_SENT_AT) || null;

// Build the list of source files: a directory (optionally recursive) or one file.
function collectFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
            if (recurse) out.push(...collectFiles(full));
        } else if (entry.isFile()) {
            out.push(full);
        }
    }
    return out;
}

let FILES;
if (DIR) {
    if (!fs.existsSync(DIR)) {
        console.error(`Directory not found: ${DIR}`);
        process.exit(1);
    }
    FILES = collectFiles(DIR);
} else {
    if (!fs.existsSync(FILE)) {
        console.error(`File not found: ${FILE}`);
        process.exit(1);
    }
    FILES = [FILE];
}

// SteamID32 (account ID) -> SteamID64 string.
const STEAMID64_BASE = 76561197960265728n;
function steamID32to64(id32) {
    try {
        return String(STEAMID64_BASE + BigInt(String(id32).trim()));
    } catch (_) {
        return null;
    }
}

// --- Parse the account file into lookup indexes ----------------------------
const bySteamID = new Map(); // steamID64 -> { username, password, raw }
const byName = new Map();    // lower(emailPrefix | username) -> { username, password, raw }
let parsed = 0;
const skipped = [];

const addName = (key, rec) => {
    const k = (key || '').trim().toLowerCase();
    if (k && !byName.has(k)) byName.set(k, rec);
};

function parseFile(filePath) {
  const source = filePath.split('/').pop();
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim());
  for (const line of lines) {
    // A true hyphen-format line is "----"-delimited and has at most a trailing
    // "<steamID>|<country>" pipe. Pipe-format lines (>=4 "|" columns) can carry
    // a stray "----" in a trailing column, so route by the dominant delimiter.
    const isHyphen = line.includes('----') && line.split('|').length < 4;
    if (isHyphen) {
        const parts = line.split('----');
        if (parts.length < 4) {
            skipped.push({ line, reason: `hyphen format: expected >=4 columns, got ${parts.length}` });
            continue;
        }
        const username = (parts[0] || '').trim();
        const password = (parts[1] || '').trim();
        const emailPrefix = (parts[2] || '').split('@')[0].trim();
        const steamID32 = (parts[3] || '').trim().split(/[\s|]/)[0];
        const rec = { username, password, raw: line, source };
        if (/^\d+$/.test(steamID32)) {
            const sid64 = steamID32to64(steamID32);
            if (sid64) bySteamID.set(sid64, rec);
        }
        addName(emailPrefix, rec);
        addName(username, rec);
        parsed++;
        continue;
    }

    if (line.includes('|')) {
        const parts = line.split('|').map((p) => p.trim());
        // Locate the email column; its prefix is the join key (recipient_name).
        const emailIdx = parts.findIndex((p) => p.includes('@'));
        if (emailIdx === -1) {
            skipped.push({ line, reason: 'pipe format: no email (@) column found' });
            continue;
        }
        const emailPrefix = parts[emailIdx].split(/\s/)[0].split('@')[0].trim();
        let username, password;
        if (emailIdx === 0) {
            // email-first format: email|password|token|guid
            username = parts[0];
            password = parts[1] || '';
        } else {
            // id-first format: id|email|extra|username|password[|country]
            username = parts[emailIdx + 2] || parts[0];
            password = parts[emailIdx + 3] || '';
        }
        const rec = { username, password, raw: line, source };
        addName(emailPrefix, rec);
        addName(username, rec);
        parsed++;
        continue;
    }

    skipped.push({ line, reason: 'unrecognized format (no "----" or "|")' });
  }
}

for (const f of FILES) {
    try {
        parseFile(f);
    } catch (err) {
        skipped.push({ line: f, reason: `could not read file: ${err.message}` });
    }
}

console.log(DIR ? `Source dir:  ${DIR} (${FILES.length} files${recurse ? ', recursive' : ''})` : `Source file: ${FILE}`);
console.log(`Parsed ${parsed} account line(s) (${bySteamID.size} with SteamID, ${byName.size} name keys)`);
if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} malformed line(s)`);
}

// --- Match sent_gifts recipients -------------------------------------------
const recipients = db
    .prepare(
        `SELECT recipient_steam_id, recipient_name, COUNT(*) AS gift_count
         FROM sent_gifts
         WHERE (@sentAt IS NULL OR sent_at = @sentAt)
         GROUP BY recipient_steam_id, recipient_name`
    )
    .all({ sentAt: SENT_AT });

if (SENT_AT) console.log(`Filter: sent_at = '${SENT_AT}'`);

const matched = [];
const unmatched = [];

for (const r of recipients) {
    let rec = r.recipient_steam_id ? bySteamID.get(String(r.recipient_steam_id)) : null;
    let how = rec ? 'steamid' : null;
    if (!rec && r.recipient_name) {
        rec = byName.get(r.recipient_name.trim().toLowerCase());
        if (rec) how = 'name';
    }
    if (rec) matched.push({ ...r, ...rec, how });
    else unmatched.push(r);
}

console.log(`\n=== Matches (${matched.length} / ${recipients.length} recipients) ===`);
const outLines = [];
for (const m of matched) {
    console.log(`[${m.how}] ${m.recipient_name} (${m.recipient_steam_id}) x${m.gift_count} -> ${m.username} / ${m.password}  [${m.source}]`);
    outLines.push(`${m.username}----${m.password}`);
    // outLines.push(`${m.raw}\t${m.source}`);
}

console.log(`\n=== Summary ===`);
console.log(`Matched:    ${matched.length}`);
console.log(`Unmatched:  ${unmatched.length}`);
if (unmatched.length > 0) {
    unmatched.slice(0, 10).forEach((u) => console.log(`  - ${u.recipient_name} (${u.recipient_steam_id})`));
    if (unmatched.length > 10) console.log(`  ...and ${unmatched.length - 10} more`);
}

if (OUT && outLines.length > 0) {
    fs.writeFileSync(OUT, outLines.join('\n') + '\n');
    console.log(`\nWrote ${outLines.length} credential line(s) to ${OUT}`);
}
