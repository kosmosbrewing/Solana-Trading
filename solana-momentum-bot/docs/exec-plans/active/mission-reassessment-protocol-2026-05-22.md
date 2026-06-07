# Mission Reassessment Protocol (2026-05-22)

> Status: active reassessment protocol
> Owner: operator + Codex
> Scope: KOL Hunter / Rotation / Smart-v3 / paper-live promotion loop
> Authority: `MISSION_CONTROL.md`, `SESSION_START.md`, `docs/design-docs/mission-refinement-2026-04-21.md`

## 0. Why This Exists

The project has spent meaningful capital and Helius credits without proving a live wallet-truth edge.
The next step is not to give up, and it is not to keep collecting more data the same way.

The next step is a forced reassessment:

```text
Use all existing local data,
run offline mission simulations with no new Helius dependency,
kill broad losing behavior,
and only re-open live risk for cohorts that pass explicit proof gates.
```

This document is the decision contract. If a strategy, paper arm, or live canary does not pass this
protocol, it is not considered mission-progress evidence.

## 1. Mission Truth

Current mission:

```text
Keep the 0.6 SOL floor intact,
minimize repeated loss,
find whether a small, cost-aware, wallet-truth-positive cohort exists,
then compound slowly only after proof.
```

Primary truth order:

1. Wallet-truth SOL delta
2. Refund-adjusted SOL delta
3. Cost-stressed paper / mirror result
4. Token-only return
5. Raw paper headline

Raw paper profit is never enough for live promotion.

## 2. Current Diagnosis To Reassess

The active hypothesis is:

```text
The project is not primarily failing because it lacks more ideas.
It is failing because low-quality admission, weak paper-live translation,
and high-cost data collection have not been judged by one frozen protocol.
```

Known symptoms to verify with simulation:

- Live canary wallet-truth is materially negative.
- Loss is concentrated in repeated early-bleed buckets.
- Rotation paper has positive-looking pockets, but broad wallet-stress often flips negative.
- Smart-v3 has rare right-tail evidence, but broad live canary is not compounding-safe.
- Helius credit burn produced more data than proof.
- Paper / mirror / live roles have improved, but promotion proof is still incomplete.

If offline simulation cannot find a wallet-stressed cohort, the correct decision is not more live
sampling. It is strategy retirement or redesign.

## 3. Freeze Rules

Until this reassessment completes:

- Do not loosen the 0.6 SOL floor.
- Do not increase ticket size.
- Do not broaden live canary arms.
- Do not treat `research_arm` or `shadow` profit as live promotion evidence.
- Do not add new paid Helius collection for this analysis.
- Do not judge any cohort without chronological out-of-sample testing.

Allowed:

- Offline analysis of local JSONL/session/candle files.
- Paper-only or mirror-only candidate generation.
- Risk-reducing live changes, if they reduce exposure and do not expand entries.

## 4. Data Inventory

The reassessment must use local data first.

Core ledgers:

- `data/realtime/kol-live-trades.jsonl`
- `data/realtime/rotation-v1-live-trades.jsonl`
- `data/realtime/smart-v3-live-trades.jsonl`
- `data/realtime/kol-paper-trades.jsonl`
- `data/realtime/rotation-v1-paper-trades.jsonl`
- `data/realtime/smart-v3-paper-trades.jsonl`

Decision and attribution:

- `data/realtime/kol-policy-decisions.jsonl`
- `data/realtime/trade-markout-anchors.jsonl`
- `data/realtime/trade-markouts.jsonl`
- `data/realtime/missed-alpha.jsonl`
- `reports/kol-live-equivalence-*.json`
- `reports/kol-live-mirror-*.json`
- `reports/rotation-promotion-candidates-*.json`
- `reports/rotation-promotion-gatekeeper-*.json`

Market context:

- `data/realtime/sessions/**/micro-candles.jsonl`
- `data/realtime/sessions/**/swaps.jsonl`
- `data/realtime/kol-tx.jsonl`
- `reports/admission-edge-*.json`
- `reports/mission-entry-*.json`
- `reports/rotation-lane-*.json`

Cost and infra:

- `data/realtime/helius-credit-usage.jsonl`
- `reports/sync-health-*.json`

No simulation result is valid if it cannot state which files were read and how many usable rows were
joined.

## 4.1 Join Contract

The simulator must not "approximately" connect paper, live, markout, and decision rows for promotion
evidence. Every joined row must report its join method.

Join priority:

1. `decisionId` + `executionPlanHash`
2. `candidateId`
3. `positionId`
4. `parentPositionId` for tail child rows, joined back to the parent position
5. `entryTxSignature` / `exitTxSignature`
6. `tokenMint + anchor timestamp` within a fixed tolerance

Rules:

- Methods 1-4 are promotion-grade joins.
- Method 5 is execution-attribution-grade only.
- Method 6 is diagnostic-only and cannot be used for live promotion.
- Any row joined by token/time must be marked `nonPromotableJoin=true`.
- Tail child rows must be reported both as child outcome and parent-attached outcome.
- Unjoined live rows are a hard blocker for promotion.

Required join counters:

```text
inputRows,
eligibleRows,
joinedRows,
unjoinedRows,
joinCoveragePct,
joinMethodCounts,
promotionGradeJoinCoveragePct
```

If `promotionGradeJoinCoveragePct < 95%`, the cohort cannot reach `MICRO_CANARY_READY`.

## 4.2 Role Contract

The simulator must separate evidence roles before calculating profitability.

Promotion-comparable roles:

- `live`
- `paper_mirror`
- `fallback_execution_safety`

Non-promotion roles:

- `research_arm`
- `shadow`
- `paper_research`
- `no_trade_markout`
- `diagnostic_only`
- `unknown_role`

Rules:

- Missing role is not neutral. It becomes `unknown_role`.
- `unknown_role` is non-promotable until the source report or row proves otherwise.
- `research_arm` and `shadow` may generate hypotheses but cannot justify live risk.
- `paper_mirror` is used for translation proof, not direct wallet-truth proof.
- `fallback_execution_safety` can explain execution blockage, but cannot by itself prove strategy edge.

Every output table must show role counts and net by role.

## 4.3 Metric Calculation Contract

The simulator must calculate metrics consistently and show the source field used.

### Net SOL axes

```text
walletTruthNetSol =
  row.walletDeltaSol
  ?? row.actualWalletNetSol
  ?? liveCloseRow.netSol
```

`walletTruthNetSol` is valid only for live close rows or explicitly wallet-reconciled rows.
Paper rows must not be promoted to wallet truth by copying `netSol`.

```text
paperNetSol =
  paperCloseRow.netSol
```

```text
tokenOnlyNetSol =
  row.netSolTokenOnly
  ?? row.tokenOnlyNetSol
  ?? null
```

Token-only values are diagnostic only.

### Refund and stress axes

Use report-provided fields when available:

```text
refundAdjustedNetSol =
  report.refundAdjustedNetSol
  ?? report.refundAdjustedSol
  ?? row.refundAdjustedNetSol
  ?? row.netSol
```

For raw-row simulation, the first-pass stress model is:

```text
stressCostSol = max(0.0001, ticketSol * 0.005)
walletStressNetSol = refundAdjustedNetSol - stressCostSol
```

If a report already provides `walletDragStressSol` or `walletStressSol`, use that field and mark
`stressSource=report`. Otherwise use the raw-row model and mark `stressSource=simulated_0p5pct_min_0p0001`.

Promotion requires the stress source to be shown. A cohort cannot be promoted if its positive result
depends only on token-only or no-stress paper.

For per-row post-cost metrics:

```text
postCostNetSol =
  walletTruthNetSol
  ?? refundAdjustedNetSol
  ?? paperNetSol
```

The source must be reported as:

```text
postCostSource = wallet_truth | refund_adjusted | paper_net
```

Promotion prefers `wallet_truth`, allows `refund_adjusted` for paper bridge review, and treats
`paper_net` as non-promotional unless paired mirror evidence later confirms translation.

### Winner concentration

```text
grossPositiveSol = sum(max(0, netSol))
topWinnerShare = sum(topN positive netSol) / grossPositiveSol
```

Default caps:

```text
top5WinnerShare <= 35%
top10WinnerShare <= 50%
```

If `grossPositiveSol <= 0`, concentration is not applicable and the cohort is not promotion-ready.

### Positive ratio and loss streak

```text
postCostPositiveRatio = count(rows where postCostNetSol > 0) / closeRows
maxLossStreak = longest consecutive sequence where postCostNetSol <= 0 ordered by close/anchor time
```

Missing close time makes the row diagnostic-only for streak calculations.

### Right-tail preservation

Right-tail candidates are counted by MFE:

```text
runner50 = MFE >= 50%
runner5x = MFE >= 400%
```

For a veto to be acceptable, it must report:

```text
savedLossSol,
missedRunner50Count,
missedRunner5xCount,
missedRunner5xNetOpportunity,
falseNegativeRate
```

## 4.4 Ex-Ante And Leakage Rules

Only features known at or before the candidate decision time may be used to create a gate.

Allowed for ex-ante gates:

- KOL events timestamped before decision time
- route / quote / security evidence observed before entry
- candle features ending at or before anchor time
- historical KOL quality calculated only from rows closed before the candidate time
- previous same-token / same-KOL cooldown state known before the candidate time

Forbidden:

- choosing `good_kol_focus` from the same test window being scored
- using future close reason to decide admission
- using future MFE/MAE except to score a frozen rule
- using day-level loss-regime labels derived from the same day after the candidate occurred
- mixing research/shadow profits into live promotion metrics

Every simulated rule must output:

```text
featureCutoffTime,
decisionTime,
usesFutureData: true|false,
leakageVerdict: PASS|FAIL
```

If `usesFutureData=true`, the result is hypothesis-only and cannot reach `MICRO_CANARY_READY`.

## 4.5 Coverage And Invalid Result Rules

The simulator must be willing to say "cannot decide".

Hard invalidation:

- `promotionGradeJoinCoveragePct < 95%`
- key metric coverage below 90% for first-pass review
- close rows below the configured minimum
- fewer than 5 active day buckets for promotion
- stale KOL quality used as if current
- stress source missing
- role unknown for more than 5% of promotion rows

Invalidated outputs must end in `COLLECT_OFFLINE`, `RESEARCH_ONLY`, or `QUARANTINE`, never
`MICRO_CANARY_READY`.

## 5. Simulation Questions

### 5.1 Baseline Replay

Question:

```text
What happened under the actual historical policy?
```

Output:

- live wallet-truth net
- paper net by role
- close count
- win rate
- max drawdown
- max loss streak
- top winner concentration
- loss by exit bucket
- Helius credits by purpose

### 5.2 Admission Veto Simulation

Question:

```text
If we had not entered the known early-bleed patterns, how much loss would be saved,
and how many future winners would be missed?
```

Candidate veto buckets:

- `probe_hard_cut`
- `entry_advantage_emergency_exit`
- `rotation_dead_on_arrival`
- `smart_v3_mae_fast_fail`
- candle-derived DOA / fail30 / volatile pre-entry regimes

Required metrics:

- saved SOL
- missed `MFE >= 50%`
- missed `MFE >= 400%`
- false-negative rate
- post-cost net after veto
- row count by day

A veto is usable only if it saves loss without deleting rare right-tail candidates at an unacceptable
rate.

### 5.3 Probe-First Simulation

Question:

```text
Would smaller initial exposure plus 15s/30s confirmation have reduced bleed without killing upside?
```

Profiles:

- full-entry baseline
- 10% probe then add only after `MFE_30 >= 2% and close_30 > 0`
- exit if `MFE_15 < 1.5% and close_15 <= 0`
- same-token cooldown after fail30

Required metrics:

- simulated wallet net
- maximum drawdown
- loss per close
- winner capture rate
- missed winner count
- active day count

### 5.4 Rotation Bridge Simulation

Question:

```text
Is there a rotation cohort that stays positive after route, cost, wallet-stress,
and chronological testing?
```

Starting cohort:

- `rotation_underfill_cost_aware_exit_v2`
- route proof present
- cost-aware present
- comparable paper role only
- good-KOL quality evidence if ex-ante available

Required metrics:

- refund-adjusted net
- wallet-stress net
- post-cost positive ratio
- top winner share
- day-bucket dispersion
- parent-child delta
- unique candidate count

If this cannot pass wallet-stress, rotation is not a compounding lane.

### 5.5 Smart-v3 Retire Or Quarantine Simulation

Question:

```text
Does smart-v3 contain a defensible tail-only subcohort,
or is it only live bleed with rare anecdotes?
```

Required metrics:

- actual `MFE >= 400%` count
- loss needed per 5x discovery
- hardcut helped vs hurt
- pass30 survivor quality
- live vs mirror sign agreement
- max loss streak

Default decision is quarantine unless a subcohort is positive under wallet-stress.

### 5.6 API Cost-To-Edge Simulation

Question:

```text
Which data collection paths produce decisions, and which only burn credits?
```

Required metrics:

- estimated credits by purpose
- credits per accepted candidate
- credits per avoided bad entry
- credits per promotion-ready row
- credits per live wallet SOL gained or lost

Any source with high credit burn and no decision impact must be capped, cached, or disabled.

### 5.7 Micro-Canary Ruin Simulation

Question:

```text
If we restart live with tiny size, what is the probability of hitting the sleeve loss cap
before proving edge?
```

Inputs:

- historical cohort returns
- ticket size
- sleeve loss cap
- max consecutive loser rule
- 30-close and 50-close review points

Required metrics:

- probability of sleeve ruin
- expected net after 30 closes
- probability of net positive after 30 closes
- worst 5% path
- recommended live close cap

No cohort can go live if ruin probability is high relative to remaining wallet buffer.

## 6. Chronological OOS Rule

Random split is prohibited.

The first implementation should support rolling chronological windows:

```text
train -> validation -> test
past data only -> freeze rule -> future slice score
```

Minimum reporting:

- train period
- validation period
- test period
- active day count
- row count
- whether thresholds were frozen before test

If a rule only works after looking at the test period, it is not proof.

## 7. Decision States

Every lane/cohort ends with one of these states:

| State | Meaning |
|---|---|
| `KILL` | Historical and cost-stressed evidence is negative. Do not run live. |
| `QUARANTINE` | Keep paper/mirror observation only. No funded live. |
| `RESEARCH_ONLY` | Interesting idea, but not comparable to live. |
| `COLLECT_OFFLINE` | Existing rows insufficient; collect only if no new paid API hot path is needed. |
| `MICRO_CANARY_READY` | Passed OOS + wallet-stress + translation checks. Manual live review only. |
| `COMPOUNDING_CANDIDATE` | Passed micro-canary wallet-truth; still capped until larger sample. |

## 8. Promotion Gate

A cohort can reach `MICRO_CANARY_READY` only if all are true:

- chronological OOS net is positive after cost stress
- wallet-stress net is positive
- top winner share is below concentration cap
- max loss streak is within sleeve budget
- paper role is comparable
- execution plan / route / cost fields are present at required coverage
- promotion-grade join coverage is high enough
- leakage verdict is `PASS`
- no live-without-comparable-paper path is required
- API cost is bounded

Suggested initial thresholds:

```text
OOS rows:                 >= 100
active days:              >= 5
wallet-stress net:        > 0
post-cost positive ratio: >= 52%
top winner share:         <= 35%
max loss streak:          <= 10
coverage for key fields:  >= 90% first pass, >= 95% before live
promotion-grade joins:    >= 95%
unknown role rows:        <= 5%
```

These thresholds can be tightened after the first simulator run, but they cannot be loosened to
justify a desired live result.

## 9. Kill Criteria

Immediate kill or quarantine:

- live wallet-truth remains negative after a properly paired micro-canary
- strategy loss, not execution drag, explains most paired failures
- wallet-stress flips a paper-positive cohort negative
- top winners explain most of gross positive result
- required data coverage is too sparse to prove translation
- API cost is high and decision impact is low

Broad live canary cannot be restarted simply because paper headline is positive.

## 10. Required Output

The first implementation should generate:

```text
reports/mission-offline-sim-YYYY-MM-DD.json
reports/mission-offline-sim-YYYY-MM-DD.md
```

The Markdown report must include:

- data files read and row counts
- join coverage by method
- role coverage and net by role
- metric source fields and stress source
- leakage verdict for every simulated rule
- baseline replay
- admission veto simulation
- probe-first simulation
- rotation bridge simulation
- smart-v3 quarantine simulation
- API cost-to-edge table
- micro-canary ruin simulation
- final decision table by lane/cohort

The JSON output must be machine-readable enough to trend over future reruns.

## 11. Next Implementation Sprint

Sprint name:

```text
Offline Mission Simulator v0
```

Files likely involved:

- add `scripts/mission-offline-simulator.ts`
- add `test/missionOfflineSimulator.test.ts`
- optionally add helpers under `src/research/missionSimulation/`

Acceptance criteria:

- runs without any network call
- reads local `data/realtime` and `reports`
- produces both Markdown and JSON reports
- separates live, mirror, fallback, shadow, and research roles
- treats unknown role as non-promotable
- reports join method and blocks promotion on fuzzy token/time joins
- reports `usesFutureData` and blocks leaked rules
- reports metric source fields for wallet/refund/stress axes
- reports saved-loss and missed-winner for veto simulations
- reports wallet-stress for rotation candidates
- reports credit burn by feature/purpose
- outputs `COLLECT_OFFLINE` instead of guessing when coverage is insufficient
- ends with explicit `KILL / QUARANTINE / RESEARCH_ONLY / COLLECT_OFFLINE / MICRO_CANARY_READY`
- `npm run check:fast` passes

## 12. Operator Rule

After this document is active, the default answer to uncertainty is:

```text
Do not pay more API or live SOL to answer a question
that can be answered from the existing dataset.
```

Only after the offline simulator finds a candidate should the project spend live risk again.
