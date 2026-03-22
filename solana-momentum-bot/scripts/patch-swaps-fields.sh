#!/usr/bin/env bash
# patch-swaps-fields.sh
#
# 기존 helius-collector 수집 데이터에 pairAddress/poolAddress 필드 추가
# isStoredRealtimeSwap guard 호환을 위해 필요
#
# Usage:
#   bash scripts/patch-swaps-fields.sh
#   bash scripts/patch-swaps-fields.sh --dry-run   # 실제 변경 없이 확인만

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SWAPS_DIR="${BOT_DIR}/data/realtime-swaps"
DRY_RUN=false

for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && DRY_RUN=true
done

echo "[patch-swaps] SWAPS_DIR: ${SWAPS_DIR}"
echo "[patch-swaps] dry-run: ${DRY_RUN}"

if [ ! -d "$SWAPS_DIR" ]; then
  echo "[patch-swaps] ERROR: ${SWAPS_DIR} not found"
  exit 1
fi

node --input-type=module <<EOF
import fs from 'fs';
import path from 'path';

const swapsDir = '${SWAPS_DIR}';
const dryRun   = ${DRY_RUN};

let totalLines = 0, fixedLines = 0, poolCount = 0;

for (const pool of fs.readdirSync(swapsDir)) {
  const file = path.join(swapsDir, pool, 'raw-swaps.jsonl');
  if (!fs.existsSync(file)) continue;

  const lines   = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let poolFixed = 0;

  const patched = lines.map(line => {
    try {
      const row = JSON.parse(line);
      totalLines++;
      if (typeof row.pairAddress !== 'string' || typeof row.poolAddress !== 'string') {
        const addr = typeof row.pool === 'string' ? row.pool : pool;
        row.pairAddress = addr;
        row.poolAddress = addr;
        fixedLines++;
        poolFixed++;
      }
      return JSON.stringify(row);
    } catch {
      return line;
    }
  });

  if (poolFixed > 0) {
    console.log('[patch-swaps] ' + pool.slice(0, 8) + '...  fixed=' + poolFixed + '/' + lines.length);
    if (!dryRun) {
      fs.writeFileSync(file, patched.join('\n') + '\n', 'utf8');
    }
  }
  poolCount++;
}

console.log('[patch-swaps] === done: pools=' + poolCount + ' total=' + totalLines + ' fixed=' + fixedLines + (dryRun ? ' (DRY RUN)' : '') + ' ===');
EOF
