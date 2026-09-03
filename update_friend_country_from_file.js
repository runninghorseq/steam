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

// The dashboard API owns the friends data now (remote is the source of truth).
// This script parses the local file and POSTs the country mapping to the API,
// which does the matching + writes. No local DB access.
// Override base with STEAM_API_BASE; token via STEAM_API_TOKEN / DASHBOARD_TOKEN.
const API_BASE = (process.env.STEAM_API_BASE || 'https://steam-dashboard.fungamingsteam.workers.dev/').replace(/\/+$/, '');
const API_TOKEN = process.env.STEAM_API_TOKEN || process.env.DASHBOARD_TOKEN || '';

async function apiPost(path, body) {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        // Cloudflare fronts the domain and blocks non-browser signatures.
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    };
    if (API_TOKEN) headers['X-Dashboard-Token'] = API_TOKEN;
    let resp;
    try {
        resp = await fetch(API_BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
        throw new Error(`API unreachable at ${API_BASE} (${e.message})`);
    }
    if (resp.status === 401) throw new Error('API 401 unauthorized — set STEAM_API_TOKEN to match the server DASHBOARD_TOKEN');
    if (!resp.ok) throw new Error(`API ${path} -> HTTP ${resp.status}`);
    return resp.json();
}

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
//   .../acc_new_steam/20260504_steam_4k_outlook.txt
///.  20260504_PTGO1774415483.txtresult.txt
const DEFAULT_FILE =
    '/Users/lequangha/Library/Mobile Documents/com~apple~CloudDocs/fungaming/acc_new_steam/20260606_1491_of_3k_outlook.txtresult.txt';

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

(async () => {
    console.log(`API: ${API_BASE}`);
    console.log(COMMIT ? 'Mode: COMMIT (writes will be saved on the server)' : 'Mode: DRY RUN (no changes written — re-run with --commit to apply)\n');

    let result;
    try {
        result = await apiPost('/api/friends/country', {
            updates: mapping.map((m) => ({ matchBy: m.matchBy, key: m.key, country: m.country })),
            commit: COMMIT
        });
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }

    // Preview (only rows that would change)
    console.log('=== Preview ===');
    for (const c of result.changes || []) {
        const changingRows = (c.rows || []).filter((r) => r.will_change);
        if (changingRows.length === 0) continue;
        const label = c.matchBy === 'steamid' ? `SteamID ${c.key}` : c.key;
        console.log(`\n${label} -> ${c.country}`);
        changingRows.forEach((r) => {
            console.log(`  [${r.account_steam_id}] ${r.friend_name}: ${r.current || '(null)'} -> ${r.new}`);
        });
    }

    console.log('\n=== Summary ===');
    console.log(`Rows that would change:  ${result.willChange}`);
    console.log(`Already correct:         ${result.alreadyCorrect}`);
    console.log(`Unmatched:               ${result.unmatched.length}`);
    if (result.unmatched.length > 0) {
        result.unmatched.slice(0, 10).forEach((u) => {
            const label = u.matchBy === 'steamid' ? `SteamID ${u.key}` : u.key;
            console.log(`  - ${label}`);
        });
        if (result.unmatched.length > 10) console.log(`  ...and ${result.unmatched.length - 10} more`);
    }

    if (!COMMIT) {
        console.log('\nDry run only. Re-run with --commit to save changes.');
        process.exit(0);
    }
    console.log(`\nCommitted on the server. ${result.totalChanges} friend rows updated.`);
    process.exit(0);
})();
