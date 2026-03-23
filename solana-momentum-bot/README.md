# Solana Momentum Bot

> **Mission: 1 SOL → 100 SOL**
>
> "가격이 움직여서 사는 게 아니라, 움직일 이유가 있고, 실제로 움직이기 시작할 때 산다."

Solana DEX 이벤트 기반 트레이딩 봇. Birdeye WS/Trending, DexScreener, 온체인 트리거를 결합해 **관심(Attention)**을 먼저 만들고, 실제 체결 가능성이 확인될 때만 거래를 실행하는 **Event-First, Onchain-Confirm** 자동매매 시스템.

---

## Reference Docs

- `docs/product-specs/strategy-catalog.md` — Strategy A/C/D/E 흐름과 게이트 설계
- `OPERATIONS.md` — demotion 운영 가이드와 live 대응 절차
- `PROJECT.md` — 목표, 비목표, 로드맵

## Documentation Guide

- Source of truth
  - `AGENTS.md` — 에이전트 작업 규칙과 저장소 문서 맵
  - `ARCHITECTURE.md` — 모듈 책임, 의존성 방향, 데이터 흐름
  - `PROJECT.md` — 제품 목표와 운영 원칙
  - `OPERATIONS.md` — 실제 운영 절차와 runbook
  - `docs/product-specs/strategy-catalog.md` — 전략/Gate/Risk 제품 명세
  - `MEASUREMENT.md` — 점수 해석과 stage score 정책
- Working guides
  - `BACKTEST.md` — 백테스트 워크플로와 해석 가이드
  - `REALTIME.md` — realtime shadow/replay 검증 가이드
- Historical or execution notes
  - `docs/exec-plans/completed/realtime-measurement-refactor.md`
  - `docs/exec-plans/completed/v4-improvement-plan.md`
  - `docs/exec-plans/completed/paper-data-plane-transition.md`
  - `docs/exec-plans/completed/paper-runtime-stabilization-loop.md`
  - `docs/exec-plans/completed/pumpswap-realtime-coverage-loop.md`
  - 구현 당시의 판단, 실험, 완료 이력을 담는다. 현재 동작의 최종 기준 문서로 읽지 않는다.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Bot Runtime Loop                      │
├──────────┬──────────┬───────────┬────────────────────────┤
│ Scanner  │ Universe │ Ingester  │   Position Monitor     │
│ (WS/API) │ (5min)   │ (5min)    │   (5sec polling)       │
├──────────┴──────────┴───────────┴────────────────────────┤
│                                                          │
│  Stage 1: WHY should this coin move?                     │
│  └─ AttentionScore (Birdeye WS/Trending + enrichment)    │
│                                                          │
│  Stage 2: IS it safe to enter NOW?                       │
│  └─ Gate System (5+1 sequential filter)                  │
│     ├─ Gate 0: Security (honeypot, freeze, transferFee)  │
│     ├─ Gate 1: AttentionScore 필수 (runtime path)        │
│     ├─ Gate 2: Strategy Score + Execution Viability      │
│     ├─ Gate 3: Token Safety (TVL, age, holder)           │
│     └─ Exit Gate: Sell-side Impact (포지션 크기 기반)     │
│                                                          │
│  Stage 3: HOW MUCH to risk?                              │
│  └─ Risk Tier → 3-Constraint Sizing → Kelly (if earned)  │
│                                                          │
│  Execution: Jupiter Ultra V3 (+ v6 fallback + Jito)      │
│  Exit: 8-priority exit cascade (5sec monitor)            │
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
| Mcap/Volume Ratio | 10 | ≥30% → 10 / ≥15% → 6 / ≥5% → 3 |

**등급:** A (≥70) / B (≥50) / C (<50, 거부) — 6팩터 합산 후 `min(100, total)` 캡

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

모든 시그널은 5+1개의 순차적 게이트를 통과해야 실행됩니다. 어느 하나라도 실패하면 `filterReason`과 함께 거부.

```
Gate 0: Security Gate (async) — honeypot, freeze, transferFee, holder 집중도
Gate 1: AttentionScore — 트렌딩 화이트리스트
Gate 2A: Execution Viability — R:R + round-trip cost
Gate 2B: Quote Gate (async) — Jupiter entry price impact
Gate 3: Strategy Score — 전략별 점수 (A/B/C 등급)
Gate 4: Safety Gate — pool 유동성, token age, LP burn
Exit Gate: Sell-side Impact (async) — 포지션 크기 기반 exit 유동성 검증
```

### Gate 0: Security Gate (async)

- Birdeye `token_security`: honeypot, freezable, mintable, transfer_fee → reject
- exit-liquidity 프록시 검증
- async 경로(live/paper)에서만 활성화

### Gate 1: AttentionScore (이벤트 게이트)

- 런타임 게이트 경로(`buildLiveGateInput`)에서는 AttentionScore가 필수이며, 점수 없으면 `not_trending`으로 거부
- Birdeye Trending 상위 20개 토큰 기반, 30분 주기 폴링
- 캐시 TTL: 3시간, 35점 미만 점수는 폐기

### Gate 2: Execution Viability + Quote Gate

- Constant Product AMM 슬리피지 모델로 진입/퇴출 비용 추정
- `roundTripCost = entrySlippage + exitSlippage + AMMfee(0.5%) + MEVmargin(0.15%)`
- `effectiveRR = (reward% - roundTripCost) / (risk% + roundTripCost)`
- < 1.2 → 거부 / 1.2–1.5 → size × 0.5 / ≥ 1.5 → full size
- Quote Gate: Jupiter 실시간 quote로 price impact ≤ 2% 검증 (60% 초과 시 size × 0.5)

### Gate 3: Strategy Score + Attention Bonus

- 전략별 스코어 (0–100) + AttentionScore 보너스 (+0–20)
- 합산 50점 미만 → 거부

### Gate 4: Token Safety (v4: 3-tier Age Bucket + 동적 TVL)

| 조건 | 처리 |
|------|------|
| TVL < 동적 최소값 | 거부 (equity 기반: <5 SOL → $50K / 5~20 SOL → $100K / 20+ SOL → $200K) |
| Token Age < 15min | 거부 (hard floor, 설정 가능) |
| Token Age 15min ~ 1h | size × 0.25 |
| Token Age 1h ~ 4h | size × 0.5 |
| Token Age 4h ~ 24h | size × 0.75 |
| Token Age ≥ 24h | size × 1.0 (감산 없음) |
| Top 10 Holder > 80% | 거부 |
| LP not burned | size × 0.5 (age bucket과 곱셈 누적) |
| Ownership not renounced | size × 0.5 |

> v4: Age Bucket hard floor와 tier 승수는 env var로 조정 가능하다. 현재 런타임에서는 age bucket 경로가 기본 활성화되어 동작한다.

### Exit Gate: Sell-side Impact (async)

- 포지션 크기 기반 Jupiter quote로 sell-side impact 측정
- `sellImpact > 3%` → reject (`exit_illiquid`)
- `sellImpact > 1.5%` → size × 0.5
- sync 경로(backtest)에서는 비활성 — 라이브 Jupiter quote 필요

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
| **Calibration** | 20–49 | 1% 고정 | 5% | 30% | 비활성 |
| **Confirmed** | 50–99 | 1/4 Kelly (cap 3%) | 15% | 35% | Quarter |
| **Proven** | 100+ | 1/4 Kelly (cap 5%) | 15% | 40% | Quarter |

> **v4:** 선형 보간으로 tier 경계 급변 방지 (Calibration→Confirmed: trades 40~60, Confirmed→Proven: trades 85~115)

**승급 조건:**
- Confirmed: ≥50 trades, WR ≥ 45%, R:R ≥ 1.5, Sharpe ≥ 0.5, 최대연속손실 ≤ 4
- Proven: ≥100 trades, WR ≥ 50%, R:R ≥ 1.75, Sharpe ≥ 0.75, 최대연속손실 ≤ 3

### Position Sizing: 3-Constraint Model

```
maxSize = min(
  riskSize,           # portfolio × riskPerTrade / stopLoss%
  liquiditySize,      # poolTVL × maxPoolImpact% (equity 기반 동적)
  emergencySize       # TVL 50% 급락 시나리오에서도 loss ≤ maxRisk
)

hardCap = portfolio × MAX_POSITION_PCT (기본 20%, 설정 가능)
```

> **v4:** maxPoolImpact equity 기반 동적 축소 (<5 SOL: 2% / 5~20 SOL: 1.5% / 20+ SOL: 1%)

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
| Position Limit | equity 기반 동적 concurrent (v4: <5 SOL: 1 / 5~20: 2 / 20+: 3, Runner +1, 절대 상한 3) |
| Pair Blacklist | 10-trade 롤링 윈도우: WR ≤ 35% + R:R ≤ 1.0 → 자동 블랙리스트 |
| Stale Signal | 시그널 발생 후 가격 괴리/TVL 급락 감지 시 거부 |

---

## Exit System (7-Priority Cascade)

5초마다 열린 포지션을 점검. 우선순위 순서대로 평가.

| 순위 | 트리거 | 동작 |
|------|--------|------|
| **0** | **Degraded Exit** | sellImpact > 5% or quote 3x fail → 25% 즉시 → 5분 후 75% |
| 1 | **Time Stop** | VS: 30분 / Fib: 60분 초과 시 전량 청산 **(TP1 후 잔여분: +30분 연장)** |
| 2 | **Stop Loss** | price ≤ SL → 전량 청산 (1%+ 이탈 시 경고) |
| 3 | **Take Profit 2** | price ≥ TP2 → 전량 청산 **(Runner: Grade A 전량 trailing / Grade B 50% 매도+50% trailing)** |
| 4 | **Take Profit 1** | price ≥ TP1 → **50% 분할 청산**, SL → 손익분기점 이동 |
| 5 | **Exhaustion Exit** | 2/3 충족 시: 캔들 바디 축소 + 긴 윗꼬리 + 거래량 감소 |
| 6 | **Adaptive Trailing** | ATR(7) × RSI 배수 기반 트레일링. RSI>80: 3.0x / 60–80: 2.0x / <60: 1.0x |

> **v2 추가:**
> - **Degraded Exit (P0):** TP1과 동일한 부분 청산 패턴. Phase 1에서 25% 매도 후 잔여분을 새 trade로 생성, pairAddress로 추적하여 delay 후 phase 2 전량 청산. trade 종료 시 state map 자동 정리. `degradedExitEnabled` (default: false)
> - **Runner Extension (v3 확장):** TP2 도달 + Grade A/B + risk-on + 비degraded → trailing-only 전환. Grade A: 전량, Grade B: 50% TP2 매도 + 50% trailing. SL 변경 DB 영속화. `runnerEnabled` + `runnerGradeBEnabled` (default: false)
> - **TP1 Time Extension (v3):** TP1 50% 청산 후 잔여분 timeStop을 현재+30분으로 재설정. `tp1TimeExtensionMinutes` (default: 30)
> - **Runner Concurrent (v3):** Runner 중 +1 추가 진입 허용 (절대 상한 2). `runnerConcurrentEnabled` (default: false)

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
  Confirmed: kellyScale = 0.25, kellyCap = 0.03 (3%)
  Proven:    kellyScale = 0.25, kellyCap = 0.05 (5%)   ← v2: 1/2→1/4, 12.5%→5%

활성화 전제: EdgeState ∈ {Confirmed, Proven} AND kellyFraction > 0
```

---

## Tech Stack

| 구성요소 | 기술 |
|---------|------|
| Runtime | Node.js 20 LTS + TypeScript |
| DEX | Jupiter Ultra V3 (v6 fallback) |
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
│   │   ├── newLpSniper.ts      # Strategy D (sandbox)
│   │   ├── momentumCascade.ts  # Strategy E (conditional)
│   │   ├── breakoutScore.ts
│   │   ├── adaptiveTrailing.ts # RSI 기반 트레일링 스톱
│   │   ├── exhaustion.ts       # 모멘텀 소진 감지
│   │   ├── indicators.ts       # ATR, avgVolume, highestHigh
│   │   ├── lpMonitor.ts        # LP 안정성 모니터
│   │   └── whaleDetect.ts      # 웨일 감지
│   ├── gate/                   # 5+1 Gate 진입 필터
│   │   ├── index.ts            # evaluateGates() + evaluateGatesAsync()
│   │   ├── securityGate.ts     # Gate 0: 토큰 보안 검증
│   │   ├── quoteGate.ts        # Gate 2B: Jupiter quote 검증
│   │   ├── scoreGate.ts
│   │   ├── fibPullbackScore.ts
│   │   ├── executionViability.ts  # Gate 2A: Slippage-Aware R:R
│   │   ├── safetyGate.ts
│   │   ├── sizingGate.ts
│   │   ├── spreadMeasurer.ts   # Exit Gate: sell-side impact
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
│   │   ├── liquiditySizer.ts   # 3-Constraint 사이저
│   │   └── regimeFilter.ts     # 3-Factor 시장 국면 필터
│   ├── orchestration/          # 거래 라이프사이클
│   │   ├── candleHandler.ts    # 캔들 → 전략 → 게이트 → 시그널
│   │   ├── signalProcessor.ts  # 시그널 → 리스크 → 주문 → 실행
│   │   ├── tradeExecution.ts   # 포지션 모니터링, 청산, TP1 분할
│   │   └── reporting.ts        # 일일 리포트
│   ├── executor/               # Jupiter API 실행 + Jito fallback
│   ├── reporting/              # EdgeTracker + Paper Validation
│   ├── ingester/               # Birdeye OHLCV 수집
│   ├── universe/               # Universe/Watchlist 엔진
│   ├── candle/                 # 캔들/거래 저장소
│   ├── state/                  # 포지션 상태 머신, 실행 잠금
│   ├── notifier/               # Telegram 알림
│   ├── audit/                  # 시그널 감사 로깅
│   └── utils/                  # Config, Logger, Types, Constants
├── config/                     # JSON 설정 파일
├── scripts/                    # CLI 도구 (backtest, paper-report, param-sweep)
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
# .env 파일에 필수 런타임 값 설정:
#   SOLANA_RPC_URL, WALLET_PRIVATE_KEY, DATABASE_URL
# 선택:
#   BIRDEYE_API_KEY, TELEGRAM_BOT_TOKEN, JUPITER_API_KEY, HELIUS_API_KEY

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

### Parameter Sweep (v4)

```bash
# Strategy A 파라미터 최적화
npx ts-node scripts/param-sweep.ts \
  --strategy volume_spike \
  --candles data/BONK-5m.csv \
  --objective sharpeRatio \
  --min-trades 20 \
  --top 10

# Walk-forward 검증
npx ts-node scripts/param-sweep.ts \
  --strategy fib_pullback \
  --candles data/WIF-5m.csv \
  --objective profitFactor \
  --walk-forward 0.7 \
  --top 5

# Cross-validation
npx ts-node scripts/param-sweep.ts \
  --strategy volume_spike \
  --candles data/BONK-5m.csv \
  --cross-validate 3 \
  --top 10
```

Grid search + walk-forward + cross-validation + stability filter 지원. 결과는 콘솔 테이블 + JSON 파일로 출력.

---

## Roadmap

| Phase | 목표 | 상태 |
|-------|------|------|
| **Phase 0** | 기존 봇 안정화, 데드코드 제거 | **완료** |
| **Phase 0.5** | Safety 연결, DrawdownGuard 통합 | **완료** |
| **Phase 1** | Event-driven scanner, Risk Tier, Slippage-aware R:R | **완료** |
| **Phase 2** | Event Catch (Birdeye 중심 + X stream 코드 경로) | **구현 완료, 외부 자격증명 검증 대기** |
| **Phase 3** | Candidate-Driven Execution + Strategy D sandbox | **완료** |
| **Phase 4** | Momentum Cascade / Dynamic sizing | **완료** |
| **v4** | 설정 가능화, Kelly 보간, 동적 사이징, 파라미터 스윕 | **완료** |

### 현재 라이브 전환 게이트

- 50회 이상 Paper Trade 완료
- Win Rate ≥ 40%
- Reward-to-Risk ≥ 2.0
- `USE_JUPITER_ULTRA=true` + `JUPITER_API_KEY` 확보 (체결률 3x 개선)
- 외부 연동 항목은 `TWITTER_BEARER_TOKEN` 및 X filtered stream rule 준비 필요

---

## Known Limitations

| 심각도 | 항목 |
|--------|------|
| High | X Filtered Stream 실연동은 Bearer Token 및 rule/live 검증이 아직 필요 |
| Medium | 포지션 모니터링은 여전히 5초 폴링 기반 |
| Medium | Birdeye WS 의존도가 높아 장기적으로 Helius WS 통합 검토 여지 존재 |
| Medium | TP1(1.5x ATR) 기본값은 자산군에 따라 재튜닝 필요 |

---

## License

Private — Not for distribution.
