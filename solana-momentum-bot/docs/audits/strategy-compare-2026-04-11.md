# Strategy Backtest Comparison (Real Operational Data)

> Generated: 2026-04-11T01:33:38.933Z
> Sessions: 12
> Signals simulated: 56

## Option β (ATR floor)

| metric | value |
|---|---|
| simulated trades | 56 |
| wins / losses | 25W / 31L |
| **win rate** | **44.6%** |
| avg PnL % | -3.514% |
| median PnL % | -0.235% |
| avg win % | +6.826% |
| avg loss % | -11.853% |
| **win/loss ratio** | **0.58x** |
| **expectancy** | **-3.514% per trade** |
| hold time p25 | 4.0m |
| hold time p50 | 11.9m |
| hold time p75 | 20.0m |

| exit reason | count | % |
|---|---:|---:|
| STOP_LOSS | 21 | 37.5% |
| TIME_STOP | 16 | 28.6% |
| TAKE_PROFIT_1 | 9 | 16.1% |
| TAKE_PROFIT_2 | 6 | 10.7% |
| DATA_END | 4 | 7.1% |

## Cupsey Lane

| metric | value |
|---|---|
| simulated trades | 56 |
| wins / losses | 24W / 32L |
| **win rate** | **42.9%** |
| avg PnL % | -3.130% |
| median PnL % | -0.063% |
| avg win % | +0.528% |
| avg loss % | -5.875% |
| **win/loss ratio** | **0.09x** |
| **expectancy** | **-3.130% per trade** |
| hold time p25 | 50s |
| hold time p50 | 1.2m |
| hold time p75 | 2.5m |

| exit reason | count | % |
|---|---:|---:|
| REJECT_TIMEOUT | 30 | 53.6% |
| WINNER_TRAILING | 15 | 26.8% |
| WINNER_TIME_STOP | 7 | 12.5% |
| REJECT_HARD_CUT | 4 | 7.1% |

## Head-to-Head Comparison

| metric | Option β | Cupsey Lane | winner |
|---|---|---|---|
| WR | 44.6% | 42.9% | Option β |
| avg PnL % | -3.514% | -3.130% | Cupsey |
| hold p50 | 11.9m | 1.2m | Cupsey (빠름) |
| per-signal winner | 24 signals | 30 signals | Cupsey (2 ties) |
