#!/usr/bin/env bash
# cron-backtest.sh
#
# 6시간 간격 cron — data/realtime-swaps/ 수집 데이터로 파라미터 그리드 전수 탐색
# 결과: results/cron-backtest-{YYYY-MM-DD_HH-MM}.json
#
# 파라미터 추가: 아래 축 배열에 값을 추가하면 자동으로 조합이 생성됩니다.
#   VMS  × CBS  × BLS  × CCPS = 총 세트 수
#   4    × 3    × 3    × 3    = 108 세트 (기본값)
#
# crontab 등록:
#   0 */6 * * * /root/Solana/Solana-Trading/solana-momentum-bot/scripts/cron-backtest.sh >> /root/Solana/Solana-Trading/solana-momentum-bot/logs/cron-backtest.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "$BOT_DIR"

# ── 파라미터 축 정의 ──────────────────────────────────────────────────────────
#  여기에 값을 추가하면 조합이 자동으로 늘어납니다.

VMS=(2.0 2.5 3.0 3.5)       # volumeSurgeMultiplier — 볼륨 급등 배율
CBS=(1 2 3)                  # confirmMinBars        — 확인 봉 수
BLS=(5 10 20)                # priceBreakoutLookback — 신고가 기준 봉 수 (짧을수록 완화)
CCPS=(0.005 0.010 0.020)     # confirmMinPriceChangePct — 확인봉 가격 변화 최소치

# 병렬 실행 상한 — VPS 부하에 따라 조정 (권장: CPU코어 수 이하)
PARALLEL_LIMIT=4

# ─────────────────────────────────────────────────────────────────────────────

DATE=$(date -u +%Y-%m-%d_%H-%M)
SWAPS_DIR="${BOT_DIR}/data/realtime-swaps"
RESULTS_DIR="${BOT_DIR}/results"
TMP_DIR="/tmp/cron-backtest-$$"
OUTPUT_FILE="${RESULTS_DIR}/cron-backtest-${DATE}.json"

echo "[cron-backtest] === Start: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

TOTAL=$(( ${#VMS[@]} * ${#CBS[@]} * ${#BLS[@]} * ${#CCPS[@]} ))
echo "[cron-backtest] Grid: vm=${#VMS[@]} × cb=${#CBS[@]} × bl=${#BLS[@]} × ccp=${#CCPS[@]} = ${TOTAL} sets (parallel=${PARALLEL_LIMIT})"

mkdir -p "$RESULTS_DIR" "$TMP_DIR"

# ── 1. 풀별 raw-swaps.jsonl 병합 ──────────────────────────────────────────────
echo "[cron-backtest] Merging swap data from ${SWAPS_DIR}..."

POOL_COUNT=0
if [ -d "$SWAPS_DIR" ]; then
  for pool_dir in "${SWAPS_DIR}"/*/; do
    swap_file="${pool_dir}raw-swaps.jsonl"
    if [ -f "$swap_file" ]; then
      POOL_COUNT=$((POOL_COUNT + 1))
      cat "$swap_file" >> "${TMP_DIR}/raw-swaps.jsonl"
    fi
  done
fi

SWAP_COUNT=0
if [ -f "${TMP_DIR}/raw-swaps.jsonl" ]; then
  SWAP_COUNT=$(wc -l < "${TMP_DIR}/raw-swaps.jsonl")
fi

if [ "$SWAP_COUNT" -eq 0 ]; then
  echo "[cron-backtest] No swap data found in ${SWAPS_DIR}. Exiting."
  rm -rf "$TMP_DIR"
  exit 0
fi

echo "[cron-backtest] Merged ${SWAP_COUNT} swap lines from ${POOL_COUNT} pools"

# ── 2. 파라미터 그리드 실행 ───────────────────────────────────────────────────

run_set() {
  local vm="$1" cb="$2" bl="$3" ccp="$4"
  # 파일명으로 쓸 수 있는 레이블 생성
  local label="vm${vm}_cb${cb}_bl${bl}_ccp${ccp}"
  local out_file="${TMP_DIR}/set-${label}.json"

  if npx ts-node scripts/micro-backtest.ts \
      --dataset "${TMP_DIR}" \
      --volume-multiplier "${vm}" \
      --confirm-bars "${cb}" \
      --breakout-lookback "${bl}" \
      --confirm-change-pct "${ccp}" \
      --json \
      > "$out_file" 2>/dev/null; then
    # 신호가 있으면 표시
    local sigs
    sigs=$(node -e "try{const r=JSON.parse(require('fs').readFileSync('${out_file}','utf8'));process.stdout.write(String(r.summary?.totalSignals??0))}catch{process.stdout.write('?')}" 2>/dev/null || echo "?")
    if [ "$sigs" != "0" ] && [ "$sigs" != "?" ]; then
      echo "[cron-backtest] ${label}  signals=${sigs} ★"
    fi
  else
    echo "{\"error\":\"backtest_failed\",\"params\":{\"vm\":${vm},\"cb\":${cb},\"bl\":${bl},\"ccp\":${ccp}}}" > "$out_file"
  fi
}

# 카르테시안 곱 생성 및 병렬 실행
SET_COUNT=0
for vm in "${VMS[@]}"; do
  for cb in "${CBS[@]}"; do
    for bl in "${BLS[@]}"; do
      for ccp in "${CCPS[@]}"; do
        # PARALLEL_LIMIT 초과 시 빈 슬롯 대기
        while [ "$(jobs -rp | wc -l)" -ge "$PARALLEL_LIMIT" ]; do
          sleep 0.2
        done
        run_set "$vm" "$cb" "$bl" "$ccp" &
        SET_COUNT=$((SET_COUNT + 1))
      done
    done
  done
done
wait

echo "[cron-backtest] All ${SET_COUNT} sets complete"

# ── 3. 결과 병합 및 저장 ──────────────────────────────────────────────────────
echo "[cron-backtest] Combining results..."

node -e "
const fs   = require('fs');
const path = require('path');

const tmpDir    = process.argv[1];
const runAt     = process.argv[2];
const swapCount = parseInt(process.argv[3], 10);

// set-*.json 파일 전체 읽기
const files = fs.readdirSync(tmpDir)
  .filter(f => f.startsWith('set-') && f.endsWith('.json'))
  .sort();

const sets = [];

for (const file of files) {
  const label = file.replace(/^set-/, '').replace(/\.json$/, '');
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(tmpDir, file), 'utf8')); }
  catch { data = { error: 'parse_failed' }; }

  const cfg  = data.config?.triggerConfig ?? data.params ?? {};
  const summ = data.summary ?? {};
  const rs   = data.rejectStats ?? {};

  sets.push({
    label,
    params: {
      vm:  cfg.volumeSurgeMultiplier  ?? null,
      cb:  cfg.confirmMinBars         ?? null,
      bl:  cfg.priceBreakoutLookback  ?? null,
      ccp: cfg.confirmMinPriceChangePct ?? null,
    },
    summary: {
      totalSignals:         summ.totalSignals         ?? 0,
      edgeScore:            summ.edgeScore            ?? 0,
      avgAdjustedReturnPct: summ.avgAdjustedReturnPct ?? 0,
      stageDecision:        summ.stageDecision        ?? 'n/a',
    },
    rejectStats: rs,
    error: data.error ?? null,
  });
}

// edgeScore + signals 기준 정렬
const ranked = [...sets].sort((a, b) => {
  if (b.summary.totalSignals !== a.summary.totalSignals)
    return b.summary.totalSignals - a.summary.totalSignals;
  return b.summary.edgeScore - a.summary.edgeScore;
});

const withSignals = sets.filter(s => s.summary.totalSignals > 0).length;

const output = {
  runAt,
  swapCount,
  grid: {
    total:       sets.length,
    withSignals,
    top10:       ranked.slice(0, 10).map(s => s.label),
  },
  ranked,
};

process.stdout.write(JSON.stringify(output, null, 2) + '\n');
" "$TMP_DIR" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SWAP_COUNT" > "$OUTPUT_FILE"

rm -rf "$TMP_DIR"

echo "[cron-backtest] Saved: ${OUTPUT_FILE}"

# ── 4. 텔레그램 알림 — 상위 10개만 표시 ──────────────────────────────────────
source ~/.profile 2>/dev/null || true
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-${BOT_TOKEN:-}}"
CHAT_ID="${TELEGRAM_CHAT_ID:-${CHAT_ID:-}}"

if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
  echo "[cron-backtest] Sending Telegram summary..."
  node -e "
const fs    = require('fs');
const https = require('https');

const result   = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const botToken = process.argv[2];
const chatId   = process.argv[3];

const g = result.grid ?? {};

function fmt(v, d) {
  if (v == null || isNaN(v)) return 'n/a';
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(d ?? 2) + '%';
}
function fmtN(v, d) {
  if (v == null || isNaN(v)) return 'n/a';
  return Number(v).toFixed(d ?? 1);
}

const top = (result.ranked ?? []).slice(0, 10);
const hasSignals = top.filter(s => s.summary.totalSignals > 0);

let rows;
if (hasSignals.length > 0) {
  rows = top.map((s, i) => {
    const p  = s.params ?? {};
    const sm = s.summary;
    const rs = s.rejectStats;
    const mark = i === 0 ? ' ★' : '';

    const paramStr = 'vm=' + (p.vm ?? '?') +
      ' cb=' + (p.cb ?? '?') +
      ' bl=' + (p.bl ?? '?') +
      ' ccp=' + (p.ccp != null ? (p.ccp * 100).toFixed(1) + '%' : '?');

    return [
      '<b>#' + (i+1) + mark + '</b> ' + paramStr,
      '  signals=' + sm.totalSignals +
        ' edge=' + fmtN(sm.edgeScore) +
        ' adj=' + fmt(sm.avgAdjustedReturnPct) +
        ' (' + sm.stageDecision + ')',
    ].join('\n');
  }).join('\n');
} else {
  // 전체 신호 0 → 병목 집계 표시
  const bottlenecks = { volumeInsufficient: 0, noBreakout: 0, confirmFail: 0, cooldown: 0, evaluations: 0 };
  for (const s of result.ranked ?? []) {
    const rs = s.rejectStats ?? {};
    bottlenecks.evaluations      += rs.evaluations      ?? 0;
    bottlenecks.volumeInsufficient += rs.volumeInsufficient ?? 0;
    bottlenecks.noBreakout       += rs.noBreakout       ?? 0;
    bottlenecks.confirmFail      += rs.confirmFail      ?? 0;
    bottlenecks.cooldown         += rs.cooldown         ?? 0;
  }
  const e = bottlenecks.evaluations || 1;
  rows = '⚠️ 전체 세트 signals=0\n' +
    '총 평가: ' + bottlenecks.evaluations + '\n' +
    '  vol_insuf  : ' + bottlenecks.volumeInsufficient + ' (' + (bottlenecks.volumeInsufficient/e*100).toFixed(1) + '%)\n' +
    '  no_breakout: ' + bottlenecks.noBreakout + ' (' + (bottlenecks.noBreakout/e*100).toFixed(1) + '%)\n' +
    '  confirm    : ' + bottlenecks.confirmFail + ' (' + (bottlenecks.confirmFail/e*100).toFixed(1) + '%)';
}

const msg = [
  '📊 <b>Cron Backtest 결과</b>',
  'swaps=' + result.swapCount +
    ' | ' + (result.runAt ?? '').slice(0,16).replace('T',' ') + ' UTC',
  'sets=' + (g.total ?? 0) + ' | 신호있음=' + (g.withSignals ?? 0),
  '',
  rows,
  '',
  '파일: ' + process.argv[1].split('/').pop(),
].join('\n');

const body = JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' });
const req = https.request({
  hostname: 'api.telegram.org',
  path: '/bot' + botToken + '/sendMessage',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
}, (r) => { r.resume(); if (r.statusCode !== 200) process.stderr.write('Telegram HTTP ' + r.statusCode + '\n'); });
req.on('error', (e) => process.stderr.write('Telegram error: ' + e.message + '\n'));
req.write(body);
req.end();
" "$OUTPUT_FILE" "$BOT_TOKEN" "$CHAT_ID" || echo "[cron-backtest] Telegram send failed (non-fatal)"
else
  echo "[cron-backtest] Telegram skipped — BOT_TOKEN or CHAT_ID not set"
fi

echo "[cron-backtest] === Done: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
