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

  it('seeds historical swaps without emitting realtime events', () => {
    const builder = new MicroCandleBuilder({
      intervals: [5],
      maxHistory: 10,
    });
    const emitted: string[] = [];
    builder.on('candle', () => emitted.push('candle'));
    builder.on('tick', () => emitted.push('tick'));

    const seeded = builder.seedSwaps([
      makeSwap({ timestamp: 1, priceNative: 1.0, amountQuote: 2 }),
      makeSwap({ timestamp: 3, priceNative: 1.2, amountQuote: 3 }),
      makeSwap({ timestamp: 6, priceNative: 1.1, amountQuote: 4, signature: 'sig-2' }),
    ]);

    const candles = builder.getRecentCandles('pool-1', 5, 10);
    expect(seeded).toBe(3);
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({
      open: 1.0,
      high: 1.2,
      low: 1.0,
      close: 1.2,
      volume: 5,
      tradeCount: 2,
    });
    expect(emitted).toEqual([]);
  });

  // Phase E1 (2026-04-08): per-pool tick sanity bound — VDOR Raydium CLMM parser artifact 대응.
  describe('tick sanity bound (Phase E1)', () => {
    it('accepts the first tick unconditionally (lastPriceByPool unset)', () => {
      const builder = new MicroCandleBuilder({ intervals: [5], maxHistory: 10 });
      const rejected: unknown[] = [];
      builder.on('tickRejected', (ev) => rejected.push(ev));

      // 극단적 low price — 여전히 첫 tick 은 accept (baseline 없음)
      builder.onSwap(makeSwap({ timestamp: 1, priceNative: 0.00001, amountQuote: 1 }));

      expect(rejected).toHaveLength(0);
      expect(builder.getCurrentPrice('pool-1')).toBe(0.00001);
    });

    it('rejects ticks beyond ±50% of last close by default', () => {
      const builder = new MicroCandleBuilder({ intervals: [5], maxHistory: 10 });
      const rejected: Array<{ pool: string; price: number; lastPrice?: number }> = [];
      builder.on('tickRejected', (ev) => rejected.push(ev as any));

      builder.onSwap(makeSwap({ timestamp: 1, priceNative: 1.0, amountQuote: 1 }));
      // 2배 점프 (+100%) → reject
      builder.onSwap(makeSwap({ timestamp: 2, priceNative: 2.0, amountQuote: 1 }));
      // 0.3 (−70%) → reject
      builder.onSwap(makeSwap({ timestamp: 3, priceNative: 0.3, amountQuote: 1 }));
      // 1.4 (+40%) → accept (±50% 이내)
      builder.onSwap(makeSwap({ timestamp: 4, priceNative: 1.4, amountQuote: 1 }));

      expect(rejected).toHaveLength(2);
      expect(rejected[0].price).toBe(2.0);
      expect(rejected[1].price).toBe(0.3);
      // 누적 count 확인
      expect(builder.getSanityRejectCounts().get('pool-1')).toBe(2);
      // last price 는 1.4 (accept 된 마지막) 여야 함
      expect(builder.getCurrentPrice('pool-1')).toBe(1.4);
    });

    it('rejected tick does not pollute candle open/high/low/close', () => {
      const builder = new MicroCandleBuilder({ intervals: [5], maxHistory: 10 });
      // bucket [0,5): 2 swaps (1 정상, 1 bad → reject)
      builder.onSwap(makeSwap({ timestamp: 1, priceNative: 1.0, amountQuote: 2 }));
      // VDOR 패턴: 0.001 로 10x 낙하 시도 → reject 되어야
      builder.onSwap(makeSwap({ timestamp: 2, priceNative: 0.001, amountQuote: 3, signature: 'sig-bad' }));
      builder.onSwap(makeSwap({ timestamp: 3, priceNative: 1.05, amountQuote: 4, signature: 'sig-3' }));
      // bucket boundary 넘김 → 이전 bucket close
      builder.onSwap(makeSwap({ timestamp: 6, priceNative: 1.1, amountQuote: 1, signature: 'sig-4' }));

      const candles = builder.getRecentCandles('pool-1', 5, 10);
      expect(candles.length).toBeGreaterThanOrEqual(1);
      const closed = candles[0];
      // low 는 1.0 이어야 (0.001 이 반영되면 low = 0.001)
      expect(closed.low).toBe(1.0);
      expect(closed.high).toBe(1.05);
      expect(closed.tradeCount).toBe(2); // bad tick 제외 (sig-1, sig-3 두 건)
    });

    it('respects per-pool isolation (one pool reject does not affect another)', () => {
      const builder = new MicroCandleBuilder({ intervals: [5], maxHistory: 10 });
      builder.onSwap(makeSwap({ pool: 'pool-a', timestamp: 1, priceNative: 1.0, amountQuote: 1 }));
      builder.onSwap(makeSwap({ pool: 'pool-b', timestamp: 1, priceNative: 100, amountQuote: 1 }));
      // pool-a 에서 10x 점프 시도 → reject
      builder.onSwap(makeSwap({ pool: 'pool-a', timestamp: 2, priceNative: 10, amountQuote: 1 }));
      // pool-b 에 150 (+50%) → boundary, accept
      builder.onSwap(makeSwap({ pool: 'pool-b', timestamp: 2, priceNative: 150, amountQuote: 1 }));

      expect(builder.getCurrentPrice('pool-a')).toBe(1.0);
      expect(builder.getCurrentPrice('pool-b')).toBe(150);
      expect(builder.getSanityRejectCounts().get('pool-a')).toBe(1);
      expect(builder.getSanityRejectCounts().get('pool-b')).toBeUndefined();
    });

    it('can be disabled via tickSanityBoundPct=0', () => {
      const builder = new MicroCandleBuilder({
        intervals: [5],
        maxHistory: 10,
        tickSanityBoundPct: 0,
      });
      builder.onSwap(makeSwap({ timestamp: 1, priceNative: 1.0, amountQuote: 1 }));
      // 10x 점프도 accept
      builder.onSwap(makeSwap({ timestamp: 2, priceNative: 10, amountQuote: 1 }));
      expect(builder.getCurrentPrice('pool-1')).toBe(10);
      expect(builder.getSanityRejectCounts().size).toBe(0);
    });
  });
});
