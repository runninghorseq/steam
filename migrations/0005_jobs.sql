-- Persisted background job runs + their logs, so scan/sync/wallet/playtime jobs
-- survive a restart and the dashboard can read history from the DB. summary is
-- the job's JSON view (counts/timestamps/results, no log); lines is the log.
CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    type        TEXT,
    status      TEXT,
    created_at  INTEGER,
    updated_at  INTEGER,
    summary     TEXT,
    lines       TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (created_at);
