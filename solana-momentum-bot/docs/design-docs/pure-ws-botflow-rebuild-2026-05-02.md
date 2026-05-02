# Pure WS Bot-Flow Rebuild — New-Pair Microstructure Lane

> Date: 2026-05-02
> Status: Phase 2 sidecar paper simulator implemented (observe-only)
> Authority: `MISSION_CONTROL.md` -> `option5-kol-discovery-adoption-2026-04-23.md` -> this document
> Scope: replace `pure_ws` strategic direction from legacy breakout scalping to new-pair bot-flow microstructure.

## 0. Decision

We will rebuild `pure_ws` around **new-pair bot-flow** rather than continue tuning the legacy `pure_ws_breakout` candle/burst strategy.

This is not a return to blind launch sniping. The new lane uses:

```text
new-pair discovery
+ token/dev/holder quality
+ bot-flow net pressure
+ execution-cost filter
+ micro-ticket fast exits
+ post-cost markout evidence
```

The target is not one 5x hold. The target is repeated small positive post-cost outcomes that can compound while the KOL runner lane continues to search for right-tail winners.

2026-05-02 Mayhem review correction:

```text
Mayhem is context, not a strategy to copy.
Do not follow the Mayhem agent wallet.
Do not treat community-claimed legacy wallets as current official Mayhem provenance.
```

## 1. Quality Check Of The Thesis

### 1.1 What was wrong with legacy pure_ws

Legacy `pure_ws_breakout` was built for on-chain burst/candle detection. It already has a documented failure mode:

- dead-liquidity bias,
- late discovery,
- high friction relative to target,
- weak 5x observation rate,
- heavy dependence on post-signal execution quality.

The 2026-04-23 debate archived `pure_ws` as a weak primary paradigm and moved the project to KOL-first discovery. That diagnosis remains valid.

Therefore, the correct move is not parameter tuning. It is a lane rewrite.

### 1.2 What the Gygj bot teaches

The inspected address `Gygj9QQby4j2jryqyqBHvLP7ctv2SaANgh4sCb69BUpA` is not a normal KOL wallet. It is a fee-payer / multi-wallet execution bot.

Recent sampled behavior:

```text
1000 swaps in 135 seconds
461 buys / 539 sells
245.849 SOL buy flow / 240.361 SOL sell flow
58 mints / 58 sub-accounts
same user-mint reconstructed hold p50 ≈ 4s, p90 ≈ 12s
```

Important correction:

```text
This is not a wallet to copy after confirmed observation.
It is a market microstructure pattern to detect earlier.
```

Important provenance split:

```text
Gygj9QQ...BUpA = legacy/community bot-flow research sample
BwWK17...de6s = current official Mayhem agent context address
MAyh...MD4e = current Mayhem program id
```

`Gygj` and `BwWK` must never be silently merged into one benchmark. The report script requires an explicit bot profile and explicit market/counterparty accounts to prevent accidental Mayhem-following semantics.

Confirmed `getParsedTransaction` after-the-fact is likely too slow for its median hold time. The edge is upstream: processed logs, fresh pair creation, prewarmed routes, and immediate net-flow scoring.

### 1.3 Why the thesis is still mission-aligned

Mission Control says 100 SOL is a tail outcome, not a planning KPI. The operational mission is survival, 200 live trades, and evidence of right-tail opportunity.

`pure_ws_botflow_v1` is mission-aligned only if it obeys:

- tiny tickets,
- no Real Asset Guard relaxation,
- no security gate weakening,
- no martingale/DCA,
- post-cost measurement before live scale,
- hard separation from KOL runner logic.

It becomes harmful if it is treated as high-size launch sniping.

## 2. Lane Identity

| Field | Value |
|---|---|
| Lane | `pure_ws` |
| Arm | `pure_ws_botflow_v1` |
| Legacy arm | `pure_ws_breakout_v1` remains disabled/benchmark-only unless explicitly re-enabled |
| Objective | small post-cost edge capture on fresh-pair bot-flow |
| Holding horizon | 3s / 10s / 15s / 30s |
| Ticket | 0.005-0.01 SOL initially; 0.02 only after evidence gate |
| Live status | observe-only first, micro-canary second |
| Runner relationship | separate from KOL 5x runner lane |

## 3. Signal Model

### 3.1 Discovery

Primary source:

```text
program log subscription -> pool init / new pair candidate -> pair prewarm
```

Secondary source:

```text
tracked wallet/profile watchlist -> enhanced/synthetic flow parser -> token/mint pressure rows
```

The lane must not rely on slow Gecko/DexScreener polling for entry timing.

Mayhem-related signals are only context flags:

```text
MAYHEM_MODE_TRUE
MAYHEM_ACTIVE_LT_24H
MAYHEM_AGENT_FLOW_PRESENT
MAYHEM_PROGRAM_SEEN
```

They do not pass an entry by themselves. `MAYHEM_AGENT_FLOW_PRESENT` is not Mayhem mode truth; it is only an agent-flow observation until an explicit `MAYHEM_MODE_TRUE` source exists. A Mayhem-only candidate remains paper/observer until organic buyer breadth, executable price reaction, sell route, and token quality confirm continuation.

### 3.2 Bot-flow features

For each fresh mint/pair, compute rolling windows:

```text
3s, 10s, 15s, 30s
```

Minimum features:

```text
buy_count
sell_count
buy_sol
sell_sol
net_flow_sol = buy_sol - sell_sol
buy_sell_ratio
small_buy_count
topup_count
unique_fee_payers
unique_sub_accounts
same_fee_payer_repetition
last_buy_age_ms
last_sell_age_ms
```

For Gygj-style bots, "recent sell exists" is not a hard reject. It is part of net-flow.

### 3.3 Entry candidate

Initial observe-only candidate rule:

```text
fresh_pair_age <= 180s
AND sell_route_precheck != failed
AND security_status != hard_reject
AND net_flow_sol_15s > 0
AND buy_count_15s >= 3
AND small_buy_count_15s >= 2
AND gross_buy_sol_15s >= 1.0
AND estimated_round_trip_cost_pct <= expected_edge_pct * 0.50
```

Live candidate rule should be stricter than observe-only:

```text
net_flow_sol_10s >= 0.5
AND buy_sell_ratio_10s >= 1.25
AND postCostEdgeEstimate_15s >= +2%
AND route_context_fresh_ms <= 1200
AND no structural risk flags
```

## 4. Exit Model

This lane is not a 5x runner system.

Initial exit policy:

```text
DOA cut: 5-10s if no favorable markout and net flow flips negative
hard cut: -4% to -6% token-only or quote-implied
T1: +6% gross / +2% post-cost
T2: +10-12% gross / +5% post-cost
trail: 3-5% after T1 only
max hold: 30s unless T2 reached and net flow remains positive
```

If T+15/T+30 shows that exits are too slow, the lane must cut sooner rather than widen stops.

## 5. Data Plane

### 5.1 New ledgers

Use sidecar ledgers first. Do not pollute trade outcome ledgers until live entries exist.

```text
data/realtime/pure-ws-botflow-events.jsonl
data/realtime/pure-ws-botflow-candidates.jsonl
data/realtime/pure-ws-botflow-markouts.jsonl
data/realtime/pure-ws-botflow-paper.jsonl
```

All writers are fail-open. Write failure must not block trading paths. The report script dedupes sidecar appends by row id when `--write-ledgers` is enabled.

### 5.2 Candidate schema

Required fields:

```text
schemaVersion = pure-ws-botflow-candidate/v1
candidateId
observedAt
tokenMint
pairAddress
poolAddress
dexId
pairAgeSec
source
windowSec
buyCount
sellCount
buySol
sellSol
netFlowSol
buySellRatio
smallBuyCount
topupCount
uniqueFeePayers
uniqueSubAccounts
securityFlags
qualityFlags
estimatedRoundTripCostPct
postCostDeltaEstimatePct
decision = observe | reject
rejectReason
```

`paper` / `live` decisions belong to later execution/outcome ledgers. Phase 0 candidate rows stay observe-only so they cannot be mistaken for trade instructions.

### 5.3 Markout offsets

For bot-flow, use:

```text
T+3s, T+10s, T+15s, T+30s, T+60s
```

KOL trade markouts remain:

```text
T+30s, T+60s, T+300s, T+1800s
```

Do not force one shared offset set across all lanes.

Phase 0 marks a row `ok` only when an external price trajectory point lands within the configured max lag of both entry and target horizon. Distant future or synthetic fee-payer flow events must remain `missing_price_trajectory` / `bad_entry_price`, otherwise the report will overstate T+15/T+30 coverage.

## 6. Execution Requirements

This lane only works if execution latency is measured and bounded.

Required telemetry:

```text
signal_detected_at
candidate_scored_at
quote_requested_at
quote_received_at
tx_built_at
tx_sent_at
landed_at
buy_fill_price
quote_price
entry_drift_pct
priority_fee_sol
jito_tip_sol
route_kind
send_path
```

Important constraint:

```text
confirmed-only parsing is acceptable for observe-only evidence,
but not sufficient for final live edge.
```

Live canary requires a faster path plan:

- processed WS or equivalent low-latency stream,
- pair prewarm,
- route cache / quote freshness checks,
- priority fee strategy,
- send path telemetry.

## 7. Risk Controls

No Real Asset Guard relaxation.

Initial hard caps:

```text
PURE_WS_BOTFLOW_ENABLED=false
PURE_WS_BOTFLOW_OBSERVE_ONLY=true
PURE_WS_BOTFLOW_LIVE_ENABLED=false
PURE_WS_BOTFLOW_TICKET_SOL=0.005
PURE_WS_BOTFLOW_MAX_CONCURRENT=1
PURE_WS_BOTFLOW_MAX_TRADES=50
PURE_WS_BOTFLOW_CANARY_BUDGET_SOL=0.03
```

Promotion to 0.01 SOL requires:

```text
>= 200 observe candidates
>= 30 paper/canary fills
T+15 postCostDelta Q25 >= 0
T+30 postCostDelta median >= +2%
no wallet drift incidents
no security hard reject bypass
```

Promotion to 0.02 SOL requires separate ADR.

## 8. Rollout Plan

### Phase 0 — Evidence parser

Build parser/reporting only. Implemented in:

```text
src/observability/pureWsBotflow*.ts
scripts/pure-ws-botflow-report.ts
test/pureWsBotflow.test.ts
```

- parse fee-payer bot-flow into synthetic mint flow events,
- require explicit `--tracked-address` or `--bot-profile`,
- separate tracked address from optional `--fee-payer-filter`,
- require target-specific market/counterparty overrides with `--market-accounts`,
- emit bot profile / wallet role / provenance confidence in reports,
- compute 3s/10s/15s/30s windows,
- write reports by default; append sidecar ledgers only with `--write-ledgers`,
- compute candidates and max-lag-bounded markouts,
- no entries.

Acceptance:

```text
npm run check:fast
>= 1 known Gygj-like session reconstructs buy/sell/net-flow windows
report shows postCostDelta by window
```

2026-05-02 sanity run against `Gygj9QQ...BUpA`:

```text
tx=300
events=300
candidates=104
observed=15
evidence verdict=observe_only
blockers: observe candidates 15 < 200, T+15 ok rows 2 < 30, T+30 ok rows 0 < 30
T+3 post-cost median -6.02%, T+10 median +25.27%, T+15 median +157.45%
```

Important finding: when candidate entry is anchored at **window end** rather than window start, the sampled data is not yet live-eligible. This confirms the safety requirement: do not copy confirmed bot-flow; collect enough post-cost distribution first.

Second important finding: after max-lag bounding, no sampled T+30/T+60 row had a reliable nearby trajectory event. This is exactly why Phase 1 must join a true fresh-pair price stream instead of relying on sparse fee-payer transactions for live decisions.

### Phase 1 — New-pair join

Join bot-flow with fresh pool discovery.

- pair age at first flow,
- sell route status,
- holder/dev quality flags,
- pool prewarm status.

Implemented observe-only context join in:

```text
src/observability/pureWsBotflowContext.ts
src/observability/pureWsBotflowCandidates.ts
src/observability/pureWsBotflowReport.ts
scripts/pure-ws-botflow-report.ts
test/pureWsBotflow.test.ts
```

Current inputs:

```text
--pair-context-file       optional jsonl; tokenMint/pairAddress/dexId/pairCreatedAt source
--token-quality-file      default data/realtime/token-quality-observations.jsonl
--admission-file          default data/realtime/admission-skips-dex.jsonl
```

Important constraint:

```text
pairAgeSec is populated only when pairCreatedAt is available.
If pair context exists but pairCreatedAt is missing, candidate rows carry PAIR_CREATED_AT_UNKNOWN.
If no context exists, candidate rows carry PAIR_CONTEXT_MISSING and cannot pass evidence promotion.
```

Acceptance:

```text
candidate rows include pairAgeSec and quality flags
late/stale candidates are separable from early candidates
```

2026-05-02 implementation status:

```text
quality flags: implemented
pool context flags: implemented
pairAgeSec: implemented when pairCreatedAt source exists
report context coverage: implemented
live/path entry impact: none
```

### Phase 2 — Paper/canary simulator

Replay entries at candidate time using markout prices.

Implemented as sidecar paper simulation, not runtime trading:

```text
src/observability/pureWsBotflowPaper.ts
scripts/pure-ws-botflow-report.ts
npm run purews:botflow-paper
npm run purews:botflow-paper -- --bot-profile gygj_legacy --market-accounts <pool-or-counterparty>
npm run purews:botflow-paper -- --bot-profile mayhem_current --market-accounts <pool-or-counterparty> --telegram
```

Policy:

```text
entry: candidate window end
ticket: 0.005 SOL default
hard cut: post-cost <= -6%
T1: gross >= +6% and post-cost >= +2%
T2: gross >= +10% and post-cost >= +5%
max hold: 30s default
missing price trajectory: unresolved, not counted as win
telegram: opt-in summary only; no per-candidate spam
profile/counterparty: explicit; no implicit Mayhem wallet copy
```

2026-05-02 Gygj sample paper run after price-truth correction:

```text
tx=300
events=300
candidates=84
observed=22
paper resolved=0/22
paper win rate=n/a
paper simulated net=0.000000 SOL
median post-cost=n/a
exit reasons: missing_entry_price=22
verdict: keep paper-only
```

Earlier synthetic fee-payer event-price paper looked positive in one sample, but it was invalid as a paper truth source. After the correction, paper cannot resolve without an external price trajectory or executable quote source. This is intended.

Acceptance:

```text
Q25(T+15 postCostDelta) >= 0
median(T+30 postCostDelta) >= +2%
false positive dump cohort identified
paper resolved rows are separated from missing trajectory rows
```

### Phase 3 — Micro live canary

Only after Phase 0-2 evidence.

Initial live:

```text
ticket 0.005 SOL
max concurrent 1
max 50 trades
budget 0.03 SOL
auto-halt on 3 consecutive realized losers
```

### Phase 4 — Scale decision

Scale only with explicit ADR.

Required:

```text
>= 100 live trades
wallet-truth positive after fees
postCostDelta live ~= paper within tolerance
no floor stress
```

## 9. Non-Goals

- Do not copy Gygj after confirmed observations.
- Do not copy the current official Mayhem agent wallet.
- Do not allow Mayhem-only context to pass an entry gate.
- Do not add high-size launch sniping.
- Do not merge this logic into KOL smart-v3.
- Do not loosen `NO_SECURITY_DATA`.
- Do not disable sell-route / drift / wallet delta guards.
- Do not treat 100 SOL as a near-term KPI.

## 10. Final Recommendation

Proceed with the rebuild.

The old `pure_ws_breakout` thesis has enough negative evidence that incremental tuning is low value. The new thesis is different enough to justify a large change:

```text
legacy pure_ws = late burst/candle follower
new pure_ws_botflow = fresh-pair net-flow microstructure harvester
```

The first implementation sprint should be observation and reporting, not live trading. If the post-cost distribution is positive, `pure_ws_botflow_v1` becomes the best candidate companion to KOL Hunter:

- KOL Hunter searches for right-tail runners.
- Rotation lane harvests KOL-driven small continuation.
- Pure WS bot-flow harvests launch/new-pair microstructure.
