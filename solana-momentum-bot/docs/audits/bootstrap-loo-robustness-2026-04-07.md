# Bootstrap LOO Robustness Analysis — 2026-04-07

> Source: `results/session-replay-sweep-bootstrap-swaps-focused-2026-04-07.json`
> Strategy: bootstrap_10s | Input: swaps | Grid: 12 profiles
> Sessions: 10 | Top profiles analyzed: 5

## Robust Criteria

1. **Rank Δ ≤ 1**: 모든 LOO 변형에서 top 5 안 순위 1단계 이하 변동
2. **Sign hold**: 모든 LOO 변형에서 weighted adj > 0
3. **Gate-pass floor**: 모든 LOO 변형에서 gate-pass ≥ baseline − 1 (passing 세션 1개 제거의 자연 감소만 허용)

## Baseline (10 sessions)

| Rank | Profile | Weighted Adj | Gate-pass | Avg Edge | Signals |
|---:|---|---:|---:|---:|---:|
| 1 | vm2.4-br0.65-lb20-cd180 | 24.02% | 6/10 | 56.1 | 1240 |
| 2 | vm2.4-br0.6-lb20-cd180 | 23.75% | 6/10 | 56.1 | 1255 |
| 3 | vm2.4-br0.55-lb20-cd180 | 23.27% | 6/10 | 56.1 | 1278 |
| 4 | vm2.2-br0.65-lb20-cd180 | 22.15% | 5/10 | 55.3 | 1338 |
| 5 | vm2.2-br0.6-lb20-cd180 | 21.80% | 5/10 | 55.3 | 1360 |

## vm2.4-br0.65-lb20-cd180

- Baseline: rank 1 | weighted adj 24.02% | gate-pass 6/10
- Gate-pass floor (9 sessions): 5/9

| Dropped Session | LOO Adj | Δ vs base | LOO Gate-pass | LOO Rank | Rank Δ |
|---|---:|---:|---:|---:|---:|
| 2026-04-03T15-45-41-044Z-live | 27.71% | +3.69pp | 5/9 | 1 | +0 |
| 2026-04-04T14-31-50-271Z-live | 26.77% | +2.75pp | 6/9 | 1 | +0 |
| 2026-04-06T14-17-04-255Z-live | 24.62% | +0.60pp | 5/9 | 1 | +0 |
| 2026-04-06T03-20-29-395Z-live | 16.76% | -7.27pp | 5/9 | 1 | +0 |
| 2026-04-03T03-53-57-260Z-live | 23.33% | -0.69pp | 5/9 | 1 | +0 |
| 2026-04-04T03-58-37-308Z-live | 24.29% | +0.26pp | 6/9 | 1 | +0 |
| 2026-04-02T03-18-12-410Z-live | 29.03% | +5.00pp | 5/9 | 1 | +0 |
| 2026-04-04T06-31-53-863Z-live | 23.17% | -0.85pp | 6/9 | 1 | +0 |
| 2026-03-31T15-15-34-690Z-live | 18.20% | -5.82pp | 5/9 | 1 | +0 |
| 2026-04-04T08-29-16-439Z-live | 27.38% | +3.35pp | 6/9 | 1 | +0 |

### Verdict

- Rank stability: PASS (max Δ = 0)
- Sign hold: PASS (min LOO adj = 16.76%)
- Gate-pass floor: PASS (min LOO gate-pass = 5/9)
- **Overall: ROBUST**

## vm2.4-br0.6-lb20-cd180

- Baseline: rank 2 | weighted adj 23.75% | gate-pass 6/10
- Gate-pass floor (9 sessions): 5/9

| Dropped Session | LOO Adj | Δ vs base | LOO Gate-pass | LOO Rank | Rank Δ |
|---|---:|---:|---:|---:|---:|
| 2026-04-03T15-45-41-044Z-live | 27.49% | +3.74pp | 5/9 | 2 | +0 |
| 2026-04-04T14-31-50-271Z-live | 26.44% | +2.69pp | 6/9 | 2 | +0 |
| 2026-04-06T14-17-04-255Z-live | 24.33% | +0.58pp | 5/9 | 2 | +0 |
| 2026-04-06T03-20-29-395Z-live | 16.60% | -7.16pp | 5/9 | 2 | +0 |
| 2026-04-03T03-53-57-260Z-live | 23.04% | -0.71pp | 5/9 | 2 | +0 |
| 2026-04-04T03-58-37-308Z-live | 24.01% | +0.26pp | 6/9 | 2 | +0 |
| 2026-04-02T03-18-12-410Z-live | 28.63% | +4.88pp | 5/9 | 2 | +0 |
| 2026-04-04T06-31-53-863Z-live | 22.91% | -0.84pp | 6/9 | 2 | +0 |
| 2026-03-31T15-15-34-690Z-live | 17.98% | -5.77pp | 5/9 | 2 | +0 |
| 2026-04-04T08-29-16-439Z-live | 27.11% | +3.35pp | 6/9 | 2 | +0 |

### Verdict

- Rank stability: PASS (max Δ = 0)
- Sign hold: PASS (min LOO adj = 16.60%)
- Gate-pass floor: PASS (min LOO gate-pass = 5/9)
- **Overall: ROBUST**

## vm2.4-br0.55-lb20-cd180

- Baseline: rank 3 | weighted adj 23.27% | gate-pass 6/10
- Gate-pass floor (9 sessions): 5/9

| Dropped Session | LOO Adj | Δ vs base | LOO Gate-pass | LOO Rank | Rank Δ |
|---|---:|---:|---:|---:|---:|
| 2026-04-03T15-45-41-044Z-live | 27.10% | +3.83pp | 5/9 | 3 | +0 |
| 2026-04-04T14-31-50-271Z-live | 25.89% | +2.63pp | 6/9 | 3 | +0 |
| 2026-04-06T14-17-04-255Z-live | 23.85% | +0.58pp | 5/9 | 3 | +0 |
| 2026-04-06T03-20-29-395Z-live | 16.23% | -7.04pp | 5/9 | 3 | +0 |
| 2026-04-03T03-53-57-260Z-live | 22.50% | -0.77pp | 5/9 | 3 | +0 |
| 2026-04-04T03-58-37-308Z-live | 23.52% | +0.25pp | 6/9 | 3 | +0 |
| 2026-04-02T03-18-12-410Z-live | 28.06% | +4.79pp | 5/9 | 3 | +0 |
| 2026-04-04T06-31-53-863Z-live | 22.44% | -0.83pp | 6/9 | 3 | +0 |
| 2026-03-31T15-15-34-690Z-live | 17.55% | -5.71pp | 5/9 | 3 | +0 |
| 2026-04-04T08-29-16-439Z-live | 26.59% | +3.32pp | 6/9 | 3 | +0 |

### Verdict

- Rank stability: PASS (max Δ = 0)
- Sign hold: PASS (min LOO adj = 16.23%)
- Gate-pass floor: PASS (min LOO gate-pass = 5/9)
- **Overall: ROBUST**

## vm2.2-br0.65-lb20-cd180

- Baseline: rank 4 | weighted adj 22.15% | gate-pass 5/10
- Gate-pass floor (9 sessions): 4/9

| Dropped Session | LOO Adj | Δ vs base | LOO Gate-pass | LOO Rank | Rank Δ |
|---|---:|---:|---:|---:|---:|
| 2026-04-03T15-45-41-044Z-live | 25.65% | +3.50pp | 5/9 | 4 | +0 |
| 2026-04-04T14-31-50-271Z-live | 24.75% | +2.60pp | 5/9 | 4 | +0 |
| 2026-04-06T14-17-04-255Z-live | 22.58% | +0.44pp | 4/9 | 4 | +0 |
| 2026-04-06T03-20-29-395Z-live | 15.87% | -6.28pp | 4/9 | 4 | +0 |
| 2026-04-03T03-53-57-260Z-live | 21.76% | -0.39pp | 4/9 | 4 | +0 |
| 2026-04-04T03-58-37-308Z-live | 22.41% | +0.27pp | 5/9 | 4 | +0 |
| 2026-04-02T03-18-12-410Z-live | 25.25% | +3.11pp | 4/9 | 4 | +0 |
| 2026-04-04T06-31-53-863Z-live | 21.36% | -0.78pp | 5/9 | 4 | +0 |
| 2026-03-31T15-15-34-690Z-live | 17.17% | -4.97pp | 4/9 | 5 | +1 |
| 2026-04-04T08-29-16-439Z-live | 25.25% | +3.10pp | 5/9 | 4 | +0 |

### Verdict

- Rank stability: PASS (max Δ = 1)
- Sign hold: PASS (min LOO adj = 15.87%)
- Gate-pass floor: PASS (min LOO gate-pass = 4/9)
- **Overall: ROBUST**

## vm2.2-br0.6-lb20-cd180

- Baseline: rank 5 | weighted adj 21.80% | gate-pass 5/10
- Gate-pass floor (9 sessions): 4/9

| Dropped Session | LOO Adj | Δ vs base | LOO Gate-pass | LOO Rank | Rank Δ |
|---|---:|---:|---:|---:|---:|
| 2026-04-03T15-45-41-044Z-live | 25.39% | +3.59pp | 5/9 | 5 | +0 |
| 2026-04-04T14-31-50-271Z-live | 24.33% | +2.53pp | 5/9 | 5 | +0 |
| 2026-04-06T14-17-04-255Z-live | 22.21% | +0.41pp | 4/9 | 5 | +0 |
| 2026-04-06T03-20-29-395Z-live | 15.64% | -6.16pp | 4/9 | 5 | +0 |
| 2026-04-03T03-53-57-260Z-live | 21.38% | -0.42pp | 4/9 | 5 | +0 |
| 2026-04-04T03-58-37-308Z-live | 22.06% | +0.26pp | 5/9 | 5 | +0 |
| 2026-04-02T03-18-12-410Z-live | 24.85% | +3.05pp | 4/9 | 5 | +0 |
| 2026-04-04T06-31-53-863Z-live | 21.03% | -0.77pp | 5/9 | 5 | +0 |
| 2026-03-31T15-15-34-690Z-live | 16.87% | -4.93pp | 4/9 | 7 | +2 ⚠ rank |
| 2026-04-04T08-29-16-439Z-live | 24.87% | +3.07pp | 5/9 | 5 | +0 |

### Verdict

- Rank stability: FAIL (max Δ = 2)
- Sign hold: PASS (min LOO adj = 15.64%)
- Gate-pass floor: PASS (min LOO gate-pass = 4/9)
- **Overall: FRAGILE**

## Summary Table

| Profile | Baseline Adj | Min LOO Adj | Max Adj Δ (pp) | Max Rank Δ | Sign Hold | Gate Hold | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| vm2.4-br0.65-lb20-cd180 | 24.02% | 16.76% | 7.27 | 0 | OK | OK | ROBUST |
| vm2.4-br0.6-lb20-cd180 | 23.75% | 16.60% | 7.16 | 0 | OK | OK | ROBUST |
| vm2.4-br0.55-lb20-cd180 | 23.27% | 16.23% | 7.04 | 0 | OK | OK | ROBUST |
| vm2.2-br0.65-lb20-cd180 | 22.15% | 15.87% | 6.28 | 1 | OK | OK | ROBUST |
| vm2.2-br0.6-lb20-cd180 | 21.80% | 15.64% | 6.16 | 2 | OK | OK | FRAGILE |

## Outlier Contribution

Best profile에서 각 세션이 weighted adj에 기여하는 비율:

- Profile: `vm2.4-br0.65-lb20-cd180`
- Total signals: 1240 | Weighted sum: 29788.41 | Weighted adj: 24.02%

| Session | Signals | Adj | Contribution (signals × adj) | % of total |
|---|---:|---:|---:|---:|
| 2026-03-31T15-15-34-690Z-live | 208 | 52.89% | 11001.12 | 36.9% |
| 2026-04-06T03-20-29-395Z-live | 34 | 281.73% | 9578.82 | 32.2% |
| 2026-04-03T03-53-57-260Z-live | 158 | 28.74% | 4540.92 | 15.2% |
| 2026-04-06T14-17-04-255Z-live | 123 | 18.60% | 2287.80 | 7.7% |
| 2026-04-02T03-18-12-410Z-live | 275 | 6.46% | 1776.50 | 6.0% |
| 2026-04-04T06-31-53-863Z-live | 11 | 119.21% | 1311.31 | 4.4% |
| 2026-04-04T14-31-50-271Z-live | 103 | -6.35% | -654.05 | -2.2% |
| 2026-04-03T15-45-41-044Z-live | 187 | 3.24% | 605.88 | 2.0% |
| 2026-04-04T08-29-16-439Z-live | 130 | -4.62% | -600.60 | -2.0% |
| 2026-04-04T03-58-37-308Z-live | 11 | -5.39% | -59.29 | -0.2% |

## Leave-Two-Out Stress (Best Profile)

Best profile에서 절대 기여도 상위 2개 세션을 동시에 제거한 worst-case 시나리오:

- Profile: `vm2.4-br0.65-lb20-cd180`
- Top contributor #1: 2026-03-31T15-15-34-690Z-live (36.9% of total)
- Top contributor #2: 2026-04-06T03-20-29-395Z-live (32.2% of total)

| Scenario | Sessions | Weighted Adj | Δ vs base | Gate-pass |
|---|---:|---:|---:|---:|
| Baseline | 10 | 24.02% | — | 6/10 |
| Drop #1 only | 9 | 18.20% | -5.82pp | 5/9 |
| Drop #2 only | 9 | 16.76% | -7.27pp | 5/9 |
| **Drop both** | 8 | **9.23%** | **-14.80pp** | 4/8 |

**LO2O verdict**: LO2O sign + magnitude hold (>+5%)
