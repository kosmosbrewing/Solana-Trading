import { InternalCandleSource } from '../src/candle';
import type { Candle } from '../src/utils/types';

describe('InternalCandleSource', () => {
  it('aggregates 1m candles into 4H candles for range queries', async () => {
    const source = new InternalCandleSource({
      getCandlesInRange: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(makeOneMinuteCandles(240)),
      getRecentCandles: jest.fn(),
    } as any);

    const candles = await source.getCandlesInRange(
      'pair-1',
      14_400,
      new Date('2026-03-01T00:00:00Z'),
      new Date('2026-03-01T03:59:59Z')
    );

    expect(candles).toHaveLength(1);
    expect(candles[0]).toEqual(expect.objectContaining({
      pairAddress: 'pair-1',
      intervalSec: 14_400,
      open: 1,
      close: 240,
      high: 240.5,
      low: 0.5,
      volume: 240,
      tradeCount: 240,
    }));
  });

  it('returns direct candles when they are already stored', async () => {
    const directCandles = [
      makeCandle(new Date('2026-03-01T00:00:00Z'), 14_400, 1),
      makeCandle(new Date('2026-03-01T04:00:00Z'), 14_400, 2),
    ];
    const source = new InternalCandleSource({
      getCandlesInRange: jest.fn().mockResolvedValueOnce(directCandles),
      getRecentCandles: jest.fn(),
    } as any);

    const candles = await source.getCandlesInRange(
      'pair-1',
      14_400,
      new Date('2026-03-01T00:00:00Z'),
      new Date('2026-03-01T08:00:00Z')
    );

    expect(candles).toEqual(directCandles);
  });
});

function makeOneMinuteCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) =>
    makeCandle(
      new Date(Date.UTC(2026, 2, 1, 0, index, 0)),
      60,
      index + 1
    )
  );
}

function makeCandle(timestamp: Date, intervalSec: number, price: number): Candle {
  return {
    pairAddress: 'pair-1',
    timestamp,
    intervalSec,
    open: price,
    high: price + 0.5,
    low: price - 0.5,
    close: price,
    volume: 1,
    buyVolume: 0.5,
    sellVolume: 0.5,
    tradeCount: 1,
  };
}
