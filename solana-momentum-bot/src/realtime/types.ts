export type SwapSide = 'buy' | 'sell';
export type SwapSource = 'logs' | 'transaction';

export interface ParsedSwap {
  pool: string;
  signature: string;
  timestamp: number;
  side: SwapSide;
  priceNative: number;
  amountBase: number;
  amountQuote: number;
  slot: number;
  dexProgram?: string;
  source: SwapSource;
}

export interface RealtimePoolMetadata {
  dexId: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals?: number;
  quoteDecimals?: number;
  poolProgram?: string;
}

export interface HeliusWSConfig {
  rpcWsUrl: string;
  rpcHttpUrl: string;
  maxSubscriptions: number;
  fallbackConcurrency?: number;
  fallbackRequestsPerSecond?: number;
  maxFallbackQueue?: number;
}
