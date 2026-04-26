// Tier 3: Trading params (코드 관리 — utils/tradingParams.ts) + selective env overrides.
// 패턴: tradingParams.X 가 default 값 → 후행 spread 가 .env 에 있으면 덮어씀.
// 변경 PR 통해 리뷰 후 배포 (label convention: code_default / runtime_canary / operator_cap).

import { tradingParams } from '../utils/tradingParams';

export const tradingParamsOverrides = {
  ...tradingParams.universe,
  ...tradingParams.strategyA,
  ...tradingParams.strategyC,
  ...tradingParams.strategyD,
  ...tradingParams.orderShape,
  ...tradingParams.risk,
  ...tradingParams.liquidity,
  ...tradingParams.execution,
  ...tradingParams.position,
  ...tradingParams.ageBucket,
  ...tradingParams.liquidityAdaptation,
  ...tradingParams.degradedExit,
  ...tradingParams.scanner,
  // ─── Scanner Operational Overrides (.env — 배포 없이 변경) ───
  ...(process.env.SCANNER_MINIMUM_RESIDENCY_MS
    ? { scannerMinimumResidencyMs: Number(process.env.SCANNER_MINIMUM_RESIDENCY_MS) }
    : {}),
  ...(process.env.SCANNER_REENTRY_COOLDOWN_MS
    ? { scannerReentryCooldownMs: Number(process.env.SCANNER_REENTRY_COOLDOWN_MS) }
    : {}),
  ...(process.env.SCANNER_IDLE_EVICTION_MS
    ? { scannerIdleEvictionMs: Number(process.env.SCANNER_IDLE_EVICTION_MS) }
    : {}),
  ...(process.env.SCANNER_IDLE_EVICTION_SWEEP_INTERVAL_MS
    ? { scannerIdleEvictionSweepIntervalMs: Number(process.env.SCANNER_IDLE_EVICTION_SWEEP_INTERVAL_MS) }
    : {}),
  ...tradingParams.realtime,
  ...tradingParams.tickTrigger,
  // 2026-04-21 (QA M2): Helius WS watchdog + reconnect cooldown env override.
  ...(process.env.HELIUS_WATCHDOG_INTERVAL_MS
    ? { heliusWatchdogIntervalMs: Number(process.env.HELIUS_WATCHDOG_INTERVAL_MS) }
    : {}),
  ...(process.env.HELIUS_RECONNECT_COOLDOWN_MS
    ? { heliusReconnectCooldownMs: Number(process.env.HELIUS_RECONNECT_COOLDOWN_MS) }
    : {}),
  ...tradingParams.event,
  ...tradingParams.social,
  ...tradingParams.jito,
  ...tradingParams.paper,
  ...tradingParams.safety,
  ...tradingParams.notification,
  ...tradingParams.operator,
  ...tradingParams.cupseyLane,
  ...tradingParams.cupseyGate,
  ...tradingParams.cusumDetector,
  // ─── Cupsey Gate Operational Overrides ───
  ...(process.env.CUPSEY_GATE_ENABLED !== undefined
    ? { cupseyGateEnabled: process.env.CUPSEY_GATE_ENABLED !== 'false' }
    : {}),
  ...(process.env.CUPSEY_GATE_MIN_VOLUME_ACCEL_RATIO
    ? { cupseyGateMinVolumeAccelRatio: Number(process.env.CUPSEY_GATE_MIN_VOLUME_ACCEL_RATIO) }
    : {}),
  ...(process.env.CUPSEY_GATE_MIN_PRICE_CHANGE_PCT
    ? { cupseyGateMinPriceChangePct: Number(process.env.CUPSEY_GATE_MIN_PRICE_CHANGE_PCT) }
    : {}),
  ...(process.env.CUPSEY_GATE_MIN_AVG_BUY_RATIO
    ? { cupseyGateMinAvgBuyRatio: Number(process.env.CUPSEY_GATE_MIN_AVG_BUY_RATIO) }
    : {}),
  ...(process.env.CUPSEY_GATE_MIN_TRADE_COUNT_RATIO
    ? { cupseyGateMinTradeCountRatio: Number(process.env.CUPSEY_GATE_MIN_TRADE_COUNT_RATIO) }
    : {}),
  // ─── Cupsey / Execution Operational Overrides ───
  ...(process.env.EXECUTION_RR_REJECT
    ? { executionRrReject: Number(process.env.EXECUTION_RR_REJECT) }
    : {}),
  ...(process.env.CUPSEY_LANE_TICKET_SOL
    ? { cupseyLaneTicketSol: Number(process.env.CUPSEY_LANE_TICKET_SOL) }
    : {}),
  ...(process.env.CUPSEY_MAX_PEAK_MULTIPLIER
    ? { cupseyMaxPeakMultiplier: Number(process.env.CUPSEY_MAX_PEAK_MULTIPLIER) }
    : {}),
  ...(process.env.CUPSEY_STALK_DROP_PCT
    ? { cupseyStalkDropPct: Number(process.env.CUPSEY_STALK_DROP_PCT) }
    : {}),
  ...tradingParams.kolTracking,
  ...tradingParams.pureWsLane,
  ...tradingParams.pureWsGate,
  // ─── Pure WS Breakout Operational Overrides (.env — 배포 없이 변경) ───
  ...(process.env.PUREWS_LANE_TICKET_SOL
    ? { pureWsLaneTicketSol: Number(process.env.PUREWS_LANE_TICKET_SOL) }
    : {}),
  ...(process.env.PUREWS_MAX_CONCURRENT
    ? { pureWsMaxConcurrent: Number(process.env.PUREWS_MAX_CONCURRENT) }
    : {}),
  ...(process.env.PUREWS_PROBE_HARD_CUT_PCT
    ? { pureWsProbeHardCutPct: Number(process.env.PUREWS_PROBE_HARD_CUT_PCT) }
    : {}),
  // 2026-04-26 (H2-followup): tradingParams.ts 의 env 직접 참조 제거 → config.ts 일원화.
  // Phase 2 P1-4 sweep override (parameter-change-log.ts 와 같이 사용).
  ...(process.env.PUREWS_PROBE_TRAILING_PCT
    ? { pureWsProbeTrailingPct: Number(process.env.PUREWS_PROBE_TRAILING_PCT) }
    : {}),
  ...(process.env.PUREWS_T1_MFE_THRESHOLD
    ? { pureWsT1MfeThreshold: Number(process.env.PUREWS_T1_MFE_THRESHOLD) }
    : {}),
  ...(process.env.PUREWS_T1_TRAIL_PCT
    ? { pureWsT1TrailingPct: Number(process.env.PUREWS_T1_TRAIL_PCT) }
    : {}),
  ...(process.env.PUREWS_T2_MFE_THRESHOLD
    ? { pureWsT2MfeThreshold: Number(process.env.PUREWS_T2_MFE_THRESHOLD) }
    : {}),
  ...(process.env.PUREWS_T2_TRAIL_PCT
    ? { pureWsT2TrailingPct: Number(process.env.PUREWS_T2_TRAIL_PCT) }
    : {}),
  ...(process.env.PUREWS_T2_LOCK_MULT
    ? { pureWsT2BreakevenLockMultiplier: Number(process.env.PUREWS_T2_LOCK_MULT) }
    : {}),
  ...(process.env.PUREWS_T3_MFE_THRESHOLD
    ? { pureWsT3MfeThreshold: Number(process.env.PUREWS_T3_MFE_THRESHOLD) }
    : {}),
  ...(process.env.PUREWS_T3_TRAIL_PCT
    ? { pureWsT3TrailingPct: Number(process.env.PUREWS_T3_TRAIL_PCT) }
    : {}),
  ...(process.env.PUREWS_GATE_ENABLED !== undefined
    ? { pureWsGateEnabled: process.env.PUREWS_GATE_ENABLED !== 'false' }
    : {}),
  ...(process.env.PUREWS_GATE_MIN_VOLUME_ACCEL_RATIO
    ? { pureWsGateMinVolumeAccelRatio: Number(process.env.PUREWS_GATE_MIN_VOLUME_ACCEL_RATIO) }
    : {}),
  ...(process.env.PUREWS_GATE_MIN_AVG_BUY_RATIO
    ? { pureWsGateMinAvgBuyRatio: Number(process.env.PUREWS_GATE_MIN_AVG_BUY_RATIO) }
    : {}),
  ...tradingParams.migrationLane,
  // ─── Migration Lane Operational Overrides ───
  ...(process.env.MIGRATION_LANE_TICKET_SOL
    ? { migrationLaneTicketSol: Number(process.env.MIGRATION_LANE_TICKET_SOL) }
    : {}),
  ...(process.env.MIGRATION_COOLDOWN_SEC
    ? { migrationCooldownSec: Number(process.env.MIGRATION_COOLDOWN_SEC) }
    : {}),
  ...(process.env.MIGRATION_STALK_MIN_PULLBACK_PCT
    ? { migrationStalkMinPullbackPct: Number(process.env.MIGRATION_STALK_MIN_PULLBACK_PCT) }
    : {}),
  ...(process.env.MIGRATION_STALK_MAX_PULLBACK_PCT
    ? { migrationStalkMaxPullbackPct: Number(process.env.MIGRATION_STALK_MAX_PULLBACK_PCT) }
    : {}),
  ...(process.env.MIGRATION_RECLAIM_BUY_RATIO_MIN
    ? { migrationReclaimBuyRatioMin: Number(process.env.MIGRATION_RECLAIM_BUY_RATIO_MIN) }
    : {}),
} as const;
