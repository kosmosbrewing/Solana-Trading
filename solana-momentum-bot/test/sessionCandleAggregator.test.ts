import { aggregateSessionCandlesToTarget } from '../src/backtest/sessionCandleAggregator';
import type { StoredMicroCandle } from '../src/realtime/replayStore';

describe('aggregateSessionCandlesToTarget', () => {
  it('aggregates the smallest compatible interval into 300s candles', () => {
    const candles: StoredMicroCandle[] = [
      makeCandle({ intervalSec: 5, timestamp: '2026-04-05T00:00:00.000Z', open: 1, high: 2, low: 1, close: 2, volume: 10, buyVolume: 7, sellVolume: 3, tradeCount: 2 }),
      makeCandle({ intervalSec: 5, timestamp: '2026-04-05T00:00:05.000Z', open: 2, high: 3, low: 2, close: 2.5, volume: 5, buyVolume: 2, sellVolume: 3, tradeCount: 1 }),
      makeCandle({ intervalSec: 10, timestamp: '2026-04-05T00:00:00.000Z', open: 99, high: 99, low: 99, close: 99, volume: 999, buyVolume: 0, sellVolume: 999, tradeCount: 99 }),
      makeCandle({ intervalSec: 5, timestamp: '2026-04-05T00:05:00.000Z', open: 2.5, high: 4, low: 2.4, close: 3.5, volume: 8, buyVolume: 6, sellVolume: 2, tradeCount: 2 }),
    ];

    const result = aggregateSessionCandlesToTarget(candles, { targetIntervalSec: 300 });

    expect(result.baseIntervalSec).toBe(5);
    const pairCandles = result.byPair.get('pair-1') ?? [];
    expect(pairCandles).toHaveLength(2);

    expect(pairCandles[0]).toMatchObject({
      pairAddress: 'pair-1',
      intervalSec: 300,
      open: 1,
      high: 3,
      low: 1,
      close: 2.5,
      volume: 15,
      buyVolume: 9,
      sellVolume: 6,
      tradeCount: 3,
    });
    expect(pairCandles[0].timestamp.toISOString()).toBe('2026-04-05T00:00:00.000Z');
    expect(pairCandles[1].timestamp.toISOString()).toBe('2026-04-05T00:05:00.000Z');
  });

  it('respects an explicit base interval override', () => {
    const candles: StoredMicroCandle[] = [
      makeCandle({ intervalSec: 10, timestamp: '2026-04-05T00:00:00.000Z', close: 1.1 }),
      makeCandle({ intervalSec: 10, timestamp: '2026-04-05T00:00:10.000Z', open: 1.1, high: 1.3, low: 1.0, close: 1.2, volume: 4, buyVolume: 3, sellVolume: 1 }),
    ];

    const result = aggregateSessionCandlesToTarget(candles, {
      targetIntervalSec: 300,
      baseIntervalSec: 10,
    });

    expect(result.baseIntervalSec).toBe(10);
    const pairCandles = result.byPair.get('pair-1') ?? [];
    expect(pairCandles).toHaveLength(1);
    expect(pairCandles[0]).toMatchObject({
      open: 1,
      high: 1.3,
      low: 1,
      close: 1.2,
      volume: 5,
      buyVolume: 4,
      sellVolume: 1,
      tradeCount: 2,
    });
  });

  it('fails when no compatible base interval exists', () => {
    expect(() =>
      aggregateSessionCandlesToTarget(
        [makeCandle({ intervalSec: 7 })],
        { targetIntervalSec: 300 }
      )
    ).toThrow('No base interval found');
  });
});

function makeCandle(
  overrides: Partial<Omit<StoredMicroCandle, 'timestamp'>> & { timestamp?: string | Date } = {}
): StoredMicroCandle {
  return {
    pairAddress: 'pair-1',
    timestamp: new Date(overrides.timestamp ?? '2026-04-05T00:00:00.000Z'),
    intervalSec: overrides.intervalSec ?? 5,
    open: overrides.open ?? 1,
    high: overrides.high ?? 1,
    low: overrides.low ?? 1,
    close: overrides.close ?? 1,
    volume: overrides.volume ?? 1,
    buyVolume: overrides.buyVolume ?? 1,
    sellVolume: overrides.sellVolume ?? 0,
    tradeCount: overrides.tradeCount ?? 1,
    poolAddress: overrides.poolAddress,
    tokenMint: overrides.tokenMint,
    tokenSymbol: overrides.tokenSymbol,
  };
}
