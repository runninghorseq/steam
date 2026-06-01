const fs = require('fs');
const path = require('path');

const OFFERS_PATH = path.join(__dirname, 'offers.json');
const OUT_PATH = path.join(__dirname, 'steam_appids.json');
const THROTTLE_MS = 250;

function cleanName(title) {
    let s = title;
    s = s.replace(/\[\s*steam\s*\]/gi, '');
    s = s.replace(/\|.*$/, '');
    s = s.replace(/\b(pre[- ]?purchase|pre[- ]?order|new steam account|new steam|new account)\b[:\-]?\s*/gi, '');
    s = s.replace(/,\s*(gmail|hotmail|outlook|microsoft|original\s+\w+).*$/gi, '');
    s = s.replace(/\b(lifetime guarantee|original email|0h played|0 hours? in.?game)\b.*$/gi, '');
    s = s.replace(/\s+-\s+(weekend deal|midweek deal|daily deal|special promotion|introductory offer|black friday sale|holiday sale|summer sale|spring sale|winter sale|autumn sale|free weekend)\b.*$/gi, '');
    s = s.replace(/\s+-\s+not linked\b.*$/gi, '');
    s = s.replace(/\b(standard|digital\s+deluxe|deluxe|ultimate|premium|gold|complete|game\s+of\s+the\s+year|goty)\s+edition\b.*$/gi, '');
    s = s.replace(/\s+-\s+lifetime\b.*$/gi, '');
    s = s.replace(/\s+\(.*\)$/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^[:\-\s]+|[:\-\s]+$/g, '');
    return s;
}

function normalize(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function scoreMatch(query, candidate) {
    const q = normalize(query);
    const c = normalize(candidate);
    if (!q || !c) return 0;
    if (q === c) return 1000;
    if (c.startsWith(q + ' ')) return 800;
    if (q.startsWith(c + ' ')) return 700;
    const qTokens = q.split(' ');
    const cTokens = c.split(' ');
    const setC = new Set(cTokens);
    const overlap = qTokens.filter(t => setC.has(t)).length;
    const lenPenalty = Math.abs(qTokens.length - cTokens.length);
    return overlap * 100 - lenPenalty * 5;
}

const BAD_TOKENS = ['soundtrack', 'ost', 'demo', 'dlc', 'expansion', 'pack', 'season pass', 'bundle', 'wallpaper'];

function isBadCandidate(query, candidateName) {
    const qNorm = normalize(query);
    const cNorm = normalize(candidateName);
    return BAD_TOKENS.some(t => cNorm.includes(t) && !qNorm.includes(t.replace(/\s/g, '')));
}

async function getAppIdFromStore(gameName) {
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameName)}&l=english&cc=US`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.total || !data.items || !data.items.length) return null;

    const scored = data.items.map(it => ({
        appid: it.id,
        name: it.name,
        score: scoreMatch(gameName, it.name),
        bad: isBadCandidate(gameName, it.name)
    }));
    const good = scored.filter(s => !s.bad);
    const pool = good.length ? good : scored;
    pool.sort((a, b) => b.score - a.score);
    const best = pool[0];
    return { appid: best.appid, matched_name: best.name, score: best.score };
}

async function getPriceFromStore(appid) {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=US&l=english&filters=price_overview`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const entry = data && data[String(appid)];
    if (!entry || !entry.success || !entry.data) return { free: false, price: null };
    const po = entry.data.price_overview;
    if (!po) return { free: true, price: null };
    return {
        free: false,
        currency: po.currency,
        initial_cents: po.initial,
        final_cents: po.final,
        discount_percent: po.discount_percent,
        final_formatted: po.final_formatted,
        initial_formatted: po.initial_formatted
    };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    if (!fs.existsSync(OFFERS_PATH)) {
        console.error('offers.json not found at', OFFERS_PATH);
        console.error('Run `node g2g/list_offers.js` first.');
        process.exit(1);
    }
    const offers = JSON.parse(fs.readFileSync(OFFERS_PATH, 'utf8'));
    const candidates = offers.filter(o => o.status === 'live' && o.title && o.title.includes('[STEAM]'));
    console.log(`Found ${candidates.length} live [STEAM] offers in offers.json`);

    const results = [];
    for (let i = 0; i < candidates.length; i++) {
        const o = candidates[i];
        const name = cleanName(o.title);
        process.stdout.write(`[${i + 1}/${candidates.length}] "${name}" ... `);
        try {
            const hit = await getAppIdFromStore(name);
            if (hit) {
                let priceInfo = { free: false, price: null };
                try {
                    await sleep(THROTTLE_MS);
                    priceInfo = await getPriceFromStore(hit.appid);
                } catch (pe) {
                    priceInfo = { free: false, price: null, price_error: pe.message };
                }
                const priceLabel = priceInfo.final_formatted || (priceInfo.free ? 'free' : 'n/a');
                console.log(`appid=${hit.appid} price=${priceLabel} (${hit.matched_name})`);
                results.push({
                    offer_id: o.offer_id,
                    title: o.title,
                    clean_name: name,
                    appid: hit.appid,
                    matched_name: hit.matched_name,
                    price: priceInfo
                });
            } else {
                console.log('no match');
                results.push({ offer_id: o.offer_id, title: o.title, clean_name: name, appid: null, matched_name: null, price: null });
            }
        } catch (e) {
            console.log(`ERR ${e.message}`);
            results.push({ offer_id: o.offer_id, title: o.title, clean_name: name, appid: null, matched_name: null, price: null, error: e.message });
        }
        if (i < candidates.length - 1) await sleep(THROTTLE_MS);
    }

    fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
    const hits = results.filter(r => r.appid).length;
    console.log(`---`);
    console.log(`Matched ${hits}/${results.length} offers to Steam appids`);
    console.log(`Wrote ${OUT_PATH}`);
})();
