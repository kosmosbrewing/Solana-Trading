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

function numRequired(key: string): number {
  const raw = required(key);
  const num = Number(raw);
  if (Number.isNaN(num)) {
    throw new Error(`Env var ${key} is not a valid number: "${raw}"`);
  }
  return num;
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
} as const;
