# STRATEGY.md

> Status: current quick reference
> Updated: 2026-03-31
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
| Realtime `momentumTrigger` | active trigger path | Helius micro-candle 기반 초봉 트리거 |
| Strategy D `new_lp_sniper` | sandbox | 별도 지갑 실험 전략 |
| Strategy E `momentum_cascade` | conditional | Strategy A add-on |

## Strategy A: Volume Spike Breakout

### Entry

```text
volume >= avg[20] x 2.5
close > highestHigh[20]
```

### Current Order Shape

```text
SL  = entry - ATR x 1.0
TP1 = entry + ATR x 1.0
TP2 = entry + ATR x 10.0
Time Stop = 20m
TP1 partial = 30%
Trailing = TP1 이후에만 활성화
```

### Why It Matters

- 현재 v5 기준 "수익은 길게, 손실은 짧게" 구조가 반영된 코어 전략이다.
- old ATR `1.5 / 3.5` 구조가 아니라, runner 여지를 남기는 형태로 해석해야 한다.

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

## Realtime Trigger: `momentumTrigger`

### Current Trigger

```text
Primary interval: 10s
Confirm interval: 60s
Volume lookback: 20
Volume multiplier: 3.0
Breakout lookback: 20
Confirm min bars: 3
Confirm min change pct: 0.02
Cooldown: 300s
```

### Current Realtime Order Shape

```text
SL mode = atr
SL ATR multiplier = 1.5
TP1 = ATR x 1.0
TP2 = ATR x 10.0
Time Stop = 15m
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

v5는 runner-centric (TP2=10x ATR) 전략이므로, RR 평가도 TP2 기준으로 해야
구조적 rejection을 피할 수 있다. TP1 기준은 SL과 대칭(1x ATR)이라 roundTripCost만큼 항상 불리하다.

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

| 키 | 현재 기본값 |
|---|---|
| `VOLUME_SPIKE_MULTIPLIER` | `2.5` |
| `MIN_BREAKOUT_SCORE` | `50` |
| `MIN_BUY_RATIO` | `0.65` |
| `TP1_MULTIPLIER` | `1.0` |
| `TP2_MULTIPLIER` | `10.0` |
| `SL_ATR_MULTIPLIER` | `1.0` |
| `TIME_STOP_MINUTES` | `20` |
| `TP1_PARTIAL_PCT` | `0.3` |
| `TRAILING_AFTER_TP1_ONLY` | `true` |
| `EXECUTION_RR_BASIS` | `tp2` |
| `EXECUTION_RR_REJECT` | `1.2` |
| `EXECUTION_RR_PASS` | `1.5` |
| `MAX_POSITION_PCT` | `0.20` |
| `MAX_SELL_IMPACT` | `0.03` |
| `SELL_IMPACT_SIZING_THRESHOLD` | `0.015` |

## One-Line Summary

> `STRATEGY.md`는 현재 runtime에서 바로 읽어야 할 전략/Gate/Risk quick reference만 담는 문서다.
