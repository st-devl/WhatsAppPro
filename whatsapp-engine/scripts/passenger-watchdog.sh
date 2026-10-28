#!/usr/bin/env bash
set -euo pipefail

PASSENGER_PATH="${PASSENGER_PATH:-/home/u341720642/domains/yardimet.site/nodejs}"
DATA_PATH="${DATA_PATH:-/home/u341720642/domains/yardimet.site/app-data}"
HEALTH_URL="${HEALTH_URL:-https://yardimet.site/healthz}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-8}"
FAILURE_THRESHOLD="${WATCHDOG_FAILURE_THRESHOLD:-2}"
RUNTIME_DIR="$DATA_PATH/runtime"
LOG_DIR="$DATA_PATH/logs"
STATE_FILE="$RUNTIME_DIR/passenger-watchdog.failures"
LOCK_FILE="$RUNTIME_DIR/app.lock"
LOG_FILE="$LOG_DIR/passenger-watchdog.log"
STOPPED_PIDS=""

mkdir -p "$RUNTIME_DIR" "$LOG_DIR" "$PASSENGER_PATH/tmp"

log() {
    printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_FILE"
}

read_failures() {
    if [ -f "$STATE_FILE" ]; then
        value="$(cat "$STATE_FILE" 2>/dev/null || true)"
        case "$value" in
            ''|*[!0-9]*) printf '0' ;;
            *) printf '%s' "$value" ;;
        esac
        return
    fi
    printf '0'
}

write_failures() {
    printf '%s\n' "$1" > "$STATE_FILE"
}

health_ok() {
    curl -fsS --max-time "$HEALTH_TIMEOUT_SECONDS" "$HEALTH_URL" >/dev/null 2>&1
}

passenger_pids() {
    pgrep -u "$USER" -f "lsnode:${PASSENGER_PATH}/" || true
}

lock_owner_pid() {
    [ -f "$LOCK_FILE" ] || return 0
    node - "$LOCK_FILE" <<'NODE'
const fs = require('fs');
try {
  const lock = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (lock.pid) process.stdout.write(String(lock.pid));
} catch (_) {}
NODE
}

stop_duplicate_passenger_workers() {
    pids="$(passenger_pids)"
    [ -n "$pids" ] || return 0
    lock_pid="$(lock_owner_pid || true)"
    [ -n "$lock_pid" ] || return 0

    duplicates=""
    for pid in $pids; do
        [ "$pid" = "$lock_pid" ] && continue
        duplicates="$duplicates $pid"
    done
    [ -n "$duplicates" ] || return 0

    log "stopping duplicate passenger app pids:$duplicates lock_pid=$lock_pid"
    kill $duplicates >/dev/null 2>&1 || true
}

stop_passenger_app() {
    pids="$(passenger_pids)"
    if [ -z "$pids" ]; then
        log "no passenger app process found"
        return 0
    fi

    STOPPED_PIDS="$pids"
    log "stopping passenger app pids:$pids"
    kill $pids >/dev/null 2>&1 || true

    for _ in $(seq 1 20); do
        alive=""
        for pid in $pids; do
            if kill -0 "$pid" >/dev/null 2>&1; then
                alive="$alive $pid"
            fi
        done
        [ -z "$alive" ] && return 0
        sleep 0.5
    done

    log "force stopping passenger app pids:$alive"
    kill -KILL $alive >/dev/null 2>&1 || true
}

remove_stale_lock() {
    [ -f "$LOCK_FILE" ] || return 0
    lock_pid="$(node - "$LOCK_FILE" <<'NODE'
const fs = require('fs');
try {
  const lock = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (lock.pid) process.stdout.write(String(lock.pid));
} catch (_) {}
NODE
)"
    if [ -n "$lock_pid" ] && printf ' %s ' "$STOPPED_PIDS" | grep -F " $lock_pid " >/dev/null 2>&1; then
        rm -f "$LOCK_FILE"
        log "removed lock owned by stopped pid=$lock_pid"
        return 0
    fi
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" >/dev/null 2>&1; then
        log "lock pid still alive; keeping lock pid=$lock_pid"
        return 0
    fi
    rm -f "$LOCK_FILE"
    log "removed stale lock $LOCK_FILE"
}

if health_ok; then
    stop_duplicate_passenger_workers
    write_failures 0
    exit 0
fi

failures="$(read_failures)"
failures=$((failures + 1))
write_failures "$failures"
log "health check failed failures=$failures threshold=$FAILURE_THRESHOLD url=$HEALTH_URL"

if [ "$failures" -lt "$FAILURE_THRESHOLD" ]; then
    exit 0
fi

# Mark the current generation stale before stopping it. LSNode can create a
# replacement as soon as the old process exits.
touch "$PASSENGER_PATH/tmp/restart.txt"
stop_passenger_app
remove_stale_lock
write_failures 0
log "passenger restart triggered"
