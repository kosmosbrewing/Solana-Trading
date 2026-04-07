#!/usr/bin/env bash
# Sync VPS realtime data + trades DB to local for analysis (P3 reality check 등).
#
# Usage:
#   bash scripts/sync-vps-data.sh                    # files + DB 둘 다
#   SKIP_DB=true bash scripts/sync-vps-data.sh       # rsync만
#   SKIP_FILES=true bash scripts/sync-vps-data.sh    # DB만
#
# Required for DB step:
#   export VPS_DATABASE_URL='postgresql://user:pw@host:port/dbname'
#   (VPS pm2 env에서 확인: ssh $REMOTE_HOST 'pm2 env 0 | grep DATABASE_URL')
#
# Required for rsync step:
#   ssh access to $REMOTE_HOST.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${REMOTE_HOST:-root@104.238.181.61}"
REMOTE_PATH="${REMOTE_PATH:-~/Solana/Solana-Trading/solana-momentum-bot/data/}"
LOCAL_PATH="${LOCAL_PATH:-${ROOT_DIR}/data/}"

SKIP_FILES="${SKIP_FILES:-false}"
SKIP_DB="${SKIP_DB:-false}"

# ─── 1. Files (jsonl, raw-swaps, micro-candles, sessions) ───
if [ "$SKIP_FILES" != "true" ]; then
  mkdir -p "${LOCAL_PATH}"
  echo "[sync-vps-data] files: ${REMOTE_HOST}:${REMOTE_PATH} -> ${LOCAL_PATH}"
  rsync -avz --progress "${REMOTE_HOST}:${REMOTE_PATH}" "${LOCAL_PATH}"
else
  echo "[sync-vps-data] files: SKIPPED (SKIP_FILES=true)"
fi

# ─── 2. DB trades table ───
if [ "$SKIP_DB" = "true" ]; then
  echo "[sync-vps-data] db: SKIPPED (SKIP_DB=true)"
  echo "[sync-vps-data] done"
  exit 0
fi

if [ -z "${VPS_DATABASE_URL:-}" ]; then
  echo "[sync-vps-data] db: SKIPPED (VPS_DATABASE_URL not set)"
  echo "[sync-vps-data]   설정 방법:"
  echo "[sync-vps-data]     export VPS_DATABASE_URL=\$(ssh ${REMOTE_HOST} \"pm2 env 0 | grep '^DATABASE_URL:' | awk '{print \\\$2}'\")"
  echo "[sync-vps-data]     # 또는 직접: export VPS_DATABASE_URL='postgresql://...'"
  echo "[sync-vps-data] done"
  exit 0
fi

LOCAL_DB_URL="$(grep '^DATABASE_URL=' "${ROOT_DIR}/.env" | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
if [ -z "${LOCAL_DB_URL}" ]; then
  echo "[sync-vps-data] db: ERROR — cannot read DATABASE_URL from ${ROOT_DIR}/.env"
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="${ROOT_DIR}/data/local-trades-backup-${STAMP}.jsonl"
DUMP_FILE="${ROOT_DIR}/data/vps-trades-${STAMP}.sql"

# 2-1. 로컬 trades 백업 (테이블 비어 있으면 빈 파일)
echo "[sync-vps-data] db: backing up local trades -> ${BACKUP_FILE}"
psql "${LOCAL_DB_URL}" -tA -c "SELECT row_to_json(t) FROM trades t" > "${BACKUP_FILE}" || true
BACKUP_COUNT="$(wc -l < "${BACKUP_FILE}" | tr -d ' ')"
echo "[sync-vps-data] db: backed up ${BACKUP_COUNT} local rows"

# 2-2. VPS에서 dump
echo "[sync-vps-data] db: dumping trades from VPS via ${REMOTE_HOST}"
ssh "${REMOTE_HOST}" "pg_dump --data-only --no-owner --column-inserts --table=trades '${VPS_DATABASE_URL}'" \
  > "${DUMP_FILE}"

DUMP_BYTES="$(wc -c < "${DUMP_FILE}" | tr -d ' ')"
if [ "${DUMP_BYTES}" -lt 100 ]; then
  echo "[sync-vps-data] db: ERROR — dump is too small (${DUMP_BYTES} bytes)"
  echo "[sync-vps-data]   확인: ssh ${REMOTE_HOST} \"pg_dump --data-only --table=trades '\${VPS_DATABASE_URL}'\""
  exit 1
fi
echo "[sync-vps-data] db: dump = ${DUMP_BYTES} bytes"

# 2-3. 로컬 truncate + restore
echo "[sync-vps-data] db: truncating local trades"
psql "${LOCAL_DB_URL}" -c "TRUNCATE trades;" >/dev/null

echo "[sync-vps-data] db: applying dump"
psql "${LOCAL_DB_URL}" -q < "${DUMP_FILE}"

# 2-4. 검증
LOCAL_COUNT="$(psql "${LOCAL_DB_URL}" -tA -c 'SELECT COUNT(*) FROM trades;')"
echo "[sync-vps-data] db: local trades after restore = ${LOCAL_COUNT}"

LOCAL_BREAKDOWN="$(psql "${LOCAL_DB_URL}" -c "SELECT strategy, status, COUNT(*) FROM trades GROUP BY strategy, status ORDER BY 3 DESC;")"
echo "[sync-vps-data] db: breakdown:"
echo "${LOCAL_BREAKDOWN}"

echo "[sync-vps-data] done"
echo "[sync-vps-data]   backup: ${BACKUP_FILE}"
echo "[sync-vps-data]   dump:   ${DUMP_FILE}"
