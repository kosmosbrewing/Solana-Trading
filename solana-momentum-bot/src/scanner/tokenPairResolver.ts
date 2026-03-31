import type { DexScreenerPair } from './dexScreenerClient';

export interface TokenPairLookupClient {
  getTokenPairs(tokenAddress: string): Promise<DexScreenerPair[]>;
}

export interface BestPoolAddressResolver {
  getBestPoolAddress(tokenMint: string): Promise<string | null>;
}

export type TokenPairResolver = TokenPairLookupClient & BestPoolAddressResolver;

/**
 * Composite resolver — 내부 registry를 우선 사용하고, 미스된 pair는 외부 API로 보완한다.
 */
export class CompositeTokenPairResolver implements TokenPairResolver {
  constructor(
    private readonly primary: TokenPairLookupClient,
    private readonly fallback?: TokenPairLookupClient | null
  ) {}

  async getTokenPairs(tokenAddress: string): Promise<DexScreenerPair[]> {
    const primaryPairs = await this.primary.getTokenPairs(tokenAddress);
    if (primaryPairs.length > 0 || !this.fallback) {
      return rankPairs(primaryPairs);
    }

    const fallbackPairs = await this.fallback.getTokenPairs(tokenAddress);
    return mergePairs(primaryPairs, fallbackPairs);
  }

  async getBestPoolAddress(tokenMint: string): Promise<string | null> {
    const pairs = await this.getTokenPairs(tokenMint);
    return pairs[0]?.pairAddress ?? null;
  }
}

function mergePairs(primary: DexScreenerPair[], fallback: DexScreenerPair[]): DexScreenerPair[] {
  const merged = new Map<string, DexScreenerPair>();
  for (const pair of [...primary, ...fallback]) {
    const existing = merged.get(pair.pairAddress);
    if (!existing || comparePairs(pair, existing) < 0) {
      merged.set(pair.pairAddress, pair);
    }
  }
  return rankPairs([...merged.values()]);
}

function rankPairs(pairs: DexScreenerPair[]): DexScreenerPair[] {
  return [...pairs].sort(comparePairs);
}

function comparePairs(left: DexScreenerPair, right: DexScreenerPair): number {
  return (right.liquidity?.usd || 0) - (left.liquidity?.usd || 0)
    || (right.volume?.h24 || 0) - (left.volume?.h24 || 0)
    || left.pairAddress.localeCompare(right.pairAddress);
}
