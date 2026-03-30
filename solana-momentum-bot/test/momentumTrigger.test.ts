import { buildMomentumTriggerOrder } from '../src/strategy/momentumTrigger';
import type { Candle, Signal } from '../src/utils/types';

describe('buildMomentumTriggerOrder', () => {
  it('falls back to recent lows when ATR stop would collapse to zero', () => {
    const candles: Candle[] = [
      makeCandle(0.00120, 0.00121, 0.00118, 0.00119),
      makeCandle(0.00119, 0.00120, 0.00117, 0.00118),
      makeCandle(0.00118, 0.00119, 0.00116, 0.00117),
      makeCandle(0.00117, 0.00118, 0.00115, 0.00116),
      makeCandle(0.00116, 0.00117, 0.00114, 0.00115),
      makeCandle(0.00115, 0.00116, 0.00114, 0.00115),
    ];
    const signal: Signal = {
      action: 'BUY',
      strategy: 'volume_spike',
      pairAddress: 'pair-1',
      price: 0.00115,
      timestamp: new Date('2026-03-30T00:00:00Z'),
      meta: {
        atr: 1.5,
      },
    };

    const order = buildMomentumTriggerOrder(signal, candles, 1, {
      slMode: 'atr',
      slAtrMultiplier: 1.5,
      slSwingLookback: 5,
    });

    expect(order.stopLoss).toBeGreaterThan(0);
    expect(order.stopLoss).toBeCloseTo(0.00114, 8);
    expect(order.stopLoss).toBeLessThan(order.price);
  });
});

function makeCandle(open: number, high: number, low: number, close: number): Candle {
  return {
    pairAddress: 'pair-1',
    timestamp: new Date('2026-03-30T00:00:00Z'),
    intervalSec: 15,
    open,
    high,
    low,
    close,
    volume: 10,
    buyVolume: 6,
    sellVolume: 4,
    tradeCount: 5,
  };
}
