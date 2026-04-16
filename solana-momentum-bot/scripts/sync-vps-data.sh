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

# 2-1. DB 메타 검증 (덤프 전 — 잘못된 DB 조기 감지)
# Why: VPS_DATABASE_URL 이 stale/wrong 이면 수백 건 덤프해도 최신 거래가 없다.
echo "[sync-vps-data] trades: verifying DB connection..."
DB_META="$(ssh "${REMOTE_HOST}" "psql '${VPS_DATABASE_URL}' -tA -c \
  \"SELECT current_database(), coalesce(inet_server_addr()::text,'localhost'), \
    coalesce(max(created_at)::text,'EMPTY'), coalesce(max(closed_at)::text,'EMPTY'), \
    count(*)::text FROM trades\"" 2>/dev/null || echo "||||ERROR")"

DB_NAME="$(echo "${DB_META}" | cut -d'|' -f1 | tr -d ' \n')"
DB_HOST="$(echo "${DB_META}" | cut -d'|' -f2 | tr -d ' \n')"
MAX_CREATED="$(echo "${DB_META}" | cut -d'|' -f3 | tr -d ' \n')"
MAX_CLOSED="$(echo "${DB_META}" | cut -d'|' -f4 | tr -d ' \n')"
DB_ROWS="$(echo "${DB_META}" | cut -d'|' -f5 | tr -d ' \n')"

echo "[sync-vps-data] trades: DB=${DB_NAME}@${DB_HOST}  rows=${DB_ROWS}"
echo "[sync-vps-data] trades: max_created=${MAX_CREATED}"
echo "[sync-vps-data] trades: max_closed=${MAX_CLOSED}"

# 신선도 검증: current-session.json 시작 시각과 비교
CURRENT_SESSION="${LOCAL_PATH}realtime/current-session.json"
if [ -f "${CURRENT_SESSION}" ] && [ "${MAX_CREATED}" != "EMPTY" ] && [ "${MAX_CREATED}" != "ERROR" ]; then
  SESSION_START="$(python3 -c "
import json, sys
try:
    d = json.load(open('${CURRENT_SESSION}'))
    print(d.get('startedAt',''))
except:
    print('')
" 2>/dev/null || echo "")"

  if [ -n "${SESSION_START}" ]; then
    # macOS(BSD) / Linux date 모두 지원
    to_epoch() {
      local ts="${1%%.*}"  # 소수점 이하 제거
      ts="${ts%+*}"        # +00:00 제거
      ts="${ts%Z}"         # Z 제거
      date -d "${ts}" +%s 2>/dev/null || \
      date -jf "%Y-%m-%dT%H:%M:%S" "${ts}" +%s 2>/dev/null || echo 0
    }
    SESSION_TS="$(to_epoch "${SESSION_START}")"
    MAX_CREATED_TS="$(to_epoch "${MAX_CREATED}")"

    if [ "${SESSION_TS}" -gt 0 ] && [ "${MAX_CREATED_TS}" -gt 0 ]; then
      if [ "${MAX_CREATED_TS}" -lt "${SESSION_TS}" ]; then
        GAP_H=$(( (SESSION_TS - MAX_CREATED_TS) / 3600 ))
        echo "[sync-vps-data] ⚠️  WARNING: DB 최신 거래가 현재 세션 시작보다 ${GAP_H}h 이전"
        echo "[sync-vps-data]    session_start : ${SESSION_START}"
        echo "[sync-vps-data]    db_max_created: ${MAX_CREATED}"
        echo "[sync-vps-data]    → VPS_DATABASE_URL 이 잘못된 DB를 가리킬 가능성"
        echo "[sync-vps-data]    → 확인: ssh ${REMOTE_HOST} \"pm2 env 0 | grep DATABASE_URL\""
      else
        echo "[sync-vps-data] ✓  DB 신선도 OK (max_created ≥ session_start)"
      fi
    fi
  fi
fi

# 2-2. VPS에서 row_to_json으로 JSONL 추출 (read-only, idempotent)
# Why row_to_json: 스키마 변화에 자동 적응, 컬럼 추가/삭제 시 코드 수정 불필요.
# Why ssh + psql: pg_dump 보다 가볍고 INSERT 문법 생성 안 함, 직접 jsonl 만 받음.
echo "[sync-vps-data] trades: dumping VPS trades -> ${SNAPSHOT_FILE}"
ssh "${REMOTE_HOST}" "psql '${VPS_DATABASE_URL}' -tA -c \"SELECT row_to_json(t) FROM trades t ORDER BY created_at\"" \
  > "${SNAPSHOT_FILE}"

# 2-3. 검증
SNAPSHOT_LINES="$(grep -c '^{' "${SNAPSHOT_FILE}" 2>/dev/null || echo 0)"
SNAPSHOT_BYTES="$(wc -c < "${SNAPSHOT_FILE}" | tr -d ' ')"
if [ "${SNAPSHOT_LINES}" -lt 1 ]; then
  echo "[sync-vps-data] trades: WARNING — snapshot is empty (${SNAPSHOT_LINES} rows, ${SNAPSHOT_BYTES} bytes)"
  echo "[sync-vps-data]   empty trades table is allowed for fresh/canary environments"
fi

# 2-4. latest 심볼릭 (cp 사용 — symlink 보다 git/rsync 친화적)
cp "${SNAPSHOT_FILE}" "${LATEST_FILE}"

echo "[sync-vps-data] trades: ${SNAPSHOT_LINES} rows, ${SNAPSHOT_BYTES} bytes"

# 2-5. breakdown (jq 가 있으면 strategy/status 그룹, 없으면 skip)
if [ "${SNAPSHOT_LINES}" -gt 0 ] && command -v jq >/dev/null 2>&1; then
  echo "[sync-vps-data] trades: breakdown (strategy / status):"
  jq -r '"\(.strategy)\t\(.status)"' "${LATEST_FILE}" | sort | uniq -c | sort -rn | sed 's/^/  /'
  # 덤프 내 실제 max_created 교차 검증
  DUMP_MAX_CREATED="$(jq -r '.created_at // empty' "${LATEST_FILE}" | sort | tail -1)"
  echo "[sync-vps-data] trades: dump_max_created=${DUMP_MAX_CREATED}"
fi

echo "[sync-vps-data] done"
echo "[sync-vps-data]   snapshot: ${SNAPSHOT_FILE}"
echo "[sync-vps-data]   latest:   ${LATEST_FILE}"
