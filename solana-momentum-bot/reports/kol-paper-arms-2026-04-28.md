# KOL Paper Arm Report - 2026-04-28

> Paper-only arm comparison. This does not unlock Kelly, sizing, or live throttle.

- Total paper closes: 457
- Arms: 4

| Arm | Trades | Shadow | Net SOL | Win Rate | Avg Net | T1 | T2 | T3 | Avg MFE | P90 MFE | Avg MAE | Median Hold |
|-----|--------|--------|---------|----------|---------|----|----|----|---------|---------|---------|-------------|
| kol_hunter_smart_v3/pullback/HIGH | 248 | 0 | 0.101787 | 26.61% | 4.75% | 45 | 1 | 1 | 26.34% | 64.09% | -9.42% | 34s |
| kol_hunter_swing_v2/swing_v2/HIGH | 85 | 85 | 0.064416 | 29.41% | 7.17% | 12 | 0 | 0 | 24.16% | 64.14% | -7.32% | 47s |
| kol_hunter_smart_v3/velocity/MEDIUM_HIGH | 56 | 0 | 0.048183 | 32.14% | 8.14% | 8 | 0 | 0 | 23.65% | 60.42% | -6.42% | 40s |
| v1.0.0-paper-2026-04-25 | 68 | 0 | -0.007807 | 30.88% | -0.65% | 7 | 0 | 0 | 16.40% | 44.33% | -8.95% | 54s |

## Exit Reasons

- kol_hunter_smart_v3/pullback/HIGH: probe_hard_cut=100, insider_exit_full=86, probe_flat_cut=30, winner_trailing_t1=16, hold_phase_sentinel_degraded_exit=11, probe_reject_timeout=5
- kol_hunter_swing_v2/swing_v2/HIGH: insider_exit_full=39, probe_hard_cut=30, probe_flat_cut=13, winner_trailing_t1=2, hold_phase_sentinel_degraded_exit=1
- kol_hunter_smart_v3/velocity/MEDIUM_HIGH: insider_exit_full=25, probe_hard_cut=16, probe_flat_cut=9, winner_trailing_t1=3, probe_reject_timeout=2, hold_phase_sentinel_degraded_exit=1
- v1.0.0-paper-2026-04-25: probe_hard_cut=34, probe_reject_timeout=15, probe_flat_cut=12, winner_trailing_t1=7
