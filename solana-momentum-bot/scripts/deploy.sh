#!/usr/bin/env bash
# VPS Paper Trading 배포 스크립트
# Usage: bash scripts/deploy.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "=== Solana Momentum Bot — Deploy ==="
echo "Directory: $APP_DIR"

# ─── 1. Prerequisites check ───
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found. Install Node.js >= 20."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "ERROR: npm not found."; exit 1; }
command -v pm2 >/dev/null 2>&1 || { echo "pm2 not found. Installing globally..."; npm install -g pm2; }

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 20 ]; then
  echo "ERROR: Node.js >= 20 required (found v$NODE_VER)."
  exit 1
fi

# ─── 2. .env check ───
if [ ! -f .env ]; then
  echo "ERROR: .env file not found. Copy .env.example and fill in values."
  echo "  cp .env.example .env"
  exit 1
fi

# 필수 키 확인
for KEY in SOLANA_RPC_URL WALLET_PRIVATE_KEY BIRDEYE_API_KEY DATABASE_URL; do
  VAL=$(grep "^${KEY}=" .env | cut -d= -f2-)
  if [ -z "$VAL" ] || [ "$VAL" = "YOUR_KEY" ]; then
    echo "ERROR: $KEY is not set in .env"
    exit 1
  fi
done

TRADING_MODE=$(grep "^TRADING_MODE=" .env | cut -d= -f2- | tr -d ' ')
echo "Trading mode: ${TRADING_MODE:-paper}"

# ─── 3. Install dependencies ───
echo "Installing dependencies..."
npm ci --production=false 2>&1 | tail -3

# ─── 4. Build ───
echo "Building TypeScript..."
npm run build

# ─── 5. DB Migration ───
echo "Running database migration..."
npx ts-node scripts/migrate.ts

# ─── 6. Create logs directory ───
mkdir -p logs

# ─── 7. pm2 deploy ───
echo "Starting with pm2..."
pm2 stop momentum-bot 2>/dev/null || true
pm2 delete momentum-bot 2>/dev/null || true
pm2 start ecosystem.config.cjs

# pm2 startup (persist across reboots)
echo ""
echo "To persist across reboots, run:"
echo "  pm2 save"
echo "  pm2 startup"

echo ""
echo "=== Deploy complete ==="
echo "Commands:"
echo "  pm2 status              # process status"
echo "  pm2 logs momentum-bot   # tail logs"
echo "  pm2 monit               # real-time monitor"
echo "  pm2 restart momentum-bot # restart"
echo "  pm2 stop momentum-bot   # stop"
