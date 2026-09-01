// Rotate mailbox (Outlook/Hotmail) OAuth refresh tokens before they expire.
//
// A Microsoft refresh token for a personal account expires after ~90 days of
// inactivity. We exchange each stored `email_refresh_token` (+ `email_client_id`)
// at Microsoft's token endpoint for a NEW refresh token, save it, and stamp
// accounts.email_token_refreshed_at. Run this on a schedule (e.g. monthly) so a
// token is always used well within its lifetime.
//
// Config (env, all optional — defaults suit personal Outlook/Hotmail apps):
//   MS_TOKEN_ENDPOINT  default https://login.microsoftonline.com/common/oauth2/v2.0/token
//   MS_OAUTH_SCOPE     default "offline_access" (offline_access is required to get
//                      a new refresh token back; add a resource scope if the app
//                      needs one, e.g. "offline_access https://outlook.office.com/IMAP.AccessAsUser.All")
//
// Usage:
//   node refresh_email_token.js                 # rotate every stored mailbox token
//   node refresh_email_token.js --due           # only tokens older than 60 days (or never refreshed)
//   node refresh_email_token.js --due=75        # ... older than 75 days
//   node refresh_email_token.js a@x.com b@y.com # only these emails
//   node refresh_email_token.js -c 5            # concurrency (default 3)
//   node refresh_email_token.js --dry-run       # show what would rotate, call nothing

const https = require('https');
const http = require('http');
const { URL } = require('url');
const querystring = require('querystring');
const store = require('./store');

const TOKEN_ENDPOINT = process.env.MS_TOKEN_ENDPOINT || 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const OAUTH_SCOPE = process.env.MS_OAUTH_SCOPE || 'offline_access';

// Reuse TLS connections across the batch.
const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });

// Exchange one refresh token for a new one. Resolves { ok, refresh_token,
// expires_in, error } — never rejects.
function refreshMailToken({ refresh_token, client_id, scope = OAUTH_SCOPE }) {
    return new Promise((resolve) => {
        const form = { client_id, grant_type: 'refresh_token', refresh_token };
        if (scope) form.scope = scope;
        const body = querystring.stringify(form);
        let u;
        try { u = new URL(TOKEN_ENDPOINT); } catch (e) { return resolve({ ok: false, error: `bad MS_TOKEN_ENDPOINT: ${e.message}` }); }
        const isHttp = u.protocol === 'http:'; // Microsoft is https; http only for a local/test endpoint
        const req = (isHttp ? http : https).request({
            hostname: u.hostname, port: u.port || (isHttp ? 80 : 443), path: u.pathname + u.search, method: 'POST',
            agent: isHttp ? undefined : agent,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), Accept: 'application/json' },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                let j;
                try { j = JSON.parse(data); } catch (_) { return resolve({ ok: false, error: `HTTP ${res.statusCode}: ${data.slice(0, 160)}` }); }
                if (j.refresh_token) return resolve({ ok: true, refresh_token: j.refresh_token, access_token: j.access_token, expires_in: j.expires_in });
                // invalid_grant => the refresh token itself is expired/revoked and
                // cannot be renewed; the mailbox must be re-authorized by hand.
                resolve({ ok: false, error: j.error_description ? `${j.error}: ${String(j.error_description).split('\n')[0]}` : (j.error || `HTTP ${res.statusCode}`), code: j.error });
            });
        });
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.setTimeout(20000, () => req.destroy(new Error('timeout')));
        req.write(body);
        req.end();
    });
}

// Rotate one account's mailbox token and persist it. Reusable by the server job.
async function refreshAccount(acc, { log = () => {}, dryRun = false } = {}) {
    const who = acc.email || acc.account_name || acc.steam_id;
    if (!acc.email_refresh_token || !acc.email_client_id) return { ok: false, email: who, reason: 'missing refresh token or client id' };
    if (dryRun) { log(`[${who}] would rotate (last ${acc.email_token_refreshed_at ? new Date(acc.email_token_refreshed_at * 1000).toISOString().slice(0, 10) : 'never'})`); return { ok: true, email: who, dryRun: true }; }
    const r = await refreshMailToken({ refresh_token: acc.email_refresh_token, client_id: acc.email_client_id });
    if (!r.ok) { log(`[${who}] FAIL: ${r.error}`); return { ok: false, email: who, reason: r.error, code: r.code }; }
    try { await store.saveEmailRefreshToken(acc.steam_id, r.refresh_token); }
    catch (e) { log(`[${who}] refreshed but save failed: ${e.message}`); return { ok: false, email: who, reason: `save failed: ${e.message}` }; }
    log(`[${who}] rotated${r.expires_in ? ` (valid ~${Math.round(r.expires_in / 86400)}d)` : ''}`);
    return { ok: true, email: who };
}

async function runWithConcurrency(items, n, worker) {
    let cursor = 0;
    const results = [];
    await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
        while (cursor < items.length) { const i = cursor++; results[i] = await worker(items[i], i); }
    }));
    return results;
}

// Rotate a set of mailbox tokens. Reusable by the dashboard job endpoint.
async function refreshMailTokens({ dueDays = null, emails = null, concurrency = 3, dryRun = false, log = console.log } = {}) {
    let accounts = await store.mailTokenAccounts({ dueDays });
    if (emails && emails.length) {
        const set = new Set(emails.map((e) => e.toLowerCase()));
        accounts = accounts.filter((a) => set.has(String(a.email || '').toLowerCase()));
    }
    log(`${accounts.length} mailbox token(s) to rotate${dueDays != null ? ` (due > ${dueDays}d)` : ''}${dryRun ? ' — DRY RUN' : ''}.`);
    const results = await runWithConcurrency(accounts, concurrency, (acc, i) => {
        log(`>> [${i + 1}/${accounts.length}] ${acc.email || acc.account_name}`);
        return refreshAccount(acc, { log, dryRun });
    });
    const ok = results.filter((r) => r?.ok).length;
    const failed = results.filter((r) => !r?.ok);
    return { total: accounts.length, ok, failed };
}

module.exports = { refreshMailToken, refreshAccount, refreshMailTokens };

if (require.main === module) {
    const argv = process.argv.slice(2);
    let dueDays = null, concurrency = 3, dryRun = false;
    const emails = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--due') dueDays = 60;
        else if (a.startsWith('--due=')) dueDays = parseInt(a.split('=')[1], 10);
        else if (a === '--dry-run') dryRun = true;
        else if (a === '-c' || a === '--concurrency') concurrency = parseInt(argv[++i], 10);
        else if (a.startsWith('--concurrency=')) concurrency = parseInt(a.split('=')[1], 10);
        else if (a.startsWith('--')) { console.error(`unknown flag: ${a}`); process.exit(1); }
        else emails.push(a);
    }
    console.log(`Endpoint: ${TOKEN_ENDPOINT}\nScope: ${OAUTH_SCOPE || '(none)'}\n`);
    refreshMailTokens({ dueDays, emails: emails.length ? emails : null, concurrency, dryRun })
        .then((r) => {
            console.log(`\n=== Done: ${r.ok}/${r.total} rotated, ${r.failed.length} failed ===`);
            r.failed.forEach((f) => console.log(`  FAIL ${f.email}: ${f.reason}`));
            process.exit(0);
        })
        .catch((e) => { console.error('Error:', e.message); process.exit(1); });
}
