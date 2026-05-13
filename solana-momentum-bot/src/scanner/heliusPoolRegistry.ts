import type { DexScreenerPair } from './dexScreenerClient';
import type { TokenPairResolver } from './tokenPairResolver';
import type { ObservedPairCandidate } from '../utils/observedPair';

export interface ObservedPairContext {
  tokenAddress: string;
  pairAddress: string;
  dexId?: string;
  discoverySource?: string;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  pairCreatedAt?: number;
  liquidityUsd?: number;
  marketCap?: number;
}

/**
 * HeliusPoolRegistry — 실시간/온체인 경로에서 확인한 pair metadata를 내부 캐시에 축적한다.
 */
export class HeliusPoolRegistry implements TokenPairResolver {
  private readonly pairsByToken = new Map<string, Map<string, DexScreenerPair>>();
  private readonly contextsByToken = new Map<string, Map<string, ObservedPairContext>>();

  async getTokenPairs(tokenAddress: string): Promise<DexScreenerPair[]> {
    const pairs = this.pairsByToken.get(tokenAddress);
    if (!pairs) return [];

    return [...pairs.values()].sort((left, right) =>
      (right.liquidity?.usd || 0) - (left.liquidity?.usd || 0)
      || (right.volume?.h24 || 0) - (left.volume?.h24 || 0)
      || left.pairAddress.localeCompare(right.pairAddress)
    );
  }

  async getBestPoolAddress(tokenMint: string): Promise<string | null> {
    const pairs = await this.getTokenPairs(tokenMint);
    return pairs[0]?.pairAddress ?? null;
  }

  getObservedPairContexts(tokenAddress: string): ObservedPairContext[] {
    const contexts = this.contextsByToken.get(tokenAddress);
    if (!contexts) return [];
    return [...contexts.values()].sort((left, right) =>
      right.lastObservedAtMs - left.lastObservedAtMs
      || left.pairAddress.localeCompare(right.pairAddress)
    );
  }

  upsertPairs(pairs: DexScreenerPair[]): void {
    for (const pair of pairs) {
      this.upsertPair(pair);
    }
  }

  upsertPair(pair: DexScreenerPair): void {
    this.upsertTokenPair(pair.baseToken.address, pair);
    this.upsertTokenPair(pair.quoteToken.address, pair);
  }

  upsertObservedPair(candidate: ObservedPairCandidate): void {
    if (!candidate.pairAddress || !candidate.baseTokenAddress || !candidate.quoteTokenAddress) {
      return;
    }

    const existing = this.findExistingPair(candidate.baseTokenAddress, candidate.pairAddress)
      ?? this.findExistingPair(candidate.quoteTokenAddress, candidate.pairAddress);

    const merged: DexScreenerPair = {
      chainId: 'solana',
      dexId: candidate.dexId || existing?.dexId || '',
      pairAddress: candidate.pairAddress,
      baseToken: {
        address: candidate.baseTokenAddress,
        name: existing?.baseToken.name || candidate.baseTokenSymbol || '',
        symbol: candidate.baseTokenSymbol || existing?.baseToken.symbol || '',
      },
      quoteToken: {
        address: candidate.quoteTokenAddress,
        name: existing?.quoteToken.name || candidate.quoteTokenSymbol || '',
        symbol: candidate.quoteTokenSymbol || existing?.quoteToken.symbol || '',
      },
      priceUsd: candidate.priceUsd ?? existing?.priceUsd ?? 0,
      liquidity: {
        usd: candidate.liquidityUsd ?? existing?.liquidity.usd ?? 0,
        base: existing?.liquidity.base ?? 0,
        quote: existing?.liquidity.quote ?? 0,
      },
      volume: {
        h24: candidate.volume24hUsd ?? existing?.volume.h24,
      },
      priceChange: existing?.priceChange ?? {},
      txns: {
        h24: {
          buys: candidate.buys24h ?? existing?.txns.h24?.buys ?? 0,
          sells: candidate.sells24h ?? existing?.txns.h24?.sells ?? 0,
        },
      },
      marketCap: candidate.marketCap ?? existing?.marketCap,
      fdv: candidate.fdv ?? existing?.fdv,
      pairCreatedAt: candidate.pairCreatedAt ?? existing?.pairCreatedAt,
    };

    this.upsertPair(merged);
    this.upsertObservedPairContext(candidate.baseTokenAddress, candidate);
    this.upsertObservedPairContext(candidate.quoteTokenAddress, candidate);
  }

  clearToken(tokenAddress: string): void {
    this.pairsByToken.delete(tokenAddress);
  }

  listPairs(): DexScreenerPair[] {
    const deduped = new Map<string, DexScreenerPair>();
    for (const pairs of this.pairsByToken.values()) {
      for (const pair of pairs.values()) {
        if (!deduped.has(pair.pairAddress)) {
          deduped.set(pair.pairAddress, pair);
        }
      }
    }
    return [...deduped.values()].sort((left, right) =>
      (right.liquidity?.usd || 0) - (left.liquidity?.usd || 0)
      || (right.volume?.h24 || 0) - (left.volume?.h24 || 0)
      || left.pairAddress.localeCompare(right.pairAddress)
    );
  }

  private upsertTokenPair(tokenAddress: string, pair: DexScreenerPair): void {
    if (!tokenAddress) return;

    const existingPairs = this.pairsByToken.get(tokenAddress) ?? new Map<string, DexScreenerPair>();
    existingPairs.set(pair.pairAddress, pair);
    this.pairsByToken.set(tokenAddress, existingPairs);
  }

  private upsertObservedPairContext(tokenAddress: string, candidate: ObservedPairCandidate): void {
    if (!tokenAddress || !candidate.pairAddress) return;
    const observedAtMs = candidate.observedAtMs ?? Date.now();
    const contexts = this.contextsByToken.get(tokenAddress) ?? new Map<string, ObservedPairContext>();
    const existing = contexts.get(candidate.pairAddress);
    contexts.set(candidate.pairAddress, {
      tokenAddress,
      pairAddress: candidate.pairAddress,
      dexId: candidate.dexId ?? existing?.dexId,
      discoverySource: candidate.discoverySource ?? existing?.discoverySource,
      firstObservedAtMs: existing
        ? Math.min(existing.firstObservedAtMs, observedAtMs)
        : observedAtMs,
      lastObservedAtMs: Math.max(existing?.lastObservedAtMs ?? 0, observedAtMs),
      pairCreatedAt: candidate.pairCreatedAt ?? existing?.pairCreatedAt,
      liquidityUsd: candidate.liquidityUsd ?? existing?.liquidityUsd,
      marketCap: candidate.marketCap ?? existing?.marketCap,
    });
    this.contextsByToken.set(tokenAddress, contexts);
  }

  private findExistingPair(tokenAddress: string, pairAddress: string): DexScreenerPair | null {
    return this.pairsByToken.get(tokenAddress)?.get(pairAddress) ?? null;
  }
}
