import type { BirdeyeTrendingToken } from '../ingester/birdeyeClient';

export interface TrendingTokenProvider {
  getTrendingTokens(limit: number): Promise<BirdeyeTrendingToken[]>;
}

/**
 * CompositeTrendingTokenProvider — 내부 후보를 우선 사용하고,
 * 부족한 슬롯만 외부 provider로 채운다.
 */
export class CompositeTrendingTokenProvider implements TrendingTokenProvider {
  constructor(
    private readonly primary: TrendingTokenProvider,
    private readonly fallback?: TrendingTokenProvider | null
  ) {}

  async getTrendingTokens(limit: number): Promise<BirdeyeTrendingToken[]> {
    const primaryTokens = await this.primary.getTrendingTokens(limit);
    if (primaryTokens.length >= limit || !this.fallback) {
      return normalizeRanks(primaryTokens.slice(0, limit));
    }

    const fallbackTokens = await this.fallback.getTrendingTokens(limit);
    const merged = new Map<string, BirdeyeTrendingToken>();

    for (const token of [...primaryTokens, ...fallbackTokens]) {
      if (!token.address || merged.has(token.address)) continue;
      merged.set(token.address, token);
    }

    return normalizeRanks([...merged.values()].slice(0, limit));
  }
}

function normalizeRanks(tokens: BirdeyeTrendingToken[]): BirdeyeTrendingToken[] {
  return tokens.map((token, index) => ({
    ...token,
    rank: index + 1,
  }));
}
