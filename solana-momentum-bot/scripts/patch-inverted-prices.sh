#!/usr/bin/env bash
# patch-inverted-prices.sh
#
# generic log parser 버그로 역전 저장된 priceNative 수정
#   - 대상: source='logs' AND amountQuote > amountBase
#          (밈코인: 항상 token >> SOL, 역전 시 amountQuote(토큰) > amountBase(SOL))
#   - 수정: amountBase <-> amountQuote 교환, priceNative = amountQuote_new / amountBase_new
#
# Usage:
#   bash scripts/patch-inverted-prices.sh              # realtime-swaps + realtime-sessions
#   bash scripts/patch-inverted-prices.sh --dry-run    # 실제 변경 없이 카운트만
#   bash scripts/patch-inverted-prices.sh --swaps-only
#   bash scripts/patch-inverted-prices.sh --sessions-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

DRY_RUN=false
TARGET="both"

for arg in "$@"; do
  [ "$arg" = "--dry-run" ]       && DRY_RUN=true
  [ "$arg" = "--swaps-only" ]    && TARGET="swaps"
  [ "$arg" = "--sessions-only" ] && TARGET="sessions"
done

echo "[patch-inv] dry-run=${DRY_RUN}  target=${TARGET}"

node --input-type=module << JSEOF
import fs   from 'fs';
import path from 'path';

const botDir = '${BOT_DIR}';
const dryRun = ${DRY_RUN};
const target = '${TARGET}';

const files = [];

if (target === 'both' || target === 'swaps') {
  const swapsDir = path.join(botDir, 'data', 'realtime-swaps');
  if (fs.existsSync(swapsDir)) {
    for (const pool of fs.readdirSync(swapsDir)) {
      const f = path.join(swapsDir, pool, 'raw-swaps.jsonl');
      if (fs.existsSync(f)) files.push(f);
    }
  }
}

if (target === 'both' || target === 'sessions') {
  const sessDir = path.join(botDir, 'data', 'realtime-sessions');
  if (fs.existsSync(sessDir)) {
    for (const sess of fs.readdirSync(sessDir)) {
      const f = path.join(sessDir, sess, 'raw-swaps.jsonl');
      if (fs.existsSync(f)) files.push(f);
    }
  }
}

let totalLines = 0, fixedLines = 0, skippedLines = 0;

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let fileFixed = 0;

  const patched = lines.map(line => {
    let row;
    try { row = JSON.parse(line); }
    catch { skippedLines++; return line; }

    totalLines++;

    const src   = row.source;
    const base  = typeof row.amountBase  === 'number' ? row.amountBase  : null;
    const quote = typeof row.amountQuote === 'number' ? row.amountQuote : null;

    // Why: source='logs' 경로의 generic parser만 역전 가능.
    // 밈코인은 token qty >> SOL qty 이므로 amountQuote > amountBase 이면 반드시 역전.
    // (1000x 임계값은 너무 보수적 — ratio가 100~999x인 케이스를 놓침)
    if (src === 'logs' && base != null && quote != null && base > 0 && quote > base) {
      row.amountBase  = quote;
      row.amountQuote = base;
      row.priceNative = base / quote;
      fixedLines++;
      fileFixed++;
    }

    return JSON.stringify(row);
  });

  if (fileFixed > 0) {
    const rel = file.replace(botDir + '/', '');
    console.log('[patch-inv] ' + rel + '  fixed=' + fileFixed + '/' + lines.length);
    if (!dryRun) {
      fs.writeFileSync(file + '.bak', fs.readFileSync(file));
      fs.writeFileSync(file, patched.join('\n') + '\n', 'utf8');
    }
  }
}

const tag = dryRun ? ' (DRY RUN)' : '';
console.log(
  '[patch-inv] === done: files=' + files.length +
  ' total=' + totalLines +
  ' fixed=' + fixedLines +
  ' skipped=' + skippedLines + tag + ' ==='
);
if (fixedLines > 0 && !dryRun) {
  console.log('[patch-inv] backup: *.bak -- 확인 후 rm data/**/*.bak');
}
JSEOF
