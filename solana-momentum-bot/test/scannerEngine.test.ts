import { ScannerEngine } from '../src/scanner/scannerEngine';
import { SocialMentionTracker } from '../src/scanner/socialMentionTracker';
import type { BirdeyeTrendingToken } from '../src/ingester/birdeyeClient';

describe('ScannerEngine social tracker wiring', () => {
  it('registers manual watchlist entries with the social mention tracker', () => {
    const socialMentionTracker = new SocialMentionTracker();
    const scanner = new ScannerEngine({
      geckoClient: {} as never,
      birdeyeWS: null,
      dexScreenerClient: null,
      maxWatchlistSize: 10,
      minWatchlistScore: 0,
      trendingPollIntervalMs: 60_000,
      dexEnrichIntervalMs: 60_000,
      laneAMinAgeSec: 3600,
      laneBMaxAgeSec: 1200,
      minLiquidityUsd: 1000,
      socialMentionTracker,
    });

    scanner.addManualEntry('mint-1', 'pair-1', 'TEST');

    expect(socialMentionTracker.getTrackedTokenCount()).toBe(1);
  });

  it('emits discovered events only for candidates that survive pruning', async () => {
    const geckoClient = {
      getTrendingTokens: jest.fn().mockResolvedValue([
        makeToken('mint-a', 'AAA', 2, 1_000_000, 500_000),
        makeToken('mint-b', 'BBB', 5, 500_000, 200_000),
        makeToken('mint-c', 'CCC', 20, 10_000, 50_000),
      ]),
    };
    const scanner = new ScannerEngine({
      geckoClient: geckoClient as never,
      birdeyeWS: null,
      dexScreenerClient: null,
      maxWatchlistSize: 2,
      minWatchlistScore: 0,
      trendingPollIntervalMs: 60_000,
      dexEnrichIntervalMs: 60_000,
      laneAMinAgeSec: 3600,
      laneBMaxAgeSec: 1200,
      reentryCooldownMs: 60_000,
      minLiquidityUsd: 1000,
    });
    const discovered: string[] = [];
    scanner.on('candidateDiscovered', entry => discovered.push(entry.tokenMint));

    await scanner.start();
    scanner.stop();

    expect(scanner.getWatchlist().map(entry => entry.tokenMint)).toEqual(['mint-a', 'mint-b']);
    expect(discovered).toEqual(['mint-a', 'mint-b']);
  });

  it('blocks immediate re-entry for recently evicted candidates', async () => {
    const geckoClient = {
      getTrendingTokens: jest.fn()
        .mockResolvedValueOnce([
          makeToken('mint-a', 'AAA', 10, 100_000, 100_000),
          makeToken('mint-b', 'BBB', 2, 1_000_000, 500_000),
        ])
        .mockResolvedValueOnce([
          makeToken('mint-a', 'AAA', 1, 1_000_000, 500_000),
        ]),
    };
    const scanner = new ScannerEngine({
      geckoClient: geckoClient as never,
      birdeyeWS: null,
      dexScreenerClient: null,
      maxWatchlistSize: 1,
      minWatchlistScore: 0,
      trendingPollIntervalMs: 60_000,
      dexEnrichIntervalMs: 60_000,
      laneAMinAgeSec: 3600,
      laneBMaxAgeSec: 1200,
      reentryCooldownMs: 60_000,
      minLiquidityUsd: 1000,
    });
    const discovered: string[] = [];
    scanner.on('candidateDiscovered', entry => discovered.push(entry.tokenMint));

    await scanner.start();
    await (scanner as any).discoverFromTrending();
    scanner.stop();

    expect(scanner.getWatchlist().map(entry => entry.tokenMint)).toEqual(['mint-b']);
    expect(discovered).toEqual(['mint-b']);
  });
});

function makeToken(
  address: string,
  symbol: string,
  rank: number,
  volume24hUsd: number,
  liquidityUsd: number
): BirdeyeTrendingToken {
  return {
    address,
    symbol,
    rank,
    volume24hUsd,
    liquidityUsd,
    priceChange24hPct: 30,
    updatedAt: new Date().toISOString(),
    source: 'token_trending',
    raw: {
      pool_created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      buys_24h: 10,
      sells_24h: 5,
    },
  };
}
