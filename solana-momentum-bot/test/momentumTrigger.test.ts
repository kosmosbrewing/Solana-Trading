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

  // Option β 2026-04-10: ATR floor — 10s candle ATR 이 noise floor 수준일 때
  // absolute 하한선 강제. TP1/SL 이 swap latency 동안의 reversion 에 잡히지 않게 함.
  describe('ATR floor (Option β 2026-04-10)', () => {
    const signalPrice = 0.001;
    const baseSignal: Signal = {
      action: 'BUY',
      strategy: 'bootstrap_10s',
      pairAddress: 'pair-atr-floor',
      price: signalPrice,
      timestamp: new Date('2026-04-10T00:00:00Z'),
      meta: {
        atr: 0.0000015, // 0.15% of price — raw noise level
      },
    };
    // signal.meta.atr 이 우선되므로 candle 은 최소 히스토리만 준비.
    const candles: Candle[] = Array.from({ length: 20 }, () =>
      makeCandle(signalPrice, signalPrice * 1.001, signalPrice * 0.999, signalPrice)
    );

    it('applies floor when rawAtr < price × atrFloorPct', () => {
      // rawAtr=0.0000015 = 0.15%, floor 0.8% = 0.000008 → floor wins
      const withFloor = buildMomentumTriggerOrder(baseSignal, candles, 1, {
        slMode: 'atr',
        slAtrMultiplier: 2.0,
        tp1Multiplier: 1.5,
        tp2Multiplier: 5.0,
        atrPeriod: 14,
        atrFloorPct: 0.008,
      });
      // effectiveAtr = max(0.0000015, 0.001 × 0.008) = max(0.0000015, 0.000008) = 0.000008
      // TP1 = price + 0.000008 × 1.5 = 0.001 + 0.000012 = 0.001012 (+1.2%)
      // TP2 = price + 0.000008 × 5.0 = 0.001 + 0.00004 = 0.00104 (+4.0%)
      expect(withFloor.takeProfit1).toBeCloseTo(0.001012, 8);
      expect(withFloor.takeProfit2).toBeCloseTo(0.00104, 8);
      // SL = price - 0.000008 × 2.0 = 0.001 - 0.000016 = 0.000984 (-1.6%)
      expect(withFloor.stopLoss).toBeCloseTo(0.000984, 8);
      // trailingStop = effectiveAtr
      expect(withFloor.trailingStop).toBeCloseTo(0.000008, 8);
    });

    it('does not apply floor when rawAtr > price × atrFloorPct (raw wins)', () => {
      const volatileSignal: Signal = {
        ...baseSignal,
        meta: { atr: 0.00002 }, // 2% of price — well above 0.8% floor
      };
      const order = buildMomentumTriggerOrder(volatileSignal, candles, 1, {
        slMode: 'atr',
        slAtrMultiplier: 2.0,
        tp1Multiplier: 1.5,
        tp2Multiplier: 5.0,
        atrPeriod: 14,
        atrFloorPct: 0.008,
      });
      // rawAtr 0.00002 > floor 0.000008 → raw 유지
      // TP1 = 0.001 + 0.00002 × 1.5 = 0.00103 (+3%)
      expect(order.takeProfit1).toBeCloseTo(0.00103, 8);
      expect(order.trailingStop).toBeCloseTo(0.00002, 8);
    });

    it('behaves as pre-redesign when atrFloorPct is omitted or zero', () => {
      const orderNoFloor = buildMomentumTriggerOrder(baseSignal, candles, 1, {
        slMode: 'atr',
        slAtrMultiplier: 2.0,
        tp1Multiplier: 1.5,
        tp2Multiplier: 5.0,
        atrPeriod: 14,
        atrFloorPct: 0,  // disabled
      });
      // rawAtr 0.0000015 그대로 사용
      // TP1 = 0.001 + 0.0000015 × 1.5 = 0.00100225
      expect(orderNoFloor.takeProfit1).toBeCloseTo(0.00100225, 10);
    });

    it('ignores floor when signalPrice is invalid (non-positive)', () => {
      const brokenSignal: Signal = {
        ...baseSignal,
        price: 0,
        meta: { atr: 0.0000015 },
      };
      const order = buildMomentumTriggerOrder(brokenSignal, candles, 1, {
        slMode: 'atr',
        slAtrMultiplier: 2.0,
        tp1Multiplier: 1.5,
        tp2Multiplier: 5.0,
        atrPeriod: 14,
        atrFloorPct: 0.008,
      });
      // signalPrice 0 → floor 계산 skip → raw atr 0.0000015 사용
      // TP1 = 0 + 0.0000015 × 1.5 = 0.00000225
      expect(order.takeProfit1).toBeCloseTo(0.00000225, 10);
    });
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
