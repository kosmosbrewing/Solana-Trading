/**
 * Phase 3 test (DEX_TRADE.md, 2026-04-18): hold-phase exitability sentinel pure function.
 */
import {
  evaluateHoldPhaseSentinel,
  DEFAULT_HOLD_PHASE_SENTINEL_CONFIG,
} from '../src/risk/holdPhaseSentinel';
import type { Candle } from '../src/utils/types';

function candle(
  overrides: Partial<Candle> & { buyVolume?: number; sellVolume?: number; tradeCount?: number } = {}
): Candle {
  return {
    pairAddress: 'P',
    timestamp: new Date(0),
    intervalSec: 10,
    open: 1.0,
    high: 1.0,
    low: 1.0,
    close: 1.0,
    volume: 100,
    buyVolume: overrides.buyVolume ?? 50,
    sellVolume: overrides.sellVolume ?? 50,
    tradeCount: overrides.tradeCount ?? 10,
  };
}

describe('holdPhaseSentinel', () => {
  it('ok when all metrics stable', () => {
    const result = evaluateHoldPhaseSentinel({
      buyRatioAtEntry: 0.7,
      txCountAtEntry: 30,
      peakPrice: 2.0,
      currentPrice: 1.95,
      recentCandles: [candle({ buyVolume: 70, sellVolume: 30, tradeCount: 28 })],
    });
    expect(result.status).toBe('ok');
  });

  it('warn with single factor', () => {
    const result = evaluateHoldPhaseSentinel({
      buyRatioAtEntry: 0.7,
      txCountAtEntry: 30,
      peakPrice: 2.0,
      currentPrice: 1.3,  // peak drift 35% = threshold
      recentCandles: [candle({ buyVolume: 70, sellVolume: 30, tradeCount: 28 })],
    });
    expect(result.status).toBe('warn');
    expect(result.warnFactors).toContain('peak_drift');
  });

  it('degraded when 2+ factors trigger', () => {
    const result = evaluateHoldPhaseSentinel({
      buyRatioAtEntry: 0.7,
      txCountAtEntry: 30,
      peakPrice: 2.0,
      currentPrice: 1.2,  // peak drift 40%
      recentCandles: [
        candle({ buyVolume: 40, sellVolume: 60, tradeCount: 10 }),  // buy ratio 0.4 → collapse 0.3
      ],
    });
    expect(result.status).toBe('degraded');
    expect(result.warnFactors.length).toBeGreaterThanOrEqual(2);
  });

  it('disabled config forces ok regardless', () => {
    const result = evaluateHoldPhaseSentinel(
      {
        buyRatioAtEntry: 0.9,
        txCountAtEntry: 100,
        peakPrice: 10.0,
        currentPrice: 1.0,
        recentCandles: [candle({ buyVolume: 10, sellVolume: 90, tradeCount: 2 })],
      },
      { ...DEFAULT_HOLD_PHASE_SENTINEL_CONFIG, enabled: false }
    );
    expect(result.status).toBe('ok');
  });

  it('peak drift calculation', () => {
    const result = evaluateHoldPhaseSentinel({
      buyRatioAtEntry: 0.7,
      txCountAtEntry: 30,
      peakPrice: 4.0,
      currentPrice: 2.0,
      recentCandles: [candle()],
    });
    expect(result.peakDriftPct).toBeCloseTo(0.5, 5); // 50% drift
  });

  it('tx_density_drop factor triggers at threshold', () => {
    const result = evaluateHoldPhaseSentinel({
      buyRatioAtEntry: 0.7,
      txCountAtEntry: 30,
      peakPrice: 2.0,
      currentPrice: 1.9,   // no peak drift
      recentCandles: [
        candle({ buyVolume: 70, sellVolume: 30, tradeCount: 10 }), // tx 30→10 = 66% drop > 60% threshold
      ],
    });
    expect(result.warnFactors).toContain('tx_density_drop');
  });
});
