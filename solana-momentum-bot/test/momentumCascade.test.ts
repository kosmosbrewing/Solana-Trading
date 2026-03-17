import {
  isFirstLegQualified,
  detectRecompression,
  calculateCombinedStopLoss,
  calculateAddOnQuantity,
  initCascadeState,
  addCascadeLeg,
  updateCascadeState,
  CascadeLeg,
} from '../src/strategy/momentumCascade';
import { Candle } from '../src/utils/types';

function makeLeg(overrides: Partial<CascadeLeg> = {}): CascadeLeg {
  return {
    entryPrice: 100,
    quantity: 1,
    stopLoss: 90,
    entryIdx: 0,
    entryTime: new Date(),
    ...overrides,
  };
}

function makeCandle(close: number, high?: number, low?: number, volume = 1000): Candle {
  return {
    pairAddress: 'test-pair',
    timestamp: new Date(),
    intervalSec: 300,
    open: close,
    high: high ?? close * 1.01,
    low: low ?? close * 0.99,
    close,
    volume,
    buyVolume: volume * 0.5,
    sellVolume: volume * 0.5,
    tradeCount: 100,
  };
}

describe('MomentumCascade', () => {
  describe('isFirstLegQualified', () => {
    it('returns false when TP1 not hit', () => {
      const leg = makeLeg();
      expect(isFirstLegQualified(leg, 120, 10, false)).toBe(false);
    });

    it('returns false when profit < minProfitR even with TP1 hit', () => {
      const leg = makeLeg();
      // originalRiskSol = 10, unrealized = (105-100)*1 = 5, R = 0.5
      expect(isFirstLegQualified(leg, 105, 10, true)).toBe(false);
    });

    it('returns true when TP1 hit and profit >= 1R', () => {
      const leg = makeLeg();
      // unrealized = (115-100)*1 = 15, R = 1.5
      expect(isFirstLegQualified(leg, 115, 10, true)).toBe(true);
    });

    it('handles zero risk gracefully', () => {
      const leg = makeLeg();
      expect(isFirstLegQualified(leg, 120, 0, true)).toBe(false);
    });
  });

  describe('detectRecompression', () => {
    it('returns false with fewer than 5 candles', () => {
      const candles = Array.from({ length: 4 }, () => makeCandle(100));
      expect(detectRecompression(candles, 110)).toBe(false);
    });

    it('detects range narrowing with pullback from peak', () => {
      // First half: wide range (80-120), second half: narrow range (95-105)
      const candles: Candle[] = [
        makeCandle(100, 120, 80, 1000),
        makeCandle(110, 120, 85, 1000),
        makeCandle(105, 118, 82, 1000),
        makeCandle(108, 115, 88, 1000),
        makeCandle(102, 112, 90, 1000),
        // Narrow range
        makeCandle(100, 105, 96, 1000),
        makeCandle(99, 104, 95, 1000),
        makeCandle(98, 103, 95, 1000),
        makeCandle(99, 102, 96, 1000),
        makeCandle(98, 101, 96, 1000),
      ];
      // Peak was at 120, current at 98 → pullback = 22
      expect(detectRecompression(candles, 120)).toBe(true);
    });

    it('returns false when no pullback from peak', () => {
      const candles = Array.from({ length: 10 }, () => makeCandle(100, 101, 99));
      // peak === close → no pullback
      expect(detectRecompression(candles, 100)).toBe(false);
    });
  });

  describe('calculateCombinedStopLoss', () => {
    it('returns 0 for empty legs', () => {
      expect(calculateCombinedStopLoss([], 10)).toBe(0);
    });

    it('single leg: SL = entry - risk/qty', () => {
      const legs = [makeLeg({ entryPrice: 100, quantity: 1, stopLoss: 90 })];
      const sl = calculateCombinedStopLoss(legs, 10);
      // costBasis=100, SL = 100 - 10/1 = 90
      expect(sl).toBeCloseTo(90, 6);
    });

    it('caps SL below costBasis * 0.99', () => {
      const legs = [makeLeg({ entryPrice: 100, quantity: 1, stopLoss: 90 })];
      // Very small risk → SL would be above cost basis
      const sl = calculateCombinedStopLoss(legs, 0.001);
      expect(sl).toBeLessThanOrEqual(100 * 0.99);
    });

    it('never goes below lowest individual leg SL', () => {
      const legs = [
        makeLeg({ entryPrice: 100, quantity: 1, stopLoss: 85 }),
        makeLeg({ entryPrice: 110, quantity: 1, stopLoss: 95 }),
      ];
      const sl = calculateCombinedStopLoss(legs, 100);
      // SL = costBasis - 100/2 = 105 - 50 = 55, but floor = min(85, 95) = 85
      expect(sl).toBeGreaterThanOrEqual(85);
    });
  });

  describe('calculateAddOnQuantity', () => {
    it('returns 0 when addOnPrice <= 0 (H-31)', () => {
      const legs = [makeLeg()];
      expect(calculateAddOnQuantity(legs, 0, 10)).toBe(0);
      expect(calculateAddOnQuantity(legs, -5, 10)).toBe(0);
    });

    it('returns 0 when no risk budget remains', () => {
      // leg risk = |100-90| * 1 = 10, originalRisk = 10 → 0 remaining
      const legs = [makeLeg({ entryPrice: 100, quantity: 1, stopLoss: 90 })];
      expect(calculateAddOnQuantity(legs, 120, 10)).toBe(0);
    });

    it('calculates correct add-on quantity within risk budget', () => {
      // leg risk = |100-90| * 0.5 = 5, originalRisk = 10 → 5 remaining
      // addOnSL = 100 (first leg entry), riskPerUnit = |120-100| = 20
      // qty = 5 / 20 = 0.25
      const legs = [makeLeg({ entryPrice: 100, quantity: 0.5, stopLoss: 90 })];
      expect(calculateAddOnQuantity(legs, 120, 10)).toBeCloseTo(0.25, 6);
    });

    it('caps quantity at balance fraction', () => {
      const legs = [makeLeg({ entryPrice: 100, quantity: 0.1, stopLoss: 90 })];
      // Large risk budget but small balance
      const qty = calculateAddOnQuantity(legs, 120, 100, 0.2, 10);
      const maxFromBalance = (10 * 0.2) / 120;
      expect(qty).toBeLessThanOrEqual(maxFromBalance + 0.0001);
    });
  });

  describe('cascade state lifecycle', () => {
    it('initializes, updates TP1, and adds leg correctly', () => {
      const leg = makeLeg({ entryPrice: 100, quantity: 1, stopLoss: 90 });
      let state = initCascadeState(leg, 150);

      expect(state.costBasis).toBe(100);
      expect(state.totalQuantity).toBe(1);
      expect(state.tp1Hit).toBe(false);
      expect(state.addOnCount).toBe(0);

      // Update: price rises to 115 (TP1 = 120, not hit yet)
      state = updateCascadeState(state, 115, 120);
      expect(state.tp1Hit).toBe(false);
      expect(state.peakPrice).toBe(115);

      // Update: price reaches 125 (TP1 hit)
      state = updateCascadeState(state, 125, 120);
      expect(state.tp1Hit).toBe(true);
      expect(state.peakPrice).toBe(125);

      // Add leg
      const newLeg = makeLeg({ entryPrice: 120, quantity: 0.5, stopLoss: 100, entryIdx: 1 });
      state = addCascadeLeg(state, newLeg);
      expect(state.legs.length).toBe(2);
      expect(state.addOnCount).toBe(1);
      expect(state.totalQuantity).toBe(1.5);
      // costBasis = (100*1 + 120*0.5) / 1.5 ≈ 106.67
      expect(state.costBasis).toBeCloseTo(106.667, 2);
    });
  });
});
