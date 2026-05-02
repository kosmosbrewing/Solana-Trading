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
- anchor rotator sell overrides style-aware sell relaxation and exits full.

It still uses structural stop, post-distribution guard, live canary gate, wallet stop, entry halt, and sell-route checks. Real Asset Guard values are unchanged.

Paper and live observability must carry the same rotation dimensions:

- `rotationAnchorKols`
- `rotationAnchorPrice`
- `rotationFirstBuyAtMs`
- `rotationLastBuyAtMs`
- `rotationLastBuyAgeMs`
- `rotationScore`

These fields are propagated to paper close rows, live buy/sell fallback ledger rows, and T+ markout extras.

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
