#!/usr/bin/env bash
# 운영 VPS 디스크 사용률이 높을 때 오래된 realtime session dataset을 정리한다.
#
# 기본 정책:
# - 파일시스템 사용률이 threshold 이상일 때만 동작
# - current-session.json 이 가리키는 활성 세션은 항상 보호
# - current-session.json 을 읽지 못하면 fail-closed로 종료
# - 최근 N개 세션 + 최근 X시간 세션은 보호
# - 가장 오래된 세션부터 삭제해서 target 이하로 내린다
# - 기본값은 dry-run, 실제 삭제는 --apply 필요
#
# Usage:
#   bash scripts/prune-realtime-sessions.sh
#   bash scripts/prune-realtime-sessions.sh --apply
#   bash scripts/prune-realtime-sessions.sh --apply --threshold 85 --target 80 --keep-recent 5 --keep-hours 48
#   REALTIME_DATA_DIR=/root/.../data/realtime bash scripts/prune-realtime-sessions.sh --apply

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

DATA_ROOT="${REALTIME_DATA_DIR:-${BOT_DIR}/data/realtime}"
SESSIONS_DIR="${DATA_ROOT}/sessions"
CURRENT_SESSION_JSON="${DATA_ROOT}/current-session.json"
LOG_FILE="${DATA_ROOT}/prune-sessions.log"

THRESHOLD_PCT=85
TARGET_PCT=80
KEEP_RECENT=5
KEEP_HOURS=48
APPLY=false
VERBOSE=false

usage() {
  cat <<EOF
Usage: bash scripts/prune-realtime-sessions.sh [options]

Options:
  --apply                 실제 삭제 수행 (기본: dry-run)
  --threshold <pct>       정리 시작 사용률 (기본: 85)
  --target <pct>          정리 종료 사용률 (기본: 80)
  --keep-recent <n>       최신 N개 세션 보호 (기본: 5)
  --keep-hours <hours>    최근 N시간 세션 보호 (기본: 48)
  --data-root <path>      realtime data root override
  --log-file <path>       로그 파일 경로 override
  --verbose               보호/삭제 판정 로그 출력
  -h, --help              도움말

Notes:
  - current-session.json 이 가리키는 활성 세션은 항상 보호한다.
  - current-session.json 을 읽지 못하거나 세션 경로가 없으면 아무것도 지우지 않고 종료한다.
  - runtime-diagnostics.json, raw-swaps.jsonl 등 root 파일은 건드리지 않는다.
  - 가장 오래된 세션부터 삭제해서 target 이하로 내린다.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=true
      shift
      ;;
    --threshold)
      THRESHOLD_PCT="${2:?missing value for --threshold}"
      shift 2
      ;;
    --target)
      TARGET_PCT="${2:?missing value for --target}"
      shift 2
      ;;
    --keep-recent)
      KEEP_RECENT="${2:?missing value for --keep-recent}"
      shift 2
      ;;
    --keep-hours)
      KEEP_HOURS="${2:?missing value for --keep-hours}"
      shift 2
      ;;
    --data-root)
      DATA_ROOT="${2:?missing value for --data-root}"
      SESSIONS_DIR="${DATA_ROOT}/sessions"
      CURRENT_SESSION_JSON="${DATA_ROOT}/current-session.json"
      shift 2
      ;;
    --log-file)
      LOG_FILE="${2:?missing value for --log-file}"
      shift 2
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[prune-sessions] unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! [[ "$THRESHOLD_PCT" =~ ^[0-9]+$ && "$TARGET_PCT" =~ ^[0-9]+$ && "$KEEP_RECENT" =~ ^[0-9]+$ && "$KEEP_HOURS" =~ ^[0-9]+$ ]]; then
  echo "[prune-sessions] numeric arguments must be integers" >&2
  exit 1
fi

if (( TARGET_PCT >= THRESHOLD_PCT )); then
  echo "[prune-sessions] --target must be lower than --threshold" >&2
  exit 1
fi

if [[ ! -d "$SESSIONS_DIR" ]]; then
  echo "[prune-sessions] sessions dir not found: $SESSIONS_DIR" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
  local msg="$1"
  echo "[prune-sessions] $msg"
  printf '%s %s\n' "$(timestamp)" "$msg" >> "$LOG_FILE"
}

current_usage_pct() {
  df -P "$DATA_ROOT" | awk 'NR==2 {gsub(/%/, "", $5); print $5}'
}

fs_total_kb() {
  df -Pk "$DATA_ROOT" | awk 'NR==2 {print $2}'
}

fs_used_kb() {
  df -Pk "$DATA_ROOT" | awk 'NR==2 {print $3}'
}

dir_size_kb() {
  du -sk "$1" | awk '{print $1}'
}

active_session_name() {
  if [[ ! -f "$CURRENT_SESSION_JSON" ]]; then
    echo "[prune-sessions] current-session.json not found: $CURRENT_SESSION_JSON" >&2
    return 1
  fi

  node --input-type=module <<'EOF'
import fs from 'fs';
import path from 'path';

const currentSessionPath = process.env.CURRENT_SESSION_JSON;
try {
  const raw = fs.readFileSync(currentSessionPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed?.datasetDir) {
    process.stdout.write(path.basename(parsed.datasetDir));
    process.exit(0);
  }
  process.stderr.write(`[prune-sessions] datasetDir missing in ${currentSessionPath}\n`);
  process.exit(1);
} catch {
  process.stderr.write(`[prune-sessions] failed to parse ${currentSessionPath}\n`);
  process.exit(1);
}
EOF
}

USAGE_BEFORE="$(current_usage_pct)"
ACTIVE_SESSION_NAME="$(CURRENT_SESSION_JSON="$CURRENT_SESSION_JSON" active_session_name)"

if [[ -z "$ACTIVE_SESSION_NAME" ]]; then
  echo "[prune-sessions] active session name is empty; aborting without deletion" >&2
  exit 1
fi

ACTIVE_SESSION_DIR="${SESSIONS_DIR}/${ACTIVE_SESSION_NAME}"
if [[ ! -d "$ACTIVE_SESSION_DIR" ]]; then
  echo "[prune-sessions] active session dir not found: $ACTIVE_SESSION_DIR" >&2
  exit 1
fi

log "start mode=$([ "$APPLY" = true ] && echo apply || echo dry-run) data_root=$DATA_ROOT usage=${USAGE_BEFORE}% threshold=${THRESHOLD_PCT}% target=${TARGET_PCT}% keep_recent=${KEEP_RECENT} keep_hours=${KEEP_HOURS}"

if (( USAGE_BEFORE < THRESHOLD_PCT )); then
  log "skip usage ${USAGE_BEFORE}% < threshold ${THRESHOLD_PCT}%"
  exit 0
fi

TMP_META="$(mktemp)"
trap 'rm -f "$TMP_META"' EXIT

SESSIONS_DIR="$SESSIONS_DIR" \
ACTIVE_SESSION_NAME="$ACTIVE_SESSION_NAME" \
KEEP_RECENT="$KEEP_RECENT" \
KEEP_HOURS="$KEEP_HOURS" \
VERBOSE="$VERBOSE" \
node --input-type=module > "$TMP_META" <<'EOF'
import fs from 'fs';
import path from 'path';

const sessionsDir = process.env.SESSIONS_DIR;
const activeSessionName = process.env.ACTIVE_SESSION_NAME || '';
const keepRecent = Number(process.env.KEEP_RECENT || '5');
const keepHours = Number(process.env.KEEP_HOURS || '48');
const verbose = process.env.VERBOSE === 'true';
const cutoffMs = Date.now() - keepHours * 60 * 60 * 1000;

const entries = fs.readdirSync(sessionsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const fullPath = path.join(sessionsDir, entry.name);
    const stat = fs.statSync(fullPath);
    return {
      name: entry.name,
      fullPath,
      mtimeMs: stat.mtimeMs,
      sizeBytes: 0,
      protectReasons: [],
    };
  })
  .sort((a, b) => b.mtimeMs - a.mtimeMs);

for (let i = 0; i < entries.length; i += 1) {
  const item = entries[i];
  if (i < keepRecent) item.protectReasons.push('recent_rank');
  if (item.mtimeMs >= cutoffMs) item.protectReasons.push('recent_time');
  if (item.name === activeSessionName) item.protectReasons.push('active_session');
}

const postOrder = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs);
for (const item of postOrder) {
  const row = {
    name: item.name,
    fullPath: item.fullPath,
    mtimeMs: item.mtimeMs,
    protected: item.protectReasons.length > 0,
    protectReasons: item.protectReasons.join(','),
  };
  if (verbose || !row.protected) {
    process.stdout.write(JSON.stringify(row) + '\n');
  }
}
EOF

deleted_count=0
deleted_bytes=0
fs_total_kb_value="$(fs_total_kb)"
fs_used_kb_value="$(fs_used_kb)"
simulated_freed_kb=0

while IFS= read -r line; do
  [[ -z "$line" ]] && continue

  name="$(node --input-type=module -e "const row = JSON.parse(process.argv[1]); process.stdout.write(row.name);" "$line")"
  full_path="$(node --input-type=module -e "const row = JSON.parse(process.argv[1]); process.stdout.write(row.fullPath);" "$line")"
  protected="$(node --input-type=module -e "const row = JSON.parse(process.argv[1]); process.stdout.write(String(row.protected));" "$line")"
  reasons="$(node --input-type=module -e "const row = JSON.parse(process.argv[1]); process.stdout.write(row.protectReasons || '');" "$line")"

  if [[ "$protected" = "true" ]]; then
    if [[ "$VERBOSE" = true ]]; then
      log "protect session=${name} reasons=${reasons}"
    fi
    continue
  fi

  if [[ "$APPLY" = true ]]; then
    usage_now="$(current_usage_pct)"
  else
    usage_now="$(( ( (fs_used_kb_value - simulated_freed_kb) * 100 + fs_total_kb_value - 1 ) / fs_total_kb_value ))"
  fi

  if (( usage_now <= TARGET_PCT )); then
    break
  fi

  size_kb="$(dir_size_kb "$full_path")"
  size_bytes=$((size_kb * 1024))
  size_human="$(du -sh "$full_path" | awk '{print $1}')"

  if [[ "$APPLY" = true ]]; then
    rm -rf "$full_path"
    log "deleted session=${name} size=${size_human} usage_before=${usage_now}%"
  else
    log "dry-run delete session=${name} size=${size_human} usage_before=${usage_now}%"
    simulated_freed_kb=$((simulated_freed_kb + size_kb))
  fi

  deleted_count=$((deleted_count + 1))
  deleted_bytes=$((deleted_bytes + size_bytes))
done < "$TMP_META"

USAGE_AFTER="$(current_usage_pct)"
DELETED_HUMAN="$(numfmt --to=iec-i --suffix=B "$deleted_bytes" 2>/dev/null || echo "${deleted_bytes}B")"

log "done deleted_count=${deleted_count} deleted_bytes=${DELETED_HUMAN} usage_before=${USAGE_BEFORE}% usage_after=${USAGE_AFTER}%"

if [[ "$APPLY" = false ]]; then
  log "dry-run only: re-run with --apply to delete old sessions"
fi
