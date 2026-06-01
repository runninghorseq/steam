const fs = require('fs');
const { scanAccount } = require('./single');

function parseSteamAccounts(filePath) {
    const data = fs.readFileSync(filePath, 'utf8');
    const lines = data.split('\n').filter(l => l.trim());
    return lines.map((line, index) => {
        if (line.includes('|')) {
            const parts = line.split('|');
            return { id: index + 1, username: parts[3], password: parts[4], rawLine: line };
        }
        if (line.includes(':')) {
            const parts = line.split(':');
            return { id: index + 1, username: parts[0], password: parts[1], rawLine: line };
        }
        const parts = line.split('----');
        return { id: index + 1, username: parts[0], password: parts[1], rawLine: line };
    });
}

async function runWithConcurrency(items, n, worker) {
    let cursor = 0;
    const results = [];
    const workers = Array.from({ length: n }, async () => {
        while (cursor < items.length) {
            const idx = cursor++;
            console.log(`>> [${idx + 1}/${items.length}] starting ${items[idx].username}`);
            results[idx] = await worker(items[idx]);
        }
    });
    await Promise.all(workers);
    return results; 
}

(async () => {
    const FILE_NAME = process.argv[2] || 'steam_accounts.txt';
    const CONCURRENCY = parseInt(process.argv[3] || '5', 10);
    const TIMEOUT = parseInt(process.argv[4] || '60000', 10);

    if (!fs.existsSync(FILE_NAME)) {
        console.error(`File not found: ${FILE_NAME}`);
        console.error('Usage: node multi_scan.js [file] [concurrency=5] [timeout_ms=60000]');
        process.exit(1);
    }

    const accounts = parseSteamAccounts(FILE_NAME);
    console.log(`Loaded ${accounts.length} accounts from ${FILE_NAME}. Concurrency: ${CONCURRENCY}.`);

    const results = await runWithConcurrency(accounts, CONCURRENCY, (acc) => scanAccount(acc, { timeout: TIMEOUT }));

    const ok = results.filter(r => r?.ok).length;
    const failed = results.filter(r => !r?.ok);
    console.log(`\n=== Done: ${ok}/${results.length} ok ===`);
    failed.forEach(r => console.log(`  FAIL ${r.account.username}: ${r.reason}`));
    process.exit(0);
})();
