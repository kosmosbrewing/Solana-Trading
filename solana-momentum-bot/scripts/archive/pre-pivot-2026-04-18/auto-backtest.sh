#\!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

ARG1="${1:-}"
ARG2="${2:-}"

if [ -z "$ARG1" ]; then
  exec npx ts-node scripts/auto-backtest.ts
fi

if [ "$ARG1" = "sweep" ]; then
  exec npx ts-node scripts/auto-backtest.ts --sweep
fi

if [ "$ARG1" = "drill" ]; then
  if [ -z "$ARG2" ]; then
    echo "Usage: $0 drill <POOL_ADDRESS>"
    exit 1
  fi
  exec npx ts-node scripts/backtest.ts "$ARG2" \
    --source csv --csv-dir ./data \
    --min-buy-ratio 0 \
    --trades --equity
fi

if [ "$ARG1" = "help" ] || [ "$ARG1" = "--help" ] || [ "$ARG1" = "-h" ]; then
  exec npx ts-node scripts/auto-backtest.ts --help
fi

exec npx ts-node scripts/auto-backtest.ts --pool "$ARG1"
