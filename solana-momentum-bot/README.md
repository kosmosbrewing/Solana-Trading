# Solana Momentum Bot

> **Mission: 1 SOL → 100 SOL**
>
> "가격이 움직여서 사는 게 아니라, 움직일 이유가 있고, 실제로 움직이기 시작할 때 산다."

Solana DEX 이벤트 기반 트레이딩 봇. Birdeye Trending 데이터로 **관심(Attention)**을 먼저 감지하고, 기술적 진입 조건이 충족될 때만 거래를 실행하는 **Event-First, Onchain-Confirm** 원칙의 자동매매 시스템.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Bot Runtime Loop                      │
├──────────┬──────────┬───────────┬────────────────────────┤
│ EventMon │ Universe │ Ingester  │   Position Monitor     │
│ (30min)  │ (5min)   │ (5min)    │   (5sec polling)       │
├──────────┴──────────┴───────────┴────────────────────────┤
│                                                          │
│  Stage 1: WHY should this coin move?                     │
│  └─ AttentionScore (Birdeye Trending top-20)             │
│                                                          │
│  Stage 2: IS it safe to enter NOW?                       │
│  └─ Gate System (4-gate sequential filter)               │
│     ├─ Gate 0: AttentionScore 필수 (live mode)           │
│     ├─ Gate 1: Strategy Score + Attention 보너스          │
│     ├─ Gate 2: Slippage-Aware R:R (effectiveRR ≥ 1.2)   │
│     └─ Gate 3: Token Safety (TVL, age, holder)           │
│                                                          │
│  Stage 3: HOW MUCH to risk?                              │
│  └─ Risk Tier → 3-Constraint Sizing → Kelly (if earned)  │
│                                                          │
│  Execution: Jupiter v6 Swap                              │
│  Exit: 6-priority exit cascade (5sec monitor)            │
└──────────────────────────────────────────────────────────┘
```

---

## Trading Strategies

### Strategy A: Volume Spike Breakout (`volume_spike`)

**개념:** 5분봉 기준 20봉 최고가를 돌파하면서 거래량이 평균 3배 이상 급증할 때 진입. 전형적인 모멘텀 브레이크아웃.

**진입 조건 (AND):**
- `currentVolume ≥ avgVolume[20] × 3.0`
- `close > highestHigh[20]`

**주문 파라미터:**
| 항목 | 값 |
|------|-----|
| Stop Loss | 현재 캔들 저가 |
| TP1 | entry + ATR(20) × 1.5 |
| TP2 | entry + ATR(20) × 2.5 |
| Time Stop | 30분 |

**스코어링 (0–100점):**

| 요소 | 배점 | 기준 |
|------|------|------|
| Volume Strength | 25 | ≥5.0x → 25 / ≥3.0x → 15 |
| Buy Ratio | 25 | ≥0.80 → 25 / ≥0.65 → 15 |
| Multi-TF Alignment | 20 | 5/10/20봉 추세 정렬: 3 TF → 20 / 2 TF → 10 |
| Whale Activity | 15 | 감지 시 +15 |
| LP Stability | -10 ~ +15 | stable → +15 / dropping → -10 |

**등급:** A (≥70) / B (≥50) / C (<50, 거부)

---

### Strategy C: Fib Pullback (`fib_pullback`)

**개념:** 15%+ 임펄스 이후 피보나치 0.5–0.618 구간으로 되돌림 → 거래량 클라이맥스(매도 소진) → 0.5 레벨 회복 시 진입. 확인(Confirmation) 기반 평균회귀 전략.

**진입 조건 (7단계 순차 확인):**

```
1. 임펄스 감지    → 18봉 내 15%+ 스윙
2. 피보나치 계산  → fib50, fib618, fib786
3. 구간 진입      → candle.low가 fib0.5–0.618 범위 터치
4. 볼륨 클라이맥스 → 약세봉 + volume ≥ avg × 2.5
5. 회복(Reclaim) → close > fib0.5
6. 하위 꼬리      → lower wick ≥ 캔들 전체 범위의 40%
7. 확인봉         → Reclaim 봉 다음 캔들에서 진입
```

**주문 파라미터:**
| 항목 | 값 |
|------|-----|
| Stop Loss | max(fib786 - ATR(14) × 0.3, swingLow) |
| TP1 | entry + (swingHigh - entry) × 0.90 |
| TP2 | entry + (swingHigh - entry) × 1.0 (임펄스 고점 리테스트) |
| Time Stop | 60분 |

**스코어링 (0–100점):**

| 요소 | 배점 | 기준 |
|------|------|------|
| Impulse Strength | 25 | impulse/minPct: ≥1.5x → 25 / ≥1.25x → 18 |
| Fib Precision | 25 | 되돌림 깊이 0.618 근접도: ≥0.75 → 25 |
| Volume Climax | 20 | ratio: ×1.5 → 20 / ×1.2 → 15 |
| Reclaim Quality | 15 | closeStrength×0.55 + wickQuality×0.30 + bodyRatio×0.15 |
| LP Stability | -10 ~ +15 | stable → +15 / dropping → -10 |

**등급:** A (≥70) / B (≥50) / C (<50, 거부)

---

## Gate System (진입 게이트)

모든 시그널은 4개의 순차적 게이트를 통과해야 실행됩니다. 어느 하나라도 실패하면 `filterReason`과 함께 거부.

```
Signal ──► Gate 0: AttentionScore ──► Gate 1: Strategy Score ──► Gate 2: R:R ──► Gate 3: Safety
              │                          │                        │                  │
              ▼                          ▼                        ▼                  ▼
         no score?                  totalScore < 50?        effectiveRR < 1.2?   TVL<$50K?
         → reject                   → reject                → reject             age<24h?
         "not_trending"                                                           → reject
```

### Gate 0: AttentionScore (이벤트 게이트)

- Live 모드: `requireAttentionScore = true` — 점수 없으면 `not_trending`으로 거부
- Birdeye Trending 상위 20개 토큰 기반, 30분 주기 폴링
- 캐시 TTL: 3시간, 35점 미만 점수는 폐기

### Gate 1: Strategy Score + Attention Bonus

- 전략별 스코어 (0–100) + AttentionScore 보너스 (+0–20)
- 합산 50점 미만 → 거부

### Gate 2: Slippage-Aware R:R

- Constant Product AMM 슬리피지 모델로 진입/퇴출 비용 추정
- `roundTripCost = entrySlippage + exitSlippage + AMMfee(0.5%) + MEVmargin(0.15%)`
- `effectiveRR = (reward% - roundTripCost) / (risk% + roundTripCost)`
- < 1.2 → 거부 / 1.2–1.5 → size × 0.5 / ≥ 1.5 → full size

### Gate 3: Token Safety

| 조건 | 처리 |
|------|------|
| TVL < $50K | 거부 |
| Token Age < 24h | 거부 |
| Top 10 Holder > 80% | 거부 |
| LP not burned | size × 0.5 |
| Ownership not renounced | size × 0.5 |

---

## Event Scoring System (AttentionScore)

Birdeye Trending API에서 상위 20개 토큰을 30분마다 폴링하여 **AttentionScore** (0–100)를 산출.

| 구성요소 | 배점 | 산출 |
|---------|------|------|
| Narrative Strength | 30 | 순위(rank≤3 +12) + 24h 가격변동 + 24h 거래량 |
| Source Quality | 20 | 기본 10 + 데이터 완전성 보너스 |
| Timing | 3–20 | ≤15min → 20 / ≤1h → 16 / ≤3h → 10 / ≤6h → 6 |
| Token Specificity | 8–15 | 기본 8 + symbol/name/address 존재 시 가산 |
| Historical Pattern | 0–15 | 유동성/거래량/시가총액 수준 |

**Confidence → Sizing:**
- `high` (≥70 + 핵심 데이터 완비): 1.2x
- `medium` (≥40): 1.0x
- `low` (<40): 0.8x

---

## Risk Management

### Risk Tier System (자동 단계 조정)

EdgeTracker의 거래 이력에 따라 자동으로 단계가 조정됩니다. **전략별 독립 적용.**

| Tier | 거래 수 | Risk/Trade | Daily Limit | Max DD | Kelly |
|------|---------|-----------|-------------|--------|-------|
| **Bootstrap** | <20 | 1% 고정 | 5% | 30% | 비활성 |
| **Calibration** | 20–49 | 2% 고정 | 8% | 30% | 비활성 |
| **Confirmed** | 50–99 | 1/4 Kelly (cap 6.25%) | 15% | 35% | Quarter |
| **Proven** | 100+ | 1/2 Kelly (cap 12.5%) | 15% | 40% | Half |

**승급 조건:**
- Confirmed: ≥50 trades, WR ≥ 45%, R:R ≥ 1.5, Sharpe ≥ 0.5, 최대연속손실 ≤ 4
- Proven: ≥100 trades, WR ≥ 50%, R:R ≥ 1.75, Sharpe ≥ 0.75, 최대연속손실 ≤ 3

### Position Sizing: 3-Constraint Model

```
maxSize = min(
  riskSize,           # portfolio × riskPerTrade / stopLoss%
  liquiditySize,      # poolTVL × 2% (시장 영향 제한)
  emergencySize       # TVL 50% 급락 시나리오에서도 loss ≤ maxRisk
)

hardCap = portfolio × 20%   # 단일 포지션 최대 노출 한도
```

### DrawdownGuard

```
drawdown% = (peakBalance - currentBalance) / peakBalance

drawdown ≥ maxDD → 거래 중단 (halted)
balance ≥ peak × 85% → 거래 재개 (recovered)
```

- 전체 거래 이력에서 **리플레이 방식**으로 계산 (봇 재시작에도 상태 유지)
- 열린 포지션의 미실현 손익도 **Mark-to-Market**으로 반영

### 추가 안전장치

| 장치 | 동작 |
|------|------|
| Cooldown | 3연속 손실 → 30분 쿨다운 |
| Position Limit | 동시 오픈 포지션 최대 1개 |
| Pair Blacklist | 10-trade 롤링 윈도우: WR ≤ 35% + R:R ≤ 1.0 → 자동 블랙리스트 |
| Stale Signal | 시그널 발생 후 가격 괴리/TVL 급락 감지 시 거부 |

---

## Exit System (6-Priority Cascade)

5초마다 열린 포지션을 점검. 우선순위 순서대로 평가.

| 순위 | 트리거 | 동작 |
|------|--------|------|
| 1 | **Time Stop** | VS: 30분 / Fib: 60분 초과 시 전량 청산 |
| 2 | **Stop Loss** | price ≤ SL → 전량 청산 (1%+ 이탈 시 경고) |
| 3 | **Take Profit 2** | price ≥ TP2 → 전량 청산 |
| 4 | **Take Profit 1** | price ≥ TP1 → **50% 분할 청산**, SL → 손익분기점 이동 |
| 5 | **Exhaustion Exit** | 2/3 충족 시: 캔들 바디 축소 + 긴 윗꼬리 + 거래량 감소 |
| 6 | **Adaptive Trailing** | ATR(7) × RSI 배수 기반 트레일링. RSI>80: 3.0x / 60–80: 2.0x / <60: 1.0x |

---

## Edge Tracking & Kelly Criterion

### EdgeTracker

모든 청산된 거래를 기록하고 전략별/페어별/포트폴리오 수준 통계를 산출.

- **Win Rate:** wins / totalTrades
- **R-Multiples:** PnL / (|entry - SL| × quantity)
- **Reward-to-Risk:** avgWinR / avgLossR
- **Sharpe Ratio:** mean(R) / std(R) × sqrt(252)
- **Kelly Fraction:** winRate - (1 - winRate) / R:R

### Kelly 적용

```
appliedKelly = kellyFraction × kellyScale
  Confirmed: kellyScale = 0.25 (Quarter Kelly)
  Proven:    kellyScale = 0.50 (Half Kelly)

활성화 전제: EdgeState ∈ {Confirmed, Proven} AND kellyFraction > 0
```

---

## Tech Stack

| 구성요소 | 기술 |
|---------|------|
| Runtime | Node.js 20 LTS + TypeScript |
| DEX | Jupiter Aggregator v6 |
| RPC | Helius (Solana mainnet) |
| Data | Birdeye API (OHLCV + Trending + Token Security) |
| Database | TimescaleDB (PostgreSQL 16, Docker) |
| Notifications | Telegram Bot (CRITICAL / WARNING / TRADE / INFO) |
| VPS | Vultr US, 2–4GB RAM |
| Process Manager | pm2 / systemd |

---

## Project Structure

```
solana-momentum-bot/
├── src/
│   ├── index.ts                # 봇 엔트리포인트
│   ├── strategy/               # 전략 구현 (순수 함수)
│   │   ├── volumeSpikeBreakout.ts
│   │   ├── fibPullback.ts
│   │   ├── breakoutScore.ts
│   │   ├── adaptiveTrailing.ts # RSI 기반 트레일링 스톱
│   │   ├── exhaustion.ts       # 모멘텀 소진 감지
│   │   ├── indicators.ts       # ATR, avgVolume, highestHigh
│   │   ├── lpMonitor.ts        # LP 안정성 모니터
│   │   └── whaleDetect.ts      # 웨일 감지
│   ├── gate/                   # 4-Gate 진입 필터
│   │   ├── index.ts            # evaluateGates()
│   │   ├── scoreGate.ts
│   │   ├── fibPullbackScore.ts
│   │   ├── executionViability.ts  # Slippage-Aware R:R
│   │   ├── safetyGate.ts
│   │   ├── sizingGate.ts
│   │   └── liveGateInput.ts
│   ├── event/                  # 이벤트/관심 스코어링
│   │   ├── index.ts            # EventMonitor (폴링 + 캐시)
│   │   ├── eventScorer.ts      # AttentionScorer
│   │   ├── trendingFetcher.ts  # Birdeye Trending API
│   │   └── types.ts
│   ├── risk/                   # 리스크 관리
│   │   ├── riskManager.ts      # 주문 승인 + 포지션 사이징
│   │   ├── riskTier.ts         # Risk Tier (Bootstrap→Proven)
│   │   ├── drawdownGuard.ts    # DrawdownGuard 상태 머신
│   │   └── liquiditySizer.ts   # 3-Constraint 사이저
│   ├── orchestration/          # 거래 라이프사이클
│   │   ├── candleHandler.ts    # 캔들 → 전략 → 게이트 → 시그널
│   │   ├── signalProcessor.ts  # 시그널 → 리스크 → 주문 → 실행
│   │   ├── tradeExecution.ts   # 포지션 모니터링, 청산, TP1 분할
│   │   └── reporting.ts        # 일일 리포트
│   ├── executor/               # Jupiter v6 스왑 실행
│   ├── reporting/              # EdgeTracker + Paper Validation
│   ├── ingester/               # Birdeye OHLCV 수집
│   ├── universe/               # Universe/Watchlist 엔진
│   ├── candle/                 # 캔들/거래 저장소
│   ├── state/                  # 포지션 상태 머신, 실행 잠금
│   ├── notifier/               # Telegram 알림
│   ├── audit/                  # 시그널 감사 로깅
│   └── utils/                  # Config, Logger, Types
├── config/                     # JSON 설정 파일
├── scripts/                    # CLI 도구 (backtest, paper-report)
├── test/                       # 테스트
├── .env.example
├── docker-compose.yml
└── Dockerfile
```

---

## Quick Start

```bash
# 1. 의존성 설치
npm install

# 2. 환경 변수 설정
cp .env.example .env
# .env 파일에 API 키 설정:
#   HELIUS_API_KEY, BIRDEYE_API_KEY, TELEGRAM_BOT_TOKEN
#   WALLET_PRIVATE_KEY, DATABASE_URL

# 3. TimescaleDB 실행
docker-compose up -d

# 4. DB 마이그레이션
npx ts-node scripts/migrate.ts

# 5. Paper 모드로 봇 실행
TRADING_MODE=paper npx ts-node src/index.ts

# 6. Paper 검증 리포트 확인
npx ts-node scripts/paper-report.ts
```

---

## Backtest

```bash
# CSV 모드
npx ts-node scripts/backtest.ts <PAIR_ADDRESS> \
  --source csv --csv-dir ./data \
  --strategy both --balance 1 \
  --trades --export-csv ./results

# DB 모드
npx ts-node scripts/backtest.ts <PAIR_ADDRESS> \
  --source db --strategy both --balance 1

# AttentionScore 강제 적용
npx ts-node scripts/backtest.ts <PAIR_ADDRESS> \
  --source csv --csv-dir ./data \
  --require-attention-score
```

**최소 캔들 요구량:** VS 22개, Fib 29개, 유의미 백테스트 8,640개 (30일 × 5분봉)

---

## Roadmap

| Phase | 목표 | 상태 |
|-------|------|------|
| **Phase 0** | 기존 봇 안정화, 데드코드 제거 | **완료** |
| **Phase 0.5** | Safety 연결, DrawdownGuard 통합 | **완료** |
| **Phase 1** | EventScore + Risk Tier + Slippage R:R | **진행 중** (Paper 50 trade 검증 잔여) |
| **Phase 2** | Event Catch (Twitter/X, Discord, Telegram) | 미착수 |
| **Phase 3** | Candidate-Driven Execution | 미착수 |
| **Phase 4** | New Coin Pipeline | 미착수 |

### Phase 2 Live 전환 조건 (Paper Validation)

- 50회 이상 Paper Trade 완료
- Win Rate ≥ 40%
- Reward-to-Risk ≥ 2.0

---

## Known Limitations

| 심각도 | 항목 |
|--------|------|
| Critical | 히스토리컬 EventScore 데이터 미수집 — 백테스트 불완전 |
| Critical | EventScore가 Birdeye Trending 한정 — 소셜/뉴스 시그널 부재 |
| High | Spread 프록시가 캔들 고가/저가 기반 — 실제 호가 데이터 없음 |
| High | AMM 수수료 0.5% 하드코딩 — 풀별 수수료 미조회 |
| Medium | TP1(1.5x ATR)이 마이크로캡 변동성 대비 보수적일 수 있음 |
| Medium | 시장 레짐 필터 없음 (SOL/BTC 상관관계, 변동성) |
| Medium | MEV 보호 없음 (Jito bundle / private routing) |
| Medium | 포지션 모니터링 5초 폴링 (WebSocket 미적용) |

---

## License

Private — Not for distribution.
