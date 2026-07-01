#!/usr/bin/env bash
# POSIX status helper — reports the ODW real-project monitor status as JSON.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO"
exec node Tests/odw-real-projects/status.mjs
