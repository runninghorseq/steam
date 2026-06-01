const https = require('https');
const fs = require('fs');
const path = require('path');

const JWT = process.env.G2G_JWT || process.argv[2];
const OFFER_ID = process.argv[3];
const NEW_PRICE = Number(process.argv[4]);
const skipConfirm = process.argv.includes('--yes');
const SNAPSHOT_PATH = path.join(__dirname, 'offers.json');

if (!JWT || !OFFER_ID || !isFinite(NEW_PRICE) || NEW_PRICE <= 0) {
    console.error('Usage: node update_offer_price_internal.js <JWT> <OFFER_ID> <NEW_PRICE> [--yes]');
    console.error('   or: G2G_JWT=... node update_offer_price_internal.js <OFFER_ID> <NEW_PRICE>');
    console.error('Example: node update_offer_price_internal.js eyJhbGc... G1762917817424JG 55');
    process.exit(1);
}

function request(method, path, body) {
    return new Promise((resolve, reject) => {
        const bodyStr = body ? JSON.stringify(body) : null;
        const headers = {
            'accept': 'application/json, text/plain, */*',
            'authorization': JWT,
            'content-type': 'application/json',
            'origin': 'https://www.g2g.com',
            'referer': 'https://www.g2g.com/',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
        };
        if (bodyStr) headers['content-length'] = Buffer.byteLength(bodyStr);

        const req = https.request({ hostname: 'sls.g2g.com', path, method, headers }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                let parsed = data;
                try { parsed = JSON.parse(data); } catch {}
                resolve({ status: res.statusCode, data: parsed });
            });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

(async () => {
    const getPath = '/offer?id=' + encodeURIComponent(OFFER_ID) + '&currency=USD';
    const got = await request('GET', getPath, null);
    if (got.status !== 200 || !got.data || !got.data.payload || !got.data.payload.results || !got.data.payload.results[0]) {
        console.error('GET failed:', got.status, JSON.stringify(got.data));
        process.exit(2);
    }
    const o = got.data.payload.results[0];
    const currentPrice = Number(o.unit_price);

    if (!fs.existsSync(SNAPSHOT_PATH)) {
        console.error('ERROR: offers.json snapshot not found at', SNAPSHOT_PATH);
        console.error('The internal GET endpoint does not return description, so we need a snapshot to avoid wiping it.');
        console.error('Run `node g2g/list_offers.js` first.');
        process.exit(5);
    }
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    const snap = snapshot.find(s => s.offer_id === OFFER_ID);
    if (!snap) {
        console.error('ERROR: offer', OFFER_ID, 'not found in offers.json snapshot.');
        console.error('Run `node g2g/list_offers.js` to refresh, then retry.');
        process.exit(6);
    }

    console.log('Offer:    ', o.offer_id);
    console.log('Title:    ', o.title);
    console.log('Status:   ', o.status);
    console.log('Currency: ', o.currency);
    console.log('Qty:      ', o.available_qty);
    console.log('Current:  ', currentPrice);
    console.log('New:      ', NEW_PRICE);
    console.log('Delta:    ', (NEW_PRICE - currentPrice).toFixed(4),
        '(' + (((NEW_PRICE - currentPrice) / currentPrice) * 100).toFixed(2) + '%)');

    if (NEW_PRICE === currentPrice) {
        console.log('No change. Exiting.');
        return;
    }

    if (!skipConfirm) {
        process.stdout.write('Proceed? (y/N) ');
        const answer = await new Promise(resolve => {
            process.stdin.resume();
            process.stdin.once('data', d => resolve(d.toString().trim().toLowerCase()));
        });
        process.stdin.pause();
        if (answer !== 'y' && answer !== 'yes') {
            console.log('Aborted.');
            return;
        }
    }

    const body = {
        seller_id: o.seller_id,
        delivery_method_ids: o.delivery_method_ids || [],
        delivery_speed: o.delivery_speed || 'manual',
        delivery_speed_details: o.delivery_speed_details && o.delivery_speed_details.length
            ? o.delivery_speed_details
            : [{ min: 1, max: 2147483647, delivery_time: 60 }],
        qty: Number(o.available_qty) || 0,
        currency: o.currency,
        min_qty: Number(o.min_qty) || 1,
        low_stock_alert_qty: Number(o.low_stock_alert_qty) || 0,
        sales_territory_settings: o.sales_territory_settings || { settings_type: 'global', countries: [] },
        title: o.title || snap.title || '',
        description: (snap.description !== undefined ? snap.description : o.description) || '',
        offer_attributes: o.offer_attributes || [],
        external_images_mapping: o.external_images_mapping || [],
        unit_price: NEW_PRICE,
        other_pricing: o.other_pricing || [],
        wholesale_details: o.wholesale_details || [],
        other_wholesale_details: o.other_wholesale_details || []
    };

    const putPath = '/offer/' + encodeURIComponent(OFFER_ID) + '?v=v2';
    const put = await request('PUT', putPath, body);
    console.log('HTTP', put.status);
    console.log(JSON.stringify(put.data, null, 2));
    if (put.status !== 200) process.exit(3);
})();
