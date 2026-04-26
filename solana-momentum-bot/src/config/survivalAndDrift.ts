// pure_ws lane 의 entry-time 보호 layer.
// - Survival Layer P0 (2026-04-21): rug/honeypot/Token-2022 dangerous ext + top-holder.
// - Sell Quote Probe Tier B-1 (2026-04-21): liquidity-based honeypot 검증 (Jupiter quote).
// - Live Price Tracker (2026-04-25 Phase 2 P1-1/P1-2): reverse-quote 기반 T1 promotion 보강.
// - Entry Drift Guard (2026-04-19 + 2026-04-22 P2): pre-entry quote 와 signal price 격차 reject.
// - Peak Warmup (2026-04-19 QA Q2): 자기 BUY 영향 배제 위한 peakPrice update 유예.
// - Market Reference Price (2026-04-19): hard-cut/MAE/MFE 는 signal price 기준, pnl 은 fill 기준.

import { boolOptional, numEnv } from './helpers';

export const survivalAndDrift = {
  // 2026-04-21 Survival Layer (P0): pure_ws 도 security gate 강제 적용.
  pureWsSurvivalCheckEnabled: boolOptional('PUREWS_SURVIVAL_CHECK_ENABLED', true),
  // true: 데이터 없어도 진입 (observability only) / false: 데이터 없으면 reject (보수적)
  pureWsSurvivalAllowDataMissing: boolOptional('PUREWS_SURVIVAL_ALLOW_DATA_MISSING', true),
  pureWsSurvivalMinExitLiquidityUsd: numEnv('PUREWS_SURVIVAL_MIN_EXIT_LIQUIDITY_USD', '5000'),
  pureWsSurvivalMaxTop10HolderPct: numEnv('PUREWS_SURVIVAL_MAX_TOP10_HOLDER_PCT', '0.80'),

  // 2026-04-21 Survival Layer Tier B-1 + 2026-04-25 Phase 2 P1-1/P1-2 live price tracker.
  // Why: candle MFE 가 burst 를 놓치는 케이스를 token→SOL quote 로 보강.
  pureWsLivePriceTrackerEnabled: boolOptional('PUREWS_LIVE_PRICE_TRACKER_ENABLED', false),
  pureWsLivePriceTrackerPollMs: numEnv('PUREWS_LIVE_PRICE_TRACKER_POLL_MS', '12000'),
  pureWsT1PromoteByQuote: boolOptional('PUREWS_T1_PROMOTE_BY_QUOTE', false),

  pureWsSellQuoteProbeEnabled: boolOptional('PUREWS_SELL_QUOTE_PROBE_ENABLED', true),
  pureWsSellQuoteMaxImpactPct: numEnv('PUREWS_SELL_QUOTE_MAX_IMPACT_PCT', '0.10'),
  // round-trip 최소 복구 비율 (0 = disabled). 운영 관측 전 0 → impact 판정에 의존.
  pureWsSellQuoteMinRoundTripPct: numEnv('PUREWS_SELL_QUOTE_MIN_ROUND_TRIP_PCT', '0'),

  // 2026-04-19: Entry drift guard — Jupiter probe quote 로 expected fill price vs signal price gap.
  // Why: 2026-04-18 VPS 관측 4 trades 전부 +20~51% drift 에서 체결 → 즉시 -20% MAE 로 loser_hardcut.
  pureWsEntryDriftGuardEnabled: boolOptional('PUREWS_ENTRY_DRIFT_GUARD_ENABLED', true),
  pureWsMaxEntryDriftPct: numEnv('PUREWS_MAX_ENTRY_DRIFT_PCT', '0.02'),  // 2% (positive drift)
  // 2026-04-22 P2: 소규모 favorable (<5%) 은 기회 허용, 대규모 (>20%) 는 signal quality 문제.
  pureWsMaxFavorableDriftPct: numEnv('PUREWS_MAX_FAVORABLE_DRIFT_PCT', '0.20'),

  // 2026-04-19: Dual price tracker — market reference (signal) vs Jupiter fill (entry) 분리.
  pureWsUseMarketReferencePrice: boolOptional('PUREWS_USE_MARKET_REFERENCE_PRICE', true),

  // 2026-04-19 (QA Q2): Peak warmup — low-liquidity pool 자기 BUY 영향 배제.
  pureWsPeakWarmupSec: numEnv('PUREWS_PEAK_WARMUP_SEC', '3'),
  pureWsPeakWarmupMaxDeviationPct: numEnv('PUREWS_PEAK_WARMUP_MAX_DEVIATION_PCT', '0.05'),
} as const;
