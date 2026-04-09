# Strategy Redesign — Option β (2026-04-10)

> Status: design doc (pre-implementation)
> Author: 48h live data 진단 후 사용자 요청 (Option β 선택)
> Origin: 48h trade-report 로 live edge 실패 확인 + `BACKTEST.md` / `replay-loop-report-2026-04-05.md` / `backtest-bootstrap-replay-loop.md` 재검토
> Scope: bootstrap_10s runtime 파라미터 재설계. Live 운영은 **중단하지 않고** 핫 배포.
> Related plans:
> - [`exit-structure-validation-2026-04-08.md`](../exec-plans/active/exit-structure-validation-2026-04-08.md) Phase X3 Scenario A+B 진입
> - [`exit-execution-mechanism-2026-04-08.md`](../exec-plans/active/exit-execution-mechanism-2026-04-08.md) 병행 (mechanism 과 독립)
> - [`1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md) P0-A/B/C 축 정렬

---

## 0. 요약 (한 장)

48h live 데이터에서 **anomaly 4건 제거한 clean expectancy = -0.00108 SOL/trade**, 예상 DD halt 도달 ~16일. 사용자 직관 확인됨. 원인 진단: **live runtime 파라미터가 backtest 수렴값과 구조적으로 어긋나 있다**.

핵심 수정 5 가지:

1. `tp2Multiplier` **10.0 → 5.0** (backtest 100% 수렴값 복원)
2. `tp1Multiplier` **1.0 → 1.5** (backtest mode)
3. `realtimeTimeStopMinutes` **15 → 20** (backtest mode)
4. `realtimeSlAtrMultiplier` **1.5 → 2.0** (noise floor + slippage 버퍼)
5. `tp1PartialPct` **0.3 → 0.0** + `trailingAfterTp1Only` **true → false** (TP1 partial 제거, runner thesis 순수화)

**보조 로직**: `atrFloorPct = 0.008` 신규 — 10s ATR 이 noise 수준일 때 0.8% floor 로 보정해 TP1/SL 이 noise 를 건드리지 않게 함.

---

## 1. Live 데이터 증거 (48h)

### 1.1 Anomaly 분리 후 진짜 숫자

| 항목 | 표시값 | anomaly 4건 제거 후 (clean) |
|---|---|---|
| rows | 38 | **34** |
| 순 PnL | +0.106780 SOL (phantom) | **-0.036808 SOL** |
| WR (row) | 21.1% | 17.6% |
| avg win | — | +0.000789 SOL |
| avg loss | — | -0.001484 SOL |
| **expectancy** | — | **-0.00108 SOL/trade** |
| DD halt ETA @ 1 SOL paper balance | — | ~16 일 |

PIPPIN row 1 (`+0.154233 SOL, exitGap +113.89%, anomaly=decision_fill_gap`) 단일 건이 +0.107 phantom profit 을 만듦. VDOR 3 건 anomaly (exitGap -72%, +1139%, +428%) 는 반대 방향 작은 noise.

### 1.2 TP1 trigger 100% 손실 패턴 (critical)

48h clean 34 rows 중 TP1 intent (`TAKE_PROFIT_1`) 8 건 — **모두 loss**:

| token | decision | exit | gap | pnl |
|---|---|---|---|---|
| PIPPIN row 5 | 0.00251829 | 0.00249918 | -0.76% | -0.000057 |
| SWARMS row 1 | 0.00560750 | 0.00553677 | -1.26% | -0.000392 |
| SWARMS row 4 | 0.00538513 | 0.00534666 | -0.71% | -0.000081 |
| SWARMS row 7 | 0.00538765 | 0.00533871 | -0.91% | -0.000029 |
| FARTCOIN row 1 | 0.000440505 | 0.000438296 | -0.50% | -0.000080 |
| FARTCOIN row 3 | 0.000458295 | 0.000454987 | -0.72% | -0.000182 |
| FARTCOIN row 5 | 0.000450388 | 0.000447377 | -0.67% | -0.000165 |
| GRIFFAIN row 1 | 0.00501325 | 0.00495771 | -1.11% | -0.000194 |

**Monitor 가 TP1 peak 를 관측 → 1.78s swap latency → 가격 noise reversion → fill 이 entry 아래에서 체결**. 8/8 = 100% 의 "TP1 가 loss 를 만드는" 패턴.

### 1.3 TP2 actual reach = 0% (clean)

clean 34 rows 중 **actual TP2 price 도달 = 0 건**. `exit_reason=TAKE_PROFIT_2` 로 마킹된 2 건 모두 anomaly (VDOR row 1, PIPPIN row 1). Phase X2 v2 finding 이 48h 에서 재확인.

### 1.4 Tail loss 증거 — 49 EXHAUSTION

```
49 row 2 (04-09 05:19):
  entry 0.0000820990 → exit 0.0000635712 (-22.6%)
  decision 0.0000829918 (entry 근처)
  exit_slip 1bps (Jupiter 깨끗 보고)
  pnl -0.014517 SOL  ← 단일 trade -1.45% of balance
```

Jupiter quote time → confirm time 사이 -23% 낙하. Risk-per-trade 1% 한도 무력화.

### 1.5 Post-deploy 11h vs pre-deploy 비교 (defense layers 작동 확인)

| metric | pre-deploy (~30 rows) | post-deploy (8 rows) |
|---|---|---|
| anomaly count | 4 | **0** |
| max exit gap | 1139.84% | **1.11%** (1000x ↓) |
| reverse p95 | 측정 불가 | **+0.43%** |
| EXHAUSTION pre-TP1 | 3 건 | **0 건** |
| avg loss magnitude | -0.00149 SOL | -0.00022 SOL |

**Phase E1 mechanism fix 는 작동 중**. noise magnitude 가 1000x 줄었고 anomaly 완전 차단. 그러나 WR 은 여전히 12.5% (8 rows), 1 entry win / 4 entry losses → **mechanism 이 strategy thesis 를 못 고침**. 1.78s swap latency 동안 0.5~1% reversion 이 여전한 구조적 문제.

---

## 2. Backtest 증거 재해석

### 2.1 5m CSV sweep (2026-04-01, 19 tokens × 960 combos)

`BACKTEST.md` line 530-556:

| Rank | vol | tp1 | tp2 | sl | timeStop | AvgSharpe | Trades | +Tokens |
|---|---|---|---|---|---|---|---|---|
| 1 | **3.0** | **1.5** | **5.0** | 1.5 | 25 | 2.22 | 313 | 12/17 |
| 2 | 3.5 | 0.5 | 5.0 | 1.25 | 20 | 2.19 | 281 | 11/17 |
| 3 | 3.0 | 1.5 | 5.0 | 1.25 | 25 | 2.14 | 315 | 12/17 |

**파라미터 안정도 (top 15)**:

| 파라미터 | 범위 | 수렴 |
|---|---|---|
| **tp2Multiplier** | **5.0** | **100% 일치** |
| slAtrMultiplier | 1.25~1.50 | mode 1.25 |
| volumeMultiplier | 3.0~3.5 | mode 3.5 |
| tp1Multiplier | 0.5~1.5 | mode 1.5 |
| timeStopMinutes | 15~30 | mode 20 |

### 2.2 현재 live runtime 과의 불일치 매트릭스

| 파라미터 | backtest 수렴 | live runtime_canary | 평가 |
|---|---|---|---|
| `volumeSpikeMultiplier` | 3.0-3.5 | 3.0 ✅ | 부합 |
| `tp1Multiplier` | **1.5** | **1.0** ❌ | 33% 작음 → noise floor 접근 |
| **`tp2Multiplier`** | **5.0** | **10.0** ❌❌ | **2x 오버** — v5 runner-centric 독단 |
| `slAtrMultiplier` (default path) | 1.25 | 1.25 ✅ | 부합 |
| `realtimeSlAtrMultiplier` (live path) | — | 1.5 | backtest 외 |
| `timeStopMinutes` (default path) | 20-25 | 20 ✅ | 부합 |
| **`realtimeTimeStopMinutes`** (live path) | — | **15** ❌ | 25% 짧음 |
| `tp1PartialPct` | — (backtest 는 partial 없음) | 0.3 ❌ | backtest 에 없는 로직 |

**가장 큰 차이 2 개**:
1. **TP2 10.0 vs backtest 수렴 5.0** — 2 배 오버. TP2 도달 불가능한 주된 이유.
2. **TP1 partial 30% 는 backtest 에 없는 로직** — backtest 는 "TP1 hit → full close". Live 는 "TP1 hit → 30% close → 70% remainder SL=entry" 로 runner thesis 파괴.

### 2.3 Bootstrap 10s replay (2026-04-05) — backtest 로 해석 금지

`replay-loop-report-2026-04-05.md`:

| Session | Signals | avgReturn | MFE | MAE | Edge Score | Decision |
|---|---|---|---|---|---|---|
| 04-04T14:31 | 132 | **+7.19%** | **+34.4%** | -3.6% | **78** | **pass** |
| 04-03T15:45 | 89 | +0.14% | +0.81% | -0.71% | 8 | reject |
| 04-03T03:53 | 64 | 0.00% | 0.00% | 0.00% | 8 | reject |
| legacy | 0 | — | — | — | — | no data |

**1/4 session pass** = broad edge 아님. Report 본문: *"단일 세션 결과이므로 outlier runner 토큰에 의한 과적합 가능성 존재"*.

또한 bootstrap replay 는 **SL/TP fill simulation 없음** — horizon return 만. MFE 34.4% 은 **monitor 관측 upside**, actual fill upside 아님. 따라서 bootstrap replay 는 Option β 의 SL/TP 파라미터 근거로 사용할 수 없다. 5m CSV sweep 만이 SL/TP 수렴값의 근거.

### 2.4 한 줄 결론

> 현재 runtime 은 **dormant 5m sweep 의 파라미터 절반 + v5 주관적 runner 확장 + TP1 partial 특수 로직** 의 hybrid. backtest 수렴값 대비 TP2 2x, TP1 33% 작음. Bootstrap 10s replay 는 SL/TP 에 무관한 trigger efficacy 측정. **현재 구조는 어느 backtest 결과와도 정합하지 않는다**.

---

## 3. Option β 재설계 원칙

### 3.1 원칙 5 개

1. **Backtest 수렴값 존중**: TP2 5.0 / TP1 1.5 / SL 1.25 / timeStop 20 — 주관적 v5 확장 철회
2. **TP1 partial 제거**: backtest 에 없는 로직이 live 에서 runner thesis 파괴 중. 단순 TP1 hit → full close 로 복귀
3. **ATR floor 도입**: 10s candle ATR 이 0.3~0.5% 로 noise floor 수준일 때 0.8% floor 강제 → TP1/SL 이 noise 위에서 작동
4. **SL 약간 넓힘** (live path 만): `realtimeSlAtrMultiplier` 1.5 → 2.0. swap latency 1.78s 동안의 0.5~1% reversion 흡수 버퍼
5. **Trailing 즉시 활성화**: `trailingAfterTp1Only = false`. TP1 partial 제거와 쌍으로 진행. entry 후 trailing stop 이 runner 를 잡음

### 3.2 원칙상 하지 않는 것

- ❌ **Timeframe 변경 (10s → 60s)** — signal density 급감 + Strategy A/C 가 이미 5m dormant 라 회귀
- ❌ **Trigger 파라미터 (volumeMultiplier 1.8) 변경** — 사용자 의도상 bootstrap cadence 유지, signal 밀도 문제 아님
- ❌ **Phase E2 (C2 tick-level)** — mechanism plan 별도, 본 redesign 과 독립
- ❌ **Phase A3 clamp 완화** — guard 는 정상 작동 중
- ❌ **`EXIT_MECHANISM_MODE=hybrid_c5` flip** — Phase E1 baseline 측정 중, Option β 와 혼동 방지

### 3.3 Option α/γ/δ 와의 비교

| Option | 접근 | 채택 여부 | 이유 |
|---|---|---|---|
| α | Live halt + paper redesign | 거절 | 사용자가 운영 중단 안 하기로 결정 |
| **β** | Backtest 정합 + ATR floor + TP1 partial 제거 | **채택** | 데이터 근거 가장 많음 |
| γ | TP1 partial 만 제거 (최소 변경) | 부분 포함 | β 가 포괄 |
| δ | Timeframe 60s 전환 | 거절 | dormant 경로 회귀 |

---

## 4. 구체 파라미터 변경

### 4.1 `src/utils/tradingParams.ts`

```diff
  // ─── Order Shape (v5 runner-centric) ───
  orderShape: {
-   tp1Multiplier: 1.0,
+   tp1Multiplier: 1.5,                 // backtest mode (2026-04-01 sweep)
-   tp2Multiplier: 10.0,
+   tp2Multiplier: 5.0,                 // backtest 100% 수렴 (2026-04-01 sweep)
    slAtrMultiplier: 1.25,              // runtime_canary: 1.25 (unchanged)
-   timeStopMinutes: 20,
+   timeStopMinutes: 25,                // backtest mode 20-25 중 여유 있는 쪽
-   tp1PartialPct: 0.3,
+   tp1PartialPct: 0,                   // TP1 partial 제거 — backtest 정합 + runner thesis 회복
-   trailingAfterTp1Only: true,
+   trailingAfterTp1Only: false,        // TP1 partial 없으므로 entry 직후 trailing 가능
-   tp1TimeExtensionMinutes: 30,
+   tp1TimeExtensionMinutes: 0,         // no-op (partial removed)
  },
```

### 4.2 `src/utils/tradingParams.ts` (realtime path)

```diff
  realtime: {
    ...
-   realtimeSlAtrMultiplier: 1.5,
+   realtimeSlAtrMultiplier: 2.0,       // noise floor + swap latency 버퍼
-   realtimeTimeStopMinutes: 15,
+   realtimeTimeStopMinutes: 20,        // backtest mode 최하단
+   // 2026-04-10: 10s ATR 이 noise floor (0.3~0.5% of price) 수준일 때 absolute floor 강제.
+   // live 에서 TP1 = entry + atr × 1.5 가 noise 에 잡히지 않도록 0.8% 하한선을 둔다.
+   atrFloorPct: 0.008,
  },
```

### 4.3 ATR floor 로직 — `src/strategy/indicators.ts` 또는 order builder

ATR 계산 후 최종 consumer (`buildMomentumTriggerOrder`) 에서:

```typescript
// Before
const stopDistance = atr * params.slAtrMultiplier;

// After
const effectiveAtr = Math.max(atr, referencePrice * config.atrFloorPct);
const stopDistance = effectiveAtr * params.slAtrMultiplier;
const tp1Distance = effectiveAtr * params.tp1Multiplier;
const tp2Distance = effectiveAtr * params.tp2Multiplier;
```

**effect table** (price=0.0005 기준):

| 시나리오 | raw ATR | effective ATR | SL (2.0×) | TP1 (1.5×) | TP2 (5.0×) |
|---|---|---|---|---|---|
| Calm 10s (ATR 0.2%) | 1e-6 | **4e-6** (floor) | -1.6% | +1.2% | +4.0% |
| Normal (ATR 0.5%) | 2.5e-6 | **4e-6** (floor) | -1.6% | +1.2% | +4.0% |
| Volatile (ATR 1.0%) | 5e-6 | 5e-6 (raw) | -2.0% | +1.5% | +5.0% |
| High vol (ATR 2.0%) | 1e-5 | 1e-5 (raw) | -4.0% | +3.0% | +10.0% |

### 4.4 Expected nominal RR

- TP1 : SL ratio = `1.5 : 2.0` = **0.75** (partial 없음이라 중요)
- TP2 : SL ratio = `5.0 : 2.0` = **2.5** (runner 기대값)
- Effective nominal RR (runner 기반) = 2.5

### 4.5 handleTakeProfit1Partial 거동

`tp1PartialPct = 0` 이면 `soldQuantity = trade.quantity * 0 = 0` → 기존 guard:
```typescript
if (remainingQuantity <= 0 || soldQuantity <= 0) {
  await closeTrade(trade, 'TAKE_PROFIT_1', ctx, currentPrice);
  return;
}
```
→ **자동으로 full close** 경로 진입. 코드 수정 없이 파라미터만으로 로직 전환. ✅

---

## 5. 기대 변화 (전/후)

| 행동 | Before (current) | After (Option β) | 이유 |
|---|---|---|---|
| 평균 TP1 distance | ~0.3-0.5% | **≥ 1.2%** (floor 적용) | ATR floor 0.8% × 1.5 |
| 평균 SL distance | ~0.45% (1.5 × 0.3%) | **≥ 1.6%** | ATR floor × 2.0 |
| 평균 TP2 distance | ~3-5% (10 × 0.3-0.5%) | ~4-5% (5 × 0.8-1%) | 절대값 유사, multiplier 만 축소 |
| TP1 noise trigger 빈도 | 매우 높음 (8/8 loss) | 현저히 감소 | noise floor 위로 올라감 |
| Runner capture 구조 | TP1 30% 분할 → 70% SL=entry | **풀 포지션 TP2 / trailing** | TP1 partial 제거 |
| swap latency 영향 | TP1 fill 0.5-1% 아래 | 여전히 0.5-1% slip, 그러나 TP1 distance 자체가 1.2%+ 이라 수익권 유지 가능 | ATR floor 버퍼 |
| Signal 빈도 | 유지 | 유지 (trigger 미변경) | — |
| Tail loss (49 케이스) | 가능 (-22%) | **여전히 가능** — redesign 이 tail risk 를 제거 안 함 | Phase E2 (tick-level) 영역 |
| 예상 WR (fresh trades) | 17.6% | **20-30%** 추정 | TP1 win 이 실제 win 으로 전환 |
| 예상 avg win R | +0.5R | **+1.5-2R** | TP1 = 0.75R × 풀 포지션 + runner 가능성 |
| 예상 avg loss R | -1.4R | **-2.0R** (SL 넓힘) | 단, floor 덕에 noise stopout 감소 |
| 예상 expectancy | -0.64R | **-0.5R ~ +0.3R** 범위 | 표본 축적 후 확인 |

**경고**: 위는 _예상_. backtest 수렴값을 live 에 투영한 것이므로 live 시장의 10s ATR scale 차이가 결과를 완전히 바꿀 수 있음. **최소 24-48h 관찰 + 재sync 후 실측 평가 필수**.

---

## 6. 검증 plan

### 6.1 Pre-deploy (구현 직후)

- [ ] `npm run typecheck` + `npm run typecheck:scripts` 0 errors
- [ ] `npx jest` 전체 pass (tradingParams snapshot 포함)
- [ ] 변경된 `handleTakeProfit1Partial` 경로에서 `tp1PartialPct=0` 시 full close 트리거 unit test
- [ ] ATR floor 로직 test: 낮은 ATR 입력 → effective_atr = max(raw, price × 0.008) 검증

### 6.2 Post-deploy 즉시 (0-2h)

- [ ] VPS pm2 log 에서 `[Executor]` 의 첫 BUY order 의 SL/TP distance 확인 (≥ 1.2% 예상)
- [ ] 첫 TP/SL trigger 시 `exit_reason` / `exit_price` 정합 확인
- [ ] `monitor_trigger_price` (Phase E1 telemetry) 가 여전히 기록되는지 확인

### 6.3 Post-deploy 12-24h

- [ ] 재sync + `trade-report --hours 24`
- [ ] post-deploy clean trades (anomaly 제거) 기준 expectancy 계산
- [ ] TP1 fill pattern (full close vs 이전 partial)
- [ ] TP2 actual reach 발생 여부 (이전 0% → 1건이라도 나오면 큰 개선)
- [ ] `exit-distribution-audit --closed-after <deploy_ts>` 실행

### 6.4 Post-deploy 48-72h

- [ ] post-deploy clean ≥ 15 trades 누적 후 `exit-distribution-audit` 재실행
- [ ] **rollback 조건 중 하나라도 발동 시 즉시 revert**

---

## 7. Rollback 조건 (strict)

아래 **단 하나라도** 해당 시 즉시 `tradingParams.ts` 이전 값으로 revert + 재배포:

1. **배포 후 24h 내 drawdown > 5% of paper balance** (현재 1% × 5 = 0.05 SOL 손실)
2. **clean trades expectancy < -1.0R/trade** (n ≥ 10)
3. **연속 10건 loss** (streak guard)
4. **새 anomaly 발생** — `exit_anomaly_reason != null` 비율이 5% 넘음
5. **PRICE_ANOMALY_BLOCK 차단율이 50%+** (Option β 가 PRICE_ANOMALY 와 무관하지만 상관관계 관찰 필요)
6. **pre-TP1 EXHAUSTION** 발생 (현재 Phase E1 deploy 후 0 유지, regression 감지용)

롤백 명령:
```bash
# tradingParams.ts 이전 값으로 git revert 또는 manual edit 후
npm run deploy:vps
```

---

## 8. 사명 정렬 (1 SOL → 100 SOL)

### 8.1 현재 시점

- **Risk tier**: Bootstrap (< 20 closed trades post-Phase E)
- **Phase X1 acceptance**: ≥ 20 post-Phase E clean trades → **재충족 필요** (Option β 배포 후 20 재누적)
- **Phase X3 진입**: 본 redesign 이 Scenario A (tp2=5.0) + B (ATR floor) 결합으로 Phase X3 실행

### 8.2 P0-A/B/C 축과의 관계 (`1sol-to-100sol.md`)

- **P0-A (Exit mechanism)**: Phase E1 배포 완료 + post-deploy reverse p95 +0.43% 확인. **mechanism 측면은 작동 중**. Option β 는 mechanism 위에 얹는 parameter 보정.
- **P0-B (Fresh flow)**: GRIFFAIN 신규 진입 등 universe 가 흐르기 시작. Option β 와 독립.
- **P0-C (Winner preservation)**: TP1 partial 제거 + ATR floor + trailing 즉시 활성화로 **직접 개선 시도**. pre-TP1 EXHAUSTION rate 모니터링으로 검증.

### 8.3 Option β 가 성공할 경우

```
Week 0 (now): Option β 배포 + paper balance 1 SOL
Week 1: ≥ 20 clean trades 누적, expectancy > 0 검증
Week 2-3: Phase X1 재통과 + Calibration tier 진입 (trades ≥ 20)
Week 4-6: 50 trades, Confirmed tier 진입 (Kelly QK cap 3%)
Week 6+: 복리 시작
```

### 8.4 Option β 가 실패할 경우

rollback 후 다음 iter:
- **Phase E2 (C2 tick-level trigger)** 실행 — mechanism 측 개선으로 1.78s swap latency 자체를 단축
- **Timeframe 확장** (10s → 30s) — trigger cadence 변경, signal density 감수
- **최종 옵션**: Strategy 전면 재설계 (bootstrap trigger 외 다른 entry thesis)

---

## 9. Forbidden (이 redesign scope 안)

- ❌ 본 design doc 의 5 가지 파라미터 외 추가 변경
- ❌ Phase A3 clamp 완화 / `bypassEdgeBlacklist=true`
- ❌ orderShape 이외 영역 (riskPerTrade, maxConcurrent, cooldown) 동시 변경
- ❌ bootstrap trigger (volumeMultiplier / minBuyRatio) 건드리기
- ❌ `EXIT_MECHANISM_MODE=hybrid_c5` 동시 flip (Phase E1 baseline 측정 중)
- ❌ 24h 관찰 전에 추가 튜닝
- ❌ rollback 조건 발동 시 override

---

## 10. Open Questions

1. **10s ATR 과 5m ATR 의 scale 차이로 인한 multiplier 비교 정당성** — 이론적으론 sqrt(30)≈5.5x 차이지만, ATR floor 0.8% 가 이 gap 을 흡수할 수 있는지 실측 전 불확실
2. **TP1 partial 제거 후 winner 잡는 경로** — TP2 reach + trailing + exhaustion 중 어느 것이 실제 주력이 되는지 미측정
3. **새 SL 2.0×ATR 이 entry ratio Phase A3 clamp `[0.7, 1.3]` 와 충돌 없는지** — theoretically 독립이나 fresh pump.fun 토큰의 entry slippage 가 큰 경우 SL 이 Phase A3 를 건드릴 수 있음
4. **atrFloorPct 0.008 의 최적값** — 0.6% 가 낫다면? 1.0% 가 낫다면? 실측 후 튜닝 후보
5. **Option β 이후 여전히 expectancy 음수면** — Phase E2 로 가야 하나, 아니면 전략 전면 재설계?

---

## History

- 2026-04-10: 초기 작성. 48h live trade-report 진단 결과 (anomaly-clean expectancy -0.00108 SOL/trade, DD halt ETA ~16일) + `BACKTEST.md` 5m CSV sweep 수렴값 (tp2=5.0 100%, tp1=1.5 mode) 와 `replay-loop-report-2026-04-05.md` 1/4 outlier dependency 를 근거로 Option β 설계. 사용자는 live 운영 중단 안 하고 핫 배포 요청. Phase X3 Scenario A+B 조합 + TP1 partial 제거 + ATR floor 추가로 `exit-structure-validation-2026-04-08.md` plan scope 확장.
