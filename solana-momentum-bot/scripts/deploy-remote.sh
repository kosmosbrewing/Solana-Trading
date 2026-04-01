#!/usr/bin/env bash
# 로컬에서 VPS 원클릭 배포
# Usage: bash scripts/deploy-remote.sh [--clean]
#   --clean: 크래시 잔해 정리 후 배포 (.tmp, runtime-diagnostics.json)
set -euo pipefail

# ─── VPS 접속 정보 (환경변수 또는 기본값) ───
VPS_HOST="${VPS_HOST:-root@your-vps-ip}"
VPS_PATH="${VPS_PATH:-/root/Solana/Solana-Trading/solana-momentum-bot}"

CLEAN=false
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=true ;;
  esac
done

echo "=== Remote Deploy ==="
echo "Host: $VPS_HOST"
echo "Path: $VPS_PATH"
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

# ─── 3. VPS에서 deploy.sh 실행 (git pull 포함) ───
echo ""
echo "Running deploy on VPS..."
ssh -t "$VPS_HOST" "cd $VPS_PATH && bash scripts/deploy.sh"

echo ""
echo "=== Remote Deploy complete ==="
echo "Verify: ssh $VPS_HOST 'pm2 status && pm2 logs --lines 20'"
