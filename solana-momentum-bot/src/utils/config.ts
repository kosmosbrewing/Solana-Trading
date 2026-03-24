import dotenv from 'dotenv';
import path from 'path';

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

function listOptional(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  return raw ? raw.split(',').map((item) => item.trim()).filter(Boolean) : fallback;
}

function boolOptional(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value == null || value === '') return fallback;
  return value === 'true';
}

function numOptional(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const num = Number(v);
  if (Number.isNaN(num)) {
    throw new Error(`Env var ${key} is not a valid number: "${v}"`);
  }
  return num;
}

function numListOptional(key: string, fallback: number[]): number[] {
  const raw = process.env[key];
  if (!raw) return fallback;
  const values = raw
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
  return values.length > 0 ? values : fallback;
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

export const config = {
  // Solana
  solanaRpcUrl: required('SOLANA_RPC_URL'),
  walletPrivateKey: required('WALLET_PRIVATE_KEY'),

  // Legacy single-pair mode
  targetPairAddress: optional('TARGET_PAIR_ADDRESS', ''),

  // Data
  // Why: Birdeye optional — GeckoTerminal + DexScreener로 대체 (docs/exec-plans/completed/paper-data-plane-transition.md)
  birdeyeApiKey: optional('BIRDEYE_API_KEY', ''),
  databaseUrl: required('DATABASE_URL'),

  // Jupiter
  jupiterApiUrl: optional('JUPITER_API_URL', 'https://quote-api.jup.ag/v6'),

  // Notification
  telegramBotToken: optional('TELEGRAM_BOT_TOKEN', ''),
  telegramChatId: optional('TELEGRAM_CHAT_ID', ''),
  telegramAdminUserId: optional('TELEGRAM_ADMIN_USER_ID', ''),
  pm2AllowedProcesses: listOptional('PM2_ALLOWED_PROCESSES', ['momentum-bot', 'momentum-shadow']),

  // Trading Mode
  tradingMode: parseTradingMode(),
  // Why: Paper 모드에서 온체인 잔고 대신 시뮬레이션 잔고 사용 (지갑에 SOL 없음)
  paperInitialBalance: numOptional('PAPER_INITIAL_BALANCE', 1.0),

  // ─── Universe Parameters (Group 1: 7개) ───
  minPoolTVL: numOptional('MIN_POOL_TVL', 50_000),
  minTokenAgeSec: numOptional('MIN_TOKEN_AGE_SEC', 86_400),
  maxTop10HolderPct: numOptional('MAX_TOP10_HOLDER_PCT', 0.80),
  minDailyVolume: numOptional('MIN_DAILY_VOLUME', 10_000),
  minTradeCount24h: numOptional('MIN_TRADE_COUNT_24H', 50),
  maxSpreadPct: numOptional('MAX_SPREAD_PCT', 0.03),
  maxWatchlistSize: numOptional('MAX_WATCHLIST_SIZE', 20),

  // ─── Strategy Parameters (Group 2: 10개) ───
  defaultTimeframe: numOptional('DEFAULT_TIMEFRAME', 300),
  volumeSpikeMultiplier: numOptional('VOLUME_SPIKE_MULTIPLIER', 2.5),
  volumeSpikeLookback: numOptional('VOLUME_SPIKE_LOOKBACK', 20),
  minBuyRatio: numOptional('MIN_BUY_RATIO', 0.65),
  minBreakoutScore: numOptional('MIN_BREAKOUT_SCORE', 50),
  maxRiskPerTrade: numOptional('MAX_RISK_PER_TRADE', 0.01),
  exhaustionThreshold: numOptional('EXHAUSTION_THRESHOLD', 2),

  // Fib Pullback (Strategy C)
  fibImpulseWindowBars: numOptional('FIB_IMPULSE_WINDOW_BARS', 18),
  fibImpulseMinPct: numOptional('FIB_IMPULSE_MIN_PCT', 0.175),
  fibEntryLow: numOptional('FIB_ENTRY_LOW', 0.5),
  fibEntryHigh: numOptional('FIB_ENTRY_HIGH', 0.618),
  fibInvalidation: numOptional('FIB_INVALIDATION', 0.786),
  fibVolumeClimaxMultiplier: numOptional('FIB_VOLUME_CLIMAX_MULTIPLIER', 2.5),
  fibMinWickRatio: numOptional('FIB_MIN_WICK_RATIO', 0.4),
  fibTimeStopMinutes: numOptional('FIB_TIME_STOP_MINUTES', 60),

  // ─── Liquidity Parameters (Group 3: 3개) ───
  maxSlippage: numOptional('MAX_SLIPPAGE', 0.01),
  maxPoolImpact: numOptional('MAX_POOL_IMPACT', 0.02),
  emergencyHaircut: numOptional('EMERGENCY_HAIRCUT', 0.50),
  defaultAmmFeePct: numOptional('DEFAULT_AMM_FEE_PCT', 0.005),
  defaultMevMarginPct: numOptional('DEFAULT_MEV_MARGIN_PCT', 0.0015),

  // Risk
  maxDailyLoss: numOptional('MAX_DAILY_LOSS', 0.05),
  maxDrawdownPct: numOptional('MAX_DRAWDOWN_PCT', 0.30),
  recoveryPct: numOptional('RECOVERY_PCT', 0.85),

  // Safety (legacy aliases — used by Universe)
  minPoolLiquidity: numOptional('MIN_POOL_LIQUIDITY', 50_000),
  minTokenAgeHours: numOptional('MIN_TOKEN_AGE_HOURS', 24),
  maxHolderConcentration: numOptional('MAX_HOLDER_CONCENTRATION', 0.80),

  // Execution
  maxRetries: numOptional('MAX_RETRIES', 3),
  txTimeoutMs: numOptional('TX_TIMEOUT_MS', 30000),
  cooldownMinutes: numOptional('COOLDOWN_MINUTES', 30),
  maxConsecutiveLosses: numOptional('MAX_CONSECUTIVE_LOSSES', 3),

  // Universe refresh
  universeRefreshIntervalMs: numOptional('UNIVERSE_REFRESH_INTERVAL_MS', 300_000),

  // Event Context (Stage 1 / EventScout)
  eventPollingIntervalMs: numOptional('EVENT_POLLING_INTERVAL_MS', 1_800_000),
  eventTrendingFetchLimit: numOptional('EVENT_TRENDING_FETCH_LIMIT', 20),
  eventMinScore: numOptional('EVENT_MIN_SCORE', 35),
  eventExpiryMinutes: numOptional('EVENT_EXPIRY_MINUTES', 180),
  eventMinLiquidityUsd: numOptional('EVENT_MIN_LIQUIDITY_USD', 25_000),

  // ─── Scanner (Phase 1A) ───
  scannerEnabled: process.env.SCANNER_ENABLED === 'true',
  scannerMinWatchlistScore: numOptional('SCANNER_MIN_WATCHLIST_SCORE', 30),
  scannerTrendingPollMs: numOptional('SCANNER_TRENDING_POLL_MS', 300_000),
  scannerDexEnrichMs: numOptional('SCANNER_DEX_ENRICH_MS', 300_000),
  scannerLaneAMinAgeSec: numOptional('SCANNER_LANE_A_MIN_AGE_SEC', 3_600),
  scannerLaneBMaxAgeSec: numOptional('SCANNER_LANE_B_MAX_AGE_SEC', 1_200),
  scannerReentryCooldownMs: numOptional('SCANNER_REENTRY_COOLDOWN_MS', 1_800_000),

  // ─── Birdeye WebSocket ───
  birdeyeWSEnabled: process.env.BIRDEYE_WS_ENABLED === 'true',

  // ─── Helius Real-Time ───
  heliusApiKey: optional('HELIUS_API_KEY', ''),
  heliusWsUrl: optional('HELIUS_WS_URL', ''),
  realtimeEnabled: boolOptional('REALTIME_ENABLED', false),
  realtimePersistenceEnabled: boolOptional('REALTIME_PERSISTENCE_ENABLED', true),
  realtimeDataDir: optional('REALTIME_DATA_DIR', path.resolve(process.cwd(), 'data/realtime')),
  realtimeOutcomeHorizonsSec: numListOptional('REALTIME_OUTCOME_HORIZONS_SEC', [30, 60, 180, 300]),
  realtimePrimaryIntervalSec: numOptional('REALTIME_PRIMARY_INTERVAL_SEC', 15),
  realtimeConfirmIntervalSec: numOptional('REALTIME_CONFIRM_INTERVAL_SEC', 60),
  realtimeVolumeSurgeLookback: numOptional('REALTIME_VOLUME_SURGE_LOOKBACK', 20),
  realtimeVolumeSurgeMultiplier: numOptional('REALTIME_VOLUME_SURGE_MULTIPLIER', 3.0),
  realtimePriceBreakoutLookback: numOptional('REALTIME_PRICE_BREAKOUT_LOOKBACK', 20),
  realtimeConfirmMinBars: numOptional('REALTIME_CONFIRM_MIN_BARS', 3),
  realtimeConfirmMinChangePct: numOptional('REALTIME_CONFIRM_MIN_CHANGE_PCT', 0.02),
  realtimeCooldownSec: numOptional('REALTIME_COOLDOWN_SEC', 300),
  realtimeMaxSubscriptions: numOptional('REALTIME_MAX_SUBSCRIPTIONS', 30),
  realtimeFallbackConcurrency: numOptional('REALTIME_FALLBACK_CONCURRENCY', 2),
  realtimeFallbackRequestsPerSecond: numOptional('REALTIME_FALLBACK_RPS', 4),
  realtimeFallbackBatchSize: numOptional('REALTIME_FALLBACK_BATCH_SIZE', 5),
  realtimeMaxFallbackQueue: numOptional('REALTIME_MAX_FALLBACK_QUEUE', 1000),
  realtimeSlMode: optional('REALTIME_SL_MODE', 'atr'),
  realtimeSlAtrMultiplier: numOptional('REALTIME_SL_ATR_MULTIPLIER', 1.5),
  realtimeSlSwingLookback: numOptional('REALTIME_SL_SWING_LOOKBACK', 5),
  realtimeTimeStopMinutes: numOptional('REALTIME_TIME_STOP_MINUTES', 15),

  // ─── DexScreener ───
  dexScreenerApiKey: optional('DEXSCREENER_API_KEY', ''),

  // ─── Jupiter API Key + Ultra API (ADR-005: Jito 보완재) ───
  jupiterApiKey: optional('JUPITER_API_KEY', ''),
  // Why: ADR-005 — Jito 미사용 경로 또는 Jito fallback으로만 활성화
  useJupiterUltra: process.env.USE_JUPITER_ULTRA === 'true', // default: false

  // ─── Security Gate ───
  // Paper 모드: Birdeye Premium 미보유 시 401 → 자동 비활성화
  securityGateEnabled: process.env.SECURITY_GATE_ENABLED
    ? process.env.SECURITY_GATE_ENABLED !== 'false'
    : parseTradingMode() === 'live',
  minExitLiquidityUsd: numOptional('MIN_EXIT_LIQUIDITY_USD', 10_000),

  // ─── Quote Gate ───
  // Paper 모드: exit liquidity/sell impact 조회 불필요 → 자동 비활성화
  quoteGateEnabled: process.env.QUOTE_GATE_ENABLED
    ? process.env.QUOTE_GATE_ENABLED !== 'false'
    : parseTradingMode() === 'live',
  // Why: sell-side impact가 높으면 exit 시 슬리피지 → 실제 R:R 훼손
  maxSellImpact: numOptional('MAX_SELL_IMPACT', 0.03), // 3% — hard reject
  sellImpactSizingThreshold: numOptional('SELL_IMPACT_SIZING_THRESHOLD', 0.015), // 1.5% — 50% sizing

  // ─── Phase 2: Pre-flight Gate ───
  preflightEnforceGate: process.env.PREFLIGHT_ENFORCE_GATE !== 'false', // default: true

  // ─── Phase 2: X/Twitter Social Mentions (C-2) ───
  twitterBearerToken: optional('TWITTER_BEARER_TOKEN', ''),
  socialInfluencerMinFollowers: numOptional('SOCIAL_INFLUENCER_MIN_FOLLOWERS', 10_000),

  // ─── Phase 2: EventScore Pruning ───
  eventScoreRetentionDays: numOptional('EVENT_SCORE_RETENTION_DAYS', 30),

  // ─── Phase 3: Jito Bundle Integration (M-5) ───
  useJitoBundles: process.env.USE_JITO_BUNDLES === 'true', // default: false
  jitoRpcUrl: optional('JITO_RPC_URL', 'https://mainnet.block-engine.jito.wtf'),
  jitoTipSol: numOptional('JITO_TIP_SOL', 0.001),

  // ─── Phase 3: Sandbox Wallet (Strategy D) ───
  sandboxWalletKey: optional('SANDBOX_WALLET_PRIVATE_KEY', ''),
  sandboxDailyLossLimitSol: numOptional('SANDBOX_DAILY_LOSS_LIMIT_SOL', 0.5),
  sandboxMaxPositionSol: numOptional('SANDBOX_MAX_POSITION_SOL', 0.05),

  // ─── Phase 3: Strategy D Parameters ───
  strategyDEnabled: process.env.STRATEGY_D_ENABLED === 'true', // default: false
  strategyDTicketSol: numOptional('STRATEGY_D_TICKET_SOL', 0.02),
  strategyDMinAge: numOptional('STRATEGY_D_MIN_AGE_MINUTES', 3),
  strategyDMaxAge: numOptional('STRATEGY_D_MAX_AGE_MINUTES', 20),
  strategyDTpMultiplier: numOptional('STRATEGY_D_TP_MULTIPLIER', 3.0),
  // ─── v4: Concurrent 절대 상한 + Equity Tiers (Step 1D, 3) ───
  maxConcurrentAbsolute: numOptional('MAX_CONCURRENT_ABSOLUTE', 3), // 안전 상한 (runner bypass 포함)
  concurrentTier1Sol: numOptional('CONCURRENT_TIER_1_SOL', 5),   // 이 equity 이상이면 2 concurrent
  concurrentTier2Sol: numOptional('CONCURRENT_TIER_2_SOL', 20),  // 이 equity 이상이면 3 concurrent

  // ─── v4: Execution R:R 임계값 (Step 1C) ───
  executionRrReject: numOptional('EXECUTION_RR_REJECT', 1.2),  // hard reject 기준
  executionRrPass: numOptional('EXECUTION_RR_PASS', 1.5),      // full pass 기준 (미만이면 0.5x)

  // ─── v4: Position Cap 설정 가능화 (Step 1B) ───
  maxPositionPct: numOptional('MAX_POSITION_PCT', 0.20), // 포트폴리오 대비 최대 포지션 비율

  // ─── v4: 유동성 적응 (Step 5A, 5B) ───
  // TVL 최소 기준 — equity 성장 시 저유동성 토큰 자동 차단
  liquidityTier1Sol: numOptional('LIQUIDITY_TIER_1_SOL', 5),
  liquidityTier1MinPool: numOptional('LIQUIDITY_TIER_1_MIN_POOL', 100_000),
  liquidityTier2Sol: numOptional('LIQUIDITY_TIER_2_SOL', 20),
  liquidityTier2MinPool: numOptional('LIQUIDITY_TIER_2_MIN_POOL', 200_000),
  // maxPoolImpact 동적 축소
  impactTier1Sol: numOptional('IMPACT_TIER_1_SOL', 5),
  impactTier1MaxImpact: numOptional('IMPACT_TIER_1_MAX_IMPACT', 0.015),
  impactTier2Sol: numOptional('IMPACT_TIER_2_SOL', 20),
  impactTier2MaxImpact: numOptional('IMPACT_TIER_2_MAX_IMPACT', 0.01),

  // ─── v4: Age Bucket 설정 가능화 (Step 1A) ───
  ageBucketHardFloorMin: numOptional('AGE_BUCKET_HARD_FLOOR_MIN', 15),         // reject 기준 (분)
  ageBucketTiers: [
    { upperHours: numOptional('AGE_BUCKET_1_UPPER_HOURS', 1), multiplier: numOptional('AGE_BUCKET_1_MULTIPLIER', 0.25) },
    { upperHours: numOptional('AGE_BUCKET_2_UPPER_HOURS', 4), multiplier: numOptional('AGE_BUCKET_2_MULTIPLIER', 0.5) },
    { upperHours: numOptional('AGE_BUCKET_3_UPPER_HOURS', 24), multiplier: numOptional('AGE_BUCKET_3_MULTIPLIER', 0.75) },
  ],

  // ─── v2: Degraded Exit (P0-3) ───
  degradedExitEnabled: process.env.DEGRADED_EXIT_ENABLED === 'true', // default: false — paper 검증 먼저
  degradedSellImpactThreshold: numOptional('DEGRADED_SELL_IMPACT_THRESHOLD', 0.05), // 5%
  degradedQuoteFailLimit: numOptional('DEGRADED_QUOTE_FAIL_LIMIT', 3), // 연속 실패 횟수
  degradedPartialPct: numOptional('DEGRADED_PARTIAL_PCT', 0.25), // 첫 매도 비율
  degradedDelayMs: numOptional('DEGRADED_DELAY_MS', 300_000), // 나머지 매도까지 대기 (5분)

  // ─── v2: Runner Extension (P0-4) ───
  runnerEnabled: process.env.RUNNER_ENABLED === 'true', // default: false — paper 검증 먼저

  // ─── v3: TP1 Time Extension ───
  // Why: TP1 50% 청산 후 잔여 trade가 원본 timeStop을 상속하면 Runner 활성화 시간 부족
  tp1TimeExtensionMinutes: numOptional('TP1_TIME_EXTENSION_MINUTES', 30),

  // ─── v3: Runner Grade B ───
  // Why: Grade B runner를 0.5x 사이징으로 허용하면 Runner 후보 2~3배 증가
  runnerGradeBEnabled: process.env.RUNNER_GRADE_B_ENABLED === 'true', // default: false

  // ─── v3: Runner Concurrent ───
  // Why: Runner 포지션은 SL이 TP1(손익분기+)이므로 추가 리스크 극소
  runnerConcurrentEnabled: process.env.RUNNER_CONCURRENT_ENABLED === 'true', // default: false
  maxConcurrentPositions: numOptional('MAX_CONCURRENT_POSITIONS', 1),

  // ─── v3: Jupiter Ultra V3 ───
  // Why: ShadowLane으로 3x 높은 체결률, 0-1블록 지연, RTSE 자동 슬리피지
  jupiterUltraApiUrl: optional('JUPITER_ULTRA_API_URL', 'https://api.jup.ag'),
} as const;
