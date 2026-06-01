const g2g = require('./g2g_api');

const offerData = {
    product_id: 'a9f570a2-5ac2-4976-a279-a2e89ac83555',
    min_qty: 1,
    api_qty: 1,
    low_stock_alert_qty: 1,
    offer_attributes: [
        {
            attribute_group_id: '6fe9cc61-3e98-4dbc-b4ed-fdd3761eec6e',
            attribute_id: '048739ae-8f3d-42f7-bd09-27c3322d18bc'
        }
    ],
    currency: 'USD',
    unit_price: 95.00,
    sales_territory_settings: {
        settings_type: 'global',
        countries: []
    }
};

console.log('Payload:', JSON.stringify(offerData, null, 2));

g2g.createOffer(offerData)
    .then(r => {
        console.log('STATUS', r.statusCode);
        console.log(JSON.stringify(r.data, null, 2));
    })
    .catch(e => {
        console.log('ERR STATUS', e.statusCode);
        console.log('message:', e.message);
        console.log('error raw:', e.error && (e.error.stack || e.error.message || e.error));
        console.log('full:', e);
    });
