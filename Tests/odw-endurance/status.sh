#!/usr/bin/env bash
# POSIX twin of status.ps1 — reports the ODW endurance monitor status as JSON.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATUS_PATH="$REPO/Tests/results/odw-endurance/monitor-process.json"

if [ ! -f "$STATUS_PATH" ]; then
  echo "No monitor-process.json found. The endurance monitor has not been started from this checkout."
  exit 1
fi

cd "$REPO"
exec node Tests/odw-endurance/status.mjs
