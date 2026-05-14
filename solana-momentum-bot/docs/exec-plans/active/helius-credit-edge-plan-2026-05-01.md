# Helius Credit-to-Edge Implementation Plan (2026-05-01)

> Status: active implementation plan
> Owner: operator + Codex
> Scope: KOL Hunter data / execution / validation layer
> Authority: `MISSION_CONTROL.md`, `SESSION_START.md`, `docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`
> Related: `docs/exec-plans/active/kol-bigloss-roadmap-2026-04-29.md`, `docs/design-docs/research-ledger-unification-2026-05-01.md`, `docs/design-docs/decu-new-pair-quality-layer-2026-05-01.md`

## 0. Decision

Helius credits should be used more deliberately. Budget pressure is **not** the active issue — there is headroom — but Real Asset Guard and Mission §3 evidence priority are.

Current user-observed usage (operator dashboard, 2026-05-01):

```text
Plan:               Developer ($49)
Cycle:              2026-04-24 — 2026-05-23 (anniversary, not calendar)
Cap:                10,000,000 credits / cycle
Used after ~1 week:    1,312,214  (13.1%)
Remaining:             8,687,786
Days remaining:               22
Current burn rate:  ~187,000 credits/day  (= 1.31M / 7d)
Daily cap allowed:  ~395,000 credits/day  (= 8.69M / 22d)
Headroom over current burn:  +110%
```

Reset date is **plan-anniversary based** (next reset: 2026-05-23), confirmed by operator billing page. Therefore offline backfill / measurement work has substantial headroom this cycle. The constraint on hot-path expansion remains Real Asset Guard, not credit budget.

The correct implementation stance:

```text
More Helius calls in live hot path:        no
More live tickets because credits exist:   no
More KOL/quality/markout measurement:      yes
More observe-only rejection evidence:      yes
More post-exit/post-reject replay truth:   yes
```

## 1. Quality Check Of The Prior Analysis

### 1.1 Accepted conclusions

| Prior conclusion | Verdict | Reason |
|---|---:|---|
| Helius should not become a blind discovery expander | accepted | Option 5 was adopted because Helius-only discovery was biased toward dead-liquidity pools. |
| Best first use is token quality / exitability | accepted | `NO_SECURITY_DATA` is a strong negative cohort and `getExitLiquidity()` currently returns null. |
| KOL tx enrichment is high leverage | accepted | `KolTx` loses slot/pool/dex/route context even though the tracker receives slot context. |
| Markout backfill is needed for 5x mission truth | accepted | The mission needs true MFE/MAE and post-exit missed-alpha, not only close PnL. |
| Priority fee telemetry matters | accepted | Execution quality is part of alpha in `MISSION_CONTROL.md`; current code records latency but not fee percentile/context. |

### 1.2 Corrections

| Issue | Correction |
|---|---|
| "Unused credits are waste" | Initial framing inverted the dashboard reading: 13.1% used in one week (not 86.9%) on a plan-anniversary cycle (Apr 24 – May 23). Headroom exists; constraint is Real Asset Guard + Mission §3 evidence priority, not credit pressure. |
| `getParsedTransaction = 100 credits` assumption | Helius docs list historical `getTransaction` at 1 credit; Enhanced Transactions parsing is 100 credits. Existing estimators must distinguish Standard RPC vs Enhanced API. |
| WebSocket cost assumption | Standard WebSockets are metered at 2 credits / 0.1 MB after the May 1, 2026 activation. Subscription breadth now has a direct credit cost. |
| "Use Helius to replace Jupiter" | Rejected. Helius does not replace Jupiter quote/route/execution. Helius should enrich context around route quality and replay truth. |

### 1.3 Confidence

| Area | Confidence | Notes |
|---|---:|---|
| Token quality / holder / exitability enrichment | high | Existing code already has security gate, holder helper, token quality ledger, and a known null exit-liquidity gap. |
| KOL transaction enrichment | high | Low behavior risk; mostly schema/logging addition. |
| Markout backfill | high | Directly answers 5x capture and missed-after-exit questions. |
| Priority fee telemetry | medium | Easy to observe; live execution policy changes require canary evidence. |
| Webhooks replacing current WS | low for now | May improve reliability, but current active issue is data value per credit, not delivery mechanism. |

## 2. Non-Negotiable Constraints

This plan must not relax Real Asset Guard:

- Wallet floor remains 0.6 SOL.
- KOL live ticket remains fixed by current guard policy.
- Max concurrent remains 3.
- Drift halt and wallet comparator remain active.
- NO_SECURITY_DATA / security hard rejects are not weakened.
- New live hard gates require observe-only evidence first unless they only reduce risk with no entry expansion.

This plan also must not revive pre-pivot Helius-only discovery as the main paradigm.

## 3. Official Helius Cost / Limit Facts Used

Source: Helius docs checked on 2026-05-01.

| Item | Cost / limit | Implementation implication |
|---|---:|---|
| Developer monthly credits | 10M / month | Treat current usage as monthly budget pressure. |
| Standard RPC calls | 1 credit | Prefer standard RPC for backfill when sufficient. |
| `getProgramAccounts` | 10 credits | Avoid broad program sweeps in hot path. |
| Priority Fee API | 1 credit | Cheap enough for observe-only execution telemetry. |
| DAS API | 10 credits | Use for cached metadata, not every tick. |
| Enhanced Transactions | 100 credits | Reserve for KOL/style/backfill samples, not synchronous entry. |
| `getTransactionsForAddress` | 50 credits | Good for bounded KOL wallet history; requires budget cap. |
| Standard WebSockets | 2 credits / 0.1 MB | Subscription breadth and noisy streams need budget visibility. |
| Sender | 0 credits | Execution feature, not a credit-burn target. |
| Staked connections | 1 credit | Current paid-plan transaction sends still have credit cost. |
| Webhook event | 1 credit | Consider only for stable address/event delivery, not as a first sprint. |
| Developer RPC RPS | 50 req/s | Fine for async jobs with throttling. |
| Developer DAS/Enhanced RPS | 10 req/s | Must queue Enhanced/DAS jobs. |
| Developer WS | 150 connections, 1,000 subscriptions/connection | Current cap is below limit, but metered bytes matter. |

Docs:
- https://www.helius.dev/docs/billing/credits
- https://www.helius.dev/docs/billing/rate-limits
- https://www.helius.dev/docs/priority-fee-api
- https://www.helius.dev/docs/api-reference/rpc/http/gettransactionsforaddress
- https://www.helius.dev/docs/webhooks

## 4. Current Code Anchors

| Area | Current anchor | Gap |
|---|---|---|
| Token security | `src/ingester/onchainSecurity.ts` | `getExitLiquidity()` returns null. |
| Legacy Birdeye exit liquidity | `src/ingester/birdeyeClient.ts` | A Premium+ `getExitLiquidity()` implementation exists, but current `BotContext.onchainSecurityClient` is typed as `OnchainSecurityClient`; call-site wiring must be verified before treating Birdeye as active. |
| Security gate | `src/gate/securityGate.ts` | Exit-liquidity unknown becomes weak evidence because data is missing. |
| Token quality observation | `src/observability/tokenQualityInspector.ts` and `kolSignalHandler.ts` | Observation exists, but holder/dev/risk enrich is mostly empty. |
| Holder calculations | `src/observability/holderDistribution.ts` | Helper exists but not wired into KOL token quality evidence. |
| KOL tx ingest | `src/ingester/kolWalletTracker.ts` | Slot/pool/dex/route/token amount/fee are not preserved in `KolTx`. |
| KOL type schema | `src/kol/types.ts` | `KolTx` has only minimal token/action/signature fields. |
| Pool registry | `src/scanner/heliusPoolRegistry.ts` | Good base for KOL-token prewarm; currently mostly passive. |
| Realtime Helius | `src/realtime/heliusWSIngester.ts` | Good raw swap source; coverage/provenance not unified with research ledger. |
| Historical backfill | `scripts/fetch-historical-swaps.ts` | Credit estimator likely overstates standard historical tx cost by treating all parses as 100 credits. |
| Research ledger | `src/research/*`, `docs/design-docs/research-ledger-unification-2026-05-01.md` | Schema exists, but Helius provenance and runtime dual-write are not fully wired. |
| Execution | `src/executor/executor.ts`, `kolSignalHandler.ts` | Latency exists; priority fee percentile / landing slot delta not yet structured. |

## 5. Target Architecture

```text
KOL wallet tx
  -> KolTx enriched with Helius provenance
  -> token quality observe-only enrich
  -> pool registry prewarm
  -> existing KOL Hunter entry gates
  -> execution telemetry
  -> research ledger event
  -> Helius markout backfill
  -> DSR/PBO/cohort reports
```

Two rules:

1. Helius enrichment may add evidence and rejections, but it must not expand live risk without an ADR.
2. Any expensive Helius call must carry a purpose tag and estimated credit cost.

## 6. Implementation Streams

### Stream A — Credit Budgeter And Cost Catalog

Purpose: make Helius spend visible and prevent hot-path budget leaks.

Files:

- Add `src/observability/heliusCreditCost.ts`
- Add `src/observability/heliusCreditLedger.ts`
- Update `scripts/fetch-historical-swaps.ts`
- Add tests under `test/heliusCreditCost.test.ts` and `test/heliusCreditLedger.test.ts`

Design:

```ts
type HeliusCreditPurpose =
  | 'live_hot_path'
  | 'kol_tx_enrichment'
  | 'token_quality'
  | 'pool_prewarm'
  | 'markout_backfill'
  | 'wallet_style_backfill'
  | 'execution_telemetry'
  | 'ops_check';

interface HeliusCreditUsageRecord {
  schemaVersion: 'helius-credit-usage/v1';
  timestamp: string;
  purpose: HeliusCreditPurpose;
  method: string;
  estimatedCredits: number;
  requestCount: number;
  tokenMint?: string;
  walletAddress?: string;
  txSignature?: string;
  source: 'estimate' | 'dashboard_reconcile';
}
```

Ledger:

```text
data/realtime/helius-credit-usage.jsonl
```

Policy:

- This is a sidecar ops trace ledger, not part of Research Ledger schema v1.
- Do not add a new `kol-call-funnel/v1` eventType for Helius calls in this sprint.
- Add a Research Ledger ADR follow-up note only if credit usage later becomes a cohort dimension.
- Writer must be fail-open: append failure logs and returns a failed result, but never blocks live trading or observation.

Acceptance:

- Cost catalog distinguishes Standard RPC, DAS, Enhanced Transactions, Wallet API, Webhook, WSS estimate, Sender.
- `scripts/fetch-historical-swaps.ts` no longer assumes every parsed historical transaction costs 100 credits.
- Backfill scripts print estimated credits by purpose before execution.
- Credit ledger append failure does not throw.
- No live behavior change.

**2026-05-01 Codex review P2 (executor decomposition 관련, 병합 가능)**:
  - **P2-A1** Lookup-table key resolve (`src/executor/executor.ts:199`): Jupiter v0 versioned tx + address lookup table 사용 시 `message.getAccountKeys()` 가 throw → catch 분기 fallback (`ataRentSol=0`, `swapInputSol=walletInputSol`). **자주 사용되는 live swap path 에서 token-only 측정 inflated 그대로 남음**. fix: `tx.meta.loadedAddresses` 의 lookup keys 를 `getAccountKeys({ accountKeysFromLookups: ... })` 에 supply. follow-up sprint 필요.

### Stream B — Token Quality / Exitability Enrichment

Purpose: convert Helius calls into fewer bad entries and better reject evidence.

Files:

- Update `src/ingester/onchainSecurity.ts`
- Add `src/observability/exitabilityEvidence.ts`
- Update `src/observability/tokenQualityInspector.ts`
- Wire `src/observability/holderDistribution.ts`
- Update `src/orchestration/kolSignalHandler.ts`
- Extend tests in `test/securityGate.test.ts`, `test/kolSignalHandler.test.ts`

Implementation steps:

1. Extend `TokenSecurityData` with `top1HolderPct`, `top5HolderPct`, `holderHhi`, `holderCountApprox`.
2. Compute holder distribution from `getTokenLargestAccounts` using existing helper logic.
3. Replace the current `getExitLiquidity()` null gap with an observe-only exitability evidence layer:
   - `OnchainSecurityClient` remains responsible only for mint / holder / on-chain security data.
   - `exitabilityEvidence` joins existing Jupiter sell quote result, Helius pool registry metadata, and recent raw-swap coverage at orchestration/observability boundaries.
   - Existing `BirdeyeClient.getExitLiquidity()` is treated as optional legacy/Premium+ fallback only after wiring is verified; it is not the primary Helius credit-to-edge path.
   - v1 output: `exitLiquidityUsd=null` allowed, but `sellRouteKnown`, `poolKnown`, `recentSwapCoverage`, and `reason` must be recorded.
   - Do not invent USD liquidity if price/liquidity source is unavailable.
4. Populate token-quality `riskFlags`:
   - `HOLDER_TOP1_HIGH`
   - `HOLDER_TOP5_HIGH`
   - `HOLDER_TOP10_HIGH`
   - `HOLDER_HHI_HIGH`
   - `EXIT_LIQUIDITY_UNKNOWN`
   - `POOL_NOT_PREWARMED`
   - `NO_HELIUS_PROVENANCE`
5. Keep initial output observe-only except existing hard security gates.

Acceptance:

- New token-quality records are not empty for KOL candidates.
- `NO_SECURITY_DATA` and `EXIT_LIQUIDITY_UNKNOWN` cohorts become separable.
- Existing Track 2B hard reject behavior remains unchanged.
- 24h report can show `riskFlags -> mfe<1% / big-loss / 5x` cohort table.

### Stream C — KOL Transaction Enrichment

Purpose: determine whether a KOL signal is copyable, late, routed through toxic pools, or part of false consensus.

Files:

- Update `src/kol/types.ts`
- Update `src/ingester/kolWalletTracker.ts`
- Update KOL tx JSONL writers
- Add/extend tests around tracker parsing

Add optional fields to `KolTx`:

```ts
slot?: number;
blockTime?: number;
poolAddress?: string;
dexId?: string;
dexProgram?: string;
inputMint?: string;
outputMint?: string;
tokenAmount?: number;
feeLamports?: number;
priorityFeeLamports?: number;
parseSource?: 'standard_rpc' | 'enhanced_tx' | 'heuristic';
routeKind?: 'direct_pool' | 'aggregator' | 'unknown';
```

Implementation steps:

1. Preserve `ctx.slot` from wallet log callback.
2. Extract pool/program if present in parsed transaction account/instruction data.
3. Keep current SOL delta heuristic as fallback; label it `parseSource='heuristic'`.
4. Write enriched fields to `kol-tx.jsonl` and `kol-shadow-tx.jsonl`.
5. Add a backward-compatible parser path for old rows.

Acceptance:

- Every new KOL tx has `slot` when WebSocket context provides it.
- At least `parseSource` is populated for every new row.
- No entry decision changes in this stream.

### Stream D — KOL Token Pool Prewarm

Purpose: reduce sparse/no-pair misses when KOL buys a token before normal scanners warm the pool.

Files:

- Update `src/scanner/heliusPoolRegistry.ts`
- Update `src/orchestration/kolSignalHandler.ts`
- Possibly add a small helper under `src/realtime/`
- Extend `runtimeDiagnosticsTracker` reason tags if needed

Implementation steps:

1. On KOL buy, query internal `HeliusPoolRegistry` by token mint.
2. If no pool found, enqueue a bounded Helius standard-RPC lookup/backfill job, tagged `pool_prewarm`.
3. If a pool is found, subscribe/warm only that pool if capacity allows.
4. Record admission context:
   - `poolRegistryHit`
   - `prewarmAttempted`
   - `prewarmSuccess`
   - `prewarmSkipReason`
   - `candidateCohort`
5. Do not hard reject solely because prewarm fails.

Acceptance:

- Sparse/admission summaries can separate `no_pair`, `unsupported_dex`, `parse_miss`, `pool_prewarm_miss`, and `capacity`.
- KOL candidate flow does not silently disappear due to missing pool metadata.

Status (2026-05-01, Codex F5 보정): **helper + tests 완료, runtime wiring 미완.**
  - `checkPoolPrewarm` / `classifyAdmissionReason` 모듈 + jest 통과 ✅
  - `recordTokenQualityObservation` 의 EXIT/POOL flag 발사 (registry inject 시) ✅
  - kolSignalHandler entry path 의 `admission-skips-dex.jsonl` reason tag 통합 — **미완** (별도 sprint)

### Stream E — Helius Markout Backfill

Purpose: answer whether we are cutting winners too early or rejecting future 5x candidates.

Files:

- Add `scripts/kol-helius-markout-backfill.ts`
- Add `src/research/heliusMarkoutTypes.ts` or colocate under `src/research/`
- Extend `researchLedger` schema extras only if compatible with current ADR; otherwise write sidecar JSONL first.

Input:

- `data/realtime/kol-paper-trades.jsonl`
- `data/realtime/kol-live-trades.jsonl`
- `data/realtime/kol-policy-decisions.jsonl`
- `data/realtime/missed-alpha.jsonl`
- historical RPC backfill is the default source
- raw swap files are optional acceleration sources when present, for example replay datasets or `data/realtime-swaps/{pool}/raw-swaps.jsonl`

Output:

```text
data/research/helius-markouts.jsonl
```

Record shape:

```ts
interface HeliusMarkoutRecord {
  schemaVersion: 'helius-markout/v1';
  subjectType: 'entry' | 'close' | 'reject';
  subjectId: string;
  tokenMint: string;
  anchorTsMs: number;
  horizonsSec: number[];
  source: 'raw_swaps' | 'historical_rpc' | 'mixed';
  coveragePct: number;
  parseFailedCount: number;
  trueMfePct?: number;
  trueMaePct?: number;
  peakAtSec?: number;
  troughAtSec?: number;
  reached5xBeforeExit?: boolean;
  reached5xAfterExit?: boolean;
  estimatedCredits: number;
}
```

Acceptance:

- Can produce a 7-day markout report for closes and rejects.
- Separates `5x reached before our exit` from `5x reached after our exit`.
- Includes coverage and parse-failure counts so missing data is not mistaken for no alpha.
- Default source is `historical_rpc`; `raw_swaps` is optional and never assumed to exist under `data/realtime/`.
- Markout report must label coverage `< 70%` as incomplete and must not use incomplete rows as policy evidence.

Status (2026-05-01, Codex F3 + 후속 review 누적): **--rpc-url wiring 완료, 그러나 정책 판단용 품질 부족.**
  - `getSignaturesForAddress(tokenMint, { limit })` 만 사용 — past anchor 까지 pagination 미지원.
  - mint address 기준 — 실제 pool/token account activity 충분히 못 잡음 가능.
  - 거래량 많은 mint / 오래된 anchor 는 coverage 0 가능성 큼.
  - **현재 사용 권고**: 보조 관찰용만. 7-day winner-kill **정책 결정 근거로는 부적합**.
  - **Phase 4 trigger 전 보강 필요**: pool-based / paginated trajectory 수집 (별도 follow-up sprint).
  - Method 별 credit attribution: ✅ 분리 기록 (getSignaturesForAddress / getParsedTransaction 각자 row).

**2026-05-01 Codex review P2 (병합 가능, follow-up 명시 필요)**:
  - **P2-E1** Close anchor schema mismatch (`scripts/kol-helius-markout-backfill.ts:145-146`): 현재 `kol-paper-trades.jsonl` / `kol-live-trades.jsonl` 은 `closedAt` + `holdSec` 만 기록. `entryTimeSec` / `exitTimeSec` 미존재 → `extractCloseAnchors` 가 모든 row 를 skip. **현 운영 데이터에서 close anchor 0건**. fix 옵션: (a) ledger writer 가 `entryTimeSec/exitTimeSec` 추가 emit, (b) backfill script 가 `closedAt - holdSec*1000` 으로 entry 추정. follow-up sprint 필요.
  - **P2-E2** Missed-alpha 의 `rejectedAt` ISO timestamp (`scripts/kol-helius-markout-backfill.ts:177-179`): `missedAlphaObserver` emit 은 `rejectedAt` (ISO) + `probe.firedAt`. 현재 parser 는 numeric `timestamp`/`observedAtMs` 만 → 모든 reject row skip. **rejected KOL false-negative 5x 측정 불가**. fix: `rejectedAt` ISO parse + numeric fallback.
  - **P2-E3** Signature pagination cap (`scripts/kol-helius-markout-backfill.ts:264-267`): `getSignaturesForAddress(limit: cap)` 가 가장 최근 cap 개만 반환 후 anchor window 필터. **거래량 많은 mint / 오래된 anchor → coverage 0**. fix: `before` 인자로 anchor 까지 pagination (또는 block time seek).

### Stream F — Execution Quality / Priority Fee Telemetry

Purpose: distinguish bad signal from non-copyable execution.

Files:

- Add a Helius priority fee client under the existing external-client boundary.
- Extend existing executor/orchestration logging only after confirming dependency direction and existing latency fields.
- Extend research ledger / execution logs with observe-only fields.

Fields:

```ts
priorityFeeEstimateMicroLamports?: number;
priorityFeeLevel?: 'Min' | 'Low' | 'Medium' | 'High' | 'VeryHigh' | 'UnsafeMax';
landingLatencyMs?: number; // already exists on Executor result; reuse rather than duplicate
landingSlotDelta?: number;
accountContentionHint?: string;
executionCopyabilityFlag?: string;
```

Acceptance:

- Each live attempt can show whether failure/loss was due to signal, slippage, fee underpayment, or late landing.
- No automatic priority fee escalation until a canary ADR.

Status (2026-05-01, Codex F5 보정): **helper + tests 완료, runtime wiring 미완.**
  - `getPriorityFeeEstimate` HTTP wrapper + `parsePriorityFeeResponse` + `classifyPriorityFee` ✅
  - `buildExecutionTelemetry` + `classifyCopyability` + `classifyFeeUnderpaid` ✅
  - executor / kolSignalHandler entry path 에서 priority fee 호출 + telemetry record 통합 — **미완** (별도 sprint, S3 dual-write trigger 정합)

### Stream G — KOL Wallet Style Backfill

Purpose: classify KOLs by follower-perspective behavior instead of anecdote.

Files:

- Add `scripts/kol-wallet-style-backfill.ts`
- Reuse `getTransactionsForAddress` only under budget cap.
- Output to `data/research/kol-wallet-style-backfill.jsonl`

Metrics:

- average hold time
- quick sell ratio
- same-token re-entry ratio
- follow-on buy density
- post-buy T+5m / T+30m median
- sell signal reliability
- copyability score

Acceptance:

- Produces role suggestions for `copy_core`, `discovery_canary`, `observer`, `unknown`.
- Does not auto-edit KOL DB.
- Produces a diff-style report for operator review.

## 7. Schedule

### Phase 0 — Budget and schema safety (0.5-1 day)

Deliver:

- Helius credit cost catalog.
- Credit ledger writer.
- Historical swap credit estimator correction.
- Unit tests.

Go condition:

- `npm run check:fast` green.
- No runtime behavior change.

### Phase 1 — Observe-only enrichment (1-2 days)

Deliver:

- Token holder enrichment.
- Exitability provenance fields.
- KOL tx enrichment.
- New report fields.

Go condition:

- 24h live/paper operation produces non-empty token-quality risk flags.
- No Real Asset Guard change.

### Phase 2 — Markout and pool-prewarm measurement (2-3 days)

Deliver:

- KOL token pool prewarm.
- Admission reason breakdown.
- 7-day markout backfill script.

Go condition:

- Report answers:
  - How many rejected tokens later reached 5x?
  - How many closed positions reached 5x after exit?
  - How often did no-pair/sparse hide KOL candidates?

### Phase 3 — Execution copyability (1-2 days)

Deliver:

- Priority fee observe-only telemetry.
- Landing/confirmation context.

Go condition:

- Report separates signal loss from execution loss.
- No automatic fee escalation.
- No duplicate latency field is introduced if `landingLatencyMs` already covers submit-to-confirm timing.

### Phase 4 — Policy candidates (after 7 days data)

Deliver:

- Candidate hard-gate proposal for token-quality flags.
- Candidate KOL role updates.
- Candidate prewarm/pool policy.
- Candidate priority fee canary ADR if telemetry supports it.

Go condition:

- Any live behavior change must show:
  - 5x false-negative impact.
  - Big-loss reduction.
  - Wallet floor effect.
  - Credit cost impact.

## 8. Credit Budget Policy

Cycle (operator dashboard confirmed): **2026-04-24 — 2026-05-23**, plan-anniversary based.

```text
Cap:                 10,000,000
Used (2026-05-01):    1,312,214  (13.1%)
Remaining:            8,687,786
Days remaining:              22
Daily cap allowed:   ~395k/day   (8.69M / 22d)
Recommended cap:     ~300k/day   (보수적, 다음 cycle 정합 + reserve margin)
Current burn:        ~187k/day   (base load: WSS / 기본 RPC / discovery)
```

Therefore:

- No broad historical backfill without explicit one-off budget annotation (purpose tag + estimated credits before run).
- Enhanced transaction calls must be sampled or wallet-scoped.
- WSS subscription expansion must be justified by mission metric.
- Offline jobs should stop when daily cap (300k recommended) is reached.

Phase 0-4 expected burn (one-time):

```text
Phase 0 (Stream A, no live calls):   ~10k     (cycle 의 0.1%)
Phase 1 (Stream B + C, 24h):         ~200k    (cycle 의 2.3%)
Phase 2 (Stream D + E, 7일):         ~1.75M   (cycle 의 20%)
Phase 3 (Stream F, 1-2일):           ~100k    (cycle 의 1.1%)
Phase 4 (Stream G, 1회):             ~200k    (cycle 의 2.3%)
                                     ──────
Total Phase 0-4:                     ~2.26M   (cycle 의 26%)
```

This cycle base load (`187k/d × 22d = 4.1M`) + Phase 0-4 (`2.26M`) = `~6.4M / 8.7M (74%)` — about `2.3M (26%)` 잔여로 cycle 종료. 안전.

Next full cycle target allocation (2026-05-24 — 2026-06-23):

| Purpose | Target share | Notes |
|---|---:|---|
| Token quality / holder / exitability | 30% | Phase 1 핵심, big-loss 차단 |
| Markout / replay / rejected-trade verification | 30% | +5% from baseline — Mission §3 5x evidence (`reached5xBeforeExit/AfterExit/AfterReject`) 직접 측정 |
| KOL wallet style and copyability | 20% | -5% from baseline — weekly 1-2회 backfill 충분; 90d full history sample 도 cover 가능 |
| Pool prewarm / sparse admission analysis | 10% | 유지 |
| Execution telemetry / priority fee sampling | 5% | 유지 (priority fee API = 1c) |
| Reserve | 5% | 유지 — cycle 안 ad-hoc backfill / incident replay margin |

## 9. Metrics

Primary mission metrics:

- Wallet floor breach count.
- Live/paper closed-trade net.
- Big-loss rate (`netPct <= -20%`).
- `mfe < 1%` rate.
- 5x winner count (`mfePctPeak >= 400%`).
- 5x reached after our exit.
- 5x reached after our reject.
- Tail-capture ratio.

Helius-specific metrics:

- Credits by purpose.
- Credits per accepted entry.
- Credits per avoided big-loss candidate.
- Credits per validated reject.
- Parse failure rate.
- Markout coverage percent.
- Pool prewarm hit rate.
- WSS bytes / credit estimate.

Ratio policy:

- If a denominator is zero, report `n/a` and show the numerator/count separately.
- Reports must not emit `NaN`, `Infinity`, or `-Infinity`.

## 10. Test Plan

Minimum verification per stream:

| Stream | Tests |
|---|---|
| A | Cost catalog, credit ledger append, append failure fail-open, historical estimator correction. |
| B | Holder concentration calculation, risk flag emission, existing NO_SECURITY_DATA behavior unchanged. |
| C | Old and new KolTx rows parse, slot preservation, heuristic fallback. |
| D | Pool prewarm hit/miss/capacity reason logging. |
| E | Markout fixture with before-exit 5x and after-exit 5x cases, coverage `<70%` incomplete labeling, sidecar writer fail-open. |
| F | Priority fee response parse, failure fallback, existing `landingLatencyMs` reuse, no policy change. |
| G | KOL style metrics fixture, sidecar writer fail-open, no auto DB mutation. |

All new sidecar JSONL writers must:

- be append-only;
- never throw into the live trading path;
- log append failure;
- return an explicit failure result when called from scripts/tests.

Command:

```bash
npm run check:fast
```

`npm run check:strict` remains known deferred debt unless Phase H4 is separately resumed.

## 11. Rollout Rules

1. Phase 0-3 are observe-only by default.
2. No entry expansion in the same PR as enrichment.
3. No live hard reject from a new flag until at least 7 days of report evidence unless it is an already-approved security invariant.
4. No automatic KOL DB mutation.
5. Any priority fee policy change requires a separate canary ADR.
6. If credits exceed daily cap, offline jobs pause first; live observability remains active until a separate live-observability threshold or safety halt is hit.

## 12. Open Questions

| Question | Current answer |
|---|---|
| Is Helius dashboard usage definitely monthly bucket usage? | Official docs say monthly reset; operator dashboard should confirm reset date. |
| Should Webhooks replace wallet WS? | Not in this plan. Consider only after measuring WS churn/byte cost. |
| Should Helius Sender be canaried? | Separate execution ADR. It is useful, but not a credit utilization mechanism. |
| Should Enhanced Transactions be used in entry path? | No. Use asynchronously or for bounded samples first. |
| Should NO_SECURITY_DATA remain hard reject? | Yes, per current Track 2B unless a later report proves false-negative 5x damage. |

## 13. Implementation Order

Recommended first PR:

```text
PR 1:
  Stream A credit catalog + ledger
  scripts/fetch-historical-swaps.ts estimator correction
  tests
```

Recommended second PR:

```text
PR 2:
  Stream B holder enrichment + token-quality risk flags
  Stream C KolTx slot/parseSource enrichment
  tests
```

If PR 2 exceeds roughly 200 LOC or touches more than one hot path, split it:

```text
PR 2A:
  Stream B holder enrichment + token-quality risk flags

PR 2B:
  Stream C KolTx slot/parseSource enrichment
```

Recommended third PR:

```text
PR 3:
  Stream D pool prewarm evidence
  Stream E markout backfill script
  report output
```

Recommended fourth PR:

```text
PR 4:
  Stream F priority fee telemetry
  Stream G wallet style backfill
  candidate policy report
```

## 14. Success Definition

This plan is successful if, after one 7-day run, the project can answer:

1. Which Helius-backed flags would have avoided big losses?
2. Which flags would have killed the known 5x winner?
3. How many closed trades reached 5x after exit?
4. How many rejected KOL candidates reached 5x later?
5. Which KOL wallets are actually copyable after fees and latency?
6. Which losses were execution-copyability failures rather than signal failures?
7. How many credits were spent per useful decision?

If these answers are available, Helius spend has been converted into mission evidence rather than noise.
