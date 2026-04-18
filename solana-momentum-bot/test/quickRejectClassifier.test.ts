/**
 * Phase 3 test (DEX_TRADE.md, 2026-04-18): quick reject classifier pure function.
 */
import {
  evaluateQuickReject,
  DEFAULT_QUICK_REJECT_CONFIG,
} from '../src/risk/quickRejectClassifier';
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

describe('quickRejectClassifier', () => {
  it('hold when elapsed > window (no-op)', () => {
    const result = evaluateQuickReject({
      elapsedSec: 100,
      mfePct: 0.001,
      buyRatioAtEntry: 0.8,
      txCountAtEntry: 30,
      recentCandles: [candle({ buyVolume: 10, sellVolume: 90, tradeCount: 3 })],
    });
    expect(result.action).toBe('hold');
  });

  it('hold when disabled', () => {
    const result = evaluateQuickReject(
      {
        elapsedSec: 20,
        mfePct: 0,
        buyRatioAtEntry: 0.8,
        txCountAtEntry: 30,
        recentCandles: [candle({ buyVolume: 10, sellVolume: 90, tradeCount: 3 })],
      },
      { ...DEFAULT_QUICK_REJECT_CONFIG, enabled: false }
    );
    expect(result.action).toBe('hold');
  });

  it('exit when 2+ microstructure factors (weak_mfe not counted) — QA fix F10', () => {
    // weak_mfe + buy_ratio_decay + tx_density_drop = 3 factors, but only 2 are microstructure
    const result = evaluateQuickReject({
      elapsedSec: 15,
      mfePct: 0,
      buyRatioAtEntry: 0.8,
      txCountAtEntry: 30,
      recentCandles: [
        candle({ buyVolume: 20, sellVolume: 80, tradeCount: 5 }),    // buy 0.2 decay + tx drop
        candle({ buyVolume: 15, sellVolume: 85, tradeCount: 5 }),
      ],
    });
    expect(result.action).toBe('exit');
    expect(result.degradeFactors).toEqual(
      expect.arrayContaining(['weak_mfe', 'buy_ratio_decay', 'tx_density_drop'])
    );
  });

  it('weak_mfe + 1 microstructure → reduce (NOT exit) — QA fix F10 prevents over-rejection', () => {
    // 초반 window 에서 weak_mfe 는 흔함. microstructure 1개 만으론 exit 금지.
    const result = evaluateQuickReject({
      elapsedSec: 10,
      mfePct: 0,                   // weak_mfe
      buyRatioAtEntry: 0.8,
      txCountAtEntry: 30,
      recentCandles: [
        candle({ buyVolume: 20, sellVolume: 80, tradeCount: 28 }),   // buy decay only
      ],
    });
    expect(result.action).toBe('reduce');
    expect(result.degradeFactors).toContain('weak_mfe');
    expect(result.degradeFactors).toContain('buy_ratio_decay');
  });

  it('hold when only weak_mfe (no microstructure degrade) — QA fix F10', () => {
    // weak_mfe 단독 → reduce 아니고 hold. microstructure 1+ 개 있어야 reduce.
    const result = evaluateQuickReject({
      elapsedSec: 15,
      mfePct: 0,                   // weak_mfe only
      buyRatioAtEntry: 0.6,
      txCountAtEntry: 30,
      recentCandles: [
        candle({ buyVolume: 55, sellVolume: 45, tradeCount: 28 }),   // buy 0.55, tx stable → no decay
      ],
    });
    expect(result.action).toBe('hold');
    expect(result.degradeFactors).toEqual(['weak_mfe']);
    expect(result.mfeOk).toBe(false);
  });

  it('hold when MFE ok and microstructure stable', () => {
    const result = evaluateQuickReject({
      elapsedSec: 15,
      mfePct: 0.02,                // healthy
      buyRatioAtEntry: 0.7,
      txCountAtEntry: 30,
      recentCandles: [
        candle({ buyVolume: 70, sellVolume: 30, tradeCount: 28 }),
      ],
    });
    expect(result.action).toBe('hold');
    expect(result.degradeFactors).toHaveLength(0);
    expect(result.mfeOk).toBe(true);
  });

  it('tx_density_drop counts toward degrade factors', () => {
    const result = evaluateQuickReject({
      elapsedSec: 15,
      mfePct: 0.02,                // healthy MFE
      buyRatioAtEntry: 0.7,
      txCountAtEntry: 30,
      recentCandles: [
        candle({ buyVolume: 70, sellVolume: 30, tradeCount: 5 }),  // tx drop 5/30 = 83% drop
      ],
    });
    expect(result.degradeFactors).toContain('tx_density_drop');
  });
});
