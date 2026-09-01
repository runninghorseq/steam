// Parse a Steam gift date string ("Sent to X on 15 Mar") to a unix epoch.
// Steam omits the year, so we assume the current one. Shared by db.js, store.js
// and (as an inline copy) the Worker, so every path stamps sent_at identically.
function parseGiftedAt(sentAt) {
    if (!sentAt) return null;
    const d = new Date(`${sentAt} ${new Date().getFullYear()}`);
    return Number.isFinite(d.getTime()) ? Math.floor(d.getTime() / 1000) : null;
}

module.exports = parseGiftedAt;
