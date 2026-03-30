#!/usr/bin/env bash
# TimescaleDB 컨테이너 재기동 스크립트
# Why: 도커 데몬은 살아 있는데 DB 컨테이너만 내려간 경우를 빠르게 복구한다.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

SERVICE_NAME="timescaledb"
HEALTH_TIMEOUT_SEC="${HEALTH_TIMEOUT_SEC:-90}"
POLL_INTERVAL_SEC=2

source ~/.profile 2>/dev/null || true

echo "=== Restart TimescaleDB ==="
echo "Directory: $APP_DIR"

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not found"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: docker compose not available"; exit 1; }

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: docker daemon is not responding"
  exit 1
fi

if [ ! -f docker-compose.yml ]; then
  echo "ERROR: docker-compose.yml not found"
  exit 1
fi

CONTAINER_ID="$(docker compose ps -q "$SERVICE_NAME" 2>/dev/null || true)"

if [ -n "$CONTAINER_ID" ]; then
  echo "Restarting existing container: $SERVICE_NAME"
  docker compose restart "$SERVICE_NAME"
else
  echo "Starting container: $SERVICE_NAME"
  docker compose up -d "$SERVICE_NAME"
  CONTAINER_ID="$(docker compose ps -q "$SERVICE_NAME")"
fi

if [ -z "$CONTAINER_ID" ]; then
  echo "ERROR: failed to resolve container id for $SERVICE_NAME"
  exit 1
fi

echo "Waiting for health check (timeout: ${HEALTH_TIMEOUT_SEC}s)..."
DEADLINE=$((SECONDS + HEALTH_TIMEOUT_SEC))

while [ "$SECONDS" -lt "$DEADLINE" ]; do
  STATUS="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER_ID" 2>/dev/null || echo unknown)"
  case "$STATUS" in
    healthy|running)
      echo "TimescaleDB is ready: $STATUS"
      docker compose ps
      exit 0
      ;;
    unhealthy|exited|dead)
      echo "ERROR: TimescaleDB entered bad state: $STATUS"
      docker logs "$CONTAINER_ID" --tail 100 || true
      exit 1
      ;;
  esac
  sleep "$POLL_INTERVAL_SEC"
done

echo "ERROR: TimescaleDB did not become ready within ${HEALTH_TIMEOUT_SEC}s"
docker logs "$CONTAINER_ID" --tail 100 || true
exit 1
