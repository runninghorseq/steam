// Diagnose why the box's "Refresh wallets/levels" button is (not) skipping
// skip_wallet accounts. Run ON THE BOX:  node diag_d1.js
//
// It reports whether the box is in D1 mode and, using the exact same selection
// the bulk refresh uses, how many accounts it would skip. If USE_D1 is false the
// box is reading its LOCAL skip_wallet flags — not the ones you set via the
// dashboard / wallet_skip.js (those live in D1).

const store = require('./store');

(async () => {
    console.log('CF_ACCOUNT_ID set:      ', !!process.env.CF_ACCOUNT_ID);
    console.log('CF_D1_DATABASE_ID set:  ', !!process.env.CF_D1_DATABASE_ID);
    console.log('CF_API_TOKEN set:       ', !!process.env.CF_API_TOKEN);
    console.log('store.USE_D1 (reads D1):', store.USE_D1);
    console.log('');

    try {
        const sel = await store.walletRefreshSelection();
        const skip = new Set(sel.skip.map((r) => (r.account_name || '').toLowerCase()));
        const lent = new Set(sel.lent.map((r) => (r.account_name || '').toLowerCase()));
        const tokened = sel.tokened.map((a) => a.username);
        const excludedSkip = tokened.filter((u) => skip.has((u || '').toLowerCase()));
        const excludedLent = tokened.filter((u) => lent.has((u || '').toLowerCase()));
        const selected = tokened.filter((u) => !skip.has((u || '').toLowerCase()) && !lent.has((u || '').toLowerCase()));

        console.log(`source of these numbers: ${store.USE_D1 ? 'Cloudflare D1' : 'LOCAL steam_accounts.db'}`);
        console.log(`tokened accounts:          ${tokened.length}`);
        console.log(`skip_wallet flagged total: ${sel.skip.length}`);
        console.log(`  -> excluded (tokened):   ${excludedSkip.length}`);
        console.log(`loaned flagged total:      ${sel.lent.length}`);
        console.log(`  -> excluded (tokened):   ${excludedLent.length}`);
        console.log(`accounts the button runs:  ${selected.length}`);
        if (!store.USE_D1) {
            console.log('\n⚠  USE_D1 is FALSE — the button is skipping only LOCAL skip_wallet flags.');
            console.log('   Set CF_ACCOUNT_ID / CF_D1_DATABASE_ID / CF_API_TOKEN so it reads D1,');
            console.log('   then restart:  pm2 restart steam --update-env');
        }
    } catch (e) {
        console.error('selection failed:', e.message);
        console.error('(in D1 mode this usually means a bad CF_API_TOKEN or D1 access)');
        process.exit(1);
    }
    process.exit(0);
})();
