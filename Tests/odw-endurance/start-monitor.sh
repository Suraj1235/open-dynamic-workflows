#!/usr/bin/env bash
# POSIX twin of start-monitor.ps1 — starts the 24h ODW endurance monitor detached.
# Usage: ./start-monitor.sh [target] [provider] [intervalMinutes] [durationHours]
set -euo pipefail

TARGET="${1:-100}"
PROVIDER="${2:-mock}"
INTERVAL_MINUTES="${3:-15}"
DURATION_HOURS="${4:-24}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="$REPO/Tests/results/odw-endurance"
mkdir -p "$LOG_DIR"

export ODW_ENDURANCE_TARGET="$TARGET"
export ODW_PROVIDER_MODE="$PROVIDER"
export ODW_MONITOR_INTERVAL_MS="$((INTERVAL_MINUTES * 60 * 1000))"
export ODW_MONITOR_DURATION_MS="$((DURATION_HOURS * 60 * 60 * 1000))"

cd "$REPO"
nohup node Tests/odw-endurance/monitor-24h.mjs > "$LOG_DIR/monitor.stdout.log" 2> "$LOG_DIR/monitor.stderr.log" &
MONITOR_PID=$!

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
cat > "$LOG_DIR/monitor-process.json" <<JSON
{
  "pid": $MONITOR_PID,
  "target": $TARGET,
  "provider": "$PROVIDER",
  "intervalMinutes": $INTERVAL_MINUTES,
  "durationHours": $DURATION_HOURS,
  "startedAt": "$STARTED_AT",
  "stopCommand": "kill $MONITOR_PID"
}
JSON

echo "Started ODW endurance monitor pid=$MONITOR_PID. Status: Tests/results/odw-endurance/monitor-process.json"
