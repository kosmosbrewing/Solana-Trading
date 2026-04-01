#!/usr/bin/env bash
# VPS Runtime 배포 스크립트
# Usage: bash scripts/deploy.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "=== Solana Momentum Bot — Deploy ==="
echo "Directory: $APP_DIR"

# ─── 1. Git pull (최신 코드 반영) ───
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Pulling latest changes..."
  git fetch origin main
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse origin/main)
  if [ "$LOCAL" != "$REMOTE" ]; then
    git pull origin main --ff-only || { echo "ERROR: git pull failed (non-fast-forward). 수동 확인 필요."; exit 1; }
    echo "Updated: $(git log --oneline -1)"
  else
    echo "Already up to date: $(git log --oneline -1)"
  fi
fi

# ─── 2. Prerequisites check ───
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found. Install Node.js >= 20."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "ERROR: npm not found."; exit 1; }
command -v pm2 >/dev/null 2>&1 || { echo "pm2 not found. Installing globally..."; npm install -g pm2; }

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 20 ]; then
  echo "ERROR: Node.js >= 20 required (found v$NODE_VER)."
  exit 1
fi

# ─── 3. .env check ───
if [ ! -f .env ]; then
  echo "ERROR: .env file not found. Copy .env.example and fill in values."
  echo "  cp .env.example .env"
  exit 1
fi

# Runtime profile
VPS_APP_PROFILE=$(grep "^VPS_APP_PROFILE=" .env | cut -d= -f2- | tr -d ' ' || true)
REALTIME_ENABLED=$(grep "^REALTIME_ENABLED=" .env | cut -d= -f2- | tr -d ' ' || true)

if [ -z "${VPS_APP_PROFILE:-}" ]; then
  if [ "${REALTIME_ENABLED:-false}" = "true" ]; then
    VPS_APP_PROFILE="shadow"
  else
    VPS_APP_PROFILE="bot"
  fi
fi

case "$VPS_APP_PROFILE" in
  bot|shadow|both) ;;
  *)
    echo "ERROR: VPS_APP_PROFILE must be one of: bot, shadow, both"
    exit 1
    ;;
esac

echo "VPS app profile: $VPS_APP_PROFILE"

# 필수 키 확인
for KEY in SOLANA_RPC_URL WALLET_PRIVATE_KEY DATABASE_URL; do
  VAL=$(grep "^${KEY}=" .env | cut -d= -f2-)
  if [ -z "$VAL" ] || [ "$VAL" = "YOUR_KEY" ]; then
    echo "ERROR: $KEY is not set in .env"
    exit 1
  fi
done

TRADING_MODE=$(grep "^TRADING_MODE=" .env | cut -d= -f2- | tr -d ' ')
echo "Trading mode: ${TRADING_MODE:-paper}"

# ─── 4. Install dependencies ───
echo "Installing dependencies..."
npm ci --production=false 2>&1 | tail -3

# ─── 5. Build ───
echo "Building TypeScript..."
npm run build

# ─── 6. DB Migration ───
echo "Running database migration..."
npx ts-node scripts/migrate.ts

# ─── 7. Create logs directory ───
mkdir -p logs

# ─── 8. pm2 deploy ───
echo "Starting with pm2..."
pm2 stop momentum-bot 2>/dev/null || true
pm2 delete momentum-bot 2>/dev/null || true
pm2 stop momentum-shadow 2>/dev/null || true
pm2 delete momentum-shadow 2>/dev/null || true

case "$VPS_APP_PROFILE" in
  bot)
    pm2 start ecosystem.config.cjs --only momentum-bot
    ;;
  shadow)
    pm2 start ecosystem.config.cjs --only momentum-shadow
    ;;
  both)
    pm2 start ecosystem.config.cjs --only momentum-bot,momentum-shadow
    ;;
esac

# pm2 startup (persist across reboots)
echo ""
echo "To persist across reboots, run:"
echo "  pm2 save"
echo "  pm2 startup"

echo ""
echo "=== Deploy complete ==="
echo "Commands:"
echo "  pm2 status              # process status"
echo "  pm2 logs momentum-bot   # bot logs"
echo "  pm2 logs momentum-shadow # shadow logs"
echo "  pm2 monit               # real-time monitor"
echo "  pm2 restart momentum-bot # restart"
echo "  pm2 restart momentum-shadow # restart shadow"
echo "  pm2 stop momentum-bot   # stop"
echo "  pm2 stop momentum-shadow # stop shadow"
