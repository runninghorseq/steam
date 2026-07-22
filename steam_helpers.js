// Helpers for steam-user unified service methods that steam-user exposes no public
// API for. Both send over the same internal `_send` path that _sendUnified uses,
// encoding/decoding protobufs ourselves. Each resolves with a value or null —
// never rejects — so callers can treat a failure as "unknown".
const Schema = require('steam-user/protobufs/generated/_load.js');
const EMsg = require('steam-user/enums/EMsg.js');
const ByteBuffer = require('bytebuffer');
const protobuf = require('protobufjs');

// LoyaltyRewards.GetSummary isn't in steam-user's bundled protobufs, so define the
// minimal request/response shape inline. summary.points is the current spendable
// Steam Points balance (== points_earned - points_spent, verified empirically).
const loyaltyRoot = protobuf.parse(`
    syntax = "proto2";
    message GetSummaryRequest { optional fixed64 steamid = 1; }
    message LoyaltySummary {
        optional int64 points = 1;
        optional int64 points_earned = 2;
        optional int64 points_spent = 3;
    }
    message GetSummaryResponse { optional LoyaltySummary summary = 1; }
`).root;
const GetSummaryRequest = loyaltyRoot.lookupType('GetSummaryRequest');
const GetSummaryResponse = loyaltyRoot.lookupType('GetSummaryResponse');

function sendUnifiedRaw(client, methodName, reqBody, timeout, decode) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (val) => { if (!done) { done = true; resolve(val); } };
        const t = setTimeout(() => finish(null), timeout);
        try {
            client._send(
                { msg: EMsg.ServiceMethodCallFromClient, proto: { target_job_name: methodName } },
                reqBody,
                (body) => {
                    clearTimeout(t);
                    try {
                        const buf = ByteBuffer.isByteBuffer(body) ? body.toBuffer() : body;
                        finish(decode(buf));
                    } catch (_) {
                        finish(null);
                    }
                }
            );
        } catch (_) {
            clearTimeout(t);
            finish(null);
        }
    });
}

/**
 * The account's REAL registered country (not accountInfo's ip_country, which is the
 * login-IP geolocation). Resolves with a 2-letter code or null.
 */
function getUserCountry(client, steamID, timeout = 15000) {
    const reqBody = Schema.CUserAccount_GetUserCountry_Request.encode({ steamid: steamID }).finish();
    return sendUnifiedRaw(client, 'UserAccount.GetUserCountry#1', reqBody, timeout, (buf) => {
        return Schema.CUserAccount_GetUserCountry_Response.decode(buf).country || null;
    });
}

/**
 * The account's current Steam Points balance. Resolves with an integer or null.
 */
function getAccountPoints(client, steamID, timeout = 15000) {
    const reqBody = GetSummaryRequest.encode({ steamid: steamID }).finish();
    return sendUnifiedRaw(client, 'LoyaltyRewards.GetSummary#1', reqBody, timeout, (buf) => {
        const points = GetSummaryResponse.decode(buf).summary?.points;
        return points == null ? null : Number(points);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Steam's server-rendered inventory HTML page returns HTTP 429 ("You've made too
// many requests recently") to requests that don't look like a real browser
// navigation — even the first request from a fresh account/IP. Empirically it
// serves a 200 only when the request carries a browser User-Agent AND the usual
// Accept / Accept-Language / Referer headers (UA alone still 429s). These defaults
// reproduce that; callers may override via opts.headers.
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
};

// A page like .../profiles/<id>/inventory/ should look like it was navigated to
// from the profile page; other URLs just refer to the site origin.
function refererFor(url) {
    try {
        const u = new URL(url);
        const base = `${u.protocol}//${u.host}`;
        const path = u.pathname.replace(/\/inventory\/.*$/, '');
        return path && path !== u.pathname ? base + path : base;
    } catch (_) {
        return 'https://steamcommunity.com';
    }
}

/**
 * GET a steamcommunity URL as a browser would (see BROWSER_HEADERS — required or
 * the inventory page 429s), retrying transient network / 5xx errors with
 * exponential backoff + jitter. Resolves with { ok, status, data, error,
 * rateLimited } and never rejects, matching the "failure = unknown" convention.
 *
 * A 429 is NOT retried by default: with the browser headers it should not occur,
 * and a real "too many requests" penalty counts every failed attempt against a
 * slow quota, so retrying deepens the block. On 429 we fail fast and flag
 * `rateLimited`. Set opts.retryOn429 = true to override.
 */
function fetchCommunityPage(community, url, opts = {}) {
    const { retries = 4, baseDelay = 2000, maxDelay = 30000, retryOn429 = false, headers = {}, log = () => {}, tag = '' } = opts;
    const reqHeaders = { ...BROWSER_HEADERS, Referer: refererFor(url), ...headers };
    return new Promise((resolve) => {
        let attempt = 0;
        const attemptFetch = () => {
            community.httpRequestGet(url, { headers: reqHeaders }, (err, res, data) => {
                const status = res && res.statusCode;
                if (!err && status === 200) return resolve({ ok: true, status, data, rateLimited: false });
                if (status === 429 && !retryOn429) {
                    log(`${tag} rate-limited (HTTP 429) — not retrying; account needs a cooldown before its next inventory load`);
                    return resolve({ ok: false, status, data, error: err, rateLimited: true });
                }
                const retryable = !!err || status === 429 || status === 502 || status === 503;
                if (retryable && attempt < retries) {
                    attempt++;
                    const retryAfter = Number(res && res.headers && res.headers['retry-after']);
                    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
                        ? Math.min(maxDelay, retryAfter * 1000)
                        : Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
                    const wait = backoff + Math.floor(Math.random() * backoff * 0.25);
                    log(`${tag} fetch ${err ? err.message : `status ${status}`} — retry ${attempt}/${retries} in ${wait}ms`);
                    return sleep(wait).then(attemptFetch);
                }
                resolve({ ok: false, status, data, error: err, rateLimited: status === 429 });
            });
        };
        attemptFetch();
    });
}

module.exports = { getUserCountry, getAccountPoints, fetchCommunityPage };
