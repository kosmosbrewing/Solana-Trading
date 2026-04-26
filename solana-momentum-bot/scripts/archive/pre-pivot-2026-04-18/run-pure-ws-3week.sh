#!/usr/bin/env bash
# Why: LANE_20260422 Path B — pure_ws 3주 candle replay. 각 세션 JSON 저장.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="results/3week-backtest-2026-04-23/pure-ws"
mkdir -p "$OUT_DIR"

SESSIONS_FILE="${1:-/tmp/sessions-live.txt}"
FAIL=0
DONE=0
TOTAL=$(wc -l < "$SESSIONS_FILE" | tr -d ' ')
echo "[pure-ws-3w] total sessions: $TOTAL"

while IFS= read -r session; do
  [ -z "$session" ] && continue
  out_file="$OUT_DIR/${session}.json"
  [ -f "$out_file" ] && { DONE=$((DONE+1)); continue; }
  # Runtime defaults: PROBE 30s / hardcut -3% / flat ±10% / T1 +100% / T2 +400% / T3 +900%
  # Gate: pure_ws relaxed (vol_accel 1.0 / buy_ratio 0.45 / trade_count 0.8 / price_change -0.5%)
  npx ts-node scripts/pure-ws-backtest.ts \
    --dataset "data/realtime/sessions/${session}" \
    --include-trades \
    --json > "$out_file" 2> "$OUT_DIR/${session}.err"
  rc=$?
  if [ $rc -ne 0 ]; then
    FAIL=$((FAIL+1))
    echo "[pure-ws-3w] FAIL $session (rc=$rc)" >&2
  fi
  DONE=$((DONE+1))
  if [ $((DONE % 10)) -eq 0 ]; then
    echo "[pure-ws-3w] progress $DONE/$TOTAL (fail=$FAIL)"
  fi
done < "$SESSIONS_FILE"

echo "[pure-ws-3w] done. $DONE/$TOTAL (fail=$FAIL)"
