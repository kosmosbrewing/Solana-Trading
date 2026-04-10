# Post-Entry Trajectory Analysis

> Generated: 2026-04-10T08:33:44.318Z
> Sessions: 11
> Signals analyzed: 497
> Quick reject threshold: +0.3% MFE at 30s

## Sample Counts

- Total signals with trajectory: 497
- Executed (live/paper): 53
- With final PnL outcome: 0

## MFE / MAE Distribution (executed signals, n=53)

| horizon | MFE p25 | MFE p50 | MFE p75 | MAE p25 | MAE p50 | MAE p75 | close p50 |
|---|---|---|---|---|---|---|---|
| 10s | +0.00% | +0.02% | +0.07% | -0.49% | +0.00% | +0.00% | +0.01% |
| 30s | +0.00% | +0.03% | +0.14% | -0.49% | -0.01% | +0.00% | +0.01% |
| 60s | +0.01% | +0.04% | +0.29% | -0.50% | -0.40% | +0.00% | +0.02% |
| 120s | +0.02% | +0.08% | +0.36% | -0.51% | -0.46% | -0.00% | +0.01% |
| 300s | +0.03% | +0.13% | +0.55% | -0.73% | -0.50% | -0.30% | -0.27% |

## Quick Reject Analysis (30s horizon, +0.3% threshold)

No signals with final PnL outcome — cannot compute quick reject impact.

## Per-Signal Detail (last 20 executed)

| # | token | entry time | MFE@30s | MAE@30s | MFE@60s | final PnL | exit reason | QR? |
|---|---|---|---|---|---|---|---|---|
| 1 | Rise | 21:55:40 | +0.01% | -0.52% | +0.01% | — | — | 🔴 REJECT |
| 2 | 74SBV4zDXxTRgv1pEMoECskKBkZHc2yGPnc7GYVepump | 23:15:00 | +0.00% | +0.00% | +0.02% | — | — | 🔴 REJECT |
| 3 | VDOR | 00:07:50 | +0.00% | +0.00% | +0.00% | — | — | 🔴 REJECT |
| 4 | pippin | 00:46:10 | +0.50% | -0.14% | +0.50% | — | — | 🟢 KEEP |
| 5 | Fartcoin | 02:32:50 | +0.36% | +0.00% | +0.36% | — | — | 🟢 KEEP |
| 6 | VDOR | 03:40:20 | +0.04% | +0.00% | +0.04% | — | — | 🔴 REJECT |
| 7 | VDOR | 04:00:40 | +0.03% | +0.00% | +0.03% | — | — | 🔴 REJECT |
| 8 | 49 | 04:08:10 | +0.00% | +0.00% | +0.00% | — | — | 🔴 REJECT |
| 9 | VDOR | 04:09:50 | +0.00% | +0.00% | +0.00% | — | — | 🔴 REJECT |
| 10 | pippin | 04:56:40 | +0.02% | +0.00% | +0.03% | — | — | 🔴 REJECT |
| 11 | 49 | 05:09:30 | +0.00% | +0.00% | +0.00% | — | — | 🔴 REJECT |
| 12 | pippin | 08:47:30 | +0.03% | -0.49% | +0.03% | — | — | 🔴 REJECT |
| 13 | 74SBV4zDXxTRgv1pEMoECskKBkZHc2yGPnc7GYVepump | 10:20:20 | +0.16% | +0.00% | +0.16% | — | — | 🔴 REJECT |
| 14 | Fartcoin | 12:47:00 | +0.02% | +0.00% | +0.02% | — | — | 🔴 REJECT |
| 15 | GRIFFAIN | 15:42:30 | +0.61% | -0.00% | +0.61% | — | — | 🟢 KEEP |
| 16 | Fartcoin | 17:21:10 | +0.14% | +0.00% | +0.47% | — | — | 🔴 REJECT |
| 17 | GRIFFAIN | 19:46:40 | +0.12% | -0.44% | +0.12% | — | — | 🔴 REJECT |
| 18 | 9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump | 21:55:10 | +0.06% | +0.00% | +0.07% | — | — | 🔴 REJECT |
| 19 | 9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump | 23:20:00 | +0.01% | +0.00% | +0.01% | — | — | 🔴 REJECT |
| 20 | BURNIE | 06:20:40 | +0.00% | -0.25% | +1.07% | — | — | 🔴 REJECT |

## Strategy Calibration Hints

- 30s 시점 MFE ≥ +0.3% 비율: 7/53 = 13.2%
- 🔴 대부분 signal 이 30s 내 +0.3% 미도달 → **quick reject 가 대부분 trade 를 자를 것**. threshold 를 낮추거나 horizon 을 늘려야
