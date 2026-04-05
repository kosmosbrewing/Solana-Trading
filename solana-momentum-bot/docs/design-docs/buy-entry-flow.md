# Buy/Entry Strategy — 전체 흐름 상세

> Status: current
> Updated: 2026-04-05
> Quick reference: [`STRATEGY.md`](../../STRATEGY.md)
> Full spec: [`../product-specs/strategy-catalog.md`](../product-specs/strategy-catalog.md)

## 전체 흐름

```text
캔들/실시간 신호 생성 → Gate 평가 → RiskManager 승인 → Sizing 파이프라인 → 주문 생성 → 실행
```

---

## 1. 전략 세트

### Strategy A: `volume_spike` (5분봉, active core)

| 항목 | 값 |
|---|---|
| 조건 | `volume >= avg[20] × 2.5` AND `close > highestHigh[20]` |
| SL | `entry - ATR(14) × 1.0` |
| TP1 | `entry + ATR(14) × 1.0` (partial 30%, SL→breakeven) |
| TP2 | `entry + ATR(14) × 10.0` (runner) |
| Time Stop | 20분 |

- 소스: `src/strategy/volumeSpikeBreakout.ts`

### Strategy C: `fib_pullback` (5분봉, active core)

| 항목 | 값 |
|---|---|
| 조건 | 임펄스 탐지 → Fib 0.5~0.618 진입 → volume climax → reclaim → 확인봉 |
| SL | `max(fib786 - ATR(14) × 0.3, swingLow)` |
| TP1 | `entry + (swingHigh - entry) × 0.90` |
| TP2 | `entry + (swingHigh - entry) × 1.0` |
| Time Stop | 60분 |

- 소스: `src/strategy/fibPullback.ts`

### `bootstrap_10s` (10초봉, active default)

| 항목 | 값 |
|---|---|
| 조건 | volume acceleration + buy ratio 2-gate (breakout/confirm 불요) |
| Volume multiplier | 1.8 (VPS baseline, code default: 3.0) |
| Min buy ratio | 0.60 (code default: 0.55) |
| Cooldown | 300초 |
| Sparse 대응 | 최근 20개 평균=0이면 wider window(120개) non-zero 평균 fallback |

- Dense path: `calcAvgVolume(prev, 20)` → volumeRatio 계산
- Sparse path: `calcSparseAvgVolume(allPrev, minActive=3)` → wider window fallback
- volumeMcap ratio ≥ 1% → multiplier 1.5로 완화 (mcap boost)
- 소스: `src/strategy/volumeMcapSpikeTrigger.ts`

### `core_momentum` (10초봉, standby)

| 항목 | 값 |
|---|---|
| 조건 | volume surge + 20봉 breakout + 3봉 confirm (3-AND) |
| Volume multiplier | 2.5 |
| Confirm | 3봉 연속 양봉 + 가격 변화 ≥ 2% |
| Cooldown | 300초 |

- bootstrap 대비 signal 밀도 매우 낮음 (noBreakout/confirmFail 차단률 높음)
- 소스: `src/strategy/momentumTrigger.ts`

---

## 2. Gate 체인

### 실행 순서 (코드 기준)

```text
evaluateGatesAsync() — src/gate/index.ts

  1. Gate 0: Security Gate         (async, 최우선)
  2. Gate 1: AttentionScore        (sync — require 시 없으면 reject)
  3. Strategy Score + Attention 합산 (sync)
  4. Hard Reject 검사               (sync — volume_spike 5분봉 buyRatio 등)
  5. Execution Viability            (sync — effective RR 계산)
  6. Grade Reject 검사              (sync — score < 50 → reject)
  7. Quote Gate                     (async — Jupiter price impact)
  8. Exit Gate: Sell Impact         (async — SpreadMeasurer)
  9. Safety Gate                    (별도 호출 — age bucket + LP 검증)
```

### Gate 0: Security Gate

- **Hard reject**: honeypot, freezable (freeze authority), transfer fee (Token-2022), exit-liquidity 부족, holder concentration > 80%
- **Soft reduction**: mintable (50%, `allowMintableWithReduction=true`일 때), exit-liquidity 데이터 없음 (50%)
- **Token-2022**: 프로그램 자체는 hard reject 아님. 분류/flag 용도. `TransferFeeExtension`만 hard reject
- 소스: `src/gate/securityGate.ts`

### Gate 1: AttentionScore / Trending Context

- 라이브 모드 (`requireAttentionScore=true`): attention score 없으면 `not_trending`으로 reject
- Confidence 기반 sizing bonus: high +1.2× / medium 1.0× / low 0.8×
- Attention component → Strategy Score에 0~20점 가산
- 소스: `src/gate/scoreGate.ts:66-91`

### Strategy Score (Gate 2)

- **volume_spike family**: volumeScore(25) + buyRatioScore(25) + multiTfScore(20) + whaleScore(15) + lpScore(15) + mcapVolumeScore(15) + attentionComponent(20)
- **fib_pullback**: impulseStrength + fibPrecision + volumeClimax + reclaimQuality + lpScore + attentionComponent
- **등급**: A(≥70) / B(≥50) / C(<50 → reject)
- **Hard reject**: `volume_spike` 5분봉만 buyRatio < `minBuyRatio` 시 별도 reject. bootstrap_10s/core_momentum은 trigger 내부에 자체 buyRatio gate가 있으므로 제외
- 소스: `src/gate/scoreGate.ts`

### Execution Viability (Gate 2A)

| 기준 | 동작 |
|---|---|
| effectiveRR < 1.2 | reject |
| 1.2 ≤ effectiveRR < 1.5 | 50% sizing |
| effectiveRR ≥ 1.5 | full sizing |

- `effectiveRR = (rewardPct − roundTripCost) / (riskPct + roundTripCost)`
- roundTripCost = entrySlippage + exitSlippage + AMM fee(0.3%) + MEV margin(0.15%)
- 기준: TP2 (설정 가능)
- 소스: `src/gate/executionViability.ts`

### Quote Gate (Gate 2B)

- Jupiter quote 기반 실제 entry price impact 체크
- `maxPoolImpact` 초과 → reject
- Impact > 60% of max → 50% sizing reduction
- 소스: `src/gate/quoteGate.ts`

### Exit Gate: Sell-side Impact

| 기준 | 동작 |
|---|---|
| sellImpact ≤ 1.5% | 패널티 없음 |
| 1.5% < sellImpact ≤ 3% | 50% sizing reduction |
| sellImpact > 3% | reject (`exit_illiquid`) |

- SpreadMeasurer가 position-sized probe로 측정
- 소스: `src/gate/index.ts:282-303`, `src/gate/spreadMeasurer.ts`

### Safety Gate (Gate 4)

- **Age bucket hard floor: 15분** (code default `DEFAULT_HARD_FLOOR_MIN = 15`)
  - runtime_canary에서 env override로 5분 사용 가능 (`AGE_BUCKET_HARD_FLOOR_MIN`)
- **Age bucket 구간별 감산**:

| 구간 | multiplier |
|---|---|
| < 15분 | reject |
| 15분 ~ 1시간 | 0.25× |
| 1시간 ~ 4시간 | 0.50× |
| 4시간 ~ 24시간 | 0.75× |
| ≥ 24시간 | 1.0× |

- **LP/ownership**: LP not burned → 0.5×, ownership not renounced → 0.5× (곱셈 누적)
- **Pool liquidity**: equity 기반 동적 최소 TVL ($50K / $100K / $200K)
- 소스: `src/gate/safetyGate.ts`

---

## 3. Sizing 파이프라인

단일 공식이 아닌 **순차 제약 적용 구조**.

### Step 1: Risk Constraint (RiskManager)

```text
maxRisk = portfolio × riskPerTrade (tier별)
riskSize = maxRisk / stopLossPct
```

### Step 2: Liquidity Constraint (LiquiditySizer)

```text
liquiditySize = poolTVL × maxPoolImpact
emergencyTVL = poolTVL × 0.5
worstSlippage = position / (emergencyTVL/2 + position)
→ 최악 시나리오에서도 maxRisk 이내 보장
```

### Step 3: Multiplier Chain

```text
finalSize = baseSize
  × gradeSizeMultiplier        (A: 1.0 / B: 0.5)
  × attentionSizeBonus         (high: 1.2 / medium: 1.0 / low: 0.8)
  × executionViabilityMult     (full: 1.0 / reduced: 0.5)
  × securitySizeMultiplier     (1.0 / 0.5)
  × quoteSizeMultiplier        (1.0 / 0.5)
  × sellImpactMultiplier       (1.0 / 0.5 / reject)
  × safetySizeMultiplier       (age bucket × LP/ownership)
  × regimeMultiplier           (risk-on: 1.0 / neutral: 0.7 / risk-off: 0)
```

### Step 4: Hard Caps

- 최대 포지션: 포트폴리오의 20% (`MAX_POSITION_PCT`)
- 동시 포지션: equity < 5 SOL → 1개 / 5~20 SOL → 2개 / 20+ SOL → 3개
- 절대 상한: 3개 (`MAX_CONCURRENT_ABSOLUTE`)

---

## 4. Risk Tier (EdgeTracker 자동 조정)

| Tier | Trades | Risk/Trade | Daily Limit | Max DD |
|---|---|---|---|---|
| Bootstrap | `<20` | 1% | 5% | 30% |
| Calibration | `20-49` | 1% | 5% | 30% |
| Confirmed | `50-99` | QK ≤ 3% | 15% | 35% |
| Proven | `100+` | QK ≤ 5% | 15% | 40% |

- Kelly 활성화 전제: EdgeState = Confirmed + `kellyEligible = true`
- Tier 경계에서 Kelly 보간 (lerp): trades 40~60, 85~115
- 소스: `src/risk/riskTier.ts`, `src/reporting/edgeTracker.ts`

---

## 5. 핵심 설계 원칙

1. **이벤트 우선**: 라이브에서 attention/trending 없는 진입 금지
2. **Effective RR 기준**: nominal RR이 아니라 slippage+fee 차감 후 판단
3. **출구 유동성 우선**: 매수 신호 품질보다 sell-side impact가 더 중요
4. **순차 제약 Sizing**: 단일 계산식이 아닌 여러 제약을 파이프라인으로 적용
5. **현재 핵심은 `bootstrap_10s`**: 5분봉 Strategy A/C는 core로 유지하되, 실시간 signal 밀도는 bootstrap이 담당
