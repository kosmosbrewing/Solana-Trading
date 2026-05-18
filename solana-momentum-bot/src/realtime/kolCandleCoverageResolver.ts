import type { DexScreenerPair } from '../scanner/dexScreenerClient';
import type { ObservedPairContext } from '../scanner/heliusPoolRegistry';
import { SOL_MINT } from '../utils/constants';
import type { RealtimePoolMetadata } from './types';

export type KolCandleCoveragePairSource = 'kol_tx_pool' | 'registry_context' | 'token_pair_resolver';

export interface KolCandleCoverageTarget {
  subscriptionPair: string;
  pairSource: KolCandleCoveragePairSource;
  metadata: RealtimePoolMetadata;
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
  if (input.poolAddress) {
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
