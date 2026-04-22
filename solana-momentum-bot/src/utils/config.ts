import dotenv from 'dotenv';
import path from 'path';
import { normalizeJupiterSwapApiUrl } from './jupiterApi';
import { tradingParams } from './tradingParams';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function boolOptional(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value == null || value === '') return fallback;
  return value === 'true';
}

const VALID_TRADING_MODES = ['paper', 'live'] as const;
export type TradingMode = typeof VALID_TRADING_MODES[number];

function parseTradingMode(): TradingMode {
  const raw = process.env.TRADING_MODE || 'paper';
  if (!VALID_TRADING_MODES.includes(raw as TradingMode)) {
    throw new Error(`Invalid TRADING_MODE: "${raw}". Must be "paper" or "live".`);
  }
  return raw as TradingMode;
}

const jupiterApiKey = optional('JUPITER_API_KEY', '');
const jupiterApiUrl = normalizeJupiterSwapApiUrl(optional('JUPITER_API_URL', ''), jupiterApiKey);

export const config = {
  // ─── Tier 1: Secrets / Infrastructure (shell profile 또는 .env) ───
  solanaRpcUrl: required('SOLANA_RPC_URL'),
  walletPrivateKey: required('WALLET_PRIVATE_KEY'),
  databaseUrl: required('DATABASE_URL'),
  birdeyeApiKey: optional('BIRDEYE_API_KEY', ''),
  telegramBotToken: optional('TELEGRAM_BOT_TOKEN', ''),
  telegramChatId: optional('TELEGRAM_CHAT_ID', ''),
  telegramAdminUserId: optional('TELEGRAM_ADMIN_USER_ID', ''),
  heliusApiKey: optional('HELIUS_API_KEY', ''),
  heliusWsUrl: optional('HELIUS_WS_URL', ''),
  dexScreenerApiKey: optional('DEXSCREENER_API_KEY', ''),
  jupiterApiKey,
  jupiterApiUrl,
  twitterBearerToken: optional('TWITTER_BEARER_TOKEN', ''),
  sandboxWalletKey: optional('SANDBOX_WALLET_PRIVATE_KEY', ''),
  jitoRpcUrl: optional('JITO_RPC_URL', 'https://mainnet.block-engine.jito.wtf'),
  jupiterUltraApiUrl: optional('JUPITER_ULTRA_API_URL', 'https://api.jup.ag'),
  realtimeDataDir: optional('REALTIME_DATA_DIR', path.resolve(process.cwd(), 'data/realtime')),
  targetPairAddress: optional('TARGET_PAIR_ADDRESS', ''),

  // ─── Tier 2: Operational Switches (.env 토글 — 배포 없이 변경) ───
  tradingMode: parseTradingMode(),
  scannerEnabled: process.env.SCANNER_ENABLED === 'true',
  realtimeEnabled: boolOptional('REALTIME_ENABLED', false),
  realtimePersistenceEnabled: boolOptional('REALTIME_PERSISTENCE_ENABLED', true),
  realtimeTriggerMode: optional('REALTIME_TRIGGER_MODE', 'bootstrap') as 'bootstrap' | 'core' | 'tick',
  realtimeReplayWarmSyncEnabled: boolOptional('REALTIME_REPLAY_WARM_SYNC_ENABLED', true),
  birdeyeWSEnabled: process.env.BIRDEYE_WS_ENABLED === 'true',
  // Why: Paper 모드에서 Birdeye Premium 미보유 시 401 → 자동 비활성화
  securityGateEnabled: process.env.SECURITY_GATE_ENABLED
    ? process.env.SECURITY_GATE_ENABLED !== 'false'
    : parseTradingMode() === 'live',
  // Why: Paper 모드에서 exit liquidity/sell impact 조회 불필요 → 자동 비활성화
  quoteGateEnabled: process.env.QUOTE_GATE_ENABLED
    ? process.env.QUOTE_GATE_ENABLED !== 'false'
    : parseTradingMode() === 'live',
  preflightEnforceGate: process.env.PREFLIGHT_ENFORCE_GATE !== 'false',
  strategyDEnabled: process.env.STRATEGY_D_ENABLED === 'true',
  useJitoBundles: process.env.USE_JITO_BUNDLES === 'true',
  useJupiterUltra: process.env.USE_JUPITER_ULTRA === 'true',
  runnerEnabled: process.env.RUNNER_ENABLED === 'true',
  runnerGradeBEnabled: process.env.RUNNER_GRADE_B_ENABLED === 'true',
  runnerConcurrentEnabled: process.env.RUNNER_CONCURRENT_ENABLED === 'true',
  degradedExitEnabled: process.env.DEGRADED_EXIT_ENABLED === 'true',
  // Phase E1 (2026-04-08): exit execution mechanism mode flag.
  // - 'legacy' (default): 기존 5s polling, swap submit 직전 recheck 없음
  // - 'hybrid_c5': polling 1s 단축 (C1) + submit 직전 pre_submit_tick_price 캡처 (C3, paper 에선 abort 안 함)
  // measurement (5 컬럼 persist) 는 두 모드 모두 동일하게 동작한다.
  // 자세한 lifecycle 은 docs/exec-plans/active/exit-execution-mechanism-2026-04-08.md
  exitMechanismMode: (process.env.EXIT_MECHANISM_MODE === 'hybrid_c5' ? 'hybrid_c5' : 'legacy') as 'legacy' | 'hybrid_c5',
  // Phase B2: CRITICAL_LIVE canary용 임시 backdoor.
  // DO NOT enable in production — EdgeTracker blacklist 자체를 무시한다.
  // 사용 시나리오: Phase A의 가드가 모두 배포된 뒤, 오염된 ledger 위에 학습된 blacklist가
  // 정상 토큰까지 막는 것을 1회성으로 해제하고 canary 기간 동안만 쓴다.
  // canary 합격 후 즉시 false로 되돌리고 `clean` 모드로 ledger를 sanitize한다.
  bypassEdgeBlacklist: boolOptional('BOT_BYPASS_EDGE_BLACKLIST', false),
  realtimePoolDiscoveryEnabled: boolOptional('REALTIME_POOL_DISCOVERY_ENABLED', true),
  realtimeSeedBackfillEnabled: boolOptional('REALTIME_SEED_BACKFILL_ENABLED', true),
  // 2026-04-11: Path A — cupsey-inspired lane (sandbox, post-entry state machine)
  cupseyLaneEnabled: boolOptional('CUPSEY_LANE_ENABLED', false),
  // 2026-04-11: Path B1 — Strategy D live execution (sandbox wallet only)
  strategyDLiveEnabled: boolOptional('STRATEGY_D_LIVE_ENABLED', false),
  // 2026-04-11: Path B2 — KOL wallet tracking (discovery source)
  kolWalletTrackingEnabled: boolOptional('KOL_WALLET_TRACKING_ENABLED', false),
  // 2026-04-17: Tier 1 — Migration Handoff Reclaim lane (off by default, paper→live 단계 승격)
  migrationLaneEnabled: boolOptional('MIGRATION_LANE_ENABLED', false),
  // 2026-04-17: Tier 1 — signal-only mode (detection + logging, 체결 없음. paper 전 검증용)
  migrationLaneSignalOnly: boolOptional('MIGRATION_LANE_SIGNAL_ONLY', true),
  // 2026-04-18: Block 3 — pure_ws_breakout lane (mission-pivot convexity). paper-first, default off.
  pureWsLaneEnabled: boolOptional('PUREWS_LANE_ENABLED', false),
  pureWsLaneWalletMode: (process.env.PUREWS_WALLET_MODE ?? 'auto') as 'auto' | 'main' | 'sandbox',
  // 2026-04-18: Block 3 paper-first enforcement — live buy 는 별도 flag 필요.
  // Why: PUREWS_LANE_ENABLED + TRADING_MODE=live 만으로 자동 live 가 되지 않게 하기 위함.
  // 운영자가 paper 관측 후 명시적으로 canary 를 켜야 live buy 허용.
  pureWsLiveCanaryEnabled: boolOptional('PUREWS_LIVE_CANARY_ENABLED', false),

  // 2026-04-21 Survival Layer (P0 mission-refinement-2026-04-21): rug / honeypot / Token-2022
  // dangerous extension / top-holder 검사를 pure_ws 에도 강제 적용. 기존 security gate 는
  // bootstrap path (candleHandler) 에만 연결돼 있어 pure_ws 는 우회 상태 — 이번에 연결.
  pureWsSurvivalCheckEnabled: boolOptional('PUREWS_SURVIVAL_CHECK_ENABLED', true),
  // 보안 데이터 resolve 실패 시 허용 여부.
  // true: 데이터 없어도 진입 (observability only — Helius RPC 간헐 실패 시 signal 놓치지 않기 위함)
  // false: 데이터 없으면 reject (보수적 — Stage 1 통과 전에는 더 엄격하게 쓸 수 있음)
  pureWsSurvivalAllowDataMissing: boolOptional('PUREWS_SURVIVAL_ALLOW_DATA_MISSING', true),
  pureWsSurvivalMinExitLiquidityUsd: Number(process.env.PUREWS_SURVIVAL_MIN_EXIT_LIQUIDITY_USD ?? '5000'),
  pureWsSurvivalMaxTop10HolderPct: Number(process.env.PUREWS_SURVIVAL_MAX_TOP10_HOLDER_PCT ?? '0.80'),

  // 2026-04-21 Survival Layer Tier B-1: Active Sell Quote Probe (exitability).
  // Jupiter 에 tokenMint→SOL quote 요청 → "팔릴 수 있는가" 직접 검증.
  // securityGate 는 static properties (mint/freeze authority, Token-2022 ext) 를 보지만,
  // liquidity 고갈 / AMM 라우팅 실패 등 honeypot-by-liquidity 는 sell quote 로만 드러남.
  pureWsSellQuoteProbeEnabled: boolOptional('PUREWS_SELL_QUOTE_PROBE_ENABLED', true),
  pureWsSellQuoteMaxImpactPct: Number(process.env.PUREWS_SELL_QUOTE_MAX_IMPACT_PCT ?? '0.10'),
  // round-trip 최소 복구 비율 (0 = disabled). 실제 운영 관측 전 0 으로 두고 impact 판정에 의존.
  pureWsSellQuoteMinRoundTripPct: Number(process.env.PUREWS_SELL_QUOTE_MIN_ROUND_TRIP_PCT ?? '0'),

  // 2026-04-19: Entry drift guard — Jupiter probe quote 로 expected fill price vs signal price
  // gap 측정, threshold 초과 시 진입 차단.
  // Why: 2026-04-18 VPS 관측에서 4 trades 전부 +20~51% drift 에서 체결됨 (Token-2022 / low-liq route).
  // Hard-cut 이 entry price 기준이라 체결 직후 즉시 -20% MAE 로 찍혀 rug 없이도 loser_hardcut 발동.
  pureWsEntryDriftGuardEnabled: boolOptional('PUREWS_ENTRY_DRIFT_GUARD_ENABLED', true),
  pureWsMaxEntryDriftPct: Number(process.env.PUREWS_MAX_ENTRY_DRIFT_PCT ?? '0.02'),  // 2% (positive drift)
  // 2026-04-22 P2: large negative drift (signal price bug / pool stale) reject threshold.
  // 소규모 favorable (<5%) 은 기회 허용, 대규모 (>20%) 는 signal quality 문제로 판단.
  pureWsMaxFavorableDriftPct: Number(process.env.PUREWS_MAX_FAVORABLE_DRIFT_PCT ?? '0.20'),

  // 2026-04-19: Dual price tracker — market reference (signal) vs Jupiter fill (entry) 분리.
  // Why: hard-cut / MAE / MFE 는 signal price 기준 (실제 market movement), pnl 은 Jupiter fill 기준.
  // 기존처럼 entryPrice 단일로 쓰면 bad fill entry 가 "시장 손실" 로 오해되어 과도 차단.
  pureWsUseMarketReferencePrice: boolOptional('PUREWS_USE_MARKET_REFERENCE_PRICE', true),

  // 2026-04-19 (QA Q2): Peak warmup — 진입 직후 N초 동안 봇 자신의 BUY tx 가 low-liquidity
  // pool 에서 price 를 일시 띄우는 영향을 배제하기 위해 peakPrice update 유예.
  // marketReferencePrice × (1 + peakWarmupMaxDeviationPct) 이내만 peak 로 인정.
  pureWsPeakWarmupSec: Number(process.env.PUREWS_PEAK_WARMUP_SEC ?? '3'),
  pureWsPeakWarmupMaxDeviationPct: Number(process.env.PUREWS_PEAK_WARMUP_MAX_DEVIATION_PCT ?? '0.05'),

  // 2026-04-18: DEX_TRADE Phase 1.3 — v2 detector (독립 WS burst detector)
  // Why: v1 은 bootstrap signal 재사용. v2 는 independent detector (`src/strategy/wsBurstDetector.ts`).
  // 2026-04-19: default on — bootstrap 의존 탈피. Phase 1-3 관측 데이터 수집 활성화.
  // Paper replay (2026-04-18, 2.26M eval): vol_floor reject 97% → tuned defaults 아래 주입.
  pureWsV2Enabled: boolOptional('PUREWS_V2_ENABLED', true),
  pureWsV2MinPassScore: Number(process.env.PUREWS_V2_MIN_PASS_SCORE ?? '50'),   // tuned: 60 → 50 (sweep 0.617%)
  pureWsV2FloorVol: Number(process.env.PUREWS_V2_FLOOR_VOL ?? '0.15'),           // tuned: 0.33 → 0.15 (p95 근처)
  pureWsV2FloorBuy: Number(process.env.PUREWS_V2_FLOOR_BUY ?? '0.25'),
  pureWsV2FloorTx: Number(process.env.PUREWS_V2_FLOOR_TX ?? '0.33'),
  pureWsV2FloorPrice: Number(process.env.PUREWS_V2_FLOOR_PRICE ?? '0.1'),
  pureWsV2BuyRatioAbsFloor: Number(process.env.PUREWS_V2_BUY_RATIO_ABS_FLOOR ?? '0.55'),
  pureWsV2TxCountAbsFloor: Number(process.env.PUREWS_V2_TX_COUNT_ABS_FLOOR ?? '3'),
  pureWsV2WVolume: Number(process.env.PUREWS_V2_W_VOLUME ?? '30'),
  pureWsV2WBuy: Number(process.env.PUREWS_V2_W_BUY ?? '25'),
  pureWsV2WDensity: Number(process.env.PUREWS_V2_W_DENSITY ?? '20'),
  pureWsV2WPrice: Number(process.env.PUREWS_V2_W_PRICE ?? '20'),
  pureWsV2WReverse: Number(process.env.PUREWS_V2_W_REVERSE ?? '5'),
  pureWsV2NRecent: Number(process.env.PUREWS_V2_N_RECENT ?? '3'),
  pureWsV2NBaseline: Number(process.env.PUREWS_V2_N_BASELINE ?? '6'),             // tuned: 12 → 6 (60s, instant burst 성격)
  pureWsV2ZVolSaturate: Number(process.env.PUREWS_V2_Z_VOL_SATURATE ?? '2.0'),    // tuned: 3.0 → 2.0
  pureWsV2ZBuySaturate: Number(process.env.PUREWS_V2_Z_BUY_SATURATE ?? '2.0'),
  pureWsV2ZTxSaturate: Number(process.env.PUREWS_V2_Z_TX_SATURATE ?? '3.0'),
  pureWsV2BpsPriceSaturate: Number(process.env.PUREWS_V2_BPS_PRICE_SATURATE ?? '1000'),  // tuned: 300 → 1000 (p90 saturate 완화)
  // per-pair cooldown (같은 pair 반복 entry 방지). Top pair 쏠림 방어.
  pureWsV2PerPairCooldownSec: Number(process.env.PUREWS_V2_PER_PAIR_COOLDOWN_SEC ?? '300'),  // 5분
  // 2026-04-21 P1: v1 (bootstrap) 경로에도 per-pair cooldown. BOME ukHH6c7m 관측에서
  // 4 trades 연속 같은 pair 진입 → canary halt 유발.
  // 2026-04-22 강화: 300s(5분) → 1800s(30분). 14h 관측에서 pippin(Dfh5DzRg) 한 pair 에
  // 32회 진입 (평균 18분 간격) — 5분 cooldown 이 실질 차단 안 함. pair diversity 강제 필요.
  pureWsV1PerPairCooldownSec: Number(process.env.PUREWS_V1_PER_PAIR_COOLDOWN_SEC ?? '1800'),

  // 2026-04-18: DEX_TRADE Phase 2 — Probe Viability Floor + Daily Bleed Budget
  // Why: RR gate retire 대체. viability 하한만 유지 + bleed budget 으로 시도 수 통제.
  probeViabilityFloorEnabled: boolOptional('PROBE_VIABILITY_FLOOR_ENABLED', true),
  probeViabilityMinTicketSol: Number(process.env.PROBE_VIABILITY_MIN_TICKET_SOL ?? '0.005'),
  probeViabilityMaxBleedPct: Number(process.env.PROBE_VIABILITY_MAX_BLEED_PCT ?? '0.06'),  // 6% round-trip cap
  probeViabilityMaxSellImpactPct: Number(process.env.PROBE_VIABILITY_MAX_SELL_IMPACT_PCT ?? '0'), // 0 = disabled 기본
  dailyBleedBudgetEnabled: boolOptional('DAILY_BLEED_BUDGET_ENABLED', true),
  dailyBleedAlpha: Number(process.env.DAILY_BLEED_ALPHA ?? '0.05'),  // wallet 5%
  dailyBleedMinCapSol: Number(process.env.DAILY_BLEED_MIN_CAP_SOL ?? '0.05'),
  dailyBleedMaxCapSol: Number(process.env.DAILY_BLEED_MAX_CAP_SOL ?? '0'),  // 0 = unlimited

  // 2026-04-18: DEX_TRADE Phase 3 — Quick Reject Classifier (microstructure-based PROBE exit)
  quickRejectClassifierEnabled: boolOptional('QUICK_REJECT_CLASSIFIER_ENABLED', true),
  quickRejectWindowSec: Number(process.env.QUICK_REJECT_WINDOW_SEC ?? '45'),
  quickRejectMinMfePct: Number(process.env.QUICK_REJECT_MIN_MFE_PCT ?? '0.005'),
  quickRejectBuyRatioDecay: Number(process.env.QUICK_REJECT_BUY_RATIO_DECAY ?? '0.15'),
  quickRejectTxDensityDrop: Number(process.env.QUICK_REJECT_TX_DENSITY_DROP ?? '0.5'),
  quickRejectDegradeCountForExit: Number(process.env.QUICK_REJECT_DEGRADE_COUNT_FOR_EXIT ?? '2'),

  // 2026-04-18: DEX_TRADE Phase 3 — Hold-Phase Exitability Sentinel (RUNNER degraded exit)
  holdPhaseSentinelEnabled: boolOptional('HOLD_PHASE_SENTINEL_ENABLED', true),
  holdPhaseBuyRatioCollapse: Number(process.env.HOLD_PHASE_BUY_RATIO_COLLAPSE ?? '0.2'),
  holdPhaseTxDensityDrop: Number(process.env.HOLD_PHASE_TX_DENSITY_DROP ?? '0.6'),
  holdPhasePeakDrift: Number(process.env.HOLD_PHASE_PEAK_DRIFT ?? '0.35'),
  holdPhaseDegradedFactorCount: Number(process.env.HOLD_PHASE_DEGRADED_FACTOR_COUNT ?? '2'),

  // 2026-04-18: Block 4 — canary auto-halt (per-lane circuit-breaker)
  // Why: Block 3 pure_ws_breakout 은 loose gate 라 연속 entry 에서 loser streak 위험. per-lane auto-halt.
  canaryAutoHaltEnabled: boolOptional('CANARY_AUTO_HALT_ENABLED', true),
  // 2026-04-21 P2: 4 → 8 완화. convexity mission 관점에서 4-streak 은 표본 부족 (일반적인
  // 우월 전략도 4 streak loss 는 빈번). budget cap 이 실제 자산 보호, consecutive counter 는
  // 관측 circuit breaker 역할로 재정의. 실제 halt 에는 budgetCap 이 더 중요.
  canaryMaxConsecutiveLosers: Number(process.env.CANARY_MAX_CONSEC_LOSERS ?? '8'),
  // 2026-04-21 mission refinement (cumulative loss cap): Real Asset Guard 정책값 `-0.3 SOL`.
  // 이전 default 0.5 는 pivot 당시 loose. refinement 이후 -0.3 SOL 로 통일 (1 SOL 중 30% 한도).
  canaryMaxBudgetSol: Number(process.env.CANARY_MAX_BUDGET_SOL ?? '0.3'),
  // 2026-04-21 P2: halt 자동 해제 — halt 이후 일정 시간 경과 + 오픈 포지션 없음 → 자동 reset.
  // Why: 기존 동작은 halt 후 운영자 수동 개입까지 무한 유지 → Phase 1-3 관측 데이터 축적 지연.
  // 자동 reset 은 consecutiveLosers 만 0 으로 리셋, budget/cumulativePnl 은 유지 (진짜 가드).
  canaryAutoResetEnabled: boolOptional('CANARY_AUTO_RESET_ENABLED', true),
  canaryAutoResetMinSec: Number(process.env.CANARY_AUTO_RESET_MIN_SEC ?? '1800'),  // 30분
  // 2026-04-21 mission refinement: 200 = scale/retire decision gate (Stage 4).
  // 이전 default 50 은 promotion gate 처럼 사용됐으나 refinement 에서 safety checkpoint 로 재분류.
  // 코드 halt 는 200 도달 시 entry pause — 운영자가 Stage 4 판정 (scale/retire/hold) 수행.
  canaryMaxTrades: Number(process.env.CANARY_MAX_TRADES ?? '200'),
  // 관측 전용 체크포인트 — halt/승격 결정 없음, telemetry summary 로그에서만 표시.
  canarySafetyCheckpointTrades: Number(process.env.CANARY_SAFETY_CHECKPOINT_TRADES ?? '50'),    // Stage 2 내 초기 safety 점검 시점
  canaryPreliminaryReviewTrades: Number(process.env.CANARY_PRELIMINARY_REVIEW_TRADES ?? '100'), // Stage 2 완료 시 preliminary edge/bleed/quickReject 검토
  canaryMinLossToCountSol: Number(process.env.CANARY_MIN_LOSS_TO_COUNT_SOL ?? '0'),

  // 2026-04-18: Block 4 QA fix — wallet-level 전역 concurrency guard
  // Why: lane별 maxConcurrent 는 서로 독립 (cupsey 5 + pure_ws 3 = 최대 8 동시 open 가능).
  // canary 단계에서 mission-pivot 가 요구한 "동시 max 3 ticket" 은 wallet 기준 전역 cap 으로 별도 강제.
  // default false (opt-in) — 전 lane 에 강제하지 않고 canary 전환 시점에만 운영자가 활성.
  canaryGlobalConcurrencyEnabled: boolOptional('CANARY_GLOBAL_CONCURRENCY_ENABLED', false),
  canaryGlobalMaxConcurrent: Number(process.env.CANARY_GLOBAL_MAX_CONCURRENT ?? '3'),
  // 2026-04-17: Wallet Stop Guard (override 가드레일 #2)
  // wallet balance < threshold 시 cupsey + migration 신규 진입 차단. exit는 영향 없음.
  walletStopGuardEnabled: boolOptional('WALLET_STOP_GUARD_ENABLED', true),
  walletStopMinSol: Number(process.env.WALLET_STOP_MIN_SOL ?? '0.8'),
  walletStopPollIntervalMs: Number(process.env.WALLET_STOP_POLL_INTERVAL_MS ?? '30000'),
  walletStopWalletName: process.env.WALLET_STOP_WALLET_NAME ?? 'main',
  walletStopRpcFailSafeThreshold: Number(process.env.WALLET_STOP_RPC_FAIL_SAFE ?? '3'),

  // 2026-04-18: Block 1 — Explicit lane wallet ownership
  // Why: cupsey/migration 은 기존에 `ctx.sandboxExecutor ?? ctx.executor`로 암묵적 선택 →
  // VPS env 의 STRATEGY_D_LIVE_ENABLED 값에 따라 wallet이 바뀜 (ambiguity).
  // 'auto' = 기존 동작 (backward compat), 'main' = main wallet 강제, 'sandbox' = sandbox 강제(미초기화 시 fail).
  cupseyWalletMode: (process.env.CUPSEY_WALLET_MODE ?? 'auto') as 'auto' | 'main' | 'sandbox',
  migrationWalletMode: (process.env.MIGRATION_WALLET_MODE ?? 'auto') as 'auto' | 'main' | 'sandbox',

  // 2026-04-18: Block 1 — Always-on wallet delta comparator
  // Why: wallet balance delta vs executed ledger net flow 를 주기적으로 비교하여
  // 2026-04-17 +18.34 SOL drift 같은 사후 발견이 아닌 상시 감지로 전환.
  walletDeltaComparatorEnabled: boolOptional('WALLET_DELTA_COMPARATOR_ENABLED', true),
  walletDeltaPollIntervalMs: Number(process.env.WALLET_DELTA_POLL_INTERVAL_MS ?? '300000'),  // 5분
  walletDeltaDriftWarnSol: Number(process.env.WALLET_DELTA_DRIFT_WARN_SOL ?? '0.05'),
  walletDeltaDriftHaltSol: Number(process.env.WALLET_DELTA_DRIFT_HALT_SOL ?? '0.20'),
  walletDeltaMinSamplesBeforeAlert: Number(process.env.WALLET_DELTA_MIN_SAMPLES ?? '2'),  // N회 연속 drift 후 알림 (noise 방어)

  // ─── Tier 3: Trading Params (코드 관리 — tradingParams.ts) ───
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
  // Why: 운영 관측 기반으로 tune 가능해야 함 (idle watchlist churn vs real dead WS 복구).
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
  // ─── Cupsey / Execution Operational Overrides (.env — 배포 없이 변경) ───
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
