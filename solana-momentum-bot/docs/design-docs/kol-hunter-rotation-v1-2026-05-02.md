# KOL Hunter Rotation v1 Lane

Date: 2026-05-02

## Decision

Add `kol_hunter_rotation_v1` as a separate opt-in KOL Hunter lane. It does not replace `kol_hunter_smart_v3`, whose job remains 5x+ convex winner capture. Rotation v1 targets fast dv/decu-like opener plus top-up patterns with tighter runner rules and explicit sell-wave avoidance.

The lane must not consume or cancel the existing smart-v3 pending candidate. If rotation fires first, the smart-v3 observe window remains alive and can still trigger its own paper/live decision later. The only shared constraint is Real Asset Guard and same-mint live exposure: if a live position is already open for the mint, the later live trigger falls back to paper monitoring.

Default runtime state:

- `KOL_HUNTER_ROTATION_V1_ENABLED=false`
- `KOL_HUNTER_ROTATION_V1_LIVE_ENABLED=false`

The lane can be enabled for paper measurement without changing Real Asset Guard values. Live requires a separate explicit flag and still passes the existing live canary gates.

## Evidence

Recent KOL wallet logs show that dv/decu are not simply buying tiny tickets and waiting for 500%:

- dv: high same-mint repeat-buy rate, median first-sell around seconds to tens of seconds, many opener plus top-up sequences.
- decu: similar repeat-buy and fast sell behavior, with small top-ups but often a meaningful opener.
- Last-24h observed gross roundtrip for dv/decu was dominated by opener plus top-up rotation, not by small-only micro entries.

Implication: copying size is wrong for our wallet, but copying the state pattern may be useful:

1. detect fast repeated buys from known rotators;
2. avoid any recent same-mint KOL sell;
3. use our fixed ticket size;
4. use tighter T1, trail, and probe timeout;
5. keep the 5x lane intact.

### Candidate and Threshold Review - 2026-05-02

Latest synced local KOL data (`kol-tx.jsonl` + `kol-shadow-tx.jsonl`) covered
2026-04-25 08:05:58 UTC to 2026-05-02 07:34:08 UTC, 57,215 KOL tx rows.
Rotation trade/no-trade markout rows were still zero, so this review is a
candidate-formation review, not realized edge proof.

`KOL_HUNTER_ROTATION_V1_MIN_BUY_COUNT=3` remains the right default. With the
current `smallBuys>=2` and `gross>=1 SOL` constraints, `buy>=2` and `buy>=3`
produced the same candidate count in the latest data. Raising to `buy>=4`
cut formation materially and risks arriving late for a short continuation lane.

`KOL_HUNTER_ROTATION_V1_SMALL_BUY_MAX_SOL=0.061` was too tightly fit to dv/decu.
It kept dv/decu coverage high but suppressed other active rotation-like KOLs
whose top-ups cluster closer to 0.10-0.12 SOL. Default is now `0.12`. Do not
raise directly to `0.25` without post-cost markout evidence because that starts
to capture broader KOL chasing rather than small top-up rotation.

Current candidate tiers:

- core live interpretation: `dv`, `decu`, `jijo`, `kadenox`;
- live watch/canary interpretation: `heyitsyolo`, `noob_mini`, `chester`,
  `letterbomb`, `theo`, `yenni`, `domy`;
- shadow/promotion watch only: `west_ratwizardx`, `cupsey_benchmark`, `sebi`,
  `scharo`, `esee06257`.

`KOL_HUNTER_ROTATION_V1_KOL_IDS` remains a seed-score boost, not a hard allowlist.
The lane should keep using active KOL DB metadata unless a future ADR introduces
a separate include-list. Shadow and observer KOLs remain ineligible for live
triggering.

### Inventory-Flow Entry/Exit Review - 2026-05-03

Latest synced evidence at review time:

- sync health: `reports/sync-health-2026-05-03.md`, generated 2026-05-03 20:04 KST;
- rotation report: `reports/rotation-lane-2026-05-03.md`;
- KOL flow source: `data/realtime/kol-tx.jsonl`, synced 2026-05-03 20:01 KST;
- scope: active S/A KOLs over the latest local 7d window, plus fresh rotation paper rows.

The consistency check supports the rotation thesis but changes the interpretation:

1. S/A rotators do use repeated same-mint buys, including trend-following top-ups.
2. First sell is usually not a small noise event. It often de-risks most of the position.
3. Sell-after-rebuy exists, but it is rare enough to be a secondary signal rather than the main exit rule.
4. Rotation should use `count + size + order`, not count-only KOL events.

Representative S/A sell-flow statistics:

| KOL | style | first sell median | first sell <=30s | sellPressure30 median | sellPressure30 >=0.8 |
|---|---|---:|---:|---:|---:|
| `decu` | scalper | 21s | 63.9% | 1.01 | 78.4% |
| `dv` | scalper | 12s | 77.9% | 0.92 | 69.7% |
| `heyitsyolo` | scalper | 21s | 60.8% | 0.95 | 81.2% |
| `theo` | scalper | 24s | 57.8% | 0.97 | 85.5% |
| `chester` | scalper | 13s | 74.3% | 0.91 | 69.6% |
| `jijo` | scalper | 38s | 44.9% | 1.25 | 75.0% |
| `limfork_eth` | scalper | 50s | 36.6% | 0.92 | 71.0% |
| `yenni` | scalper | 257s | 12.1% | 0.89 | 57.2% |

Definitions used for the review:

```text
sellPressure30 = SOL sold by anchor KOLs within 30s after first sell
               / SOL bought by anchor KOLs before that first sell

topupStrength = post-opener top-up SOL / opener SOL

chaseTopup = same-mint pre-first-sell buy sequence where later buy fill price
             is materially above the previous buy fill price
```

Entry implication:

- `rotation_underfill_v1` remains valid: buy only when our quote is below the S/A KOL's actual fill reference and no recent sell exists.
- Add a separate paper-only `rotation_chase_topup_v1` candidate before any live consideration:
  - active S/A KOL only;
  - fresh opener plus top-up inside the short rotation window;
  - follow-up buy fill price is above the prior buy by a cost-aware threshold;
  - `topupStrength` is meaningful, not just dust;
  - `sellPressure30` is still low;
  - max hold remains a short rotation clock, not a runner clock.

Exit implication:

- First anchor sell should be interpreted by pressure, not by count alone.
- Low-pressure sell can be a trim; high-pressure sell is usually a de-risk or exit.
- Rebuy after sell is a rare rescue signal and must not override high sell pressure.
- Top-up before sell is useful for residual hold; sell pressure after entry is useful for residual reduction or full exit.

Initial paper-only exit state machine:

```text
on T1:
  take 30-40% partial profit

while residual is open:
  if structural risk, no route, severe quote impact, or liquidity collapse:
    exit full immediately

  if sellPressure30 >= 1.2:
    exit full and block same-mint reentry

  if sellPressure30 >= 0.8:
    exit full

  if sellPressure30 >= 0.5:
    reduce residual strongly

  if sellPressure30 >= 0.2:
    reduce residual lightly

  if fresh top-up exists, sellPressure30 < 0.5, and quote quality is acceptable:
    keep residual until max 60-90s

  if no top-up and momentum fades:
    close residual
```

Hard-cut implication:

```text
if structural hard cut:
  exit full immediately

if price-only hard cut and sellPressure30 >= 0.8:
  exit full

if price-only hard cut and sellPressure30 < 0.5 and fresh top-up exists:
  cut 70-80%
  keep 20-30% residual for max 60s

if residual does not reclaim or quote quality worsens:
  close residual
```

This is deliberately paper-only. It does not loosen live risk controls, does not
turn rotation into a runner lane, and does not change smart-v3. The purpose is to
test whether KOL inventory-flow improves exit timing versus the current binary
hard-cut / full-close behavior.

## Policy

Rotation v1 triggers during the existing smart-v3 observe window without consuming smart-v3:

- participating KOL has rotation suitability score >= `KOL_HUNTER_ROTATION_V1_MIN_KOL_SCORE`;
- independent rotation KOL count is at least `KOL_HUNTER_ROTATION_V1_MIN_INDEPENDENT_KOL` (default `1`);
- `KOL_HUNTER_ROTATION_V1_KOL_IDS` (default `dv,decu`) are seed ids that receive a score boost, not a hard allowlist;
- `KOL_HUNTER_ROTATION_V1_EXCLUDE_KOL_IDS` can hard-exclude known bad rotators;
- at least `KOL_HUNTER_ROTATION_V1_MIN_BUY_COUNT` buys in the recent window;
- at least `KOL_HUNTER_ROTATION_V1_MIN_SMALL_BUY_COUNT` top-up sized buys;
- gross buy SOL is at least `KOL_HUNTER_ROTATION_V1_MIN_GROSS_BUY_SOL`;
- last eligible buy age is <= `KOL_HUNTER_ROTATION_V1_MAX_LAST_BUY_AGE_SEC`;
- no same-mint KOL sell in `KOL_HUNTER_ROTATION_V1_MAX_RECENT_SELL_SEC`;
- current price must show at least `KOL_HUNTER_ROTATION_V1_MIN_PRICE_RESPONSE_PCT` response from the rotation anchor price, not just the first smart-v3 observe reference.

Rotation suitability uses existing KOL DB metadata:

- `lane_role=observer` and shadow-only KOLs are ineligible;
- `trading_style=scalper`, `lane_role=discovery_canary`, and high tier increase score;
- seed ids receive a score boost so dv/decu remain measurable even when metadata is incomplete.

No-trade outcomes such as stale last buy, recent sell block, low rotation score, and no price response are emitted to the policy ledger as rotation-specific reject decisions. They do not terminally reject smart-v3.

The lane is deliberately same-token sell sensitive. A recent sell means this is likely post-distribution or chop, so rotation v1 should wait for the next token rather than pay spread and slippage.

### Paper-Only Underfill Arm (2026-05-03)

`rotation_underfill_v1` is a separate paper-only arm for the stricter 1 KOL / 1 buy hypothesis:

- the parent `KOL_HUNTER_ROTATION_V1_ENABLED` switch must be on;
- `KOL_HUNTER_ROTATION_UNDERFILL_PAPER_ENABLED=true`;
- one or more active S/A KOL buys exist within `KOL_HUNTER_ROTATION_UNDERFILL_MAX_LAST_BUY_AGE_SEC`;
- the eligible KOL score is at least `KOL_HUNTER_ROTATION_UNDERFILL_MIN_KOL_SCORE`;
- the KOL buy has an actual fill reference from the incoming `KolTx` (`solAmount / tokenAmount`); no hot-path RPC fallback is used;
- there is no same-mint KOL sell within `KOL_HUNTER_ROTATION_UNDERFILL_MAX_RECENT_SELL_SEC`;
- the current quote is below the KOL weighted fill reference by `KOL_HUNTER_ROTATION_UNDERFILL_MIN_DISCOUNT_PCT` to `KOL_HUNTER_ROTATION_UNDERFILL_MAX_DISCOUNT_PCT`.

This arm does not weaken the main rotation control and never routes to live. Its purpose is to test whether "our fill is better than the S/A KOL's actual fill reference, and the KOL has not sold" has positive short-horizon post-cost expectancy. Too-shallow discount, too-deep discount, missing fill price, stale buy, and recent sell decisions are emitted as underfill no-trade markouts so false negatives are measurable.

Default exits are intentionally faster than `kol_hunter_rotation_v1`:

- T1 MFE `5%`;
- T1 trail `2.5%`;
- profit floor `1.02x`;
- probe timeout `30s`;
- hard cut `4%`;
- DOA window `15s`.

### Implemented Paper-Only Inventory-Flow Arms - 2026-05-03

The 2026-05-03 consistency review introduced two paper-only inventory-flow
arms. They are implemented as measurement arms, not live routing behavior. The
shared flow metrics are built from the existing KOL transaction stream; no extra
RPC call is required on the entry path.

`rotation_chase_topup_v1`:

- tests trend-following S/A top-up entries;
- requires fresh same-mint top-up after opener;
- requires a cost-aware positive buy-to-buy fill-price move;
- rejects if recent `sellPressure30` is elevated;
- uses the same short `15/30/60` primary validation clock as rotation-v1;
- is paper-only by default under
  `KOL_HUNTER_ROTATION_CHASE_TOPUP_PAPER_ENABLED=true`.

`rotation_exit_kol_flow_v1`:

- keeps the same candidate entry as its parent arm;
- changes exit only;
- uses `sellPressure`, `topupStrength`, first-sell timing, and residual state;
- never delays structural exits;
- tests virtual partial reduce plus small residual hold after low/medium pressure
  anchor sell or price-only hard cut;
- reports partial/reduce, final close, hard cut, DOA, and anchor-sell T+
  separately;
- is paper-only by default under
  `KOL_HUNTER_ROTATION_EXIT_FLOW_PAPER_ENABLED=true`.

Promotion rule remains unchanged: these arms must stay out of live until there
are at least 50-100 fresh closes, `okCoverage >= 80%` on the primary
`T+15/T+30` windows, control-beating post-cost net, no loser-loss
deterioration, and positive refund-adjusted net.

### Monetizable-Edge Shadow Gate - 2026-05-03

Deep research review conclusion: rotation is the most cost-sensitive KOL lane,
so arm success must be judged after copyable execution drag, not only raw T+
continuation. Current implementation keeps all new rotation arms paper-only and
adds a shadow estimate to every rotation paper position:

- `rotationMonetizableEdge.schemaVersion = rotation-monetizable-edge/v1`;
- irreversible execution cost = venue bleed model + base/priority fee +
  entry/quick-exit slippage;
- recoverable ATA rent is tracked separately as wallet drag, not as permanent
  strategy loss;
- `costRatio = irreversibleCostSol / ticketSol`;
- `walletDragRatio = (recoverableRentSol + irreversibleCostSol) / ticketSol`;
- default pass threshold `KOL_HUNTER_ROTATION_EDGE_MAX_COST_RATIO=0.06`;
- default mode is observe-only. It does not block paper entries and never routes
  to live;
- paper close ledgers, trade-markout extras, and rotation reports expose
  pass/fail, median cost ratio, wallet-drag ratio, and required gross move.

This is intentionally a validation layer, not a new entry rule. Promotion still
requires positive primary-window post-cost markout, positive refund-adjusted net,
and enough closed samples.

`scripts/rotation-lane-report.ts` now renders an arm-level evidence verdict:

- `COLLECT`: fewer than 50 closed paper samples;
- `DATA_GAP`: at least 50 closes, but any required T+15/T+30 buy
  markout coverage is missing or below `80%`, or `rotationMonetizableEdge`
  coverage is below `80%`;
- `COST_REJECT`: edge shadow pass rate is weak or refund-adjusted net is not
  positive;
- `POST_COST_REJECT`: best primary T+15/T+30 median post-cost markout is not
  positive or does not beat the control arm;
- `WATCH`: 50-99 closes with positive evidence, or an experimental arm has no
  control T+15/T+30 baseline yet;
- `PROMOTION_CANDIDATE`: at least 100 closes with markout coverage, cost,
  refund-adjusted net, primary-window post-cost, and control-beating primary
  checks all passing.

The verdict is report-only. It cannot enable live routing and it does not block
paper entries.

2026-05-05 mission-aligned update:

- Reports now show both `refund-adjusted SOL` and `wallet-drag stress SOL`.
- `refund-adjusted SOL` treats ATA rent as recoverable and subtracts only the
  configured irreversible network fee from token-only PnL.
- `wallet-drag stress SOL` keeps the old conservative view of token-only PnL
  minus ATA rent and network fee. It is still useful for wallet floor / capital
  lock analysis, but it is not the promotion blocker by itself.
- `Winner Entry Pairing` splits `winner_trailing_t1` from all other exits by
  entry arm. This prevents treating `winner_trailing_t1` as an entry signal and
  instead measures which entry arms most reliably reach the T1 trailing state.
- `Winner Entry Diagnostics` splits the same winner/non-winner buckets by
  `topupStrength`, `sellPressure30`, anchor buy size, fresh top-up rate,
  high-risk flag rate, and unknown-quality flag rate. This is report-only and
  exists to find candidate entry refinements without changing live behavior.
- 2026-05-05 follow-up: the evidence verdict now treats T+15/T+30 as the
  fast-compound primary window and T+60 as decay warning. A negative T+60 no
  longer rejects an otherwise positive fast arm; it tells the operator that the
  lane should harvest earlier rather than behave like a runner lane.
- 2026-05-05 review fix: promotion now requires both primary windows to stay
  positive after cost. An arm with positive T+15 but negative T+30 is a
  `POST_COST_REJECT` until a future ADR defines an explicit one-horizon capture
  arm. The report renders T+15 and T+30 side by side instead of hiding behind a
  single best-horizon value.
- 2026-05-05 review fix: legacy `rotationMonetizableEdge.requiredGrossMovePct`
  rows that included recoverable ATA rent are normalized to copyable
  irreversible cost in `required gross move`; wallet-drag remains visible in its
  own column.

### KOL Transfer Posterior Coverage - 2026-05-05

The Helius transfer posterior is diagnostic-only. It can help explain whether a
KOL behaves more like a short-rotation wallet or a support/runner wallet, but it
must not become a live allowlist or blocklist without a separate evidence review.

The posterior report now loads the active KOL DB and classifies every active
address as:

- `ok`: this KOL/address has posterior rows inside the report window;
- `stale`: historical posterior rows exist, but none are fresh for the report
  window;
- `missing`: no posterior rows are present in the local cache.

Rotation reports surface the same coverage table before showing rotation-fit
scores. This prevents stale posterior data from being misread as a bad KOL
signal. A stale/missing posterior is a data quality finding, not a trading
decision. Promotion still requires fresh arm-level paper closes, T+15/T+30
`okCoverage`, refund-adjusted post-cost net, and control-beating evidence.

Coverage matching is address-first, so KOL id alias changes do not create false
`missing` rows. If the active KOL DB cannot be loaded, the report states
`load_failed` instead of rendering an empty active target set.

## Exit Shape

Rotation v1 uses the common KOL Hunter state machine with lane-specific overrides:

- `kolEntryReason=rotation_v1`
- `armName=kol_hunter_rotation_v1`
- lower T1 MFE threshold than smart-v3;
- tighter T1 trail;
- modest profit floor;
- shorter probe flat timeout.
- dead-on-arrival exit when early MFE is weak and MAE breaches the rotation threshold;
- fresh anchor top-up inside the grace window can defer dead-on-arrival once;
- `rotation_mae_fast_fail` after the DOA window for weak-MFE probes that drift below the MAE threshold before hard cut;
- anchor rotator sell overrides style-aware sell relaxation and exits full.

It still uses structural stop, post-distribution guard, live canary gate, wallet stop, entry halt, and sell-route checks. Real Asset Guard values are unchanged.

Paper and live observability must carry the same rotation dimensions:

- `rotationAnchorKols`
- `rotationAnchorPrice`
- `rotationFirstBuyAtMs`
- `rotationLastBuyAtMs`
- `rotationLastBuyAgeMs`
- `rotationScore`
- `rotationMaeFastFail`

These fields are propagated to paper close rows, live buy/sell fallback ledger rows, and T+ markout extras.

2026-05-06 MAE fast-fail update:

- Default config is observable and reversible via `KOL_HUNTER_ROTATION_MAE_FAST_FAIL_ENABLED`.
- Default thresholds: min elapsed `5s`, max MAE `-3%`, max MFE `+1.5%`.
- The check runs after `rotation_dead_on_arrival` and before the wider probe hard cut. It is meant to reduce late failed probes, not to replace structural stops or winner trailing.
- Reports split `After Sell - MAE Fast-Fail Cohort` from the broader hard-cut cohort so the policy can be reviewed before further live expansion.

Rotation v1 uses a shorter validation clock than the 5x lane:

- trade entry/exit markouts add `KOL_HUNTER_ROTATION_V1_MARKOUT_OFFSETS_SEC` (default `15,30,60`) on top of the global trade markout horizons;
- rotation no-trade decisions are tracked in `missed-alpha.jsonl` with the same `15,30,60` horizons;
- `15s` checks immediate continuation, `30s` checks DOA/failure classification, and `60s` checks short continuation;
- `300s/1800s` remain global tail/winner-kill horizons rather than primary rotation policy horizons.
- `scripts/rotation-lane-report.ts` reports raw `deltaPct` and `postCostDelta = deltaPct - roundTripCostPct`
  (default round-trip cost assumption `0.005`, override with `--round-trip-cost-pct`).
- `scripts/rotation-lane-report.ts` also joins `token-quality-observations.jsonl` and the paper-only
  dev candidate file to report T+60 `postCostDelta` by dev bucket. This is report-only. Dev candidate
  labels are not entry triggers, not live allowlists, and do not bypass security / sell quote / drift gates.

### Ledger Projection Update (2026-05-03)

Rotation no longer needs to be discovered only by filtering `kol-paper-trades.jsonl`.

The writer now keeps the legacy aggregate ledger and adds lane projections:

```text
data/realtime/kol-paper-trades.jsonl          # compatibility aggregate
data/realtime/kol-live-trades.jsonl           # compatibility aggregate
data/realtime/rotation-v1-paper-trades.jsonl  # rotation projection
data/realtime/rotation-v1-live-trades.jsonl   # rotation projection
```

Projection writes are fail-open and never replace the aggregate ledger writes.

Rotation reporting behavior:

- `src/orchestration/rotationPaperDigest.ts` reads `rotation-v1-paper-trades.jsonl` first;
- `scripts/rotation-lane-report.ts` defaults to `rotation-v1-paper-trades.jsonl`;
- both paths fall back to `kol-paper-trades.jsonl` when the projection file is empty;
- shared markout files stay unchanged and are filtered by `armName`, `entryReason`, `mode`, and rotation extras.

This keeps historical reports working while making daily rotation paper review much simpler.

## Rollout

1. Paper: enable `KOL_HUNTER_ROTATION_V1_ENABLED=true`, leave live disabled when a paper-only shakeout is desired.
2. Live canary: enable both `KOL_HUNTER_ROTATION_V1_ENABLED=true` and `KOL_HUNTER_ROTATION_V1_LIVE_ENABLED=true`. Existing canary gates still apply, but rotation uses its own `KOL_HUNTER_ROTATION_V1_MIN_INDEPENDENT_KOL=1` instead of weakening the global smart-v3 live min-KOL gate.
3. Measure by `armName/kolEntryReason`:
   - closed netSol and token-only netPct;
   - median hold;
   - hard-cut rate;
   - post-exit T+ markout;
   - no-trade T+15/30/60 false-negative rate;
   - 5x missed-after-exit rate.
   - dev bucket T+60 postCostDelta from token-quality attribution.
4. Same-mint live overlap falls back to paper; this preserves observability while preventing double live exposure.

## Non-goals

- Do not increase KOL ticket size.
- Do not relax `KOL_HUNTER_LIVE_MIN_INDEPENDENT_KOL` by default.
- Do not merge this behavior into smart-v3 until DSR/PBO and live-paper drift are reviewed.
- Do not use paper-only dev candidates as a live allowlist or standalone entry trigger.
