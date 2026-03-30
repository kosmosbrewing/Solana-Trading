import { GeckoTerminalClient } from '../src/ingester/geckoTerminalClient';
import { UniverseEngine } from '../src/universe/universeEngine';
import type { Candle } from '../src/utils/types';

describe('UniverseEngine spread proxy', () => {
  it('hydrates watchlist spreadPct from recent 1m candles', async () => {
    const mockGeckoClient = {
      getOHLCV: jest.fn().mockResolvedValue(makeCandles()),
      getPoolInfo: jest.fn().mockResolvedValue(null),
      getTrendingTokens: jest.fn().mockResolvedValue([]),
      getTrendingPools: jest.fn().mockResolvedValue([]),
    } as unknown as GeckoTerminalClient;

    const mockDexScreener = {
      getTokenPairs: jest.fn().mockResolvedValue([{
        chainId: 'solana',
        dexId: 'raydium',
        pairAddress: 'pair-1',
        baseToken: { address: 'mint-1', name: 'Test', symbol: 'TEST' },
        quoteToken: { address: 'usdc', name: 'USDC', symbol: 'USDC' },
        priceUsd: 1.01,
        liquidity: { usd: 100_000, base: 0, quote: 0 },
        volume: { h24: 500_000 },
        priceChange: {},
        txns: { h24: { buys: 100, sells: 100 } },
        marketCap: 1_000_000,
        pairCreatedAt: Date.now() - 172_800_000,
      }]),
    };

    const engine = new UniverseEngine(mockGeckoClient, {
      params: { maxSpreadPct: 0.03 },
      refreshIntervalMs: 300_000,
      poolAddresses: ['pair-1'],
    }, mockDexScreener as never);

    await engine.refresh();

    const watchlist = engine.getWatchlist();
    expect(watchlist).toHaveLength(1);
    expect(watchlist[0].spreadPct).toBeGreaterThan(0);
    expect(watchlist[0].spreadPct).toBeCloseTo((1.02 - 1.0) / 1.01, 6);
  });

  it('falls back to fdv when marketCap is unavailable', async () => {
    const mockGeckoClient = {
      getOHLCV: jest.fn().mockResolvedValue(makeCandles()),
      getPoolInfo: jest.fn().mockResolvedValue(null),
      getTrendingTokens: jest.fn().mockResolvedValue([]),
      getTrendingPools: jest.fn().mockResolvedValue([]),
    } as unknown as GeckoTerminalClient;

    const mockDexScreener = {
      getTokenPairs: jest.fn().mockResolvedValue([{
        chainId: 'solana',
        dexId: 'raydium',
        pairAddress: 'pair-1',
        baseToken: { address: 'mint-1', name: 'Test', symbol: 'TEST' },
        quoteToken: { address: 'usdc', name: 'USDC', symbol: 'USDC' },
        priceUsd: 1.01,
        liquidity: { usd: 100_000, base: 0, quote: 0 },
        volume: { h24: 500_000 },
        priceChange: {},
        txns: { h24: { buys: 100, sells: 100 } },
        marketCap: undefined,
        fdv: 2_000_000,
        pairCreatedAt: Date.now() - 172_800_000,
      }]),
    };

    const engine = new UniverseEngine(mockGeckoClient, {
      params: { maxSpreadPct: 0.03 },
      refreshIntervalMs: 300_000,
      poolAddresses: ['pair-1'],
    }, mockDexScreener as never);

    await engine.refresh();

    const watchlist = engine.getWatchlist();
    expect(watchlist).toHaveLength(1);
    expect(watchlist[0].marketCap).toBe(2_000_000);
  });
});

function makeCandles(): Candle[] {
  return [
    makeCandle(new Date('2026-03-15T00:00:00Z')),
    makeCandle(new Date('2026-03-15T00:01:00Z')),
    makeCandle(new Date('2026-03-15T00:02:00Z')),
  ];
}

function makeCandle(timestamp: Date): Candle {
  return {
    pairAddress: 'pair-1',
    timestamp,
    intervalSec: 60,
    open: 1.01,
    high: 1.02,
    low: 1.0,
    close: 1.01,
    volume: 100,
    buyVolume: 50,
    sellVolume: 50,
    tradeCount: 10,
  };
}
