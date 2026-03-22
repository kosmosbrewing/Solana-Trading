#!/usr/bin/env bash
# cron-backtest.sh
#
# 6시간 간격 cron으로 실행 — data/realtime-swaps/ 수집 데이터로 4-set micro-backtest 실행
# 결과: results/cron-backtest-{YYYY-MM-DD_HH-MM}.json
#
# crontab 등록:
#   0 */6 * * * /root/Solana/Solana-Trading/solana-momentum-bot/scripts/cron-backtest.sh >> /root/Solana/Solana-Trading/solana-momentum-bot/logs/cron-backtest.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "$BOT_DIR"

DATE=$(date -u +%Y-%m-%d_%H-%M)
SWAPS_DIR="${BOT_DIR}/data/realtime-swaps"
RESULTS_DIR="${BOT_DIR}/results"
TMP_DIR="/tmp/cron-backtest-$$"
OUTPUT_FILE="${RESULTS_DIR}/cron-backtest-${DATE}.json"

echo "[cron-backtest] === Start: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

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

# ── 2. 파라미터 4세트 micro-backtest 실행 ────────────────────────────────────

run_set() {
  local label="$1"
  local vol_mult="$2"
  local confirm_bars="$3"
  local out_file="${TMP_DIR}/set-${label}.json"

  echo "[cron-backtest] Running Set ${label} (volumeMultiplier=${vol_mult}, confirmBars=${confirm_bars})..."

  if npx ts-node scripts/micro-backtest.ts \
      --dataset "${TMP_DIR}" \
      --volume-multiplier "${vol_mult}" \
      --confirm-bars "${confirm_bars}" \
      --json \
      > "$out_file" 2>/dev/null; then
    echo "[cron-backtest] Set ${label} done"
  else
    echo "[cron-backtest] Set ${label} failed — writing empty result"
    echo '{"error":"backtest_failed"}' > "$out_file"
  fi
}

run_set "A" 2.5 3 &
run_set "B" 3.0 3 &
run_set "C" 2.5 2 &
run_set "D" 3.5 4 &
wait

# ── 3. 결과 병합 및 저장 ──────────────────────────────────────────────────────
echo "[cron-backtest] Combining results..."

node -e "
const fs = require('fs');

function safeRead(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return { error: 'parse_failed' }; }
}

const tmpDir = process.argv[1];
const runAt  = process.argv[2];
const swapCount = parseInt(process.argv[3], 10);

const resultA = safeRead(tmpDir + '/set-A.json');
const resultB = safeRead(tmpDir + '/set-B.json');
const resultC = safeRead(tmpDir + '/set-C.json');
const resultD = safeRead(tmpDir + '/set-D.json');

function extractSummary(r) {
  if (!r || r.error) return r;
  return r.summary ?? r;
}

const output = {
  runAt,
  swapCount,
  paramSets: {
    A: { volumeMultiplier: 2.5, confirmBars: 3 },
    B: { volumeMultiplier: 3.0, confirmBars: 3 },
    C: { volumeMultiplier: 2.5, confirmBars: 2 },
    D: { volumeMultiplier: 3.5, confirmBars: 4 },
  },
  results: {
    A: extractSummary(resultA),
    B: extractSummary(resultB),
    C: extractSummary(resultC),
    D: extractSummary(resultD),
  },
  raw: { A: resultA, B: resultB, C: resultC, D: resultD },
};

process.stdout.write(JSON.stringify(output, null, 2) + '\n');
" "$TMP_DIR" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SWAP_COUNT" > "$OUTPUT_FILE"

rm -rf "$TMP_DIR"

echo "[cron-backtest] Saved: ${OUTPUT_FILE}"

# ── 4. 텔레그램 알림 ─────────────────────────────────────────────────────────
# TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 가 .env에 있으면 전송
source ~/.profile 2>/dev/null || true
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-${BOT_TOKEN:-}}"
CHAT_ID="${TELEGRAM_CHAT_ID:-${CHAT_ID:-}}"

if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
  echo "[cron-backtest] Sending Telegram summary..."
  node -e "
const fs = require('fs');
const https = require('https');

const result = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const botToken = process.argv[2];
const chatId = process.argv[3];

function fmt(v, digits) {
  if (v == null || isNaN(v)) return 'n/a';
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(digits ?? 2) + '%';
}
function fmtN(v, digits) {
  if (v == null || isNaN(v)) return 'n/a';
  return Number(v).toFixed(digits ?? 1);
}

const sets = ['A', 'B', 'C', 'D'];
const params = result.paramSets;
const res = result.results;

let best = null;
let bestScore = -Infinity;
for (const s of sets) {
  const score = res[s]?.edgeScore ?? -Infinity;
  if (score > bestScore) { bestScore = score; best = s; }
}

const rows = sets.map(s => {
  const p = params[s];
  const r = res[s] ?? {};
  const mark = s === best ? ' ★' : '';
  return [
    \`<b>Set \${s}\${mark}</b> vm=\${p.volumeMultiplier} cb=\${p.confirmBars}\`,
    \`  signals=\${r.totalSignals ?? 'n/a'} edge=\${fmtN(r.edgeScore)} adj=\${fmt(r.avgAdjustedReturnPct)}\`,
  ].join('\n');
}).join('\n');

const msg = [
  '📊 <b>Cron Backtest 결과</b>',
  \`swaps=\${result.swapCount} | \${result.runAt?.slice(0,16).replace('T',' ')} UTC\`,
  '',
  rows,
  '',
  \`파일: \${process.argv[1].split('/').pop()}\`,
].join('\n');

const body = JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' });
const req = https.request({
  hostname: 'api.telegram.org',
  path: '/bot' + botToken + '/sendMessage',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
}, (res) => {
  res.resume();
  if (res.statusCode !== 200) process.stderr.write('Telegram HTTP ' + res.statusCode + '\n');
});
req.on('error', (e) => process.stderr.write('Telegram error: ' + e.message + '\n'));
req.write(body);
req.end();
" "$OUTPUT_FILE" "$BOT_TOKEN" "$CHAT_ID" || echo "[cron-backtest] Telegram send failed (non-fatal)"
else
  echo "[cron-backtest] Telegram skipped — BOT_TOKEN or CHAT_ID not set"
fi

echo "[cron-backtest] === Done: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
