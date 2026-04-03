# STRATEGY.md

> Status: current quick reference
> Updated: 2026-04-03
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
| Strategy A `volume_spike` | active core | 5분봉 브레이크아웃 |
| Strategy C `fib_pullback` | active core | 확인형 되돌림 진입 |
| Realtime bootstrap `volumeMcapSpikeTrigger` | **active default** | volume+buyRatio 2-gate 트리거 |
| Realtime core `momentumTrigger` | standby | 3-AND 조건 (breakout+confirm) 트리거 |
| Strategy D `new_lp_sniper` | sandbox | 별도 지갑 실험 전략 |
| Strategy E `momentum_cascade` | conditional | Strategy A add-on |

## Strategy A: Volume Spike Breakout

### Entry

```text
volume >= avg[20] x 3.0
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

## Strategy C: Fib Pullback

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
- 현재 runtime의 active core 전략이다.

## Realtime Trigger

두 가지 모드 지원. `REALTIME_TRIGGER_MODE` env var로 전환 (default: `bootstrap`).

### Bootstrap Mode (`volumeMcapSpikeTrigger`) — default

breakout/confirm 제거. volume acceleration + buy ratio만으로 발화.
Core 모드 대비 signal 밀도 대폭 개선 (noBreakout=100%, confirmFail=100% 해소).

```text
Primary interval: 10s
Volume lookback: 20
Volume multiplier: 2.5
Min buy ratio: 0.55              ← REALTIME_BOOTSTRAP_MIN_BUY_RATIO (soft filter)
Cooldown: 300s
```

롤백: `REALTIME_TRIGGER_MODE=core` → pm2 restart.

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

## Conditional Strategies

### Strategy D

- sandbox wallet only
- fixed ticket (`0.02 SOL` default)
- live main wallet path에 섞지 않는다

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

## Current Key Parameters

### Order Shape

| 키 | Default Path | Live Path | 비고 |
|---|---|---|---|
| `TP1_MULTIPLIER` | `1.0` | `1.0` | 공통 |
| `TP2_MULTIPLIER` | `10.0` | `10.0` | 공통. v5 runner-centric (sweep 최적 5.0에서 확장) |
| `SL_ATR_MULTIPLIER` | `1.0` | — | default/backtest path |
| `REALTIME_SL_ATR_MULTIPLIER` | — | `1.5` | live path (slippage 고려) |
| `TIME_STOP_MINUTES` | `20` | — | default/backtest path |
| `REALTIME_TIME_STOP_MINUTES` | — | `15` | live path |
| `TP1_PARTIAL_PCT` | `0.3` | `0.3` | 공통 |
| `TRAILING_AFTER_TP1_ONLY` | `true` | `true` | 공통 |

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

| 키 | VPS 현재값 | 비고 |
|---|---|---|
| `REALTIME_TRIGGER_MODE` | `bootstrap` | bootstrap / core |
| `REALTIME_VOLUME_SURGE_MULTIPLIER` | `2.5` | 4차 점검: 3.0→2.5 |
| `REALTIME_BOOTSTRAP_MIN_BUY_RATIO` | `0.55` | bootstrap 전용 soft filter |
| `REALTIME_CONFIRM_MIN_BARS` | `3` | core 전용 |
| `REALTIME_CONFIRM_MIN_CHANGE_PCT` | `0.02` | core 전용 |
| `REALTIME_COOLDOWN_SEC` | `300` | |
| `VOLUME_SPIKE_MULTIPLIER` | `3.0` | backtest path |
| `MIN_BREAKOUT_SCORE` | `50` | |
| `MIN_BUY_RATIO` | `0.65` | |
| `MAX_WATCHLIST_SIZE` | `20` | |
| `REALTIME_MAX_SUBSCRIPTIONS` | `30` | |
| `AGE_BUCKET_HARD_FLOOR_MIN` | `5` | |
| `MAX_CONCURRENT_ABSOLUTE` | `3` | |

## One-Line Summary

> `STRATEGY.md`는 현재 runtime에서 바로 읽어야 할 전략/Gate/Risk quick reference만 담는 문서다.
