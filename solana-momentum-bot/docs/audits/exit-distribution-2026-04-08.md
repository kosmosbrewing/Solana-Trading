# Exit Distribution Audit

Generated: 2026-04-07T23:13:21.787Z
Source: data/vps-trades-latest.jsonl
Filter: status=CLOSED AND exit_anomaly_reason IS NULL AND strategy=bootstrap_10s
Input rows: 140, dropped (anomaly): 0, parent groups: 18

## Sample Size Verdict

⚠ **Sample insufficient**: 18 < 20 (Phase X1 acceptance gate). Phase X3 가설 분기 진입 금지.

## Exit Reason Distribution

| Exit Reason | n | % | avg R | p25 R | p50 R | p75 R | avg PnL (SOL) | finite R |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| TAKE_PROFIT_2 | 10 | 55.6% | -2.51 | -2.92 | -0.94 | -0.50 | -0.001492 | 10 |
| STOP_LOSS | 6 | 33.3% | -1.17 | -1.58 | -0.86 | -0.49 | -0.000564 | 6 |
| TAKE_PROFIT_1 | 1 | 5.6% | -0.24 | -0.24 | -0.24 | -0.24 | -0.000045 | 1 |
| TIME_STOP | 1 | 5.6% | 0.07 | 0.07 | 0.07 | 0.07 | +0.000542 | 1 |

## Hit Rate Headlines (Intent — exit_reason 기반)

> 주의: 아래는 *trigger intent* (monitor loop이 어떤 조건을 발동시켰는가) 기반이다.
> 실제 Jupiter fill은 swap latency 동안 price가 변해 intent와 다른 level에서 체결될 수 있다.
> Phase X3 가설 분기 판단은 아래 "Intent vs Actual Outcome" 섹션의 actual bucket을 사용한다.

- **TP1 hit rate (intent)**: 4/18 = 22.2%
- **TP2 hit rate (intent)**: 10/18 = 55.6%
- **SL final rate (intent)**: 6/18 = 33.3%
- **TRAILING final rate (intent)**: 0/18 = 0.0%
- **TIME_STOP final rate (intent)**: 1/18 = 5.6%

## Actual Outcome Distribution (exit_price 기반)

| Actual Bucket | n | % | 의미 |
|---|---:|---:|---|
| BELOW_TP1 | 1 | 5.6% | entry ≤ exit_price < TP1 — 본전~TP1 사이 작은 win |
| BELOW_ENTRY | 8 | 44.4% | SL < exit_price < entry — 본전 이하 작은 loss |
| SL_OR_WORSE | 9 | 50.0% | exit_price ≤ SL — full SL 또는 penetration |

## Intent vs Actual Cross-Tabulation

Rows = intent (exit_reason), columns = actual price-level bucket. 대각선 외 셀이 클수록 intent ≠ actual gap이 크다.

| intent \\ actual | BELOW_TP1 | BELOW_ENTRY | SL_OR_WORSE | total |
|---|---:|---:|---:|---:|
| **STOP_LOSS** | · | 2 | 4 | 6 |
| **TAKE_PROFIT_1** | · | 1 | · | 1 |
| **TAKE_PROFIT_2** | · | 5 | 5 | 10 |
| **TIME_STOP** | 1 | · | · | 1 |

> **TP2 intent → actual TP2 match rate**: 0/10 = 0.0%
> ⚠ **measurement gap detected**: TP2 trigger fired 10건 중 실제로 TP2 level에서 fill된 건은 0건뿐. 나머지는 swap latency 동안 price가 reverse되어 lower level에서 체결됨. exit_reason 기반 hit rate는 over-counting이다.

> **Actual TP2 reach rate (price-based)**: 0/18 = 0.0% — Phase X3 Scenario A 판단의 정확한 입력값

## Overall R-Multiple Distribution

- finite R count: 18 / 18
- avg R: -1.79
- median R (p50): -0.70
- p25 R: -1.72
- p75 R: -0.35
- max R: 0.07
- min R: -12.57
- win rate (entry-level): 1/18 = 5.6%
- net realized PnL: -0.017809 SOL

## Phase X3 Scenario Hints (actual bucket 기반)

- 표본 부족 (18 < 20). Phase X1 누적 대기.

## Entry Group Detail (first 30)

| symbol | n legs | intent reason | actual bucket | total pnl SOL | realized R |
|---|---:|---|---|---:|---:|
| pippin | 1 | TAKE_PROFIT_2 | SL_OR_WORSE ⚠ | -0.000668 | -1.04 |
| LLM | 1 | TAKE_PROFIT_2 | SL_OR_WORSE ⚠ | -0.002861 | -4.28 |
| LLM | 1 | TAKE_PROFIT_2 | BELOW_ENTRY ⚠ | -0.000056 | -0.01 |
| pippin | 1 | TAKE_PROFIT_2 | BELOW_ENTRY ⚠ | -0.000361 | -0.47 |
| BURNIE | 1 | TAKE_PROFIT_2 | SL_OR_WORSE ⚠ | -0.002495 | -3.32 |
| stonks | 1 | TAKE_PROFIT_1 | BELOW_ENTRY | -0.000045 | -0.24 |
| stonks | 1 | TAKE_PROFIT_2 | SL_OR_WORSE ⚠ | -0.004326 | -12.57 |
| pippin | 1 | TAKE_PROFIT_2 | BELOW_ENTRY ⚠ | -0.000547 | -0.83 |
| pippin | 1 | TAKE_PROFIT_2 | BELOW_ENTRY ⚠ | -0.000549 | -0.58 |
| BTW | 1 | TAKE_PROFIT_2 | BELOW_ENTRY ⚠ | -0.002261 | -0.27 |
| BTW | 1 | TAKE_PROFIT_2 | SL_OR_WORSE ⚠ | -0.000797 | -1.73 |
| pippin | 2 | STOP_LOSS | SL_OR_WORSE | -0.000358 | -0.49 |
| pippin | 2 | STOP_LOSS | BELOW_ENTRY | -0.000151 | -0.32 |
| pippin | 1 | TIME_STOP | BELOW_TP1 | +0.000542 | 0.07 |
| pippin | 1 | STOP_LOSS | SL_OR_WORSE | -0.000987 | -1.70 |
| pippin | 2 | STOP_LOSS | SL_OR_WORSE | -0.001227 | -1.21 |
| swarms | 1 | STOP_LOSS | SL_OR_WORSE | -0.000200 | -2.78 |
| swarms | 1 | STOP_LOSS | BELOW_ENTRY | -0.000463 | -0.51 |

⚠ = intent ≠ actual mismatch (TP2 intent → non-TP2 actual, 또는 TP1 intent → SL actual).

## Caveats

- 1-level parent grouping (`parent_trade_id ?? id`). 깊은 chain (T1→T2→T3) 처리 한계는 trade-report.ts와 동일. root parent resolver 도입 시 본 스크립트도 함께 갱신 필요.
- `stop_loss == 0` 인 legacy row는 R 계산에서 NaN 처리 + actualBucket=UNKNOWN (legacy v3 이전 데이터).
- `exit_anomaly_reason IS NULL` 필터로 Phase E fake-fill 마커가 있는 row는 제외. `--include-dirty` 로 해제 가능.
- Phase X1 acceptance gate (≥ 20 clean trades) 미달 시 본 결과로 가설 분기 금지.
- **measurement gap**: `exit_reason`은 monitor loop가 발동시킨 *trigger intent*고, `exit_price`는 Jupiter swap의 *actual fill*이다. 메모코인 빠른 변동 + swap latency 때문에 두 값이 자주 분리된다. Phase X3 판단은 actual bucket을 사용해야 한다 (intent 기반 hit rate는 over-counting).