import { SOL_MINT } from '../utils/constants';
import { ORCA_WHIRLPOOL_PROGRAM, RAYDIUM_CLMM_PROGRAM, RAYDIUM_V4_PROGRAM } from './swapParser';

export interface RealtimePairCandidate {
  dexId: string;
  pairAddress: string;
  baseToken?: { address: string; symbol?: string };
  quoteToken?: { address: string; symbol?: string };
  liquidity?: { usd: number };
}

export interface RealtimeEligibilityResult<T extends RealtimePairCandidate> {
  eligible: boolean;
  pair?: T;
  reason: string;
}

export const SUPPORTED_REALTIME_DEX_IDS = new Set(['raydium', 'orca']);
export const SUPPORTED_REALTIME_POOL_PROGRAMS = new Map<string, Set<string>>([
  ['raydium', new Set([RAYDIUM_V4_PROGRAM, RAYDIUM_CLMM_PROGRAM])],
  ['orca', new Set([ORCA_WHIRLPOOL_PROGRAM])],
]);

export function selectRealtimeEligiblePair<T extends RealtimePairCandidate>(
  pairs: T[],
  poolOwners?: Map<string, string | null>
): RealtimeEligibilityResult<T> {
  if (pairs.length === 0) {
    return { eligible: false, reason: 'no_pairs' };
  }

  const supportedDexPairs = pairs.filter((pair) => SUPPORTED_REALTIME_DEX_IDS.has(pair.dexId));
  if (supportedDexPairs.length === 0) {
    return { eligible: false, reason: 'unsupported_dex' };
  }

  const solQuotePairs = supportedDexPairs.filter((pair) => pair.quoteToken?.address === SOL_MINT);
  if (solQuotePairs.length === 0) {
    return { eligible: false, reason: 'non_sol_quote' };
  }

  const ranked = [...solQuotePairs].sort(
    (left, right) => (right.liquidity?.usd || 0) - (left.liquidity?.usd || 0)
  );

  if (poolOwners) {
    const ownerMatched = ranked.find((pair) => {
      const owner = poolOwners.get(pair.pairAddress);
      if (!owner) return false;
      return SUPPORTED_REALTIME_POOL_PROGRAMS.get(pair.dexId)?.has(owner) ?? false;
    });
    if (!ownerMatched) {
      return { eligible: false, reason: 'unsupported_pool_program' };
    }
    return {
      eligible: true,
      pair: ownerMatched,
      reason: 'eligible',
    };
  }

  return {
    eligible: true,
    pair: ranked[0],
    reason: 'eligible',
  };
}
