import { ScannerEngine } from '../src/scanner/scannerEngine';
import { SocialMentionTracker } from '../src/scanner/socialMentionTracker';
import { detectRealtimeDiscoveryMismatch } from '../src/realtime';
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

  it('skips realtime-ineligible candidates before they reach the watchlist', async () => {
    const geckoClient = {
      getTrendingTokens: jest.fn().mockResolvedValue([
        makeToken('mint-unsupported', 'BAD', 1, 300_000, 120_000, {
          dex_id: 'lifinity',
          quote_token_address: 'So11111111111111111111111111111111111111112',
        }),
        makeToken('mint-supported', 'GOOD', 2, 200_000, 100_000, {
          dex_id: 'raydium',
          quote_token_address: 'So11111111111111111111111111111111111111112',
        }),
      ]),
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
      candidateFilter: (token) => {
        const mismatch = detectRealtimeDiscoveryMismatch({
          dexId: typeof token.raw?.dex_id === 'string' ? token.raw.dex_id : undefined,
          quoteTokenAddress:
            typeof token.raw?.quote_token_address === 'string' ? token.raw.quote_token_address : undefined,
        });
        return mismatch ? { allowed: false, reason: mismatch } : { allowed: true };
      },
    });

    await scanner.start();
    scanner.stop();

    expect(scanner.getWatchlist().map(entry => entry.tokenMint)).toEqual(['mint-supported']);
  });

  it('supports async pre-watchlist filters for unsupported pool programs', async () => {
    const geckoClient = {
      getTrendingTokens: jest.fn().mockResolvedValue([
        makeToken('mint-owner-bad', 'OWN', 1, 300_000, 120_000, {
          dex_id: 'raydium',
          pair_address: 'pair-owner-bad',
          quote_token_address: 'So11111111111111111111111111111111111111112',
        }),
      ]),
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
      candidateFilter: async () => ({ allowed: false, reason: 'unsupported_pool_program' }),
    });

    await scanner.start();
    scanner.stop();

    expect(scanner.getWatchlist()).toHaveLength(0);
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

describe('ScannerEngine blacklist integration (R3)', () => {
  it('rejects candidates whose pair is blacklisted', async () => {
    const blacklisted = new Set(['mint-bad']);
    const geckoClient = {
      getTrendingTokens: jest.fn().mockResolvedValue([
        makeToken('mint-bad', 'BAD', 1, 1_000_000, 500_000),
        makeToken('mint-good', 'GOOD', 2, 800_000, 400_000),
      ]),
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
      blacklistCheck: (pairAddress) => blacklisted.has(pairAddress),
    });

    await scanner.start();
    scanner.stop();

    const mints = scanner.getWatchlist().map(e => e.tokenMint);
    expect(mints).toContain('mint-good');
    expect(mints).not.toContain('mint-bad');
  });

  it('evicts existing watchlist entries that become blacklisted', async () => {
    const blacklisted = new Set<string>();
    const geckoClient = {
      getTrendingTokens: jest.fn().mockResolvedValue([
        makeToken('mint-a', 'AAA', 1, 1_000_000, 500_000),
        makeToken('mint-b', 'BBB', 2, 800_000, 400_000),
      ]),
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
      blacklistCheck: (pairAddress) => blacklisted.has(pairAddress),
    });

    await scanner.start();
    scanner.stop();
    expect(scanner.getWatchlist()).toHaveLength(2);

    // pair가 블랙리스트에 추가됨
    blacklisted.add('mint-a');
    const evicted = scanner.evictBlacklistedEntries();

    expect(evicted).toBe(1);
    expect(scanner.getWatchlist().map(e => e.tokenMint)).toEqual(['mint-b']);
  });

  it('uses raw pair_address for blacklist check when available', async () => {
    const checkedAddresses: string[] = [];
    const geckoClient = {
      getTrendingTokens: jest.fn().mockResolvedValue([
        makeToken('mint-x', 'XXX', 1, 1_000_000, 500_000, {
          pair_address: 'real-pair-x',
        }),
      ]),
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
      blacklistCheck: (pairAddress) => {
        checkedAddresses.push(pairAddress);
        return false;
      },
    });

    await scanner.start();
    scanner.stop();

    expect(checkedAddresses).toContain('real-pair-x');
    // entry.pairAddress도 raw.pair_address로 저장되어야 eviction key space가 일치
    expect(scanner.getEntry('mint-x')?.pairAddress).toBe('real-pair-x');
  });

  it('evicts by raw pair_address when it differs from tokenMint', async () => {
    const blacklisted = new Set<string>();
    const geckoClient = {
      getTrendingTokens: jest.fn().mockResolvedValue([
        makeToken('mint-y', 'YYY', 1, 1_000_000, 500_000, {
          pair_address: 'real-pair-y',
        }),
      ]),
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
      blacklistCheck: (pairAddress) => blacklisted.has(pairAddress),
    });

    await scanner.start();
    scanner.stop();
    expect(scanner.getWatchlist()).toHaveLength(1);

    // tokenMint가 아닌 real pair_address로 블랙리스트 → eviction 동작해야 함
    blacklisted.add('real-pair-y');
    expect(scanner.evictBlacklistedEntries()).toBe(1);
    expect(scanner.getWatchlist()).toHaveLength(0);
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
