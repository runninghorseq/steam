// Crawl current (and optionally historical) prices for Steam apps.
//
// Sources:
//   - store.steampowered.com/api/appdetails  (official, no key, current price per region)
//   - api.isthereanydeal.com                 (official, free key, historical low + current best)
//
// Usage:
//   node crawl_steam_prices.js 730 570 440
//   node crawl_steam_prices.js --file appids.txt --regions us,jp,vn,tr --out prices
//   node crawl_steam_prices.js 1091500 --with-dlc
//   ITAD_KEY=xxxx node crawl_steam_prices.js 730 --history
//
// Output: <out>.json and <out>.csv (defaults to prices.json / prices.csv)

const https = require("https");
const fs = require("fs");
const path = require("path");

// const DEFAULT_REGIONS = ["us", "jp", "vn", "tr", "ar"];
const DEFAULT_REGIONS = ["ua"];
const REQUEST_DELAY_MS = 1500; // polite pacing; Steam rate-limits aggressive callers
const USER_AGENT = "personal-price-analysis/1.0";

function parseArgs(argv) {
    const args = { appIds: [], regions: DEFAULT_REGIONS, out: "prices", history: false, file: null, withDlc: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--file") args.file = argv[++i];
        else if (a === "--regions") args.regions = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
        else if (a === "--out") args.out = argv[++i];
        else if (a === "--history") args.history = true;
        else if (a === "--with-dlc") args.withDlc = true;
        else if (/^\d+$/.test(a)) args.appIds.push(a);
        else throw new Error(`Unknown argument: ${a}`);
    }
    if (args.file) {
        const fromFile = fs.readFileSync(args.file, "utf8")
            .split(/\s+/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
        args.appIds.push(...fromFile);
    }
    if (args.appIds.length === 0) throw new Error("Provide at least one app id (or --file path).");
    return args;
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { "User-Agent": USER_AGENT, "Accept": "application/json" } }, (res) => {
            if (res.statusCode === 429) return reject(new Error("Rate limited (429). Slow down REQUEST_DELAY_MS."));
            if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            const chunks = [];
            res.on("data", c => chunks.push(c));
            res.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`Bad JSON from ${url}: ${e.message}`)); }
            });
        });
        req.on("error", reject);
        req.setTimeout(20000, () => req.destroy(new Error(`Timeout for ${url}`)));
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchSteamPrice(appId, cc, parentAppId = null) {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}&filters=basic,price_overview`;
    const data = await getJson(url);
    const entry = data && data[appId];
    if (!entry || !entry.success) return { appId, parentAppId, region: cc, name: null, available: false };
    const d = entry.data || {};
    const p = d.price_overview;
    return {
        appId,
        parentAppId,
        region: cc,
        name: d.name || null,
        type: d.type || null,
        isFree: !!d.is_free,
        available: true,
        currency: p ? p.currency : null,
        initialPrice: p ? p.initial / 100 : null,
        finalPrice: p ? p.final / 100 : null,
        discountPercent: p ? p.discount_percent : null,
    };
}

async function fetchDlcIds(appId) {
    // dlc[] is included with the `basic` filter; region doesn't affect this list
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`;
    const data = await getJson(url);
    const entry = data && data[appId];
    if (!entry || !entry.success) return [];
    const dlcs = (entry.data && entry.data.dlc) || [];
    return dlcs.map(String);
}

async function fetchItadHistory(appId, key) {
    // ITAD v2 lookup by Steam app id, then history endpoint.
    const lookup = await getJson(`https://api.isthereanydeal.com/games/lookup/v1?key=${key}&appid=${appId}`);
    const game = lookup && lookup.game;
    if (!game || !game.id) return { appId, itadId: null, historicalLow: null, currentLow: null };
    const id = game.id;
    const overview = await getJson(`https://api.isthereanydeal.com/games/overview/v2?key=${key}&country=US`
        + `&ids=${encodeURIComponent(JSON.stringify([id]))}`);
    const ov = overview && overview.prices && overview.prices[0];
    return {
        appId,
        itadId: id,
        title: game.title || null,
        currentLow: ov && ov.current ? { price: ov.current.price.amount, shop: ov.current.shop.name } : null,
        historicalLow: ov && ov.lowest ? { price: ov.lowest.price.amount, shop: ov.lowest.shop.name, date: ov.lowest.timestamp } : null,
    };
}

function toCsv(rows) {
    if (rows.length === 0) return "";
    const cols = Object.keys(rows[0]);
    const esc = v => v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    return [cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const itadKey = args.history ? process.env.ITAD_KEY : null;
    if (args.history && !itadKey) throw new Error("--history requires ITAD_KEY env var (get one free at isthereanydeal.com/apps/my/).");

    console.log(`Crawling ${args.appIds.length} app(s) across regions: ${args.regions.join(",")}${args.withDlc ? " (with DLC)" : ""}`);

    // Expand each input app into [base, ...dlcs] if --with-dlc is set
    const targets = []; // { id, parentId }
    for (const appId of args.appIds) {
        targets.push({ id: appId, parentId: null });
        if (args.withDlc) {
            try {
                const dlcs = await fetchDlcIds(appId);
                console.log(`  ${appId} → ${dlcs.length} DLC(s)`);
                for (const dlcId of dlcs) targets.push({ id: dlcId, parentId: appId });
            } catch (e) {
                console.error(`  ${appId} DLC discovery ERROR: ${e.message}`);
            }
            await sleep(REQUEST_DELAY_MS);
        }
    }

    const rows = [];
    const histRows = [];
    for (const { id: appId, parentId } of targets) {
        for (const cc of args.regions) {
            try {
                const row = await fetchSteamPrice(appId, cc, parentId);
                rows.push(row);
                console.log(`  [${appId}${parentId ? ` dlc-of-${parentId}` : ""} ${cc}] ${row.name || "?"} — ${row.available ? `${row.finalPrice ?? "free/none"} ${row.currency ?? ""}` : "unavailable"}`);
            } catch (e) {
                console.error(`  [${appId} ${cc}] ERROR: ${e.message}`);
                rows.push({ appId, parentAppId: parentId, region: cc, name: null, available: false, error: e.message });
            }
            await sleep(REQUEST_DELAY_MS);
        }
        if (args.history && !parentId) {
            try {
                const h = await fetchItadHistory(appId, itadKey);
                histRows.push(h);
                const lo = h.historicalLow;
                console.log(`  [${appId} history] low: ${lo ? `${lo.price} @ ${lo.shop}` : "n/a"}`);
            } catch (e) {
                console.error(`  [${appId} history] ERROR: ${e.message}`);
                histRows.push({ appId, error: e.message });
            }
            await sleep(REQUEST_DELAY_MS);
        }
    }

    const outBase = path.resolve(args.out);
    fs.writeFileSync(`${outBase}.json`, JSON.stringify({ prices: rows, history: histRows }, null, 2));
    fs.writeFileSync(`${outBase}.csv`, toCsv(rows));
    if (histRows.length) fs.writeFileSync(`${outBase}_history.json`, JSON.stringify(histRows, null, 2));
    console.log(`\nWrote ${outBase}.json and ${outBase}.csv (${rows.length} rows).`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
