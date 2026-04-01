import { InternalCandleSource } from '../candle';
import type { BirdeyeTrendingToken } from '../ingester/birdeyeClient';
import { HeliusPoolRegistry } from '../scanner/heliusPoolRegistry';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('InternalTrendingTokenProvider');
const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface InternalTrendingTokenProviderConfig {
  intervalSec?: number;
  lookbackBars?: number;
  maxCandidateAgeMs?: number;
}

interface RankedCandidate {
  token: BirdeyeTrendingToken;
  score: number;
}

/**
 * InternalTrendingTokenProvider — 내부 registry + candle data로 activity 후보를 생성한다.
 */
export class InternalTrendingTokenProvider {
  private readonly candidatePoolLimit: number;
  private readonly intervalSec: number;
  private readonly lookbackBars: number;
  private readonly maxCandidateAgeMs: number;

  constructor(
    private readonly registry: HeliusPoolRegistry,
    private readonly candleSource: InternalCandleSource,
    config: InternalTrendingTokenProviderConfig = {}
  ) {
    this.candidatePoolLimit = Math.max(25, (config.lookbackBars ?? 12) * 5);
    this.intervalSec = config.intervalSec ?? 300;
    this.lookbackBars = Math.max(3, config.lookbackBars ?? 12);
    this.maxCandidateAgeMs = config.maxCandidateAgeMs ?? 90 * 60_000;
  }

  async getTrendingTokens(limit: number): Promise<BirdeyeTrendingToken[]> {
    const candidates: Array<RankedCandidate | null> = await Promise.all(
      this.registry.listPairs().slice(0, Math.max(limit * 5, this.candidatePoolLimit)).map(async (pair) => {
      const token = resolveTrackedToken(pair.baseToken.address, pair.quoteToken.address)
        ? pair.baseToken
        : pair.quoteToken;
      const tokenMint = token.address;
      if (!tokenMint || tokenMint === SOL_MINT) return null;

      const candles = await this.loadRecentCandles(pair);
      if (candles.length < 3) return null;

      const latest = candles[candles.length - 1];
      const latestTimestampMs = latest.timestamp.getTime();
      if (!Number.isFinite(latestTimestampMs) || Date.now() - latestTimestampMs > this.maxCandidateAgeMs) {
        return null;
      }

      const first = candles[0];
      const priceChangePct = first.open > 0
        ? ((latest.close - first.open) / first.open) * 100
        : 0;
      const recentVolume = candles.reduce((sum, candle) => sum + candle.volume, 0);
      const recentTradeCount = candles.reduce((sum, candle) => sum + candle.tradeCount, 0);
      const liquidityUsd = pair.liquidity?.usd || 0;
      const volume24hUsd = pair.volume?.h24 ?? recentVolume;
      const score = (
        recentVolume
        + recentTradeCount * 500
        + Math.abs(priceChangePct) * 1_000
        + liquidityUsd * 0.05
      );

      return {
        score,
        token: {
          address: tokenMint,
          symbol: token.symbol,
          name: token.name,
          rank: 0,
          price: latest.close,
          priceChange24hPct: pair.priceChange?.h24 ?? priceChangePct,
          volume24hUsd,
          liquidityUsd,
          marketCap: pair.marketCap,
          updatedAt: latest.timestamp.toISOString(),
          source: 'token_trending' as const,
          raw: {
            discovery_source: 'internal_activity',
            dex_id: pair.dexId,
            pair_address: pair.pairAddress,
            base_token_address: pair.baseToken.address,
            quote_token_address: pair.quoteToken.address,
            pool_created_at: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : undefined,
            buys_24h: pair.txns?.h24?.buys,
            sells_24h: pair.txns?.h24?.sells,
            internal_recent_volume: recentVolume,
            internal_recent_trade_count: recentTradeCount,
            internal_activity_score: score,
          },
        },
      };
    })
    );

    const ranked = candidates.filter(isRankedCandidate);
    const tokens = ranked
      .sort((left, right) =>
        right.score - left.score
        || (right.token.liquidityUsd || 0) - (left.token.liquidityUsd || 0)
        || left.token.address.localeCompare(right.token.address)
      )
      .slice(0, limit)
      .map((entry, index) => ({
        ...entry.token,
        rank: index + 1,
      }));

    if (tokens.length > 0) {
      log.debug(`Generated ${tokens.length} internal activity candidates`);
    }

    return tokens;
  }

  private async loadRecentCandles(pair: {
    pairAddress: string;
    baseToken: { address: string };
    quoteToken: { address: string };
  }): Promise<import('../utils/types').Candle[]> {
    const candidateKeys = [
      pair.pairAddress,
      pair.baseToken.address,
      pair.quoteToken.address,
    ].filter((value, index, array) => value && value !== SOL_MINT && array.indexOf(value) === index);

    for (const key of candidateKeys) {
      const candles = await this.candleSource.getRecentCandles(
        key,
        this.intervalSec,
        this.lookbackBars
      );
      if (candles.length > 0) {
        return candles;
      }
    }

    return [];
  }
}

function resolveTrackedToken(baseTokenAddress: string, quoteTokenAddress: string): boolean {
  return baseTokenAddress !== SOL_MINT || quoteTokenAddress === SOL_MINT;
}

function isRankedCandidate(entry: RankedCandidate | null): entry is RankedCandidate {
  return entry !== null;
}
