#!/usr/bin/env bash
# 로컬에서 VPS 원클릭 배포
# Usage: bash scripts/deploy-remote.sh [--clean] [--sync-env] [--env-file=.env]
#   --clean: 크래시 잔해 정리 후 배포 (.tmp, runtime-diagnostics.json)
#   --sync-env: 로컬 env 파일의 key/value를 VPS .env에 병합한 뒤 배포한다. Git에는 올리지 않는다.
set -euo pipefail

# ─── VPS 접속 정보 (환경변수 또는 기본값) ───
VPS_HOST="${VPS_HOST:-root@your-vps-ip}"
VPS_PATH="${VPS_PATH:-/root/Solana/Solana-Trading/solana-momentum-bot}"
SYNC_ENV="${DEPLOY_SYNC_ENV:-false}"
ENV_SOURCE="${DEPLOY_ENV_SOURCE:-.env}"

CLEAN=false
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=true ;;
    --sync-env) SYNC_ENV=true ;;
    --env-file=*) ENV_SOURCE="${arg#*=}" ;;
  esac
done

echo "=== Remote Deploy ==="
echo "Host: $VPS_HOST"
echo "Path: $VPS_PATH"
echo "Sync env: $SYNC_ENV"
echo ""

# ─── 1. 로컬 상태 확인 ───
if ! git diff --quiet HEAD; then
  echo "WARNING: uncommitted changes exist locally. Push first."
  echo "  git add . && git commit && git push"
  exit 1
fi

LOCAL_HEAD=$(git rev-parse --short HEAD)
echo "Local HEAD: $LOCAL_HEAD"

# ─── 2. 크래시 잔해 정리 (--clean) ───
if [ "$CLEAN" = true ]; then
  echo ""
  echo "Cleaning crash artifacts on VPS..."
  ssh "$VPS_HOST" "cd $VPS_PATH && rm -f data/realtime/*.tmp && rm -f data/realtime/runtime-diagnostics.json && echo 'Cleaned .tmp + diagnostics'"
fi

# ─── 3. Optional .env sync (Git 추적 금지, SSH 전송만 허용) ───
if [ "$SYNC_ENV" = true ]; then
  if [ ! -f "$ENV_SOURCE" ]; then
    echo "ERROR: env source not found: $ENV_SOURCE"
    exit 1
  fi

  echo ""
  echo "Merging env file into VPS .env..."
  scp -q "$ENV_SOURCE" "$VPS_HOST:$VPS_PATH/.env.deploy-profile.tmp"
  ssh "$VPS_HOST" "cd $VPS_PATH && node" <<'NODE'
const fs = require('fs');

const targetPath = '.env';
const profilePath = '.env.deploy-profile.tmp';
const requiredSecrets = ['SOLANA_RPC_URL', 'WALLET_PRIVATE_KEY', 'DATABASE_URL'];

function readKeyValues(filePath) {
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=(.*)$/);
    if (!match) continue;
    values.set(match[1], match[2].trimEnd());
  }
  return values;
}

if (!fs.existsSync(profilePath) || fs.statSync(profilePath).size === 0) {
  throw new Error('Uploaded env profile is empty or missing');
}

const profile = readKeyValues(profilePath);
const originalText = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
const seen = new Set();
const mergedLines = originalText.split(/\r?\n/).map((line) => {
  const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/);
  if (!match || !profile.has(match[1])) return line;
  seen.add(match[1]);
  return `${match[1]}=${profile.get(match[1])}`;
});

for (const [key, value] of profile.entries()) {
  if (!seen.has(key)) mergedLines.push(`${key}=${value}`);
}

const mergedValues = new Map([...readKeyValues(targetPath), ...profile]);
const missingSecrets = requiredSecrets.filter((key) => {
  const value = (mergedValues.get(key) || '').trim();
  return !value || value === 'YOUR_KEY';
});

if (missingSecrets.length > 0) {
  fs.unlinkSync(profilePath);
  throw new Error(`Refusing to write .env: required runtime secrets missing after merge: ${missingSecrets.join(', ')}`);
}

if (fs.existsSync(targetPath)) {
  fs.copyFileSync(targetPath, `.env.backup-${Date.now()}`);
}
fs.writeFileSync(targetPath, `${mergedLines.join('\n').replace(/\n*$/, '')}\n`, { mode: 0o600 });
fs.unlinkSync(profilePath);
console.log('.env merged (secrets preserved, content hidden)');
NODE
fi

# ─── 4. VPS에서 deploy.sh 실행 (git pull + build + pm2 restart) ───
echo ""
echo "Running deploy on VPS..."
ssh -t "$VPS_HOST" "cd $VPS_PATH && bash scripts/deploy.sh"

echo ""
echo "=== Remote Deploy complete ==="
echo "Verify: ssh $VPS_HOST 'pm2 status && pm2 logs momentum-bot --lines 20'"
