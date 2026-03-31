import { RealtimeSwapSanitizer } from '../src/realtime/swapSanitizer';
import { ParsedSwap } from '../src/realtime/types';

function makeSwap(overrides: Partial<ParsedSwap> = {}): ParsedSwap {
  return {
    pool: 'pool-1',
    signature: 'sig-1',
    timestamp: 1,
    side: 'buy',
    priceNative: 0.001,
    amountBase: 1_000,
    amountQuote: 1,
    slot: 1,
    source: 'transaction',
    ...overrides,
  };
}

describe('RealtimeSwapSanitizer', () => {
  it('rejects large sequential price spikes while keeping normal swaps', () => {
    const sanitizer = new RealtimeSwapSanitizer();

    expect(sanitizer.accept(makeSwap({ signature: 'sig-1', priceNative: 0.0010, timestamp: 1, slot: 1 }))).toBe(true);
    expect(sanitizer.accept(makeSwap({ signature: 'sig-2', priceNative: 0.0011, timestamp: 2, slot: 2 }))).toBe(true);
    expect(sanitizer.accept(makeSwap({ signature: 'sig-3', priceNative: 0.0012, timestamp: 3, slot: 3 }))).toBe(true);
    expect(sanitizer.accept(makeSwap({ signature: 'sig-4', priceNative: 12, timestamp: 4, slot: 4 }))).toBe(false);
    expect(sanitizer.accept(makeSwap({ signature: 'sig-5', priceNative: 0.00115, timestamp: 5, slot: 5 }))).toBe(true);
  });

  it('seeds ordered swaps and reports dropped outliers', () => {
    const sanitizer = new RealtimeSwapSanitizer();
    const result = sanitizer.seed([
      makeSwap({ signature: 'sig-2', timestamp: 2, slot: 2, priceNative: 0.0011 }),
      makeSwap({ signature: 'sig-1', timestamp: 1, slot: 1, priceNative: 0.0010 }),
      makeSwap({ signature: 'sig-3', timestamp: 3, slot: 3, priceNative: 25 }),
      makeSwap({ signature: 'sig-4', timestamp: 4, slot: 4, priceNative: 0.0012 }),
    ]);

    expect(result.keptCount).toBe(3);
    expect(result.droppedCount).toBe(1);
    expect(result.swaps.map((swap) => swap.signature)).toEqual(['sig-1', 'sig-2', 'sig-4']);
  });
});
