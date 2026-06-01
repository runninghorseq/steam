const https = require('https');

const JWT = process.env.G2G_JWT || process.argv[2];
if (!JWT) {
    console.error('Missing JWT. Provide via G2G_JWT env var or as first arg.');
    console.error('Get a fresh JWT by opening g2g.com (logged in) and copying the "authorization" header from any sls.g2g.com XHR in DevTools.');
    process.exit(1);
}

const payload = {
    seller_id: '1001814582',
    delivery_method_ids: [],
    delivery_speed: 'manual',
    delivery_speed_details: [{ min: 1, max: 2147483647, delivery_time: 10 }],
    qty: 1,
    description: '',
    currency: 'USD',
    min_qty: 1,
    low_stock_alert_qty: 0,
    sales_territory_settings: { settings_type: 'global', countries: [] },
    package_settings: [],
    title: 'Kiln',
    offer_attributes: [
        { collection_id: 'lgc_40967_platform', dataset_id: 'lgc_40967_platform_62040' }
    ],
    external_images_mapping: [],
    unit_price: 111,
    other_pricing: [],
    wholesale_details: [],
    other_wholesale_details: [],
    service_id: 'f6a1aba5-473a-4044-836a-8968bbab16d7',
    brand_id: 'lgc_game_40967',
    offer_type: 'public'
};

const body = JSON.stringify(payload);

const req = https.request({
    hostname: 'sls.g2g.com',
    path: '/offer?v=v2',
    method: 'POST',
    headers: {
        'accept': 'application/json, text/plain, */*',
        'authorization': JWT,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'origin': 'https://www.g2g.com',
        'referer': 'https://www.g2g.com/',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
    }
}, (res) => {
    let data = '';
    res.on('data', (c) => data += c);
    res.on('end', () => {
        console.log('HTTP', res.statusCode);
        try {
            const j = JSON.parse(data);
            console.log(JSON.stringify(j, null, 2));
        } catch {
            console.log(data);
        }
    });
});

req.on('error', (e) => console.error('REQ ERR', e));
req.write(body);
req.end();
