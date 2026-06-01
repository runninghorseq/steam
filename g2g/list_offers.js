const fs = require('fs');
const path = require('path');
const g2g = require('./g2g_api');

const STATUSES = ['live', 'delisted', 'requires_modification'];
const PAGE_SIZE = 100;
const OUT_DIR = __dirname;
const JSON_PATH = path.join(OUT_DIR, 'offers.json');
const CSV_PATH = path.join(OUT_DIR, 'offers.csv');

function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

(async () => {
    const all = [];
    for (const status of STATUSES) {
        let page = 1;
        while (true) {
            let res;
            try {
                res = await g2g.searchOffers({ filter: { status }, page_size: PAGE_SIZE, page });
            } catch (e) {
                console.error('ERR', status, 'page', page, e.statusCode, e.error && e.error.message);
                break;
            }
            const results = (res.data.payload && res.data.payload.results) || [];
            console.error('status=' + status, 'page=' + page, 'got=' + results.length);
            results.forEach(o => all.push(Object.assign({ _status: status }, o)));
            if (results.length < PAGE_SIZE) break;
            page++;
        }
    }

    const enriched = all.map(o => ({
        status: o._status,
        offer_id: o.offer_id,
        title: o.title,
        brand_id: o.brand_id,
        service_id: o.service_id,
        currency: o.currency,
        unit_price: o.unit_price,
        available_qty: o.available_qty,
        inventory_value: (Number(o.unit_price) || 0) * (Number(o.available_qty) || 0),
        has_inventory: (Number(o.available_qty) || 0) > 0,
        created_at: o.created_at,
        updated_at: o.updated_at,
        created_iso: o.created_at ? new Date(o.created_at).toISOString() : '',
        updated_iso: o.updated_at ? new Date(o.updated_at).toISOString() : '',
        age_days: o.created_at ? Math.floor((Date.now() - o.created_at) / 86400000) : '',
        description: o.description,
        seller_id: o.seller_id,
        relation_id: o.relation_id,
        region_id: o.region_id,
        edit_url: `https://www.g2g.com/offers/${o.offer_id}/edit`
    }));

    fs.writeFileSync(JSON_PATH, JSON.stringify(enriched, null, 2));

    const cols = Object.keys(enriched[0] || {});
    const lines = [cols.join(',')];
    for (const row of enriched) lines.push(cols.map(c => csvCell(row[c])).join(','));
    fs.writeFileSync(CSV_PATH, lines.join('\n'));

    const liveValue = enriched.filter(r => r.status === 'live').reduce((s, r) => s + r.inventory_value, 0);
    console.error('---');
    console.error('TOTAL', enriched.length, 'offers');
    console.error('LIVE inventory value (sum of unit_price * available_qty):', liveValue.toFixed(2), 'USD');
    console.error('Wrote', JSON_PATH);
    console.error('Wrote', CSV_PATH);
})();
