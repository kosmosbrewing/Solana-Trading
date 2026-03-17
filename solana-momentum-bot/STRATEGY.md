# Strategy Reference

> Last updated: 2026-03-16
> Mission: 1 SOL → 100 SOL
> Active strategies: Volume Spike (A), Fib Pullback (C)
> Next: Event-driven Scanner Core (Phase 1A)

---

## 핵심 철학

> "가격이 움직여서 사는 게 아니라, 움직일 이유가 있고, 실제로 움직이기 시작할 때 산다."

봇은 순수 모멘텀 추격자가 아니다. **이벤트 컨텍스트**가 선행하고, **온체인 트리거**가 확인될 때만 진입한다.

```
Stage 1: 왜 움직이는가?  → AttentionScore (Birdeye WS + DexScreener 보조)
Stage 2: 지금 들어가도 되는가?  → Gate System (Security → Score → Execution → Risk)
```

### 핵심 제약 — 이 시장에서는 "의도한 손절"보다 "실제 exit 손실"이 더 중요하다

- exit-liquidity가 불충분하면 차트상 SL은 의미 없음
- transfer fee (Token-2022 TransferFeeExtension) 토큰은 실제 수취값이 기대보다 낮음
- security check는 보조 도구이며 안전을 보장하지 않음
- 따라서 **"팔 수 있는 것만 사는"** 원칙이 전략보다 선행

---

## Strategy A: Volume Spike Breakout

### 개요

직전 20봉 대비 볼륨이 3배 이상 폭등하면서 최고가를 돌파할 때 진입. 전형적인 모멘텀 브레이크아웃 전략.

### 진입 조건 (AND)

| 조건 | 수식 | 기본값 |
|------|------|--------|
| 볼륨 스파이크 | `currentVolume ≥ avgVolume[20] × multiplier` | 3.0x |
| 가격 돌파 | `close > highestHigh[20]` | 20봉 최고가 |

### 주문 구조

```
SL  = 현재 봉 저가 (candle.low)
TP1 = entry + ATR(20) × 1.5
TP2 = entry + ATR(20) × 2.5
Time Stop = 30분
```

### TP1 부분 익절

TP1 도달 시 50% 청산, 잔여 50%는:
- SL → 진입가(손익분기)로 이동
- TP1 → 기존 TP2로 교체
- Adaptive trailing stop 적용

### 스코어 산출 (0–100점)

| 팩터 | 배점 | 기준 |
|------|------|------|
| Volume Strength | 0–25 | ≥5.0x → 25 / ≥3.0x → 15 |
| Buy Ratio | 0–25 | ≥0.80 → 25 / ≥0.65 → 15 |
| Multi-TF Alignment | 0–20 | ≥3 TF → 20 / ≥2 → 10 |
| Whale Activity | 0–15 | 감지 시 15 |
| LP Stability | -10–15 | stable +15 / dropping -10 |

Grade: A(≥70) / B(≥50) / C(<50, reject)

### 특성

- **장점:** 단순하고 반복 가능, 과적합 위험 낮음
- **약점:** TP1이 마이크로캡에 비해 빡빡할 수 있음 (M-1 backtest 검증 필요)

---

## Strategy C: Fib Pullback

### 개요

15%+ 임펄스 후 피보나치 0.5–0.618 되돌림 구간에서 볼륨 클라이맥스 + 리클레임 확인 후 진입. 평균 회귀 + 확인 기반 전략.

### 진입 조건 (순차 7단계)

```
1. 임펄스 감지    — 18봉 내 ≥15% 스윙 존재
2. 피보나치 계산  — swingHigh/Low 기준 fib50, fib618, fib786
3. 존 진입       — candle.low가 fib0.5~fib0.618 구간 진입
4. 볼륨 클라이맥스 — 음봉 + 볼륨 ≥ 평균 × 2.5
5. 리클레임       — close > fib0.5 (되돌림 회복)
6. 위크 검증      — 아래꼬리 ≥ 봉 범위의 40%
7. 확인 봉        — 리클레임 다음 봉에서 실행
```

### 주문 구조

```
SL  = max(fib786 - ATR(14) × 0.3, swingLow)
TP1 = entry + (swingHigh - entry) × 0.90
TP2 = entry + (swingHigh - entry) × 1.0
Time Stop = 60분
```

### 리클레임 품질 점수

```
reclaimQuality = closeStrength × 0.55 + wickQuality × 0.30 + bodyRatio × 0.15
```

### 스코어 산출 (0–100점)

| 팩터 | 배점 | 기준 |
|------|------|------|
| Impulse Strength | 0–25 | ≥1.5x → 25 / ≥1.25x → 18 / ≥1.0x → 10 |
| Fib Precision | 0–25 | ≥0.75 → 25 / ≥0.55 → 18 / ≥0.35 → 10 |
| Volume Climax | 0–20 | ≥base×1.5 → 20 / ≥base×1.2 → 15 / ≥base → 10 |
| Reclaim Quality | 0–15 | ≥0.75 → 15 / ≥0.55 → 10 / ≥0.35 → 5 |
| LP Stability | -10–15 | stable +15 / dropping -10 |

Grade: A(≥70) / B(≥50) / C(<50, reject)

### 특성

- **장점:** 확인 단계가 많아 가짜 시그널 필터링에 강함, 리스크/리워드 명확
- **약점:** 느린 진입(확인 대기), 강한 모멘텀 초기 구간을 놓칠 수 있음

---

## Dual-Lane Scanner Architecture (신규)

> 현재 병목: 단일 `TARGET_PAIR_ADDRESS`만 감시 → 기회 탐지 불가

스캐너를 두 갈래로 분리한다. 같은 필터를 사용하면 전략 간 충돌이 발생하기 때문이다.

### Lane A: Mature Breakout (Strategy A/C 대상)

```
필터:
  age > 60분
  exit-liquidity gate 통과
  token security (honeypot, freezable, mintable, transfer fee) 통과
  holder concentration ≤ 80%
  volume spike + range compression + Jupiter quote impact 양호

소스:
  Birdeye WS → price / txs / OHLCV 실시간 수신
  Universe refresh → pool health 모니터링
```

### Lane B: Fresh Listing (향후 Strategy D 대상)

```
필터:
  age 3~20분 (초신규 구간)
  고정 티켓 사이즈 (리스크% 사이징 아님, "복권값")
  별도 지갑 / 별도 일일 손실 한도
  강화된 security gate

소스:
  Birdeye WS → SUBSCRIBE_TOKEN_NEW_LISTING / SUBSCRIBE_NEW_PAIR
  Birdeye token_security + exit-liquidity 엔드포인트
```

### 왜 분리하는가

| | Lane A (Mature) | Lane B (Fresh) |
|--|--|--|
| 목적 | 검증된 전략 실행 | 옵션성 베팅 |
| 사이징 | risk-based (3-Constraint) | 고정 티켓 (0.01~0.05 SOL) |
| 손절 | 전략별 SL | 전량 손실 감수 |
| 지갑 | 메인 | 별도 (격리) |
| 우선순위 | Phase 1A | Phase 3 (Jito 전제) |

---

## Event-driven Scanner Core (Phase 1A)

> "더 많은 전략"이 아니라 "더 많은 종목을 더 빨리, 실제로 팔 수 있는 것만 고르는 코어"를 먼저 만든다.

### 데이터 소스 역할 분담

| 소스 | 역할 | 갱신 주기 |
|------|------|----------|
| **Birdeye WebSocket** | 실시간 탐지 (price, txs, OHLCV, new listing, new pair) | 실시간 |
| **DexScreener API** | 주목도 보강 (boosts, ads, paid orders, token profiles) | 1~5분 |
| **Jupiter Quote API** | price impact / route quality / freshness gate | 진입 전 |
| **Birdeye REST** | token_security + exit-liquidity gate | 진입 전 |

### Birdeye WebSocket 구독 타입

**URL:** `wss://public-api.birdeye.so/socket/solana?x-api-key={API_KEY}`

```
SUBSCRIBE_PRICE              — 실시간 가격 (5초 polling 대체)
SUBSCRIBE_TXS                — 트랜잭션 피드 (volume spike 조기 감지)
SUBSCRIBE_PRICE (w/ OHLCV)   — 캔들 스트림 (1s/15s/30s/1m~1M, ingester 대체)
SUBSCRIBE_TOKEN_NEW_LISTING  — 신규 토큰 리스팅 (address, liquidity, liquidityAddedAt)
SUBSCRIBE_NEW_PAIR           — 신규 페어 생성
SUBSCRIBE_BASE_QUOTE_PRICE   — 임의 페어 가격 변동
```

**플랜 요구사항:** WS 연결은 Premium Plus(500 conn) 이상, Free/Standard는 WS 미지원.

### DexScreener 피처 (랭킹 보조, 매수 트리거 아님)

**Base URL:** `https://api.dexscreener.com` (API key 필요, 60 req/min)

```
GET /token-boosts/latest       — 최근 부스트된 토큰 (amount, claimDate)
GET /token-boosts/top          — 가장 많이 부스트된 토큰 (amount, totalAmount)
GET /orders/v1/solana/:token   — 유료 주문/광고 존재 여부
GET /token-profiles/latest     — 최근 프로필 업데이트된 토큰
```

> DexScreener 데이터는 "사람들이 돈 주고 노출시키는 토큰인지" = 마케팅 강도 피처.
> 절대 매수 트리거로 사용하지 않는다.

### Jupiter Quote Gate

> **v6 (`quote-api.jup.ag/v6`)는 deprecated.** Ultra API (`api.jup.ag`, portal.jup.ag에서 API key 발급)로 마이그레이션 필요.
> Ultra V3: 0.01% 분할 라우팅, Jupiter Beam MEV 보호 (50-66% faster landing), gasless swap 지원.

진입 직전 실행 가능성 검증:

```typescript
// Jupiter Ultra API (api.jup.ag, X-API-Key 헤더)
GET /swap/quote?inputMint=SOL&outputMint={token}&amount={estimatedSize}

검증 항목:
  - priceImpact ≤ maxPoolImpact
  - route 존재 여부
  - quote freshness (stale quote 거부)
```

**Price API V3** (참조가격): `GET https://api.jup.ag/price/v3/price?ids=SOL`

### Security Gate 강화

> **플랜 요구사항:** token_security → Premium+, exit-liquidity → Premium+

```
Birdeye GET /defi/token_security (X-API-KEY 헤더):
  - is_honeypot → reject
  - is_freezable → reject
  - is_mintable → reject (또는 사이징 50%)
  - has_transfer_fee → reject (Token-2022 TransferFeeExtension)
  - freeze_authority_present → reject
  - top10_holder_pct > 80% → reject

Birdeye GET /defi/v3/token/exit-liquidity (단일 토큰, 2025-06 추가):
  - exit-liquidity 실측 (null이면 미지원 토큰 → 사이징 50%)
  - sell-side depth가 entry size 대비 충분한지

보조 — Birdeye /defi/v3/token/trade-data/single:
  - 24h sell volume / buy volume ratio
  - 최근 대형 매도 체결 존재 여부
```

### Watchlist Score 체계 (AttentionScore 대체)

```
WatchlistScore = f(
  birdeye_trending_rank,        // 기존 AttentionScore
  dexscreener_boost_count,      // 마케팅 강도
  dexscreener_paid_orders,      // 유료 노출
  volume_24h_change,            // 거래량 추세
  unique_buyers_trend,          // 매수자 다양성
  social_mention_count          // 향후 X/Telegram (Phase 2+)
)
```

> WatchlistScore는 **watchlist 진입 우선순위**를 결정할 뿐, 매수 결정은 전략 시그널이 한다.

---

## Gate System

시그널 발생 → 5단 게이트 순차 통과 → 리스크 검증 → 주문 실행.

```
Signal
  │
  ├─ Gate 0: Security Gate (신규 — 최우선)
  │    ├─ Birdeye token_security → honeypot/freezable/mintable/transfer_fee reject
  │    ├─ exit-liquidity 프록시 → sell-side depth 검증
  │    └─ Token-2022 transfer fee → reject
  │
  ├─ Gate 1: AttentionScore 컨텍스트 (live: 필수)
  │    └─ WatchlistScore 없음 → reject (not_trending)
  │
  ├─ Gate 2: 전략 스코어
  │    ├─ 전략별 5팩터 점수 합산 (0–100)
  │    ├─ AttentionScore 존재 시 +0~20점 (eventScore/5)
  │    └─ totalScore < 50 → reject (grade_rejected)
  │
  ├─ Gate 3: Execution Viability
  │    ├─ Jupiter quote → 실제 price impact 확인
  │    ├─ effectiveRR = (reward - cost) / (risk + cost)
  │    ├─ effectiveRR < 1.2 → reject
  │    ├─ 1.2 ≤ effectiveRR < 1.5 → 50% 사이징
  │    └─ effectiveRR ≥ 1.5 → 100% 사이징
  │
  └─ Gate 4: Token Safety
       ├─ Pool TVL < $50K → reject
       ├─ Token age < 60min (Lane A) → reject
       ├─ Top10 holders > 80% → reject
       ├─ LP not burned → 50% 사이징
       └─ Ownership not renounced → 50% 사이징
```

### 최종 사이징 공식

```
finalQuantity = riskBasedSize
  × gradeSizeMultiplier      (Grade A: 1.0 / Grade B: 0.5)
  × eventSizeBonus           (high: 1.2 / medium: 1.0 / low: 0.8)
  × executionViability       (full: 1.0 / reduced: 0.5 / reject: 0)
  × safetySizeMultiplier     (1.0 / 0.5 / 0.25)
  × regimeMultiplier         (risk-on: 1.0 / neutral: 0.7 / risk-off: 0)
```

---

## Market Regime Filter (Phase 1B — 앞당김)

> 브레이크아웃 전략은 시장이 risk-on일 때와 risk-off일 때 follow-through가 완전히 다르다.
> 거시 필터 1개 + 내부 마이크로스트럭처 필터 2개가 실전적이다.

### 3-Factor Regime Classification

| 팩터 | 소스 | 판단 기준 |
|------|------|----------|
| **SOL 4H Trend** | Birdeye SOL/USD 4H OHLCV | EMA20 > EMA50 = bullish, 역전 = bearish |
| **Watchlist Breadth** | 내부 scanner 결과 | 후보군 중 고점돌파 후 2봉 연장 성공 비율 |
| **Recent Follow-through** | 최근 1~2일 트레이드 결과 | breakout 후 TP1 도달률 |

### Regime → 행동 매핑

| Regime | 조건 | 행동 |
|--------|------|------|
| **Risk-on** | SOL bullish + breadth > 50% + follow-through > 40% | 정상 운영 |
| **Neutral** | 2/3 조건 충족 | 사이징 70% |
| **Risk-off** | SOL bearish + breadth < 30% + follow-through < 25% | 신규 진입 중단 |

---

## 청산 규칙

포지션 모니터링: **Birdeye WS price 스트림** (5초 polling 대체). 아래 순서로 체크, 첫 번째 매칭에서 청산.

| 우선순위 | 청산 조건 | 적용 대상 |
|---------|----------|----------|
| 1 | **Time Stop** — 경과시간 ≥ 제한 | Spike: 30분, Fib: 60분 |
| 2 | **Stop Loss** — price ≤ SL | 전체 |
| 3 | **Take Profit 2** — price ≥ TP2 | 전체 (전량 청산) |
| 4 | **Take Profit 1** — price ≥ TP1 | 전체 (50% 부분 청산) |
| 5 | **Exhaustion Exit** — 2+ 소진 지표 | 전체 |
| 6 | **Adaptive Trailing** — price ≤ peak - ATR(7) | 전체 |

### Exhaustion 지표 (2개 이상 충족 시 청산)

- 실체가 직전 봉의 50% 미만
- 윗꼬리가 실체의 2배 이상
- 거래량이 직전 봉의 60% 미만

### Adaptive Trailing Stop

```
trail = peakPrice - ATR(7)
if currentPrice ≤ trail → 청산
```

HWM(High Water Mark)은 DB에 저장되어 봇 재시작 후에도 유지.

---

## Risk Tier System

EdgeTracker의 트레이드 이력 기반 자동 단계 조정.

| Tier | 트레이드 수 | Risk/Trade | Daily Limit | Max DD | Kelly |
|------|-----------|-----------|-------------|--------|-------|
| **Bootstrap** | <20 | 1% 고정 | 5% | 30% | 비활성 |
| **Calibration** | 20–50 | 1% 고정 | 5% | 30% | 비활성 |
| **Confirmed** | 50–100 | QK ≤6.25% | 10% | 35% | 1/4 Kelly |
| **Proven** | 100+ | HK ≤12.5% | 15% | 40% | 1/2 Kelly |

### 피드백 반영 — Bootstrap에서 공격적 사이징 금지

> "Bootstrap 2~3% risk/trade는 CEX 대형자산 단타에서도 공격적인 편인데, 온체인 마이크로캡에서는 더 위험하다.
> 의도한 2%가 exit-liquidity 부족으로 실현 손실에서는 훨씬 크게 튈 수 있다."

- Bootstrap/Calibration 모두 **1% 고정** (이전 Calibration 2% → 1%로 하향)
- Kelly는 라이브 표본 충분히 쌓인 후에만 활성화 (과대사이징 방지)

### 전략별 사이징 분리

| 전략 유형 | 사이징 방식 | 근거 |
|----------|-----------|------|
| A/C (코어 브레이크아웃/리클레임) | fixed-fraction + hard notional cap | 검증된 전략 |
| D (신규 LP 실험) | 고정 티켓 사이즈 (0.01~0.05 SOL) | "잃어도 되는 복권값" |
| E (모멘텀 캐스케이드) | A 확장 — 총 리스크 1R 이내 | Phase 4 이후 |

### Kelly Criterion

```
kellyFraction = winRate - (1 - winRate) / rewardRiskRatio
appliedKelly = kellyFraction × kellyScale
maxRiskPerTrade = min(appliedKelly, kellyCap)
```

활성화 조건: edgeState ∈ {Confirmed, Proven} AND kellyFraction > 0 AND 라이브 표본 ≥ 50

### Drawdown Guard

```
drawdownPct = (peakBalance - currentBalance) / peakBalance

if drawdownPct ≥ maxDrawdownPct → 전 트레이딩 중단
if balance ≥ peakBalance × recoveryPct (85%) → 재개
```

### 추가 보호 장치

| 장치 | 기준 | 행동 |
|------|------|------|
| Daily Loss Halt | dailyPnL < -(equity × maxDailyLoss) | 당일 트레이딩 중단 |
| Cooldown | 3연패 | 30분 대기 |
| Max Concurrent | 1 포지션 | 추가 진입 차단 |
| Max Exposure | 잔고의 20% | 단일 포지션 한도 |

---

## Position Sizing: 3-Constraint Model

세 가지 제약 중 최솟값으로 결정.

### 1. Risk Constraint

```
maxRisk = portfolio × maxRiskPerTrade (tier에서 결정)
riskSize = maxRisk / stopLossPct
```

### 2. Liquidity Constraint

```
liquiditySize = poolTVL × maxPoolImpact (2%)
```

### 3. Emergency Constraint

TVL이 50% 급감했을 때에도 최대 손실이 maxRisk 이내인 사이즈.

```
emergencyTVL = poolTVL × 0.5
worstSlippage = position / (emergencyTVL/2 + position)
loss = position × worstSlippage + fees
constraint: loss ≤ maxRisk
```

### Slippage 추정

Constant product AMM 기준:

```
priceImpact = tradeSize / (poolTVL/2 + tradeSize)
totalSlippage = priceImpact + AMMfee(0.3%) + MEVmargin(0.1%)
```

슬리피지 > 1% 시 사이즈 추가 감축.

---

## Execution Viability (R:R Gate)

### 비용 모델

```
roundTripCost = entrySlippage + exitSlippage + AMMfee(0.3%) + MEV(0.1%)
effectiveRR = (rewardPct - roundTripCost) / (riskPct + roundTripCost)
```

### 판정

| effectiveRR | 판정 | 사이징 |
|-------------|------|--------|
| < 1.2 | reject | 0% |
| 1.2 – 1.5 | pass (reduced) | 50% |
| ≥ 1.5 | pass (full) | 100% |

---

## Strategy D: New LP Sniper (실험 트랙 — Phase 3)

> **코어 전략이 아닌 별도 지갑의 옵션성 베팅.**
> Jito 도입이 전제 조건이며, Phase 3 이전에는 라이브 금지.

### 전제 조건

1. **Jito bundle 통합 완료**
   - API: `POST https://mainnet.block-engine.jito.wtf/api/v1/bundles`
   - 최대 5 TX/bundle, all-or-nothing 원자적 실행
   - tip: 마지막 TX에 SOL transfer (min 1,000 lamports, 8개 tip account 중 랜덤 선택)
   - **DontFront MEV 보호**: `jitodontfront...` 계정을 instruction에 read-only로 추가 → 샌드위치 방지
   - SDK: `jito-js-rpc` (JS)
2. **강화된 Security Gate** — honeypot, freezable, mintable, freeze authority, transfer fee 전부 체크
3. **별도 지갑** — 메인 자본과 완전 격리
4. **별도 일일 손실 한도** — 메인 전략과 독립

### 위험 요인

- 신규 토큰은 security gate를 더 세게 걸어야 함
- Birdeye security: honeypot, freezable, mintable, freeze authority, transfer fees, top holders
- Token-2022 TransferFeeExtension → 매 전송마다 자동 fee → 차트가 좋아 보여도 기대값 파괴
- Jito 없이 초저지연 스나이핑은 MEV 봇에 의해 샌드위치 당함

### 진입 로직 (초안)

```
Birdeye WS: SUBSCRIBE_TOKEN_NEW_LISTING / SUBSCRIBE_NEW_PAIR
  → age 3~20분 필터
  → Birdeye token_security 전항목 통과
  → exit-liquidity 최소 threshold
  → Jupiter quote gate (route 존재 + impact < 5%)
  → Jito bundle로 TX 전송
  → 고정 티켓: 0.01~0.05 SOL (risk% 사이징 아님)
```

---

## Strategy E: Momentum Cascade (Phase 4 — 조건부)

> Strategy A의 확장 기능이지, 별도 메인 전략이 아니다.
> A가 라이브에서 기대값 양수 확인된 뒤에만 검토한다.

### 활성화 조건

- Strategy A가 라이브에서 **expectancy > 0** 확인 (최소 50 트레이드)
- 첫 진입이 **+1R 이상** 진행된 상태
- 추가 진입은 **돌파 후 재압축/재가속**에서만
- **총 리스크는 최초 1R을 넘기지 않음**
- 추가 진입 후 stop은 **전체 포지션 기준으로 재산정**

### 비활성화 근거

피라미딩은 초기 진입 전략이 기대값 양수일 때만 효율적이다.
검증 전 추가 진입 = 수익 극대화가 아니라 슬리피지 확대 + 손실 가속.

---

## 이벤트 파이프라인 역할 정의

### X (Twitter) — 주목도 피처 (매수 트리거 아님)

> X Filtered Stream P99 지연 ≈ 6~7초. 1분봉 브레이크아웃 진입 트리거로는 늦다.
> 따라서 X는 "들어가라"가 아니라 **WatchlistScore를 올리는 피처**로만 사용한다.

- 특정 키워드/인플루언서 멘션 감지
- WatchlistScore에 social_mention_count로 반영
- 우선순위: Phase 2+ (DexScreener 보조 이후)

### Telegram — 운영 편의성 (현 상태 유지)

> Telegram Bot API는 "내 봇이 받는 업데이트" 전달 메커니즘이다.
> 알파 소스가 아니라 알림/모니터링 채널.

### DexScreener — 마케팅 강도 피처 (Phase 1A에서 도입)

> 토큰은 유동성 풀 생기고 첫 거래 발생 시 자동 리스팅.
> boost/ad/order = "돈 주고 노출시키는지" = 깨끗한 ranking 피처.
> **매수 트리거가 되면 안 된다.**

---

## 전체 파이프라인 요약 (개선안)

```
[Birdeye WS]
    │
    ├─ price / txs / OHLCV → Lane A 실시간 모니터링
    ├─ new_listing / new_pair → Lane B 후보 수집 (Phase 3)
    │
    ├─ [DexScreener enrichment] → WatchlistScore 보강
    │
    ├─ [Regime Filter] ← SOL 4H + Breadth + Follow-through
    │    └─ risk-off → 신규 진입 중단
    │
    ├─ Volume Spike 평가 ──┐
    └─ Fib Pullback 평가 ──┤
                            │
                    [Gate 평가]
                    Gate 0: Security (honeypot/freeze/transfer_fee)
                    Gate 1: AttentionScore (WatchlistScore)
                    Gate 2: 전략 스코어 ≥ 50
                    Gate 3: Jupiter quote → effectiveRR ≥ 1.2
                    Gate 4: Token Safety
                            │
                    [Risk 검증]
                    DrawdownGuard / Daily Loss Halt
                    Cooldown / 포지션 한도 / Regime
                            │
                    [사이징]
                    3-Constraint min → base size
                    × grade × event × execution × safety × regime
                            │
                    [실행]
                    Jupiter Swap API → 최적 경로 스왑
                    실제 슬리피지 측정
                    포지션 DB 기록
                            │
                    [모니터링] (Birdeye WS price 스트림)
                    SL / TP1(50%) / TP2 / TimeStop
                    Exhaustion / Adaptive Trailing
                            │
                    [청산]
                    Jupiter Swap API → 스왑
                    PnL 계산 → EdgeTracker 반영
                    Tier 자동 조정
```

---

## 구현 로드맵 (피드백 반영 최종안)

### Phase 1A — Event-driven Scanner Core ← **지금 시작**

| 항목 | 상세 |
|------|------|
| Birdeye WS 연결 | price, txs, OHLCV 구독 (5초 polling 대체) |
| Multi-pair watchlist | TARGET_PAIR_ADDRESS 단일 → 동적 watchlist |
| DexScreener enrichment | boost/ad/order → WatchlistScore 피처 |
| Jupiter quote gate | 진입 전 실제 price impact 검증 |
| Security gate 강화 | Birdeye token_security + exit-liquidity |
| 결과물 | watchlist score 기반 자동 후보 관리 |

### Phase 1B — Regime + Paper Trading

| 항목 | 상세 |
|------|------|
| Market Regime Filter | SOL 4H + breadth + follow-through |
| Paper trade 측정 | false positive, price impact, quote decay, MAE/MFE |
| Strategy A/C 검증 | multi-pair 환경에서 기대값 확인 |

### Phase 2 — Core Live (A/C만)

| 항목 | 상세 |
|------|------|
| 소액 라이브 | Bootstrap tier (1% risk) |
| X 피처 추가 | WatchlistScore social_mention_count |
| Historical EventScore 수집 | C-1 해결 → backtest 신뢰도 확보 |

### Phase 3 — Strategy D Sandbox

| 항목 | 상세 |
|------|------|
| Jito 통합 | fast landing, MEV protection, revert protection |
| 별도 지갑 | 메인 자본 격리 |
| 별도 일일 손실 한도 | 코어 전략과 독립 |
| New LP Sniper | "코어 전략" 아닌 "옵션성 베팅" |

### Phase 4 — Momentum Cascade / Dynamic Sizing

| 항목 | 상세 |
|------|------|
| Strategy E | A가 라이브에서 양수 기대값 확인 후 |
| Fractional Kelly | 라이브 표본 ≥ 50 트레이드 후 |
| TP1 튜닝 | 2.0x/2.5x ATR backtest 비교 (M-1) |

### 금지 사항

- Phase 2 전에 Strategy D/E 라이브 금지
- Jito 없이 Strategy D 라이브 금지
- 라이브 표본 < 50 상태에서 Kelly 활성화 금지
- DexScreener/X 데이터를 매수 트리거로 사용 금지

---

## 파라미터 전체 목록

### 전략 파라미터

| 파라미터 | 값 | 소스 |
|---------|-----|------|
| `volumeSpikeMultiplier` | 3.0 | config.ts |
| `volumeSpikeLookback` | 20 | config.ts |
| `minBreakoutScore` | 50 | config.ts |
| `minBuyRatio` | 0.65 | config.ts |
| `exhaustionThreshold` | 2 | config.ts |
| `fibImpulseWindowBars` | 18 | config.ts |
| `fibImpulseMinPct` | 0.15 | config.ts |
| `fibEntryLow` | 0.5 | config.ts |
| `fibEntryHigh` | 0.618 | config.ts |
| `fibInvalidation` | 0.786 | config.ts |
| `fibVolumeClimaxMultiplier` | 2.5 | config.ts |
| `fibMinWickRatio` | 0.4 | config.ts |

### 리스크 파라미터

| 파라미터 | 값 | 소스 |
|---------|-----|------|
| `maxRiskPerTrade` | 0.01 (tier overrides) | config.ts |
| `maxDailyLoss` | 0.05 (tier overrides) | config.ts |
| `maxDrawdownPct` | 0.30 (tier overrides) | config.ts |
| `recoveryPct` | 0.85 | config.ts |
| `maxSlippage` | 0.01 | config.ts |
| `maxPoolImpact` | 0.02 | config.ts |
| `emergencyHaircut` | 0.50 | config.ts |
| `cooldownMinutes` | 30 | config.ts |
| `maxConsecutiveLosses` | 3 | config.ts |

### 실행 파라미터

| 파라미터 | 값 | 소스 |
|---------|-----|------|
| `MIN_EFFECTIVE_RR_REJECT` | 1.2 | executionViability.ts |
| `MIN_EFFECTIVE_RR_PASS` | 1.5 | executionViability.ts |
| `AMM_FEE_PCT` | 0.003 | executionViability.ts |
| `MEV_MARGIN_PCT` | 0.001 | executionViability.ts |
| `maxRetries` | 3 | config.ts |
| `txTimeoutMs` | 30,000 | config.ts |

### Jupiter 파라미터 (Phase 1A에서 마이그레이션)

| 파라미터 | 현재 값 | Phase 1A 후 |
|---------|--------|------------|
| `jupiterApiUrl` | `https://quote-api.jup.ag/v6` (deprecated) | `https://api.jup.ag` (Ultra API) |

### 이벤트 파라미터 (Phase 1A에서 변경 예정)

| 파라미터 | 현재 값 | Phase 1A 후 |
|---------|--------|------------|
| `eventPollingIntervalMs` | 1,800,000 (30분) | Birdeye WS로 대체 |
| `eventTrendingFetchLimit` | 20 | WatchlistScore로 대체 |
| `eventMinScore` | 35 | 유지 |
| `eventExpiryMinutes` | 180 (3시간) | 유지 |
| `eventMinLiquidityUsd` | 25,000 | 유지 |

### Safety 파라미터

| 파라미터 | 값 | 소스 |
|---------|-----|------|
| `minPoolLiquidity` | $50,000 | config.ts |
| `minTokenAgeHours` | 1 (Lane A), 0.05 (Lane B) | config.ts |
| `maxHolderConcentration` | 0.80 | config.ts |

---

## 한 문장 요약

> **지금은 "더 많은 전략"을 추가할 때가 아니라, "더 많은 종목을 더 빨리, 그러나 실제로 팔 수 있는 것만 고르는 코어"를 먼저 만들 때다.**
