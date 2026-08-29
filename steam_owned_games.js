// Fetch a Steam account's owned games and playtime by SteamID64 (or account name).
//
// Uses the Steam Web API IPlayerService/GetOwnedGames — this only returns data
// when the profile's "Game details" privacy is Public. A private/friends-only
// profile comes back empty, which is reported as such (not an error).
//
// Playtime is stored by Steam in MINUTES; shown here as hours.
//
// Usage:
//   node steam_owned_games.js <steamID64|accountName> [more...] [options]
//
//   <accountName> is resolved via the accounts table (steam_accounts.db), then
//   steam_accounts.js; a 17-digit SteamID64 is used directly.
//
// Options:
//   --top=N     show only the N most-played games (default: all)
//   --recent    sort by last-2-weeks playtime instead of total
//   --json      print raw JSON instead of the formatted report
//
// Examples:
//   node steam_owned_games.js 76561199829091185
//   node steam_owned_games.js daicaso1122 --top=20
//   node steam_owned_games.js daicaso1122 --recent
//   node steam_owned_games.js 76561199829091185 --json

const https = require('https');

const API_KEY = 'EFB5DCE316D3146FD6EFA3BECB8BCB80';

// Optional account-name resolution. The DB is the primary source; steam_accounts.js
// is a fallback. Both are optional — a raw SteamID64 needs neither.
let db = null;
try { ({ db } = require('./db')); } catch (_) {}
let ACCOUNTS = {};
try { ACCOUNTS = require('./steam_accounts'); } catch (_) {}

const STEAMID64_RE = /^7656119\d{10}$/;

function httpsGetJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200 || data.trim().startsWith('<')) {
                    return reject(new Error(`API returned status ${res.statusCode}`));
                }
                try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
            });
        }).on('error', reject);
    });
}

// Resolve a CLI token to { steamID, label }. A 17-digit id is used as-is;
// otherwise it's looked up as an account name in the DB, then steam_accounts.js.
function resolveTarget(token) {
    if (STEAMID64_RE.test(token)) return { steamID: token, label: token };
    if (db) {
        try {
            const row = db.prepare('SELECT steam_id, account_name FROM accounts WHERE lower(account_name) = lower(?)').get(token);
            if (row && row.steam_id) return { steamID: row.steam_id, label: row.account_name };
        } catch (_) {}
    }
    const byLower = Object.keys(ACCOUNTS).find((k) => k.toLowerCase() === token.toLowerCase());
    if (byLower && ACCOUNTS[byLower].steamID) return { steamID: ACCOUNTS[byLower].steamID, label: byLower };
    return null;
}

async function fetchPlayerSummary(steamID) {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${API_KEY}&steamids=${steamID}`;
    const j = await httpsGetJSON(url);
    return ((j.response && j.response.players) || [])[0] || null;
}

async function fetchOwnedGames(steamID) {
    const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${API_KEY}`
        + `&steamid=${steamID}&include_appinfo=1&include_played_free_games=1&format=json`;
    const j = await httpsGetJSON(url);
    const r = j.response || {};
    // A public profile always includes game_count (even 0). Its absence means the
    // game list is private/friends-only.
    return {
        public: Object.prototype.hasOwnProperty.call(r, 'game_count'),
        gameCount: r.game_count ?? 0,
        games: r.games || []
    };
}

const hours = (minutes) => (minutes / 60).toFixed(1);

function personaVisibility(state) {
    // ECommunityVisibilityState: 1 = private, 3 = public.
    return state === 3 ? 'public' : 'private/friends-only';
}

async function reportAccount(token, opts) {
    const target = resolveTarget(token);
    if (!target) {
        console.log(`\n=== ${token} ===`);
        console.log('  could not resolve — not a 17-digit SteamID64 and not a known account name');
        return { token, error: 'unresolved' };
    }

    const [summary, owned] = await Promise.all([
        fetchPlayerSummary(target.steamID).catch(() => null),
        fetchOwnedGames(target.steamID).catch((e) => ({ error: e.message }))
    ]);

    const persona = summary ? summary.personaname : null;
    const header = `${target.label}${persona && target.label !== persona ? ` (${persona})` : ''} · ${target.steamID}`;

    if (owned.error) {
        if (opts.json) return { token, steamID: target.steamID, error: owned.error };
        console.log(`\n=== ${header} ===`);
        console.log(`  error: ${owned.error}`);
        return { token, error: owned.error };
    }

    // Sort by chosen playtime, most first.
    const key = opts.recent ? 'playtime_2weeks' : 'playtime_forever';
    const games = [...owned.games].sort((a, b) => (b[key] || 0) - (a[key] || 0));
    const totalMin = owned.games.reduce((s, g) => s + (g.playtime_forever || 0), 0);
    const recentMin = owned.games.reduce((s, g) => s + (g.playtime_2weeks || 0), 0);
    const playedCount = owned.games.filter((g) => (g.playtime_forever || 0) > 0).length;
    const shown = opts.top ? games.slice(0, opts.top) : games;

    if (opts.json) {
        return {
            token, steamID: target.steamID, persona,
            visibility: summary ? personaVisibility(summary.communityvisibilitystate) : null,
            game_details_public: owned.public,
            game_count: owned.gameCount,
            played_count: playedCount,
            total_playtime_hours: Number(hours(totalMin)),
            recent_playtime_hours: Number(hours(recentMin)),
            games: games.map((g) => ({
                appid: g.appid, name: g.name || `app ${g.appid}`,
                hours_total: Number(hours(g.playtime_forever || 0)),
                hours_2weeks: Number(hours(g.playtime_2weeks || 0))
            }))
        };
    }

    console.log(`\n=== ${header} ===`);
    if (summary) console.log(`  Profile: ${personaVisibility(summary.communityvisibilitystate)}${summary.profileurl ? ` · ${summary.profileurl}` : ''}`);
    if (!owned.public) {
        console.log('  Game details are PRIVATE — owned games / playtime not shared.');
        return { token, steamID: target.steamID, public: false };
    }

    console.log(`  Owned games: ${owned.gameCount} (${playedCount} played)`);
    console.log(`  Total playtime: ${hours(totalMin)} h${recentMin ? ` · last 2 weeks: ${hours(recentMin)} h` : ''}`);
    if (games.length === 0) {
        console.log('  (no games owned, or none shared)');
    } else {
        console.log(`\n  ${opts.recent ? 'Most played (last 2 weeks)' : 'Most played'}${opts.top ? `, top ${opts.top}` : ''}:`);
        const width = Math.max(...shown.map((g) => (g.name || `app ${g.appid}`).length), 4);
        shown.forEach((g) => {
            const name = (g.name || `app ${g.appid}`).padEnd(Math.min(width, 48));
            const parts = [`${hours(g.playtime_forever || 0)} h`];
            if (g.playtime_2weeks) parts.push(`${hours(g.playtime_2weeks)} h/2wk`);
            console.log(`    ${name}  ${parts.join(' · ')}`);
        });
        if (opts.top && games.length > opts.top) {
            console.log(`    … and ${games.length - opts.top} more`);
        }
    }
    return { token, steamID: target.steamID, public: true, gameCount: owned.gameCount, totalHours: Number(hours(totalMin)) };
}

(async () => {
    const argv = process.argv.slice(2);
    const opts = { top: null, recent: false, json: false };
    const tokens = [];
    for (const a of argv) {
        if (a.startsWith('--top=')) opts.top = Math.max(1, parseInt(a.slice('--top='.length), 10) || 0) || null;
        else if (a === '--recent') opts.recent = true;
        else if (a === '--json') opts.json = true;
        else if (a.startsWith('--')) { console.error(`unknown flag: ${a}`); process.exit(1); }
        else tokens.push(a);
    }

    if (tokens.length === 0) {
        console.log('Usage: node steam_owned_games.js <steamID64|accountName> [more...] [--top=N] [--recent] [--json]');
        process.exit(1);
    }

    const results = [];
    for (const token of tokens) {
        try {
            results.push(await reportAccount(token, opts));
        } catch (err) {
            if (opts.json) results.push({ token, error: err.message });
            else console.log(`\n=== ${token} ===\n  error: ${err.message}`);
        }
    }

    if (opts.json) console.log(JSON.stringify(tokens.length === 1 ? results[0] : results, null, 2));
    process.exit(0);
})();
