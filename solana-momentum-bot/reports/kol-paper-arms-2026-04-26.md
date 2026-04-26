# KOL Paper Arm Report - 2026-04-26

> Paper-only arm comparison. This does not unlock Kelly, sizing, or live throttle.

- Total paper closes: 75
- Arms: 2

| Arm | Trades | Shadow | Net SOL | Win Rate | Avg Net | T1 | T2 | T3 | Avg MFE | P90 MFE | Avg MAE | Median Hold |
|-----|--------|--------|---------|----------|---------|----|----|----|---------|---------|---------|-------------|
| kol_hunter_smart_v3/pullback/HIGH | 7 | 0 | -0.002996 | 28.57% | -3.78% | 1 | 0 | 0 | 16.13% | 30.65% | -8.27% | 18s |
| v1.0.0-paper-2026-04-25 | 68 | 0 | -0.007807 | 30.88% | -0.65% | 7 | 0 | 0 | 16.40% | 44.33% | -8.95% | 54s |

## Exit Reasons

- kol_hunter_smart_v3/pullback/HIGH: probe_hard_cut=4, probe_flat_cut=2, winner_trailing_t1=1
- v1.0.0-paper-2026-04-25: probe_hard_cut=34, probe_reject_timeout=15, probe_flat_cut=12, winner_trailing_t1=7
