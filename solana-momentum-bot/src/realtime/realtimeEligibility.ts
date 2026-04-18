import { SOL_MINT } from '../utils/constants';
import {
  isMeteoraDexId,
  METEORA_DAMM_V1_PROGRAM,
  METEORA_DAMM_V2_PROGRAM,
  METEORA_DLMM_PROGRAM,
} from './meteoraPrograms';
import {
  ORCA_WHIRLPOOL_PROGRAM,
  PUMP_SWAP_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  RAYDIUM_V4_PROGRAM,
} from './swapParser';
import { isPumpSwapDexId } from './pumpSwapParser';

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

export interface RealtimeDiscoveryCandidateMeta {
  dexId?: string | null;
  quoteTokenAddress?: string | null;
}

export interface RealtimePoolProgramCandidateMeta {
  dexId?: string | null;
  poolOwner?: string | null;
}

export type RealtimeAdmissionSkipDetail =
  | 'resolver_miss'
  | 'empty_pairs'
  | 'all_pairs_blocked'
  | 'unsupported_dex_after_lookup'
  | 'non_sol_quote_after_lookup'
  | 'unsupported_pool_program_after_lookup';

// Block 2 (2026-04-18): canonical DEX IDs (post-normalize).
// 실제 alias 허용은 `normalizeDexId` 에서 수행. 여기는 normalize 된 결과만 검사.
// 2026-04-18 Block 2 QA fix: normalize 함수가 항상 `raydium/orca/pumpswap/meteora` 중 하나로 압축하므로
// 이 set 에는 진짜 canonical 4개만 둔다. (이전: `pumpfun`, `pump-swap` 가 남아 있었음)
export const SUPPORTED_REALTIME_DEX_IDS = new Set([
  'raydium',
  'orca',
  'pumpswap',
  'meteora',
]);

// Block 2 (2026-04-18): Raydium 변형 태그 normalization.
// Raydium v4 / CLMM / CPMM / Launchpad / Launchlab 등 동일 프로그램군을 같은 'raydium' 으로.
const RAYDIUM_ALIAS_IDS = new Set([
  'raydium',
  'raydium-v4',
  'raydium_v4',
  'raydium-clmm',
  'raydium_clmm',
  'raydium-cpmm',
  'raydium_cpmm',
  'raydium-launchpad',
  'raydium-launchlab',
  'raydium-amm',
  'raydium_amm',
]);

const ORCA_ALIAS_IDS = new Set([
  'orca',
  'orca-whirlpool',
  'orca_whirlpool',
  'whirlpool',
]);
// 2026-04-18 Block 2 QA fix: map 은 normalize 된 canonical key 만 포함 (`pumpfun`, `pump-swap` 제거 — dead entries).
export const SUPPORTED_REALTIME_POOL_PROGRAMS = new Map<string, Set<string>>([
  ['raydium', new Set([RAYDIUM_V4_PROGRAM, RAYDIUM_CLMM_PROGRAM, RAYDIUM_CPMM_PROGRAM])],
  ['orca', new Set([ORCA_WHIRLPOOL_PROGRAM])],
  ['pumpswap', new Set([PUMP_SWAP_PROGRAM])],
  ['meteora', new Set([METEORA_DLMM_PROGRAM, METEORA_DAMM_V1_PROGRAM, METEORA_DAMM_V2_PROGRAM])],
]);

export function detectRealtimeDiscoveryMismatch(
  candidate: RealtimeDiscoveryCandidateMeta
): 'unsupported_dex' | 'non_sol_quote' | null {
  const normalizedDexId = candidate.dexId ? normalizeDexId(candidate.dexId) : undefined;
  if (normalizedDexId && !SUPPORTED_REALTIME_DEX_IDS.has(normalizedDexId)) {
    return 'unsupported_dex';
  }
  if (candidate.quoteTokenAddress && candidate.quoteTokenAddress !== SOL_MINT) {
    return 'non_sol_quote';
  }
  return null;
}

export function detectRealtimePoolProgramMismatch(
  candidate: RealtimePoolProgramCandidateMeta
): 'unsupported_pool_program' | null {
  const normalizedDexId = candidate.dexId ? normalizeDexId(candidate.dexId) : undefined;
  if (!normalizedDexId || !candidate.poolOwner) {
    return null;
  }
  const supportedPrograms = SUPPORTED_REALTIME_POOL_PROGRAMS.get(normalizedDexId);
  if (!supportedPrograms) {
    return null;
  }
  return supportedPrograms.has(candidate.poolOwner) ? null : 'unsupported_pool_program';
}

export function selectRealtimeEligiblePair<T extends RealtimePairCandidate>(
  pairs: T[],
  poolOwners?: Map<string, string | null>
): RealtimeEligibilityResult<T> {
  if (pairs.length === 0) {
    return { eligible: false, reason: 'no_pairs' };
  }

  const normalizedPairs = pairs.map((pair) => ({
    ...pair,
    dexId: normalizeDexId(pair.dexId),
  }));

  const supportedDexPairs = normalizedPairs.filter((pair) => SUPPORTED_REALTIME_DEX_IDS.has(pair.dexId));
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

export function classifyRealtimeAdmissionSkip<T extends RealtimePairCandidate>(input: {
  resolvedPairs: T[];
  admissionPairs: T[];
  result: RealtimeEligibilityResult<T>;
}): RealtimeAdmissionSkipDetail | undefined {
  if (input.result.eligible) return undefined;
  if (input.result.reason === 'no_pairs') {
    if (input.resolvedPairs.length === 0) return 'resolver_miss';
    return input.admissionPairs.length === 0 ? 'all_pairs_blocked' : 'empty_pairs';
  }
  if (input.result.reason === 'unsupported_dex') return 'unsupported_dex_after_lookup';
  if (input.result.reason === 'non_sol_quote') return 'non_sol_quote_after_lookup';
  if (input.result.reason === 'unsupported_pool_program') return 'unsupported_pool_program_after_lookup';
  return undefined;
}

export function buildRealtimeAdmissionSkipDetail<T extends RealtimePairCandidate>(input: {
  resolvedPairs: T[];
  admissionPairs: T[];
  result: RealtimeEligibilityResult<T>;
}): string | undefined {
  const base = classifyRealtimeAdmissionSkip(input);
  if (!base) return undefined;

  if (base === 'unsupported_dex_after_lookup') {
    const dexIds = dedupeNonEmpty(input.resolvedPairs.map((pair) => normalizeDexId(pair.dexId)));
    const samplePair = input.resolvedPairs[0]?.pairAddress;
    const fields = [
      `resolved=${input.resolvedPairs.length}`,
      `dex=${dexIds.slice(0, 3).join(',') || 'unknown'}`,
      samplePair ? `samplePair=${samplePair}` : undefined,
    ].filter(Boolean);
    return [base, ...fields].join('|');
  }

  if (base === 'all_pairs_blocked') {
    const dexIds = dedupeNonEmpty(input.resolvedPairs.map((pair) => normalizeDexId(pair.dexId)));
    const samplePair = input.resolvedPairs[0]?.pairAddress;
    const fields = [
      `resolved=${input.resolvedPairs.length}`,
      `admission=${input.admissionPairs.length}`,
      `dex=${dexIds.slice(0, 3).join(',') || 'unknown'}`,
      samplePair ? `samplePair=${samplePair}` : undefined,
    ].filter(Boolean);
    return [base, ...fields].join('|');
  }

  return base;
}

function normalizeDexId(dexId: string): string {
  const lower = dexId.toLowerCase();
  if (isMeteoraDexId(lower)) return 'meteora';
  if (isPumpSwapDexId(lower)) return 'pumpswap';
  if (RAYDIUM_ALIAS_IDS.has(lower)) return 'raydium';
  if (ORCA_ALIAS_IDS.has(lower)) return 'orca';
  return lower;
}

function dedupeNonEmpty(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
