# Realized vs Replay Edge Ratio — 2026-04-07

> Mode: `live` | Horizon: 180s | Strategy filter: `bootstrap`
> Trades source: `data/vps-trades-latest.jsonl`
> Sessions scanned: 39 | Signal records: 337
> Closed trades: 15 | Matched to signals: 14
> Match source: trade_id=0, tx_signature=14

## What this measures

- **Realized %** = (exit_price − entry_price) / entry_price × 100 (실체결 fill price 기반)
- **Predicted adj %** = signal.horizons[180s].adjustedReturnPct (replay 헤드라인과 동일 metric)
- **Ratio** = realized / predicted_adj (1.0 = replay 그대로 실현, 0.0 = 완전 손실)
- 이상치 수렴을 위해 `ratioRealizedTotal` = Σ realized / Σ predicted_adj 도 함께 보고

## Overall

- Matched trades: **14**
- Avg realized: **-0.99%**
- Avg predicted adj (replay): **-0.00%**
- Avg predicted raw (no cost): 0.00%
- Mean of per-trade ratios: **-896.90**
- Median per-trade ratio: -24.30
- Sum-based ratio (Σ realized / Σ predicted_adj): **626.92**
- Win rate: 7.1%

## Per-session

| Session | n | Avg Realized | Avg Predicted Adj | Sum Ratio | Avg Ratio |
|---|---:|---:|---:|---:|---:|
| 2026-04-06T03-20-29-395Z-live | 4 | -0.82% | -0.00% | 441.83 | -75.47 |
| 2026-04-06T14-17-04-255Z-live | 6 | -1.69% | -0.00% | 452.22 | -1999.64 |
| 2026-04-07T03-53-05-856Z-live | 4 | -0.13% | 0.00% | -65.92 | -64.22 |

## Per-trade detail

| Trade ID (8) | Match | Session | Pair (8) | Realized | Predicted Adj | Ratio | Decision Gap | Exit Reason |
|---|---|---|---|---:|---:|---:|---:|---|
| 581a8711 | tx_signature | 2026-04-06T03-20 | Dfh5DzRg | -0.49% | 0.00% | -506.91 | —% | TAKE_PROFIT_2 |
| 418b9511 | tx_signature | 2026-04-06T03-20 | 98mb39tP | -1.74% | -0.01% | 238.05 | —% | TAKE_PROFIT_2 |
| 275d27f7 | tx_signature | 2026-04-06T03-20 | 98mb39tP | -0.61% | 0.01% | -89.64 | —% | TAKE_PROFIT_2 |
| cc45aa5a | tx_signature | 2026-04-06T03-20 | Dfh5DzRg | -0.45% | -0.01% | 56.61 | —% | TAKE_PROFIT_2 |
| 1ec7e3dc | tx_signature | 2026-04-06T14-17 | CYTUg8qL | -0.15% | 0.01% | -24.30 | -0.93% | TAKE_PROFIT_1 |
| 1953c360 | tx_signature | 2026-04-06T14-17 | CYTUg8qL | -3.64% | -0.01% | 643.90 | -95.48% | TAKE_PROFIT_2 |
| 755f4f16 | tx_signature | 2026-04-06T14-17 | Dfh5DzRg | -0.42% | -0.01% | 27.86 | -84.51% | TAKE_PROFIT_2 |
| 71a550fd | tx_signature | 2026-04-06T14-17 | Dfh5DzRg | -0.35% | -0.01% | 25.03 | -84.21% | TAKE_PROFIT_2 |
| ab340c9e | tx_signature | 2026-04-06T14-17 | 4ytpZgVo | -5.08% | 0.00% | -12579.67 | -100.00% | TAKE_PROFIT_2 |
| 14b020a9 | tx_signature | 2026-04-06T14-17 | 4ytpZgVo | -0.51% | 0.01% | -90.68 | -100.00% | TAKE_PROFIT_2 |
| 2207984d | tx_signature | 2026-04-07T03-53 | Dfh5DzRg | 0.41% | 0.00% | 234.96 | -0.41% | TAKE_PROFIT_1 |
| 694ca489 | tx_signature | 2026-04-07T03-53 | Dfh5DzRg | -0.56% | 0.00% | -323.53 | 0.01% | STOP_LOSS |
| 480c3f39 | tx_signature | 2026-04-07T03-53 | Dfh5DzRg | -0.13% | 0.00% | -62.88 | -0.45% | TAKE_PROFIT_1 |
| faaf7a04 | tx_signature | 2026-04-07T03-53 | Dfh5DzRg | -0.22% | 0.00% | -105.45 | 0.17% | STOP_LOSS |

## Interpretation guide

| Sum Ratio | Verdict | Mission Implication |
|---:|---|---|
| ≥ 0.8 | execution layer가 replay edge를 거의 보존 | replay 예측을 mission math에 사실상 그대로 사용 가능 |
| 0.5 – 0.8 | 30-50% 손실 (slippage / timing) | edge 낙폭 반영 후 mission horizon 1.5-2x 연장 |
| 0.2 – 0.5 | 절반 이상 손실, slippage 또는 SL 오작동 의심 | 실행 layer 개선 없이는 mission 도달 가능성 낮음 |
| < 0.2 | edge 사실상 전무 | 전략 또는 execution path 재검토 필수 |
| < 0 | 음수 — replay 양수가 실현 음수로 뒤집힘 | sample contamination 또는 chronic adverse selection |

### Notes
- Match rate는 (matched / total trades). 1차는 tradeId, 2차는 tx_signature fallback으로 매칭한다.
- Decision gap = paper에서 발생한 entry slippage (decision_price → fill price).
- 표본 < 20이면 ratio는 reference만. 20 trades 누적 후 P3 verdict 확정.