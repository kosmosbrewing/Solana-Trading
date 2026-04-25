#!/usr/bin/env bash
# Why: LANE_20260422 Path B 선행 평가 — cupsey benchmark 3주 전체 JSON 집계.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="results/3week-backtest-2026-04-23/cupsey"
mkdir -p "$OUT_DIR"

SESSIONS_FILE="${1:-/tmp/sessions-live.txt}"
FAIL=0
DONE=0
TOTAL=$(wc -l < "$SESSIONS_FILE" | tr -d ' ')
echo "[cupsey-3w] total sessions: $TOTAL"

while IFS= read -r session; do
  [ -z "$session" ] && continue
  out_file="$OUT_DIR/${session}.json"
  if [ -f "$out_file" ]; then
    DONE=$((DONE+1))
    continue
  fi
  npx ts-node scripts/cupsey-backtest.ts \
    --dataset "data/realtime/sessions/${session}" \
    --gate-vol-accel 1.2 --gate-price-change 0 \
    --gate-buy-ratio 0.50 --gate-trade-count 1.0 \
    --stalk-window 60 --stalk-drop 0.005 --stalk-max-drop 0.015 \
    --probe-window 45 --probe-mfe 0.02 --probe-hard-cut 0.008 \
    --winner-max-hold 720 --winner-trailing 0.04 --winner-breakeven 0.005 \
    --max-concurrent 5 --round-trip-cost 0.0045 \
    --json > "$out_file" 2> "$OUT_DIR/${session}.err"
  rc=$?
  if [ $rc -ne 0 ]; then
    FAIL=$((FAIL+1))
    echo "[cupsey-3w] FAIL $session (rc=$rc)" >&2
  fi
  DONE=$((DONE+1))
  if [ $((DONE % 10)) -eq 0 ]; then
    echo "[cupsey-3w] progress $DONE/$TOTAL (fail=$FAIL)"
  fi
done < "$SESSIONS_FILE"

echo "[cupsey-3w] done. $DONE/$TOTAL (fail=$FAIL)"
