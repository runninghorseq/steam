'use strict';

const state = {
    view: 'accounts',
    q: '',
    filter: '',
    wallet: { currency: '', min: '', max: '' },
    sort: 'account_name',
    dir: 'asc',
    rows: [],
    summary: null
};

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
        ['skip_wallet', s.skip_wallet], ['Friends', s.friends], ['Sent gifts', s.sent_gifts],
        ['Pending gifts', s.pending_gifts], ['Open loans', s.open_loans]
    ].map(([label, value]) => el('div', { className: 'stat' }, el('b', {}, value), el('span', {}, label)));
    if (s.overdue_loans) {
        cards.push(el('div', { className: 'stat alert' }, el('b', {}, s.overdue_loans), el('span', {}, 'Overdue')));
    }
    s.wallets.forEach((w) => cards.push(
        el('div', { className: 'stat' }, el('b', {}, (w.cents / 100).toFixed(2)), el('span', {}, `${w.currency} · ${w.accounts} acc`))
    ));
    return cards;
}

// --- views ------------------------------------------------------------------

function toolbar({ filters = [], placeholder = 'Search…' } = {}) {
    const search = el('input', { type: 'search', placeholder, value: state.q });
    let timer;
    search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value.trim(); load(); }, 220); };
    const bar = el('div', { className: 'toolbar' }, search);
    filters.forEach(([key, label]) => {
        const b = el('button', { className: 'chip' + (state.filter === key ? ' on' : '') }, label);
        b.onclick = () => { state.filter = state.filter === key ? '' : key; load(); };
        bar.append(b);
    });
    bar.append(el('span', { className: 'count' }, `${state.rows.length} row(s)`));
    return bar;
}

function viewAccounts() {
    const cols = [
        { key: 'account_name', label: 'Account' }, { key: 'persona', label: 'Persona' },
        { key: 'country', label: 'CC' }, { key: 'wallet', label: 'Wallet', num: true },
        { key: 'level', label: 'Lvl', num: true }, { key: 'points', label: 'Points', num: true },
        { key: 'friends', label: 'Friends', num: true }, { key: 'sent', label: 'Sent', num: true },
        { key: 'pending', label: 'Pend', num: true }, { key: 'licenses', label: 'Lic', num: true },
        { key: 'scanned', label: 'Scanned' }, { label: 'Source' }, { label: 'Flags' }, { label: 'Actions' }
    ];
    const rows = table(cols, state.rows, (a) => {
        const flags = el('td');
        if (a.skip_wallet) flags.append(el('span', { className: 'tag skip' }, 'skip_wallet'), ' ');
        if (a.loan_id != null) flags.append(el('span', { className: 'tag loan' }, `loan #${a.loan_id}`), ' ');
        if (!a.has_token) flags.append(el('span', { className: 'tag notok' }, 'no token'));

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
            el('td', {}, a.persona || '—'),
            el('td', { className: 'dim' }, a.country || '—'),
            el('td', { className: 'num' }, money(a.wallet_balance_cents, a.wallet_currency)),
            el('td', { className: 'num' }, a.steam_level ?? '—'),
            el('td', { className: 'num' }, a.steam_points ?? '—'),
            el('td', { className: 'num' }, a.friend_count),
            el('td', { className: 'num' }, a.sent_gift_count),
            el('td', { className: 'num' }, a.pending_gift_count),
            el('td', { className: 'num' }, a.license_count),
            el('td', { className: 'dim' }, date(a.scanned_at)),
            el('td', { className: 'dim', title: a.source || '' }, a.source || '—'),
            flags,
            el('td', { style: 'white-space:nowrap' }, toggle, ' ', del)
        );
    }, (a) => openDetail(a.steam_id));

    return [toolbar({
        placeholder: 'Search account, persona, email, steamID…',
        filters: [['funded', 'Funded'], ['skip_wallet', 'skip_wallet'], ['tracked', 'Tracked'], ['loaned', 'Loaned'], ['no_token', 'No token']]
    }), walletFilterBar(), rows];
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
        load();
    };
    const debounced = () => { clearTimeout(timer); timer = setTimeout(apply, 250); };
    cur.onchange = apply;
    min.oninput = debounced;
    max.oninput = debounced;

    const clear = el('button', { className: 'chip' }, 'Clear');
    clear.onclick = () => { state.wallet = { currency: '', min: '', max: '' }; load(); };

    const bar = el('div', { className: 'toolbar' },
        el('span', { className: 'dim', style: 'font-size:12px' }, 'Wallet:'),
        cur, min, el('span', { className: 'dim' }, '–'), max);
    if ((state.wallet.min || state.wallet.max) && !state.wallet.currency) {
        bar.append(el('span', { className: 'dim', style: 'font-size:12px; color:var(--warn)' }, 'range spans mixed currencies — pick one'));
    }
    if (state.wallet.currency || state.wallet.min || state.wallet.max) bar.append(clear);
    return bar;
}

function viewLoans() {
    const nowSec = Math.floor(Date.now() / 1000);
    const form = el('form', { className: 'inline' },
        el('input', { type: 'text', name: 'account_name', placeholder: 'account name', required: true }),
        el('input', { type: 'text', name: 'borrower', placeholder: 'borrower' }),
        el('input', { type: 'number', name: 'days', value: '1', min: '0.1', step: '0.1', style: 'width:76px' }),
        el('input', { type: 'text', name: 'note', placeholder: 'note' }),
        el('button', { className: 'act primary', type: 'submit' }, 'Record loan')
    );
    form.onsubmit = async (ev) => {
        ev.preventDefault();
        const f = Object.fromEntries(new FormData(form));
        try {
            await api('/api/loans', { method: 'POST', body: JSON.stringify(f) });
            toast(`Loan recorded for ${f.account_name} — wallet/level now frozen`);
            form.reset();
            load();
        } catch (err) { toast(err.message, true); }
    };

    const rows = table(
        [{ label: '#' }, { label: 'Account' }, { label: 'Borrower' }, { label: 'Lent' }, { label: 'Due' }, { label: 'State' }, { label: 'Note' }, { label: '' }],
        state.rows,
        (l) => {
            const open = !l.returned_at;
            const overdue = open && l.due_at < nowSec;
            const state_ = open
                ? el('span', { className: 'tag ' + (overdue ? 'over' : 'loan') }, overdue ? `overdue ${ago(l.due_at)}` : `due ${ago(l.due_at)}`)
                : el('span', { className: 'tag done' }, l.password_changed ? 'returned · pw rotated' : 'returned');

            const actions = el('td');
            if (open) {
                const btn = el('button', { className: 'act' }, 'Mark returned');
                btn.onclick = async () => {
                    if (!confirm(`Close loan #${l.id} for ${l.account_name}?\n\nThis only updates the DB. Rotate the password with:\n  node lend_account.js return ${l.account_name}`)) return;
                    try { await api(`/api/loans/${l.id}/return`, { method: 'POST' }); toast(`Loan #${l.id} closed`); load(); }
                    catch (err) { toast(err.message, true); }
                };
                actions.append(btn);
            } else {
                const btn = el('button', { className: 'act' }, 'Unfreeze wallet');
                btn.onclick = async () => {
                    try {
                        await api(`/api/accounts/${l.account_steam_id}/unlink-loan`, { method: 'POST' });
                        toast(`${l.account_name}: loan_id cleared, wallet/level updates resume`);
                        load();
                    } catch (err) { toast(err.message, true); }
                };
                actions.append(btn);
            }

            return el('tr', {},
                el('td', { className: 'dim' }, l.id),
                el('td', { className: 'name' }, l.account_name),
                el('td', {}, l.borrower || '—'),
                el('td', { className: 'dim' }, dateTime(l.lent_at)),
                el('td', { className: 'dim' }, dateTime(l.due_at)),
                el('td', {}, state_),
                el('td', { className: 'dim' }, l.note || '—'),
                actions
            );
        }
    );
    return [el('div', { className: 'toolbar' }, form), rows];
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
    bar.insertBefore(refresh, bar.querySelector('.count'));

    const tbl = table(
        [{ label: 'From' }, { label: 'Recipient' }, { label: 'Item' }, { label: 'Sent' }, { label: 'Status' }, { label: 'Scanned' }],
        state.rows,
        (g) => el('tr', {},
            el('td', { className: 'name' }, g.account_name || g.account_steam_id),
            el('td', {}, g.recipient_name || g.recipient_steam_id || '—'),
            el('td', {}, g.item_name || '—'),
            el('td', { className: 'dim' }, date(g.sent_at)),
            el('td', {}, g.status || '—'),
            el('td', { className: 'dim' }, date(g.scanned_at))
        )
    );
    return [bar, progress, tbl];
}

function viewPending() {
    return [toolbar({ placeholder: 'Filter is client-side below…' }), table(
        [{ label: 'Account' }, { label: 'Sender' }, { label: 'Item' }, { label: 'Sent' }, { label: 'Status' }, { label: 'Scanned' }],
        state.rows,
        (g) => el('tr', {},
            el('td', { className: 'name' }, g.account_name || g.account_steam_id),
            el('td', {}, g.sender_name || g.sender_steam_id || '—'),
            el('td', {}, g.item_name || '—'),
            el('td', { className: 'dim' }, g.sent_at || '—'),
            el('td', {}, g.status || '—'),
            el('td', { className: 'dim' }, date(g.scanned_at))
        )
    )];
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

function viewScan() {
    const wrap = el('div');

    const ta = el('textarea', {
        placeholder: 'Paste account lines, one per line:\n  user----pass----email----steamID\n  user:pass\n  id|email|x|user|pass',
        rows: 8,
        style: 'width:100%; font-family:var(--mono); font-size:13px; padding:10px; background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:8px; resize:vertical;'
    });
    const timeout = el('input', { type: 'number', value: '60', min: '10', step: '5', style: 'width:80px' });
    const rescan = el('input', { type: 'checkbox' });

    // File upload: read the chosen file's text into the box and remember its name
    // as the account source. `source` tracks the current textarea content's origin;
    // typing by hand clears it so we never mislabel pasted lines with a filename.
    let source = null;
    const fileInput = el('input', { type: 'file', accept: '.txt,.csv,text/plain', style: 'display:none' });
    const pickBtn = el('button', { className: 'act', type: 'button' }, 'Choose file…');
    const sourceLabel = el('span', { className: 'dim', style: 'font-size:12px' }, 'no file — source will be blank');
    pickBtn.onclick = () => fileInput.click();
    fileInput.onchange = () => {
        const f = fileInput.files && fileInput.files[0];
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
    const rescanLabel = el('label', { style: 'display:flex; gap:6px; align-items:center; font-size:12px; color:var(--muted); cursor:pointer' }, rescan, 'Rescan accounts already in DB');
    const addOnly = el('input', { type: 'checkbox' });
    const addOnlyLabel = el('label', { style: 'display:flex; gap:6px; align-items:center; font-size:12px; color:var(--muted); cursor:pointer' }, addOnly, 'Just add to DB (don\u2019t scan)');
    const submit = el('button', { className: 'act primary' }, 'Scan accounts');
    const hint = el('span', { className: 'dim', style: 'font-size:12px' }, 'Logs into each account in turn and saves wallet, level, friends, licenses and gifts. Runs one at a time.');
    // Add-only imports the steamID straight from each line — no login.
    addOnly.onchange = () => { submit.textContent = addOnly.checked ? 'Add accounts' : 'Scan accounts'; };

    ta.oninput = () => { if (source) { source = null; sourceLabel.textContent = 'edited by hand — source will be blank'; } };

    submit.onclick = async () => {
        const text = ta.value.trim();
        if (!text) { toast('Paste some account lines first', true); return; }
        const count = text.split('\n').filter((l) => l.trim()).length;
        if (!confirm(`Scan ${count} line(s)?\n\nThis logs into each Steam account and may take ~${Math.ceil(count * (Number(timeout.value) || 60) / 60)} min at worst.`)) return;
        submit.disabled = true;
        try {
            const job = await api('/api/scan', { method: 'POST', body: JSON.stringify({ text, timeout: (Number(timeout.value) || 60) * 1000, rescan: rescan.checked, source, addOnly: addOnly.checked }) });
            if (job.mode === 'add-only') {
                const parts = [`added ${job.added}`];
                if (job.skipped_no_steamid?.length) parts.push(`${job.skipped_no_steamid.length} no steamID`);
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
            el('span', { className: 'dim', style: 'font-size:12px' }, 'Per-account timeout (s):'), timeout, rescanLabel, addOnlyLabel, submit),
        el('div', { style: 'margin-bottom:16px' }, hint)
    );

    const jobPanel = el('div');
    wrap.append(el('div', { style: 'margin:18px 0 8px; font-weight:600' }, 'Scan jobs'), jobPanel);
    renderJobList(jobPanel);
    return [wrap];
}

let jobPoll = null;

async function renderJobList(container) {
    let jobsList;
    try { jobsList = await api('/api/jobs'); }
    catch (err) { container.replaceChildren(el('div', { className: 'empty' }, err.message)); return; }
    if (!jobsList.length) { container.replaceChildren(el('div', { className: 'empty' }, 'No scan jobs yet.')); return; }

    const rows = jobsList.map((j) => {
        const badge = j.status === 'running' ? el('span', { className: 'tag loan' }, 'running')
            : j.status === 'queued' ? el('span', { className: 'tag' }, 'queued')
            : j.status === 'error' ? el('span', { className: 'tag over' }, 'error')
            : el('span', { className: 'tag done' }, 'done');
        const open = el('button', { className: 'act' }, 'View log');
        const panel = el('div');
        open.onclick = () => watchJob(j.id, panel);
        return el('div', { style: 'border:1px solid var(--border); border-radius:8px; padding:10px; margin-bottom:8px; background:var(--panel)' },
            el('div', { style: 'display:flex; gap:12px; align-items:center; flex-wrap:wrap' },
                badge,
                el('b', { style: 'font-family:var(--mono)' }, j.id),
                el('span', { className: 'dim' }, `${j.done}/${j.total} · ${j.ok} ok · ${j.failed} failed${j.guard_skipped ? ` · ${j.guard_skipped} guard-skipped` : ''}`),
                el('span', { className: 'dim', style: 'font-size:12px' }, dateTime(j.created_at)),
                open),
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
        if (job.status === 'done' || job.status === 'error') {
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

async function openDetail(steamID) {
    const dlg = $('#detail');
    const body = $('#detail-body');
    body.replaceChildren(el('div', { className: 'empty' }, 'Loading…'));
    if (!dlg.open) dlg.showModal();
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
         ['Last scan', dateTime(a.scanned_at)], ['Source', a.source], ['Token', a.has_token ? 'cached' : 'none'],
         ['skip_wallet', a.skip_wallet ? 'yes' : 'no'], ['loan_id', a.loan_id ?? '—']
        ].map(([k, v]) => el('div', {}, el('span', {}, k), el('b', {}, v ?? '—')))
    );

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
        [`Sent gifts (${d.sent_gifts.length})`]: () => table(
            [{ label: 'Recipient' }, { label: 'Item' }, { label: 'Sent' }, { label: 'Status' }],
            d.sent_gifts,
            (g) => el('tr', {}, el('td', {}, g.recipient_name || '—'), el('td', {}, g.item_name || '—'),
                el('td', { className: 'dim' }, date(g.sent_at)), el('td', {}, g.status || '—'))
        ),
        [`Pending (${d.pending_gifts.length})`]: () => table(
            [{ label: 'Sender' }, { label: 'Item' }, { label: 'Sent' }, { label: 'Status' }],
            d.pending_gifts,
            (g) => el('tr', {}, el('td', {}, g.sender_name || '—'), el('td', {}, g.item_name || '—'),
                el('td', { className: 'dim' }, g.sent_at || '—'), el('td', {}, g.status || '—'))
        ),
        [`Licenses (${d.licenses.length})`]: () => table(
            [{ label: 'Package' }, { label: 'Name' }, { label: 'Payment' }, { label: 'Bought' }],
            d.licenses,
            (l) => el('tr', {}, el('td', { className: 'dim num' }, l.package_id), el('td', {}, l.package_name || '—'),
                el('td', { className: 'dim' }, l.payment_method || '—'), el('td', { className: 'dim' }, date(l.purchased_at)))
        ),
        [`Loans (${d.loans.length})`]: () => table(
            [{ label: '#' }, { label: 'Borrower' }, { label: 'Lent' }, { label: 'Due' }, { label: 'Returned' }],
            d.loans,
            (l) => el('tr', {}, el('td', { className: 'dim' }, l.id), el('td', {}, l.borrower || '—'),
                el('td', { className: 'dim' }, dateTime(l.lent_at)), el('td', { className: 'dim' }, dateTime(l.due_at)),
                el('td', { className: 'dim' }, l.returned_at ? dateTime(l.returned_at) : 'open'))
        )
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
        mkRun('Sync sent gifts', 'sync'),
        a.has_token ? '' : el('span', { className: 'tag notok' }, 'no token — needs a login')
    );

    body.replaceChildren(runBar, runLog, kv, tabs, pane);
}

// --- loading ----------------------------------------------------------------

const ENDPOINTS = {
    accounts: () => `/api/accounts?q=${encodeURIComponent(state.q)}&filter=${state.filter}&sort=${state.sort}&dir=${state.dir}`
        + `&currency=${encodeURIComponent(state.wallet.currency)}&wallet_min=${encodeURIComponent(state.wallet.min)}&wallet_max=${encodeURIComponent(state.wallet.max)}`,
    loans: () => '/api/loans',
    sent: () => '/api/gifts/sent',
    pending: () => '/api/gifts/pending',
    friends: () => `/api/friends?q=${encodeURIComponent(state.q)}`,
    scan: null
};
const VIEWS = { accounts: viewAccounts, loans: viewLoans, sent: viewSent, pending: viewPending, friends: viewFriends, scan: viewScan };

async function load() {
    try {
        const s = await api('/api/summary');
        state.summary = s;
        $('#stats').replaceChildren(...statCards(s));
        if (!ENDPOINTS[state.view]) { // scan view builds itself, no row list
            $('#view').replaceChildren(...VIEWS[state.view]());
            return;
        }
        const rows = await api(ENDPOINTS[state.view]());
        state.rows = rows;
        // Sent/pending views filter client-side; the server has no search on them.
        if ((state.view === 'sent' || state.view === 'pending') && state.q) {
            const needle = state.q.toLowerCase();
            state.rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(needle));
        }
        $('#view').replaceChildren(...VIEWS[state.view]());
    } catch (err) {
        $('#view').replaceChildren(el('div', { className: 'empty' }, `Failed to load: ${err.message}`));
    }
}

document.querySelectorAll('nav button').forEach((b) => {
    b.onclick = () => {
        document.querySelectorAll('nav button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        if (jobPoll) { clearInterval(jobPoll); jobPoll = null; }
        state.view = b.dataset.view;
        state.q = '';
        state.filter = '';
        state.wallet = { currency: '', min: '', max: '' };
        state.sort = state.view === 'accounts' ? 'account_name' : state.sort;
        load();
    };
});
$('#refresh').onclick = load;
$('#detail-close').onclick = () => $('#detail').close();

load();
