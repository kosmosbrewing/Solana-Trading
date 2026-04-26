// DEX_TRADE Phase 1.3 (v2 detector) + Phase 2 (viability + bleed) + Phase 3 (quick reject + hold sentinel).
// 모두 pure_ws lane 에 default-on 통합 (PUREWS_V2_ENABLED 만 운영자 opt-in).
// Phase 1.2 paper replay (2026-04-18, 2.26M eval): vol_floor reject 97% → tuned defaults 적용.

import { boolOptional, numEnv } from './helpers';

export const dexTradeDetector = {
  // ─── Phase 1.3: v2 독립 WS burst detector ───
  // Why: v1 은 bootstrap signal 재사용. v2 는 src/strategy/wsBurstDetector.ts 독립 detector.
  // 2026-04-19: default on — bootstrap 의존 탈피, Phase 1-3 관측 데이터 수집 활성화.
  pureWsV2Enabled: boolOptional('PUREWS_V2_ENABLED', true),
  pureWsV2MinPassScore: numEnv('PUREWS_V2_MIN_PASS_SCORE', '50'),   // tuned: 60 → 50 (sweep 0.617%)
  pureWsV2FloorVol: numEnv('PUREWS_V2_FLOOR_VOL', '0.15'),           // tuned: 0.33 → 0.15 (p95 근처)
  pureWsV2FloorBuy: numEnv('PUREWS_V2_FLOOR_BUY', '0.25'),
  pureWsV2FloorTx: numEnv('PUREWS_V2_FLOOR_TX', '0.33'),
  pureWsV2FloorPrice: numEnv('PUREWS_V2_FLOOR_PRICE', '0.1'),
  pureWsV2BuyRatioAbsFloor: numEnv('PUREWS_V2_BUY_RATIO_ABS_FLOOR', '0.55'),
  pureWsV2TxCountAbsFloor: numEnv('PUREWS_V2_TX_COUNT_ABS_FLOOR', '3'),
  pureWsV2WVolume: numEnv('PUREWS_V2_W_VOLUME', '30'),
  pureWsV2WBuy: numEnv('PUREWS_V2_W_BUY', '25'),
  pureWsV2WDensity: numEnv('PUREWS_V2_W_DENSITY', '20'),
  pureWsV2WPrice: numEnv('PUREWS_V2_W_PRICE', '20'),
  pureWsV2WReverse: numEnv('PUREWS_V2_W_REVERSE', '5'),
  pureWsV2NRecent: numEnv('PUREWS_V2_N_RECENT', '3'),
  pureWsV2NBaseline: numEnv('PUREWS_V2_N_BASELINE', '6'),             // tuned: 12 → 6 (60s, instant burst 성격)
  pureWsV2ZVolSaturate: numEnv('PUREWS_V2_Z_VOL_SATURATE', '2.0'),    // tuned: 3.0 → 2.0
  pureWsV2ZBuySaturate: numEnv('PUREWS_V2_Z_BUY_SATURATE', '2.0'),
  pureWsV2ZTxSaturate: numEnv('PUREWS_V2_Z_TX_SATURATE', '3.0'),
  pureWsV2BpsPriceSaturate: numEnv('PUREWS_V2_BPS_PRICE_SATURATE', '1000'),  // tuned: 300 → 1000 (p90 saturate 완화)

  // per-pair cooldown — top pair 쏠림 방어.
  pureWsV2PerPairCooldownSec: numEnv('PUREWS_V2_PER_PAIR_COOLDOWN_SEC', '300'),  // 5분
  // 2026-04-21 P1: v1 (bootstrap) 경로에도 per-pair cooldown.
  // 2026-04-22 강화: 300s(5분) → 1800s(30분). pippin 한 pair 32회 진입 (평균 18분 간격) — 5분 cooldown 무력.
  pureWsV1PerPairCooldownSec: numEnv('PUREWS_V1_PER_PAIR_COOLDOWN_SEC', '1800'),

  // ─── Phase 2: Probe Viability Floor + Daily Bleed Budget ───
  // Why: RR gate retire 대체. viability 하한 + bleed budget 으로 시도 수 통제.
  probeViabilityFloorEnabled: boolOptional('PROBE_VIABILITY_FLOOR_ENABLED', true),
  probeViabilityMinTicketSol: numEnv('PROBE_VIABILITY_MIN_TICKET_SOL', '0.005'),
  probeViabilityMaxBleedPct: numEnv('PROBE_VIABILITY_MAX_BLEED_PCT', '0.06'),  // 6% round-trip cap
  probeViabilityMaxSellImpactPct: numEnv('PROBE_VIABILITY_MAX_SELL_IMPACT_PCT', '0'), // 0 = disabled

  dailyBleedBudgetEnabled: boolOptional('DAILY_BLEED_BUDGET_ENABLED', true),
  dailyBleedAlpha: numEnv('DAILY_BLEED_ALPHA', '0.05'),  // wallet 5%
  dailyBleedMinCapSol: numEnv('DAILY_BLEED_MIN_CAP_SOL', '0.05'),
  dailyBleedMaxCapSol: numEnv('DAILY_BLEED_MAX_CAP_SOL', '0'),  // 0 = unlimited

  // ─── Phase 3: Quick Reject Classifier (microstructure-based PROBE exit) ───
  quickRejectClassifierEnabled: boolOptional('QUICK_REJECT_CLASSIFIER_ENABLED', true),
  quickRejectWindowSec: numEnv('QUICK_REJECT_WINDOW_SEC', '45'),
  quickRejectMinMfePct: numEnv('QUICK_REJECT_MIN_MFE_PCT', '0.005'),
  quickRejectBuyRatioDecay: numEnv('QUICK_REJECT_BUY_RATIO_DECAY', '0.15'),
  quickRejectTxDensityDrop: numEnv('QUICK_REJECT_TX_DENSITY_DROP', '0.5'),
  quickRejectDegradeCountForExit: numEnv('QUICK_REJECT_DEGRADE_COUNT_FOR_EXIT', '2'),

  // ─── Phase 3: Hold-Phase Exitability Sentinel (RUNNER degraded exit) ───
  holdPhaseSentinelEnabled: boolOptional('HOLD_PHASE_SENTINEL_ENABLED', true),
  holdPhaseBuyRatioCollapse: numEnv('HOLD_PHASE_BUY_RATIO_COLLAPSE', '0.2'),
  holdPhaseTxDensityDrop: numEnv('HOLD_PHASE_TX_DENSITY_DROP', '0.6'),
  holdPhasePeakDrift: numEnv('HOLD_PHASE_PEAK_DRIFT', '0.35'),
  holdPhaseDegradedFactorCount: numEnv('HOLD_PHASE_DEGRADED_FACTOR_COUNT', '2'),
} as const;
