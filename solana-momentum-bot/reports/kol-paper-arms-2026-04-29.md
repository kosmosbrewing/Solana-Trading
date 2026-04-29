# KOL Paper Arm Report - 2026-04-29

> Paper-only arm comparison. This does not unlock Kelly, sizing, or live throttle.

- Total paper closes: 472
- Arms: 4

| Arm | Trades | Shadow | Net SOL | Win Rate | Avg Net | T1 | T2 | T3 | Avg MFE | P90 MFE | Avg MAE | Median Hold |
|-----|--------|--------|---------|----------|---------|----|----|----|---------|---------|---------|-------------|
| kol_hunter_smart_v3/pullback/HIGH | 256 | 0 | 0.081442 | 26.56% | 4.22% | 46 | 1 | 1 | 26.00% | 64.09% | -9.62% | 33s |
| kol_hunter_swing_v2/swing_v2/HIGH | 90 | 90 | 0.050850 | 30.00% | 6.05% | 12 | 0 | 0 | 23.84% | 64.14% | -7.79% | 42s |
| kol_hunter_smart_v3/velocity/MEDIUM_HIGH | 58 | 0 | 0.047970 | 32.76% | 7.86% | 8 | 0 | 0 | 23.45% | 60.42% | -6.38% | 40s |
| v1.0.0-paper-2026-04-25 | 68 | 0 | -0.007807 | 30.88% | -0.65% | 7 | 0 | 0 | 16.40% | 44.33% | -8.95% | 54s |

## Exit Reasons

- kol_hunter_smart_v3/pullback/HIGH: probe_hard_cut=105, insider_exit_full=88, probe_flat_cut=30, winner_trailing_t1=17, hold_phase_sentinel_degraded_exit=11, probe_reject_timeout=5
- kol_hunter_swing_v2/swing_v2/HIGH: insider_exit_full=39, probe_hard_cut=32, probe_flat_cut=16, winner_trailing_t1=2, hold_phase_sentinel_degraded_exit=1
- kol_hunter_smart_v3/velocity/MEDIUM_HIGH: insider_exit_full=25, probe_hard_cut=17, probe_flat_cut=10, winner_trailing_t1=3, probe_reject_timeout=2, hold_phase_sentinel_degraded_exit=1
- v1.0.0-paper-2026-04-25: probe_hard_cut=34, probe_reject_timeout=15, probe_flat_cut=12, winner_trailing_t1=7
