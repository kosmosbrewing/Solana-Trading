# Realized vs Replay Edge Ratio — 2026-04-07

> Mode: `live` | Horizon: 180s | Strategy filter: `all`
> Trades source: `data/vps-trades-latest.jsonl`
> Sessions scanned: 40 | Signal records: 341
> Closed trades: raw=133, clean=131 (anomaly filter excluded 1 parent groups / 2 rows)
> Matched to signals: 127
> Match source: trade_id=0, tx_signature=127
> Anomaly filter rule: `exit_anomaly_reason` set OR `exit_slippage_bps >= 9000` (parent group 단위 drop — TP1 partial child가 anomalous면 parent 합산 pnl 전체 오염)

## What this measures

- **Realized %** = (exit_price − entry_price) / entry_price × 100 (실체결 fill price 기반)
- **Predicted adj %** = signal.horizons[180s].adjustedReturnPct (replay 헤드라인과 동일 metric)
- **Ratio** = realized / predicted_adj (1.0 = replay 그대로 실현, 0.0 = 완전 손실)
- 이상치 수렴을 위해 `ratioRealizedTotal` = Σ realized / Σ predicted_adj 도 함께 보고

## Overall

- Matched trades: **127** (parent-dedup 적용)
- Avg realized: **153.66%**
- Avg predicted adj (replay): **-0.01%**
- Avg predicted raw (no cost): -0.00%
- Mean of per-trade ratios: **6109.70** (n=3 finite, 124 excluded by |denom|<0.05% floor)
- Median per-trade ratio: 25.10
- Sum-based ratio (Σ realized / Σ predicted_adj): **-20636.59**
- Win rate: 48.0%

## Per-session

| Session | n | Avg Realized | Avg Predicted Adj | Sum Ratio | Avg Ratio |
|---|---:|---:|---:|---:|---:|
| 2026-04-03T15-45-41-044Z-live | 103 | 189.81% | -0.00% | -126965.24 | 18303.74 |
| 2026-04-06T03-20-29-395Z-live | 4 | -0.82% | -0.00% | — | — |
| 2026-04-06T14-17-04-255Z-live | 6 | -1.69% | -0.00% | — | — |
| 2026-04-07T03-53-05-856Z-live | 1 | -0.22% | 0.00% | — | — |
| legacy-2026-03-31T13-04-55-420Z | 13 | -1.68% | -0.06% | 28.51 | 12.67 |

## Per-trade detail

| Trade ID (8) | Match | Session | Pair (8) | Realized | Predicted Adj | Ratio | Decision Gap | Exit Reason |
|---|---|---|---|---:|---:|---:|---:|---|
| 867cb4f4 | tx_signature | legacy-2026-03-3 | Dfh5DzRg | -9.94% | 0.03% | — | —% | TRAILING_STOP |
| 2c1d08af | tx_signature | legacy-2026-03-3 | Dfh5DzRg | -0.77% | 0.01% | — | —% | TRAILING_STOP |
| c61414a4 | tx_signature | legacy-2026-03-3 | 6yjNqPzT | -1.13% | 0.01% | — | —% | EXHAUSTION |
| 4e7ed92d | tx_signature | legacy-2026-03-3 | 6yjNqPzT | -1.54% | 0.02% | — | —% | EXHAUSTION |
| b4c69607 | tx_signature | legacy-2026-03-3 | Dfh5DzRg | -2.82% | -0.03% | — | —% | TRAILING_STOP |
| 8132fc5f | tx_signature | legacy-2026-03-3 | Dfh5DzRg | -1.43% | -0.01% | — | —% | TRAILING_STOP |
| 0f10490d | tx_signature | legacy-2026-03-3 | 6yjNqPzT | -0.03% | -0.00% | — | —% | TRAILING_STOP |
| 30e0c818 | tx_signature | legacy-2026-03-3 | 6yjNqPzT | 2.82% | -0.02% | — | —% | TRAILING_STOP |
| 17cae629 | tx_signature | legacy-2026-03-3 | 6yjNqPzT | 3.66% | -0.04% | — | —% | TRAILING_STOP |
| 5b2acd76 | tx_signature | legacy-2026-03-3 | 6yjNqPzT | -1.84% | 0.01% | — | —% | TRAILING_STOP |
| 77ff29fe | tx_signature | legacy-2026-03-3 | 6yjNqPzT | -0.12% | -0.48% | 0.24 | —% | TRAILING_STOP |
| cefb5165 | tx_signature | legacy-2026-03-3 | 6yjNqPzT | -2.08% | 0.01% | — | —% | TRAILING_STOP |
| cb7c41c8 | tx_signature | legacy-2026-03-3 | 6yjNqPzT | -6.57% | -0.26% | 25.10 | —% | TRAILING_STOP |
| 9e9f6b47 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 1608.40% | 0.09% | 18303.74 | —% | EXHAUSTION |
| 80b459de | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 527.98% | -0.00% | — | —% | TAKE_PROFIT_1 |
| 293ea4ab | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -1.00% | 0.01% | — | —% | TAKE_PROFIT_1 |
| 91d65186 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -3.11% | 0.01% | — | —% | STOP_LOSS |
| 77d5aef8 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 25.59% | -0.01% | — | —% | STOP_LOSS |
| 7ebb07c4 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 1430.10% | 0.00% | — | —% | TAKE_PROFIT_2 |
| bf7eb309 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -1.32% | -0.01% | — | —% | TAKE_PROFIT_1 |
| 93189f27 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 155.75% | 0.00% | — | —% | STOP_LOSS |
| ef9db42b | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 631.47% | -0.01% | — | —% | TAKE_PROFIT_2 |
| 5dc7a4c6 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 0.40% | -0.00% | — | —% | STOP_LOSS |
| 884d47b4 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.02% | -0.00% | — | —% | STOP_LOSS |
| c7f99f49 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 1.03% | -0.01% | — | —% | STOP_LOSS |
| af2d41d7 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -1.23% | -0.01% | — | —% | TAKE_PROFIT_1 |
| f6608d3d | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 566.90% | -0.01% | — | —% | STOP_LOSS |
| 2a67863c | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 572.41% | -0.01% | — | —% | EXHAUSTION |
| d9be2761 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.86% | 0.00% | — | —% | TAKE_PROFIT_1 |
| 227e4654 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 75.19% | -0.00% | — | —% | TAKE_PROFIT_1 |
| 86b7e54d | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 61.68% | 0.00% | — | —% | EXHAUSTION |
| 4ab58e84 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 614.35% | -0.00% | — | —% | EXHAUSTION |
| 2b9c703f | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.53% | -0.00% | — | —% | TAKE_PROFIT_1 |
| a86a6edd | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 75.84% | -0.01% | — | —% | STOP_LOSS |
| ce860db2 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 589.27% | -0.00% | — | —% | TRAILING_STOP |
| 3dadb56e | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 0.42% | -0.01% | — | —% | STOP_LOSS |
| a97f36e3 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.10% | 0.01% | — | —% | TAKE_PROFIT_1 |
| 34febd64 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 36.23% | -0.00% | — | —% | STOP_LOSS |
| 62e8d905 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 562.75% | 0.01% | — | —% | TRAILING_STOP |
| 249fd561 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 561.25% | -0.00% | — | —% | STOP_LOSS |
| 828cd9ad | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.49% | -0.00% | — | —% | TAKE_PROFIT_1 |
| cb929b39 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 271.54% | -0.00% | — | —% | TRAILING_STOP |
| 8d3d0c56 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 582.18% | -0.01% | — | —% | STOP_LOSS |
| 49c12a33 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.17% | 0.00% | — | —% | TAKE_PROFIT_1 |
| 6df998ac | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 36.20% | -0.00% | — | —% | STOP_LOSS |
| 855ff01c | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 579.71% | 0.00% | — | —% | EXHAUSTION |
| 9370e5f7 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.07% | -0.01% | — | —% | TAKE_PROFIT_1 |
| 186a4e55 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 76.07% | 0.00% | — | —% | TAKE_PROFIT_1 |
| 39a225a5 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 61.12% | -0.01% | — | —% | TRAILING_STOP |
| 73cb0f4d | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 0.07% | -0.00% | — | —% | STOP_LOSS |
| 40e82445 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -22.47% | 0.00% | — | —% | EXHAUSTION |
| 24782ac6 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 593.52% | -0.00% | — | —% | TAKE_PROFIT_1 |
| f6458ea5 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 1.12% | -0.01% | — | —% | STOP_LOSS |
| 44e633a1 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.10% | 0.00% | — | —% | TAKE_PROFIT_1 |
| c8a92a2a | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 74.39% | 0.00% | — | —% | TAKE_PROFIT_1 |
| acbe24d9 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 59.40% | 0.00% | — | —% | EXHAUSTION |
| 4cef2a7a | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 587.62% | 0.00% | — | —% | TRAILING_STOP |
| dbc9c25b | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 586.75% | 0.00% | — | —% | TAKE_PROFIT_1 |
| f6a74a17 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.88% | 0.00% | — | —% | TAKE_PROFIT_1 |
| 6708994a | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 77.00% | -0.00% | — | —% | STOP_LOSS |
| 2c909bb2 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 568.68% | 0.00% | — | —% | EXHAUSTION |
| 8f8b7766 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.24% | -0.01% | — | —% | STOP_LOSS |
| e7ef5577 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.08% | -0.01% | — | —% | STOP_LOSS |
| 0460a930 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 0.63% | -0.01% | — | —% | STOP_LOSS |
| a980351b | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.22% | -0.00% | — | —% | STOP_LOSS |
| c63c3d0f | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 0.55% | -0.01% | — | —% | STOP_LOSS |
| 843581db | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.24% | 0.00% | — | —% | TAKE_PROFIT_1 |
| 3e4cd960 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -1.53% | 0.00% | — | —% | TRAILING_STOP |
| 86352eb6 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.15% | -0.00% | — | —% | STOP_LOSS |
| b312f18d | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.27% | -0.00% | — | —% | TAKE_PROFIT_1 |
| 22e075fe | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 0.07% | -0.00% | — | —% | TRAILING_STOP |
| 3f1caed3 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.34% | -0.01% | — | —% | STOP_LOSS |
| dea0b6bb | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.14% | -0.01% | — | —% | TAKE_PROFIT_1 |
| fa73ef6d | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 75.46% | -0.01% | — | —% | STOP_LOSS |
| 57199f60 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.45% | -0.01% | — | —% | STOP_LOSS |
| d55b66b4 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 610.47% | -0.01% | — | —% | EXHAUSTION |
| 60e62457 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 616.83% | 0.00% | — | —% | TAKE_PROFIT_1 |
| 187e7dec | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -4.88% | 0.00% | — | —% | TAKE_PROFIT_2 |
| 22c7a1b9 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 687.27% | 0.01% | — | —% | TAKE_PROFIT_1 |
| 3dd43186 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 127.77% | 0.01% | — | —% | EXHAUSTION |
| 0b78127d | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 710.39% | 0.00% | — | —% | TAKE_PROFIT_1 |
| 08ef7863 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.32% | -0.02% | — | —% | STOP_LOSS |
| 18443222 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.59% | 0.00% | — | —% | TAKE_PROFIT_1 |
| ff0c754d | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 73.97% | 0.00% | — | —% | TAKE_PROFIT_1 |
| e830919c | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 59.45% | 0.00% | — | —% | EXHAUSTION |
| 9a43f3a1 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -2.71% | 0.01% | — | —% | TAKE_PROFIT_1 |
| 2c295199 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -46.67% | 0.00% | — | —% | EXHAUSTION |
| 61703fac | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.45% | -0.00% | — | —% | TAKE_PROFIT_1 |
| cf3496e8 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 0.25% | 0.01% | — | —% | EXHAUSTION |
| 8d20b7c7 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 741.58% | 0.00% | — | —% | TAKE_PROFIT_1 |
| 8cb906af | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 98.98% | -0.00% | — | —% | EXHAUSTION |
| d7b12754 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.42% | -0.00% | — | —% | TAKE_PROFIT_1 |
| d0ef999d | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -50.24% | 0.00% | — | —% | EXHAUSTION |
| 206ea6cd | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 186.58% | -0.00% | — | —% | TRAILING_STOP |
| 610d8bca | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 699.10% | -0.01% | — | —% | STOP_LOSS |
| 4d6376cf | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 690.27% | -0.02% | — | —% | STOP_LOSS |
| c870fa17 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.06% | -0.01% | — | —% | STOP_LOSS |
| f68f0d0c | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 0.98% | -0.02% | — | —% | STOP_LOSS |
| 30ed4aa8 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.72% | 0.01% | — | —% | TAKE_PROFIT_1 |
| 64b98621 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -2.17% | 0.01% | — | —% | TRAILING_STOP |
| e83e40af | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.48% | -0.01% | — | —% | TAKE_PROFIT_1 |
| b12c1c9d | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 0.87% | -0.01% | — | —% | EXHAUSTION |
| 96a0d14b | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.45% | -0.01% | — | —% | STOP_LOSS |
| bc8ee6bf | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 606.92% | -0.00% | — | —% | TAKE_PROFIT_1 |
| a55dd914 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 273.32% | -0.00% | — | —% | EXHAUSTION |
| 4c4dbf9f | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.14% | -0.00% | — | —% | TAKE_PROFIT_1 |
| 1aae64ab | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -26.24% | -0.00% | — | —% | STOP_LOSS |
| 7b461468 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 586.66% | -0.00% | — | —% | EXHAUSTION |
| e0e8733b | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 0.12% | -0.01% | — | —% | STOP_LOSS |
| 4252915e | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.07% | 0.01% | — | —% | STOP_LOSS |
| 70272b90 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 25.25% | -0.01% | — | —% | STOP_LOSS |
| 4d1f4c3e | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | 599.41% | 0.00% | — | —% | EXHAUSTION |
| 29f4bafb | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.48% | -0.00% | — | —% | STOP_LOSS |
| dbfa330f | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.10% | -0.01% | — | —% | STOP_LOSS |
| 17fdbe53 | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -0.60% | -0.00% | — | —% | TAKE_PROFIT_1 |
| fb78d24b | tx_signature | 2026-04-03T15-45 | Dfh5DzRg | -1.80% | -0.00% | — | —% | EXHAUSTION |
| 581a8711 | tx_signature | 2026-04-06T03-20 | Dfh5DzRg | -0.49% | 0.00% | — | —% | TAKE_PROFIT_2 |
| 418b9511 | tx_signature | 2026-04-06T03-20 | 98mb39tP | -1.74% | -0.01% | — | —% | TAKE_PROFIT_2 |
| 275d27f7 | tx_signature | 2026-04-06T03-20 | 98mb39tP | -0.61% | 0.01% | — | —% | TAKE_PROFIT_2 |
| cc45aa5a | tx_signature | 2026-04-06T03-20 | Dfh5DzRg | -0.45% | -0.01% | — | —% | TAKE_PROFIT_2 |
| 1ec7e3dc | tx_signature | 2026-04-06T14-17 | CYTUg8qL | -0.15% | 0.01% | — | -0.93% | TAKE_PROFIT_1 |
| 1953c360 | tx_signature | 2026-04-06T14-17 | CYTUg8qL | -3.64% | -0.01% | — | -95.48% | TAKE_PROFIT_2 |
| 755f4f16 | tx_signature | 2026-04-06T14-17 | Dfh5DzRg | -0.42% | -0.01% | — | -84.51% | TAKE_PROFIT_2 |
| 71a550fd | tx_signature | 2026-04-06T14-17 | Dfh5DzRg | -0.35% | -0.01% | — | -84.21% | TAKE_PROFIT_2 |
| ab340c9e | tx_signature | 2026-04-06T14-17 | 4ytpZgVo | -5.08% | 0.00% | — | -100.00% | TAKE_PROFIT_2 |
| 14b020a9 | tx_signature | 2026-04-06T14-17 | 4ytpZgVo | -0.51% | 0.01% | — | -100.00% | TAKE_PROFIT_2 |
| 480c3f39 | tx_signature | 2026-04-07T03-53 | Dfh5DzRg | -0.22% | 0.00% | — | -0.45% | TAKE_PROFIT_1 |

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