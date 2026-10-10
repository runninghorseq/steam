const SteamUser = require('steam-user');
const store = require('./store');

/**
 * Log into a single account and create ONE quick invite link (the shareable
 * "add me" link — steam-user's createQuickInviteLink, same call multi_friend.js
 * uses in MODE='create'). Resolves with
 *   { ok, username, invite_link, invite_limit, invite_duration, time_created }
 * or { ok:false, reason } / { ok:false, skipped:true, reason } — never rejects,
 * matching the other per-account job modules.
 *
 * opts.inviteLimit    max uses of the link (default 1000, as in multi_friend.js)
 * opts.inviteDuration seconds until it expires, or null = never (default null)
 */
function createInviteLink(account, opts = {}) {
    const { timeout = 60000, log = console.log } = opts;
    const inviteLimit = Number.isFinite(Number(opts.inviteLimit)) && Number(opts.inviteLimit) > 0
        ? Number(opts.inviteLimit) : 1000;
    const inviteDuration = opts.inviteDuration == null || opts.inviteDuration === ''
        ? null : Number(opts.inviteDuration);
    const tag = `[${account.username}]`;

    return new Promise((resolve) => {
        // Renew the refresh token on a refresh-token login so its ~200-day expiry
        // keeps sliding forward (see update_wallet_level.js for the rationale).
        const client = new SteamUser({ renewRefreshTokens: true });
        let resolved = false;

        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            try { client.logOff(); } catch (_) {}
            resolve(result);
        };

        const timer = setTimeout(() => {
            log(`${tag} timeout`);
            finish({ ok: false, reason: 'timeout', username: account.username });
        }, timeout);

        client.on('error', (err) => {
            log(`${tag} error:`, err.message);
            // A dead credential/token — drop the cached token so the next attempt
            // re-fetches one (matches update_wallet_level.js).
            if (/InvalidPassword|AccessDenied|Expired/i.test(err.message)) {
                store.clearRefreshToken(account.username).catch(() => {});
                log(`${tag} cleared cached refresh token`);
            }
            finish({ ok: false, reason: err.message, username: account.username });
        });

        client.on('refreshToken', (token) => {
            store.saveRefreshToken(account.username, token).catch(() => {});
            log(`${tag} refresh token saved`);
        });

        // Steam Guard can't be answered from a background job — skip, like the
        // other per-account job modules do.
        client.on('steamGuard', (domain) => {
            const why = domain ? `Steam Guard email required (${domain})` : 'Steam Guard App code required';
            log(`${tag} skipping: ${why}`);
            finish({ ok: false, skipped: true, reason: why, username: account.username });
        });

        client.on('loggedOn', () => {
            const steamID = client.steamID.getSteamID64();
            log(`${tag} logged in: ${steamID}`);
            client.createQuickInviteLink({ inviteLimit, inviteDuration }, (err, response) => {
                if (err) {
                    log(`${tag} createQuickInviteLink failed: ${err.message || err}`);
                    finish({ ok: false, reason: err.message || String(err), username: account.username });
                    return;
                }
                const t = (response && response.token) || {};
                log(`${tag} invite link: ${t.invite_link}`);
                finish({
                    ok: true,
                    username: account.username,
                    invite_link: t.invite_link || null,
                    invite_limit: t.invite_limit ?? inviteLimit,
                    invite_duration: t.invite_duration ?? inviteDuration,
                    time_created: t.time_created ?? null,
                });
            });
        });

        store.getRefreshToken(account.username).then((cachedToken) => {
            if (cachedToken) {
                log(`${tag} using cached refresh token`);
                client.logOn({ refreshToken: cachedToken });
            } else if (account.password) {
                log(`${tag} no cached token — using password (Steam Guard may prompt)`);
                client.logOn({ accountName: account.username, password: account.password });
            } else {
                finish({ ok: false, reason: 'no token and no password', username: account.username });
            }
        }).catch((e) => finish({ ok: false, reason: e.message, username: account.username }));
    });
}

module.exports = { createInviteLink };
