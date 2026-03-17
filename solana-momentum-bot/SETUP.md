# VPS 환경 구성 가이드

> Vultr VPS (US) + Ubuntu 22.04 + TimescaleDB + Node.js 20
> 목적: 백테스트 실행 → 라이브 전환 대비

---

## 리전 선택: US 필수

| 서비스 | 위치 | 이유 |
|--------|------|------|
| Birdeye API | US | 캔들 데이터 수집 레이턴시 |
| Helius RPC | US | 온체인 트랜잭션 속도 |
| Jupiter API | US | quote/swap 레이턴시 및 price impact 검증 |
| Solana Validators | 대부분 US | 체인 전체 레이턴시 |

**추천: New Jersey (ewr) 또는 Los Angeles (lax)**

## 권장 스펙

| 항목 | 백테스트 전용 | 백테스트 + 라이브 |
|------|-------------|------------------|
| Plan | Cloud Compute (Shared) | Cloud Compute (Regular) |
| vCPU | 1 | 2 |
| RAM | 2 GB | 4 GB |
| Storage | 55 GB SSD | 80 GB SSD |
| 월 비용 | ~$12 | ~$24 |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |

---

## Step 1. VPS 초기 셋업

```bash
# SSH 접속
ssh root@<VPS_IP>

# 시스템 업데이트
sudo apt update && sudo apt upgrade -y

# 필수 패키지
sudo apt install -y curl git build-essential

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # v20.x 확인
npm --version    # 10.x 확인

# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
docker compose version   # v2.x 확인
```

## Step 2. 프로젝트 배포

```bash
mkdir -p ~/projects && cd ~/projects

# Git Clone
git clone <YOUR_REPO_URL> solana-momentum-bot
cd solana-momentum-bot

# 의존성 설치
npm install
```

## Step 3. 환경변수 (.env)

```bash
cp .env.example .env
nano .env
```

### 백테스트 최소 설정

```bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  필수 — 백테스트 실행에 필요
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BIRDEYE_API_KEY=<your-birdeye-api-key>
DATABASE_URL=postgresql://momentum:momentum_secret@localhost:5432/momentum_bot
```

### 전체 설정 (라이브 전환 포함)

```bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  필수 — 백테스트
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BIRDEYE_API_KEY=<your-birdeye-api-key>
DATABASE_URL=postgresql://momentum:momentum_secret@localhost:5432/momentum_bot

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  라이브 전환 시 추가
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<helius-key>
WALLET_PRIVATE_KEY=<base58-private-key>
JUPITER_API_URL=https://api.jup.ag
TELEGRAM_BOT_TOKEN=<telegram-bot-token>
TELEGRAM_CHAT_ID=<telegram-chat-id>
TRADING_MODE=paper
TARGET_PAIR_ADDRESS=<pair-address>   # legacy single-pair mode에서만 사용

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Risk Parameters
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MAX_RISK_PER_TRADE=0.01
MAX_DAILY_LOSS=0.05
MAX_SLIPPAGE=0.01
MAX_POOL_IMPACT=0.02
EMERGENCY_HAIRCUT=0.50

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Strategy Parameters
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DEFAULT_TIMEFRAME=300
VOLUME_SPIKE_MULTIPLIER=3.0
VOLUME_SPIKE_LOOKBACK=20
MIN_BUY_RATIO=0.65
MIN_BREAKOUT_SCORE=50
TAKE_PROFIT_ATR_MULTIPLIER=2.0
TRAILING_STOP_ATR_MULTIPLIER=1.5
TIME_STOP_MINUTES=30
EXHAUSTION_THRESHOLD=2
PUMP_CONSECUTIVE_CANDLES=3
PUMP_MIN_PRICE_MOVE=0.05

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Universe Parameters
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MIN_POOL_TVL=50000
MIN_TOKEN_AGE_SEC=86400
MAX_TOP10_HOLDER_PCT=0.80
MIN_DAILY_VOLUME=10000
MIN_TRADE_COUNT_24H=50
MAX_SPREAD_PCT=0.03
MAX_WATCHLIST_SIZE=20
UNIVERSE_REFRESH_INTERVAL_MS=300000

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Safety (legacy)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MIN_POOL_LIQUIDITY=50000
MIN_TOKEN_AGE_HOURS=24
MAX_HOLDER_CONCENTRATION=0.80

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Execution
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MAX_RETRIES=3
TX_TIMEOUT_MS=30000
COOLDOWN_MINUTES=30
MAX_CONSECUTIVE_LOSSES=3
```

## Step 4. TimescaleDB 실행

```bash
# DB 컨테이너만 실행 (봇 컨테이너는 아직 불필요)
docker compose up -d timescaledb

# 헬스체크 대기 (~10초)
docker compose ps
# STATUS: healthy 확인

# 마이그레이션 실행
npx ts-node scripts/migrate.ts
```

예상 출력:

```
Running migrations (v0.3)...
  ✓ candles table created
  ✓ candles hypertable created
  ✓ candles compression/retention policies set
  ✓ candles index created
  ✓ trades table created
  ✓ trades indexes created
  ✓ position_states table created
  ✓ signal_audit_log table created
  ✓ signal_audit_log hypertable + policies set
  ✓ universe_snapshots table created
  ✓ universe_snapshots hypertable + retention set
  ✓ backtest_runs table created

Migration complete!
```

### 생성되는 테이블

| 테이블 | 용도 | 백테스트 필수 |
|--------|------|:----------:|
| `candles` | OHLCV + 방향성 거래량 | **O** (DB 모드) |
| `trades` | 라이브 트레이드 기록 | X |
| `position_states` | 포지션 상태 머신 | X |
| `signal_audit_log` | 시그널 감사 로그 | X |
| `universe_snapshots` | 풀 메타데이터 스냅샷 | X |
| `backtest_runs` | 백테스트 실행 이력 | X |

## Step 5. 캔들 데이터 수집

```bash
# 대상 페어의 5분봉 30일치 다운로드
npx ts-node scripts/fetch-candles.ts <PAIR_ADDRESS> \
  --interval 5m --days 30 --output ./data

# 여러 페어 수집
npx ts-node scripts/fetch-candles.ts <PAIR_1> --interval 5m --days 30 --output ./data
npx ts-node scripts/fetch-candles.ts <PAIR_2> --interval 5m --days 30 --output ./data
npx ts-node scripts/fetch-candles.ts <PAIR_3> --interval 5m --days 30 --output ./data

# 수집 확인
ls -la data/
```

### CSV 파일 형식

```
timestamp,open,high,low,close,volume,trade_count,buy_volume,sell_volume
1705359900,0.025,0.026,0.025,0.0255,1250000,145,750000,500000
```

파일명 규칙: `{pairAddress}_5m.csv`

### 데이터 최소 요구량

| 전략 | 최소 캔들 수 | 권장 기간 |
|------|:-----------:|----------|
| Volume Spike (A) | 22개 (21 lookback + 1) | 7일+ |
| Fib Pullback (C) | 29개 (28 lookback + 1) | 7일+ |
| 유의미한 백테스트 | 8,640개 | **30일** |

> 5분봉 30일 = 8,640 캔들

## Step 6. 백테스트 실행

### CSV 모드 (DB 불필요)

```bash
npx ts-node scripts/backtest.ts <PAIR_ADDRESS> \
  --source csv --csv-dir ./data \
  --strategy both --balance 1 \
  --trades --export-csv ./results
```

### DB 모드

```bash
npx ts-node scripts/backtest.ts <PAIR_ADDRESS> \
  --source db \
  --strategy both --balance 1 \
  --trades --export-csv ./results
```

### 파라미터 조정 테스트

```bash
# 보수적 설정
npx ts-node scripts/backtest.ts <PAIR_ADDRESS> \
  --source csv --csv-dir ./data \
  --risk 0.005 --daily-loss 0.03 --max-drawdown 0.20 \
  --min-score 60 --min-buy-ratio 0.70

# 공격적 설정
npx ts-node scripts/backtest.ts <PAIR_ADDRESS> \
  --source csv --csv-dir ./data \
  --risk 0.03 --daily-loss 0.10 --max-drawdown 0.40

# TP 확대 테스트
npx ts-node scripts/backtest.ts <PAIR_ADDRESS> \
  --source csv --csv-dir ./data \
  --vol-mult 4.0 --min-score 55
```

### CLI 전체 옵션

```
Data Source:
  --source db|csv              데이터 소스 (default: db)
  --csv-dir ./data             CSV 디렉토리 (source=csv 시)

Strategy:
  --strategy a|c|both          전략 선택 (default: both)
                               a = Volume Spike Breakout
                               c = Fib Pullback

Risk:
  --balance 10                 초기 잔고 SOL (default: 10)
  --risk 0.01                  트레이드당 최대 리스크 (default: 0.01)
  --daily-loss 0.05            일일 최대 손실률 (default: 0.05)
  --max-drawdown 0.30          HWM 기준 최대 drawdown (default: 0.30)
  --recovery-pct 0.85          거래 재개 회복 비율 (default: 0.85)
  --max-losses 3               연속 손실 제한 (default: 3)
  --cooldown 30                쿨다운 분 (default: 30)

Strategy Params:
  --vol-mult 3.0               Volume Spike 배수
  --vol-lookback 20            Volume Spike 룩백
  --min-buy-ratio 0.65         Gate 최소 매수 비율
  --min-score 50               Gate 최소 Breakout Score

Gate Overrides:
  --gate-tvl 50000             풀 TVL 오버라이드
  --gate-token-age-hours 24    토큰 나이 오버라이드
  --gate-top10-holder-pct 0.8  상위10 보유 비율 오버라이드
  --gate-lp-burned true        LP 소각 여부 오버라이드
  --gate-ownership-renounced true  소유권 포기 오버라이드

Date Range:
  --start 2024-01-01           시작 날짜 (ISO)
  --end 2024-12-31             종료 날짜 (ISO)

Output:
  --trades                     트레이드 로그 출력
  --trades-limit 50            트레이드 로그 제한
  --equity                     equity curve 출력 (ASCII)
  --export-csv ./out           트레이드+equity CSV 내보내기
```

---

## DB 관리

### 접속

```bash
docker exec -it solana-momentum-bot-timescaledb-1 \
  psql -U momentum -d momentum_bot
```

### 자주 쓰는 쿼리

```sql
-- 수집된 캔들 데이터 확인
SELECT pair_address, COUNT(*) as candles,
       MIN(timestamp) as first, MAX(timestamp) as last
FROM candles
GROUP BY pair_address;

-- 디스크 사용량
SELECT hypertable_name,
       pg_size_pretty(hypertable_size(
         format('%I.%I', hypertable_schema, hypertable_name)
       ))
FROM timescaledb_information.hypertables;

-- 특정 페어 최근 캔들
SELECT timestamp, open, high, low, close, volume
FROM candles
WHERE pair_address = '<PAIR_ADDRESS>' AND interval_sec = 300
ORDER BY timestamp DESC
LIMIT 10;
```

### 백업 / 복원

```bash
# 백업
docker exec solana-momentum-bot-timescaledb-1 \
  pg_dump -U momentum momentum_bot > backup_$(date +%Y%m%d).sql

# 복원
docker exec -i solana-momentum-bot-timescaledb-1 \
  psql -U momentum momentum_bot < backup_20260315.sql
```

### 컨테이너 관리

```bash
docker compose stop timescaledb     # 중지
docker compose start timescaledb    # 재시작
docker compose logs timescaledb     # 로그 확인
docker compose down                 # 컨테이너 삭제 (볼륨 유지)
docker compose down -v              # 컨테이너 + 볼륨 삭제 (데이터 초기화)
```

---

## 트러블슈팅

### TimescaleDB 연결 실패

```bash
# 컨테이너 상태 확인
docker compose ps
# STATUS가 healthy가 아니면 로그 확인
docker compose logs timescaledb

# 포트 충돌 확인
sudo lsof -i :5432
```

### fetch-candles 실패

```bash
# API Key 확인
echo $BIRDEYE_API_KEY

# Rate limit → 200ms 딜레이 내장, 그래도 실패 시 --days 줄여서 재시도
npx ts-node scripts/fetch-candles.ts <PAIR> --interval 5m --days 7 --output ./data
```

### 백테스트 "No candle data found"

```bash
# CSV 파일 존재 확인
ls data/<PAIR_ADDRESS>*

# 파일명이 규칙에 맞는지 확인 (pairAddress_5m.csv)
# DB 모드면 캔들 데이터가 DB에 있는지 확인
```

### ts-node 메모리 부족

```bash
# 대용량 데이터 시 메모리 늘리기
NODE_OPTIONS="--max-old-space-size=2048" npx ts-node scripts/backtest.ts ...
```

---

## 체크리스트

```
[ ] Vultr VPS 생성 (US, Ubuntu 22.04, 2GB+)
[ ] SSH 접속 확인
[ ] Node.js 20 설치 (node --version)
[ ] Docker 설치 (docker compose version)
[ ] 프로젝트 clone + npm install
[ ] .env 생성 (BIRDEYE_API_KEY + DATABASE_URL)
[ ] docker compose up -d timescaledb
[ ] npx ts-node scripts/migrate.ts → "Migration complete!"
[ ] npx ts-node scripts/fetch-candles.ts <PAIR> --days 30
[ ] npx ts-node scripts/backtest.ts <PAIR> --source csv --trades
```

**Birdeye API Key + 페어 주소만 있으면 ~15분 완료.**
