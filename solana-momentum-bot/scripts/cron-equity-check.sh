#!/usr/bin/env bash
# cron-equity-check.sh — Phase 1 P0-5 (2026-04-25)
#
# Why: MISSION_CONTROL §Control 1 — wallet truth ground truth 자동 모니터링.
# `equity-decomposition --rpc-check` 매시간 실행하여 ledger ↔ RPC drift > 0.01 SOL 시
# Telegram critical alert (best-effort, env not present 시 silent).
#
# crontab 등록 (매시간 정각):
#   0 * * * * /root/Solana/Solana-Trading/solana-momentum-bot/scripts/cron-equity-check.sh \
#     >> /root/Solana/Solana-Trading/solana-momentum-bot/logs/cron-equity-check.log 2>&1
#
# 환경변수:
#   EQUITY_BASELINE_SOL    — 비교 기준 baseline (필수). 없으면 dry-run.
#   EQUITY_DRIFT_THRESHOLD — drift alert 임계 (default 0.01 SOL)
#   TELEGRAM_BOT_TOKEN     — alert 송신 (선택)
#   TELEGRAM_CHAT_ID       — alert chat (선택)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$BOT_DIR"

BASELINE="${EQUITY_BASELINE_SOL:-}"
THRESHOLD="${EQUITY_DRIFT_THRESHOLD:-0.01}"
TS="$(date +%Y-%m-%dT%H-%M-%S)"
OUT_DIR="results/cron-equity-check"
mkdir -p "$OUT_DIR"

if [ -z "$BASELINE" ]; then
  echo "[$TS] EQUITY_BASELINE_SOL not set — dry run (no comparison, just decomposition snapshot)"
  npx ts-node scripts/equity-decomposition.ts --rpc-check \
    --json "$OUT_DIR/equity-${TS}.json" \
    --md "$OUT_DIR/equity-${TS}.md" || true
  exit 0
fi

JSON_OUT="$OUT_DIR/equity-${TS}.json"
MD_OUT="$OUT_DIR/equity-${TS}.md"

npx ts-node scripts/equity-decomposition.ts \
  --rpc-check \
  --baseline-sol "$BASELINE" \
  --json "$JSON_OUT" \
  --md "$MD_OUT" || {
  echo "[$TS] equity-decomposition failed — skip alert"
  exit 1
}

# Drift extraction — RPC 모드만 의미 있음. ledger 모드는 source mismatch 라 alert 안 함.
SOURCE=$(jq -r '.walletCashDeltaSource // "ledger_realized_sum"' "$JSON_OUT" 2>/dev/null || echo "unknown")
if [ "$SOURCE" != "rpc_balance" ]; then
  echo "[$TS] walletCashDelta source=$SOURCE — RPC unavailable, skip alert"
  exit 0
fi

CASH_DELTA=$(jq -r '.walletCashDelta // 0' "$JSON_OUT" 2>/dev/null || echo "0")
LEDGER_SUM=$(jq -r '.totalRealizedSol // 0' "$JSON_OUT" 2>/dev/null || echo "0")

# Drift = cash_delta - ledger_sum (양수면 wallet 이 더 많이 받음 → 정상보다 좋음, 음수면 손실 누락)
DRIFT=$(echo "$CASH_DELTA - $LEDGER_SUM" | bc -l)
ABS_DRIFT=$(echo "$DRIFT" | awk '{print ($1 < 0) ? -$1 : $1}')
EXCEEDED=$(awk -v a="$ABS_DRIFT" -v t="$THRESHOLD" 'BEGIN{print (a > t) ? 1 : 0}')

echo "[$TS] cash_delta=$CASH_DELTA ledger_sum=$LEDGER_SUM drift=$DRIFT (threshold=$THRESHOLD, exceeded=$EXCEEDED)"

if [ "$EXCEEDED" = "1" ] && [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  MSG="🚨 [EQUITY_DRIFT] $TS%0Acash=${CASH_DELTA}%0Aledger=${LEDGER_SUM}%0Adrift=${DRIFT} SOL (>${THRESHOLD})"
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "text=${MSG}" > /dev/null || true
fi
