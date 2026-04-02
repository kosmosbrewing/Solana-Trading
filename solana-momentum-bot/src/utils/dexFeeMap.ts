/**
 * DEX AMM Fee Map — dexId/poolProgram 기반 실제 fee 조회.
 *
 * Why: scanner가 ammFeePct를 populate하지 않으면 executionViability gate가
 * DEFAULT_AMM_FEE_PCT (0.5%) fallback을 사용하여 effectiveRR을 과소 평가.
 * 실제 PumpSwap/Raydium은 0.25%, Meteora DLMM은 0.30%.
 */

// Why: dexId는 DexScreener/GeckoTerminal에서 반환하는 문자열 (대소문자 혼재 가능)
const DEX_ID_FEE_MAP: Record<string, number> = {
  raydium: 0.0025,
  'raydium-cp': 0.0025,
  'raydium-clmm': 0.0025,
  pumpswap: 0.0025,
  'pump-swap': 0.0025,
  'pump.fun': 0.0025,
  orca: 0.003,
  'meteora-dlmm': 0.003,
  meteora: 0.003,
};

// Why: poolProgram은 on-chain account owner (Helius pool discovery에서 제공)
const POOL_PROGRAM_FEE_MAP: Record<string, number> = {
  // Raydium AMM v4
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 0.0025,
  // Raydium CLMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 0.0025,
  // Raydium CP (CPMM)
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 0.0025,
  // PumpSwap AMM
  'PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP': 0.0025,
  // Orca Whirlpool
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 0.003,
  // Meteora DLMM
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 0.003,
};

/**
 * dexId 또는 poolProgram으로 실제 AMM fee를 조회.
 * 둘 다 없거나 매칭 안 되면 fallback 반환.
 */
export function resolveAmmFeePct(
  dexId?: string,
  poolProgram?: string,
  fallback = 0.003
): number {
  if (dexId) {
    const fee = DEX_ID_FEE_MAP[dexId.toLowerCase()];
    if (fee !== undefined) return fee;
  }
  if (poolProgram) {
    const fee = POOL_PROGRAM_FEE_MAP[poolProgram];
    if (fee !== undefined) return fee;
  }
  return fallback;
}
