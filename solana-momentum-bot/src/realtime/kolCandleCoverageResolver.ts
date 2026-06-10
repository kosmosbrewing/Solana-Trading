import type { DexScreenerPair } from '../scanner/dexScreenerClient';
import type { ObservedPairContext } from '../scanner/heliusPoolRegistry';
import { SOL_MINT } from '../utils/constants';
import { isWsSupportedPoolProgram } from './realtimeEligibility';
import type { RealtimePoolMetadata } from './types';

export type KolCandleCoveragePairSource = 'kol_tx_pool' | 'registry_context' | 'token_pair_resolver';

export interface KolCandleCoverageTarget {
  subscriptionPair: string;
  pairSource: KolCandleCoveragePairSource;
  metadata: RealtimePoolMetadata;
}

export function formatKolCandleCoverageMissDetail(input: {
  reason: string;
  poolAddress?: string;
  dexId?: string;
  dexProgram?: string;
  inputMint?: string;
  outputMint?: string;
  contexts: ObservedPairContext[];
  resolvedPairs: DexScreenerPair[];
  resolverReason?: string | null;
}): string {
  const resolvedDexIds = dedupe(input.resolvedPairs.map((pair) => pair.dexId || 'unknown'));
  const contextDexIds = dedupe(input.contexts.map((context) => context.dexId || 'unknown'));
  const samplePair = input.resolvedPairs[0]?.pairAddress ?? input.contexts[0]?.pairAddress;
  const fields = [
    `reason=${input.reason}`,
    `requestPool=${input.poolAddress ? short(input.poolAddress) : 'missing'}`,
    `requestDex=${input.dexId || 'unknown'}`,
    `requestProgram=${input.dexProgram ? short(input.dexProgram) : 'unknown'}`,
    `input=${input.inputMint ? short(input.inputMint) : 'unknown'}`,
    `output=${input.outputMint ? short(input.outputMint) : 'unknown'}`,
    `contexts=${input.contexts.length}`,
    `contextDex=${contextDexIds.slice(0, 3).join(',') || 'none'}`,
    `resolvedPairs=${input.resolvedPairs.length}`,
    `resolvedDex=${resolvedDexIds.slice(0, 3).join(',') || 'none'}`,
    `resolverReason=${input.resolverReason ?? 'no_context'}`,
    samplePair ? `samplePair=${short(samplePair)}` : undefined,
  ].filter(Boolean);
  return fields.join(' ');
}

export function shouldSeedKolCandleCoverage(input: {
  alreadyTracking: boolean;
  globalSeedBackfillEnabled: boolean;
}): boolean {
  // KOL coverage is policy evidence for admission. It must not inherit the broad
  // bootstrap seed toggle; otherwise pre-entry candle windows stay empty in live.
  void input.globalSeedBackfillEnabled;
  return !input.alreadyTracking;
}

export function buildKolCandleCoverageTarget(input: {
  tokenMint: string;
  poolAddress?: string;
  dexId?: string;
  dexProgram?: string;
  inputMint?: string;
  outputMint?: string;
  contexts: ObservedPairContext[];
  resolvedPair?: DexScreenerPair;
}): KolCandleCoverageTarget | null {
  // 2026-06-10 (coverage repair lever 1): kol_tx_pool 직행은 WS candle parser 가
  // 해석 가능한 프로그램일 때만. 미지원 프로그램 (pump.fun bonding curve 등) pool 을
  // 구독하면 candle 0 인 채 capacity slot 만 소모한다 — registry/resolver 경로로 fall through.
  if (input.poolAddress && isWsSupportedPoolProgram(input.dexProgram)) {
    return {
      subscriptionPair: input.poolAddress,
      pairSource: 'kol_tx_pool',
      metadata: buildMetadataFromRequest(input),
    };
  }

  const context = input.contexts[0];
  if (context) {
    return {
      subscriptionPair: context.pairAddress,
      pairSource: 'registry_context',
      metadata: buildMetadataFromContext(input, context),
    };
  }

  if (input.resolvedPair) {
    return {
      subscriptionPair: input.resolvedPair.pairAddress,
      pairSource: 'token_pair_resolver',
      metadata: buildMetadataFromPair(input.tokenMint, input.resolvedPair, input.dexProgram),
    };
  }

  return null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function short(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function buildMetadataFromRequest(input: {
  tokenMint: string;
  dexId?: string;
  dexProgram?: string;
  inputMint?: string;
  outputMint?: string;
}): RealtimePoolMetadata {
  const quoteMint = input.inputMint && input.inputMint !== input.tokenMint
    ? input.inputMint
    : SOL_MINT;
  return {
    dexId: input.dexId ?? '',
    baseMint: input.tokenMint,
    quoteMint,
    quoteDecimals: quoteMint === SOL_MINT ? 9 : undefined,
    poolProgram: input.dexProgram,
  };
}

function buildMetadataFromContext(
  input: { tokenMint: string; inputMint?: string; dexProgram?: string },
  context: ObservedPairContext
): RealtimePoolMetadata {
  const quoteMint = input.inputMint && input.inputMint !== input.tokenMint
    ? input.inputMint
    : SOL_MINT;
  return {
    dexId: context.dexId ?? '',
    baseMint: input.tokenMint,
    quoteMint,
    quoteDecimals: quoteMint === SOL_MINT ? 9 : undefined,
    poolProgram: input.dexProgram,
  };
}

function buildMetadataFromPair(
  tokenMint: string,
  pair: DexScreenerPair,
  dexProgram?: string
): RealtimePoolMetadata {
  const baseMint = pair.baseToken.address || tokenMint;
  const quoteMint = pair.quoteToken.address || SOL_MINT;
  return {
    dexId: pair.dexId,
    baseMint,
    quoteMint,
    baseDecimals: undefined,
    quoteDecimals: quoteMint === SOL_MINT ? 9 : undefined,
    poolProgram: dexProgram,
  };
}
