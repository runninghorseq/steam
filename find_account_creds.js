// Find the Steam login username/password for accounts in the DB by matching
// each account's email against an external account list file. For every account
// (accounts table) that has an email we look the email up in the file(s) and, on
// a match, print/export the account's login credentials (username + password).
//
// Match key: accounts.email (full, case-insensitive) against the file's email
// column. This is the sibling of find_sent_gift_creds.js, which matches
// sent_gifts recipients by SteamID/name; here we match accounts by email.
//
// Supported file formats (same as find_sent_gift_creds.js /
// update_friend_country_from_file.js / mark_cant_gift_from_file.js):
//
//   Hyphen format (4 cols):
//     username----password----email----<steamID32>[|country]
//     -> username=col1, password=col2, email=col3
//
//   Pipe format (5-6+ cols):
//     id|email|extra|username|password[|country]
//     -> email=col2, username=col4, password=col5
//     (email-first variant: email|password|token|guid)
//
// By default it scans DEFAULT_DIR (all accounts, no filter). Override the source
// with --dir=<path> (add --recurse for subfolders) or a single --file=<path> /
// bare positional path. Filter accounts with --country=<CC> or --email=<substr>.
// Use --out=<path> to also write matched credentials to a file.
//
// Usage:
//   node steam/find_account_creds.js                       # all accounts, default dir
//   node steam/find_account_creds.js --out=creds.txt
//   node steam/find_account_creds.js --country=US
//   node steam/find_account_creds.js --dir=<path> --recurse
//   node steam/find_account_creds.js --file=<path>

const fs = require('fs');
const { db } = require('./db');

// Default source dir used when no --dir / --file flag is given.
const DEFAULT_DIR =
    '/Users/lequangha/Library/Mobile Documents/com~apple~CloudDocs/fungaming/acc_new_steam/';

const args = process.argv.slice(2);
const fileFlag = args.find((a) => a.startsWith('--file='));
const dirFlag = args.find((a) => a.startsWith('--dir='));
const outFlag = args.find((a) => a.startsWith('--out='));
const countryFlag = args.find((a) => a.startsWith('--country='));
const emailFlag = args.find((a) => a.startsWith('--email='));
const recurse = args.includes('--recurse');
const positional = args.find((a) => !a.startsWith('--'));
// A single file (--file=/positional) overrides the dir; otherwise scan DEFAULT_DIR.
const FILE = fileFlag ? fileFlag.slice('--file='.length) : positional || null;
const DIR = FILE ? null : dirFlag ? dirFlag.slice('--dir='.length) : DEFAULT_DIR;
const OUT = outFlag ? outFlag.slice('--out='.length) : null;
const COUNTRY = countryFlag ? countryFlag.slice('--country='.length).trim() : null;
const EMAIL_SUBSTR = emailFlag ? emailFlag.slice('--email='.length).trim().toLowerCase() : null;

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

// --- Parse the account file(s) into an email -> credentials index ----------
const byEmail = new Map(); // lower(email) -> { username, password, raw, source }
let parsed = 0;
const skipped = [];

const addEmail = (email, rec) => {
    const k = (email || '').trim().toLowerCase();
    if (k && k.includes('@') && !byEmail.has(k)) byEmail.set(k, rec);
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
        const email = (parts[2] || '').trim().split(/\s/)[0];
        addEmail(email, { username, password, raw: line, source });
        parsed++;
        continue;
    }

    if (line.includes('|')) {
        const parts = line.split('|').map((p) => p.trim());
        // Locate the email column; it is the join key against accounts.email.
        const emailIdx = parts.findIndex((p) => p.includes('@'));
        if (emailIdx === -1) {
            skipped.push({ line, reason: 'pipe format: no email (@) column found' });
            continue;
        }
        const email = parts[emailIdx].split(/\s/)[0];
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
        addEmail(email, { username, password, raw: line, source });
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
console.log(`Parsed ${parsed} account line(s) (${byEmail.size} distinct email keys)`);
if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} malformed line(s)`);
}

// --- Match DB accounts by email --------------------------------------------
const accounts = db
    .prepare(
        `SELECT steam_id, account_name, email, country
         FROM accounts
         WHERE email IS NOT NULL AND email != ''
           AND (@country IS NULL OR country = @country)
           AND (@emailSub IS NULL OR lower(email) LIKE '%' || @emailSub || '%')
         ORDER BY email`
    )
    .all({ country: COUNTRY, emailSub: EMAIL_SUBSTR });

if (COUNTRY) console.log(`Filter: country = '${COUNTRY}'`);
if (EMAIL_SUBSTR) console.log(`Filter: email contains '${EMAIL_SUBSTR}'`);

const matched = [];
const unmatched = [];

for (const a of accounts) {
    const rec = byEmail.get(a.email.trim().toLowerCase());
    if (rec) matched.push({ ...a, ...rec });
    else unmatched.push(a);
}

console.log(`\n=== Matches (${matched.length} / ${accounts.length} accounts) ===`);
const outLines = [];
for (const m of matched) {
    console.log(`${m.email} (${m.steam_id}) -> ${m.username} / ${m.password}  [${m.source}]`);
    outLines.push(m.raw);
}

console.log(`\n=== Summary ===`);
console.log(`Matched:    ${matched.length}`);
console.log(`Unmatched:  ${unmatched.length}`);
if (unmatched.length > 0) {
    unmatched.slice(0, 10).forEach((u) => console.log(`  - ${u.email} (${u.steam_id})`));
    if (unmatched.length > 10) console.log(`  ...and ${unmatched.length - 10} more`);
}

if (OUT && outLines.length > 0) {
    fs.writeFileSync(OUT, outLines.join('\n') + '\n');
    console.log(`\nWrote ${outLines.length} credential line(s) to ${OUT}`);
}
