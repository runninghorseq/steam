'use strict';

const state = {
    view: 'accounts',
    q: '',
    filter: '',
    wallet: { currency: 'USD', min: '', max: '' },
    sort: 'wallet',
    dir: 'desc',
    rows: [],
    summary: null,
    page: 1,
    perPage: 50,
    total: 0,
    // Show a record count on each accounts filter chip. Persisted, off by default.
    showCounts: (() => { try { return localStorage.getItem('showCounts') === '1'; } catch { return false; } })(),
    filterCounts: {}
};
const ACCOUNTS_DEFAULT = { sort: 'wallet', dir: 'desc' };
// Business status values (must match the server's STATUSES).
const STATUSES = ['available', 'renting', 'sold', 'reserved', 'disabled'];

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    kids.flat().forEach((k) => n.append(k?.nodeType ? k : document.createTextNode(String(k ?? ''))));
    return n;
};

async function api(path, opts) {
    const res = await fetch(path, {
        ...opts,
        headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

function toast(msg, isErr) {
    const t = el('div', { className: 'toast' + (isErr ? ' err' : '') }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 3200);
}

// A small button that copies `text` to the clipboard (with a graceful fallback
// for non-secure contexts). `label` names the thing in the toast.
function copyBtn(text, label = 'value') {
    const b = el('button', { className: 'act', style: 'padding:0 6px; font-size:12px; line-height:1.6', title: `Copy ${label}` }, '⧉');
    b.onclick = async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        try {
            if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
            else { const ta = el('textarea', { value: text, style: 'position:fixed;opacity:0' }); document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
            toast(`Copied ${label}`);
        } catch { toast('Copy failed', true); }
    };
    return b;
}

// --- formatting -------------------------------------------------------------

const money = (cents, cur) => cents == null ? '—' : `${(cents / 100).toFixed(2)} ${cur || ''}`.trim();
const date = (ts) => ts ? new Date(ts * 1000).toLocaleDateString() : '—';
const dateTime = (ts) => ts ? new Date(ts * 1000).toLocaleString() : '—';

function ago(ts) {
    if (!ts) return '—';
    const s = Math.floor(Date.now() / 1000) - ts;
    const d = Math.floor(Math.abs(s) / 86400);
    const h = Math.floor((Math.abs(s) % 86400) / 3600);
    const text = d ? `${d}d ${h}h` : `${h}h`;
    return s < 0 ? `in ${text}` : `${text} ago`;
}

// --- rendering helpers ------------------------------------------------------

function table(cols, rows, renderRow, onRowClick) {
    if (!rows.length) return el('div', { className: 'empty' }, 'Nothing here.');
    const thead = el('tr');
    cols.forEach((c) => {
        const active = state.sort === c.key;
        const th = el('th', { className: (c.num ? 'num ' : '') + (c.key ? '' : 'no-sort') },
            c.label, active ? el('span', { className: 'arrow' }, state.dir === 'asc' ? ' ▲' : ' ▼') : '');
        if (c.key) th.onclick = () => {
            if (state.sort === c.key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
            else { state.sort = c.key; state.dir = c.num ? 'desc' : 'asc'; }
            state.page = 1;
            load();
        };
        thead.append(th);
    });
    const tbody = el('tbody');
    rows.forEach((r) => {
        const tr = renderRow(r);
        if (onRowClick) {
            tr.className = 'clickable';
            tr.onclick = (ev) => { if (!ev.target.closest('button')) onRowClick(r); };
        }
        tbody.append(tr);
    });
    return el('div', { className: 'table-wrap' }, el('table', {}, el('thead', {}, thead), tbody));
}

function statCards(s) {
    const cards = [
        ['Accounts', s.accounts], ['With token', s.with_token], ['Tracked wallets', s.accounts - s.skip_wallet],
        ['skip_wallet', s.skip_wallet], ['Friends', s.friends], ['Sent gifts', s.sent_gifts]
    ].map(([label, value]) => el('div', { className: 'stat' }, el('b', {}, value), el('span', {}, label)));
    s.wallets.forEach((w) => cards.push(
        el('div', { className: 'stat' }, el('b', {}, (w.cents / 100).toFixed(2)), el('span', {}, `${w.currency} · ${w.accounts} acc`))
    ));
    return cards;
}

// --- views ------------------------------------------------------------------

function toolbar({ filters = [], placeholder = 'Search…', counts = null } = {}) {
    const search = el('input', { type: 'search', placeholder, value: state.q });
    let timer;
    search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value.trim(); state.page = 1; load(); }, 220); };
    const bar = el('div', { className: 'toolbar' }, search);
    filters.forEach(([key, label]) => {
        // When counts is provided, append the matching record count per filter.
        const n = counts ? counts[key] : null;
        const b = el('button', { className: 'chip' + (state.filter === key ? ' on' : '') }, n != null ? `${label} (${n})` : label);
        b.onclick = () => { state.filter = state.filter === key ? '' : key; state.page = 1; load(); };
        bar.append(b);
    });
    bar.append(el('span', { className: 'count' }, `${state.rows.length} row(s)`));
    return bar;
}

function viewAccounts() {
    // Persona and Source are hidden here to keep the row compact — both are shown
    // in the account detail dialog.
    const cols = [
        { key: 'account_name', label: 'Account' },
        { key: 'country', label: 'CC' }, { key: 'wallet', label: 'Wallet', num: true },
        { key: 'level', label: 'Lvl', num: true }, { key: 'points', label: 'Points', num: true },
        { key: 'friends', label: 'Friends', num: true }, { key: 'sent', label: 'Sent', num: true },
        { key: 'pending', label: 'Pend', num: true }, { key: 'licenses', label: 'Lic', num: true },
        { key: 'scanned', label: 'Scanned' }, { label: 'Flags' }, { label: 'Actions' }
    ];
    const rows = table(cols, state.rows, (a) => {
        const flags = el('td');
        if (String(a.steam_id).startsWith('pending:')) flags.append(el('span', { className: 'tag notok', title: 'Added without a SteamID — run a SteamID-only scan to resolve it' }, 'no SteamID'), ' ');
        if (a.skip_wallet) flags.append(el('span', { className: 'tag skip' }, 'skip_wallet'), ' ');
        if (a.loan_id != null) flags.append(el('span', { className: 'tag loan' }, `loan #${a.loan_id}`), ' ');
        if (!a.has_token) flags.append(el('span', { className: 'tag notok' }, 'no token'), ' ');
        if (a.email_token_refreshed_at && (Date.now() / 1000 - a.email_token_refreshed_at) >= MAIL_TOKEN_REFRESH_DAYS * 86400) {
            flags.append(el('span', { className: 'tag notok', title: 'Mailbox OAuth token is older than 2 months — rotate it' }, 'mail due'));
        }
        if (a.status && a.status !== 'available') flags.append(el('span', { className: 'tag loan', title: 'business status' }, a.status), ' ');

        const toggle = el('button', { className: 'act' }, a.skip_wallet ? 'Track wallet' : 'Skip wallet');
        toggle.onclick = async () => {
            toggle.disabled = true;
            try {
                await api(`/api/accounts/${a.steam_id}/skip-wallet`, {
                    method: 'POST', body: JSON.stringify({ value: a.skip_wallet ? 0 : 1 })
                });
                toast(`${a.account_name}: ${a.skip_wallet ? 'wallet tracked again' : 'wallet updates off'}`);
                load();
            } catch (err) { toast(err.message, true); toggle.disabled = false; }
        };

        const del = el('button', { className: 'act danger', title: 'Delete this account and all its data from the DB' }, 'Delete');
        del.onclick = async () => {
            const owned = a.friend_count + a.sent_gift_count + a.pending_gift_count + a.license_count;
            if (!confirm(`Delete "${a.account_name || a.steam_id}" from the DB?\n\n` +
                `Removes the account row, its cached login token, and ${owned} owned row(s) ` +
                `(${a.friend_count} friends, ${a.license_count} licenses, ${a.sent_gift_count} sent + ${a.pending_gift_count} pending gifts).\n\n` +
                `This only edits the local database — it does NOT touch the real Steam account. It cannot be undone (re-scan to restore).`)) return;
            del.disabled = true;
            try {
                const r = await api(`/api/accounts/${a.steam_id}`, { method: 'DELETE' });
                toast(`Deleted ${r.account_name || a.steam_id}`);
                load();
            } catch (err) { toast(err.message, true); del.disabled = false; }
        };

        return el('tr', {},
            el('td', { className: 'name' }, a.account_name || '—'),
            el('td', { className: 'dim' }, a.country || '—'),
            el('td', { className: 'num' }, money(a.wallet_balance_cents, a.wallet_currency)),
            el('td', { className: 'num' }, a.steam_level ?? '—'),
            el('td', { className: 'num' }, a.steam_points ?? '—'),
            el('td', { className: 'num' }, a.friend_count),
            el('td', { className: 'num' }, a.sent_gift_count),
            el('td', { className: 'num' }, a.pending_gift_count),
            el('td', { className: 'num' }, a.license_count),
            el('td', { className: 'dim' }, date(a.scanned_at)),
            flags,
            el('td', { style: 'white-space:nowrap' }, toggle, ' ', del)
        );
    }, (a) => openDetail(a.steam_id));

    const bar = toolbar({
        placeholder: 'Search account, persona, email, steamID…',
        filters: [['funded', 'Funded'], ['skip_wallet', 'skip_wallet'], ['tracked', 'Tracked'], ['loaned', 'Loaned'], ['no_token', 'No token'],
            ['renting', 'Renting'], ['sold', 'Sold'], ['reserved', 'Reserved']],
        counts: state.showCounts ? state.filterCounts : null
    });
    // Toggle the per-filter record counts on the chips (persisted).
    const countsToggle = el('button', { className: 'chip' + (state.showCounts ? ' on' : ''), title: 'Show a record count on each filter' },
        state.showCounts ? `# counts${state.filterCounts.total != null ? ` · ${state.filterCounts.total} total` : ''}` : '# counts off');
    countsToggle.onclick = () => {
        state.showCounts = !state.showCounts;
        try { localStorage.setItem('showCounts', state.showCounts ? '1' : '0'); } catch { /* ignore */ }
        load();
    };
    bar.insertBefore(countsToggle, bar.querySelector('.count'));

    // Bulk refresh wallet+level across all tokened accounts, minus skip_wallet /
    // loaned (mirrors update_wallet_level.js). Progress streams into `progress`.
    const progress = el('div');
    const refreshBtn = el('button', { className: 'act primary' }, 'Refresh wallets/levels');
    refreshBtn.onclick = async () => {
        if (!confirm('Log into every tracked account (except skip_wallet and loaned) and refresh wallet + level?\n\nThis runs a batch of Steam logins and can take a while.')) return;
        refreshBtn.disabled = true;
        try {
            const job = await api('/api/wallets/refresh', { method: 'POST', body: JSON.stringify({ mode: 'all' }) });
            if (!job.id) { toast(job.message || 'Nothing to refresh', true); refreshBtn.disabled = false; return; }
            const note = job.skipped_wallet ? ` (${job.skipped_wallet} skip_wallet excluded)` : '';
            toast(`Refreshing ${job.total} account(s)${note}…`);
            watchJob(job.id, progress, (done) => {
                toast(`Wallet refresh done: ${done.ok}/${done.total} ok, ${done.failed} failed`);
                refreshBtn.disabled = false;
                if (state.view === 'accounts') load(); // reload table with fresh values
            });
        } catch (err) { toast(err.message, true); refreshBtn.disabled = false; }
    };
    bar.insertBefore(refreshBtn, bar.querySelector('.count'));

    return [bar, progress, walletFilterBar(), rows, pager()];
}

// Pagination controls for the accounts list. state.total / state.pages come from
// the paginated /api/accounts response.
function pager() {
    const pages = state.pages || Math.max(1, Math.ceil(state.total / state.perPage));
    const bar = el('div', { className: 'toolbar', style: 'justify-content:flex-end; gap:10px; margin-top:10px' });
    if (state.total > state.perPage) {
        const prev = el('button', { className: 'act', disabled: state.page <= 1 }, '‹ Prev');
        const next = el('button', { className: 'act', disabled: state.page >= pages }, 'Next ›');
        prev.onclick = () => { if (state.page > 1) { state.page--; load(); } };
        next.onclick = () => { if (state.page < pages) { state.page++; load(); } };
        const from = (state.page - 1) * state.perPage + 1;
        const to = Math.min(state.page * state.perPage, state.total);
        bar.append(prev, el('span', { className: 'dim', style: 'font-size:12px' }, `${from}–${to} of ${state.total} · page ${state.page}/${pages}`), next);
    } else {
        bar.append(el('span', { className: 'dim', style: 'font-size:12px' }, `${state.total} account(s)`));
    }
    return bar;
}

// Wallet filter: currency dropdown (from the currencies actually present) + a
// min/max amount range in that currency's units. Amount alone across "any
// currency" mixes currencies, so we warn when a range is set without one.
function walletFilterBar() {
    const currencies = (state.summary?.wallets || []).map((w) => w.currency);
    const cur = el('select', {},
        el('option', { value: '' }, 'Any currency'),
        ...currencies.map((c) => el('option', { value: c, selected: state.wallet.currency === c }, c))
    );
    const min = el('input', { type: 'number', placeholder: 'min', step: '0.01', value: state.wallet.min, style: 'width:90px' });
    const max = el('input', { type: 'number', placeholder: 'max', step: '0.01', value: state.wallet.max, style: 'width:90px' });

    let timer;
    const apply = () => {
        state.wallet = { currency: cur.value, min: min.value.trim(), max: max.value.trim() };
        state.page = 1;
        load();
    };
    const debounced = () => { clearTimeout(timer); timer = setTimeout(apply, 250); };
    cur.onchange = apply;
    min.oninput = debounced;
    max.oninput = debounced;

    const clear = el('button', { className: 'chip' }, 'Clear');
    clear.onclick = () => { state.wallet = { currency: '', min: '', max: '' }; state.page = 1; load(); };

    const bar = el('div', { className: 'toolbar' },
        el('span', { className: 'dim', style: 'font-size:12px' }, 'Wallet:'),
        cur, min, el('span', { className: 'dim' }, '–'), max);
    if ((state.wallet.min || state.wallet.max) && !state.wallet.currency) {
        bar.append(el('span', { className: 'dim', style: 'font-size:12px; color:var(--warn)' }, 'range spans mixed currencies — pick one'));
    }
    if (state.wallet.currency || state.wallet.min || state.wallet.max) bar.append(clear);
    return bar;
}

// Sent-gift recipient cell. If the recipient is one of our own accounts (matched
// by steam_id), clicking opens that account's detail dialog. Otherwise it's an
// external Steam user — link out to their community profile in a new tab.
// The sender account (always one of ours) — click to open its detail dialog.
function sentFromCell(g) {
    const label = g.account_name || g.account_steam_id || '—';
    if (!g.account_steam_id) return el('td', { className: 'name' }, label);
    const link = el('a', { href: '#', style: 'color:var(--accent); cursor:pointer', title: 'Open sender account' }, label);
    link.onclick = (ev) => { ev.preventDefault(); openDetail(g.account_steam_id); };
    return el('td', { className: 'name' }, link);
}

function sentRecipientCell(g) {
    const label = g.recipient_name || g.recipient_steam_id || '—';
    // A copy button for the recipient name (or id) — quick to paste into a list.
    const copy = (g.recipient_name || g.recipient_steam_id)
        ? [' ', copyBtn(g.recipient_name || g.recipient_steam_id, 'recipient')] : [];
    if (g.recipient_account_id) {
        const link = el('a', { href: '#', style: 'color:var(--accent); cursor:pointer', title: 'One of your accounts — view details' }, label);
        link.onclick = (ev) => { ev.preventDefault(); openDetail(g.recipient_account_id); };
        return el('td', {}, link, ' ', el('span', { className: 'tag loan', title: 'Recipient is your account' }, 'account'), ...copy);
    }
    if (g.recipient_steam_id) {
        return el('td', {}, el('a', {
            href: `https://steamcommunity.com/profiles/${g.recipient_steam_id}`,
            target: '_blank', rel: 'noopener noreferrer',
            style: 'color:var(--accent)', title: 'External recipient — open Steam profile',
        }, label), ...copy);
    }
    return el('td', {}, label, ...copy);
}

function viewSent() {
    const bar = toolbar({ placeholder: 'Filter is client-side below…' });
    const progress = el('div');

    // Reuse sync_sent_gifts.js via /api/gifts/sync: re-scrape each account's live
    // "Sent Gifts" list and prune anything the recipient has since accepted.
    const refresh = el('button', { className: 'act primary' }, 'Sync from Steam');
    refresh.onclick = async () => {
        if (!confirm('Log into every account with pending sent gifts and re-check Steam?\n\nGifts the recipient has accepted get pruned. Takes a bit.')) return;
        refresh.disabled = true;
        try {
            const job = await api('/api/gifts/sync', { method: 'POST', body: JSON.stringify({}) });
            if (!job.id) { toast(job.message || 'Nothing to sync', true); refresh.disabled = false; return; }
            toast(`Sync job ${job.id} started (${job.total} account${job.total === 1 ? '' : 's'})`);
            watchJob(job.id, progress, (done) => {
                toast(`Sync done: ${done.ok}/${done.total} ok, ${done.pruned} pruned`);
                if (state.view === 'sent') load(); // reload the table with fresh data
            });
        } catch (err) { toast(err.message, true); refresh.disabled = false; }
    };
    // Multi-select delete. Selection is view-local; it resets after a reload.
    const selected = new Set();
    const rows = state.rows;
    const delBtn = el('button', { className: 'act danger', disabled: true }, 'Delete selected');
    const paintDel = () => { delBtn.disabled = selected.size === 0; delBtn.textContent = selected.size ? `Delete selected (${selected.size})` : 'Delete selected'; };
    delBtn.onclick = async () => {
        if (!selected.size) return;
        if (!confirm(`Delete ${selected.size} sent-gift row(s) from the database?\n\nThis only edits the DB — a gift still pending on Steam reappears on the next sync.`)) return;
        delBtn.disabled = true;
        try {
            const r = await api('/api/gifts/sent/delete', { method: 'POST', body: JSON.stringify({ gift_ids: [...selected] }) });
            toast(`Deleted ${r.deleted} sent gift(s)`);
            load();
        } catch (e) { toast(e.message, true); paintDel(); }
    };
    bar.insertBefore(delBtn, bar.querySelector('.count'));
    bar.insertBefore(refresh, delBtn);

    const selectAll = el('input', { type: 'checkbox', title: 'Select all' });
    const boxes = [];
    const head = el('tr', {}, el('th', { className: 'no-sort' }, selectAll),
        ...['From', 'Recipient', 'Item', 'Sent', 'Status', 'Scanned'].map((l) => el('th', { className: 'no-sort' }, l)));
    const tbody = el('tbody', {}, ...rows.map((g) => {
        const cb = el('input', { type: 'checkbox' });
        cb.onchange = () => {
            cb.checked ? selected.add(g.gift_id) : selected.delete(g.gift_id);
            selectAll.checked = rows.length > 0 && selected.size === rows.length;
            paintDel();
        };
        boxes.push(cb);
        return el('tr', {}, el('td', {}, cb),
            sentFromCell(g),
            sentRecipientCell(g),
            el('td', {}, g.item_name || '—'),
            el('td', { className: 'dim' }, date(g.sent_at)),
            el('td', {}, g.status || '—'),
            el('td', { className: 'dim' }, date(g.scanned_at)));
    }));
    selectAll.onchange = () => {
        selected.clear();
        if (selectAll.checked) rows.forEach((g) => selected.add(g.gift_id));
        boxes.forEach((cb) => { cb.checked = selectAll.checked; });
        paintDel();
    };
    const tbl = rows.length
        ? el('div', { className: 'table-wrap' }, el('table', {}, el('thead', {}, head), tbody))
        : el('div', { className: 'empty' }, 'Nothing here.');
    return [bar, progress, tbl];
}

function viewFriends() {
    return [toolbar({ placeholder: 'Search friend name, steamID, owning account…' }), table(
        [{ label: 'Account' }, { label: 'Friend' }, { label: 'SteamID' }, { label: 'Lvl', num: true }, { label: 'Added' }, { label: 'Gifted' }, { label: 'CC' }],
        state.rows,
        (f) => el('tr', {},
            el('td', { className: 'name' }, f.account_name || f.account_steam_id),
            el('td', {}, f.friend_name || '—'),
            el('td', { className: 'dim name' }, f.friend_steam_id),
            el('td', { className: 'num' }, f.friend_level ?? '—'),
            el('td', { className: 'dim' }, `${date(f.added_at)} (${ago(f.added_at)})`),
            el('td', { className: 'dim' }, f.gifted_game ? `${f.gifted_game} · ${date(f.gifted_at)}` : '—'),
            el('td', { className: 'dim' }, f.country || '—')
        )
    )];
}

// Licenses: one row per package (aggregated across every account), with a count
// of how many accounts own it. Click a row to see exactly which accounts do.
function viewLicenses() {
    const pkgName = (l) => (l.package_name && l.package_name !== '(unknown)')
        ? l.package_name
        : (l.app_names ? l.app_names.split(',')[0] : '(unknown)');
    return [toolbar({ placeholder: 'Search package name, app, package ID…' }), table(
        [{ label: 'Package' }, { label: 'ID' }, { label: 'Apps' }, { label: 'Owners', num: true }],
        state.rows,
        (l) => el('tr', {},
            el('td', { className: 'name' }, pkgName(l)),
            el('td', { className: 'dim num' }, l.package_id),
            el('td', { className: 'dim', title: l.app_names || '' }, l.app_names || '—'),
            el('td', { className: 'num' }, l.account_count)
        ),
        (l) => openLicenseOwners(l)
    )];
}

// Show which accounts own a given package, in the shared detail dialog. Each
// owner row is clickable through to that account's full detail.
async function openLicenseOwners(pkg) {
    const dlg = $('#detail');
    const body = $('#detail-body');
    const name = (pkg.package_name && pkg.package_name !== '(unknown)') ? pkg.package_name : (pkg.app_names || '(unknown)');
    $('#detail-title').textContent = `Package ${pkg.package_id} · ${name}`;
    body.replaceChildren(el('div', { className: 'empty' }, 'Loading…'));
    if (!dlg.open) dlg.showModal();
    let rows;
    try { rows = await api(`/api/licenses/owners?package_id=${encodeURIComponent(pkg.package_id)}`); }
    catch (err) { body.replaceChildren(el('div', { className: 'empty' }, err.message)); return; }

    body.replaceChildren(
        pkg.app_names
            ? el('div', { className: 'kv' }, el('div', {}, el('span', {}, 'Apps'), el('b', {}, pkg.app_names)))
            : el('div'),
        table(
            [{ label: 'Account' }, { label: 'SteamID' }, { label: 'Payment' }, { label: 'Type' }, { label: 'Bought' }],
            rows,
            (r) => el('tr', {},
                el('td', { className: 'name' }, r.account_name || '—'),
                el('td', { className: 'dim name' }, r.account_steam_id),
                el('td', { className: 'dim' }, r.payment_method || '—'),
                el('td', { className: 'dim' }, r.license_type || '—'),
                el('td', { className: 'dim' }, date(r.purchased_at))),
            (r) => openDetail(r.account_steam_id)
        )
    );
}

// Playtime leaderboard: accounts with the most game time. Each row expands to
// its per-game breakdown (lazy-loaded from /api/accounts/:id/playtime).
function viewPlaytime() {
    const hrs = (m) => `${((m || 0) / 60).toFixed(1)} h`;
    const bar = toolbar({ placeholder: 'Search account or game name…' });
    if (!state.rows.length) {
        return [bar, el('div', { className: 'empty' }, 'No playtime data — run a "playtime" scan (per-account Games tab, or Upload/Scan) first.')];
    }
    const head = el('tr', {}, ['Account', 'Games', 'Total', 'Last 2 weeks', ''].map((l, i) =>
        el('th', { className: (i >= 1 && i <= 3 ? 'num ' : '') + 'no-sort' }, l)));
    const tbody = el('tbody');
    state.rows.forEach((a) => {
        const gamesCell = el('td', { colSpan: 5, style: 'padding:0 0 0 24px' });
        const detailRow = el('tr', {}, gamesCell);
        detailRow.style.display = 'none';
        let loaded = false;
        const expandBtn = el('button', { className: 'act' }, 'Games ▸');
        const main = el('tr', { className: 'clickable' },
            el('td', { className: 'name' }, a.account_name || a.steam_id),
            el('td', { className: 'num' }, a.game_count),
            el('td', { className: 'num' }, hrs(a.playtime_minutes)),
            el('td', { className: 'num' }, a.playtime_2weeks_minutes ? hrs(a.playtime_2weeks_minutes) : '—'),
            el('td', {}, expandBtn));
        const toggle = async () => {
            const opening = detailRow.style.display === 'none';
            detailRow.style.display = opening ? '' : 'none';
            expandBtn.textContent = opening ? 'Games ▾' : 'Games ▸';
            if (opening && !loaded) {
                loaded = true;
                gamesCell.replaceChildren(el('div', { className: 'empty' }, 'Loading…'));
                try {
                    const pt = await api(`/api/accounts/${a.steam_id}/playtime`);
                    gamesCell.replaceChildren(table(
                        [{ label: 'Game' }, { label: 'Total', num: true }, { label: 'Last 2 weeks', num: true }, { label: 'Scanned' }],
                        pt.games,
                        (g) => el('tr', {},
                            el('td', {}, g.name || `app ${g.app_id}`),
                            el('td', { className: 'num' }, hrs(g.playtime_forever)),
                            el('td', { className: 'num' }, g.playtime_2weeks ? hrs(g.playtime_2weeks) : '—'),
                            el('td', { className: 'dim' }, date(g.scanned_at)))
                    ));
                } catch (e) { gamesCell.replaceChildren(el('div', { className: 'empty' }, e.message)); loaded = false; }
            }
        };
        main.onclick = (ev) => { if (!ev.target.closest('button') || ev.target === expandBtn) toggle(); };
        tbody.append(main, detailRow);
    });
    return [bar, el('div', { className: 'table-wrap' }, el('table', {}, el('thead', {}, head), tbody))];
}

function viewScan() {
    const wrap = el('div');

    const ta = el('textarea', {
        placeholder: 'Paste account lines, one per line — or drag a .txt/.csv file here:\n  user----pass----email----steamID\n  user:pass\n  id|email|x|user|pass',
        rows: 8,
        style: 'width:100%; font-family:var(--mono); font-size:13px; padding:10px; background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:8px; resize:vertical;'
    });
    const timeout = el('input', { type: 'number', value: '60', min: '10', step: '5', style: 'width:80px' });
    const rescan = el('input', { type: 'checkbox' });

    // File upload: read the chosen/dropped file's text into the box and remember
    // its name as the account source. `source` tracks the current textarea
    // content's origin; typing by hand clears it so we never mislabel pasted lines.
    let source = null;
    const fileInput = el('input', { type: 'file', accept: '.txt,.csv,text/plain', style: 'display:none' });
    const pickBtn = el('button', { className: 'act', type: 'button' }, 'Choose file…');
    const sourceLabel = el('span', { className: 'dim', style: 'font-size:12px' }, 'no file — source will be blank');
    const readFile = (f) => {
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
            ta.value = reader.result;
            source = f.name;
            sourceLabel.textContent = `source: ${f.name}`;
        };
        reader.onerror = () => toast('Could not read that file', true);
        reader.readAsText(f);
    };
    pickBtn.onclick = () => fileInput.click();
    fileInput.onchange = () => readFile(fileInput.files && fileInput.files[0]);

    // Drag-and-drop a file onto the textarea. preventDefault on dragover is what
    // makes it a valid drop target (otherwise the browser just opens the file).
    ta.addEventListener('dragover', (e) => { e.preventDefault(); ta.style.borderColor = 'var(--accent)'; });
    ta.addEventListener('dragleave', () => { ta.style.borderColor = 'var(--border)'; });
    ta.addEventListener('drop', (e) => {
        e.preventDefault();
        ta.style.borderColor = 'var(--border)';
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) readFile(f);
    });
    const rescanLabel = el('label', { style: 'display:flex; gap:6px; align-items:center; font-size:12px; color:var(--muted); cursor:pointer' }, rescan, 'Rescan accounts already in DB');
    // Default mode: log in just far enough to learn each SteamID64 and save it \u2014
    // fast, and works when the uploaded lines have no SteamID (add-only can't).
    const idOnly = el('input', { type: 'checkbox', checked: true });
    const idOnlyLabel = el('label', { style: 'display:flex; gap:6px; align-items:center; font-size:12px; color:var(--muted); cursor:pointer' }, idOnly, 'Log in & save SteamID only (fast)');
    const addOnly = el('input', { type: 'checkbox' });
    const addOnlyLabel = el('label', { style: 'display:flex; gap:6px; align-items:center; font-size:12px; color:var(--muted); cursor:pointer' }, addOnly, 'Just add to DB (don\u2019t log in)');
    const emailTokens = el('input', { type: 'checkbox' });
    const emailTokensLabel = el('label', { style: 'display:flex; gap:6px; align-items:center; font-size:12px; color:var(--muted); cursor:pointer' }, emailTokens, 'Update email tokens (mail|pass|refresh_token|app_id)');
    const submit = el('button', { className: 'act primary' }, 'Get SteamIDs');
    const hint = el('span', { className: 'dim', style: 'font-size:12px' }, 'Default: log in to each account just to save its SteamID (fast). Uncheck "SteamID only" for a full scan (wallet, level, friends, licenses, gifts).');
    // Four mutually-exclusive modes: SteamID-only login (default), full scan,
    // add-only (steamID straight from the line, no login), and email-tokens.
    const modeBoxes = [idOnly, addOnly, emailTokens];
    const updateSubmitText = () => { submit.textContent = emailTokens.checked ? 'Update email tokens' : addOnly.checked ? 'Add accounts' : idOnly.checked ? 'Get SteamIDs' : 'Scan accounts'; };
    const exclusive = (on) => { if (on.checked) modeBoxes.forEach((m) => { if (m !== on) m.checked = false; }); updateSubmitText(); };
    modeBoxes.forEach((m) => { m.onchange = () => exclusive(m); });

    ta.oninput = () => { if (source) { source = null; sourceLabel.textContent = 'edited by hand — source will be blank'; } };

    submit.onclick = async () => {
        const text = ta.value.trim();
        if (!text) { toast('Paste some account lines first', true); return; }
        const count = text.split('\n').filter((l) => l.trim()).length;

        // Email-tokens mode: no Steam login, no job — update existing accounts'
        // mailbox OAuth columns by matching each line's email.
        if (emailTokens.checked) {
            if (!confirm(`Update mailbox tokens for ${count} line(s)?\n\nMatches existing accounts by email and updates only the email password / refresh token / app id.`)) return;
            submit.disabled = true;
            try {
                const r = await api('/api/email-tokens', { method: 'POST', body: JSON.stringify({ text }) });
                const parts = [`updated ${r.updated}`];
                if (r.not_found?.length) parts.push(`${r.not_found.length} email not in DB`);
                if (r.invalid?.length) parts.push(`${r.invalid.length} invalid line`);
                toast(parts.join(', '), r.updated === 0);
                if (r.updated > 0) { ta.value = ''; source = null; sourceLabel.textContent = 'no file — source will be blank'; }
            } catch (err) { toast(err.message, true); }
            submit.disabled = false;
            return;
        }

        const msg = idOnly.checked
            ? `Log into ${count} account(s) to fetch the SteamID only?\n\nQuick login — saves each SteamID (and password); no wallet, friends, licenses or gifts.`
            : `Scan ${count} line(s)?\n\nThis logs into each Steam account and may take ~${Math.ceil(count * (Number(timeout.value) || 60) / 60)} min at worst.`;
        if (!confirm(msg)) return;
        submit.disabled = true;
        try {
            const job = await api('/api/scan', { method: 'POST', body: JSON.stringify({ text, timeout: (Number(timeout.value) || 60) * 1000, rescan: rescan.checked, source, addOnly: addOnly.checked, idOnly: idOnly.checked }) });
            if (job.mode === 'add-only') {
                const parts = [`added ${job.added}`];
                if (job.added_pending?.length) parts.push(`${job.added_pending.length} without SteamID (pending)`);
                if (job.skipped_existing?.length) parts.push(`${job.skipped_existing.length} already in DB`);
                if (job.skipped_failed?.length) parts.push(`${job.skipped_failed.length} failed/invalid`);
                toast(parts.join(', '), job.added === 0);
                if (job.added > 0) { ta.value = ''; source = null; sourceLabel.textContent = 'no file — source will be blank'; }
                api('/api/summary').then((sm) => { state.summary = sm; $('#stats').replaceChildren(...statCards(sm)); }).catch(() => {});
                submit.disabled = false;
                return;
            }
            if (!job.id) { // everything was skipped as already-existing
                toast(job.message || 'Nothing to scan', true);
            } else {
                const notes = [];
                if (job.skipped_failed && job.skipped_failed.length) notes.push(`${job.skipped_failed.length} failed/invalid`);
                if (job.skipped_existing && job.skipped_existing.length) notes.push(`${job.skipped_existing.length} already in DB`);
                const note = notes.length ? ` (skipped ${notes.join(', ')})` : '';
                toast(`Scan job ${job.id} started (${job.total} account${job.total === 1 ? '' : 's'})${note}`);
                ta.value = '';
                renderJobList(document.querySelector('#view') && jobPanel);
                watchJob(job.id, jobPanel);
            }
        } catch (err) { toast(err.message, true); }
        submit.disabled = false;
    };

    wrap.append(
        el('div', { style: 'margin-bottom:8px; font-weight:600' }, 'Upload Steam accounts'),
        el('div', { className: 'toolbar', style: 'margin-bottom:8px' }, pickBtn, sourceLabel, fileInput),
        ta,
        el('div', { className: 'toolbar', style: 'margin-top:10px' },
            el('span', { className: 'dim', style: 'font-size:12px' }, 'Per-account timeout (s):'), timeout, idOnlyLabel, rescanLabel, addOnlyLabel, emailTokensLabel, submit),
        el('div', { style: 'margin-bottom:16px' }, hint)
    );

    const jobPanel = el('div');

    // Rotate stored mailbox OAuth tokens against Microsoft before they expire
    // (~90 days). Runs as a job on the box; progress streams into jobPanel.
    const rotateDue = el('button', { className: 'act primary' }, 'Rotate mailbox tokens (due > 60d)');
    const rotateAll = el('button', { className: 'act' }, 'Rotate ALL now');
    const runRotate = (body, label) => async () => {
        if (!confirm(`${label}?\n\nCalls Microsoft to exchange each stored refresh token for a fresh one and re-stamps the rotation time.`)) return;
        rotateDue.disabled = rotateAll.disabled = true;
        try {
            const job = await api('/api/email-tokens/refresh', { method: 'POST', body: JSON.stringify(body) });
            toast(`Rotation job ${job.id} started`);
            watchJob(job.id, jobPanel, () => { rotateDue.disabled = rotateAll.disabled = false; });
        } catch (e) { toast(e.message, true); rotateDue.disabled = rotateAll.disabled = false; }
    };
    rotateDue.onclick = runRotate({ dueDays: 60 }, 'Rotate mailbox tokens last refreshed over 60 days ago');
    rotateAll.onclick = runRotate({}, 'Rotate every stored mailbox token');
    wrap.append(
        el('div', { style: 'margin:18px 0 8px; font-weight:600' }, 'Mailbox token rotation'),
        el('div', { className: 'toolbar' }, rotateDue, rotateAll,
            el('span', { className: 'dim', style: 'font-size:12px' }, 'Outlook/Hotmail refresh tokens expire ~90d — rotate monthly.')));

    wrap.append(el('div', { style: 'margin:18px 0 8px; font-weight:600' }, 'Scan jobs'), jobPanel);
    renderJobList(jobPanel);
    return [wrap];
}

let jobPoll = null;
let loginPoll = null;
const stopLoginPoll = () => { if (loginPoll) { clearInterval(loginPoll); loginPoll = null; } };

async function renderJobList(container) {
    let jobsList;
    try { jobsList = await api('/api/jobs'); }
    catch (err) { container.replaceChildren(el('div', { className: 'empty' }, err.message)); return; }
    if (!jobsList.length) { container.replaceChildren(el('div', { className: 'empty' }, 'No scan jobs yet.')); return; }

    const rows = jobsList.map((j) => {
        const badge = j.status === 'running' ? el('span', { className: 'tag loan' }, 'running')
            : j.status === 'queued' ? el('span', { className: 'tag' }, 'queued')
            : j.status === 'error' ? el('span', { className: 'tag over' }, 'error')
            : j.status === 'cancelled' ? el('span', { className: 'tag over' }, 'stopped')
            : el('span', { className: 'tag done' }, 'done');
        const open = el('button', { className: 'act' }, 'View log');
        const panel = el('div');
        open.onclick = () => watchJob(j.id, panel);
        const controls = [open];
        // Stop a running job (cooperative) or cancel one still queued.
        if (j.status === 'running' || j.status === 'queued') {
            const queued = j.status === 'queued';
            const stop = el('button', { className: 'act danger' }, queued ? 'Cancel' : 'Stop');
            stop.onclick = async () => {
                if (!confirm(queued ? 'Cancel this queued job?' : 'Stop this job?\n\nIt finishes the account currently in flight, then stops.')) return;
                stop.disabled = true;
                try { await api(`/api/jobs/${j.id}/cancel`, { method: 'POST' }); toast(queued ? 'Cancelled' : 'Stopping…'); renderJobList(container); }
                catch (e) { toast(e.message, true); stop.disabled = false; }
            };
            controls.push(stop);
        }
        return el('div', { style: 'border:1px solid var(--border); border-radius:8px; padding:10px; margin-bottom:8px; background:var(--panel)' },
            el('div', { style: 'display:flex; gap:12px; align-items:center; flex-wrap:wrap' },
                badge,
                el('b', { style: 'font-family:var(--mono)' }, j.id),
                el('span', { className: 'dim' }, `${j.done}/${j.total} · ${j.ok} ok · ${j.failed} failed${j.guard_skipped ? ` · ${j.guard_skipped} guard-skipped` : ''}`),
                el('span', { className: 'dim', style: 'font-size:12px' }, dateTime(j.created_at)),
                ...controls),
            panel);
    });
    container.replaceChildren(...rows);
}

function watchJob(id, panel, onDone) {
    if (jobPoll) { clearInterval(jobPoll); jobPoll = null; }
    const pre = el('pre', {
        style: 'margin-top:10px; max-height:340px; overflow:auto; background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:10px; font-size:12px; line-height:1.45; white-space:pre-wrap'
    }, 'Loading…');
    panel.replaceChildren(pre);

    const tick = async () => {
        let job;
        try { job = await api(`/api/jobs/${id}`); }
        catch (err) { pre.textContent = err.message; clearInterval(jobPoll); return; }
        const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        pre.textContent = (job.lines || []).join('\n');
        if (atBottom) pre.scrollTop = pre.scrollHeight;
        if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
            clearInterval(jobPoll); jobPoll = null;
            // Refresh the header stats only — NOT the whole view, which would
            // rebuild the job list and detach this very log panel.
            api('/api/summary').then((s) => { state.summary = s; $('#stats').replaceChildren(...statCards(s)); }).catch(() => {});
            if (onDone) onDone(job);
        }
    };
    tick();
    jobPoll = setInterval(tick, 1500);
}

// --- detail dialog ----------------------------------------------------------

// Editable credentials for one account (in the detail dialog). Plaintext, behind
// the dashboard token. Only fields the user changes are sent; '' clears a field.
const MAIL_TOKEN_REFRESH_DAYS = 60; // rotate the mailbox OAuth token ~every 2 months
function credentialsSection(a) {
    const inStyle = 'width:100%; font-family:var(--mono); font-size:13px; padding:7px 9px; background:var(--panel-2); color:var(--text); border:1px solid var(--border); border-radius:6px; box-sizing:border-box';
    const input = (val, ro) => el('input', { type: 'text', value: val ?? '', readOnly: !!ro, autocomplete: 'off', spellcheck: 'false', style: inStyle + (ro ? '; opacity:.65' : '') });
    const area = (val) => { const t = el('textarea', { rows: 2, autocomplete: 'off', spellcheck: 'false', style: inStyle + '; resize:vertical; word-break:break-all' }); t.value = val ?? ''; return t; };
    const acctName = input(a.account_name, true);
    const steamPw = input(a.steam_password);
    const email = input(a.email);
    const emailPw = input(a.email_password);
    const emailRt = area(a.email_refresh_token);
    const emailCid = input(a.email_client_id);
    const token = area(a.refresh_token);

    const copyBtn = (node) => {
        const b = el('button', { className: 'act', type: 'button', style: 'font-size:11px; padding:2px 8px' }, 'Copy');
        b.onclick = () => { navigator.clipboard?.writeText(node.value || '').then(() => toast('Copied'), () => toast('Copy failed', true)); };
        return b;
    };
    const row = (label, node, extra) => el('div', { style: 'margin-bottom:10px' },
        el('div', { style: 'font-size:12px; color:var(--muted); margin-bottom:4px; display:flex; align-items:center; gap:8px' }, label, extra || ''),
        node);

    // Mailbox OAuth token rotation status + "mark refreshed".
    const refreshedInfo = el('span', { style: 'font-size:12px' });
    const paintRefreshed = () => {
        const ts = a.email_token_refreshed_at;
        if (!ts) { refreshedInfo.textContent = 'never refreshed'; refreshedInfo.style.color = 'var(--muted)'; return; }
        const days = Math.floor((Date.now() / 1000 - ts) / 86400);
        const due = days >= MAIL_TOKEN_REFRESH_DAYS;
        refreshedInfo.textContent = `refreshed ${days}d ago${due ? ` — DUE (rotate every ${MAIL_TOKEN_REFRESH_DAYS}d)` : ''}`;
        refreshedInfo.style.color = due ? '#e5534b' : 'var(--muted)';
    };
    paintRefreshed();
    const markBtn = el('button', { className: 'act', type: 'button', style: 'font-size:11px; padding:2px 8px' }, 'Mark refreshed');
    markBtn.onclick = async () => {
        markBtn.disabled = true;
        try {
            await api(`/api/accounts/${a.steam_id}/credentials`, { method: 'POST', body: JSON.stringify({ stamp_refreshed: true }) });
            a.email_token_refreshed_at = Math.floor(Date.now() / 1000); paintRefreshed(); toast('Marked refreshed');
        } catch (e) { toast(e.message, true); } finally { markBtn.disabled = false; }
    };

    const status = el('span', { className: 'dim', style: 'font-size:12px; margin-left:10px' });
    const save = el('button', { className: 'act primary' }, 'Save credentials');
    save.onclick = async () => {
        save.disabled = true; status.textContent = 'Saving…';
        const hadNewMailToken = emailRt.value.trim() && emailRt.value.trim() !== (a.email_refresh_token ?? '');
        try {
            await api(`/api/accounts/${a.steam_id}/credentials`, {
                method: 'POST',
                body: JSON.stringify({
                    email: email.value.trim(), email_password: emailPw.value, steam_password: steamPw.value,
                    email_refresh_token: emailRt.value.trim(), email_client_id: emailCid.value.trim(), refresh_token: token.value.trim(),
                })
            });
            // keep the in-memory account object in sync so re-opening the tab is correct
            a.email = email.value.trim(); a.email_password = emailPw.value; a.steam_password = steamPw.value;
            a.email_refresh_token = emailRt.value.trim(); a.email_client_id = emailCid.value.trim(); a.refresh_token = token.value.trim();
            if (hadNewMailToken) { a.email_token_refreshed_at = Math.floor(Date.now() / 1000); paintRefreshed(); }
            status.textContent = 'Saved'; toast('Credentials saved');
        } catch (e) { status.textContent = ''; toast(e.message, true); }
        finally { save.disabled = false; setTimeout(() => { status.textContent = ''; }, 3000); }
    };

    // Quick-copy the account as a credential line, in the formats the upload / list
    // tools consume. Values are read live from the fields above (edited-but-unsaved
    // included). STT is an editable sequence number — two of the formats carry it.
    const stt = el('input', {
        type: 'text', value: '1', title: 'STT (sequence number)',
        style: 'width:54px; font-family:var(--mono); font-size:12px; padding:3px 6px; background:var(--panel-2); color:var(--text); border:1px solid var(--border); border-radius:6px; box-sizing:border-box'
    });
    const S = () => acctName.value.trim();      // steam login name
    const P = () => steamPw.value;              // steam password
    const E = () => email.value.trim();         // email
    const Q = () => emailPw.value;              // email password
    const N = () => stt.value.trim();           // STT
    const copyLine = (text, label) => navigator.clipboard?.writeText(text).then(() => toast(`Copied: ${label}`), () => toast('Copy failed', true));
    const fmtBtn = (label, build) => {
        const b = el('button', { className: 'act', type: 'button', style: 'font-size:11px; padding:3px 9px' }, label);
        b.onclick = () => copyLine(build(), label);
        return b;
    };
    const copyBlock = el('div', { style: 'border-top:1px solid var(--border); margin:14px 0 10px; padding-top:10px' },
        el('div', { style: 'font-size:12px; color:var(--muted); margin-bottom:6px' }, 'Copy as line'),
        el('div', { className: 'toolbar', style: 'gap:6px; flex-wrap:wrap; align-items:center' },
            el('span', { style: 'font-size:11px; color:var(--muted)' }, 'STT'), stt,
            fmtBtn('steam----pass', () => `${S()}----${P()}`),
            fmtBtn('STT|email|pass|steam|pass', () => `${N()}|${E()}|${Q()}|${S()}|${P()}`),
            fmtBtn('STT|email|pass|steam|steam----pass', () => `${N()}|${E()}|${Q()}|${S()}|${S()}----${P()}`))
    );

    return el('div', { style: 'max-width:560px' },
        el('div', { className: 'dim', style: 'font-size:12px; margin-bottom:12px' }, '⚠ Plaintext, stored in the database and visible to anyone with the dashboard token. Never share a screenshot.'),
        row('Steam login name', acctName),
        row('Steam password', steamPw, copyBtn(steamPw)),
        copyBlock,
        el('div', { style: 'border-top:1px solid var(--border); margin:14px 0 10px; padding-top:10px; font-size:12px; color:var(--muted)' }, 'Mailbox (email:pass:refresh_token:client_id)'),
        row('Email', email),
        row('Email password', emailPw, copyBtn(emailPw)),
        row('Email refresh token', emailRt, copyBtn(emailRt)),
        row('Email client ID', emailCid, copyBtn(emailCid)),
        row('Mailbox token', refreshedInfo, markBtn),
        el('div', { style: 'border-top:1px solid var(--border); margin:14px 0 10px; padding-top:10px; font-size:12px; color:var(--muted)' }, 'Steam'),
        row('Steam refresh token (blank to clear)', token, copyBtn(token)),
        el('div', { style: 'margin-top:4px' }, save, status)
    );
}

async function openDetail(steamID) {
    const dlg = $('#detail');
    const body = $('#detail-body');
    body.replaceChildren(el('div', { className: 'empty' }, 'Loading…'));
    if (!dlg.open) dlg.showModal();
    stopLoginPoll();
    let d;
    try { d = await api(`/api/accounts/${steamID}`); }
    catch (err) { body.replaceChildren(el('div', { className: 'empty' }, err.message)); return; }

    const a = d.account;
    $('#detail-title').textContent = `${a.account_name || '—'} · ${a.steam_id}`;

    const kv = el('div', { className: 'kv' },
        [['Persona', a.persona], ['Email', a.email], ['Country', a.country],
         ['Wallet', money(a.wallet_balance_cents, a.wallet_currency)], ['Level', a.steam_level],
         ['Points', a.steam_points], ['Friends', a.friend_count], ['Licenses', a.license_count],
         ['Sent gifts', a.sent_gift_count], ['Pending gifts', a.pending_gift_count],
         ['Playtime', a.playtime_minutes ? `${(a.playtime_minutes / 60).toFixed(1)} h (${a.game_count} games)` : '—'],
         ['Last scan', dateTime(a.scanned_at)], ['Source', a.source], ['Token', a.has_token ? 'cached' : 'none'],
         ['skip_wallet', a.skip_wallet ? 'yes' : 'no'], ['loan_id', a.loan_id ?? '—']
        ].map(([k, v]) => el('div', {}, el('span', {}, k), el('b', {}, v ?? '—')))
    );

    // Pending stub (added without a SteamID): the per-account actions key on a real
    // SteamID64, so first resolve it with an interactive login by name — enter the
    // password (and a Steam Guard code if prompted). On success the server saves the
    // real SteamID + token and drops the placeholder, and we reopen on the real id.
    if (String(a.steam_id).startsWith('pending:')) {
        const banner = el('div', { className: 'empty', style: 'border:1px dashed var(--border); border-radius:8px; padding:12px; margin-bottom:14px; text-align:left' },
            el('b', {}, 'No SteamID yet. '),
            `Added without one. Log in below to resolve and store its SteamID — enter the password, and a Steam Guard code if prompted. (Or run a "SteamID only" scan on the Upload / Scan tab.)`);

        if (!a.account_name) { body.replaceChildren(banner, kv); return; }

        const pw = el('input', { type: 'password', placeholder: 'account password', autocomplete: 'new-password', style: 'min-width:190px' });
        const goBtn = el('button', { className: 'act primary' }, 'Log in & resolve SteamID');
        const guardInput = el('input', { type: 'text', placeholder: 'Steam Guard code', autocomplete: 'off', style: 'width:150px; display:none' });
        const guardBtn = el('button', { className: 'act', style: 'display:none' }, 'Submit code');
        const st = el('span', { className: 'dim', style: 'font-size:12px' }, '');
        let sid = null;
        const showGuard = (on) => { guardInput.style.display = on ? '' : 'none'; guardBtn.style.display = on ? '' : 'none'; };
        const poll = async (s) => {
            let r;
            try { r = await api(`/api/accounts/login/${s}`); }
            catch (e) { stopLoginPoll(); st.textContent = e.message; goBtn.disabled = false; return; }
            if (r.status === 'need_guard') { st.textContent = `Steam Guard required (${r.guard_type}) — enter the code`; showGuard(true); guardInput.focus(); }
            else if (r.status === 'done') { stopLoginPoll(); showGuard(false); st.textContent = 'resolved ✓'; toast(`${a.account_name}: SteamID resolved`); if (state.view === 'accounts') load(); openDetail(r.resolved_steam_id || a.steam_id); }
            else if (r.status === 'error') { stopLoginPoll(); showGuard(false); st.textContent = `failed: ${r.reason || 'unknown'}`; goBtn.disabled = false; }
            else st.textContent = r.status === 'logging_in' ? 'logging in…' : 'starting…';
        };
        goBtn.onclick = async () => {
            if (!pw.value) { toast('Enter the password first', true); return; }
            goBtn.disabled = true; showGuard(false); st.textContent = 'starting…';
            try {
                const r = await api('/api/accounts/login/start', { method: 'POST', body: JSON.stringify({ account_name: a.account_name, password: pw.value }) });
                pw.value = ''; sid = r.session_id; stopLoginPoll();
                loginPoll = setInterval(() => poll(sid), 1500); poll(sid);
            } catch (e) { st.textContent = ''; toast(e.message, true); goBtn.disabled = false; }
        };
        guardBtn.onclick = async () => {
            if (!guardInput.value || !sid) return;
            guardBtn.disabled = true;
            try { await api(`/api/accounts/login/${sid}/guard`, { method: 'POST', body: JSON.stringify({ code: guardInput.value }) }); guardInput.value = ''; showGuard(false); st.textContent = 'submitting code…'; }
            catch (e) { toast(e.message, true); }
            guardBtn.disabled = false;
        };
        const loginBar = el('div', { className: 'toolbar', style: 'margin-bottom:14px; flex-wrap:wrap' },
            el('span', { className: 'dim', style: 'font-size:12px' }, `Resolve (${a.account_name}):`), pw, goBtn, guardInput, guardBtn, st);
        body.replaceChildren(banner, loginBar, kv);
        return;
    }

    const tabs = el('div', { className: 'sub-tabs' });
    const pane = el('div');
    const sections = {
        [`Friends (${d.friends.length})`]: () => table(
            [{ label: 'Name' }, { label: 'SteamID' }, { label: 'Lvl', num: true }, { label: 'Added' }, { label: 'Gifted' }],
            d.friends,
            (f) => el('tr', {},
                el('td', {}, f.friend_name || '—'),
                el('td', { className: 'dim name' }, f.friend_steam_id),
                el('td', { className: 'num' }, f.friend_level ?? '—'),
                el('td', { className: 'dim' }, `${date(f.added_at)} (${ago(f.added_at)})`),
                el('td', { className: 'dim' }, f.gifted_game ? `${f.gifted_game} · ${date(f.gifted_at)}` : '—'))
        ),
        ['Credentials']: () => credentialsSection(a),
        [`Sent gifts (${d.sent_gifts.length})`]: () => table(
            [{ label: 'Recipient' }, { label: 'Item' }, { label: 'Sent' }, { label: 'Status' }],
            d.sent_gifts,
            (g) => el('tr', {}, el('td', {}, g.recipient_name || '—'), el('td', {}, g.item_name || '—'),
                el('td', { className: 'dim' }, date(g.sent_at)), el('td', {}, g.status || '—'))
        ),
        [`Licenses (${d.licenses.length})`]: () => table(
            [{ label: 'Package' }, { label: 'Name' }, { label: 'Payment' }, { label: 'Bought' }],
            d.licenses,
            (l) => el('tr', {}, el('td', { className: 'dim num' }, l.package_id), el('td', {}, l.app_names || (l.package_name && l.package_name !== '(unknown)' ? l.package_name : '') || '—'),
                el('td', { className: 'dim' }, l.payment_method || '—'), el('td', { className: 'dim' }, date(l.purchased_at)))
        ),
        [`Games`]: () => {
            const box = el('div');
            const list = el('div', { className: 'empty' }, 'Loading playtime…');
            const logPanel = el('div');
            const refreshBtn = el('button', { className: 'act' }, 'Refresh playtime');
            const hrs = (m) => (m / 60).toFixed(1);
            const loadGames = () => api(`/api/accounts/${a.steam_id}/playtime`).then((pt) => {
                if (!pt.games || !pt.games.length) { list.replaceChildren(el('div', { className: 'empty' }, 'No playtime yet — click Refresh to log in and fetch it.')); return; }
                const hdr = el('div', { className: 'dim', style: 'margin-bottom:8px' }, `${pt.count} games · ${pt.played} played · ${hrs(pt.total_minutes)} h total`);
                const tbl = table(
                    [{ label: 'Game' }, { label: 'Hours', num: true }, { label: 'Last 2wk', num: true }],
                    pt.games,
                    (g) => el('tr', {},
                        el('td', {}, g.name || `app ${g.app_id}`),
                        el('td', { className: 'num' }, hrs(g.playtime_forever)),
                        el('td', { className: 'num dim' }, g.playtime_2weeks ? hrs(g.playtime_2weeks) : '—'))
                );
                list.replaceChildren(hdr, tbl);
            }).catch((e) => list.replaceChildren(el('div', { className: 'empty' }, e.message)));
            refreshBtn.onclick = async () => {
                refreshBtn.disabled = true;
                try {
                    const job = await api(`/api/accounts/${a.steam_id}/run`, { method: 'POST', body: JSON.stringify({ action: 'playtime' }) });
                    toast('Refreshing playtime — logging in…');
                    watchJob(job.id, logPanel, (done) => {
                        refreshBtn.disabled = false;
                        if (done.ok) { toast('Playtime refreshed'); loadGames(); }
                        else toast('Playtime refresh failed — see log', true);
                    });
                } catch (err) { toast(err.message, true); refreshBtn.disabled = false; }
            };
            box.replaceChildren(
                el('div', { className: 'toolbar', style: 'margin-bottom:10px' }, refreshBtn, el('span', { className: 'dim', style: 'font-size:12px' }, 'logs into the account and re-reads its games')),
                logPanel, list);
            loadGames();
            return box;
        }
    };
    Object.keys(sections).forEach((name, i) => {
        const b = el('button', { className: 'chip' + (i === 0 ? ' on' : '') }, name);
        b.onclick = () => {
            tabs.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
            b.classList.add('on');
            pane.replaceChildren(sections[name]());
        };
        tabs.append(b);
    });
    pane.replaceChildren(Object.values(sections)[0]());
    // Per-account actions — each reuses the same worker as its CLI script and runs
    // through the shared one-at-a-time Steam job queue.
    const runLog = el('div');
    const mkRun = (label, action) => {
        const btn = el('button', { className: 'act' }, label);
        btn.onclick = async () => {
            btn.disabled = true;
            try {
                const job = await api(`/api/accounts/${a.steam_id}/run`, { method: 'POST', body: JSON.stringify({ action }) });
                toast(`${label}: job ${job.id} started`);
                watchJob(job.id, runLog, (done) => {
                    api('/api/summary').then((sm) => { state.summary = sm; $('#stats').replaceChildren(...statCards(sm)); }).catch(() => {});
                    if (state.view === 'accounts') load(); // refresh the table underneath
                    if (done.ok) { toast(`${label}: done`); openDetail(a.steam_id); } // reopen with fresh data
                    else if (done.guard_skipped) toast(`${label}: skipped (Steam Guard)`, true);
                    else toast(`${label}: failed — see log`, true);
                });
            } catch (err) { toast(err.message, true); }
            btn.disabled = false;
        };
        return btn;
    };
    const runBar = el('div', { className: 'toolbar', style: 'margin-bottom:14px' },
        el('span', { className: 'dim', style: 'font-size:12px' }, 'Run on this account:'),
        mkRun('Scan', 'scan'),
        mkRun('Wallet + Level', 'wallet'),
        mkRun('Sync friends', 'friends'),
        mkRun('Playtime', 'playtime'),
        mkRun('Sync sent gifts', 'sync'),
        a.has_token ? '' : el('span', { className: 'tag notok' }, 'no token — needs a login')
    );

    // Remove friends — by name/steamID list or by friend_since date range.
    // Dry-run is the DEFAULT (it deletes real Steam friends); a real removal asks
    // to confirm. Runs on the box (proxied) and streams into the same runLog.
    const rfMode = el('select', {}, el('option', { value: 'name' }, 'by name / steamID'), el('option', { value: 'date' }, 'by date added'));
    const rfNames = el('textarea', { placeholder: 'names or 17-digit steamIDs, one per line', rows: 2, style: 'min-width:240px; font-family:var(--mono); font-size:12px; padding:6px; background:var(--panel-2); color:var(--text); border:1px solid var(--border); border-radius:6px' });
    const rfFrom = el('input', { type: 'date' });
    const rfTo = el('input', { type: 'date' });
    const rfDates = el('span', { style: 'display:none; align-items:center; gap:6px', className: 'dim' }, 'from ', rfFrom, ' to ', rfTo);
    const rfDry = el('input', { type: 'checkbox', checked: true });
    const rfBtn = el('button', { className: 'act' }, 'Preview');
    rfMode.onchange = () => { const d = rfMode.value === 'date'; rfNames.style.display = d ? 'none' : ''; rfDates.style.display = d ? 'inline-flex' : 'none'; };
    rfDry.onchange = () => { rfBtn.textContent = rfDry.checked ? 'Preview' : 'Remove'; rfBtn.classList.toggle('primary', !rfDry.checked); };
    rfBtn.onclick = async () => {
        const mode = rfMode.value;
        const payload = { mode, dryRun: rfDry.checked };
        if (mode === 'name') {
            payload.names = rfNames.value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
            if (!payload.names.length) { toast('Enter at least one name/steamID', true); return; }
        } else {
            const f = Date.parse(rfFrom.value), t = Date.parse(rfTo.value + 'T23:59:59');
            if (!f || !t) { toast('Pick both dates', true); return; }
            payload.dateFrom = Math.floor(f / 1000); payload.dateTo = Math.floor(t / 1000);
        }
        if (!rfDry.checked && !confirm(`Really remove matching friends from ${a.account_name}? This cannot be undone.`)) return;
        rfBtn.disabled = true;
        try {
            const job = await api(`/api/accounts/${a.steam_id}/remove-friends`, { method: 'POST', body: JSON.stringify(payload) });
            toast(`Remove-friends job ${job.id} started`);
            watchJob(job.id, runLog, (done) => {
                const r = (done.results || [])[0] || {};
                toast(r.dryRun ? `Dry-run: ${r.matched} matched` : `Removed ${(r.removed || []).length}`);
                if (!rfDry.checked && state.view === 'accounts') load();
            });
        } catch (err) { toast(err.message, true); }
        rfBtn.disabled = false;
    };
    const rfBar = el('div', { className: 'toolbar', style: 'margin-bottom:14px; flex-wrap:wrap' },
        el('span', { className: 'dim', style: 'font-size:12px' }, 'Remove friends:'),
        rfMode, rfNames, rfDates,
        el('label', { style: 'display:flex; gap:5px; align-items:center; font-size:12px; color:var(--muted)' }, rfDry, 'dry-run'),
        rfBtn);

    // Fetch/re-fetch a refresh token by logging in with the account password.
    // Handles a Steam Guard prompt inline. The password is sent once and cleared.
    const pw = el('input', { type: 'password', placeholder: 'account password', autocomplete: 'new-password', style: 'min-width:190px' });
    const fetchBtn = el('button', { className: 'act' }, a.has_token ? 'Re-fetch token' : 'Fetch token');
    const tokenStatus = el('span', { className: 'dim', style: 'font-size:12px' }, '');
    const guardInput = el('input', { type: 'text', placeholder: 'Steam Guard code', autocomplete: 'off', style: 'width:150px; display:none' });
    const guardBtn = el('button', { className: 'act', style: 'display:none' }, 'Submit code');
    let currentSid = null;

    const showGuard = (on) => { guardInput.style.display = on ? '' : 'none'; guardBtn.style.display = on ? '' : 'none'; };

    const pollLogin = async (sid) => {
        let st;
        try { st = await api(`/api/accounts/login/${sid}`); }
        catch (err) { stopLoginPoll(); tokenStatus.textContent = err.message; fetchBtn.disabled = false; return; }
        if (st.status === 'need_guard') {
            tokenStatus.textContent = `Steam Guard required (${st.guard_type}) — enter the code`;
            showGuard(true); guardInput.focus();
        } else if (st.status === 'done') {
            stopLoginPoll(); showGuard(false);
            tokenStatus.textContent = 'token cached \u2713';
            toast(`${a.account_name}: token cached`);
            openDetail(a.steam_id); // reopen — the "no token" tag is gone now
        } else if (st.status === 'error') {
            stopLoginPoll(); showGuard(false);
            tokenStatus.textContent = `failed: ${st.reason || 'unknown'}`;
            fetchBtn.disabled = false;
        } else {
            tokenStatus.textContent = st.status === 'logging_in' ? 'logging in\u2026' : 'starting\u2026';
        }
    };

    fetchBtn.onclick = async () => {
        if (!pw.value) { toast('Enter the password first', true); return; }
        fetchBtn.disabled = true; showGuard(false); tokenStatus.textContent = 'starting\u2026';
        try {
            const r = await api(`/api/accounts/${a.steam_id}/login`, { method: 'POST', body: JSON.stringify({ password: pw.value }) });
            pw.value = ''; // don't keep the password in the DOM
            currentSid = r.session_id;
            stopLoginPoll();
            loginPoll = setInterval(() => pollLogin(currentSid), 1500);
            pollLogin(currentSid);
        } catch (err) { tokenStatus.textContent = ''; toast(err.message, true); fetchBtn.disabled = false; }
    };
    guardBtn.onclick = async () => {
        if (!guardInput.value || !currentSid) return;
        guardBtn.disabled = true;
        try {
            await api(`/api/accounts/login/${currentSid}/guard`, { method: 'POST', body: JSON.stringify({ code: guardInput.value }) });
            guardInput.value = ''; showGuard(false); tokenStatus.textContent = 'submitting code\u2026';
        } catch (err) { toast(err.message, true); }
        guardBtn.disabled = false;
    };

    const tokenBar = el('div', { className: 'toolbar', style: 'margin-bottom:14px; flex-wrap:wrap' },
        el('span', { className: 'dim', style: 'font-size:12px' }, 'Token:'),
        pw, fetchBtn, guardInput, guardBtn, tokenStatus);

    // Business status — set it and (if a webhook is configured) publish to the
    // other repo. Saved immediately on change.
    const statusSel = el('select', { style: 'padding:4px 8px; background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:6px' },
        ...STATUSES.map((s) => el('option', { value: s, selected: (a.status || 'available') === s }, s)));
    statusSel.onchange = async () => {
        const prev = a.status || 'available';
        statusSel.disabled = true;
        try {
            const r = await api(`/api/accounts/${a.steam_id}/status`, { method: 'POST', body: JSON.stringify({ status: statusSel.value }) });
            a.status = statusSel.value;
            toast(`Status: ${statusSel.value}${r.pushed ? ' · pushed' : ''}`);
        } catch (e) { toast(e.message, true); statusSel.value = prev; }
        statusSel.disabled = false;
    };
    const statusBar = el('div', { className: 'toolbar', style: 'margin-bottom:14px' },
        el('span', { className: 'dim', style: 'font-size:12px' }, 'Status:'), statusSel);

    body.replaceChildren(runBar, rfBar, tokenBar, statusBar, runLog, kv, tabs, pane);
}

// --- loading ----------------------------------------------------------------

const ENDPOINTS = {
    accounts: () => `/api/accounts?q=${encodeURIComponent(state.q)}&filter=${state.filter}&sort=${state.sort}&dir=${state.dir}`
        + `&currency=${encodeURIComponent(state.wallet.currency)}&wallet_min=${encodeURIComponent(state.wallet.min)}&wallet_max=${encodeURIComponent(state.wallet.max)}`
        + `&page=${state.page}&per=${state.perPage}`,
    sent: () => '/api/gifts/sent',
    friends: () => `/api/friends?q=${encodeURIComponent(state.q)}`,
    licenses: () => `/api/licenses?q=${encodeURIComponent(state.q)}`,
    playtime: () => `/api/playtime?q=${encodeURIComponent(state.q)}`,
    scan: null
};
const VIEWS = { accounts: viewAccounts, sent: viewSent, friends: viewFriends, licenses: viewLicenses, playtime: viewPlaytime, scan: viewScan };

async function load() {
    try {
        const s = await api('/api/summary');
        state.summary = s;
        $('#stats').replaceChildren(...statCards(s));
        if (!ENDPOINTS[state.view]) { // scan view builds itself, no row list
            $('#view').replaceChildren(...VIEWS[state.view]());
            return;
        }
        const data = await api(ENDPOINTS[state.view]());
        // Accounts is paginated → { rows, total, page, pages }; other views are arrays.
        const rows = Array.isArray(data) ? data : data.rows;
        state.total = Array.isArray(data) ? rows.length : data.total;
        if (!Array.isArray(data)) { state.page = data.page; state.pages = data.pages; }
        state.rows = rows;
        // The sent-gifts view filters client-side; the server has no search on it.
        if (state.view === 'sent' && state.q) {
            const needle = state.q.toLowerCase();
            state.rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(needle));
        }
        // Per-filter counts for the accounts chips, only when the toggle is on.
        if (state.view === 'accounts' && state.showCounts) {
            state.filterCounts = await api('/api/accounts/filter-counts').catch(() => ({}));
        }
        $('#view').replaceChildren(...VIEWS[state.view]());
    } catch (err) {
        $('#view').replaceChildren(el('div', { className: 'empty' }, `Failed to load: ${err.message}`));
    }
}

// Switch to a tab and (re)load it. Resets the per-view search/filter/page state.
function selectView(view) {
    if (!VIEWS[view]) view = 'accounts';
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x.dataset.view === view));
    if (jobPoll) { clearInterval(jobPoll); jobPoll = null; }
    state.view = view;
    state.q = '';
    state.filter = '';
    state.wallet = { currency: '', min: '', max: '' };
    state.page = 1;
    if (view === 'accounts') { state.sort = ACCOUNTS_DEFAULT.sort; state.dir = ACCOUNTS_DEFAULT.dir; }
    load();
}

// The current tab lives in the URL hash (#friends), so an F5 stays on it and
// back/forward navigate between tabs. Nav clicks just set the hash.
const viewFromHash = () => (location.hash || '').replace(/^#/, '');
document.querySelectorAll('nav button').forEach((b) => {
    b.onclick = () => {
        const v = b.dataset.view;
        if (viewFromHash() === v) selectView(v); // re-click active tab: reload it
        else location.hash = v;                  // else the hashchange handler loads it
    };
});
window.addEventListener('hashchange', () => selectView(viewFromHash()));
$('#refresh').onclick = load;
// Close the detail dialog via the button, Escape, or a click on the backdrop
// (a click whose target is the <dialog> itself, i.e. outside the content box).
// The 'close' event centralizes cleanup so every path stops the login poll.
const detailDlg = $('#detail');
detailDlg.addEventListener('close', () => stopLoginPoll());
detailDlg.addEventListener('click', (e) => { if (e.target === detailDlg) detailDlg.close(); });
$('#detail-close').onclick = () => detailDlg.close();

// Honor the hash on first load so a refresh (F5) restores the tab you were on.
selectView(viewFromHash() || 'accounts');
