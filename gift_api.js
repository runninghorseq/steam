// Server-side DB logic for the Steam gifting script (steam_profile_login.py).
//
// The Python script used to run all this SQL against steam_accounts.db directly.
// It now POSTs its GAME config + exclude/priority lists to the dashboard API and
// this module runs the queries, so the browser-automation script never opens the
// DB itself. The clause construction and parameter order below mirror the old
// Python functions exactly (get_oldest_friend_names / get_game2_friends /
// record_gift / mark_friend_failed / record_game2_gift / mark_game2_failed) so
// candidate selection and de-dup behaviour are unchanged.

const { db } = require('./db');

const now = () => Math.floor(Date.now() / 1000);

const accountSteamId = db.prepare('SELECT steam_id FROM accounts WHERE account_name = ?');

// Build the "exclude these friend names" clause + its params (lowercased).
// Names are inlined as escaped literals (not bound). Parity with the Worker,
// where D1 caps bound variables at 100 and the exclude list exceeds that.
const sqlLit = (v) => `'${String(v).replace(/'/g, "''")}'`;
function excludeNamesClause(alias, excludeNames) {
    const names = (excludeNames || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
    if (!names.length) return { sql: '', params: [] };
    return { sql: `  AND lower(${alias}.friend_name) NOT IN (${names.map(sqlLit).join(',')}) `, params: [] };
}

// Build the leading ORDER BY term that floats PRIORITY names first (ends with a
// comma so the caller's own ordering column becomes the tie-breaker).
function priorityOrderClause(alias, priorityNames) {
    const names = (priorityNames || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
    if (!names.length) return { sql: '', params: [] };
    const whens = names.map((n, i) => `WHEN ${sqlLit(n)} THEN ${i}`).join(' ');
    return { sql: `CASE lower(${alias}.friend_name) ${whens} ELSE ${names.length} END, `, params: [] };
}

// --- game1 (friends-row tracked): oldest ungifted, non-VN friends -------------
function getOldestFriendNames({ account, limit, gameName, game, excludeNames, priorityNames }) {
    if (!accountSteamId.get(account)) {
        return { candidates: [], reason: `Account '${account}' does not exist` };
    }
    const exN = excludeNamesClause('f', excludeNames);
    const prio = priorityOrderClause('f', priorityNames);
    const params = [account];

    let giftedClause;
    if (game.exclude_if_any_gifted) {
        giftedClause =
            '  AND NOT EXISTS (' +
            '    SELECT 1 FROM friends f2 ' +
            '    WHERE (f2.friend_steam_id = f.friend_steam_id ' +
            '           OR lower(f2.friend_name) = lower(f.friend_name)) ' +
            '      AND f2.gifted_at IS NOT NULL AND f2.gifted_at > 0' +
            '  ) ';
    } else {
        giftedClause =
            '  AND NOT EXISTS (' +
            '    SELECT 1 FROM friends f2 ' +
            '    WHERE lower(f2.friend_name) = lower(f.friend_name) ' +
            '      AND f2.gifted_at IS NOT NULL AND f2.gifted_at > 0 ' +
            '      AND f2.gifted_game = ?' +
            '  ) ';
        params.push(gameName);
    }

    let anySentClause = '';
    if (game.exclude_if_any_sent_gift) {
        anySentClause =
            '  AND NOT EXISTS (' +
            '    SELECT 1 FROM sent_gifts sg ' +
            '    WHERE (sg.recipient_steam_id = f.friend_steam_id ' +
            '           OR lower(sg.recipient_name) = lower(f.friend_name))' +
            '  ) ';
    }

    const excludeSentItems = game.exclude_if_sent_items || [];
    let sentItemsClause = '';
    for (let i = 0; i < excludeSentItems.length; i++) {
        sentItemsClause +=
            '  AND NOT EXISTS (' +
            '    SELECT 1 FROM sent_gifts sgi ' +
            '    WHERE sgi.item_name = ? ' +
            '      AND (sgi.recipient_steam_id = f.friend_steam_id ' +
            '           OR lower(sgi.recipient_name) = lower(f.friend_name))' +
            '  ) ';
    }
    params.push(...excludeSentItems);
    params.push(...exN.params);
    params.push(...prio.params);
    params.push(limit);

    const rows = db.prepare(
        'SELECT f.friend_name ' +
        'FROM accounts a JOIN friends f ON f.account_steam_id = a.steam_id ' +
        'WHERE a.account_name = ? ' +
        '  AND f.added_at IS NOT NULL AND f.added_at > 0 ' +
        '  AND f.gifted_at IS NULL ' +
        "  AND f.country != 'VN' " +
        giftedClause + anySentClause + sentItemsClause + exN.sql +
        'ORDER BY ' + prio.sql + 'f.added_at ASC LIMIT ?'
    ).all(...params);

    return {
        candidates: rows.map((r) => ({ friend_name: r.friend_name, friend_steam_id: null })),
        reason: rows.length ? null : `Account '${account}' has no giftable friends left (ungifted, non-VN)`
    };
}

// --- game2/game3/packs (sent_gifts tracked) -----------------------------------
function getGame2Friends({ account, limit, game, excludeNames, priorityNames }) {
    if (!accountSteamId.get(account)) {
        return { candidates: [], reason: `Account '${account}' does not exist` };
    }
    const priorItem = game.requires_prior_sent_item;
    const itemName = game.item_name;
    const params = [account];

    let priorClause = '';
    if (priorItem) {
        priorClause =
            '  AND EXISTS (' +
            '    SELECT 1 FROM sent_gifts sg1 ' +
            '    WHERE sg1.item_name = ? ' +
            '      AND (sg1.recipient_steam_id = f.friend_steam_id ' +
            '           OR lower(sg1.recipient_name) = lower(f.friend_name))' +
            '  ) ';
        params.push(priorItem);
    }

    let excludeGiftedClause = '';
    if (game.exclude_prior_gifted) {
        excludeGiftedClause =
            '  AND NOT EXISTS (' +
            '    SELECT 1 FROM friends f3 ' +
            '    WHERE f3.gifted_at IS NOT NULL AND f3.gifted_at > 0 ' +
            '      AND (f3.friend_steam_id = f.friend_steam_id ' +
            '           OR lower(f3.friend_name) = lower(f.friend_name))' +
            '  ) ';
    }

    const excludeSentItems = game.exclude_if_sent_items || [];
    let excludeSentClause = '';
    for (let i = 0; i < excludeSentItems.length; i++) {
        excludeSentClause +=
            '  AND NOT EXISTS (' +
            '    SELECT 1 FROM sent_gifts sg3 ' +
            '    WHERE sg3.item_name = ? ' +
            '      AND (sg3.recipient_steam_id = f.friend_steam_id ' +
            '           OR lower(sg3.recipient_name) = lower(f.friend_name))' +
            '  ) ';
    }
    params.push(...excludeSentItems);

    let excludeAnySentClause = '';
    if (game.exclude_if_any_sent_gift) {
        excludeAnySentClause =
            '  AND NOT EXISTS (' +
            '    SELECT 1 FROM sent_gifts sg4 ' +
            '    WHERE (sg4.recipient_steam_id = f.friend_steam_id ' +
            '           OR lower(sg4.recipient_name) = lower(f.friend_name))' +
            '  ) ';
    }

    const excludeFailedClause =
        '  AND NOT EXISTS (' +
        '    SELECT 1 FROM friends ff ' +
        '    WHERE ff.gifted_at = -1 ' +
        '      AND (ff.friend_steam_id = f.friend_steam_id ' +
        '           OR lower(ff.friend_name) = lower(f.friend_name))' +
        '  ) ';

    const exN = excludeNamesClause('f', excludeNames);
    const prio = priorityOrderClause('f', priorityNames);
    params.push(itemName);
    params.push(...exN.params);
    params.push(...prio.params);
    params.push(limit);

    const rows = db.prepare(
        'SELECT f.friend_name, f.friend_steam_id ' +
        'FROM accounts a JOIN friends f ON f.account_steam_id = a.steam_id ' +
        'WHERE a.account_name = ? ' +
        "  AND f.country != 'VN' " +
        "  AND f.friend_steam_id IS NOT NULL AND f.friend_steam_id != '' " +
        priorClause + excludeGiftedClause + excludeSentClause + excludeAnySentClause + excludeFailedClause +
        '  AND NOT EXISTS (' +
        '    SELECT 1 FROM sent_gifts sg2 ' +
        '    WHERE sg2.item_name = ? ' +
        '      AND (sg2.recipient_steam_id = f.friend_steam_id ' +
        '           OR lower(sg2.recipient_name) = lower(f.friend_name))' +
        '  ) ' +
        exN.sql +
        'ORDER BY ' + prio.sql + 'f.gifted_at ASC LIMIT ?'
    ).all(...params);

    return {
        candidates: rows.map((r) => ({ friend_name: r.friend_name, friend_steam_id: r.friend_steam_id })),
        reason: rows.length ? null : `Account '${account}' has no ${itemName}-eligible friends left`
    };
}

function giftCandidates(opts) {
    return opts.usesSentGifts ? getGame2Friends(opts) : getOldestFriendNames(opts);
}

// --- writes: mirror record_gift / mark_friend_failed / record_game2_gift ------
const recordGift = db.transaction((account, friend_name, game_name) => {
    const gifter = accountSteamId.get(account);
    if (!gifter) return 0;
    const gid = gifter.steam_id;
    const row = db.prepare(
        'SELECT friend_steam_id FROM friends WHERE account_steam_id = ? AND friend_name = ?'
    ).get(gid, friend_name);
    const ts = now();
    if (!row || !row.friend_steam_id) {
        return db.prepare(
            'UPDATE friends SET gifted_at = ?, gifted_game = ? WHERE account_steam_id = ? AND friend_name = ?'
        ).run(ts, game_name, gid, friend_name).changes;
    }
    // Propagate to every OTHER account's row for the same friend (still ungifted).
    return db.prepare(
        'UPDATE friends SET gifted_at = ?, gifted_game = ? WHERE friend_steam_id = ? AND gifted_at IS NULL'
    ).run(ts, game_name, row.friend_steam_id).changes;
});

function markFriendFailed(account, friend_name, reason) {
    const label = `FAILED: ${reason}`.slice(0, 200);
    return db.prepare(
        'UPDATE friends SET gifted_at = -1, gifted_game = ? ' +
        'WHERE account_steam_id = (SELECT steam_id FROM accounts WHERE account_name = ?) ' +
        'AND friend_name = ?'
    ).run(label, account, friend_name).changes;
}

function syntheticGiftId(subid, accountSteamID, friendSteamID) {
    return `local-${subid}-${accountSteamID}-${friendSteamID}-${now()}`;
}

const insertSentGiftStub = db.prepare(
    'INSERT OR IGNORE INTO sent_gifts ' +
    '(gift_id, account_steam_id, recipient_steam_id, recipient_name, item_name, detail, sent_at, status, store_url, scanned_at) ' +
    'VALUES (@gift_id, @account_steam_id, @recipient_steam_id, @recipient_name, @item_name, @detail, @sent_at, @status, @store_url, @scanned_at)'
);

function recordGame2Gift(account, friend_name, friend_steam_id, item_name, subid, status) {
    const gifter = accountSteamId.get(account);
    const accId = gifter ? gifter.steam_id : null;
    return insertSentGiftStub.run({
        gift_id: syntheticGiftId(subid, accId, friend_steam_id),
        account_steam_id: accId,
        recipient_steam_id: friend_steam_id,
        recipient_name: friend_name,
        item_name,
        detail: 'Steam Gift',
        sent_at: null,
        status: status || 'pending',
        store_url: null,
        scanned_at: now()
    }).changes;
}

// record_success: sent_gifts games log the send AND mark the friends row; game1
// only marks the friends row.
function recordSuccess({ account, friend_name, friend_steam_id, usesSentGifts, item_name, gifted_game, subid, gameName }) {
    if (usesSentGifts) {
        const sent = recordGame2Gift(account, friend_name, friend_steam_id, item_name, subid, 'pending');
        const gg = gifted_game || item_name || gameName;
        const marked = recordGift(account, friend_name, gg);
        return { ok: true, sent_gifts_rows: sent, friends_rows: marked };
    }
    const marked = recordGift(account, friend_name, gameName);
    return { ok: true, sent_gifts_rows: 0, friends_rows: marked };
}

function recordFailure({ account, friend_name, friend_steam_id, usesSentGifts, item_name, subid, reason }) {
    if (usesSentGifts) {
        const status = `FAILED: ${reason}`.slice(0, 200);
        const rows = recordGame2Gift(account, friend_name, friend_steam_id, item_name, subid, status);
        return { ok: true, rows };
    }
    const rows = markFriendFailed(account, friend_name, reason);
    return { ok: true, rows };
}

module.exports = { giftCandidates, recordSuccess, recordFailure };
