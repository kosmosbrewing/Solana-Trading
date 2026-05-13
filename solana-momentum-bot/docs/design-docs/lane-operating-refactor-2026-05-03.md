# Lane Operating And Ledger Refactor — smart-v3 / rotation-v1 / pure_ws / capitulation rebound

> Date: 2026-05-03
> Status: implemented for measurement/refactor layer
> Authority: `MISSION_CONTROL.md` -> `docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md` -> this document
> Scope: `kol_hunter_smart_v3`, `kol_hunter_rotation_v1`, `pure_ws botflow`, `kol_hunter_capitulation_rebound_v1`

## 0. Decision

The three active strategy surfaces now have separate operating roles:

| Strategy surface | Role | Live stance | Paper / observation stance |
|---|---|---|---|
| `kol_hunter_smart_v3` | Main 5x lane | Live canary is arm-based: `smart_v3_clean` for strict-quality entries, optional `smart_v3_quality_unknown_micro` for unknown-only quality fallbacks, and optional `smart_v3_fast_canary_v1` for rotation-like relaxed testing of unknown/medium holder-risk candidates. These labels keep the same live canary ticket for cost comparability | Paper fallback for pullback, weak recovery, dev risk, hard quality risk, prior sell risk, bad combo, halt, or guard fallback |
| `kol_hunter_rotation_v1` | Fast-compound KOL auxiliary lane | Keep canonical live disabled unless explicitly listed; promoted profiles are selected through `KOL_HUNTER_LIVE_CANARY_ARMS` | Paper control plus parallel parameter arms, underfill arm, chase-topup paper, and entry-vs-KOL-fill canary evidence |
| `kol_hunter_capitulation_rebound_v1` / `kol_hunter_capitulation_rebound_rr_v1` | Liquidity-shock rebound experiment | Live prohibited | Strict baseline keeps recent sell-wave veto; RR sidecar allows pre-low sell but requires clean post-low/post-bounce flow and favorable stop/target RR |
| `pure_ws botflow` | New-pair / botflow rebuild candidate | Live off | Paper/observe-only with T+ markouts, digest, and parameter arms |

The refactor keeps the old aggregate KOL ledgers for compatibility, but adds lane-level projection files for analysis.

Live canary is not a single strategy anymore. `KOL_HUNTER_LIVE_CANARY_ENABLED`
only opens the runtime; `KOL_HUNTER_LIVE_CANARY_ARMS` selects which arm may spend
real canary budget. Empty arm list keeps legacy env flags working. A non-empty
arm list is authoritative and blocks every unlisted arm.

## 1. Mission Fit

`smart-v3` remains the only current lane whose payoff shape is directly aligned with 5x+ winner discovery. It should not be weakened into a fast scalper.

`rotation-v1` is deliberately not a runner lane. Its target is short continuation after known KOL flow. The primary validation horizons are T+15 and T+30, measured after realistic cost.

`capitulation_rebound_v1` is not a smart-v3 extension. It tests whether KOL attention plus a severe but non-structural liquidity shock produces executable T+15/T+30 rebound after cost. `capitulation_rebound_rr_v1` is the 2026-05-11 sidecar variant: KOL sell before the local low is measured as pressure, not a full veto, while KOL sell after the low/bounce still blocks. Both must stay paper-only until no-trade counterfactuals and closed paper rows show stable positive post-cost evidence.

`pure_ws botflow` is not a Mayhem clone. It observes fresh-pair and botflow microstructure. It can become a future micro-compound lane only if paper outcomes are positive after cost and context coverage is high.

## 2. smart-v3 Current Policy

Implemented operating shape:

- live eligibility is based on fresh same-mint active KOL context, not stale 24h aggregate count;
- fresh 2+ active KOLs are required for default live velocity entry;
- A+A fresh consensus is allowed at the default smart-v3 velocity score threshold `5.0`;
- inactive/shadow KOLs are auxiliary confirmation only and cannot create live eligibility;
- pure pullback, weak post-sell recovery, strict-quality miss, pre-entry sell risk, combo decay, adverse KOL-fill price, dev-wallet block, `LIVE_MIN_KOL`, and `YELLOW_ZONE_MIN_KOL` are strategy gates under live canary. They emit `SMART_V3_STRATEGY_NO_PAPER_FALLBACK`, live-equivalence `paperWouldEnter=false`, and no-trade/reject markout instead of creating a main smart-v3 paper fallback row;
- paper-only operation still measures smart-v3 candidates as paper, but live-canary mode no longer lets strategy rejects inflate aggregate paper close performance;
- live strict quality is fail-closed by default: `EXIT_LIQUIDITY_UNKNOWN`, `TOKEN_QUALITY_UNKNOWN`, `UNCLEAN_TOKEN*`, holder-risk, no-route, and rug-like flags block live unless an explicitly selected smart-v3 live canary arm routes the exact quality bucket to live;
- `smart_v3_fast_canary_v1` is an explicit live-canary arm for reducing paper/live divergence. It may route `EXIT_LIQUIDITY_UNKNOWN`, `TOKEN_QUALITY_UNKNOWN`, medium `UNCLEAN_TOKEN:top10_*`, and moderate holder-risk (`HOLDER_TOP1_HIGH` / `HOLDER_TOP5_HIGH` / `HOLDER_HHI_HIGH`) fallbacks to live, matching the rotation-underfill philosophy more closely. It still blocks `HOLDER_TOP10_HIGH`, explicit high-concentration, non-top10 unclean reasons, no-route/rug-like conditions, pre-entry sell risk, combo decay, wallet/halt guards, and `SMART_V3_ENTRY_ADVANTAGE_ADVERSE`;
- `smart_v3_fast_fail_live_v1` is a more progressive explicit live-canary arm for reproducing paper-like smart-v3 candidates under the same KOL ticket/floor/cap. It may route live-disabled, pullback-disabled, weak post-sell recovery, pre-entry sell-window, moderate quality fallback, and bounded KOL-fill adverse candidates to live for canary measurement. It still blocks no-route/rug-like conditions, explicit high concentration, `HOLDER_TOP10_HIGH`, top10 concentration above `KOL_HUNTER_SMART_V3_FAST_FAIL_LIVE_MAX_TOP10_HOLDER_PCT` and survival max, repeated losing combos, and KOL-fill adverse above `KOL_HUNTER_SMART_V3_FAST_FAIL_LIVE_MAX_ADVERSE_KOL_FILL_PCT`;
- any pre-entry same-mint KOL sell requires enough fresh independent re-buy plus a no-sell window before live; otherwise it is a strategy reject via `SMART_V3_PRE_ENTRY_SELL_LIVE_DISABLED` or `SMART_V3_RECENT_SELL_NO_SELL_WINDOW`;
- repeated losing smart-v3 KOL combinations are tracked in-memory and temporarily rejected via `SMART_V3_COMBO_DECAY`; the combo key is fixed from entry-time fresh KOLs, primary paper and live closes both feed the memory, live losses are weighted as stronger evidence, and shadow arms are excluded;
- if fresh KOL fill-price data exists and our quote is materially above the KOL weighted entry, live is rejected via `SMART_V3_ENTRY_ADVANTAGE_ADVERSE`;
- dev wallet blacklist/watchlist status is a strategy live block, while allowlist is telemetry only;
- unknown dev status remains fail-open and does not bypass survival, sell-route, drift, halt, or canary guards.
- MAE fast-fail is default-on for smart-v3 probe positions: if pre-T1 MFE stays below `+3%`, token-only MAE reaches `-6%`, minimum elapsed is met, and no participating KOL has freshly topped up, the position closes as `smart_v3_mae_fast_fail`;
- pre-T1 MFE recovery hold is default-on: if smart-v3 has reached at least `+10%` MFE, token-only MAE has not exceeded `-18%`, and no participating KOL has sold after entry, the first hard-cut event receives a short one-time hold window instead of immediate close;
- MFE winner preservation is default-on: once smart-v3 reaches `+10%/+20%/+50%/+100%` MFE, it enters `breakeven_watch` / `profit_lock` / `runner` / `convexity` and raises the stop to `+0.5%/+2%/+10%/+20%` token-only floor;
- floor breach is an exit trigger (`smart_v3_mfe_floor_exit`), not a close blocker. Structural/liquidity/insider exits remain highest priority. The goal is not to inflate win-rate; it is to stop proven MFE candidates from being closed as losses before the 5x payoff has time to express;
- pre-T1 MFE giveback remains measured: close rows record `smartV3PreT1MfeBand`, close pct, giveback pct, breakeven-lock diagnostic flags, MFE stage, profit floor, and floor-exit counters.

Required analysis before scaling:

- split `probe_hard_cut` by pre-entry quality, KOL style, dev status, and post-close continuation;
- audit top post-close continuation cases before relaxing exits;
- separate signal quality loss, execution loss, and exit loss in reports;
- preserve token-only and wallet-delta metrics separately because ATA rent can hide token-only 5x.

Implemented diagnostic transfer from rotation/deep-research work:

- `scripts/smart-v3-evidence-report.ts` reads `smart-v3-paper-trades.jsonl`, `smart-v3-live-trades.jsonl`, and shared `trade-markouts.jsonl`;
- the report emits cohort verdicts: `COLLECT`, `DATA_GAP`, `COST_REJECT`, `POST_COST_REJECT`, `WATCH`, `PROMOTION_CANDIDATE`;
- smart-v3 evidence uses 30/60/300/1800 second buy/sell T+ coverage, not rotation's 15/30 second fast-harvest objective;
- smart-v3 evidence verdict coverage is close-anchor based: each cohort close `positionId` must have ok buy/sell markouts for the required horizon; raw row ok-rate is shown separately and does not promote a cohort;
- smart-v3 close ledgers now carry `smartV3CopyableEdge` shadow fields so copyable result can use actual per-close drag when available;
- smart-v3 close ledgers also carry `smartV3EntryComboKey`, so later reinforcement KOLs do not rewrite the entry combo used for posterior-lite decay;
- smart-v3 closed-trade W/L is copyable/wallet-first, with token-only W/L shown separately because token-only wins can still be non-copyable after wallet drag;
- smart-v3 closed-trade cohorts show MAE fast-fail, recovery-hold, MFE floor-exit counts, stage counts (`>=20`, `>=50`, `>=100`), and pre-T1 MFE band counts (`10-20`, `20-30`, `30-50`) as diagnostics;
- smart-v3 evidence now summarizes live-equivalence/no-trade rows that would not have entered live, including top `smartV3LiveBlockReason` and `smartV3LiveBlockFlags`, so strict gates can be audited against false-negative T+ markouts without mixing those rows into main paper PnL;
- live smart-v3 buy/sell markout anchors carry `mode`, `armName`, `parameterVersion`, and `entryReason` to avoid paper/live or pullback/velocity cohort bleed;
- the report adds no runtime strategy env; `SKIP_SMART_V3_EVIDENCE_REPORT` and `SMART_V3_EVIDENCE_ROUND_TRIP_COST_PCT` are sync/report-only shell knobs;
- verdicts are report-only and must not change live eligibility, hard-cut, trail, or ticket sizing without a separate ADR.

## 3. rotation-v1 Current Policy

Implemented operating shape:

- `KOL_HUNTER_ROTATION_V1_ENABLED=true` can run measurement while live remains off;
- `KOL_HUNTER_ROTATION_V1_LIVE_ENABLED=false` is the safe default while evidence is negative;
- primary rotation control uses opener plus top-up behavior, recent-sell avoidance, and price response;
- rotation paper parameter arms run in parallel:
  - `rotation_fast15_v1`;
  - `rotation_cost_guard_v1`;
  - `rotation_quality_strict_v1`;
- `rotation_underfill_v1` tests the S/A 1 KOL / 1 buy discounted-entry hypothesis as paper-only;
- `rotation_underfill_exit_flow_v1` is the promoted comparison profile: `entryArm=rotation_underfill_v1`, `exitArm=rotation_exit_kol_flow_v1`, and `profileArm=rotation_underfill_exit_flow_v1`;
- underfill uses the incoming `KolTx` fill reference (`solAmount / tokenAmount`) and does not add a hot-path RPC call;
- underfill rejects such as missing fill price, too-shallow discount, too-deep discount, stale buy, and recent sell are recorded as no-trade markouts;
- when promoted to live canary, the underfill + exit-flow profile keeps its own 1-KOL minimum even in yellow-zone; the 0.7 SOL wallet floor remains the hard stop, while 0.70-0.85 SOL is an arm-aware quality zone;
- live underfill does not inherit smart-v3 tail-retain; rotation is a fast-compound lane, so price-kill closes sell the rotation position rather than retaining a runner tail;
- live underfill blocks executor spend on unknown/no sell-route evidence (`EXIT_LIQUIDITY_UNKNOWN`, `NO_SELL_ROUTE`, `SELL_NO_ROUTE`, `NO_ROUTE`) and keeps the candidate as paper fallback/equivalence evidence;
- live underfill has a short-memory KOL decay guard: consecutive recent live rotation losses by the same anchor KOL temporarily move that KOL's next underfill signal to paper-only (`ROTATION_LIVE_KOL_DECAY`). The state hydrates on startup from `rotation-v1-live-trades.jsonl` plus the compatibility `kol-live-trades.jsonl`, deduped by `positionId`, with tail child rows excluded;
- fast-fail defaults are tightened for short-horizon capture: underfill DOA defaults to `10s` / `-2% MAE`, and rotation MAE fast-fail defaults to `3s` / `-2% MAE` with weak MFE;
- rotation paper visibility uses a low-noise 15-minute Telegram digest and rare MFE alerts.

Primary validation:

```text
T+15 post-cost
T+30 post-cost
arm-level net SOL
rent/network-fee stress
no-trade false-negative rate
same-mint sell/rebuy damage
```

Rotation must not inherit smart-v3 runner logic. It should fail fast, capture small winners, and avoid becoming a fee-churn lane.

## 4. capitulation-rebound V1 Current Policy

Implemented operating shape:

- `KOL_HUNTER_CAPITULATION_REBOUND_ENABLED=true` arms only the paper experiment;
- `KOL_HUNTER_CAPITULATION_REBOUND_RR_ENABLED=true` arms the RR paper sidecar; default is off;
- `KOL_HUNTER_CAPITULATION_REBOUND_PAPER_ENABLED=true` is required and there is no live path;
- the trigger is evaluated after smart-v3, rotation, underfill, and chase-topup arbitration so it does not steal existing lane entries;
- the RR sidecar is evaluated independently as paper-only and does not consume or block smart-v3/rotation entries;
- hard-veto flags include no sell route, exit liquidity unknown, missing/unsafe security, unclean token, holder concentration, rug-like and dangerous Token-2022 signals;
- entry requires KOL attention, bounded drawdown, bounce from local low, recovery confirmations, no recent KOL sell wave, and the existing size-aware sell quote check;
- RR entry replaces the recent-sell-wave veto with clean post-low/post-bounce sell-flow plus `minRR` validation;
- exits are short monetization rules: no-reaction, no-post-cost, and hard-cut. Runner/tail-retain logic is intentionally not inherited;
- projection ledger: `data/realtime/capitulation-rebound-paper-trades.jsonl`;
- markout horizons: `15,30,60,180,300,1800`;
- report: `reports/capitulation-rebound-YYYY-MM-DD.md/json` via `npm run kol:capitulation-report`;
- live promotion requires a separate ADR after at least 100 paper closes, adequate ok coverage, and positive T+15/T+30 post-cost evidence.

## 5. pure_ws Botflow Current Policy

Implemented operating shape:

- pure_ws botflow is paper/observe-only;
- it is not Mayhem-following and must keep Mayhem mode, Mayhem agent flow, and generic botflow as separate cohort axes;
- paper buy/sell anchors feed the shared trade markout observer;
- default pure_ws paper markout horizons are `15,30,60,180,300,1800`;
- 15-minute digest is the default notification mode;
- per-open/per-close Telegram spam is off by default;
- two paper-only parameter arms exist:
  - `pure_ws_cost_guard_v1`;
  - `pure_ws_confirm60_v1`;
- V2 cold-start handling treats zero-baseline new pairs as candidates when absolute recent activity is sufficient;
- paper-only observation may tag `paperOnlyReason` for cases live would not enter, including `security_data_unavailable_observe` and `entry_drift_quote_repriced`.

Promotion from observe-only requires:

```text
entry price resolved
pair age/context known
T+15/T+30/T+60 okCoverage >= 80%
positive post-cost result in at least one paper arm
no same-pair concentration dominating results
no Mayhem provenance ambiguity driving the cohort
```

## 6. Ledger Refactor

The aggregate ledgers remain the compatibility source:

```text
data/realtime/kol-paper-trades.jsonl
data/realtime/kol-live-trades.jsonl
```

Lane-level projection ledgers are added for operator analysis:

```text
data/realtime/smart-v3-paper-trades.jsonl
data/realtime/smart-v3-live-trades.jsonl
data/realtime/rotation-v1-paper-trades.jsonl
data/realtime/rotation-v1-live-trades.jsonl
data/realtime/capitulation-rebound-paper-trades.jsonl
data/realtime/pure-ws-paper-trades.jsonl
data/realtime/pure-ws-live-trades.jsonl
```

Implementation rules:

- aggregate KOL ledgers are still written first;
- smart-v3, rotation, and capitulation projection writes are dual-write projections;
- projection write failure is fail-open and must not block trade close or existing ledger append;
- rotation digest and rotation report prefer `rotation-v1-paper-trades.jsonl`;
- when projection files are empty, rotation tools fall back to `kol-paper-trades.jsonl` for backward compatibility;
- `sync-vps-data.sh` reports projection file freshness, row counts, and recent 24h W/L/net/last-trade summaries in sync health.

## 7. Markout Policy

Markout ledgers remain shared:

```text
data/realtime/trade-markout-anchors.jsonl
data/realtime/trade-markouts.jsonl
```

Do not split markout files by lane. Splitting markouts would increase dedupe, retry, and coverage complexity. Instead, every anchor/markout row must carry lane context in extras:

```text
mode
armName
parameterVersion
entryReason
paperOnlyReason when applicable
rotationAnchorKols / rotationScore when applicable
capitulation telemetry when applicable
```

Lane-specific reports should filter shared markouts by these fields.

## 8. Operating Reports

Daily sync should treat these as the primary operating artifacts:

| Report | Purpose |
|---|---|
| `reports/kol-live-canary-YYYY-MM-DD.md` | wallet-truth and smart-v3 live health |
| `reports/smart-v3-evidence-YYYY-MM-DD.md` | smart-v3 paper/live cohort verdicts using projection ledgers plus shared T+ |
| `reports/trade-markout-YYYY-MM-DD.md` | shared buy/sell T+ coverage |
| `reports/rotation-lane-YYYY-MM-DD.md` | rotation control, arms, no-trade markouts, post-cost T+ |
| `reports/capitulation-rebound-YYYY-MM-DD.md` | paper-only rebound closes, no-trade counterfactuals, and post-cost T+ |
| `reports/pure-ws-trade-markout-YYYY-MM-DD.md` | pure_ws paper T+ coverage and post-cost behavior |
| `reports/token-quality-YYYY-MM-DD.md` | dev/token quality joins |
| `reports/sync-health-YYYY-MM-DD.md` | artifact freshness, row counts, and lane trade ledger summary |

Promotion decisions should not rely on raw win rate alone. Use post-cost markouts, wallet truth, and lane-specific objectives.

## 9. Remaining Refactor Debt

High-value refactor targets:

1. Split `kolSignalHandler.ts` into smart-v3 policy, rotation policy, live gate, paper arms, and shared entry orchestration.
2. Add shared token-risk snapshot provider with in-flight dedupe for security and exit-liquidity calls.
3. Always evaluate rotation/underfill shadow metrics even when smart-v3 wins the live arbitration.
4. Separate pure_ws digest/report views into `all paper` and `live-eligible paper only`.
5. Move capitulation rebound policy orchestration out of `kolSignalHandler.ts` once the paper shape stabilizes.
6. Replace full JSONL scans in digest paths with cursor/offset incremental reads once file sizes grow.

## 10. Non-Goals

- Do not relax Real Asset Guard.
- Do not merge rotation into smart-v3.
- Do not merge capitulation rebound into smart-v3 or rotation until paper evidence proves a stable cohort.
- Do not activate pure_ws live from Mayhem or botflow context alone.
- Do not treat dev allowlist as an entry bypass.
- Do not split shared markout ledgers unless dedupe/retry semantics are redesigned.
