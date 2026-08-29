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
// Defaults: tag=poe2ea, date=today (local). Source file path defaults to:
//   /Users/lequangha/Library/Mobile Documents/com~apple~CloudDocs/fungaming/acc_new_steam/steam_cis_gift.txt
// Override with env var GIFT_FILE or the --file=<path> flag.
//
// CLI:
//   node steam/mark_gifted.js                                 # sync today, tag=poe2ea
//   node steam/mark_gifted.js --auto                          # sync today, auto-detect each recipient's pack
//   node steam/mark_gifted.js --auto --date=20260726          # auto-detect for that day
//   node steam/mark_gifted.js --tag=cs2                       # sync today, tag=cs2
//   node steam/mark_gifted.js --date=20260530                 # sync that day, tag=poe2ea
//   node steam/mark_gifted.js mp753932                        # mark friend, tag=poe2ea, today
//   node steam/mark_gifted.js mp753932 poe2 20260530          # full explicit
//   node steam/mark_gifted.js 76561199860275357 poe2          # by steamid
//
// Programmatic:
//   const { markGifted, syncFromDB } = require('./mark_gifted');
//   markGifted({ friend: 'mp753932' });                       // defaults to poe2ea + today
//   syncFromDB();                                             // sync all today/poe2ea

const fs = require('fs');
const path = require('path');
const { db } = require('./db');

// The dashboard API owns the gift records now (steam_profile_login.py writes
// there). Auto/sync modes read the day's gifted recipients from it instead of
// the local DB, so this stays consistent with wherever the bot recorded them.
// Override with STEAM_API_BASE; token via STEAM_API_TOKEN / DASHBOARD_TOKEN.
// Single-friend mode still uses the LOCAL db (it's a manual override).
const API_BASE = (process.env.STEAM_API_BASE || 'https://steam.fungamingvn.space').replace(/\/+$/, '');
const API_TOKEN = process.env.STEAM_API_TOKEN || process.env.DASHBOARD_TOKEN || '';

async function fetchGifted(dayStart, dayEnd) {
    const headers = {
        // Cloudflare fronts the domain and blocks non-browser signatures.
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'application/json',
    };
    if (API_TOKEN) headers['X-Dashboard-Token'] = API_TOKEN;
    let resp;
    try {
        resp = await fetch(`${API_BASE}/api/gifted?start=${dayStart}&end=${dayEnd}`, { headers });
    } catch (e) {
        throw new Error(`API unreachable at ${API_BASE} (${e.message})`);
    }
    if (resp.status === 401) throw new Error('API 401 unauthorized — set STEAM_API_TOKEN to match the server DASHBOARD_TOKEN');
    if (!resp.ok) throw new Error(`API /api/gifted -> HTTP ${resp.status}`);
    return resp.json(); // { sent: [{friend_name, game}], gifted: [{friend_name, game}] }
}

const GIFT_DIR = '/Users/lequangha/Library/Mobile Documents/com~apple~CloudDocs/fungaming/acc_new_steam';
const DEFAULT_FILE = [
    '20251117_accsteam_57KIJUKFJD_85_pearl.txt',
    '20251123_accsteam_LICN16HSJX_85_deale.txt',
    'steam_brasil.txt',
    '20260427_OPFH1777198116_444.txt',
    'steam_cis_gift.txt',
    '20251106_accsteam_MZGSS5TD4B_60_towaj.txt',
    '20251124_accsteam_CZ2LNYHQ4F_135_sovikjrollexq.txt',
    '20260502_2k_outlook_20260420.txt',
    '20251218_accsteamvn_EGTT97H1H9_110_tepo.txt',
    'steam_hotmail_Marcow.txt',
    '20260304_accsteam_QUDT1772289980_f800.txt',
    'dataloifb_04242026.txt',
    '20260409_PTGO1774415483_f40.txt',
    '20251128_accsteam_ZL0OBRNNXJ1_190_kienpoe222.txt',
    '20260507_1910_from_2k.txtresult.txt',
    '20251204_accsteam_SPHFWLDOLN_90_duan.txt',
    '20260302_accsteam_QUDT1772289980_51_pro.txt',
    '20251031_accsteam_MCO2RAIFV1_50_meoqua.txt',
    '20251208_accsteam_OPJEUW69FU_79_alen_kadic.txt',
    '20260319_YOKT1773745893_f600.txt',
    '20260412_PTGO1774415483_f500_macpro.txt',
    '20260513_2650_outlook.txtresult.txt',
    '20260526_1k_outlook_2005.txtresult.txt',
    '20260606_1491_of_3k_outlook.txtresult.txt',
    '20251021_steam_A4EFUPVYPJ_35.txt',
    '20260604_2650_outlook.txt.missing.txtresult.txt',
    '20260504_steam_4k_outlook.txt',
    '20260504_PTGO1774415483.txtresult.txt',
    '20251201_accsteam_PXFC2BCSMK_80_leori.txt',
].map((name) => path.join(GIFT_DIR, name));
const DEFAULT_TAG = 'poe2ea';

// Normalize the file input into a list of paths. Accepts an explicit string or
// array (from the --file flag or programmatic call), a comma-separated
// GIFT_FILE env var, or falls back to DEFAULT_FILE.
function resolveFiles(file) {
    if (file) return (Array.isArray(file) ? file : [file]).filter(Boolean);
    if (process.env.GIFT_FILE) {
        return process.env.GIFT_FILE.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return DEFAULT_FILE;
}

// Maps a short tag (used in the file marker and CLI) to the canonical Steam
// item_name(s) that may appear in friends.gifted_game. First entry is the
// canonical form that single-friend mode writes back to the DB. Extra entries
// are accepted as equivalent when filtering or checking idempotency, so rows
// written by either the gifting bot or older script runs both match.
const TAG_ALIASES = {
    poe2: ['Path of Exile 2', 'poe2'],
    // game2: the follow-up regular Early Access Supporter Pack. Unlike poe2, this
    // gift is recorded in the sent_gifts table (item_name), NOT friends.gifted_game,
    // so it is listed in SENT_GIFTS_TAGS below and sourced from there in sync mode.
    poe2ea: ['Path of Exile 2 - Early Access Supporter Pack'],
    // PoE1 supporter packs gifted by steam_profile_login.py (poe1_curator /
    // poe1_iron / poe1_plague / poe1_remidus). Recorded in sent_gifts.item_name,
    // so also in SENT_GIFTS_TAGS.
    poe1cw: ['Path of Exile - Curator of Wisdom Supporter Pack'],
    poe1ii: ['Path of Exile - Iron Incarcerator Supporter Pack'],
    poe1pg: ['Path of Exile - Plague Supporter Pack'],
    poe1rm: ['Path of Exile - Remidus Supporter Pack'],
    isle: ['The Isle'],


};

// Tags whose gift record lives in sent_gifts.item_name rather than
// friends.gifted_game. Sync mode pulls recipients from sent_gifts for these.
const SENT_GIFTS_TAGS = new Set(['poe2ea', 'poe1cw', 'poe1ii', 'poe1pg', 'poe1rm']);

function gameNamesForTag(tag) {
    return TAG_ALIASES[tag] || [tag];
}
function canonicalGameForTag(tag) {
    return gameNamesForTag(tag)[0];
}
function isSentGiftsTag(tag) {
    return SENT_GIFTS_TAGS.has(tag);
}

// Reverse map: canonical Steam item_name / gifted_game (lowercased) -> tag.
// Used by auto mode to detect which pack each recipient got. First tag wins if
// a name is listed under more than one.
const NAME_TO_TAG = {};
for (const [tag, names] of Object.entries(TAG_ALIASES)) {
    for (const n of names) {
        const k = (n || '').toLowerCase();
        if (k && !(k in NAME_TO_TAG)) NAME_TO_TAG[k] = tag;
    }
}
function tagForGameName(name) {
    return NAME_TO_TAG[(name || '').toLowerCase()] || null;
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
        // Already-marked if a token IS the marker, or STARTS WITH it followed by
        // a suffix annotation (e.g. the gifting bot appends " -> fb"). An exact
        // match alone would miss those and append a duplicate marker.
        if (tokens.some((t) => t === marker || t.startsWith(`${marker} `))) {
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
    if (isSentGiftsTag(tag)) {
        // This gift lives in sent_gifts, not friends.gifted_game. Writing it via
        // single-friend mode would overwrite the friend's game1 marker, so it's
        // only supported in sync mode (which reads from sent_gifts).
        throw new Error(`tag '${tag}' is recorded in sent_gifts — use sync mode (no friend arg) instead of single-friend mode`);
    }
    const ts = date ? parseDate(date) : nowEpoch();
    const stamp = fmtDate(ts);
    const dbRes = updateDB({ friend, tag, ts });

    const keys = new Set(dbRes.names);
    if (dbRes.lookup === 'name') keys.add(String(friend));
    const files = resolveFiles(file).map((path) => ({
        path,
        ...updateFile({ file: path, keys: [...keys], tag, stamp })
    }));

    return { ts, stamp, tag, db: dbRes, files, fileKeys: [...keys] };
}

async function syncFromDB({ tag = DEFAULT_TAG, date, file } = {}) {
    const ts = date ? parseDate(date) : nowEpoch();
    const stamp = fmtDate(ts);
    const [dayStart, dayEnd] = localDayRange(ts);
    const gameNames = gameNamesForTag(tag);
    const lowerNames = new Set(gameNames.map((n) => (n || '').toLowerCase()));
    const { sent, gifted } = await fetchGifted(dayStart, dayEnd);
    const src = isSentGiftsTag(tag) ? sent : gifted;
    const friendNames = [...new Set(
        src.filter((r) => lowerNames.has((r.game || '').toLowerCase()))
           .map((r) => r.friend_name).filter(Boolean)
    )];

    const files = resolveFiles(file).map((filePath) => {
        const fileExists = fs.existsSync(filePath);
        if (!fileExists) {
            return { path: filePath, fileExists, perFriend: [], totals: { updated: 0, alreadyMarked: 0, noLine: 0 } };
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
        return { path: filePath, fileExists, perFriend, totals };
    });
    return { tag, stamp, dayStart, dayEnd, friendNames, files };
}

// Auto-detect mode: for the given day, mark every recipient with the tag of the
// item they actually received (from sent_gifts AND friends.gifted_game), so one
// run back-fills all packs without specifying --tag. Unmapped items are skipped.
async function syncAuto({ date, file } = {}) {
    const ts = date ? parseDate(date) : nowEpoch();
    const stamp = fmtDate(ts);
    const [dayStart, dayEnd] = localDayRange(ts);

    const detected = [];        // {friend, tag}
    const unknown = new Set();  // item/game names with no tag mapping
    const add = (rows) => rows.forEach((r) => {
        const tag = tagForGameName(r.game);
        if (tag) detected.push({ friend: r.friend_name, tag });
        else if (r.game && r.game.trim()) unknown.add(r.game);
    });
    const { sent, gifted } = await fetchGifted(dayStart, dayEnd);
    add(sent);
    add(gifted);

    // Dedup (friend, tag).
    const seen = new Set();
    const pairs = detected.filter(({ friend, tag }) => {
        const k = `${tag} ${(friend || '').toLowerCase()}`;
        if (!friend || seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    const files = resolveFiles(file).map((filePath) => {
        const fileExists = fs.existsSync(filePath);
        if (!fileExists) {
            return { path: filePath, fileExists, perFriend: [], totals: { updated: 0, alreadyMarked: 0, noLine: 0 } };
        }
        const perFriend = pairs.map(({ friend, tag }) => {
            const fileRes = updateFile({ file: filePath, keys: [friend], tag, stamp });
            let status = 'no-line';
            if (fileRes.updated > 0) status = 'updated';
            else if (fileRes.alreadyMarked > 0) status = 'already-marked';
            return { friend, tag, status };
        });
        const totals = {
            updated: perFriend.filter((p) => p.status === 'updated').length,
            alreadyMarked: perFriend.filter((p) => p.status === 'already-marked').length,
            noLine: perFriend.filter((p) => p.status === 'no-line').length
        };
        return { path: filePath, fileExists, perFriend, totals };
    });
    return { stamp, dayStart, dayEnd, pairs, unknown: [...unknown], files };
}

function parseArgs(argv) {
    const out = { positional: [] };
    for (const a of argv) {
        if (a.startsWith('--file=')) out.file = a.slice('--file='.length);
        else if (a.startsWith('--tag=')) out.tag = a.slice('--tag='.length);
        else if (a.startsWith('--date=')) out.date = a.slice('--date='.length);
        else if (a === '--auto') out.auto = true;
        else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
        else out.positional.push(a);
    }
    return out;
}

async function runCli() {
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

    try {
        if (!friendPos && (args.auto || tag === 'auto')) {
            const res = await syncAuto({ date, file: args.file });
            console.log(`Auto sync: day=${fmtDate(res.dayStart)} (local)`);
            const byTag = {};
            res.pairs.forEach((p) => { (byTag[p.tag] = byTag[p.tag] || new Set()).add(p.friend); });
            Object.entries(byTag).forEach(([t, s]) => console.log(`  tag='${t}': ${s.size} recipient(s)`));
            if (res.pairs.length === 0) console.log('  no gifted recipients detected for this day');
            if (res.unknown.length) console.log(`  (unmapped item(s), skipped: ${res.unknown.join(', ')})`);
            let anyExists = false;
            res.files.forEach((f) => {
                if (!f.fileExists) return;
                anyExists = true;
                if (f.totals.updated === 0) return;
                console.log(`  FILE: ${f.path}`);
                f.perFriend.forEach((p) => {
                    if (p.status === 'updated') console.log(`    ${p.friend} [${p.tag}]: updated`);
                });
                console.log(`  Totals: updated=${f.totals.updated} already-marked=${f.totals.alreadyMarked} no-line=${f.totals.noLine}`);
            });
            if (!anyExists) process.exit(2);
            return;
        }
        if (!friendPos) {
            const res = await syncFromDB({ tag, date, file: args.file });
            const dayLabel = `${fmtDate(res.dayStart)} (local)`;
            console.log(`Sync mode: tag='${res.tag}' day=${dayLabel}`);
            console.log(`  ${res.friendNames.length} distinct friend(s) gifted in DB`);
            let anyExists = false;
            res.files.forEach((f) => {
                if (!f.fileExists) return;
                anyExists = true;
                if (f.totals.updated === 0) return;
                console.log(`  FILE: ${f.path}`);
                f.perFriend.forEach((p) => {
                    if (p.status !== 'updated') return;
                    const lineInfo = p.file.matches.map((m) => `line ${m.line}`).join(', ');
                    console.log(`    ${p.friend}: ${p.status}${lineInfo ? ` (${lineInfo})` : ''}`);
                });
                console.log(`  Totals: updated=${f.totals.updated} already-marked=${f.totals.alreadyMarked} no-line=${f.totals.noLine}`);
            });
            if (!anyExists) process.exit(2);
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
        let anyFileTouched = false;
        res.files.forEach((f) => {
            if (!f.fileExists) {
                console.log(`  FILE: ${f.path} not found — skipped`);
                return;
            }
            console.log(`  FILE: ${f.path}`);
            console.log(`        keys=[${res.fileKeys.join(', ')}] updated=${f.updated} already-marked=${f.alreadyMarked}`);
            f.matches.forEach((m) => console.log(`        line ${m.line}: ${m.status}`));
            if (f.matches.length === 0) console.log('        no matching line found');
            if (f.updated > 0 || f.alreadyMarked > 0) anyFileTouched = true;
        });
        if (res.db.matched === 0 && !anyFileTouched) process.exit(2);
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

if (require.main === module) runCli().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });

module.exports = { markGifted, syncFromDB, syncAuto };
