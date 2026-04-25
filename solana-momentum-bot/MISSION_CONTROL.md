# Mission Control Framework

> Updated: 2026-04-25
> Document type: control-plane policy
> Authority chain: `mission-refinement-2026-04-21.md` -> `mission-pivot-2026-04-18.md` -> `PLAN.md` / `MEASUREMENT.md` -> this document

## Purpose

This project is not searching for one perfect trading rule. The mission is to keep the wallet alive while searching for rare right-tail winners.

`100 SOL` is a tail outcome, not a planning KPI. Operational success remains:

```text
Keep the 0.8 SOL floor intact,
survive 200 live trades,
measure whether 5x+ winners exist in the selected universe.
```

The bot optimizes for positive optionality:

```text
small fixed probes
+ strict survival gates
+ fast loser removal
+ long runner preservation
+ wallet-truth accounting
+ interpretable experiment logs
```

Primary question:

```text
Which universe, regime, KOL cluster, venue, and execution condition
raise the conditional probability of a 5x+ winner enough
to justify the bleed budget?
```

## Control 1: Survival Budget

`0.8 SOL` is a hard floor. Survival accounting includes realized PnL, failed transaction fees, base fee, priority fee, tip, slippage, bad fill drift, and open inventory equity view. DB-only PnL is reconciliation evidence only.

Required controls:

| Control | Role |
|---|---|
| `WalletStopGuard` | Halt new entries below wallet floor |
| `WalletDeltaComparator` | Halt on wallet-vs-ledger drift |
| `DailyBleedBudget` | Cap daily probe bleed |
| `CanaryAutoHalt` | Cap per-lane cumulative loss and loss streak |
| `CanaryConcurrencyGuard` | Cap global simultaneous probes |

Open implementation requirement:

```text
Every live report separates:
wallet_cash_delta,
wallet_equity_delta,
realized_lane_pnl,
execution_cost_breakdown.
```

## Control 2: Tail Universe Selection

All tokens are not one universe. Arms must be separated by tail structure.

| Arm | Role | Status |
|---|---|---|
| Lane C: `cupsey_flip_10s` | benchmark | frozen |
| Lane S: `pure_ws_breakout` | Helius/WS scalping baseline | implemented |
| Lane T: `kol_hunter` | KOL discovery + our execution | paper-first |
| Lane M: `migration_handoff` | graduation / canonical pool reclaim | candidate |
| Lane L: `pump_live_lotto` | tiny-ticket new launch optionality | candidate only |

Rules:

- KOL buy is a discovery trigger, not automatic entry.
- Multiple KOL buys raise priority only when they are independent clusters.
- Jupiter organic / recent / toporganicscore is soft ranking, not hard override.
- Migration / graduation tokens are a separate event universe.
- Raw new-launch sniping is a lotto lane only.
- Every trade and reject records arm and cohort.

## Control 3: Payoff Architecture

Tail hunting requires many small controlled losses and few large preserved winners.

```text
PROBE: small ticket, hard gates, fast loser cut
T1: first strength confirmation, trailing begins
T2: 5x candidate zone, breakeven/profit lock, looser trail
T3: 10x candidate zone, no arbitrary time stop, runner mode
```

Constraints:

- Do not increase initial size to catch tail.
- Do not cut all winners at 1.2x-1.5x unless data proves runners do not exist.
- Do not add DCA before one-shot probe expectancy is understood.
- Strength add-on is Stage 4+ only.

Required metrics:

```text
MFE peak,
MAE trough,
T1/T2/T3 visit timestamps,
close reason,
post-close missed-alpha trajectory.
```

## Control 4: Execution Quality

Execution is part of alpha. A correct signal can lose if it lands badly.

| Check | Purpose |
|---|---|
| Entry drift guard | Reject bad buy fill vs signal price |
| Sell quote probe | Verify exitability before entry |
| Probe viability floor | Reject routes whose bleed exceeds budget |
| Venue-specific bleed model | Estimate fee/slippage by DEX family |
| Jupiter 429 telemetry | Detect route/quote infrastructure stress |

Minimum execution fields:

```text
entry_route_found,
entry_drift_pct,
entry_slippage_bps,
sell_route_found,
sell_impact_pct,
round_trip_bleed_sol,
priority_fee_sol,
tip_sol,
failed_tx_count,
venue.
```

If execution quality degrades, reduce probes or halt the affected arm. Do not loosen entry.

## Control 5: Interpretable 200-Trade Experiment

`200 live trades` is not proof of edge. It is the minimum sample for a scale/retire decision.

Every trade, reject, and close should include:

| Field group | Required examples |
|---|---|
| Arm identity | `lane`, `strategy`, `detector_version`, `parameter_version` |
| Discovery context | KOL id, KOL cluster, independent KOL count, token age, source |
| Market context | venue, token age bucket, liquidity, organic score, buy pressure |
| Execution context | drift, sell impact, route status, fees, slippage |
| Payoff context | MFE, MAE, T1/T2/T3 visits, close reason |
| Risk context | wallet balance, concurrent probes, daily bleed remaining |

Trade count interpretation:

| Count | Meaning |
|---|---|
| 50 | safety checkpoint only; no promotion decision |
| 100 | preliminary friction / bleed / quick-reject review |
| 200 | scale / retire / hold decision |

Adaptive changes require a change log:

```text
change_id, changed_at, arm, hypothesis,
old_value, new_value, reason,
minimum_sample_before_next_change.
```

Without this log, the result is an anecdote, not an experiment.

## Control 6: Operational Discipline

Guardrail relaxation must not depend on emotion after losses.

Hard rules:

- Never weaken `0.8 SOL` wallet floor.
- Never weaken wallet delta halt because it is inconvenient.
- Never increase ticket size after a loss streak.
- Never enable live for a new lane before paper/shadow criteria pass.
- Never change parameters on the same day as a major drawdown unless the change reduces risk.
- Never treat DB PnL as final truth.

Allowed after losses:

- Reduce ticket count.
- Pause an arm.
- Increase observation-only logging.
- Tighten survival / execution gates.
- Reclassify weak KOLs inactive.

Forbidden after losses:

- Lower security gates.
- Raise max concurrent probes.
- Disable wallet comparator.
- Disable sell quote / drift checks in live.
- Add DCA to recover.

## KOL Control

KOL discovery is an information edge candidate, not a trade permission.

```text
KOL wallet buy
-> candidate
-> independent cluster scoring
-> short observation window
-> survival / drift / sell quote checks
-> small PROBE
-> T1/T2/T3 runner state machine
```

KOL DB target:

```text
20-30 independent KOL clusters
50-80 verified wallet addresses
monthly re-verification
inactive stale/noisy wallets
```

KOL promotion / demotion metrics:

- `T+5m` median return.
- `T+30m` median return.
- `5x+` candidate frequency.
- Average KOL hold time.
- Quick sell ratio.
- No-route / sell-impact failure rate.
- Multi-KOL independent consensus uplift.

## Strategy Expansion Priority

If the system starts producing stable positive wallet-truth results, expansion order is still controlled by survival and evidence. Do not add the highest-variance lane first.

| Priority | Strategy | Why |
|---|---|---|
| 1 | KOL DB expansion | More independent clusters improve discovery breadth |
| 2 | KOL performance tiering | Remove stale/noisy wallets before scaling |
| 3 | KOL Consensus Reclaim | Prefer independent KOL agreement plus reclaim over immediate copy |
| 4 | Organic confirmation ranker | Add Jupiter organic/recent signals as soft priority, not hard permission |
| 5 | Migration / PumpSwap handoff | Event-backed momentum with clearer structure than raw launch sniping |
| 6 | Pump Live / new launch lotto | Tiny-ticket optionality only, never the main survival engine |
| 7 | Read / landing upgrade | LaserStream, Sender, or Jito only after detector edge is visible |

Priority rule:

```text
KOL candidate quality before more trades.
Organic/event confirmation before raw launch sniping.
Detector edge before expensive infrastructure.
```

## Daily Review

Daily review answers only:

1. Did wallet truth remain valid?
2. Did the 0.8 SOL floor remain protected?
3. Which arm consumed bleed, and did it produce runner visits?
4. Which cohort improved or degraded the 5x conditional probability?

Do not ask "when will this reach 100 SOL?" during Stage 1-4.

## Scale Decision

An arm can scale only when all are true:

```text
>= 200 live trades
wallet log growth > 0
5x+ winner or clear T2 runner distribution
ruin probability < 5%
execution costs understood
no unresolved wallet drift
```

Decision:

```text
positive but incomplete -> HOLD
negative wallet growth -> RETIRE or paper rollback
survival breach -> HALT and reconcile
```

## One-Line Rule

The mission is won by preserving survival while repeatedly buying cheap optionality in the few universes where right-tail winners actually appear.
