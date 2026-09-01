// Health check for the D1 write-through mirror. Run ON THE BOX:  node check_d1_mirror.js
// Confirms the CLOUDFLARE_*/D1_* env vars are set correctly and that a real
// query round-trips to D1. Catches the two things that bite: mirror not active
// (env missing), and a malformed ACCOUNT_ID/DB_ID (stray space/quote/newline).

const mirror = require('./d1_mirror');

function showEnv(name) {
    const v = process.env[name];
    if (v === undefined) return console.log(`  ${name.padEnd(24)} MISSING`);
    // reveal stray whitespace/quotes that break the request path
    const clean = /^[A-Za-z0-9-]+$/.test(v);
    console.log(`  ${name.padEnd(24)} "${v}"  len=${v.length}  ${clean ? 'ok' : '⚠ has non [A-Za-z0-9-] chars (space/quote/newline?)'}`);
}

(async () => {
    console.log('env:');
    ['D1_MIRROR', 'CLOUDFLARE_ACCOUNT_ID', 'D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN'].forEach(showEnv);
    console.log('');
    const r = await mirror.ping();
    console.log('ping:', JSON.stringify(r));
    if (r.active && r.ok) console.log('\n✅ mirror is active and D1 is reachable — writes will sync.');
    else if (!r.active) console.log('\n❌ mirror NOT active — set D1_MIRROR=1 + CLOUDFLARE_ACCOUNT_ID + D1_DATABASE_ID + CLOUDFLARE_API_TOKEN, then restart.');
    else console.log(`\n❌ mirror active but D1 unreachable: ${r.error}\n   (check the token has D1 Edit, and ACCOUNT_ID/DB_ID have no stray characters)`);
    process.exit(0);
})();
