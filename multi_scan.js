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

async function runSequentially(items, worker) {
    const results = [];
    for (let idx = 0; idx < items.length; idx++) {
        console.log(`>> [${idx + 1}/${items.length}] starting ${items[idx].username}`);
        results[idx] = await worker(items[idx]);
    }
    return results;
}

// Exported so the web dashboard (server.js) parses uploads with exactly this
// logic instead of keeping a second copy that can drift.
module.exports = { parseSteamAccounts, runSequentially };

if (require.main !== module) return;

(async () => {
    const FILE_NAME = process.argv[2] || 'steam_accounts.txt';
    const TIMEOUT = parseInt(process.argv[3] || '60000', 10);

    if (!fs.existsSync(FILE_NAME)) {
        console.error(`File not found: ${FILE_NAME}`);
        console.error('Usage: node multi_scan.js [file] [timeout_ms=60000]');
        process.exit(1);
    }

    const accounts = parseSteamAccounts(FILE_NAME);
    console.log(`Loaded ${accounts.length} accounts from ${FILE_NAME}. Processing one by one.`);

    const results = await runSequentially(accounts, (acc) => scanAccount(acc, { timeout: TIMEOUT }));

    const ok = results.filter(r => r?.ok).length;
    const guardSkipped = results.filter(r => !r?.ok && r?.skipped);
    const failed = results.filter(r => !r?.ok && !r?.skipped);
    console.log(`\n=== Done: ${ok}/${results.length} ok, ${failed.length} failed${guardSkipped.length ? `, ${guardSkipped.length} Steam-Guard-skipped` : ''} ===`);
    failed.forEach(r => console.log(`  FAIL ${r.account.username}: ${r.reason}`));
    guardSkipped.forEach(r => console.log(`  SKIP ${r.account.username}: ${r.reason}`));
    process.exit(0);
})();
