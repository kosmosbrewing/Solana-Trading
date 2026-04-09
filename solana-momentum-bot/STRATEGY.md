# STRATEGY.md

> Status: current quick reference
> Updated: 2026-04-06
> Purpose: 현재 runtime에서 읽어야 할 전략/게이트/리스크/핵심 파라미터를 짧게 정리한다.
> Full spec: [`docs/product-specs/strategy-catalog.md`](./docs/product-specs/strategy-catalog.md)
> Forward memo: [`STRATEGY_NOTES.md`](./STRATEGY_NOTES.md)

## Role

이 문서는 quick reference다.

- 현재 구현/운영 기준만 짧게 담는다
- historical validation 결과나 과거 파라미터는 싣지 않는다
- 전략의 구조적 한계나 다음 방향 메모는 [`STRATEGY_NOTES.md`](./STRATEGY_NOTES.md)로 분리한다

## Core Principle

> 가격이 움직여서 사는 게 아니라, 움직일 이유가 있고, 실제로 움직이기 시작할 때 산다.

## Runtime Strategy Set

| 전략 | 상태 | 역할 |
|---|---|---|
| Realtime bootstrap `bootstrap_10s` | **active default** | 10초봉 volume+buyRatio 2-gate 트리거 |
| Strategy A `volume_spike` | **dormant (5m meme)** | 5분봉 브레이크아웃 — 밈코인 모멘텀(10-30s)에 구조적 비적합 (04-05 확인) |
| Strategy C `fib_pullback` | **dormant (5m meme)** | 확인형 되돌림 진입 — 5m 해상도에서 밈코인 비적합 (04-05 확인) |
| Realtime core `core_momentum` | standby | 3-AND 조건 (breakout+confirm) 트리거 |
| Strategy D `new_lp_sniper` | sandbox | 별도 지갑 실험 전략 (현재 live execution 미연결) |
| Strategy E `momentum_cascade` | conditional | Strategy A add-on |

### Strategy A/C Dormancy 근거 (2026-04-05)

4 sessions × 87 pairs × 3 strategies(A/C/combined) = 261 combination 중 **단 3건만 trade 발생**.
300s candle 해상도에서 밈코인의 짧은 모멘텀(10-30초)을 포착하는 것이 구조적으로 불가능.
향후 CEX/DEX 대형 토큰으로 전환 시에만 재활성화 고려. 상세: [`results/replay-loop-report-2026-04-05.md`](./results/replay-loop-report-2026-04-05.md)

## Strategy A: Volume Spike Breakout (dormant for 5m meme)

> Status: **dormant** — 5m 해상도에서 밈코인 모멘텀 포착 불가. bootstrap_10s가 이 역할을 대체한다.

### Entry

```text
volume >= avg[20] x 2.5
close > highestHigh[20]
```

### Current Order Shape (Default Path)

```text
SL  = entry - ATR x 1.0
TP1 = entry + ATR x 1.0
TP2 = entry + ATR x 10.0
Time Stop = 20m
TP1 partial = 30%
Trailing = TP1 이후에만 활성화
```

### Why It Matters

- 19-token 크로스밸리데이션 스윕에서 TP2=5.0이 상위 15개 조합 전부에서 최적 수렴 → v5에서 runner-centric 10.0으로 확장.
- v5 SL=1.0 ATR: 일정한 risk 단위. Realtime live path는 slippage 고려 1.5 ATR 사용.
- Nominal RR (default path) = 10.0/1.0 = 10.0 → RR gate(1.2/1.5) 통과.
- Effective RR = (rewardPct − roundTripCost) / (riskPct + roundTripCost). 실행 시 slippage/fee 차감 후 계산.
- TP2 10.0 vs sweep 최적 5.0은 live 50-trade 데이터로 판단 예정 (STRATEGY_NOTES.md 참조).

## Strategy C: Fib Pullback (dormant for 5m meme)

> Status: **dormant** — Strategy A와 동일 사유. 5m 해상도에서 밈코인 비적합.

### Entry

```text
impulse -> fib 0.5~0.618 -> volume climax -> reclaim -> confirm candle
```

### Current Order Shape

```text
SL  = max(fib786 - ATR(14) x 0.3, swingLow)
TP1 = entry + (swingHigh - entry) x 0.90
TP2 = entry + (swingHigh - entry) x 1.0
Time Stop = 60m
```

### Notes

- Strategy A보다 느리지만 확인 강도가 높다.
- **현재 밈코인에서는 dormant**. CEX/DEX 대형 토큰 전환 시 재활성화 후보.

## Realtime Trigger

두 가지 모드 지원. `REALTIME_TRIGGER_MODE` env var로 전환 (default: `bootstrap`).

### Bootstrap Mode (`volumeMcapSpikeTrigger`) — default

breakout/confirm 제거. volume acceleration + buy ratio만으로 발화.
Core 모드 대비 signal 밀도 대폭 개선 (noBreakout=100%, confirmFail=100% 해소).
5-session replay sweep 기준 현재 VPS 안정형 baseline은 `1.8 / 0.60 / 20`이다.

```text
Primary interval: 10s
Volume lookback: 20
Volume multiplier: 1.8
Min buy ratio: 0.60              ← REALTIME_BOOTSTRAP_MIN_BUY_RATIO (soft filter)
Cooldown: 300s
```

참고:
- 현재 code default는 `3.0 / 0.55 / 20`이다.
- 현재 VPS 운영 baseline이 env override로 `1.8 / 0.60 / 20`을 사용한다.
- bootstrap signal은 `strategy=bootstrap_10s`로 기록되며, 5분봉 Strategy A(`volume_spike`)와 별도 집계된다.

롤백: `REALTIME_TRIGGER_MODE=core` → pm2 restart.

### Current Bootstrap Bottleneck (2026-04-05)

- **Sparse Data Insufficient: 81% 평가 차단** — Feature 4(zero-volume skip)로 인해 persist된 candle이 불연속. Replay 시 fillCandleGaps()가 synthetic candle 삽입하지만, lookback window(20 bars × 10s) 내 active candle 부족 시 거부.
- **Edge 재현성**: 4개 세션 중 04-04 세션만 edgeScore 78 통과, 나머지 3개 reject (8점). 단일 세션 결과이므로 outlier runner 가능성 존재.
- **Critical Path**: Sparse 해소 → 평가 모수 확대 → edge 재현성 확인 → paper 50-trade → live enablement
- 상세: [`results/replay-loop-report-2026-04-05.md`](./results/replay-loop-report-2026-04-05.md)

### Core Mode (`momentumTrigger`)

3개 AND 조건 (volume surge + 20봉 breakout + 3봉 confirm). 검증된 후 사용.

```text
Primary interval: 10s
Confirm interval: 60s
Volume lookback: 20
Volume multiplier: 2.5
Breakout lookback: 20
Confirm min bars: 3
Confirm min change pct: 0.02
Cooldown: 300s
```

### Current Realtime Order Shape (Live Path)

```text
SL mode = atr
SL ATR multiplier = 1.5         ← REALTIME_SL_ATR_MULTIPLIER (default path 1.0보다 넓음)
TP1 = ATR x 1.0
TP2 = ATR x 10.0                ← v5 runner-centric (sweep 최적 5.0에서 확장)
Time Stop = 15m                  ← REALTIME_TIME_STOP_MINUTES (default path 20m보다 짧음)
Nominal RR = 10.0 / 1.5 = 6.67
```

## Gate Chain

```text
Gate 0  Security
Gate 1  AttentionScore / Context
Gate 2A Execution Viability
Gate 2B Quote Gate
Gate 3  Strategy Score
Gate 4  Safety
Exit     Sell-side Impact
```

### Current Execution Viability Basis

```text
RR basis = TP2
Reject   < 1.2
Reduced  < 1.5
Full     >= 1.5
```

TP2=10x ATR 기준이므로 RR 평가도 TP2 기준으로 해야 한다.
TP1 기준은 SL과 거의 대칭(1x ATR)이라 roundTripCost만큼 항상 불리하다.

> Nominal vs Effective RR:
> - Nominal = TP2 distance / SL distance (config 값만으로 계산)
> - Effective = (rewardPct − roundTripCost) / (riskPct + roundTripCost) — runtime에서 slippage probe 후 계산
> - Gate는 effective RR 기준으로 판단

## Risk And Exit

### Risk Tier

| Tier | Trades | Risk/Trade | Daily Limit | Max DD |
|---|---|---|---|---|
| Bootstrap | `<20` | 1% | 5% | 30% |
| Calibration | `20-49` | 1% | 5% | 30% |
| Confirmed | `50-99` | QK cap 3% | 15% | 35% |
| Proven | `100+` | QK cap 5% | 15% | 40% |

### Current Exit Guards

- TP1 partial exit
- trailing after TP1 only
- degraded exit optional
- runner optional
- sell impact exit gate
- drawdown guard / daily loss halt / cooldown
- **decision price tracking**: 모든 exit 경로에서 trigger 판정가(`decisionPrice`)를 DB에 기록. Live fill과의 gap 계측용.

## Conditional Strategies

### Strategy D

- sandbox wallet only
- fixed ticket (`0.02 SOL` default)
- live main wallet path에 섞지 않는다
- 현재는 candidate 평가 + signal/order 생성까지만 연결돼 있고, live execution은 아직 미연결이다

### Strategy E

- Strategy A expectancy가 live에서 검증된 뒤에만 활성화
- 현재는 기본 비활성 경로로 본다

## Guardrails

- Jito 없이 Strategy D live 금지
- sandbox wallet 외 경로에서 Strategy D 금지
- live 표본 `< 50`에서 Kelly 활성화 금지
- Strategy A 기대값 미검증 상태에서 Strategy E 공격적 활성화 금지
- DexScreener/X 데이터를 매수 트리거로 사용 금지
- 설명 없는 급등 추격 금지
- `OPERATOR_TOKEN_BLACKLIST`에 포함된 token/pair는 scanner / realtime / candle path에서 모두 차단

## Current Key Parameters

### Order Shape (Option β — 2026-04-10 재설계)

> 근거: [`docs/design-docs/strategy-redesign-2026-04-10.md`](./docs/design-docs/strategy-redesign-2026-04-10.md)
> 이전 v5 runner-centric 확장 (tp2=10.0, tp1 partial 30%) 는 `BACKTEST.md` 2026-04-01 sweep 수렴값과 정합 X → 철회. backtest mode 값 복원 + TP1 partial 제거 + ATR floor 도입.

| 키 | Default Path | Live Path | 비고 |
|---|---|---|---|
| `TP1_MULTIPLIER` | `1.5` | `1.5` | 2026-04-10: 1.0 → 1.5 (backtest mode 2026-04-01 sweep) |
| `TP2_MULTIPLIER` | `5.0` | `5.0` | 2026-04-10: 10.0 → 5.0 (backtest 100% 수렴, v5 주관 확장 철회) |
| `SL_ATR_MULTIPLIER` | `1.25` | — | default/backtest path (runtime_canary 1.25) |
| `REALTIME_SL_ATR_MULTIPLIER` | — | `2.0` | 2026-04-10: 1.5 → 2.0 (noise floor + swap latency 버퍼) |
| `TIME_STOP_MINUTES` | `25` | — | 2026-04-10: 20 → 25 (backtest mode 상단) |
| `REALTIME_TIME_STOP_MINUTES` | — | `20` | 2026-04-10: 15 → 20 (backtest mode 최하단) |
| `TP1_PARTIAL_PCT` | `0` | `0` | 2026-04-10: 0.3 → 0 (TP1 partial 제거, runner thesis 순수화) |
| `TRAILING_AFTER_TP1_ONLY` | `false` | `false` | 2026-04-10: true → false (entry 직후 trailing 가능) |
| `atrFloorPct` (realtime) | — | `0.008` | **신규** 2026-04-10: 10s ATR noise floor 보정 (0.8% 하한선) |

**effective TP/SL (ATR floor 적용 후, price=0.001 예시)**:
- effectiveAtr = `max(raw_atr, 0.001 × 0.008) = max(raw, 0.000008)`
- TP1 = entry + effectiveAtr × 1.5 ≥ entry × **1.012** (+1.2%)
- TP2 = entry + effectiveAtr × 5.0 ≥ entry × **1.040** (+4.0%)
- SL = entry − effectiveAtr × 2.0 ≥ entry × **0.984** (−1.6%)
- Nominal RR (TP2/SL) = 5.0 / 2.0 = **2.5**

### Execution Viability

| 키 | 현재 값 |
|---|---|
| `EXECUTION_RR_BASIS` | `tp2` |
| `EXECUTION_RR_REJECT` | `1.2` |
| `EXECUTION_RR_PASS` | `1.5` |
| `MAX_POSITION_PCT` | `0.20` |
| `MAX_SELL_IMPACT` | `0.03` |
| `SELL_IMPACT_SIZING_THRESHOLD` | `0.015` |

### Signal 밀도 (Trigger + Admission)

이 표는 `runtime_canary` (tradingParams.ts 현재 값) 기준이다.
`code_default`와 다른 항목은 비고에 함께 적고, `operator_cap` (OPERATIONS.md)은 별도 표시한다.

| 키 | runtime_canary | 비고 |
|---|---|---|
| `REALTIME_TRIGGER_MODE` | `bootstrap` | bootstrap / core |
| `REALTIME_VOLUME_SURGE_MULTIPLIER` | `1.8` | 4/4 replay stable baseline. code_default: `3.0` |
| `REALTIME_VOLUME_SURGE_LOOKBACK` | `20` | lookback 30보다 우세 |
| `REALTIME_BOOTSTRAP_MIN_BUY_RATIO` | `0.60` | bootstrap 전용 soft filter. code_default: `0.55` |
| `REALTIME_CONFIRM_MIN_BARS` | `3` | core 전용 |
| `REALTIME_CONFIRM_MIN_CHANGE_PCT` | `0.02` | core 전용 |
| `REALTIME_COOLDOWN_SEC` | `300` | |
| `VOLUME_SPIKE_MULTIPLIER` | `3.0` | runtime_canary. code_default: `2.5` |
| `SL_ATR_MULTIPLIER` | `1.25` | runtime_canary. code_default: `1.0`, **live_path: `2.0`** (Option β 2026-04-10) |
| `MIN_BREAKOUT_SCORE` | `50` | |
| `MIN_BUY_RATIO` | `0.65` | |
| `MAX_WATCHLIST_SIZE` | `20` | operator_cap (OPERATIONS.md): `8` |
| `REALTIME_MAX_SUBSCRIPTIONS` | `30` | operator_cap (OPERATIONS.md): `5` |
| `AGE_BUCKET_HARD_FLOOR_MIN` | `5` | runtime_canary. code_default: `15` |
| `MAX_CONCURRENT_ABSOLUTE` | `3` | |
| `MAX_CONCURRENT_POSITIONS` | `2` | runtime_canary. code_default: `1` |
| `OPERATOR_TOKEN_BLACKLIST` | 운영값 | replay blacklist 후보를 runtime에 직접 반영 |

## One-Line Summary

> `STRATEGY.md`는 현재 runtime에서 바로 읽어야 할 전략/Gate/Risk quick reference만 담는 문서다.
