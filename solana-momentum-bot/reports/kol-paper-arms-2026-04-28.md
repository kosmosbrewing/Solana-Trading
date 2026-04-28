# KOL Paper Arm Report - 2026-04-28

> Paper-only arm comparison. This does not unlock Kelly, sizing, or live throttle.

- Total paper closes: 441
- Arms: 4

| Arm | Trades | Shadow | Net SOL | Win Rate | Avg Net | T1 | T2 | T3 | Avg MFE | P90 MFE | Avg MAE | Median Hold |
|-----|--------|--------|---------|----------|---------|----|----|----|---------|---------|---------|-------------|
| kol_hunter_smart_v3/pullback/HIGH | 244 | 0 | 0.109858 | 26.64% | 4.98% | 45 | 1 | 1 | 26.70% | 64.09% | -9.36% | 33s |
| kol_hunter_swing_v2/swing_v2/HIGH | 75 | 75 | 0.044742 | 29.33% | 6.75% | 9 | 0 | 0 | 23.37% | 56.89% | -7.22% | 44s |
| kol_hunter_smart_v3/velocity/MEDIUM_HIGH | 54 | 0 | 0.037400 | 31.48% | 7.43% | 7 | 0 | 0 | 22.73% | 56.89% | -6.48% | 40s |
| v1.0.0-paper-2026-04-25 | 68 | 0 | -0.007807 | 30.88% | -0.65% | 7 | 0 | 0 | 16.40% | 44.33% | -8.95% | 54s |

## Exit Reasons

- kol_hunter_smart_v3/pullback/HIGH: probe_hard_cut=98, insider_exit_full=85, probe_flat_cut=30, winner_trailing_t1=16, hold_phase_sentinel_degraded_exit=11, probe_reject_timeout=4
- kol_hunter_swing_v2/swing_v2/HIGH: insider_exit_full=33, probe_hard_cut=28, probe_flat_cut=11, winner_trailing_t1=2, hold_phase_sentinel_degraded_exit=1
- kol_hunter_smart_v3/velocity/MEDIUM_HIGH: insider_exit_full=24, probe_hard_cut=16, probe_flat_cut=8, winner_trailing_t1=3, probe_reject_timeout=2, hold_phase_sentinel_degraded_exit=1
- v1.0.0-paper-2026-04-25: probe_hard_cut=34, probe_reject_timeout=15, probe_flat_cut=12, winner_trailing_t1=7
