const fs = require('fs');
const path = require('path');
const g2g = require('./g2g_api');

const CSV_PATH = path.join(__dirname, 'offers.csv');

const offerId = process.argv[2];
const newPriceArg = process.argv[3];

if (!offerId || newPriceArg === undefined) {
    console.error('Usage: node update_offer_price.js <OFFER_ID> <NEW_PRICE> [--yes]');
    console.error('Example: node update_offer_price.js G1762917817424JG 49.99');
    console.error('Add --yes to skip confirmation.');
    process.exit(1);
}
const newPrice = Number(newPriceArg);
if (!isFinite(newPrice) || newPrice <= 0) {
    console.error('NEW_PRICE must be a positive number, got:', newPriceArg);
    process.exit(1);
}
const skipConfirm = process.argv.includes('--yes');

function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
            else if (c === '"') { inQuotes = false; }
            else { cell += c; }
        } else {
            if (c === '"') inQuotes = true;
            else if (c === ',') { row.push(cell); cell = ''; }
            else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
            else if (c !== '\r') { cell += c; }
        }
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    const header = rows.shift();
    return rows.filter(r => r.length === header.length).map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

(async () => {
    if (!fs.existsSync(CSV_PATH)) {
        console.error('offers.csv not found at', CSV_PATH, '- run list_offers.js first.');
        process.exit(2);
    }
    const offers = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
    const match = offers.find(o => o.offer_id === offerId);
    if (!match) {
        console.error('Offer', offerId, 'not found in offers.csv. Re-run list_offers.js if it is recent.');
        process.exit(3);
    }

    const currentPrice = Number(match.unit_price);
    console.log('Offer:    ', match.offer_id);
    console.log('Title:    ', match.title);
    console.log('Status:   ', match.status);
    console.log('Currency: ', match.currency);
    console.log('Current:  ', currentPrice);
    console.log('New:      ', newPrice);
    console.log('Delta:    ', (newPrice - currentPrice).toFixed(4), '(' + (((newPrice - currentPrice) / currentPrice) * 100).toFixed(2) + '%)');

    if (newPrice === currentPrice) {
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

    try {
        const res = await g2g.updateOffer(offerId, { unit_price: newPrice });
        console.log('OK', res.statusCode);
        console.log(JSON.stringify(res.data, null, 2));
    } catch (e) {
        console.log('ERR', e.statusCode, JSON.stringify(e.error, null, 2));
        process.exit(4);
    }
})();
