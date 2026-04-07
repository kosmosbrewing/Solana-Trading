import { RealtimePoolMetadata } from './types';

export const PUMP_SWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const PUMP_SWAP_DEX_IDS = ['pumpswap', 'pumpfun', 'pump-swap'] as const;

// Why: PumpSwap `buy(base_amount_out: u64, max_quote_amount_in: u64, ...)` 와
//   `sell(base_amount_in: u64, min_quote_amount_out: u64, ...)` 두 함수 모두 user intent
//   (slippage 상한/하한)을 인코딩하지, 실제 fill 수량/가격을 인코딩하지 않는다.
//   instruction payload offset 8/16에서 priceNative를 만들면 worst-case price ≈
//   expected × (1+s)/(1-s) 로 5×~30× 부풀어 PRICE_ANOMALY_BLOCK을 100% 만들었다
//   (docs/audits/price-anomaly-ratio-2026-04-08.md). 따라서 PumpSwap는 `parseFromPoolMetadata`
//   (preTokenBalances/postTokenBalances delta)만 신뢰하고, log 파서/instruction 파서는 모두 폐기.
//   동일한 이유로 `parsePumpSwapFromLogs` (raw 정수 + decimals 미보정)도 제거됨.

export function isPumpSwapDexId(dexId?: string | null): boolean {
  if (!dexId) return false;
  return PUMP_SWAP_DEX_IDS.includes(dexId.toLowerCase() as typeof PUMP_SWAP_DEX_IDS[number]);
}

export function isPumpSwapPool(metadata?: RealtimePoolMetadata): boolean {
  if (!metadata) return false;
  return metadata.poolProgram === PUMP_SWAP_PROGRAM || isPumpSwapDexId(metadata.dexId);
}
