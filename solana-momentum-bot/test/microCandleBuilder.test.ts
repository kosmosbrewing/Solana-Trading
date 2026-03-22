import { MicroCandleBuilder } from '../src/realtime';
import { ParsedSwap } from '../src/realtime/types';

function makeSwap(overrides: Partial<ParsedSwap> = {}): ParsedSwap {
  return {
    pool: 'pool-1',
    signature: 'sig-1',
    timestamp: 1,
    side: 'buy',
    priceNative: 1,
    amountBase: 10,
    amountQuote: 5,
    slot: 1,
    source: 'logs',
    ...overrides,
  };
}

describe('MicroCandleBuilder', () => {
  it('aggregates swaps and closes candles at bucket boundaries', () => {
    const builder = new MicroCandleBuilder({
      intervals: [5],
      maxHistory: 10,
    });

    builder.onSwap(makeSwap({ timestamp: 1, priceNative: 1.0, amountQuote: 2 }));
    builder.onSwap(makeSwap({ timestamp: 3, priceNative: 1.2, amountQuote: 3 }));
    builder.onSwap(makeSwap({ timestamp: 6, priceNative: 1.1, amountQuote: 4, signature: 'sig-2' }));

    const candles = builder.getRecentCandles('pool-1', 5, 10);
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({
      open: 1.0,
      high: 1.2,
      low: 1.0,
      close: 1.2,
      volume: 5,
      buyVolume: 5,
      sellVolume: 0,
      tradeCount: 2,
    });
  });

  it('fills empty buckets during sweep with flat synthetic candles', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-22T00:00:00Z'));

    const builder = new MicroCandleBuilder({
      intervals: [5],
      maxHistory: 10,
      sweepIntervalMs: 1000,
    });
    builder.start();

    builder.onSwap(makeSwap({ timestamp: Math.floor(Date.now() / 1000), priceNative: 1.5, amountQuote: 2 }));

    jest.setSystemTime(new Date('2026-03-22T00:00:16Z'));
    jest.advanceTimersByTime(1000);

    const candles = builder.getRecentCandles('pool-1', 5, 10);
    expect(candles).toHaveLength(3);
    expect(candles.map((candle) => candle.volume)).toEqual([2, 0, 0]);
    expect(candles[1]).toMatchObject({ open: 1.5, high: 1.5, low: 1.5, close: 1.5 });

    builder.stop();
    jest.useRealTimers();
  });
});
