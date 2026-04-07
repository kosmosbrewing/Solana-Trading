# Mission Horizon Recalculation — 2026-04-07

> P5 deliverable. P0 (runtime fidelity) + P1 (focused grid) + P2 (LOO robustness) 결과를 입력으로,
> 1 SOL → 100 SOL mission 도달까지 거리(시간/세션 수)를 다중 시나리오로 추정한다.

## Constants

- 목표: **100x bankroll** (1 SOL → 100 SOL)
- 자연로그 기준 doublings: ln(100) / ln(2) ≈ **6.644**
- 로그 성장률 목표: ln(100) ≈ **4.605** (필요 누적 로그 수익률)
- 일평균 활성 세션 수 가정: **1 session/day** (Helius shadow 운영 cadence)

## Edge inputs (from P1 + P2)

| Profile | Source | Per-session weighted adj % | Note |
|---|---|---:|---|
| Replay headline (best, full 10 sess) | focused sweep | **+24.02%** | vm2.4-br0.65-lb20-cd180 |
| LOO worst-case (drop best contributor) | LOO | +16.76% | drop 04-06T03-20 |
| LO2O stress (drop top-2 outliers) | LO2O | **+9.23%** | drop 03-31 + 04-06T03-20 |
| LO2O × realized-50% (assumed cost survival) | hypothesis | +4.62% | execution layer 보존율 50% 가정 |
| LO2O × realized-30% | hypothesis | +2.77% | 보존율 30% |
| LO2O × realized-10% | hypothesis | +0.92% | 보존율 10% |

> **중요 가정 #1**: weighted adj %는 per-signal adjusted return의 signal-weighted 평균이다.
> 1 session = 1 day 가정 하에서, **bankroll-level 일일 수익률 ≈ weighted adj % × signal_to_trade_conversion × position_concentration**.
> 본 모델은 단순화를 위해 "weighted adj %"가 그대로 daily bankroll 변화율이라고 가정한다 — 이는
> **upper bound** 이며, 실제로는 cooldown / position cap / 동시 trade 제한으로 더 낮다.

> **중요 가정 #2**: 각 세션의 수익률이 독립이고 동일 분포라고 가정 (i.i.d.). 실제로는 sessoin
> 간 자기상관, 변동성 클러스터링, 시장 regime shift가 존재한다.

## Compounding model

기간 내 N 세션에서 각 세션 수익률 r 일정 → bankroll 배수 = (1 + r)^N
- 100x 도달 조건: (1 + r)^N ≥ 100
- N = ln(100) / ln(1 + r) = **4.605 / ln(1 + r)**

## Scenarios

| 시나리오 | r (per session) | ln(1+r) | Sessions to 100x | Days (1 session/day) |
|---|---:|---:|---:|---:|
| Replay headline | 24.02% | 0.2152 | **21.4** | ~22 |
| LOO worst | 16.76% | 0.1550 | **29.7** | ~30 |
| LO2O stress | 9.23% | 0.0883 | **52.2** | ~52 |
| LO2O × 50% realized | 4.62% | 0.0451 | **102.0** | ~102 |
| LO2O × 30% realized | 2.77% | 0.0273 | **168.7** | ~169 |
| LO2O × 10% realized | 0.92% | 0.00919 | **501.2** | ~501 |
| Bear (after-cost +0.5%) | 0.50% | 0.00499 | **923.4** | ~923 |
| Catastrophe (-0.5%) | -0.50% | -0.00501 | ∞ | 도달 불가 |

## Sensitivity Heatmap (sessions to 100x)

행: outlier survival 시나리오 / 열: execution realization factor (cost layer 보존율).
각 cell = 4.605 / ln(1 + row_r × col_c).

| Outlier Survival ↓ / Realization → | 100% | 50% | 30% | 10% |
|---|---:|---:|---:|---:|
| Replay headline (24.02%) | 21 | 41 | 66 | 194 |
| LOO worst (16.76%) | 30 | 57 | 94 | 277 |
| LO2O stress (9.23%) | 52 | 102 | 169 | 501 |
| Conservative (5%) | 94 | 186 | 309 | 923 |
| Bear (1%) | 463 | 923 | 1537 | 4607 |

## Reading the table

- **Top-left corner** (Replay headline × 100% realization): **21 days, 1 SOL → 100 SOL**
  - 사실상 도달 불가능한 upper bound. P0가 입증한 swaps replay = signal-generation truth지만,
    execution layer 손실 0%는 비현실적.
- **Mid corridor** (LO2O × 50%): **102 days**
  - LOO와 cost survival 절반 가정 모두 적용한 "현실 추정 시나리오".
- **Bottom-right** (Bear × 10%): **4624 days = 12.7년**
  - 현재 strategy로는 mission 사실상 불가능.

## Outlier dependency reminder

P2 LOO 결과에서 확인된 주요 사실:
- 03-31 단일 세션 = headline의 **36.9%** 기여
- 04-06T03-20 (34 signals only) = **32.2%** 기여
- **상위 2 outlier 합 = 69.1%**

LO2O 시나리오는 이 두 outlier 동시 제거를 가정하며 +9.23%로 떨어진다. 향후 9 세션 표본이 더 모이지 않으면, edge가 outlier-dependent 인지 statistically robust 인지 구분 자체가 불가능.

## What's needed to reduce uncertainty

### Knowns (현 시점 확정)
- Replay headline: +24.02%/session under best profile
- LOO worst: +16.76% (sign hold)
- LO2O stress: +9.23% (sign hold, magnitude 큰 폭 감소)
- All top 5 profiles tightly clustered (< 1pp spread) → hyperparameter sensitivity 낮음

### Unknowns (P3 / 추가 데이터로 좁혀야 할 부분)
1. **Realization factor** (P3): replay → realized PnL 보존율. 현재 0% ~ 100% 전 영역이 가능.
2. **Independence**: 세션 간 상관관계, regime shift 영향
3. **Trade conversion**: signal 수 → 실제 trade 수 비율. cooldown / wallet limit 영향
4. **Position concentration**: bootstrap 1% risk 하에서 평균 position size, peak concurrency

## Mission feasibility verdict

### Probabilistic statement (현 데이터 기반)

LOO worst (16.76%/sess)을 baseline edge로, 다양한 execution realization factor 적용:

| 보존율 가정 | 적용 r (per session) | 100x 도달까지 sessions ≈ days | Verdict |
|---|---:|---:|---|
| 100% (replay 그대로) | 16.76% | **30** | aspiration upper bound (cost 0 가정) |
| 80% (best case execution) | 13.41% | **37** | 거의 무손실 — 비현실적 |
| 50% (mid case) | 8.38% | **57** | **plausible mid-case**, 약 8주 |
| 30% (conservative) | 5.03% | **94** | **likely realistic**, 약 3개월 |
| 10% (bear) | 1.68% | **277** | mission 회의적, 약 9개월 |

> **추정 권장 baseline**: 30%-50% realization × LOO worst (+16.76%) → **57-94 sessions ≈ 2-3개월**.

### What this means for runway / decision

1. P3가 realization factor를 측정할 때까지는 모든 시나리오가 **±5x 범위**를 가진다.
2. mission 도달 가능성을 정량 평가하려면 **20+ paper trades** 우선 필요.
3. 그 전에 의사결정 가능한 것: **best profile 채택은 안전** (P2 LOO 통과), **focused grid로 grid noise 제거 완료**.

## Recommended next decisions

### 즉시 (코드 / 인프라)
- [x] Best profile 확정: `vm2.4-br0.65-lb20-cd180` (P2 verdict)
- [x] Focused grid 도입 (2026-04-07 P1, this commit)
- [ ] **P3 실행**: paper 모드 best profile 주입 → 20 trades 누적 → realized/replay ratio 측정

### P3 결과 후 (조건부)
- IF realization ≥ 50%: bootstrap → calibration tier 전환 검토 (50 trades 향)
- IF realization 20-50%: execution layer 개선 우선 (slippage / SL trigger fidelity)
- IF realization < 20%: 전략 재검토, paper 데이터 확장 후 sweep 재실행

## Caveats

1. 1 session = 1 day 가정은 단순화. 실제 cadence는 Helius WS 가동 시간에 의존.
2. 단일 i.i.d. compounding 모델은 path-dependent (drawdown, kelly fraction adjustment) 효과를 무시.
3. 100x mission이 기술적으로 가능한지와 별개로, **risk budget (max DD 30%) 내에서 도달 가능한지**는
   별도 sim 필요. 현재 모델은 ruin probability를 측정하지 않는다.
4. LO2O는 두 outlier를 "데이터 오염"으로 가정한 worst case. outlier가 진짜 edge라면 LO2O는 over-penalty.

## References

- P0: `docs/audits/bootstrap-runtime-fidelity-2026-04-07.md`
- P1: `results/session-replay-sweep-bootstrap-swaps-focused-2026-04-07.{json,md}`
- P2: `docs/audits/bootstrap-loo-robustness-2026-04-07.md`
- P3 status: `docs/audits/realized-replay-ratio-status-2026-04-07.md`
- P3 tooling: `scripts/analysis/realized-replay-ratio.ts`
