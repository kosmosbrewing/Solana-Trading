# Trading Strategy — Quick Reference

> Last updated: 2026-03-19
> Mission: 1 SOL → 100 SOL
> 상세 기술 문서: `docs/product-specs/strategy-catalog.md`

---

## 원칙

> "가격이 움직여서 사는 게 아니라, 움직일 이유가 있고, 실제로 움직이기 시작할 때 산다."

1. **이벤트 선행** — AttentionScore가 없으면 진입하지 않는다
2. **온체인 확인** — 브레이크아웃은 트리거일 뿐, 게이트를 통과해야 실행
3. **팔 수 있는 것만 산다** — exit-liquidity 검증이 전략보다 선행
4. **모든 거래를 추적** — source attribution 필수

---

## 전략 요약

### Strategy A: Volume Spike Breakout (`volume_spike`) — 코어

5분봉 20봉 최고가 돌파 + 거래량 3배 이상 급증 시 진입.

```
진입: volume ≥ avg[20] × 3.0 AND close > highestHigh[20]
SL:   현재 캔들 저가
TP1:  entry + ATR(20) × 1.5  → 50% 청산, SL → 손익분기
TP2:  entry + ATR(20) × 2.5  → 전량 청산
Time: 30분
```

**스코어 (0–100):** Volume(25) + BuyRatio(25) + MultiTF(20) + Whale(15) + LP(-10~15) + McapVol(10)
**등급:** A(≥70) / B(≥50) / C(<50, 거부) — `min(100, total)` 캡

### Strategy C: Fib Pullback (`fib_pullback`) — 코어

15%+ 임펄스 후 피보나치 0.5–0.618 되돌림 → 볼륨 클라이맥스 + 리클레임 확인 후 진입.

```
진입: 7단계 순차 확인 (임펄스 → fib 계산 → 존 진입 → 볼륨 → 리클레임 → 위크 → 확인봉)
SL:   max(fib786 - ATR(14) × 0.3, swingLow)
TP1:  entry + (swingHigh - entry) × 0.90
TP2:  entry + (swingHigh - entry) × 1.0
Time: 60분
```

**스코어 (0–100):** Impulse(25) + FibPrecision(25) + VolClimax(20) + Reclaim(15) + LP(-10~15)

### Strategy D: New LP Sniper (`new_lp_sniper`) — 실험 (sandbox)

신규 토큰 리스팅 3~20분 내 스나이핑. **별도 지갑, 고정 티켓(0.02 SOL), Jito 필수.**

### Strategy E: Momentum Cascade (`momentum_cascade`) — 조건부

Strategy A 확장 add-on. TP1 도달 + 1R 이상 진행 + 재압축/재가속 감지 시 추가 진입. 총 리스크 1R 이내.
**활성화 조건:** Strategy A expectancy > 0, 최소 50 trades.

---

## Gate System (5+1 순차 필터)

```
Gate 0: Security (async)    — honeypot, freeze, mintable, transferFee → reject
Gate 1: AttentionScore      — 트렌딩 화이트리스트 (live: 필수)
Gate 2A: Execution Viability — effectiveRR < rrReject(1.2) → reject / < rrPass(1.5) → size 50% (v4: 설정 가능)
Gate 2B: Quote Gate (async)  — Jupiter price impact ≤ 2% (>1.2% → size 50%)
Gate 3: Strategy Score       — 합산 < 50점 → reject
Gate 4: Token Safety         — TVL < $50K / age bucket sizing / holder > 80% → reject
Exit Gate (async)            — sellImpact > 3% → reject / > 1.5% → size 50%
```

---

## Risk Tier (자동 단계 조정)

| Tier | Trades | Risk/Trade | Daily Limit | Max DD | Kelly |
|------|--------|-----------|-------------|--------|-------|
| Bootstrap | <20 | 1% 고정 | 5% | 30% | 비활성 |
| Calibration | 20–49 | 1% 고정 | 5% | 30% | 비활성 |
| Confirmed | 50–99 | QK ≤3% | 15% | 35% | 1/4 Kelly |
| Proven | 100+ | QK ≤5% | 15% | 40% | 1/4 Kelly |

> **v2 변경 (2026-03-18):** Confirmed kellyCap 6.25%→3%, Proven 1/2→1/4 Kelly + cap 12.5%→5%.
> 근거: 마이크로캡 exit-liquidity 부족 시 의도한 리스크 대비 실현 손실이 훨씬 클 수 있다. 생존 우선.
>
> **v4 변경 (2026-03-19):** 선형 보간(lerp) 도입 — tier 경계에서 리스크 급변(cliff) 방지.
> - Calibration→Confirmed (trades 40~60): 1%에서 Kelly 값까지 점진 증가
> - Confirmed→Proven (trades 85~115): Confirmed cap에서 Proven cap까지 점진 증가

**승급:** Confirmed(WR≥45%, R:R≥1.5, Sharpe≥0.5) / Proven(WR≥50%, R:R≥1.75, Sharpe≥0.75)
**강등:** 최근 15~20 trades 기준 WR/R:R 하락 시 한 단계 하향

---

## Position Sizing: 3-Constraint

```
finalSize = min(riskSize, liquiditySize, emergencySize)

riskSize      = portfolio × riskPerTrade / stopLoss%
liquiditySize = poolTVL × maxPoolImpact%
emergencySize = TVL 50% 급락에서도 loss ≤ maxRisk

hardCap = portfolio × MAX_POSITION_PCT (기본 20%)
```

> **v4 변경 (2026-03-19):**
> - `MAX_POSITION_PCT` env var로 설정 가능 (기본 0.20)
> - `maxPoolImpact` equity 기반 동적 축소: <5 SOL → 2% / 5~20 SOL → 1.5% / 20+ SOL → 1%
> - `minPoolLiquidity` equity 기반 동적 상향: <5 SOL → $50K / 5~20 SOL → $100K / 20+ SOL → $200K

**최종 사이징 승수:**

```
base × grade(A:1.0/B:0.5) × event(high:1.2/med:1.0/low:0.8)
     × executionViability(full:1.0/reduced:0.5)
     × safety(1.0/0.5/0.25) × regime(on:1.0/neutral:0.7/off:0)
     × sellImpact(≤1.5%:1.0/>1.5%:0.5/>3%:reject)
```

---

## 비용 모델

```
roundTripCost = entrySlippage + exitSlippage + AMMfee(0.5%) + MEVmargin(0.15%)
effectiveRR   = (reward% - roundTripCost) / (risk% + roundTripCost)
```

---

## Exit (7-Priority Cascade, 5초 모니터링)

| 순위 | 트리거 | 동작 |
|------|--------|------|
| **0** | **Degraded Exit** | sellImpact > 5% 또는 quote 3연속 실패 → 25% 즉시 매도 → 5분 후 75% 매도 |
| 1 | Time Stop | VS 30분 / Fib 60분 / Cascade 120분 **(TP1 후 잔여분: +30분 연장)** |
| 2 | Stop Loss | price ≤ SL → 전량 청산 |
| 3 | Take Profit 2 | price ≥ TP2 → 전량 청산 **(Runner: Grade A 전량 trailing / Grade B 50% 매도+50% trailing)** |
| 4 | Take Profit 1 | price ≥ TP1 → 50% 청산, SL → 손익분기 |
| 5 | Exhaustion | 2/3 지표 충족: 바디 축소 + 긴 윗꼬리 + 거래량 감소 |
| 6 | Adaptive Trailing | ATR(7) 기반, RSI 배수 조절 |

> **v2 추가 (2026-03-18):**
> - **Degraded Exit (P0):** 유동성 소실 감지 시 2단계 분할 매도. TP1과 동일한 부분 청산 패턴(close partial + 잔여분 새 trade 생성). Phase 2는 pairAddress 기반 매칭으로 잔여분 추적. trade 종료 시 state map 자동 정리. `degradedExitEnabled` (default: false)
> - **Runner Extension (v3 확장):** TP2 도달 + Grade A/B + risk-on + 비degraded → trailing-only 전환. Grade A: 전량 trailing, Grade B: 50% TP2 매도 + 50% trailing (0.5x). SL 변경 DB 영속화. `runnerEnabled` + `runnerGradeBEnabled` (default: false)
> - **TP1 Time Extension (v3):** TP1 50% 청산 후 잔여 trade의 timeStop을 현재 시점 + 30분으로 재설정. Runner 활성화 시간 확보. `tp1TimeExtensionMinutes` (default: 30)
> - **Runner Concurrent (v3):** Runner 포지션 중 +1 추가 진입 허용 (절대 상한 2). Runner SL은 TP1(손익분기+)이므로 추가 리스크 극소. `runnerConcurrentEnabled` (default: false)

### Age Bucket Graduated Sizing (v4: 3-tier 완화)

| 토큰 나이 | sizeMultiplier | 설정 env var |
|----------|----------------|-------------|
| < 15min | reject (hard floor) | `AGE_BUCKET_HARD_FLOOR_MIN=15` |
| 15min ~ 1h | × 0.25 | `AGE_BUCKET_1_UPPER_HOURS=1` |
| 1h ~ 4h | × 0.5 | `AGE_BUCKET_2_UPPER_HOURS=4` |
| 4h ~ 24h | × 0.75 | `AGE_BUCKET_3_UPPER_HOURS=24` |
| ≥ 24h | × 1.0 (감산 없음) | — |

> **v4 변경 (2026-03-19):** v2 대비 1h~4h 구간 0.25x→0.5x, 4h~24h 구간 0.5x→0.75x. 기회 exposure ~40% 증가.
> 모든 구간 값이 env var로 설정 가능. `enableAgeBuckets` (default: true).

LP/ownership 감산과 곱셈 누적.

---

## Market Regime Filter (3-Factor)

| 팩터 | 소스 |
|------|------|
| SOL 4H Trend | EMA20 vs EMA50 |
| Watchlist Breadth | 고점돌파 후 2봉 연장 성공률 |
| Follow-through | 최근 breakout → TP1 도달률 |

**Risk-on** (2+/3 bullish): 정상 / **Neutral**: size 70% / **Risk-off** (2+/3 bearish): 신규 진입 중단

---

## 안전장치

| 장치 | 기준 | 행동 |
|------|------|------|
| DrawdownGuard | DD ≥ tier별 maxDD | 전 거래 중단, 85% 회복 시 재개 |
| Daily Loss Halt | dailyPnL < -(equity × maxDailyLoss) | 당일 중단 |
| Cooldown | 3연패 | 30분 대기 |
| Max Concurrent | equity 기반 동적 (v4) | 추가 진입 차단 |
| Pair Blacklist | 5-trade: WR≤35% + R:R≤1.0 | 자동 차단 |

---

## 금지 사항

- Jito 없이 Strategy D 라이브 금지
- Strategy D는 sandbox wallet 외 경로 사용 금지
- 라이브 표본 < 50에서 Kelly 활성화 금지
- Strategy A 기대값 검증 전 Strategy E 활성화 금지
- DexScreener/X 데이터를 매수 트리거로 사용 금지
- 설명 불가 급등 추격 금지

---

## 핵심 파라미터 (config.ts)

| 파라미터 | 기본값 | 비고 |
|---------|--------|------|
| `volumeSpikeMultiplier` | 3.0 | Strategy A 진입 배수 |
| `volumeSpikeLookback` | 20 | 평균 볼륨 윈도우 |
| `minBreakoutScore` | 50 | 최소 통과 점수 |
| `minBuyRatio` | 0.65 | 최소 매수 비율 |
| `maxRiskPerTrade` | 0.01 (1%) | tier가 override |
| `maxDailyLoss` | 0.05 (5%) | tier가 override |
| `maxDrawdownPct` | 0.30 (30%) | tier가 override |
| `maxPoolImpact` | 0.02 (2%) | 유동성 사이징 |
| `maxSlippage` | 0.01 (1%) | 슬리피지 한도 |
| `DEFAULT_AMM_FEE_PCT` | 0.005 (0.5%) | AMM 수수료 추정 |
| `DEFAULT_MEV_MARGIN_PCT` | 0.0015 (0.15%) | MEV 마진 추정 |
| `maxSellImpact` | 0.03 (3%) | Exit Gate reject |
| `sellImpactSizingThreshold` | 0.015 (1.5%) | Exit Gate 50% 감축 |
| `cooldownMinutes` | 30 | 3연패 후 대기 |
| `recoveryPct` | 0.85 (85%) | DD 회복 기준 |
| `enableAgeBuckets` | true | Age Bucket Graduated Sizing |
| `degradedExitEnabled` | false | Degraded Exit 활성화 |
| `degradedSellImpactThreshold` | 0.05 (5%) | Degraded 트리거 임계값 |
| `degradedQuoteFailLimit` | 3 | Quote 연속 실패 한도 |
| `degradedPartialPct` | 0.25 (25%) | Phase 1 부분 청산 비율 |
| `degradedDelayMs` | 300,000 (5분) | Phase 2 대기 시간 |
| `runnerEnabled` | false | Runner Extension 활성화 |
| `tp1TimeExtensionMinutes` | 30 | TP1 후 잔여 trade time stop 연장 (분) |
| `runnerGradeBEnabled` | false | Grade B Runner 허용 (0.5x) |
| `runnerConcurrentEnabled` | false | Runner 중 +1 concurrent 허용 |
| `maxConcurrentPositions` | 1 | 최대 동시 포지션 수 |
| **v4 추가 파라미터** | | |
| `maxPositionPct` | 0.20 (20%) | 단일 포지션 최대 노출 |
| `maxConcurrentAbsolute` | 3 | 동시 포지션 절대 상한 |
| `concurrentTier1Sol` | 5 | 2 concurrent 시작 equity |
| `concurrentTier2Sol` | 20 | 3 concurrent 시작 equity |
| `executionRrReject` | 1.2 | Execution R:R reject 임계값 |
| `executionRrPass` | 1.5 | Execution R:R full-size 임계값 |
| `ageBucketHardFloorMin` | 15 | Age Bucket reject 기준 (분) |
| `liquidityTier1Sol` | 5 | TVL 상향 시작 equity |
| `liquidityTier1MinPool` | 100,000 | TVL 상향 최소값 ($) |
| `liquidityTier2Sol` | 20 | TVL 추가 상향 equity |
| `liquidityTier2MinPool` | 200,000 | TVL 추가 상향 최소값 ($) |
| `impactTier1Sol` | 5 | Impact 축소 시작 equity |
| `impactTier1MaxImpact` | 0.015 | Impact 축소값 (1.5%) |
| `impactTier2Sol` | 20 | Impact 추가 축소 equity |
| `impactTier2MaxImpact` | 0.01 | Impact 추가 축소값 (1%) |

---

## 라이브 전환 게이트

- [ ] 50+ Paper Trades 완료
- [ ] Win Rate ≥ 40%
- [ ] Reward-to-Risk ≥ 2.0
- [ ] VPS + TimescaleDB + API keys 세팅
- [ ] `runnerEnabled=true` 설정 (100x 볼록성 필수)
- [ ] `degradedExitEnabled=true` 설정 (유동성 소실 대응 필수)
- [ ] `USE_JUPITER_ULTRA=true` + `JUPITER_API_KEY` 확보 (체결률 3x 개선)
- [ ] X Filtered Stream Bearer Token 준비 (optional)
