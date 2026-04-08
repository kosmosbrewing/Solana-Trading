#!/usr/bin/env bash
# Sync VPS artifacts and refresh local analysis docs.
#
# Default flow:
#   1. sync-vps-data.sh
#   2. optional remote trade-report.ts snapshot
#   3. local realized-replay-ratio.ts
#
# Usage:
#   bash scripts/refresh-vps-analysis.sh
#   FETCH_TRADE_REPORT=true bash scripts/refresh-vps-analysis.sh
#   RUN_SYNC=false RATIO_STRATEGY=volume bash scripts/refresh-vps-analysis.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"

RUN_SYNC="${RUN_SYNC:-true}"
RUN_RATIO="${RUN_RATIO:-true}"
FETCH_TRADE_REPORT="${FETCH_TRADE_REPORT:-false}"

REMOTE_HOST="${REMOTE_HOST:-root@104.238.181.61}"
REMOTE_REPO_PATH="${REMOTE_REPO_PATH:-~/Solana/Solana-Trading/solana-momentum-bot}"

OUT_DIR="${OUT_DIR:-${ROOT_DIR}/results/vps-analysis}"
TRADES_FILE="${TRADES_FILE:-data/vps-trades-latest.jsonl}"

REPORT_HOURS="${REPORT_HOURS:-4}"
REPORT_SNAPSHOT="${OUT_DIR}/trade-report-${STAMP}.txt"
REPORT_LATEST="${OUT_DIR}/trade-report-latest.txt"

RATIO_MODE="${RATIO_MODE:-live}"
RATIO_STRATEGY="${RATIO_STRATEGY:-bootstrap}"
RATIO_HORIZON="${RATIO_HORIZON:-180}"
RATIO_SESSION_GLOB="${RATIO_SESSION_GLOB:-}"
RATIO_SNAPSHOT="${OUT_DIR}/realized-replay-ratio-${STAMP}.md"
RATIO_LATEST="${OUT_DIR}/realized-replay-ratio-latest.md"

mkdir -p "${OUT_DIR}"

run_remote_trade_report() {
  echo "[refresh-vps-analysis] trade-report: fetching ${REPORT_HOURS}h snapshot from VPS"
  if [ -n "${VPS_DATABASE_URL:-}" ]; then
    ssh "${REMOTE_HOST}" \
      "cd ${REMOTE_REPO_PATH} && DATABASE_URL='${VPS_DATABASE_URL}' npx ts-node scripts/trade-report.ts --hours '${REPORT_HOURS}'" \
      > "${REPORT_SNAPSHOT}"
  else
    ssh "${REMOTE_HOST}" \
      "cd ${REMOTE_REPO_PATH} && DATABASE_URL=\$(pm2 env 0 | awk -F': ' '/^DATABASE_URL:/{print \$2; exit}') npx ts-node scripts/trade-report.ts --hours '${REPORT_HOURS}'" \
      > "${REPORT_SNAPSHOT}"
  fi
  cp "${REPORT_SNAPSHOT}" "${REPORT_LATEST}"
  echo "[refresh-vps-analysis] trade-report: saved ${REPORT_SNAPSHOT}"
  echo "[refresh-vps-analysis] trade-report: latest ${REPORT_LATEST}"
  local exhaustion_line
  local empty_window_line
  exhaustion_line="$(grep -F "EXHAUSTION (entry):" "${REPORT_LATEST}" || true)"
  empty_window_line="$(grep -E "거래 없음\\.|실현 손익 row 없음\\." "${REPORT_LATEST}" || true)"
  if [ -n "${exhaustion_line}" ]; then
    echo "[refresh-vps-analysis] trade-report: ${exhaustion_line}"
  elif [ -n "${empty_window_line}" ]; then
    echo "[refresh-vps-analysis] trade-report: no realized rows in requested window"
  else
    echo "[refresh-vps-analysis] trade-report: WARNING missing 'EXHAUSTION (entry)' line (old remote script or fetch failure)"
  fi
}

run_realized_ratio() {
  echo "[refresh-vps-analysis] realized-ratio: mode=${RATIO_MODE} strategy=${RATIO_STRATEGY:-all} horizon=${RATIO_HORIZON}s"
  local cmd=(
    npx ts-node scripts/analysis/realized-replay-ratio.ts
    --mode "${RATIO_MODE}"
    --horizon "${RATIO_HORIZON}"
    --trades-file "${TRADES_FILE}"
    --out "${RATIO_SNAPSHOT}"
  )

  if [ -n "${RATIO_STRATEGY}" ]; then
    cmd+=(--strategy "${RATIO_STRATEGY}")
  fi
  if [ -n "${RATIO_SESSION_GLOB}" ]; then
    cmd+=(--session-glob "${RATIO_SESSION_GLOB}")
  fi

  (
    cd "${ROOT_DIR}"
    "${cmd[@]}"
  )
  cp "${RATIO_SNAPSHOT}" "${RATIO_LATEST}"
  echo "[refresh-vps-analysis] realized-ratio: saved ${RATIO_SNAPSHOT}"
  echo "[refresh-vps-analysis] realized-ratio: latest ${RATIO_LATEST}"
}

if [ "${RUN_SYNC}" = "true" ]; then
  echo "[refresh-vps-analysis] sync: start"
  (
    cd "${ROOT_DIR}"
    bash scripts/sync-vps-data.sh
  )
else
  echo "[refresh-vps-analysis] sync: SKIPPED (RUN_SYNC=false)"
fi

if [ "${FETCH_TRADE_REPORT}" = "true" ]; then
  run_remote_trade_report
else
  echo "[refresh-vps-analysis] trade-report: SKIPPED (FETCH_TRADE_REPORT=false)"
fi

if [ "${RUN_RATIO}" = "true" ]; then
  run_realized_ratio
else
  echo "[refresh-vps-analysis] realized-ratio: SKIPPED (RUN_RATIO=false)"
fi

echo "[refresh-vps-analysis] done"
