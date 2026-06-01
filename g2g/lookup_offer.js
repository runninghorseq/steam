const https = require('https');

const JWT = process.env.G2G_JWT || process.argv[2];
const OFFER_ID = process.argv[3] || process.env.G2G_OFFER_ID;

if (!JWT || !OFFER_ID) {
    console.error('Usage: node lookup_offer.js <JWT> <OFFER_ID>');
    console.error('   or: G2G_JWT=... G2G_OFFER_ID=... node lookup_offer.js');
    console.error('Example: node lookup_offer.js eyJhbGc... G1778559546530QX');
    process.exit(1);
}

const path = '/offer?id=' + encodeURIComponent(OFFER_ID) + '&currency=USD';

https.get({
    hostname: 'sls.g2g.com',
    path,
    headers: {
        'authorization': JWT,
        'accept': 'application/json',
        'origin': 'https://www.g2g.com',
        'referer': 'https://www.g2g.com/',
        'user-agent': 'Mozilla/5.0'
    }
}, (res) => {
    let data = '';
    res.on('data', (c) => data += c);
    res.on('end', () => {
        let j;
        try { j = JSON.parse(data); } catch { console.error('Non-JSON response:', data); process.exit(2); }
        const offer = j && j.payload && j.payload.results && j.payload.results[0];
        if (!offer) {
            console.error('Offer not found. Raw response:');
            console.error(JSON.stringify(j, null, 2));
            process.exit(3);
        }
        console.log('// Offer:', offer.title, '(' + offer.offer_id + ')');
        console.log('// Service:', offer.service_id);
        console.log('// Currency:', offer.currency, '| Price:', offer.unit_price);
        console.log('');
        console.log('service_id: ' + JSON.stringify(offer.service_id) + ',');
        console.log('brand_id: ' + JSON.stringify(offer.brand_id) + ',');
        console.log('offer_attributes: ' + JSON.stringify(offer.offer_attributes) + ',');
    });
}).on('error', (e) => { console.error('REQ ERR', e); process.exit(4); });
