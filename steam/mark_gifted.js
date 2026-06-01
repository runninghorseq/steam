// Mark a friend as gifted: updates both the DB and the source gift list file.
//
// Two modes:
//
//   1. Single-friend mode (friend arg given): set gifted_at + gifted_game on
//      every friends row matching the friend (by friend_name, or by
//      friend_steam_id if the input is a 17-digit SteamID64), then append
//      "|<tag> <date>" to the matching line in the source file.
//
//   2. Sync mode (no friend arg): query the DB for every friend already
//      gifted on <date> with gifted_game = <tag>, then append the marker to
//      each one's line in the source file. Use this after the gifting bot
//      has run, to back-fill the source list in one shot.
//
// In both modes the file write is idempotent (lines already containing the
// same "|<tag> <date>" token are left alone) and atomic (tmp + rename).
//
// Defaults: tag=poe2, date=today (local). Source file path defaults to:
//   /Users/lequangha/Library/Mobile Documents/com~apple~CloudDocs/fungaming/acc_new_steam/steam_cis_gift.txt
// Override with env var GIFT_FILE or the --file=<path> flag.
//
// CLI:
//   node steam/mark_gifted.js                                 # sync today, tag=poe2
//   node steam/mark_gifted.js --tag=cs2                       # sync today, tag=cs2
//   node steam/mark_gifted.js --date=20260530                 # sync that day, tag=poe2
//   node steam/mark_gifted.js mp753932                        # mark friend, tag=poe2, today
//   node steam/mark_gifted.js mp753932 poe2 20260530          # full explicit
//   node steam/mark_gifted.js 76561199860275357 poe2          # by steamid
//
// Programmatic:
//   const { markGifted, syncFromDB } = require('./mark_gifted');
//   markGifted({ friend: 'mp753932' });                       // defaults to poe2 + today
//   syncFromDB();                                             // sync all today/poe2

const fs = require('fs');
const path = require('path');
const { db } = require('./db');
// /Users/lequangha/Library/Mobile Documents/com~apple~CloudDocs/fungaming/acc_new_steam/20251123_accsteam_LICN16HSJX_85_deale.txt
// /Users/lequangha/Library/Mobile Documents/com~apple~CloudDocs/fungaming/acc_new_steam/steam_brasil.txt.txt
// /Users/lequangha/Library/Mobile Documents/com~apple~CloudDocs/fungaming/acc_new_steam/20260427_OPFH1777198116_444.txt.txt
// /Users/lequangha/Library/Mobile Documents/com~apple~CloudDocs/fungaming/acc_new_steam/steam_cis_gift.txt.txt
// /Users/lequangha/Library/Mobile Documents/com~apple~CloudDocs/fungaming/acc_new_steam/20251106_accsteam_MZGSS5TD4B_60_towaj.txt.txt
const DEFAULT_FILE =
    '/Users/lequangha/Library/Mobile Documents/com~apple~CloudDocs/fungaming/acc_new_steam/steam_cis_gift.txt'
const DEFAULT_TAG = 'poe2';

// Maps a short tag (used in the file marker and CLI) to the canonical Steam
// item_name(s) that may appear in friends.gifted_game. First entry is the
// canonical form that single-friend mode writes back to the DB. Extra entries
// are accepted as equivalent when filtering or checking idempotency, so rows
// written by either the gifting bot or older script runs both match.
const TAG_ALIASES = {
    poe2: ['Path of Exile 2', 'poe2']
};

function gameNamesForTag(tag) {
    return TAG_ALIASES[tag] || [tag];
}
function canonicalGameForTag(tag) {
    return gameNamesForTag(tag)[0];
}

const STEAMID64_RE = /^7656119\d{10}$/;

function nowEpoch() {
    return Math.floor(Date.now() / 1000);
}

function parseDate(s) {
    // YYYYMMDD (or YYYY-MM-DD) → epoch of local midnight on that day.
    const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
    if (!m) throw new Error(`bad date '${s}', expected YYYYMMDD`);
    return Math.floor(new Date(+m[1], +m[2] - 1, +m[3]).getTime() / 1000);
}

function fmtDate(ts) {
    if (!ts) return '(null)';
    const d = new Date(ts * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

function localDayRange(ts) {
    // [startEpoch, endEpoch) covering the local day that contains ts.
    const d = new Date(ts * 1000);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    return [Math.floor(start / 1000), Math.floor(end / 1000)];
}

const findByName = db.prepare(`
SELECT account_steam_id, friend_steam_id, friend_name, gifted_at, gifted_game
FROM friends WHERE lower(friend_name) = lower(?)
`);
const findBySteamID = db.prepare(`
SELECT account_steam_id, friend_steam_id, friend_name, gifted_at, gifted_game
FROM friends WHERE friend_steam_id = ?
`);
const updateGift = db.prepare(`
UPDATE friends
SET gifted_at = ?, gifted_game = ?, updated_at = unixepoch()
WHERE account_steam_id = ? AND friend_steam_id = ?
`);
function findGiftedInRange(dayStart, dayEnd, gameNames) {
    if (gameNames.length === 0) return [];
    const placeholders = gameNames.map(() => '?').join(', ');
    return db
        .prepare(`
            SELECT DISTINCT friend_name
            FROM friends
            WHERE gifted_at >= ? AND gifted_at < ?
              AND gifted_game IN (${placeholders})
              AND friend_name IS NOT NULL AND trim(friend_name) <> ''
            ORDER BY friend_name
        `)
        .all(dayStart, dayEnd, ...gameNames);
}

function updateDB({ friend, tag, ts }) {
    const bySteamID = STEAMID64_RE.test(String(friend));
    const rows = bySteamID ? findBySteamID.all(String(friend)) : findByName.all(friend);
    const canonical = canonicalGameForTag(tag);
    const aliases = new Set(gameNamesForTag(tag));
    let updated = 0;
    let alreadyMarked = 0;
    const results = rows.map((r) => {
        if (r.gifted_at === ts && aliases.has(r.gifted_game)) {
            alreadyMarked++;
            return { ...r, status: 'already-marked' };
        }
        updateGift.run(ts, canonical, r.account_steam_id, r.friend_steam_id);
        updated++;
        return { ...r, status: 'updated', new_gifted_at: ts, new_gifted_game: canonical };
    });
    return { lookup: bySteamID ? 'steamid' : 'name', matched: rows.length, updated, alreadyMarked, rows: results, names: [...new Set(rows.map((r) => r.friend_name).filter(Boolean))] };
}

function emailPrefixFromLine(line) {
    if (line.includes('----')) {
        const parts = line.split('----');
        if (parts.length < 3) return '';
        const email = (parts[2] || '').trim();
        return (email.split('@')[0] || '').trim();
    }
    if (line.includes('|')) {
        const parts = line.split('|');
        if (parts.length < 2) return '';
        const email = (parts[1] || '').trim();
        return (email.split('@')[0] || '').trim();
    }
    return '';
}

function splitLinesPreservingEol(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
        let j = i;
        while (j < text.length && text[j] !== '\r' && text[j] !== '\n') j++;
        const content = text.slice(i, j);
        let eol = '';
        if (text[j] === '\r' && text[j + 1] === '\n') eol = '\r\n';
        else if (text[j] === '\r') eol = '\r';
        else if (text[j] === '\n') eol = '\n';
        out.push({ content, eol });
        i = j + eol.length;
        if (eol === '' && j === text.length) break;
    }
    return out;
}

function updateFile({ file, keys, tag, stamp }) {
    if (!fs.existsSync(file)) {
        return { fileExists: false, updated: 0, alreadyMarked: 0, matches: [] };
    }
    const marker = `${tag} ${stamp}`;
    const needles = new Set(keys.map((k) => k.toLowerCase()).filter(Boolean));
    if (needles.size === 0) return { fileExists: true, updated: 0, alreadyMarked: 0, matches: [] };
    const original = fs.readFileSync(file, 'utf8');
    const parts = splitLinesPreservingEol(original);
    const matches = [];
    const out = parts.map((p, idx) => {
        const line = p.content;
        if (!line.trim()) return p;
        const prefix = emailPrefixFromLine(line);
        if (!prefix || !needles.has(prefix.toLowerCase())) return p;
        const tokens = line.split('|').map((t) => t.trim());
        if (tokens.includes(marker)) {
            matches.push({ line: idx + 1, status: 'already-marked', prefix });
            return p;
        }
        matches.push({ line: idx + 1, status: 'updated', prefix });
        return { content: `${line}|${marker}`, eol: p.eol };
    });
    const updated = matches.filter((m) => m.status === 'updated').length;
    const alreadyMarked = matches.filter((m) => m.status === 'already-marked').length;
    if (updated > 0) {
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, out.map((p) => p.content + p.eol).join(''));
        fs.renameSync(tmp, path.resolve(file));
    }
    return { fileExists: true, updated, alreadyMarked, matches };
}

function markGifted({ friend, tag = DEFAULT_TAG, date, file } = {}) {
    if (!friend) throw new Error('friend is required');
    const ts = date ? parseDate(date) : nowEpoch();
    const stamp = fmtDate(ts);
    const dbRes = updateDB({ friend, tag, ts });

    const keys = new Set(dbRes.names);
    if (dbRes.lookup === 'name') keys.add(String(friend));
    const fileRes = updateFile({
        file: file || process.env.GIFT_FILE || DEFAULT_FILE,
        keys: [...keys],
        tag,
        stamp
    });

    return { ts, stamp, tag, db: dbRes, file: fileRes, fileKeys: [...keys] };
}

function syncFromDB({ tag = DEFAULT_TAG, date, file } = {}) {
    const ts = date ? parseDate(date) : nowEpoch();
    const stamp = fmtDate(ts);
    const [dayStart, dayEnd] = localDayRange(ts);
    const gameNames = gameNamesForTag(tag);
    const friendNames = findGiftedInRange(dayStart, dayEnd, gameNames).map((r) => r.friend_name);

    const filePath = file || process.env.GIFT_FILE || DEFAULT_FILE;
    const fileExists = fs.existsSync(filePath);
    if (!fileExists) {
        return { tag, stamp, dayStart, dayEnd, friendNames, fileExists, perFriend: [], totals: { updated: 0, alreadyMarked: 0, noLine: 0 } };
    }
    const perFriend = friendNames.map((name) => {
        const fileRes = updateFile({ file: filePath, keys: [name], tag, stamp });
        let status = 'no-line';
        if (fileRes.updated > 0) status = 'updated';
        else if (fileRes.alreadyMarked > 0) status = 'already-marked';
        return { friend: name, status, file: fileRes };
    });
    const totals = {
        updated: perFriend.filter((p) => p.status === 'updated').length,
        alreadyMarked: perFriend.filter((p) => p.status === 'already-marked').length,
        noLine: perFriend.filter((p) => p.status === 'no-line').length
    };
    return { tag, stamp, dayStart, dayEnd, friendNames, fileExists, filePath, perFriend, totals };
}

function parseArgs(argv) {
    const out = { positional: [] };
    for (const a of argv) {
        if (a.startsWith('--file=')) out.file = a.slice('--file='.length);
        else if (a.startsWith('--tag=')) out.tag = a.slice('--tag='.length);
        else if (a.startsWith('--date=')) out.date = a.slice('--date='.length);
        else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
        else out.positional.push(a);
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
    const [friendPos, tagPos, datePos] = args.positional;
    const tag = tagPos || args.tag || DEFAULT_TAG;
    const date = datePos || args.date;
    const filePath = args.file || process.env.GIFT_FILE || DEFAULT_FILE;

    try {
        if (!friendPos) {
            const res = syncFromDB({ tag, date, file: args.file });
            const dayLabel = `${fmtDate(res.dayStart)} (local)`;
            console.log(`Sync mode: tag='${res.tag}' day=${dayLabel}`);
            console.log(`  ${res.friendNames.length} distinct friend(s) gifted in DB`);
            if (!res.fileExists) {
                console.log(`  FILE: ${filePath} not found — skipped`);
                process.exit(2);
            }
            console.log(`  FILE: ${filePath}`);
            res.perFriend.forEach((p) => {
                const lineInfo = p.file.matches.map((m) => `line ${m.line}`).join(', ');
                console.log(`    ${p.friend}: ${p.status}${lineInfo ? ` (${lineInfo})` : ''}`);
            });
            console.log(`  Totals: updated=${res.totals.updated} already-marked=${res.totals.alreadyMarked} no-line=${res.totals.noLine}`);
            return;
        }

        const res = markGifted({ friend: friendPos, tag, date, file: args.file });
        console.log(`friend='${friendPos}' (${res.db.lookup}) tag='${tag}' date=${res.stamp}`);
        console.log(`  DB:   matched=${res.db.matched} updated=${res.db.updated} already-marked=${res.db.alreadyMarked}`);
        res.db.rows.forEach((r) => {
            const detail = r.status === 'updated'
                ? `(was: ${r.gifted_game || '(null)'} @ ${fmtDate(r.gifted_at)})`
                : '';
            console.log(`    [${r.account_steam_id}] ${r.friend_name}: ${r.status} ${detail}`.trim());
        });
        if (!res.file.fileExists) {
            console.log(`  FILE: ${filePath} not found — skipped`);
        } else {
            console.log(`  FILE: ${filePath}`);
            console.log(`        keys=[${res.fileKeys.join(', ')}] updated=${res.file.updated} already-marked=${res.file.alreadyMarked}`);
            res.file.matches.forEach((m) => console.log(`        line ${m.line}: ${m.status}`));
            if (res.file.matches.length === 0) console.log('        no matching line found');
        }
        if (res.db.matched === 0 && res.file.updated === 0 && res.file.alreadyMarked === 0) process.exit(2);
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

if (require.main === module) runCli();

module.exports = { markGifted, syncFromDB };
