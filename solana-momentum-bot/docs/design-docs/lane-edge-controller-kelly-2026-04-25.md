# Lane Edge Controller - Conservative Kelly / Payoff Control

> Date: 2026-04-25
> Status: Proposed control-plane design
> Authority: `mission-pivot-2026-04-18.md`, `mission-refinement-2026-04-21.md`, `MISSION_CONTROL.md`

## 1. Decision

Kelly and reward/risk are not immediate sizing expansion tools.

For this mission, Kelly is a **lane/cohort control signal** used to:

- keep, throttle, or halt a lane,
- quarantine losing cohorts,
- limit max concurrency,
- decide paper-only versus live,
- only later decide whether ticket size can increase.

Kelly is not alpha. It only allocates attempts toward cohorts that already show wallet-truth edge.

## 2. Why

Recent 2026-04-25 operating data exposed three control gaps:

- `pure_ws_breakout` DB PnL can diverge from executed-ledger / wallet cash flow because of duplicate buy and open-row accounting.
- `pure_ws_breakout` and `migration_reclaim` are not fully covered by the legacy `EdgeTracker` strategy list.
- `kol_hunter` is mission-critical but is not a `StrategyName`; forcing it into legacy strategy stats would blur lane identity.

Therefore, Kelly built on DB PnL or legacy strategy-level stats can create false confidence and increase exposure to a broken cohort.

## 3. Non-Goals

- Do not increase ticket size before wallet-truth accounting is clean.
- Do not compute live Kelly from paper-only PnL.
- Do not use nominal TP/SL RR as the final reward/risk estimate for pure DEX lanes.
- Do not collapse all lanes into one portfolio Kelly number.

## 4. Inputs

The controller must consume append-only, wallet-truth-oriented records:

- executed buys ledger,
- executed sells ledger,
- wallet delta comparator,
- DB trade rows only after reconciliation,
- lane/arm metadata.

Required normalized outcome fields: `laneName`, `armName`, `positionId`, `tokenMint`, `pairAddress`, `dex`, `discoverySource`, `entryTime`, `exitTime`, `exitReason`, `paperOnly`, `spentSol`, `receivedSol`, `feesSol`, `realizedPnlSol`, `maxMfePct`, `maxMaePct`.

## 5. Cohorts

The useful edge is likely cohort-specific, not portfolio-wide.

Default cohort dimensions: `laneName`, `armName`, `dex`, `discoverySource`, `tokenAgeBucket`, `mcapBucket`, `kolCluster`, `independentKolCount`, `signalQualityBucket`, `tokenSessionId`.

Example cohorts: `kol_hunter / lexapro / pumpswap / age<30m`, `pure_ws_breakout / ws_burst_v2 / CATCOIN-session`, `migration_reclaim / launchlab / raydium_cpmm`.

## 6. Metrics

All live metrics must be wallet-realized unless explicitly labeled as paper.

Per lane and cohort:

```text
n
win_rate
avg_win_sol
avg_loss_sol
reward_risk = avg_win_sol / abs(avg_loss_sol)
expectancy_sol = win_rate * avg_win_sol - (1 - win_rate) * abs(avg_loss_sol)
cash_flow_sol = sum(receivedSol) - sum(spentSol) - sum(feesSol)
log_growth = log(wallet_after / wallet_before)
max_loss_streak
runner_contribution = pnl_from_T1_T2_T3 / total_pnl
```

Paper-only metrics must use a `paper_` prefix and cannot unlock live sizing.

## 7. Conservative Kelly

Raw Kelly:

```text
raw_kelly = win_rate - (1 - win_rate) / reward_risk
```

Production Kelly must use conservative estimates:

```text
p = lower_confidence_bound(win_rate)
rr = lower_confidence_bound_or_bootstrap_p10(reward_risk)
conservative_kelly = max(0, p - (1 - p) / rr)
applied_kelly = min(conservative_kelly * scale, cap)
```

Recommended defaults:

- `scale = 0.125` for canary,
- `scale = 0.25` only after confirmed wallet-truth edge,
- `cap = 0.01` while wallet < 3 SOL,
- `cap = 0.03` only after 200+ reconciled live trades.

## 8. Control Outputs

The controller emits actions, not just reports: `entry_mode`, `ticket_cap_sol`, `max_concurrent`, `cooldown_sec`, `quarantine_until`, `reason`.

Suggested policy:

| Condition | Action |
|---|---|
| wallet mismatch active | `entry_mode=halted`, Kelly forced to `0` |
| `n < 50` | display only, fixed ticket |
| `50 <= n < 100` and expectancy <= 0 | reduce max concurrent or paper-only |
| `n >= 100` and conservative Kelly <= 0 | throttle or quarantine cohort |
| `n >= 100` and conservative Kelly > 0 | keep live attempts, fixed ticket |
| `n >= 200` and wallet log growth > 0 | consider small ticket cap increase |

## 9. Lane Rules

### Pure WS

Kelly controls token-session quarantine, per-pair cooldown, max concurrency, and whether V2 pass signals are allowed to execute.

Pure WS must not increase ticket size until duplicate/open-row accounting is fixed, quote-based T1 promotion is implemented, and wallet cash flow agrees with DB within drift tolerance.

### KOL Hunter

KOL paper stats may rank KOLs but cannot unlock live sizing.

KOL live Kelly requires a real `enterLivePosition()` path, executed buy/sell ledger, size-aware sell quote probe, wallet-truth PnL, and KOL cohort identity.

### Migration Reclaim

Migration lane can use cohort Kelly only after event type is explicit:

- LaunchLab to Raydium CPMM,
- Pump.fun to PumpSwap canonical,
- Meteora DBC to DAMM/DLMM.

## 10. Implementation Plan

### P0 - Accounting Eligibility

- Reconcile DB trades against executed buy/sell ledger.
- Force Kelly to zero when duplicate/open-row mismatch exists.
- Add coverage through `LaneName` / `ArmName`, not legacy `StrategyName` only.

### P1 - LaneEdgeController

- Add `src/risk/laneEdgeController.ts`.
- Read reconciled lane outcomes.
- Emit `entry_mode`, `ticket_cap_sol`, `max_concurrent`, `cooldown_sec`, and `reason`.
- Start in report-only mode.

### P2 - Cohort Throttle

- Wire controller into Pure WS entry path.
- Add token-session quarantine for negative conservative Kelly or repeated stale-price rejects.
- Keep fixed ticket.

### P3 - Live Sizing Unlock

- Only after 200+ wallet-reconciled live trades.
- Only if wallet log growth and conservative Kelly are positive.
- Raise ticket cap by one step, not continuously.

## 11. Acceptance Criteria

- Kelly is never computed from unreconciled DB PnL.
- Paper lanes never unlock live sizing.
- Negative conservative Kelly can reduce attempts, but cannot increase them.
- Ticket increase is impossible while wallet floor, drift halt, or duplicate ledger mismatch is active.
- Reports show raw Kelly and conservative Kelly separately.

## 12. Summary

The practical edge is not the Kelly formula itself.

The edge is using conservative Kelly and realized payoff distribution to decide which lane/cohort deserves more attempts, which cohort must be throttled, and when a promising paper edge is not yet live-tradable.
