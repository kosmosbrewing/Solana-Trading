#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

mkdir -p logs data/realtime-sessions

RUN_MINUTES="${SHADOW_RUN_MINUTES:-1440}"
SIGNAL_TARGET="${SHADOW_SIGNAL_TARGET:-100}"
HORIZON="${SHADOW_HORIZON_SEC:-30}"
POLL_SEC="${SHADOW_POLL_SEC:-5}"

ARGS=(
  "--run-minutes" "$RUN_MINUTES"
  "--signal-target" "$SIGNAL_TARGET"
  "--horizon" "$HORIZON"
  "--poll-sec" "$POLL_SEC"
)

if [ "${SHADOW_TELEGRAM:-true}" = "true" ]; then
  ARGS+=("--telegram")
fi

exec ./node_modules/.bin/ts-node scripts/realtime-shadow-runner.ts "${ARGS[@]}" "$@"
