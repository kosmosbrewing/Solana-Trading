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


function numOptional(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const num = Number(v);
  if (Number.isNaN(num)) {
    throw new Error(`Env var ${key} is not a valid number: "${v}"`);
  }
  return num;
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

  // Data
  birdeyeApiKey: required('BIRDEYE_API_KEY'),
  databaseUrl: required('DATABASE_URL'),

  // Jupiter
  jupiterApiUrl: optional('JUPITER_API_URL', 'https://quote-api.jup.ag/v6'),

  // Notification
  telegramBotToken: optional('TELEGRAM_BOT_TOKEN', ''),
  telegramChatId: optional('TELEGRAM_CHAT_ID', ''),

  // Trading Mode
  tradingMode: parseTradingMode(),

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
  volumeSpikeMultiplier: numOptional('VOLUME_SPIKE_MULTIPLIER', 3.0),
  volumeSpikeLookback: numOptional('VOLUME_SPIKE_LOOKBACK', 20),
  minBuyRatio: numOptional('MIN_BUY_RATIO', 0.65),
  minBreakoutScore: numOptional('MIN_BREAKOUT_SCORE', 50),
  maxRiskPerTrade: numOptional('MAX_RISK_PER_TRADE', 0.01),
  exhaustionThreshold: numOptional('EXHAUSTION_THRESHOLD', 2),

  // Fib Pullback (Strategy C)
  fibImpulseWindowBars: numOptional('FIB_IMPULSE_WINDOW_BARS', 18),
  fibImpulseMinPct: numOptional('FIB_IMPULSE_MIN_PCT', 0.15),
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

  // ─── Birdeye WebSocket ───
  birdeyeWSEnabled: process.env.BIRDEYE_WS_ENABLED === 'true',

  // ─── DexScreener ───
  dexScreenerApiKey: optional('DEXSCREENER_API_KEY', ''),

  // ─── Jupiter API Key (Ultra API) ───
  jupiterApiKey: optional('JUPITER_API_KEY', ''),

  // ─── Security Gate ───
  securityGateEnabled: process.env.SECURITY_GATE_ENABLED !== 'false', // default: true
  minExitLiquidityUsd: numOptional('MIN_EXIT_LIQUIDITY_USD', 10_000),

  // ─── Quote Gate ───
  quoteGateEnabled: process.env.QUOTE_GATE_ENABLED !== 'false', // default: true

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
} as const;
