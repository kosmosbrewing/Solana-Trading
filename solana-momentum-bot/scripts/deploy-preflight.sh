#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

fail=0

required_runtime_paths=(
  "src/orchestration/excursionTelemetry.ts"
  "scripts/kol-transfer-refresh.sh"
)

for path in "${required_runtime_paths[@]}"; do
  if [[ ! -e "${path}" ]]; then
    echo "[deploy-preflight] MISSING required runtime path: ${path}" >&2
    fail=1
    continue
  fi
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if ! git ls-files --error-unmatch "${path}" >/dev/null 2>&1; then
      echo "[deploy-preflight] UNTRACKED required runtime path: ${path}" >&2
      fail=1
    fi
  fi
done

node <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const missing = [];
for (const [name, command] of Object.entries(pkg.scripts || {})) {
  const matches = [...String(command).matchAll(/\b(?:bash|ts-node)\s+(scripts\/[^\s&|;]+)/g)];
  for (const match of matches) {
    const scriptPath = match[1];
    if (!fs.existsSync(scriptPath)) missing.push(`${name} -> ${scriptPath}`);
  }
}
if (missing.length > 0) {
  for (const item of missing) console.error(`[deploy-preflight] MISSING package script target: ${item}`);
  process.exit(1);
}
NODE

if [[ "${fail}" -ne 0 ]]; then
  exit 1
fi

npm run -s typecheck
npm run -s typecheck:scripts
npm run -s env:check

echo "[deploy-preflight] OK"
