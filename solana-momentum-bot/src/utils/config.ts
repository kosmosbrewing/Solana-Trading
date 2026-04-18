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

  // 2026-04-18: Block 4 — canary auto-halt (per-lane circuit-breaker)
  // Why: Block 3 pure_ws_breakout 은 loose gate 라 연속 entry 에서 loser streak 위험. per-lane auto-halt.
  canaryAutoHaltEnabled: boolOptional('CANARY_AUTO_HALT_ENABLED', true),
  canaryMaxConsecutiveLosers: Number(process.env.CANARY_MAX_CONSEC_LOSERS ?? '5'),
  canaryMaxBudgetSol: Number(process.env.CANARY_MAX_BUDGET_SOL ?? '0.5'),
  // 50 = mission-pivot 기준 canary 평가 윈도(ops:canary:eval PROMOTE 판정 trigger).
  // 코드 halt 는 이 값 도달 시 entry pause 하여 운영자가 평가 수행하게 함.
  canaryMaxTrades: Number(process.env.CANARY_MAX_TRADES ?? '50'),
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
