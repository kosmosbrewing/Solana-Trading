# Realized vs Replay Edge Ratio — 2026-04-07

> Horizon: 180s | Strategy filter: `all`
> Sessions scanned: 38 | Signal records: 321
> Closed paper trades: 19 | Matched to signals: 0

## What this measures

- **Realized %** = (exit_price − entry_price) / entry_price × 100 (paper fill price 기반)
- **Predicted adj %** = signal.horizons[180s].adjustedReturnPct (replay 헤드라인과 동일 metric)
- **Ratio** = realized / predicted_adj (1.0 = replay 그대로 실현, 0.0 = 완전 손실)
- 이상치 수렴을 위해 `ratioRealizedTotal` = Σ realized / Σ predicted_adj 도 함께 보고

## Overall

No matched trades. Run paper mode to accumulate signals + trades, then re-run this script.

## Per-session

(no session breakdown — no matched trades)

## Per-trade detail

(none)

## Interpretation guide

| Sum Ratio | Verdict | Mission Implication |
|---:|---|---|
| ≥ 0.8 | execution layer가 replay edge를 거의 보존 | replay 예측을 mission math에 사실상 그대로 사용 가능 |
| 0.5 – 0.8 | 30-50% 손실 (slippage / timing) | edge 낙폭 반영 후 mission horizon 1.5-2x 연장 |
| 0.2 – 0.5 | 절반 이상 손실, slippage 또는 SL 오작동 의심 | 실행 layer 개선 없이는 mission 도달 가능성 낮음 |
| < 0.2 | edge 사실상 전무 | 전략 또는 execution path 재검토 필수 |
| < 0 | 음수 — replay 양수가 실현 음수로 뒤집힘 | sample contamination 또는 chronic adverse selection |

### Notes
- Match rate는 (matched / total trades). 낮으면 signal-trade tradeId 누락 또는 sessions/시기 불일치.
- Decision gap = paper에서 발생한 entry slippage (decision_price → fill price).
- 표본 < 20이면 ratio는 reference만. 20 trades 누적 후 P3 verdict 확정.