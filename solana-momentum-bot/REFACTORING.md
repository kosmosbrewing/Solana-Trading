# Solana Momentum Bot Refactoring Plan

> Updated: 2026-03-15
> Current state: v0.3 single-pair momentum executor
> Target state: event-aware, multi-candidate, onchain-triggered trading system

## 1. Why Refactor

The current bot can submit trades, manage risk, and recover state, but its strategy layer is weaker than the surrounding infrastructure.

- Entry is mostly post-fact confirmation.
- Universe selection is effectively disabled because only `TARGET_PAIR_ADDRESS` is watched.
- Several strategy and risk knobs exist in config but are not wired into live decisions.
- The codebase is organized like a multi-strategy engine, but runtime behavior is closer to a single-pair runner.

The refactor should not start from scratch. The goal is to preserve the stable execution and state-management pieces and replace the weak signal architecture around them.

## 2. Scope And Assumptions

### In Scope

- Strategy selection and gating
- Candidate discovery and watchlist flow
- Risk wiring and safety filters
- Exit behavior and position lifecycle quality
- Data ingestion architecture needed for the new strategy model

### Out Of Scope For Phase 1

- Full redesign of persistence schema unless required
- Complete replacement of Jupiter execution
- Dashboard implementation beyond minimal support hooks
- Fully automated influencer/event ontology

### Assumptions

- The product direction is Solana meme/event trading, not generic market making.
- The strongest edge will come from combining offchain context with onchain confirmation.
- Existing modules such as `TradeStore`, `PositionStore`, `Executor`, `Notifier`, and recovery logic should be reused.

## 3. Current Reality

This section describes what the code actually does today, not what the README suggests.

### 3.1 Runtime Shape

- Only one pair is monitored through `TARGET_PAIR_ADDRESS`.
- Only one timeframe is ingested at runtime, selected by `DEFAULT_TIMEFRAME`.
- `volume_spike` and `fib_pullback` can enter trades.
- `pump_detect` emits signals but is hard-blocked by a fixed Grade C score.
- Position checks use 5-minute candles for all open trades.

### 3.2 Structural Gaps

| Area | Current Behavior | Problem |
|------|------------------|---------|
| Universe | Single configured pair | No candidate selection edge |
| Timing | Polling + candle-close logic | Too slow for true opening-candle breakout |
| Multi-TF | Score input exists but is hardcoded | Score quality is misleading |
| Safety | Some safety data is fetched but not enforced | False sense of protection |
| Config | Several params are defined but unused | Strategy tuning is unreliable |
| Exit | TP1 closes full size; trailing uses recent local high | Winners are cut early and trailing is unstable |

### 3.3 Dead Or Misleading Paths

| Item | Status | Why It Matters |
|------|--------|----------------|
| `pump_detect` | Dead in live flow | Generates noise but no execution path |
| `fib_pullback` score | Static Grade B | Position sizing is biased regardless of quality |
| `multiTfAlignment` | Hardcoded to `1` | Score suggests sophistication that does not exist |
| `checkTokenSafety()` | Implemented, not wired | Safety rules are not actually applied |
| Spread filter | Spread is always `0` | Risk filter appears enabled but is ineffective |
| `minBuyRatio`, `minBreakoutScore` | Config only | Tuning these values changes nothing |

## 4. Target Strategy Model

The new system should separate idea generation from execution.

### 4.1 Core Principle

Do not trade because price moved.
Trade because:

1. there is a reason the coin should move,
2. onchain behavior confirms that the move is real,
3. scam/manipulation risk is below threshold,
4. execution timing still offers acceptable risk/reward.

### 4.2 Two-Stage Architecture

```text
Stage 1: Context / Candidate Creation
  - Event catch
  - Spike explanation
  - New coin tracking
  - Manual watchlist input

Stage 2: Execution / Trigger
  - Onchain confirmation
  - Risk gate
  - Entry trigger
  - Position management
```

### 4.3 Four Core Modules

#### Module 1. Event Catch

Purpose:
- detect meme, narrative, influencer, and news events before price fully reacts

Primary outputs:
- `event_score`
- `narrative_score`
- related tickers / contract candidates
- urgency tier for notification and watchlist promotion

Notes:
- TikTok should remain broad and non-crypto-filtered
- X/Twitter should be tiered by influencer importance
- low-confidence mappings should create watch candidates, not trades

#### Module 2. Spike Explanation

Purpose:
- detect abnormal onchain movement and explain it with social/context data

Primary outputs:
- `spike_score`
- `explained` or `unexplained`
- `scam_risk`
- reason summary for operator review and for strategy gating

This is the highest-value near-term module because it attacks the current strategy's main weakness: reacting to price without knowing why it moved.

#### Module 3. New Coin Filtering

Purpose:
- discover newly launched candidates and track them through the first hour

Primary outputs:
- rough eligibility
- follow-up watch status
- AI research report when meaningful progress occurs

This module should be treated as a noisy candidate generator, not as a direct trade source.

#### Module 4. Watchlist Tracking

Purpose:
- allow manual and automatic candidate registration
- trigger alerts when tracked assets hit operator-defined conditions

This is an operations layer, not the primary alpha source.

## 5. Decision Model

Avoid one giant score. Use layered gates.

### Gate 1. Hard Reject

Reject immediately when any of the following is true:

- `scam_risk` above threshold
- bundling / coordinated wallet behavior above threshold
- bot-wallet dominance above threshold
- critical token safety checks fail
- liquidity is below tradable floor

### Gate 2. Context Qualification

Decide whether a coin is worth active monitoring.

- `event_score >= 80`: high-priority candidate
- `event_score 60-79`: conditional candidate
- `event_score < 60`: watch only unless onchain context is exceptional

### Gate 3. Onchain Confirmation

Enter only when the candidate also satisfies real market confirmation.

Examples:
- breakout with real buy imbalance
- sustained holder growth
- non-bundled volume expansion
- reclaim after impulse and pullback

### Gate 4. Execution Viability

Even after confirmation, do not trade if:

- expected slippage is too high
- price is too extended relative to planned stop
- signal is stale
- the move is classified as unexplained pump chasing

## 6. Codebase Direction

### Keep

- `Executor`
- `TradeStore`
- `PositionStore`
- recovery and execution lock
- `Notifier`
- `SignalAuditLogger`
- most of `RiskManager` and `LiquiditySizer`

### Rework

- main orchestration in `src/index.ts`
- strategy scoring and gating flow
- universe/watchlist ownership
- exit management state
- ingestion layer for multi-source candidate feeds

### Remove Or Downgrade

- dead `pump_detect` path unless redefined with a real use case
- fake multi-timeframe score until it is truly implemented
- unused config fields or misleading score components

## 7. Refactoring Phases

### Phase 0. Stabilize The Existing Bot

Goal:
- remove misleading behavior before adding new intelligence

Tasks:
- wire real safety checks into live order approval
- remove or disable dead strategy paths
- align config surface with actual runtime behavior
- make daily-loss handling enforceable, not informational only
- fix exit behavior:
  - partial TP1 instead of full exit
  - persistent high-water mark for trailing
  - timeframe-aware monitoring per strategy

Exit criteria:
- no dead live strategy paths remain
- every exposed config value affects behavior or is removed
- risk and safety checks match documented behavior

### Phase 1. Introduce Spike Explanation

Goal:
- stop trading unexplained pumps

Tasks:
- build anomaly detector for volume, holder count, price, and liquidity changes
- classify moves as explained or unexplained
- compute baseline `scam_risk`
- attach explanation metadata to candidate lifecycle and audit log
- allow only explained candidates into the active execution watchlist

Exit criteria:
- every execution candidate has an explanation state
- unexplained pumps are blocked or heavily size-reduced
- operator can inspect why a candidate was promoted or rejected

### Phase 2. Add Event Catch

Goal:
- create candidate flow from offchain catalysts

Tasks:
- ingest X, TikTok, and news signals
- support influencer tiers
- produce `event_score` and related-asset hypotheses
- push strong candidates into watchlist before price confirmation

Exit criteria:
- event candidates are created independently of price spikes
- high-scoring events can be traced to candidate coins
- weak-confidence mappings remain observational only

### Phase 3. Convert To Candidate-Driven Execution

Goal:
- use onchain strategies as execution triggers, not idea generators

Tasks:
- refactor `volume_spike` and `fib_pullback` into trigger modules
- run trigger evaluation only for active candidates
- size positions by combined context quality and market quality
- record which gates were passed at entry time

Exit criteria:
- every trade can be explained by both context and trigger
- no trade is opened from raw price action alone unless explicitly allowed

### Phase 4. Add New Coin Pipeline

Goal:
- capture early candidates without turning the bot into a blind sniper

Tasks:
- detect new launches / migrations
- run rough filters
- track first-hour progression
- generate AI research snapshots when thresholds are met

Exit criteria:
- new coin tracking feeds the candidate system
- direct entry from raw new-launch detection is disabled by default

## 8. Required Data Model Changes

The following additions are likely needed even if the existing schema remains mostly intact.

- candidate table or candidate snapshot stream
- explanation metadata for spikes
- event records and source references
- persistent per-trade high-water mark
- gate decision audit:
  - hard reject reason
  - context qualification reason
  - trigger reason
  - execution viability reason

## 9. Metrics That Matter

Refactoring should be judged by trading quality, not architectural elegance.

### Strategy Metrics

- expectancy after fees and slippage
- median MAE / MFE by strategy
- explained vs unexplained candidate conversion
- win rate by gate path
- average hold time and exit reason distribution

### Operational Metrics

- candidate-to-trade conversion rate
- stale-signal rejection rate
- trade failure rate
- percent of trades with complete source attribution
- latency from event/spike detection to watchlist promotion

## 10. Risks

| Risk | Description | Mitigation |
|------|-------------|------------|
| Over-design | Building all four modules before validating one edge path | Ship Phase 0 and Phase 1 first |
| Bad token mapping | Social event mapped to wrong ticker/CA | Use contract-first mapping where possible |
| Social overfitting | Score tuned to historical hype artifacts | Use gates, not monolithic weighted score |
| Data cost | X/TikTok/news feeds can become expensive or unstable | Start with Module 2 and a narrow Module 1 |
| Live/backtest gap | New-coin and meme flows degrade in real execution | Validate in paper mode with slippage-aware reporting |

## 11. Immediate Next Actions

Recommended order for actual work:

1. Clean up dead and misleading live paths in the current bot.
2. Enforce real safety and risk behavior.
3. Add spike explanation and candidate audit metadata.
4. Move existing breakout logic behind candidate gating.
5. Only then add event ingestion and new-coin discovery.

## 12. Done Definition

This refactor is successful when:

- the bot is no longer a single-pair breakout chaser pretending to be a multi-strategy engine,
- every live trade can be traced to a candidate, a gate path, and a trigger,
- unexplained price spikes are mostly filtered out,
- strategy parameters are trustworthy because they are actually wired into runtime behavior,
- the architecture supports event-driven candidate creation without rewriting execution from scratch.
