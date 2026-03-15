import { BirdeyeClient } from '../src/ingester/birdeyeClient';
import { UniverseEngine } from '../src/universe/universeEngine';
import type { Candle } from '../src/utils/types';

describe('UniverseEngine spread proxy', () => {
  it('hydrates watchlist spreadPct from recent 1m candles', async () => {
    const engine = new UniverseEngine({
      getTokenOverview: jest.fn().mockResolvedValue({
        address: 'mint-1',
        liquidity: 100_000,
        v24hUSD: 500_000,
        trade24h: 200,
        createdAt: Math.floor(Date.now() / 1000) - 172_800,
      }),
      getTokenSecurity: jest.fn().mockResolvedValue({
        top10HolderPercent: 0.4,
        isLpBurned: true,
        isOwnerRenounced: true,
      }),
      getOHLCV: jest.fn().mockResolvedValue(makeCandles()),
    } as unknown as BirdeyeClient, {
      params: { maxSpreadPct: 0.03 },
      refreshIntervalMs: 300_000,
      poolAddresses: ['pair-1'],
    });

    await engine.refresh();

    const watchlist = engine.getWatchlist();
    expect(watchlist).toHaveLength(1);
    expect(watchlist[0].spreadPct).toBeGreaterThan(0);
    expect(watchlist[0].spreadPct).toBeCloseTo((1.02 - 1.0) / 1.01, 6);
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
