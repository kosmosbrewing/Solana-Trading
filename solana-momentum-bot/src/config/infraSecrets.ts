// Tier 1: Secrets / Infrastructure (shell profile 또는 .env).
// Network endpoints, wallet keys, third-party API tokens, persistence paths.

import path from 'path';
import { normalizeJupiterSwapApiUrl } from '../utils/jupiterApi';
import { optional, required } from './helpers';

const jupiterApiKey = optional('JUPITER_API_KEY', '');
const jupiterApiUrl = normalizeJupiterSwapApiUrl(optional('JUPITER_API_URL', ''), jupiterApiKey);

export const infraSecrets = {
  solanaRpcUrl: required('SOLANA_RPC_URL'),
  walletPrivateKey: required('WALLET_PRIVATE_KEY'),
  databaseUrl: required('DATABASE_URL'),
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
} as const;
