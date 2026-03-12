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

  // Risk
  maxRiskPerTrade: numOptional('MAX_RISK_PER_TRADE', 0.01),
  maxDailyLoss: numOptional('MAX_DAILY_LOSS', 0.05),
  maxSlippage: numOptional('MAX_SLIPPAGE', 0.01),

  // Strategy - Volume Spike
  defaultTimeframe: numOptional('DEFAULT_TIMEFRAME', 300),
  volumeSpikeMultiplier: numOptional('VOLUME_SPIKE_MULTIPLIER', 3.0),
  volumeSpikeLookback: numOptional('VOLUME_SPIKE_LOOKBACK', 20),

  // Strategy - Pump Detection
  pumpConsecutiveCandles: numOptional('PUMP_CONSECUTIVE_CANDLES', 3),
  pumpMinPriceMove: numOptional('PUMP_MIN_PRICE_MOVE', 0.05),

  // Safety
  minPoolLiquidity: numOptional('MIN_POOL_LIQUIDITY', 50000),
  minTokenAgeHours: numOptional('MIN_TOKEN_AGE_HOURS', 24),
  maxHolderConcentration: numOptional('MAX_HOLDER_CONCENTRATION', 0.80),

  // Execution
  maxRetries: numOptional('MAX_RETRIES', 3),
  txTimeoutMs: numOptional('TX_TIMEOUT_MS', 30000),
  cooldownMinutes: numOptional('COOLDOWN_MINUTES', 30),
  maxConsecutiveLosses: numOptional('MAX_CONSECUTIVE_LOSSES', 3),
} as const;
