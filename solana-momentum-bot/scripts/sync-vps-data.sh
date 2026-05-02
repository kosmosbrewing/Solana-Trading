#!/usr/bin/env bash
# Sync VPS realtime data + trades snapshot to local for analysis (P3 reality check 등).
#
# Why JSONL not local PG: 로컬 DB로 restore 하면 (1) 스키마 불일치 시 매번 ALTER 필요,
# (2) TRUNCATE → RESTORE 로 paper 데이터 손실, (3) DB 의존 늘어남.
# 파일 기반은 read-only · gitignore 가능 · 스키마 변화 자동 흡수.
#
# Usage:
#   bash scripts/sync-vps-data.sh                    # files + logs + file-only reports
#   RUN_TRADES_DUMP=true bash scripts/sync-vps-data.sh  # legacy DB trades snapshot opt-in
#   SKIP_FILES=true bash scripts/sync-vps-data.sh    # logs + reports 만
#   SKIP_LOGS=true bash scripts/sync-vps-data.sh     # files + reports 만
#   SKIP_PAPER_REPORT=true bash scripts/sync-vps-data.sh   # paper arm report 생략
#   SKIP_TOKEN_QUALITY_REPORT=true bash scripts/sync-vps-data.sh  # dev candidate quality report 생략
#   SKIP_LIVE_CANARY_REPORT=true bash scripts/sync-vps-data.sh    # live canary report 생략
#   SKIP_TRADE_MARKOUT_REPORT=true bash scripts/sync-vps-data.sh  # buy/sell T+ markout report 생략
#   SKIP_WINNER_KILL_REPORT=true bash scripts/sync-vps-data.sh    # winner-kill report 생략
#   SKIP_SYNC_HEALTH=true bash scripts/sync-vps-data.sh           # sync health manifest 생략
#   RUN_SHADOW_EVAL=true bash scripts/sync-vps-data.sh     # KOL shadow eval 추가 (Jupiter API 사용)
#
# Required only for RUN_TRADES_DUMP=true:
#   export VPS_DATABASE_URL='postgresql://user:pw@host:port/dbname'
#   (VPS pm2 env에서 확인: ssh $REMOTE_HOST 'pm2 env 0 | grep DATABASE_URL')
#
# Required for rsync step:
#   ssh access to $REMOTE_HOST.
#
# Output:
#   data/realtime/sessions/...           (rsync from VPS data/)
#   logs/bot-out.log, logs/bot-error.log ... (rsync from VPS logs/)
#   data/vps-trades-latest.jsonl         (opt-in, one JSON object per row, gitignored)
#   data/vps-trades-${STAMP}.jsonl       (opt-in timestamped snapshot)

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
# 2026-05-01: DB trades snapshot 은 기본 OFF. 운영 분석은 data/realtime JSONL 을 truth 로 사용한다.
# 필요할 때만 RUN_TRADES_DUMP=true 또는 SKIP_TRADES=false 로 opt-in.
RUN_TRADES_DUMP="${RUN_TRADES_DUMP:-false}"
SKIP_TRADES="${SKIP_TRADES:-${SKIP_DB:-true}}"  # legacy SKIP_DB 호환
if [ "$RUN_TRADES_DUMP" = "true" ]; then
  SKIP_TRADES="false"
fi
# 2026-04-26~05-01 — sync 직후 자동 분석 단계.
# paper-arm-report: 파일 only (Jupiter API 0건) → default ON.
# token-quality-report: 파일 only (Jupiter/API 0건) → default ON. dev-wallet candidate JSON join 포함.
# live-canary-report: 파일 only → default ON. live canary wallet-truth / 5x / catastrophic summary.
# trade-markout-report: 파일 only → default ON. 실제 buy/sell 이후 T+30/60/300/1800 coverage / continuation.
# winner-kill-report: 파일 only → default ON. missed-alpha close-site 기반 tail-retain feedback.
# sync-health: 파일 only → default ON. 핵심 JSONL row count / mtime manifest.
# shadow-eval: Jupiter forward quote 호출 다수 → quota 절약을 위해 default OFF (opt-in).
SKIP_PAPER_REPORT="${SKIP_PAPER_REPORT:-false}"
SKIP_TOKEN_QUALITY_REPORT="${SKIP_TOKEN_QUALITY_REPORT:-false}"
SKIP_LIVE_CANARY_REPORT="${SKIP_LIVE_CANARY_REPORT:-false}"
SKIP_TRADE_MARKOUT_REPORT="${SKIP_TRADE_MARKOUT_REPORT:-false}"
SKIP_WINNER_KILL_REPORT="${SKIP_WINNER_KILL_REPORT:-false}"
SKIP_SYNC_HEALTH="${SKIP_SYNC_HEALTH:-false}"
TOKEN_QUALITY_WINDOW_DAYS="${TOKEN_QUALITY_WINDOW_DAYS:-7}"
TRADE_MARKOUT_SINCE="${TRADE_MARKOUT_SINCE:-24h}"
WINNER_KILL_WINDOW_DAYS="${WINNER_KILL_WINDOW_DAYS:-7}"
RUN_SHADOW_EVAL="${RUN_SHADOW_EVAL:-false}"

to_epoch() {
  local ts="${1%%.*}"  # 소수점 이하 제거
  ts="${ts%+*}"        # +00:00 제거
  ts="${ts%Z}"         # Z 제거
  # macOS (BSD) / Linux (GNU) 양쪽 모두 + 'T' 와 ' ' 두 구분자 모두 지원.
  date -d "${ts}" +%s 2>/dev/null || \
  date -jf "%Y-%m-%dT%H:%M:%S" "${ts}" +%s 2>/dev/null || \
  date -jf "%Y-%m-%d %H:%M:%S" "${ts}" +%s 2>/dev/null || echo 0
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

jsonl_rows() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "missing"
    return
  fi
  grep -cve '^[[:space:]]*$' "$file" 2>/dev/null || echo 0
}

file_bytes() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "missing"
    return
  fi
  wc -c < "$file" | tr -d ' '
}

file_mtime_epoch() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo ""
    return
  fi
  stat -f "%m" "$file" 2>/dev/null || stat -c "%Y" "$file" 2>/dev/null || echo ""
}

file_mtime_iso() {
  local file="$1"
  local epoch
  epoch="$(file_mtime_epoch "$file")"
  if [ -z "$epoch" ]; then
    echo "missing"
    return
  fi
  date -u -r "$epoch" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
  date -u -d "@$epoch" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "$epoch"
}

write_sync_health_report() {
  local out_file="$1"
  mkdir -p "$(dirname "$out_file")"
  {
    echo "# Sync Health ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
    echo ""
    echo "| Artifact | Rows | Bytes | Modified UTC |"
    echo "|---|---:|---:|---|"
    for rel in \
      "data/realtime/current-session.json" \
      "data/realtime/kol-paper-trades.jsonl" \
      "data/realtime/kol-live-trades.jsonl" \
      "data/realtime/token-quality-observations.jsonl" \
      "data/realtime/missed-alpha.jsonl" \
      "data/realtime/trade-markout-anchors.jsonl" \
      "data/realtime/trade-markouts.jsonl" \
      "data/realtime/executed-buys.jsonl" \
      "data/realtime/executed-sells.jsonl" \
      "logs/bot.log" \
      "logs/bot-out.log" \
      "logs/bot-error.log"
    do
      local abs="${ROOT_DIR}/${rel}"
      local rows
      if [[ "$rel" == *.jsonl || "$rel" == *.log ]]; then
        rows="$(jsonl_rows "$abs")"
      else
        rows="-"
      fi
      echo "| ${rel} | ${rows} | $(file_bytes "$abs") | $(file_mtime_iso "$abs") |"
    done
  } > "$out_file"
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

  # 2026-04-29 (P1): freshness 검증 — sync 후 bot.log 가 stale 하면 명시적 warn.
  # Why: 운영자가 sync 명령 안 돌렸거나 VPS 봇 down 상태인 경우 분석 결과 오염.
  # 직전 incident: logs/bot.log mtime 20:16Z 인데 분석 시점은 23:40Z (3.5h stale) — wallet_delta_warn
  # dedup 검증 불가. SESSION_START.md §6-bis 체크리스트의 "bot.log freshness" 자동화.
  LOG_FRESHNESS_THRESHOLD_SEC="${LOG_FRESHNESS_THRESHOLD_SEC:-1800}"  # 30분 default
  if [ -f "${LOCAL_LOGS_PATH}/bot.log" ]; then
    NOW_EPOCH=$(date +%s)
    # macOS (BSD) / Linux (GNU) 양쪽 호환
    LOG_MTIME=$(stat -f "%m" "${LOCAL_LOGS_PATH}/bot.log" 2>/dev/null || stat -c "%Y" "${LOCAL_LOGS_PATH}/bot.log" 2>/dev/null || echo 0)
    LOG_AGE_SEC=$((NOW_EPOCH - LOG_MTIME))
    if [ "$LOG_AGE_SEC" -gt "$LOG_FRESHNESS_THRESHOLD_SEC" ]; then
      LOG_AGE_MIN=$((LOG_AGE_SEC / 60))
      echo "[sync-vps-data] ⚠️  WARNING: logs/bot.log is ${LOG_AGE_MIN}min old (>${LOG_FRESHNESS_THRESHOLD_SEC}s threshold)"
      echo "[sync-vps-data]    가능 원인: (1) VPS 봇 down (2) pm2 log rotation 직후 (3) rsync 실패"
      echo "[sync-vps-data]    분석 전 ssh ${REMOTE_HOST} 'pm2 list' 로 봇 상태 확인 권장"
    else
      echo "[sync-vps-data] logs/bot.log freshness OK (${LOG_AGE_SEC}s old)"
    fi
  else
    echo "[sync-vps-data] ⚠️  WARNING: logs/bot.log not found after sync — VPS log path 확인 필요"
  fi
else
  echo "[sync-vps-data] logs: SKIPPED (SKIP_LOGS=true)"
fi

# ─── 3. Trades snapshot (JSONL, no local DB) ───
TRADES_SKIPPED=false
if [ "$SKIP_TRADES" = "true" ]; then
  echo "[sync-vps-data] trades: SKIPPED (DB dump default off; set RUN_TRADES_DUMP=true to enable)"
  TRADES_SKIPPED=true
fi

if [ "$TRADES_SKIPPED" != "true" ] && [ -z "${VPS_DATABASE_URL:-}" ]; then
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

if [ "$TRADES_SKIPPED" != "true" ]; then

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
# Why: timestamp 필드는 공백 보존 (postgres '2026-04-18 19:36:32.164514+00' vs ISO 'T' 구분).
# 공백을 지우면 dump_max_created 와 preflight 비교가 포맷 차이로 false-positive 반환.
MAX_CREATED="$(echo "${DB_META}" | cut -d'|' -f3 | tr -d '\n')"
MAX_CLOSED="$(echo "${DB_META}" | cut -d'|' -f4 | tr -d '\n')"
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
# Why: 포맷이 다른 두 timestamp (postgres 'YYYY-MM-DD HH:MM:SS+00' vs ISO 'YYYY-MM-DDTHH:MM:SS+00:00')
# 를 문자열로 비교하면 같은 시각인데 다르다고 나온다 — epoch 으로 변환 후 수치 비교.
if [ "${SNAPSHOT_LINES}" -gt 0 ] && command -v jq >/dev/null 2>&1; then
  DUMP_MAX_CREATED="$(jq -r '.created_at // empty' "${SNAPSHOT_FILE}" | sort | tail -1)"
  echo "[sync-vps-data] trades: dump_max_created=${DUMP_MAX_CREATED}"
  if [ -n "${DUMP_MAX_CREATED}" ] && [ "${MAX_CREATED}" != "EMPTY" ]; then
    DUMP_TS="$(to_epoch "${DUMP_MAX_CREATED}")"
    PREFLIGHT_TS="$(to_epoch "${MAX_CREATED}")"
    if [ "${DUMP_TS}" -gt 0 ] && [ "${PREFLIGHT_TS}" -gt 0 ] && [ "${DUMP_TS}" -ne "${PREFLIGHT_TS}" ]; then
      handle_stale_db "dump_max_created (${DUMP_MAX_CREATED}) != preflight max_created (${MAX_CREATED})"
    fi
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

echo "[sync-vps-data] trades: snapshot=${SNAPSHOT_FILE}"
echo "[sync-vps-data] trades: latest=${LATEST_FILE}"

fi  # /TRADES_SKIPPED

# ─── 4. Paper arm report (file-only, 항상 안전) ───
# Why: sync 와 같은 시점 데이터로 sub-arm 분리 통계 산출. Jupiter API 호출 0건.
# 실패해도 sync 자체는 OK 로 종료 (분석은 보조 단계).
if [ "$SKIP_PAPER_REPORT" != "true" ]; then
  echo "[sync-vps-data] paper-arm-report: generating from data/realtime/kol-paper-trades.jsonl"
  if (cd "${ROOT_DIR}" && npm run -s kol:paper-arm-report 2>&1 | tail -5); then
    echo "[sync-vps-data] paper-arm-report: ok → reports/kol-paper-arms-$(date +%Y-%m-%d).md"
  else
    echo "[sync-vps-data] paper-arm-report: WARN — generation failed (sync 자체는 정상)"
  fi
else
  echo "[sync-vps-data] paper-arm-report: SKIPPED (SKIP_PAPER_REPORT=true)"
fi

# ─── 5. Token quality report (file-only, dev candidate join) ───
# Why: sync 와 같은 시점의 token-quality-observations / paper / live / missed-alpha 를 join.
# dev-wallet 후보 JSON 은 운영 DB 가 아니라 paper-only label 이며, Jupiter / RPC 호출 0건.
# 실패해도 sync 자체는 OK 로 종료 (분석은 보조 단계).
if [ "$SKIP_TOKEN_QUALITY_REPORT" != "true" ]; then
  TOKEN_QUALITY_OUT="${ROOT_DIR}/reports/token-quality-$(date +%Y-%m-%d).md"
  echo "[sync-vps-data] token-quality-report: generating ${TOKEN_QUALITY_WINDOW_DAYS}d report"
  if (cd "${ROOT_DIR}" && npx ts-node scripts/token-quality-report.ts --window-days="${TOKEN_QUALITY_WINDOW_DAYS}" --output="${TOKEN_QUALITY_OUT}" 2>&1 | tail -8); then
    echo "[sync-vps-data] token-quality-report: ok → ${TOKEN_QUALITY_OUT}"
  else
    echo "[sync-vps-data] token-quality-report: WARN — generation failed (sync 자체는 정상)"
  fi
else
  echo "[sync-vps-data] token-quality-report: SKIPPED (SKIP_TOKEN_QUALITY_REPORT=true)"
fi

# ─── 6. KOL live canary report (file-only) ───
# Why: sync 직후 live canary wallet-truth / 5x / catastrophic / runner diagnostics 확인.
# DB 미사용, Jupiter/RPC 호출 0건.
if [ "$SKIP_LIVE_CANARY_REPORT" != "true" ]; then
  LIVE_CANARY_MD="${ROOT_DIR}/reports/kol-live-canary-$(date +%Y-%m-%d).md"
  LIVE_CANARY_JSON="${ROOT_DIR}/reports/kol-live-canary-$(date +%Y-%m-%d).json"
  echo "[sync-vps-data] live-canary-report: generating"
  if (cd "${ROOT_DIR}" && npm run -s kol:live-canary-report -- --ledger-dir data/realtime --md "${LIVE_CANARY_MD}" --json "${LIVE_CANARY_JSON}" 2>&1 | tail -8); then
    echo "[sync-vps-data] live-canary-report: ok → ${LIVE_CANARY_MD}"
  else
    echo "[sync-vps-data] live-canary-report: WARN — generation failed (sync 자체는 정상)"
  fi
else
  echo "[sync-vps-data] live-canary-report: SKIPPED (SKIP_LIVE_CANARY_REPORT=true)"
fi

# ─── 7. Trade markout report (file-only) ───
# Why: actual buy/sell/paper anchors 이후 T+30/60/300/1800 quote trajectory 를 sync 표준 산출물로 고정.
# DB 미사용, Jupiter/RPC 호출 0건. trade-markout runtime observer 가 남긴 파일만 읽는다.
if [ "$SKIP_TRADE_MARKOUT_REPORT" != "true" ]; then
  TRADE_MARKOUT_MD="${ROOT_DIR}/reports/trade-markout-$(date +%Y-%m-%d).md"
  TRADE_MARKOUT_JSON="${ROOT_DIR}/reports/trade-markout-$(date +%Y-%m-%d).json"
  echo "[sync-vps-data] trade-markout-report: generating since=${TRADE_MARKOUT_SINCE}"
  if (cd "${ROOT_DIR}" && npm run -s ops:trade-markout-audit -- --since "${TRADE_MARKOUT_SINCE}" --realtime-dir data/realtime --md "${TRADE_MARKOUT_MD}" --json "${TRADE_MARKOUT_JSON}" 2>&1 | tail -12); then
    echo "[sync-vps-data] trade-markout-report: ok → ${TRADE_MARKOUT_MD}"
  else
    echo "[sync-vps-data] trade-markout-report: WARN — generation failed (sync 자체는 정상)"
  fi
else
  echo "[sync-vps-data] trade-markout-report: SKIPPED (SKIP_TRADE_MARKOUT_REPORT=true)"
fi

# ─── 8. Winner-kill report (file-only) ───
# Why: missed-alpha close-site markout 으로 early cut 이 5x winner 를 죽이는지 추적.
# tail-retain / partial-take 측정 sprint 의 핵심 feedback.
if [ "$SKIP_WINNER_KILL_REPORT" != "true" ]; then
  WINNER_KILL_OUT="${ROOT_DIR}/reports/winner-kill-$(date +%Y-%m-%d).md"
  mkdir -p "$(dirname "${WINNER_KILL_OUT}")"
  echo "[sync-vps-data] winner-kill-report: generating ${WINNER_KILL_WINDOW_DAYS}d report"
  if (cd "${ROOT_DIR}" && npx ts-node scripts/winner-kill-analyzer.ts --window-days="${WINNER_KILL_WINDOW_DAYS}" > "${WINNER_KILL_OUT}"); then
    echo "[sync-vps-data] winner-kill-report: ok → ${WINNER_KILL_OUT}"
  else
    echo "[sync-vps-data] winner-kill-report: WARN — generation failed (sync 자체는 정상)"
  fi
else
  echo "[sync-vps-data] winner-kill-report: SKIPPED (SKIP_WINNER_KILL_REPORT=true)"
fi

# ─── 9. Sync health manifest (file-only) ───
if [ "$SKIP_SYNC_HEALTH" != "true" ]; then
  SYNC_HEALTH_OUT="${ROOT_DIR}/reports/sync-health-$(date +%Y-%m-%d).md"
  echo "[sync-vps-data] sync-health: generating"
  if write_sync_health_report "${SYNC_HEALTH_OUT}"; then
    echo "[sync-vps-data] sync-health: ok → ${SYNC_HEALTH_OUT}"
  else
    echo "[sync-vps-data] sync-health: WARN — generation failed (sync 자체는 정상)"
  fi
else
  echo "[sync-vps-data] sync-health: SKIPPED (SKIP_SYNC_HEALTH=true)"
fi

# ─── 10. Shadow eval (Jupiter API 호출, opt-in) ───
# Why: KOL signal 자체의 raw alpha (smart-v3 logic 무관) 측정 — Jupiter forward quote 사용.
# Phase 2 go/no-go 판정용. Jupiter quota 영향 있어 default OFF.
if [ "$RUN_SHADOW_EVAL" = "true" ]; then
  echo "[sync-vps-data] shadow-eval: running (Jupiter API 사용)"
  if (cd "${ROOT_DIR}" && npm run -s kol:shadow-eval 2>&1 | tail -10); then
    echo "[sync-vps-data] shadow-eval: ok"
  else
    echo "[sync-vps-data] shadow-eval: WARN — eval failed (sync 자체는 정상)"
  fi
else
  echo "[sync-vps-data] shadow-eval: SKIPPED (set RUN_SHADOW_EVAL=true to enable — Jupiter API)"
fi

echo "[sync-vps-data] done"
