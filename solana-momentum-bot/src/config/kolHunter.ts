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
  // 2026-04-29 (Track 1): Same-token re-entry cooldown — GUfyGEF6 incident 패턴 차단.
  // Why: paper 데이터 5 mints / 12 big losses (cum -0.033 SOL). 시뮬 +13% improvement.
  // 같은 mint 의 close 후 N ms 안에는 재진입 차단. 5x winner 보호 (대부분 single-entry).
  kolHunterReentryCooldownMs: numEnv('KOL_HUNTER_REENTRY_COOLDOWN_MS', '1800000'),  // 30분

  // 2026-04-29 (외부 전략 리포트 권고 #5): Co-buy graph community detection.
  // 같은 community KOL 들이 chain forward 시 simple 60s anti-correlation dedup 만으로 부족.
  // co-buy graph 빌드 후 community 추출 → N_eff (effective independent count) 산출.
  // consensusBonus 의 false positive (같은 squad 의 5명이 large 보너스 받는 경우) 차단.
  // 실측 (kol-tx.jsonl, minWeight=25): {chester, decu, dv, earl, theo} 5-KOL squad + {heyitsyolo, kev} 2-KOL pair.
  // disabled by default — 운영자 paper-shadow 측정 후 명시 활성화 권고.
  kolHunterCommunityDetectionEnabled: boolOptional('KOL_HUNTER_COMMUNITY_DETECTION_ENABLED', false),
  kolHunterCommunityWindowMs: numEnv('KOL_HUNTER_COMMUNITY_WINDOW_MS', '300000'),  // 5분 co-buy 윈도우
  kolHunterCommunityMinEdgeWeight: numEnv('KOL_HUNTER_COMMUNITY_MIN_EDGE_WEIGHT', '25'),  // 실측 권고 시작점

  // 2026-04-29 (P0-2 손실 방어 layer 0): KOL alpha decay cooldown.
  // 직전 N close 의 cumulative pnl 음수 + 손실 ratio ≥ threshold 인 KOL 이 trigger 한 entry 차단.
  // Track 1 (same-mint) 과 직교 — KOL-level 확장. 8JH1J6p4 incident 직전 패턴 (KOL 다수 dump streak)
  // 의 코드화. 격언 "Cut losses short" 의 KOL-level 적용.
  // downside-only — entry 차단만, 잘못 발동해도 손실 안 늘어남.
  kolHunterKolDecayCooldownEnabled: boolOptional('KOL_HUNTER_KOL_DECAY_COOLDOWN_ENABLED', true),
  kolHunterKolDecayCooldownMs: numEnv('KOL_HUNTER_KOL_DECAY_COOLDOWN_MS', '14400000'),  // 4h
  kolHunterKolDecayMinCloses: numEnv('KOL_HUNTER_KOL_DECAY_MIN_CLOSES', '3'),  // 직전 N close 평가
  kolHunterKolDecayLossRatioThreshold: numEnv('KOL_HUNTER_KOL_DECAY_LOSS_RATIO', '0.66'),  // 2/3 이상 손실
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
  // 2026-04-30 (P1-1, 외부 비판 후속): hardcoded constant → config 승격.
  // Why: live 운영 15h n=49 trades 에서 hold≤30s 의 12건 (44%) 이 mfeLowElapsedSec=30 임계
  //   미달로 quick reject 평가 자체 안 됨. avgHold 15s. → 시간 임계 단축 + winner 보호 분기.
  // - mfeLowThreshold (현 hardcode 0.02): peak MFE 임계 — 진입 후 한 번도 N% 도달 못하면 factor +1
  // - mfeLowElapsedSec (현 hardcode 30): 위 임계 적용 시점. 새 default 15.
  // - pullbackThreshold (현 hardcode 0.20): peak 대비 pullback 임계. 새 default 0.10 (덜 보수적).
  // - winnerSafeMfe: 한 번이라도 도달 시 quick reject 비활성화 (winner 보호). default 0.05 (5%).
  kolHunterQuickRejectMfeLowThreshold: numEnv('KOL_HUNTER_QUICK_REJECT_MFE_LOW_THRESHOLD', '0.02'),
  kolHunterQuickRejectMfeLowElapsedSec: numEnv('KOL_HUNTER_QUICK_REJECT_MFE_LOW_ELAPSED_SEC', '15'),
  kolHunterQuickRejectPullbackThreshold: numEnv('KOL_HUNTER_QUICK_REJECT_PULLBACK_THRESHOLD', '0.10'),
  kolHunterQuickRejectWinnerSafeMfe: numEnv('KOL_HUNTER_QUICK_REJECT_WINNER_SAFE_MFE', '0.05'),

  // 2026-04-30 (Sprint 2.A1, 외부 학술 리포트 §exit two-layer): structural kill-switch.
  // Why: live 운영 15h 분석 — D-bucket 6건 (mae<-30%) 의 root cause 가 sell tx confirm 84s 동안
  //   가격 -10% → -34% 진행. universal hardcut (-10%) 만으로는 sellability 변화 못 잡음.
  //   학술 권고 "stop 보다 팔 수 있음 우선" — runtime sell quote 평가로 emergency exit.
  // 정책:
  //   - paper 모드: kolHunterHoldPhasePeakDriftThreshold (이미 0.45) 강화 분기는 별도 keep,
  //     본 sprint 는 live 우선 (paper 는 가격 신호만).
  //   - live 모드: hold 60s 이상 + impact 임계 초과 시 즉시 close (close reason
  //     'structural_kill_sell_route').
  // Rate-limit: peakDrift 0.20 이상 + tick interval 30s 이상 trigger 후 quote 호출 (cache).
  kolHunterStructuralKillEnabled: boolOptional('KOL_HUNTER_STRUCTURAL_KILL_ENABLED', true),
  /** sell quote runtime 평가의 minimum hold 시간 (s). 0 미만은 disabled. */
  kolHunterStructuralKillMinHoldSec: numEnv('KOL_HUNTER_STRUCTURAL_KILL_MIN_HOLD_SEC', '60'),
  /** sell impact 임계 (decimal, 0.10 = 10% — sellQuoteProbe.maxImpactPct 정합). */
  kolHunterStructuralKillMaxImpactPct: numEnv('KOL_HUNTER_STRUCTURAL_KILL_MAX_IMPACT_PCT', '0.10'),
  /** quote cache TTL (ms) — 동일 mint 의 runtime quote 빈도 cap. */
  kolHunterStructuralKillCacheMs: numEnv('KOL_HUNTER_STRUCTURAL_KILL_CACHE_MS', '30000'),
  /** peakDrift 가 이 값을 초과해야 sell quote 호출 (rate-limit pre-gate). */
  kolHunterStructuralKillPeakDriftTrigger: numEnv('KOL_HUNTER_STRUCTURAL_KILL_PEAK_DRIFT_TRIGGER', '0.20'),
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
  // 2026-04-29 (Track 2B): NO_SECURITY_DATA cohort reject — Track 2A retro 결과.
  // Why: paper n=372 분석 — securityData 가 null 인 cohort (n=70) 가 mfe<1% rate 65.7%
  //   (vs baseline 45.2%, Δ +20.6%) + cum_net -0.0376 SOL + 5x winner 0건. 외부 API 없이
  //   순수 entry-time signal 로 IDEAL 달성률 +10% 추가 가능. allowDataMissing 보다 우선
  //   적용 — true 여도 본 flag 가 true 면 reject. paper-first (default true 안전, kol_hunter
  //   에만 적용 — pure_ws / cupsey 기존 정책 유지).
  kolHunterRejectOnNoSecurityData: boolOptional('KOL_HUNTER_REJECT_ON_NO_SECURITY_DATA', true),

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
  // 2026-04-30 (P1-2): pullback path 도 KOL count gate 강제.
  // Why: live 운영 15h n=49 trades 의 trigger×kols 분석 — pullback|kols=1 이 31건 (63%) 차지,
  //   net -0.1158 SOL = 전체 net 의 103% (다른 path 합 +0.0037). pullback 평가에 KOL count 조건 누락.
  // velocity path 는 이미 MIN_INDEPENDENT_KOL=2 강제, pullback 만 무방비 → 동일 강도로 잠금.
  kolHunterSmartV3PullbackMinKolCount: numEnv('KOL_HUNTER_SMART_V3_PULLBACK_MIN_KOL_COUNT', '2'),
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
