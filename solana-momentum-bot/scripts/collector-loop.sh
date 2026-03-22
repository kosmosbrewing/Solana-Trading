#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

POOL_FILE="${1:-data/pools-batch-seed-2026-03-22.txt}"
DAYS="${DAYS:-7}"
SLEEP_SEC="${SLEEP_SEC:-3600}"

while true; do
  printf '===== %s =====\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  npx ts-node scripts/auto-backtest.ts --pool-file "$POOL_FILE" --days "$DAYS" --no-notify
  printf 'sleeping %ss\n' "$SLEEP_SEC"
  sleep "$SLEEP_SEC"
done
