#!/usr/bin/env bash
# Sync VPS realtime data + trades snapshot to local for analysis (P3 reality check 등).
#
# Why JSONL not local PG: 로컬 DB로 restore 하면 (1) 스키마 불일치 시 매번 ALTER 필요,
# (2) TRUNCATE → RESTORE 로 paper 데이터 손실, (3) DB 의존 늘어남.
# 파일 기반은 read-only · gitignore 가능 · 스키마 변화 자동 흡수.
#
# Usage:
#   bash scripts/sync-vps-data.sh                    # files + logs + trades 모두
#   SKIP_TRADES=true bash scripts/sync-vps-data.sh   # rsync (files + logs) 만
#   SKIP_FILES=true bash scripts/sync-vps-data.sh    # logs + trades 만
#   SKIP_LOGS=true bash scripts/sync-vps-data.sh     # files + trades 만
#
# Required for trades step:
#   export VPS_DATABASE_URL='postgresql://user:pw@host:port/dbname'
#   (VPS pm2 env에서 확인: ssh $REMOTE_HOST 'pm2 env 0 | grep DATABASE_URL')
#
# Required for rsync step:
#   ssh access to $REMOTE_HOST.
#
# Output:
#   data/realtime/sessions/...           (rsync from VPS data/)
#   logs/bot-out.log, logs/bot-error.log ... (rsync from VPS logs/)
#   data/vps-trades-latest.jsonl         (one JSON object per row, gitignored)
#   data/vps-trades-${STAMP}.jsonl       (timestamped snapshot)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${REMOTE_HOST:-root@104.238.181.61}"
REMOTE_PATH="${REMOTE_PATH:-~/Solana/Solana-Trading/solana-momentum-bot/data/}"
LOCAL_PATH="${LOCAL_PATH:-${ROOT_DIR}/data/}"
REMOTE_LOGS_PATH="${REMOTE_LOGS_PATH:-~/Solana/Solana-Trading/solana-momentum-bot/logs/}"
LOCAL_LOGS_PATH="${LOCAL_LOGS_PATH:-${ROOT_DIR}/logs/}"
VPS_PM2_APP_NAME="${VPS_PM2_APP_NAME:-momentum-bot}"
ALLOW_STALE_DB_DUMP="${ALLOW_STALE_DB_DUMP:-false}"

SKIP_FILES="${SKIP_FILES:-false}"
SKIP_LOGS="${SKIP_LOGS:-false}"
SKIP_TRADES="${SKIP_TRADES:-${SKIP_DB:-false}}"  # legacy SKIP_DB 호환

to_epoch() {
  local ts="${1%%.*}"  # 소수점 이하 제거
  ts="${ts%+*}"        # +00:00 제거
  ts="${ts%Z}"         # Z 제거
  date -d "${ts}" +%s 2>/dev/null || \
  date -jf "%Y-%m-%dT%H:%M:%S" "${ts}" +%s 2>/dev/null || echo 0
}

resolve_remote_database_url() {
  ssh "${REMOTE_HOST}" "PM2_APP_NAME='${VPS_PM2_APP_NAME}' node -e \"const { execSync } = require('child_process'); const app = process.env.PM2_APP_NAME; const list = JSON.parse(execSync('pm2 jlist', { stdio: ['ignore','pipe','ignore'] }).toString()); const proc = list.find((item) => item.name === app); if (!proc) process.exit(2); const env = proc.pm2_env?.env || proc.pm2_env || {}; const url = env.DATABASE_URL || ''; if (!url) process.exit(3); process.stdout.write(url);\"" 2>/dev/null
}

handle_stale_db() {
  local message="$1"
  if [ "${ALLOW_STALE_DB_DUMP}" = "true" ]; then
    echo "[sync-vps-data] ⚠️  WARNING: ${message}"
    echo "[sync-vps-data]    ALLOW_STALE_DB_DUMP=true 이므로 계속 진행"
  else
    echo "[sync-vps-data] ERROR: ${message}"
    echo "[sync-vps-data]   잘못된 DB dump 로 분석이 오염될 수 있어 중단합니다."
    echo "[sync-vps-data]   override: ALLOW_STALE_DB_DUMP=true bash scripts/sync-vps-data.sh"
    exit 1
  fi
}

# ─── 1. Files (jsonl, raw-swaps, micro-candles, sessions) ───
if [ "$SKIP_FILES" != "true" ]; then
  mkdir -p "${LOCAL_PATH}"
  echo "[sync-vps-data] files: ${REMOTE_HOST}:${REMOTE_PATH} -> ${LOCAL_PATH}"
  rsync -avz --progress "${REMOTE_HOST}:${REMOTE_PATH}" "${LOCAL_PATH}"
else
  echo "[sync-vps-data] files: SKIPPED (SKIP_FILES=true)"
fi

# ─── 2. Logs (bot-out.log, bot-error.log, rotated bot*.log) ───
# Why: 운영 중 issue 추적 (wallet_delta_warn, SlippageToleranceExceeded 등) 은
# stdout/stderr 경로 (pm2 가 logs/bot-out.log 로 리다이렉트) 를 봐야 분석 가능하다.
# data/ 동기화와 분리한 이유: 용량이 크고 (bot-out.log 수백 MB) 빈번한 갱신 대상이라
# 필요 시 SKIP_LOGS 로 스킵 가능해야 한다.
if [ "$SKIP_LOGS" != "true" ]; then
  mkdir -p "${LOCAL_LOGS_PATH}"
  echo "[sync-vps-data] logs: ${REMOTE_HOST}:${REMOTE_LOGS_PATH} -> ${LOCAL_LOGS_PATH}"
  rsync -avz --progress --partial "${REMOTE_HOST}:${REMOTE_LOGS_PATH}" "${LOCAL_LOGS_PATH}"
else
  echo "[sync-vps-data] logs: SKIPPED (SKIP_LOGS=true)"
fi

# ─── 3. Trades snapshot (JSONL, no local DB) ───
if [ "$SKIP_TRADES" = "true" ]; then
  echo "[sync-vps-data] trades: SKIPPED (SKIP_TRADES=true)"
  echo "[sync-vps-data] done"
  exit 0
fi

if [ -z "${VPS_DATABASE_URL:-}" ]; then
  echo "[sync-vps-data] trades: VPS_DATABASE_URL not set — resolving from pm2 app '${VPS_PM2_APP_NAME}'"
  if VPS_DATABASE_URL="$(resolve_remote_database_url)"; then
    echo "[sync-vps-data] trades: resolved DATABASE_URL from pm2 app '${VPS_PM2_APP_NAME}'"
  else
    echo "[sync-vps-data] ERROR: failed to resolve DATABASE_URL from pm2 app '${VPS_PM2_APP_NAME}'"
    echo "[sync-vps-data]   fallback:"
    echo "[sync-vps-data]     export VPS_DATABASE_URL='postgresql://...'"
    echo "[sync-vps-data]     # 또는 VPS에서: pm2 jlist | jq '.[] | select(.name==\"${VPS_PM2_APP_NAME}\")'"
    exit 1
  fi
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

if [ -z "${DB_NAME}" ] || [ "${DB_ROWS}" = "ERROR" ]; then
  echo "[sync-vps-data] ERROR: failed to query trades metadata from VPS DB"
  exit 1
fi

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
    SESSION_TS="$(to_epoch "${SESSION_START}")"
    MAX_CREATED_TS="$(to_epoch "${MAX_CREATED}")"

    if [ "${SESSION_TS}" -gt 0 ] && [ "${MAX_CREATED_TS}" -gt 0 ]; then
      if [ "${MAX_CREATED_TS}" -lt "${SESSION_TS}" ]; then
        GAP_H=$(( (SESSION_TS - MAX_CREATED_TS) / 3600 ))
        handle_stale_db "DB 최신 거래가 현재 세션 시작보다 ${GAP_H}h 이전 (session_start=${SESSION_START}, db_max_created=${MAX_CREATED}, app=${VPS_PM2_APP_NAME})"
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

# 2-4. dump 최대 시각 교차 검증 (jq 가 있으면 수행)
if [ "${SNAPSHOT_LINES}" -gt 0 ] && command -v jq >/dev/null 2>&1; then
  DUMP_MAX_CREATED="$(jq -r '.created_at // empty' "${SNAPSHOT_FILE}" | sort | tail -1)"
  echo "[sync-vps-data] trades: dump_max_created=${DUMP_MAX_CREATED}"
  if [ -n "${DUMP_MAX_CREATED}" ] && [ "${MAX_CREATED}" != "EMPTY" ] && [ "${DUMP_MAX_CREATED}" != "${MAX_CREATED}" ]; then
    handle_stale_db "dump_max_created (${DUMP_MAX_CREATED}) != preflight max_created (${MAX_CREATED})"
  fi
fi

# 2-5. latest 심볼릭 (cp 사용 — symlink 보다 git/rsync 친화적)
cp "${SNAPSHOT_FILE}" "${LATEST_FILE}"

echo "[sync-vps-data] trades: ${SNAPSHOT_LINES} rows, ${SNAPSHOT_BYTES} bytes"

# 2-6. breakdown (jq 가 있으면 strategy/status 그룹, 없으면 skip)
if [ "${SNAPSHOT_LINES}" -gt 0 ] && command -v jq >/dev/null 2>&1; then
  echo "[sync-vps-data] trades: breakdown (strategy / status):"
  jq -r '"\(.strategy)\t\(.status)"' "${LATEST_FILE}" | sort | uniq -c | sort -rn | sed 's/^/  /'
fi

echo "[sync-vps-data] done"
echo "[sync-vps-data]   snapshot: ${SNAPSHOT_FILE}"
echo "[sync-vps-data]   latest:   ${LATEST_FILE}"
