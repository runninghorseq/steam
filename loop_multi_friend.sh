#!/usr/bin/env bash
#
# Loop runner for multi_friend.js that avoids hitting Steam's login throttle.
#
# multi_friend.js processes one batch (BATCH_SIZE) of accounts per invocation,
# then exits. This script re-runs it, waiting between runs so we don't burst
# logins from the same IP and trip Steam's RateLimitExceeded error.
#
# Usage:
#   ./loop_multi_friend.sh                 # default delay
#   DELAY=180 ./loop_multi_friend.sh       # wait 600s (10 min) between batches
#   MAX_RUNS=5 ./loop_multi_friend.sh      # stop after 5 batches
#
set -u

cd "$(dirname "$0")"

# Seconds to wait between batches. Steam rate-limits logins per IP, so give it
# a generous gap. 300s (5 min) is a safe default for a 15-account batch.
DELAY="${DELAY:-300}"

# Extra backoff (seconds) applied when a run looks rate-limited.
THROTTLE_BACKOFF="${THROTTLE_BACKOFF:-1800}"

# 0 = run until no accounts remain.
MAX_RUNS="${MAX_RUNS:-0}"

run=0
while true; do
    run=$((run + 1))
    echo "==================================================================="
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting batch #$run"
    echo "==================================================================="

    # Capture output so we can detect "no accounts left" and throttling.
    output="$(node multi_friend.js 2>&1)"
    echo "$output"

    # Stop cleanly when the script reports nothing left to process.
    if echo "$output" | grep -q "No accounts left to process"; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] All accounts processed. Stopping."
        break
    fi

    if [ "$MAX_RUNS" -ne 0 ] && [ "$run" -ge "$MAX_RUNS" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Reached MAX_RUNS=$MAX_RUNS. Stopping."
        break
    fi

    # If Steam rate-limited us this run, back off longer before retrying.
    if echo "$output" | grep -qiE "RateLimit|rate limit|throttl"; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Rate limit detected — backing off ${THROTTLE_BACKOFF}s"
        sleep "$THROTTLE_BACKOFF"
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Batch #$run done — waiting ${DELAY}s before next batch"
        sleep "$DELAY"
    fi
done
