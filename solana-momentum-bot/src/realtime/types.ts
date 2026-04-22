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
  fallbackBatchSize?: number;
  maxFallbackQueue?: number;
  /** Free tier 등 batch 미지원 플랜에서 single-request fallback까지 막는다. 기본 true. */
  disableSingleTxFallbackOnBatchUnsupported?: boolean;
  /** WS 무응답 감지 후 재구독 시도 간격 (ms). 기본 300000 (5분). 0 이면 비활성화. */
  watchdogIntervalMs?: number;
  /**
   * 재연결 cooldown (ms). 이 기간 내에는 watchdog 이 발화해도 reconnect 하지 않음.
   * Why: idle watchlist 일 때 back-to-back reconnect 가 subscription 을 점차 손상.
   * 기본 300000 (5분).
   */
  reconnectCooldownMs?: number;
  /** 429 재시도 최대 횟수. 기본 3. 0 이면 재시도 없이 즉시 드롭. */
  fallbackMaxRetries?: number;
}
