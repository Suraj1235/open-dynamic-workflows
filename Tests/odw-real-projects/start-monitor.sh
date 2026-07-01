#!/usr/bin/env bash
# POSIX twin of start-monitor.ps1 — starts the 24h ODW real-project monitor detached.
# Usage: ./start-monitor.sh [provider] [intervalMinutes] [durationHours] [projectsPerCycle]
set -euo pipefail

PROVIDER="${1:-mock}"
INTERVAL_MINUTES="${2:-15}"
DURATION_HOURS="${3:-24}"
PROJECTS_PER_CYCLE="${4:-10}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="$REPO/Tests/results/odw-real-projects"
mkdir -p "$LOG_DIR"

export ODW_PROVIDER_MODE="$PROVIDER"
export ODW_REAL_PROJECT_INTERVAL_MS="$((INTERVAL_MINUTES * 60 * 1000))"
export ODW_REAL_PROJECT_DURATION_MS="$((DURATION_HOURS * 60 * 60 * 1000))"
export ODW_REAL_PROJECTS_PER_CYCLE="$PROJECTS_PER_CYCLE"

cd "$REPO"
nohup node Tests/odw-real-projects/monitor-24h.mjs > "$LOG_DIR/monitor.stdout.log" 2> "$LOG_DIR/monitor.stderr.log" &
MONITOR_PID=$!

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
cat > "$LOG_DIR/monitor-process.json" <<JSON
{
  "pid": $MONITOR_PID,
  "provider": "$PROVIDER",
  "intervalMinutes": $INTERVAL_MINUTES,
  "durationHours": $DURATION_HOURS,
  "projectsPerCycle": $PROJECTS_PER_CYCLE,
  "startedAt": "$STARTED_AT",
  "brief": "Tests/results/odw-real-projects/brief-latest.md",
  "briefHistory": "Tests/results/odw-real-projects/brief-history.md",
  "stopCommand": "kill $MONITOR_PID"
}
JSON

echo "Started ODW real-project monitor pid=$MONITOR_PID"
