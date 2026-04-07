#!/usr/bin/env bash
# Sync VPS realtime data + trades snapshot to local for analysis (P3 reality check 등).
#
# Why JSONL not local PG: 로컬 DB로 restore 하면 (1) 스키마 불일치 시 매번 ALTER 필요,
# (2) TRUNCATE → RESTORE 로 paper 데이터 손실, (3) DB 의존 늘어남.
# 파일 기반은 read-only · gitignore 가능 · 스키마 변화 자동 흡수.
#
# Usage:
#   bash scripts/sync-vps-data.sh                    # files + trades 둘 다
#   SKIP_TRADES=true bash scripts/sync-vps-data.sh   # rsync만
#   SKIP_FILES=true bash scripts/sync-vps-data.sh    # trades만
#
# Required for trades step:
#   export VPS_DATABASE_URL='postgresql://user:pw@host:port/dbname'
#   (VPS pm2 env에서 확인: ssh $REMOTE_HOST 'pm2 env 0 | grep DATABASE_URL')
#
# Required for rsync step:
#   ssh access to $REMOTE_HOST.
#
# Output:
#   data/realtime/sessions/...           (rsync from VPS)
#   data/vps-trades-latest.jsonl         (one JSON object per row, gitignored)
#   data/vps-trades-${STAMP}.jsonl       (timestamped snapshot)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${REMOTE_HOST:-root@104.238.181.61}"
REMOTE_PATH="${REMOTE_PATH:-~/Solana/Solana-Trading/solana-momentum-bot/data/}"
LOCAL_PATH="${LOCAL_PATH:-${ROOT_DIR}/data/}"

SKIP_FILES="${SKIP_FILES:-false}"
SKIP_TRADES="${SKIP_TRADES:-${SKIP_DB:-false}}"  # legacy SKIP_DB 호환

# ─── 1. Files (jsonl, raw-swaps, micro-candles, sessions) ───
if [ "$SKIP_FILES" != "true" ]; then
  mkdir -p "${LOCAL_PATH}"
  echo "[sync-vps-data] files: ${REMOTE_HOST}:${REMOTE_PATH} -> ${LOCAL_PATH}"
  rsync -avz --progress "${REMOTE_HOST}:${REMOTE_PATH}" "${LOCAL_PATH}"
else
  echo "[sync-vps-data] files: SKIPPED (SKIP_FILES=true)"
fi

# ─── 2. Trades snapshot (JSONL, no local DB) ───
if [ "$SKIP_TRADES" = "true" ]; then
  echo "[sync-vps-data] trades: SKIPPED (SKIP_TRADES=true)"
  echo "[sync-vps-data] done"
  exit 0
fi

if [ -z "${VPS_DATABASE_URL:-}" ]; then
  echo "[sync-vps-data] trades: SKIPPED (VPS_DATABASE_URL not set)"
  echo "[sync-vps-data]   설정 방법:"
  echo "[sync-vps-data]     export VPS_DATABASE_URL=\$(ssh ${REMOTE_HOST} \"pm2 env 0 | grep '^DATABASE_URL:' | awk '{print \\\$2}'\")"
  echo "[sync-vps-data]     # 또는 직접: export VPS_DATABASE_URL='postgresql://...'"
  echo "[sync-vps-data] done"
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
SNAPSHOT_FILE="${ROOT_DIR}/data/vps-trades-${STAMP}.jsonl"
LATEST_FILE="${ROOT_DIR}/data/vps-trades-latest.jsonl"

# 2-1. VPS에서 row_to_json으로 JSONL 추출 (read-only, idempotent)
# Why row_to_json: 스키마 변화에 자동 적응, 컬럼 추가/삭제 시 코드 수정 불필요.
# Why ssh + psql: pg_dump 보다 가볍고 INSERT 문법 생성 안 함, 직접 jsonl 만 받음.
echo "[sync-vps-data] trades: dumping VPS trades -> ${SNAPSHOT_FILE}"
ssh "${REMOTE_HOST}" "psql '${VPS_DATABASE_URL}' -tA -c \"SELECT row_to_json(t) FROM trades t ORDER BY created_at\"" \
  > "${SNAPSHOT_FILE}"

# 2-2. 검증
SNAPSHOT_LINES="$(grep -c '^{' "${SNAPSHOT_FILE}" 2>/dev/null || echo 0)"
SNAPSHOT_BYTES="$(wc -c < "${SNAPSHOT_FILE}" | tr -d ' ')"
if [ "${SNAPSHOT_LINES}" -lt 1 ]; then
  echo "[sync-vps-data] trades: WARNING — snapshot is empty (${SNAPSHOT_LINES} rows, ${SNAPSHOT_BYTES} bytes)"
  echo "[sync-vps-data]   empty trades table is allowed for fresh/canary environments"
fi

# 2-3. latest 심볼릭 (cp 사용 — symlink 보다 git/rsync 친화적)
cp "${SNAPSHOT_FILE}" "${LATEST_FILE}"

echo "[sync-vps-data] trades: ${SNAPSHOT_LINES} rows, ${SNAPSHOT_BYTES} bytes"

# 2-4. breakdown (jq 가 있으면 strategy/status 그룹, 없으면 skip)
if [ "${SNAPSHOT_LINES}" -gt 0 ] && command -v jq >/dev/null 2>&1; then
  echo "[sync-vps-data] trades: breakdown (strategy / status):"
  jq -r '"\(.strategy)\t\(.status)"' "${LATEST_FILE}" | sort | uniq -c | sort -rn | sed 's/^/  /'
fi

echo "[sync-vps-data] done"
echo "[sync-vps-data]   snapshot: ${SNAPSHOT_FILE}"
echo "[sync-vps-data]   latest:   ${LATEST_FILE}"
