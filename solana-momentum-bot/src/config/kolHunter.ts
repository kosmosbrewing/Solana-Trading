// Option 5 (2026-04-23): KOL Discovery + 자체 Execution.
// - ADR: docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md
// - REFACTORING_v1.0.md §6.5 / §8.2 env 규칙
// Sections: Tracker (Phase 1) → Scoring → Lane T base (Phase 3) → Survival → Live opt-in
// → Versions → swing-v2 paper A/B (2026-04-26) → smart-v3 main entry (2026-04-26)

import path from 'path';
import { boolOptional, numEnv, optional } from './helpers';

export const kolHunter = {
  // ─── KOL Wallet Tracker (Phase 1 passive logging) ───
  kolTrackerEnabled: boolOptional('KOL_TRACKER_ENABLED', false),
  kolDbPath: optional('KOL_DB_PATH', path.resolve(process.cwd(), 'data/kol/wallets.json')),
  kolHotReloadIntervalMs: numEnv('KOL_HOT_RELOAD_INTERVAL_MS', '60000'),
  kolTxFetchTimeoutMs: numEnv('KOL_TX_FETCH_TIMEOUT_MS', '5000'),
  kolTxLogFileName: optional('KOL_TX_LOG_FILE_NAME', 'kol-tx.jsonl'),

  // ─── Inactive KOL Shadow Track (Option A, 2026-04-27) ───
  // Why: 28 inactive KOL 의 실제 활동량을 paper position 영향 0 으로 사후 관측 → promotion candidate 식별.
  // Helius 429 risk MEDIUM: subscribe 대상이 active+inactive 합산이라 RPC 부하 증가.
  // 운영자는 활성화 전 KOL_TRACKER_ENABLED 와 무관하게 helius rate-limit 여유 확인 필수.
  // shadow 활성 시: inactive tx 는 kolSignalHandler 호출 없이 별도 jsonl 에만 기록 → entry 영향 0.
  kolHunterShadowTrackInactive: boolOptional('KOL_HUNTER_SHADOW_TRACK_INACTIVE', false),
  kolShadowTxLogFileName: optional('KOL_SHADOW_TX_LOG_FILE_NAME', 'kol-shadow-tx.jsonl'),
  // 2026-04-28: inactive KOL paper trade opt-in. shadowTrackInactive=true 의 superset.
  // 활성 시 inactive KOL signal 도 handleKolSwap 진입 → paper PROBE 생성 → 별도 jsonl 분리 dump.
  // 분포 측정 무결성 — active paper trade ledger 와 섞이지 않음.
  kolHunterShadowPaperTradeEnabled: boolOptional('KOL_HUNTER_SHADOW_PAPER_TRADE_ENABLED', false),
  kolShadowPaperTradesFileName: optional('KOL_SHADOW_PAPER_TRADES_FILE_NAME', 'kol-shadow-paper-trades.jsonl'),

  // ─── KOL Scoring (Discovery trigger 용, Gate 가산 아님) ───
  kolScoringWindowMs: numEnv('KOL_SCORING_WINDOW_MS', String(24 * 60 * 60 * 1000)),
  kolAntiCorrelationMs: numEnv('KOL_ANTI_CORRELATION_MS', '60000'),

  // ─── kol_hunter Lane T (Phase 3 paper-first) ───
  kolHunterEnabled: boolOptional('KOL_HUNTER_ENABLED', false),
  kolHunterPaperOnly: boolOptional('KOL_HUNTER_PAPER_ONLY', true),
  // 2026-04-28 B안: 운영자 결정 — live 24h n=44 데이터 (ROI -2.55%, catastrophic 4.5%) 도착 후
  // 0.03 → 0.02 SOL 후퇴. policyGuards POLICY_TICKET_MAX_SOL_BY_LANE.kol_hunter = 0.02 정합.
  // 200 trade 여정 시뮬: catastrophic 9건 + bleed 0.102 = 0.282 drawdown → wallet 0.718 (floor 0.7 +0.018 margin).
  // 100 trade 검증 후 catastrophic < 2% + ROI > 0% 시 0.025 승격, ≥ 4% 시 0.015 후퇴.
  kolHunterTicketSol: numEnv('KOL_HUNTER_TICKET_SOL', '0.02'),
  kolHunterMaxConcurrent: numEnv('KOL_HUNTER_MAX_CONCURRENT', '3'),
  kolHunterStalkWindowSec: numEnv('KOL_HUNTER_STALK_WINDOW_SEC', '180'),
  kolHunterHardcutPct: numEnv('KOL_HUNTER_HARDCUT_PCT', '0.10'),
  kolHunterT1Mfe: numEnv('KOL_HUNTER_T1_MFE', '0.50'),
  kolHunterT1TrailPct: numEnv('KOL_HUNTER_T1_TRAIL_PCT', '0.15'),
  kolHunterT2Mfe: numEnv('KOL_HUNTER_T2_MFE', '4.00'),
  kolHunterT2TrailPct: numEnv('KOL_HUNTER_T2_TRAIL_PCT', '0.20'),
  kolHunterT2BreakevenLockMult: numEnv('KOL_HUNTER_T2_BREAKEVEN_LOCK_MULT', '3.0'),
  kolHunterT3Mfe: numEnv('KOL_HUNTER_T3_MFE', '9.00'),
  kolHunterT3TrailPct: numEnv('KOL_HUNTER_T3_TRAIL_PCT', '0.25'),
  kolHunterQuickRejectWindowSec: numEnv('KOL_HUNTER_QUICK_REJECT_WINDOW_SEC', '180'),
  kolHunterQuickRejectFactorCount: numEnv('KOL_HUNTER_QUICK_REJECT_FACTOR_COUNT', '3'),
  // Paper round-trip cost (Jupiter platform fee + MEV + AMM fee). Live 시 wallet delta 에서 직접 차감.
  kolHunterPaperRoundTripCostPct: numEnv('KOL_HUNTER_PAPER_ROUND_TRIP_COST_PCT', '0.005'),

  // ─── Hold-phase sentinel relaxation (2026-04-28, Sprint 1A 결과) ───
  // Why: paper n=401 분석에서 mfe 200%+ 9건 중 4건이 sentinel (peak drift 0.30) 로 cut.
  //   - 8ipcTXum mfe 246% → net 108% (drift 40%)
  //   - HqyQHwQv mfe 207% → net 98%  (drift 36%)
  //   - ssFb5yQU mfe 215% → net 116% (drift 31%, 임계 직상)
  //   - EjY599u1 mfe 230% → net 42%  (drift 82%, 심각 — 완화해도 cut 됨)
  // 0.30 → 0.45 완화: 임계 직상 (31-40%) 케이스에서 retreat 견디고 추가 상승 capture 기대.
  // 심각 케이스 (drift 50%+) 는 여전히 cut → 다운사이드 보호 유지.
  // env override 로 추가 A/B 가능 (0.50 / 0.40 등).
  kolHunterHoldPhasePeakDriftThreshold: numEnv('KOL_HUNTER_HOLD_PHASE_PEAK_DRIFT_THRESHOLD', '0.45'),

  // ─── KOL Survival (MISSION_CONTROL §KOL Control, 2026-04-25) ───
  // Live canary 단계에서는 운영자가 명시적으로 false 로 닫아야 live 와 같은 gate 분포 보장.
  kolHunterSurvivalAllowDataMissing: boolOptional('KOL_HUNTER_SURVIVAL_ALLOW_DATA_MISSING', true),
  kolHunterSurvivalMinExitLiquidityUsd: numEnv('KOL_HUNTER_SURVIVAL_MIN_EXIT_LIQUIDITY_USD', '5000'),
  kolHunterSurvivalMaxTop10HolderPct: numEnv('KOL_HUNTER_SURVIVAL_MAX_TOP10_HOLDER_PCT', '0.80'),
  kolHunterRunSellQuoteProbe: boolOptional('KOL_HUNTER_RUN_SELL_QUOTE_PROBE', true),

  // Phase 5 P1-15 (2026-04-25): KOL live canary 명시적 opt-in.
  // Why: KOL_HUNTER_PAPER_ONLY=false 만으로는 live 안 돔 (review feedback P0). 별도 flag 필요.
  kolHunterLiveCanaryEnabled: boolOptional('KOL_HUNTER_LIVE_CANARY_ENABLED', false),

  // MISSION_CONTROL §Control 5 — arm identity / detector version.
  kolHunterParameterVersion: process.env.KOL_HUNTER_PARAMETER_VERSION ?? 'v1.0.0',
  kolHunterDetectorVersion: process.env.KOL_HUNTER_DETECTOR_VERSION ?? 'kol_discovery_v1',

  // ─── 2026-04-26: kol_hunter_swing_v2 paper-only A/B arm ───
  // 외부 review feedback (decimals_unknown 차단 후 swing 검증 필요). v1 main 변경 없음.
  // 진입 조건: enabled + independentKolCount ≥ minKolCount + kolScore ≥ minScore.
  // 변경 항목: PROBE flat timeout, T1 trail %, T1 profit floor.
  kolHunterSwingV2Enabled: boolOptional('KOL_HUNTER_SWING_V2_ENABLED', false),
  kolHunterSwingV2MinKolCount: numEnv('KOL_HUNTER_SWING_V2_MIN_KOL_COUNT', '2'),
  kolHunterSwingV2MinScore: numEnv('KOL_HUNTER_SWING_V2_MIN_SCORE', '5.0'),
  kolHunterSwingV2StalkWindowSec: numEnv('KOL_HUNTER_SWING_V2_STALK_WINDOW_SEC', '600'),
  kolHunterSwingV2T1TrailPct: numEnv('KOL_HUNTER_SWING_V2_T1_TRAIL_PCT', '0.25'),
  kolHunterSwingV2T1ProfitFloorMult: numEnv('KOL_HUNTER_SWING_V2_T1_PROFIT_FLOOR_MULT', '1.10'),
  kolHunterSwingV2ParameterVersion: process.env.KOL_HUNTER_SWING_V2_PARAMETER_VERSION ?? 'swing-v2.0.0',

  // ─── 2026-04-26: kol_hunter_smart_v3 main paper entry logic ───
  // 운영자 결정: 돈을 번 적 없는 v1 single-KOL wait entry 대신 smart-v3 trigger 를 main 으로 사용.
  // KOL_HUNTER_ENABLED=false 기본값과 paper-only guard 는 그대로 — 실제 wallet risk 없음.
  kolHunterSmartV3Enabled: boolOptional('KOL_HUNTER_SMART_V3_ENABLED', true),
  // observe window: anti-correlation 60s 와 충돌하지 않도록 120s default. 60s 는 env override 가능.
  kolHunterSmartV3ObserveWindowSec: numEnv('KOL_HUNTER_SMART_V3_OBSERVE_WINDOW_SEC', '120'),
  kolHunterSmartV3MinPullbackPct: numEnv('KOL_HUNTER_SMART_V3_MIN_PULLBACK_PCT', '0.10'),
  kolHunterSmartV3MaxDrawdownFromKolEntryPct: numEnv('KOL_HUNTER_SMART_V3_MAX_DRAWDOWN_FROM_KOL_ENTRY_PCT', '0.15'),
  kolHunterSmartV3VelocityScoreThreshold: numEnv('KOL_HUNTER_SMART_V3_VELOCITY_SCORE_THRESHOLD', '6.0'),
  kolHunterSmartV3VelocityMinIndependentKol: numEnv('KOL_HUNTER_SMART_V3_VELOCITY_MIN_INDEPENDENT_KOL', '2'),
  kolHunterSmartV3T1ThresholdHigh: numEnv('KOL_HUNTER_SMART_V3_T1_THRESHOLD_HIGH', '0.40'),
  kolHunterSmartV3T1TrailBoth: numEnv('KOL_HUNTER_SMART_V3_T1_TRAIL_BOTH', '0.25'),
  kolHunterSmartV3T1TrailPullback: numEnv('KOL_HUNTER_SMART_V3_T1_TRAIL_PULLBACK', '0.22'),
  kolHunterSmartV3T1TrailVelocity: numEnv('KOL_HUNTER_SMART_V3_T1_TRAIL_VELOCITY', '0.20'),
  kolHunterSmartV3ProfitFloorBoth: numEnv('KOL_HUNTER_SMART_V3_PROFIT_FLOOR_BOTH', '1.05'),
  kolHunterSmartV3ProfitFloorPullback: numEnv('KOL_HUNTER_SMART_V3_PROFIT_FLOOR_PULLBACK', '1.08'),
  kolHunterSmartV3ProfitFloorVelocity: numEnv('KOL_HUNTER_SMART_V3_PROFIT_FLOOR_VELOCITY', '1.10'),
  kolHunterSmartV3ProbeTimeoutBothSec: numEnv('KOL_HUNTER_SMART_V3_PROBE_TIMEOUT_BOTH_SEC', '600'),
  kolHunterSmartV3ProbeTimeoutPullbackSec: numEnv('KOL_HUNTER_SMART_V3_PROBE_TIMEOUT_PULLBACK_SEC', '300'),
  kolHunterSmartV3ProbeTimeoutVelocitySec: numEnv('KOL_HUNTER_SMART_V3_PROBE_TIMEOUT_VELOCITY_SEC', '300'),
  kolHunterSmartV3ReinforcementTrailInc: numEnv('KOL_HUNTER_SMART_V3_REINFORCEMENT_TRAIL_INC', '0.01'),
  kolHunterSmartV3ReinforcementTrailMax: numEnv('KOL_HUNTER_SMART_V3_REINFORCEMENT_TRAIL_MAX', '0.25'),
  kolHunterSmartV3ParameterVersion: process.env.KOL_HUNTER_SMART_V3_PARAMETER_VERSION ?? 'smart-v3.0.0',
} as const;
