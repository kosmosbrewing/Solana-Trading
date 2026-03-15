# Strategy Reference

> Last updated: 2026-03-15 HB10
> Mission: 1 SOL → 100 SOL
> Active strategies: Volume Spike (A), Fib Pullback (C)

---

## 핵심 철학

> "가격이 움직여서 사는 게 아니라, 움직일 이유가 있고, 실제로 움직이기 시작할 때 산다."

봇은 순수 모멘텀 추격자가 아니다. **이벤트 컨텍스트**가 선행하고, **온체인 트리거**가 확인될 때만 진입한다.

```
Stage 1: 왜 움직이는가?  → EventScore (Birdeye Trending → 향후 소셜/뉴스)
Stage 2: 지금 들어가도 되는가?  → Gate System (Safety → Score → Execution → Risk)
```

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
| Multi-TF Alignment | 0–20 | ≥3 TF → 20 / ≥2 → 10 (현재 1 고정) |
| Whale Activity | 0–15 | 감지 시 15 |
| LP Stability | -10–15 | stable +15 / dropping -10 |

Grade: A(≥70) / B(≥50) / C(<50, reject)

### 특성

- **장점:** 단순하고 반복 가능, 과적합 위험 낮음
- **약점:** Multi-TF 미구현(0점 고정), TP1이 마이크로캡에 비해 빡빡할 수 있음

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

- closeStrength: fib0.5 위로 얼마나 강하게 마감했는가
- wickQuality: 아래꼬리가 충분히 길었는가
- bodyRatio: 실체 대비 범위 비율

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

## Gate System

시그널 발생 → 4단 게이트 순차 통과 → 리스크 검증 → 주문 실행.

```
Signal
  │
  ├─ Gate 0: EventScore 컨텍스트 (live: 필수)
  │    └─ eventScore 없음 → reject (no_event_context)
  │
  ├─ Gate 1: 전략 스코어 + EventScore 보너스
  │    ├─ 전략별 5팩터 점수 합산 (0–100)
  │    ├─ EventScore 존재 시 +0~20점 (eventScore/5)
  │    └─ totalScore < 50 → reject (grade_rejected)
  │
  ├─ Gate 2: Execution Viability
  │    ├─ effectiveRR = (reward - cost) / (risk + cost)
  │    ├─ effectiveRR < 1.2 → reject
  │    ├─ 1.2 ≤ effectiveRR < 1.5 → 50% 사이징
  │    └─ effectiveRR ≥ 1.5 → 100% 사이징
  │
  └─ Gate 3: Token Safety
       ├─ Pool TVL < $50K → reject
       ├─ Token age < 24h → reject
       ├─ Top10 holders > 80% → reject
       ├─ LP not burned → 50% 사이징
       └─ Ownership not renounced → 50% 사이징
```

### EventScore 사이징 보너스

| Confidence | 배율 |
|-----------|------|
| high (≥70점 + 코어 메트릭 완비) | 1.2x |
| medium (≥40점) | 1.0x |
| low (<40점) | 0.8x |

### 최종 사이징 공식

```
finalQuantity = riskBasedSize
  × gradeSizeMultiplier      (Grade A: 1.0 / Grade B: 0.5)
  × eventSizeBonus           (high: 1.2 / medium: 1.0 / low: 0.8)
  × executionViability       (full: 1.0 / reduced: 0.5 / reject: 0)
  × safetySizeMultiplier     (1.0 / 0.5 / 0.25)
```

---

## EventScore 산출

소스: Birdeye Trending API (30분 폴링, 상위 20개 토큰)

### 구성 요소 (0–100점)

| 요소 | 배점 | 핵심 기준 |
|------|------|----------|
| Narrative Strength | 0–30 | 랭킹 순위 + 24h 가격변동 + 24h 거래량 |
| Source Quality | 0–20 | 데이터 완성도 (가격/볼륨/유동성/시총 존재 여부) |
| Timing | 3–20 | 감지 후 경과 시간 (≤15분: 20 / ≤1h: 16 / ≤3h: 10) |
| Token Specificity | 8–15 | 심볼/이름/CA 존재 여부 |
| Historical Pattern | 0–15 | 유동성/거래량/시총 수준 |

캐시 TTL: 3시간, 최소 점수: 35점 이상만 저장

---

## 청산 규칙

포지션 모니터링: 5초 간격. 아래 순서로 체크, 첫 번째 매칭에서 청산.

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
| **Calibration** | 20–50 | 2% 고정 | 8% | 30% | 비활성 |
| **Confirmed** | 50–100 | QK ≤6.25% | 15% | 35% | 1/4 Kelly |
| **Proven** | 100+ | HK ≤12.5% | 15% | 40% | 1/2 Kelly |

### Kelly Criterion

```
kellyFraction = winRate - (1 - winRate) / rewardRiskRatio
appliedKelly = kellyFraction × kellyScale
maxRiskPerTrade = min(appliedKelly, kellyCap)
```

활성화 조건: edgeState ∈ {Confirmed, Proven} AND kellyFraction > 0

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

## 전체 파이프라인 요약

```
[캔들 수신]
    │
    ├─ Volume Spike 평가 ──┐
    └─ Fib Pullback 평가 ──┤
                            │
                    [Gate 평가]
                    requireEventScore → EventScore 필수
                    breakoutScore ≥ 50 → Grade B+
                    effectiveRR ≥ 1.2 → 실행 가능
                    tokenSafety 통과 → 안전
                            │
                    [Risk 검증]
                    DrawdownGuard 확인
                    Daily Loss Halt 확인
                    Cooldown 확인
                    포지션 한도 확인
                            │
                    [사이징]
                    3-Constraint min → base size
                    × grade multiplier
                    × event bonus
                    × execution viability
                    × safety multiplier
                            │
                    [실행]
                    Jupiter v6 → 최적 경로 스왑
                    실제 슬리피지 측정
                    포지션 DB 기록
                            │
                    [모니터링] (5초 간격)
                    SL / TP1(50%) / TP2 / TimeStop
                    Exhaustion / Adaptive Trailing
                            │
                    [청산]
                    Jupiter v6 → 스왑
                    PnL 계산 → EdgeTracker 반영
                    Tier 자동 조정
```

---

## 파라미터 전체 목록

### 전략 파라미터

| 파라미터 | 값 | 소스 |
|---------|-----|------|
| `volumeSpikeMultiplier` | 3.0 | config.ts |
| `volumeSpikeLookback` | 20 | config.ts |
| `minBreakoutScore` | 50 | config.ts |
| `minBuyRatio` | 0.65 | config.ts (⚠️ 미연결) |
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

### 이벤트 파라미터

| 파라미터 | 값 | 소스 |
|---------|-----|------|
| `eventPollingIntervalMs` | 1,800,000 (30분) | config.ts |
| `eventTrendingFetchLimit` | 20 | config.ts |
| `eventMinScore` | 35 | config.ts |
| `eventExpiryMinutes` | 180 (3시간) | config.ts |
| `eventMinLiquidityUsd` | 25,000 | config.ts |

### Safety 파라미터

| 파라미터 | 값 | 소스 |
|---------|-----|------|
| `minPoolLiquidity` | $50,000 | config.ts |
| `minTokenAgeHours` | 24 | config.ts |
| `maxHolderConcentration` | 0.80 | config.ts |

---

## 알려진 한계 및 개선 과제

→ 상세 내용은 `ISSUES.md` 참조

| 영역 | 한계 | 우선순위 |
|------|------|---------|
| EventScore | Birdeye만, 30분 지연 | CRITICAL |
| Backtest | Live gate와 불일치 | CRITICAL |
| 페어 추적 | 글로벌만, 페어별 없음 | CRITICAL |
| `minBuyRatio` | 정의만, 필터 미연결 | HIGH |
| AMM 수수료 | 0.3% 하드코딩 | HIGH |
| DrawdownGuard | 미실현 손실 미반영 | HIGH |
| TP1 배치 | 마이크로캡에 빡빡할 수 있음 | MEDIUM |
| Multi-TF | volume_spike에서 0점 고정 | MEDIUM |
| MEV 보호 | 없음 | MEDIUM |
| 시장 레짐 | 감지 없음 | MEDIUM |
