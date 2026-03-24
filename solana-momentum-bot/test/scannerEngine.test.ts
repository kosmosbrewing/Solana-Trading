import { ScannerEngine } from '../src/scanner/scannerEngine';
import { SocialMentionTracker } from '../src/scanner/socialMentionTracker';
import type { BirdeyeTrendingToken } from '../src/ingester/birdeyeClient';

describe('ScannerEngine social tracker wiring', () => {
  it('registers manual watchlist entries with the social mention tracker', () => {
    const socialMentionTracker = new SocialMentionTracker();
    const scanner = new ScannerEngine({
      geckoClient: {} as never,
      dexScreenerClient: null,
      maxWatchlistSize: 10,
      minWatchlistScore: 0,
      trendingPollIntervalMs: 60_000,
      geckoNewPoolIntervalMs: 60_000,
      dexDiscoveryIntervalMs: 60_000,
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
      dexScreenerClient: null,
      maxWatchlistSize: 2,
      minWatchlistScore: 0,
      trendingPollIntervalMs: 60_000,
      geckoNewPoolIntervalMs: 60_000,
      dexDiscoveryIntervalMs: 60_000,
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
      dexScreenerClient: null,
      maxWatchlistSize: 1,
      minWatchlistScore: 0,
      trendingPollIntervalMs: 60_000,
      geckoNewPoolIntervalMs: 60_000,
      dexDiscoveryIntervalMs: 60_000,
      dexEnrichIntervalMs: 60_000,
      laneAMinAgeSec: 3600,
      laneBMaxAgeSec: 1200,
      reentryCooldownMs: 60_000,
      minLiquidityUsd: 1000,
    });
    const discovered: string[] = [];
    scanner.on('candidateDiscovered', entry => discovered.push(entry.tokenMint));

    await scanner.start();
    const scannerInternal = scanner as unknown as { discoverFromTrending(): Promise<void> };
    await scannerInternal.discoverFromTrending();
    scanner.stop();

    expect(scanner.getWatchlist().map(entry => entry.tokenMint)).toEqual(['mint-b']);
    expect(discovered).toEqual(['mint-b']);
  });

  it('discovers candidates from Dex boosts even when trending is empty', async () => {
    const geckoClient = {
      getTrendingTokens: jest.fn().mockResolvedValue([]),
    };
    const dexScreenerClient = {
      getLatestTokenProfiles: jest.fn().mockResolvedValue([]),
      getLatestCommunityTakeovers: jest.fn().mockResolvedValue([]),
      getLatestAds: jest.fn().mockResolvedValue([]),
      getLatestBoosts: jest.fn().mockResolvedValue([
        { tokenAddress: 'mint-boost', chainId: 'solana', amount: 150, totalAmount: 150 },
      ]),
      getTopBoosts: jest.fn().mockResolvedValue([]),
      getTokenPairs: jest.fn().mockResolvedValue([
        {
          chainId: 'solana',
          dexId: 'raydium',
          pairAddress: 'pair-boost',
          baseToken: { address: 'mint-boost', name: 'Boosted', symbol: 'BST' },
          quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' },
          priceUsd: 0.12,
          liquidity: { usd: 80_000, base: 1000, quote: 1000 },
          volume: { h24: 250_000 },
          priceChange: { h24: 35 },
          txns: { h24: { buys: 12, sells: 4 } },
          marketCap: 400_000,
          pairCreatedAt: Date.now() - 5 * 60 * 1000,
        },
      ]),
      getTokenOrders: jest.fn().mockResolvedValue([{ type: 'boost', status: 'active' }]),
    };
    const scanner = new ScannerEngine({
      geckoClient: geckoClient as never,
      dexScreenerClient: dexScreenerClient as never,
      maxWatchlistSize: 10,
      minWatchlistScore: 0,
      trendingPollIntervalMs: 60_000,
      geckoNewPoolIntervalMs: 60_000,
      dexDiscoveryIntervalMs: 60_000,
      dexEnrichIntervalMs: 60_000,
      laneAMinAgeSec: 3600,
      laneBMaxAgeSec: 1200,
      minLiquidityUsd: 1000,
    });
    const discovered: string[] = [];
    scanner.on('candidateDiscovered', entry => discovered.push(entry.tokenMint));

    await scanner.start();
    scanner.stop();

    expect(scanner.getWatchlist().map(entry => entry.tokenMint)).toContain('mint-boost');
    expect(discovered).toContain('mint-boost');
    expect(dexScreenerClient.getTokenPairs).toHaveBeenCalledWith('mint-boost');
  });

  it('discovers candidates from Gecko new pools before trending fallback', async () => {
    const geckoClient = {
      getNewPoolTokens: jest.fn().mockResolvedValue([
        makeToken('mint-new', 'NEW', 1, 125_000, 75_000, {
          discovery_source: 'gecko_new_pool',
          pool_created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        }),
      ]),
      getTrendingTokens: jest.fn().mockResolvedValue([]),
    };
    const scanner = new ScannerEngine({
      geckoClient: geckoClient as never,
      dexScreenerClient: null,
      maxWatchlistSize: 10,
      minWatchlistScore: 0,
      trendingPollIntervalMs: 60_000,
      geckoNewPoolIntervalMs: 60_000,
      dexDiscoveryIntervalMs: 60_000,
      dexEnrichIntervalMs: 60_000,
      laneAMinAgeSec: 3600,
      laneBMaxAgeSec: 1200,
      minLiquidityUsd: 1000,
    });

    await scanner.start();
    scanner.stop();

    expect(scanner.getWatchlist().map(entry => entry.tokenMint)).toContain('mint-new');
    expect(scanner.getEntry('mint-new')?.discoverySource).toBe('gecko_new_pool');
    expect(geckoClient.getNewPoolTokens).toHaveBeenCalledWith(20);
  });

  it('discovers candidates from latest Dex token profiles when trending is empty', async () => {
    const geckoClient = {
      getTrendingTokens: jest.fn().mockResolvedValue([]),
    };
    const dexScreenerClient = {
      getLatestTokenProfiles: jest.fn().mockResolvedValue([
        { tokenAddress: 'mint-profile', chainId: 'solana', url: 'https://dexscreener.com/solana/mint-profile' },
      ]),
      getLatestCommunityTakeovers: jest.fn().mockResolvedValue([]),
      getLatestAds: jest.fn().mockResolvedValue([]),
      getLatestBoosts: jest.fn().mockResolvedValue([]),
      getTopBoosts: jest.fn().mockResolvedValue([]),
      getTokenPairs: jest.fn().mockResolvedValue([
        {
          chainId: 'solana',
          dexId: 'raydium',
          pairAddress: 'pair-profile',
          baseToken: { address: 'mint-profile', name: 'Profiled', symbol: 'PRF' },
          quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' },
          priceUsd: 0.05,
          liquidity: { usd: 45_000, base: 1000, quote: 1000 },
          volume: { h24: 80_000 },
          priceChange: { h24: 12 },
          txns: { h24: { buys: 8, sells: 3 } },
          marketCap: 300_000,
          pairCreatedAt: Date.now() - 4 * 60 * 1000,
        },
      ]),
      getTokenOrders: jest.fn().mockResolvedValue([]),
    };
    const scanner = new ScannerEngine({
      geckoClient: geckoClient as never,
      dexScreenerClient: dexScreenerClient as never,
      maxWatchlistSize: 10,
      minWatchlistScore: 0,
      trendingPollIntervalMs: 60_000,
      geckoNewPoolIntervalMs: 60_000,
      dexDiscoveryIntervalMs: 60_000,
      dexEnrichIntervalMs: 60_000,
      laneAMinAgeSec: 3600,
      laneBMaxAgeSec: 1200,
      minLiquidityUsd: 1000,
    });
    const discovered: string[] = [];
    scanner.on('candidateDiscovered', entry => discovered.push(entry.tokenMint));

    await scanner.start();
    scanner.stop();

    expect(scanner.getWatchlist().map(entry => entry.tokenMint)).toContain('mint-profile');
    expect(discovered).toContain('mint-profile');
    expect(dexScreenerClient.getLatestTokenProfiles).toHaveBeenCalled();
    expect(dexScreenerClient.getTokenPairs).toHaveBeenCalledWith('mint-profile');
  });

  it('polls Dex discovery on its own cadence', async () => {
    jest.useFakeTimers();
    try {
      const geckoClient = {
        getNewPoolTokens: jest.fn().mockResolvedValue([]),
        getTrendingTokens: jest.fn().mockResolvedValue([]),
      };
    const dexScreenerClient = {
      getLatestTokenProfiles: jest.fn().mockResolvedValue([]),
      getLatestCommunityTakeovers: jest.fn().mockResolvedValue([]),
      getLatestAds: jest.fn().mockResolvedValue([]),
      getLatestBoosts: jest.fn().mockResolvedValue([]),
      getTopBoosts: jest.fn().mockResolvedValue([]),
      getTokenPairs: jest.fn().mockResolvedValue([]),
        getTokenOrders: jest.fn().mockResolvedValue([]),
      };
      const scanner = new ScannerEngine({
        geckoClient: geckoClient as never,
        dexScreenerClient: dexScreenerClient as never,
        maxWatchlistSize: 10,
        minWatchlistScore: 0,
        trendingPollIntervalMs: 60_000,
        geckoNewPoolIntervalMs: 10_000,
        dexDiscoveryIntervalMs: 10_000,
        dexEnrichIntervalMs: 60_000,
        laneAMinAgeSec: 3600,
        laneBMaxAgeSec: 1200,
        minLiquidityUsd: 1000,
      });

      await scanner.start();
      await jest.advanceTimersByTimeAsync(10_000);
      scanner.stop();

      expect(dexScreenerClient.getLatestBoosts).toHaveBeenCalledTimes(2);
      expect(dexScreenerClient.getLatestTokenProfiles).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('polls Gecko new pools separately from slower trending fallback', async () => {
    jest.useFakeTimers();
    try {
      const geckoClient = {
        getNewPoolTokens: jest.fn().mockResolvedValue([]),
        getTrendingTokens: jest.fn().mockResolvedValue([]),
      };
      const scanner = new ScannerEngine({
        geckoClient: geckoClient as never,
        dexScreenerClient: null,
        maxWatchlistSize: 10,
        minWatchlistScore: 0,
        trendingPollIntervalMs: 60_000,
        geckoNewPoolIntervalMs: 10_000,
        dexDiscoveryIntervalMs: 60_000,
        dexEnrichIntervalMs: 60_000,
        laneAMinAgeSec: 3600,
        laneBMaxAgeSec: 1200,
        minLiquidityUsd: 1000,
      });

      await scanner.start();
      await jest.advanceTimersByTimeAsync(10_000);
      scanner.stop();

      expect(geckoClient.getNewPoolTokens).toHaveBeenCalledTimes(2);
      expect(geckoClient.getTrendingTokens).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips trending fallback when Dex discovery already filled the watchlist', async () => {
    const geckoClient = {
      getTrendingTokens: jest.fn().mockResolvedValue([
        makeToken('mint-trending', 'TRN', 1, 1_000_000, 500_000),
      ]),
    };
    const dexScreenerClient = {
      getLatestTokenProfiles: jest.fn().mockResolvedValue([
        { tokenAddress: 'mint-profile', chainId: 'solana', url: 'https://dexscreener.com/solana/mint-profile' },
      ]),
      getLatestCommunityTakeovers: jest.fn().mockResolvedValue([]),
      getLatestAds: jest.fn().mockResolvedValue([]),
      getLatestBoosts: jest.fn().mockResolvedValue([]),
      getTopBoosts: jest.fn().mockResolvedValue([]),
      getTokenPairs: jest.fn().mockResolvedValue([
        {
          chainId: 'solana',
          dexId: 'raydium',
          pairAddress: 'pair-profile',
          baseToken: { address: 'mint-profile', name: 'Profiled', symbol: 'PRF' },
          quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' },
          priceUsd: 0.05,
          liquidity: { usd: 45_000, base: 1000, quote: 1000 },
          volume: { h24: 80_000 },
          priceChange: { h24: 12 },
          txns: { h24: { buys: 8, sells: 3 } },
          marketCap: 300_000,
          pairCreatedAt: Date.now() - 4 * 60 * 1000,
        },
      ]),
      getTokenOrders: jest.fn().mockResolvedValue([]),
    };
    const scanner = new ScannerEngine({
      geckoClient: geckoClient as never,
      dexScreenerClient: dexScreenerClient as never,
      maxWatchlistSize: 1,
      minWatchlistScore: 0,
      trendingPollIntervalMs: 60_000,
      geckoNewPoolIntervalMs: 60_000,
      dexDiscoveryIntervalMs: 60_000,
      dexEnrichIntervalMs: 60_000,
      laneAMinAgeSec: 3600,
      laneBMaxAgeSec: 1200,
      minLiquidityUsd: 1000,
    });

    await scanner.start();
    scanner.stop();

    expect(scanner.getWatchlist().map(entry => entry.tokenMint)).toEqual(['mint-profile']);
    expect(geckoClient.getTrendingTokens).not.toHaveBeenCalled();
  });

  it('discovers candidates from Dex community takeovers when trending is empty', async () => {
    const geckoClient = {
      getTrendingTokens: jest.fn().mockResolvedValue([]),
    };
    const dexScreenerClient = {
      getLatestTokenProfiles: jest.fn().mockResolvedValue([]),
      getLatestCommunityTakeovers: jest.fn().mockResolvedValue([
        {
          tokenAddress: 'mint-cto',
          chainId: 'solana',
          url: 'https://dexscreener.com/solana/mint-cto',
          claimDate: '2026-03-24T00:00:00.000Z',
        },
      ]),
      getLatestAds: jest.fn().mockResolvedValue([]),
      getLatestBoosts: jest.fn().mockResolvedValue([]),
      getTopBoosts: jest.fn().mockResolvedValue([]),
      getTokenPairs: jest.fn().mockResolvedValue([
        {
          chainId: 'solana',
          dexId: 'raydium',
          pairAddress: 'pair-cto',
          baseToken: { address: 'mint-cto', name: 'Takeover', symbol: 'CTO' },
          quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' },
          priceUsd: 0.07,
          liquidity: { usd: 55_000, base: 1000, quote: 1000 },
          volume: { h24: 90_000 },
          priceChange: { h24: 18 },
          txns: { h24: { buys: 9, sells: 4 } },
          marketCap: 350_000,
          pairCreatedAt: Date.now() - 4 * 60 * 1000,
        },
      ]),
      getTokenOrders: jest.fn().mockResolvedValue([]),
    };
    const scanner = new ScannerEngine({
      geckoClient: geckoClient as never,
      dexScreenerClient: dexScreenerClient as never,
      maxWatchlistSize: 10,
      minWatchlistScore: 0,
      trendingPollIntervalMs: 60_000,
      geckoNewPoolIntervalMs: 60_000,
      dexDiscoveryIntervalMs: 60_000,
      dexEnrichIntervalMs: 60_000,
      laneAMinAgeSec: 3600,
      laneBMaxAgeSec: 1200,
      minLiquidityUsd: 1000,
    });

    await scanner.start();
    scanner.stop();

    expect(scanner.getWatchlist().map(entry => entry.tokenMint)).toContain('mint-cto');
    expect(dexScreenerClient.getLatestCommunityTakeovers).toHaveBeenCalled();
    expect(dexScreenerClient.getTokenPairs).toHaveBeenCalledWith('mint-cto');
  });

  it('discovers candidates from Dex ads when trending is empty', async () => {
    const geckoClient = {
      getTrendingTokens: jest.fn().mockResolvedValue([]),
    };
    const dexScreenerClient = {
      getLatestTokenProfiles: jest.fn().mockResolvedValue([]),
      getLatestCommunityTakeovers: jest.fn().mockResolvedValue([]),
      getLatestAds: jest.fn().mockResolvedValue([
        {
          tokenAddress: 'mint-ad',
          chainId: 'solana',
          url: 'https://dexscreener.com/solana/mint-ad',
          date: '2026-03-24T00:00:00.000Z',
          type: 'tokenAd',
          durationHours: 4,
          impressions: 1234,
        },
      ]),
      getLatestBoosts: jest.fn().mockResolvedValue([]),
      getTopBoosts: jest.fn().mockResolvedValue([]),
      getTokenPairs: jest.fn().mockResolvedValue([
        {
          chainId: 'solana',
          dexId: 'raydium',
          pairAddress: 'pair-ad',
          baseToken: { address: 'mint-ad', name: 'Advertised', symbol: 'ADV' },
          quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' },
          priceUsd: 0.09,
          liquidity: { usd: 60_000, base: 1000, quote: 1000 },
          volume: { h24: 95_000 },
          priceChange: { h24: 16 },
          txns: { h24: { buys: 10, sells: 5 } },
          marketCap: 375_000,
          pairCreatedAt: Date.now() - 3 * 60 * 1000,
        },
      ]),
      getTokenOrders: jest.fn().mockResolvedValue([]),
    };
    const scanner = new ScannerEngine({
      geckoClient: geckoClient as never,
      dexScreenerClient: dexScreenerClient as never,
      maxWatchlistSize: 10,
      minWatchlistScore: 0,
      trendingPollIntervalMs: 60_000,
      geckoNewPoolIntervalMs: 60_000,
      dexDiscoveryIntervalMs: 60_000,
      dexEnrichIntervalMs: 60_000,
      laneAMinAgeSec: 3600,
      laneBMaxAgeSec: 1200,
      minLiquidityUsd: 1000,
    });

    await scanner.start();
    scanner.stop();

    expect(scanner.getWatchlist().map(entry => entry.tokenMint)).toContain('mint-ad');
    expect(dexScreenerClient.getLatestAds).toHaveBeenCalled();
    expect(dexScreenerClient.getTokenPairs).toHaveBeenCalledWith('mint-ad');
  });
});

function makeToken(
  address: string,
  symbol: string,
  rank: number,
  volume24hUsd: number,
  liquidityUsd: number,
  raw: Record<string, unknown> = {}
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
      ...raw,
    },
  };
}
