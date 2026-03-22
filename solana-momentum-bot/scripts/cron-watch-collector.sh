#!/usr/bin/env bash
# cron-watch-collector.sh
#
# helius-collector WS silent-drop 감지 watchdog
# — data/realtime-swaps/ 하위 raw-swaps.jsonl 중 최근 수정 파일이
#   STALE_MINUTES 이상 갱신 없으면 pm2 restart helius-collector
#
# crontab 등록 (10분마다):
#   */10 * * * * /root/Solana/Solana-Trading/solana-momentum-bot/scripts/cron-watch-collector.sh >> /root/Solana/Solana-Trading/solana-momentum-bot/logs/cron-watch-collector.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SWAPS_DIR="${BOT_DIR}/data/realtime-swaps"
STALE_MINUTES="${COLLECTOR_STALE_MINUTES:-15}"
PM2_PROCESS="helius-collector"
LOG_PREFIX="[watch-collector]"

echo "${LOG_PREFIX} === Check: $(date -u +%Y-%m-%dT%H:%M:%SZ) (stale_threshold=${STALE_MINUTES}m) ==="

# ── 1. 수집 디렉토리 존재 여부 ─────────────────────────────────────────────
if [ ! -d "$SWAPS_DIR" ]; then
  echo "${LOG_PREFIX} SWAPS_DIR not found: ${SWAPS_DIR} — skipping"
  exit 0
fi

# ── 2. 최근 수정된 raw-swaps.jsonl 탐색 ───────────────────────────────────
# find: STALE_MINUTES 이내에 수정된 파일이 하나라도 있으면 fresh
FRESH_FILE=$(find "$SWAPS_DIR" -name "raw-swaps.jsonl" -mmin "-${STALE_MINUTES}" 2>/dev/null | head -1)

if [ -n "$FRESH_FILE" ]; then
  echo "${LOG_PREFIX} OK — fresh data found (e.g. ${FRESH_FILE##*/data/realtime-swaps/})"
  exit 0
fi

# ── 3. Stale 판정 → pm2 restart ───────────────────────────────────────────
echo "${LOG_PREFIX} STALE — no swap writes in ${STALE_MINUTES}m. Restarting ${PM2_PROCESS}..."

if command -v pm2 &>/dev/null; then
  pm2 restart "$PM2_PROCESS" --update-env 2>&1 | sed "s/^/${LOG_PREFIX} pm2: /"
  RESTART_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "${LOG_PREFIX} Restart issued at ${RESTART_TS}"

  # Telegram alert (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID 환경변수 설정 시 전송)
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    MSG="⚠️ [watch-collector] STALE restart: ${PM2_PROCESS} — no swap data for ${STALE_MINUTES}m (${RESTART_TS})"
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_CHAT_ID}" \
      -d text="${MSG}" > /dev/null || echo "${LOG_PREFIX} WARN: Telegram alert failed"
  fi
else
  echo "${LOG_PREFIX} ERROR: pm2 not found in PATH — cannot restart"
  exit 1
fi
