# Solana Trading

Solana DEX 자동 트레이딩 시스템. Python 스나이퍼 봇(v0)과 TypeScript 모멘텀 봇(v0.3) 두 가지 전략을 포함합니다.

---

## 프로젝트 구조

```
Solana-Trading/
├── solana-momentum-bot/     # v0.3 — TypeScript 모멘텀 브레이크아웃 봇
│   ├── src/
│   │   ├── index.ts              # 메인 엔트리 (파이프라인 통합)
│   │   ├── ingester/             # Birdeye API 캔들 수집
│   │   ├── candle/               # CandleStore + TradeStore (TimescaleDB)
│   │   ├── universe/             # Pool 필터링 + 랭킹 + Watchlist
│   │   ├── strategy/             # Breakout Score, Whale, LP, Exhaustion, Trailing
│   │   ├── risk/                 # RiskManager + LiquiditySizer (3-Constraint)
│   │   ├── executor/             # Jupiter Swap 실행 (SwapResult 반환)
│   │   ├── state/                # ExecutionLock, StaleSignalGuard, PositionStore, Recovery
│   │   ├── audit/                # Signal Audit Log
│   │   ├── notifier/             # Telegram 4-Level Alert
│   │   ├── backtest/             # 백테스트 엔진 + 리포터
│   │   └── utils/                # Config, Logger, HealthMonitor, Types
│   ├── scripts/
│   │   ├── migrate.ts            # DB 마이그레이션
│   │   ├── backtest.ts           # 백테스트 CLI
│   │   └── fetch-candles.ts      # Birdeye → CSV 데이터 수집
│   └── config/                   # 3-Group 파라미터 (Universe, Strategy, Liquidity)
│
├── omain.py                 # v0 — Python 스나이퍼 봇 메인
├── getNewLPScraper.py       # 텔레그램 스크래핑 + 자동 매매
├── getNewLP.py              # Raydium LP WebSocket 모니터링
├── getOrderGmGn.py          # GMGN 스왑 주문 실행
├── getBacktestScraper.py    # Python 백테스트
└── checkPosition.py         # 포지션 모니터링
```

---

## v0.3 — Momentum Breakout Bot (TypeScript)

Solana DEX micro-cap 토큰의 모멘텀 브레이크아웃을 감지하여 자동 매매하는 봇.

### 아키텍처

**3단계 파이프라인**: Universe → Strategy → Risk

```
Universe Engine          Strategy Layer           Risk Layer
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ Pool Discovery  │───▶│ Breakout Score    │───▶│ LiquiditySizer  │
│ Static Filter   │    │  (5-factor 0~100) │    │  (3-Constraint) │
│ Dynamic Filter  │    │ Whale Detection   │    │ Grade Sizing    │
│ Ranking         │    │ LP Monitor        │    │  A=100% B=50%   │
│ Watchlist (≤20) │    │ Exhaustion Exit   │    │  C=rejected     │
└─────────────────┘    │ Adaptive Trailing │    └─────────────────┘
                       └──────────────────┘
```

### Breakout Score (0~100)

| Factor | Weight | 기준 |
|--------|--------|------|
| Volume Ratio | 25 | ≥5x → 25, ≥3x → 15 |
| Buy Ratio | 25 | ≥80% → 25, ≥65% → 15 |
| Multi-TF Alignment | 20 | ≥3TF → 20, ≥2TF → 10 |
| Whale Activity | 15 | 감지 → 15 |
| LP Stability | -10~15 | stable → 15, dropping → -10 |

**Grade**: A (≥70) → Full Size, B (≥50) → Half Size, C (<50) → Rejected

### LiquiditySizer — 3-Constraint Model

```
Position Size = min(Risk, Liquidity, Emergency)

Risk:       portfolio × riskPerTrade / stopLossPct
Liquidity:  TVL × maxPoolImpactPct (2%)
Emergency:  TVL 50% 급감 시에도 maxRisk 이내 청산 가능한 사이즈
```

슬리피지 추정: `priceImpact + fee(0.3%) + MEV(0.1%)`

### 주요 모듈

| 모듈 | 역할 |
|------|------|
| **UniverseEngine** | 5분 주기 pool 필터링/랭킹, watchlist 관리 |
| **BreakoutScore** | 5-factor 점수 → Grade A/B/C 분류 |
| **WhaleDetect** | 단일 대형 매수(>2% TVL), 3-candle 누적 감지 |
| **LPMonitor** | LP 추가/제거 감지, 안정성 평가 |
| **AdaptiveTrailing** | RSI(7) 기반 trailing 폭 조절 (×1~×3 ATR) |
| **ExhaustionExit** | body 축소 + upper wick + volume 감소 (2/3 trigger) |
| **ExecutionLock** | 동시 1개 트레이드만 실행 (60s timeout) |
| **StaleSignalGuard** | 시그널 유효성 (시간/가격/스프레드/TVL) |
| **PositionStore** | Write-Ahead 상태 기록 + 크래시 복구 |
| **SignalAuditLog** | 모든 시그널 결과 DB 기록 |

### 설치 및 실행

```bash
cd solana-momentum-bot

# 의존성 설치
npm install

# 환경 변수 설정
cp .env.example .env
# .env 파일에 API 키, DB URL, 지갑 키 등 설정

# DB 기동 (TimescaleDB)
docker-compose up -d

# DB 마이그레이션
npx ts-node scripts/migrate.ts

# Paper 모드로 실행
TRADING_MODE=paper npx ts-node src/index.ts

# Live 모드로 실행
TRADING_MODE=live npx ts-node src/index.ts
```

### 환경 변수 (.env)

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `DATABASE_URL` | TimescaleDB 연결 | `postgresql://...` |
| `BIRDEYE_API_KEY` | Birdeye API 키 | - |
| `SOLANA_RPC_URL` | Solana RPC 엔드포인트 | - |
| `WALLET_PRIVATE_KEY` | 지갑 개인키 (Base58) | - |
| `TELEGRAM_BOT_TOKEN` | 텔레그램 알림 봇 | - |
| `TARGET_PAIR_ADDRESS` | 모니터링 대상 풀 | - |
| `TRADING_MODE` | `paper` / `live` | `paper` |
| `MAX_RISK_PER_TRADE` | 1회 최대 리스크 | `0.02` |
| `MAX_DAILY_LOSS` | 일일 최대 손실 | `0.05` |
| `MAX_SLIPPAGE` | 최대 슬리피지 | `0.01` |

### 백테스트

```bash
# 캔들 데이터 수집 (Birdeye → CSV)
npx ts-node scripts/fetch-candles.ts \
  --pair <PAIR_ADDRESS> \
  --interval 5m \
  --days 30 \
  --output data/candles.csv

# 백테스트 실행
npx ts-node scripts/backtest.ts \
  --file data/candles.csv \
  --strategy volume_spike \
  --initial-balance 10 \
  --slippage-deduction 0.30

# 주요 옵션
#   --strategy         volume_spike | pump_detect | combined
#   --start-date       시작일 (YYYY-MM-DD)
#   --end-date         종료일 (YYYY-MM-DD)
#   --export-csv       트레이드 결과 CSV 내보내기
#   --chart            ASCII equity curve 출력
```

### DB 스키마

| 테이블 | 용도 |
|--------|------|
| `candles` | OHLCV + buyVolume/sellVolume (TimescaleDB hypertable) |
| `trades` | 트레이드 기록 (score, grade, constraint, exitReason) |
| `position_states` | 포지션 상태 머신 (Write-Ahead) |
| `signal_audit_log` | 시그널 감사 로그 (EXECUTED/FILTERED/STALE/RISK_REJECTED) |
| `universe_snapshots` | Pool 스냅샷 |
| `backtest_runs` | 백테스트 결과 |

### 파라미터 구조 (3-Group)

```
config/
├── params-universe.json    # 7개: TVL, age, holder, volume, trade count, spread, watchlist
├── params-strategy.json    # 10개: lookback, multiplier, consecutive, TP/SL, trailing 등
├── params-liquidity.json   # 3개: maxSlippage, maxPoolImpact, emergencyHaircut
└── params-search.json      # Grid search 범위 + constraint rules
```

---

## v0 — Sniper Bot (Python)

텔레그램 채널에서 신규 토큰을 스크래핑하여 필터링 후 자동 매수하는 스나이퍼 봇.

### 필터링 조건

| 조건 | 값 |
|------|-----|
| Market Cap | 초기 단계 (K/M 단위) |
| Holder 수 | 50명 이하 |
| Renounced | 소유권 포기됨 |
| Top 10 홀더 | 85% 이하 |
| LP Burn | 100% |
| Rug 확률 | 10% 이하 |

### 실행

```bash
pip install telethon aiohttp solana solders base58 pandas python-telegram-bot websockets

# consts.py에 API 키 및 지갑 설정 후
python omain.py
```

---

## 기술 스택

| 구분 | v0 (Sniper) | v0.3 (Momentum) |
|------|------------|-----------------|
| Language | Python 3.x | TypeScript (Node.js) |
| DB | JSON files | TimescaleDB (PostgreSQL) |
| DEX | GMGN Router | Jupiter Aggregator |
| Data | DexScreener, Telegram | Birdeye API |
| Notification | python-telegram-bot | Telegram Bot API |
| Infra | - | Docker Compose |
