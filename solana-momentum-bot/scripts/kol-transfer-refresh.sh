#!/usr/bin/env bash
# Refresh KOL transfer posterior input as a low-frequency sidecar batch.
#
# This script intentionally stays outside sync-vps-data.sh and the live trading
# process. It calls Helius only when the local transfer ledger is stale, writes
# through kol-transfer-backfill's backup/overwrite path, then regenerates the
# posterior report from file.
#
# Usage:
#   npm run kol:transfer-refresh
#   KOL_TRANSFER_REFRESH_FORCE=true npm run kol:transfer-refresh
#   KOL_TRANSFER_REFRESH_MAX_AGE_HOURS=168 KOL_TRANSFER_REFRESH_SINCE=7d npm run kol:transfer-refresh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

REFRESH_SINCE="${KOL_TRANSFER_REFRESH_SINCE:-7d}"
# 2026-05-09 Helius containment: daily refresh can consume a large share of the remaining quota.
# Default to weekly-ish cadence; force/manual runs remain available for incident analysis.
MAX_AGE_HOURS="${KOL_TRANSFER_REFRESH_MAX_AGE_HOURS:-168}"
MAX_PAGES_PER_WALLET="${KOL_TRANSFER_REFRESH_MAX_PAGES_PER_WALLET:-3}"
FORCE="${KOL_TRANSFER_REFRESH_FORCE:-false}"
SKIP_REPORT="${KOL_TRANSFER_REFRESH_SKIP_REPORT:-false}"
INPUT_REL="${KOL_TRANSFER_INPUT:-data/research/kol-transfers.jsonl}"
LOG_FILE="${KOL_TRANSFER_REFRESH_LOG:-${ROOT_DIR}/logs/kol-transfer-refresh.log}"
LOCK_DIR="${KOL_TRANSFER_REFRESH_LOCK_DIR:-${ROOT_DIR}/data/research/.kol-transfer-refresh.lock}"

case "$INPUT_REL" in
  /*) INPUT_FILE="$INPUT_REL" ;;
  *) INPUT_FILE="${ROOT_DIR}/${INPUT_REL}" ;;
esac

mkdir -p "$(dirname "$LOG_FILE")" "${ROOT_DIR}/data/research" "${ROOT_DIR}/reports"

log() {
  local msg="[kol-transfer-refresh] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}

file_mtime_epoch() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo ""
    return
  fi
  stat -f "%m" "$file" 2>/dev/null || stat -c "%Y" "$file" 2>/dev/null || echo ""
}

is_stale() {
  if [ "$FORCE" = "true" ]; then
    return 0
  fi
  if [ ! -f "$INPUT_FILE" ]; then
    return 0
  fi
  local mtime now age_sec max_age_sec
  mtime="$(file_mtime_epoch "$INPUT_FILE")"
  if [ -z "$mtime" ]; then
    return 0
  fi
  now="$(date +%s)"
  age_sec=$((now - mtime))
  max_age_sec=$((MAX_AGE_HOURS * 3600))
  [ "$age_sec" -ge "$max_age_sec" ]
}

if ! [[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]] || [ "$MAX_AGE_HOURS" -le 0 ]; then
  log "ERROR MAX_AGE_HOURS must be a positive integer: ${MAX_AGE_HOURS}"
  exit 1
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "SKIP another refresh is running lock=${LOCK_DIR}"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

if ! is_stale; then
  mtime="$(file_mtime_epoch "$INPUT_FILE")"
  now="$(date +%s)"
  age_min=$(((now - mtime) / 60))
  log "SKIP fresh input=${INPUT_REL} age=${age_min}min maxAge=${MAX_AGE_HOURS}h"
  exit 0
fi

log "START since=${REFRESH_SINCE} input=${INPUT_REL} force=${FORCE} maxAge=${MAX_AGE_HOURS}h"

(
  cd "$ROOT_DIR"
  npm run -s kol:transfer-backfill -- --since "$REFRESH_SINCE" --max-pages-per-wallet "$MAX_PAGES_PER_WALLET" --overwrite
) 2>&1 | tee -a "$LOG_FILE"

if [ "$SKIP_REPORT" != "true" ]; then
  TODAY="$(date +%Y-%m-%d)"
  log "REPORT since=${REFRESH_SINCE}"
  (
    cd "$ROOT_DIR"
    npm run -s kol:transfer-report -- --input "$INPUT_REL" --since "$REFRESH_SINCE" \
      --md "reports/kol-transfer-posterior-${TODAY}.md" \
      --json "reports/kol-transfer-posterior-${TODAY}.json"
  ) 2>&1 | tee -a "$LOG_FILE"
fi

log "DONE input=${INPUT_REL}"
