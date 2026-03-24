#!/usr/bin/env bash
# momentum-bot + momentum-ops-bot 재기동 스크립트
# Why: 기존 PM2 정의를 재시작만 하면 ecosystem 변경이 반영되지 않을 수 있으므로
#      delete -> start 로 재생성한다.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

source ~/.profile 2>/dev/null || true

echo "=== Restart bot + ops ==="
echo "Directory: $APP_DIR"

command -v npm >/dev/null 2>&1 || { echo "ERROR: npm not found"; exit 1; }
command -v pm2 >/dev/null 2>&1 || { echo "ERROR: pm2 not found"; exit 1; }

mkdir -p logs

echo "Building TypeScript..."
npm run build

for APP in momentum-bot momentum-ops-bot; do
  echo "Recreating PM2 app: $APP"
  pm2 stop "$APP" 2>/dev/null || true
  pm2 delete "$APP" 2>/dev/null || true
done

echo "Starting PM2 apps from ecosystem..."
pm2 start ecosystem.config.cjs --only momentum-bot,momentum-ops-bot

echo
pm2 status

echo
echo "PM2 describe: momentum-bot"
pm2 describe momentum-bot

echo
echo "PM2 describe: momentum-ops-bot"
pm2 describe momentum-ops-bot

echo
echo "Done. Verify with:"
echo "  pm2 logs momentum-bot --lines 50"
echo "  pm2 logs momentum-ops-bot --lines 50"
