import {
  evaluateCupseySignalGate,
  CupseySignalGateConfig,
} from '../src/strategy/cupseySignalGate';
import { Candle } from '../src/utils/types';

function makeConfig(overrides: Partial<CupseySignalGateConfig> = {}): CupseySignalGateConfig {
  return {
    enabled: true,
    minVolumeAccelRatio: 1.5,
    minPriceChangePct: 0.001,
    minAvgBuyRatio: 0.55,
    minTradeCountRatio: 1.5,
    lookbackBars: 20,
    recentBars: 3,
    ...overrides,
  };
}

function makeCandle(overrides: Partial<Candle> & { index: number }): Candle {
  const { index, ...rest } = overrides;
  return {
    pairAddress: 'TEST_PAIR',
    timestamp: new Date(1000000 + index * 10000),
    intervalSec: 10,
    open: 1.0,
    high: 1.01,
    low: 0.99,
    close: 1.0,
    volume: 100,
    buyVolume: 60,
    sellVolume: 40,
    tradeCount: 10,
    ...rest,
  };
}

// Generates N baseline candles + recentBars candles with configurable recent overrides
function buildCandles(
  count: number,
  recentOverrides: Partial<Candle> = {},
  baselineOverrides: Partial<Candle> = {}
): Candle[] {
  const candles: Candle[] = [];
  const recentStart = count - 3;
  for (let i = 0; i < count; i++) {
    const isRecent = i >= recentStart;
    const overrides = isRecent ? recentOverrides : baselineOverrides;
    candles.push(makeCandle({ index: i, ...overrides }));
  }
  return candles;
}

describe('cupseySignalGate', () => {
  it('passes on sustained multi-bar momentum', () => {
    // Baseline: low volume/trades, Recent: high volume + rising price + strong buy
    const candles = buildCandles(20, {
      volume: 300,
      buyVolume: 200,
      sellVolume: 100,
      tradeCount: 30,
      open: 1.0,
      close: 1.005,
      high: 1.01,
    }, {
      volume: 100,
      tradeCount: 10,
    });

    const result = evaluateCupseySignalGate(candles, makeConfig());
    expect(result.pass).toBe(true);
    expect(result.score).toBeGreaterThan(50);
    expect(result.factors.volumeAccelRatio).toBeGreaterThanOrEqual(1.5);
  });

  it('rejects isolated single-bar spike (volume accel too low)', () => {
    // All candles have similar volume — no acceleration
    const candles = buildCandles(20, {
      volume: 110, // barely above baseline 100
      tradeCount: 11,
      buyVolume: 70,
      sellVolume: 40,
      close: 1.005,
    });

    const result = evaluateCupseySignalGate(candles, makeConfig());
    expect(result.pass).toBe(false);
    expect(result.rejectReason).toContain('vol_accel');
  });

  it('rejects flat price (no upward momentum)', () => {
    const candles = buildCandles(20, {
      volume: 300,
      tradeCount: 30,
      buyVolume: 200,
      sellVolume: 100,
      open: 1.0,
      close: 0.999, // slight down
    }, {
      volume: 100,
      tradeCount: 10,
    });

    const result = evaluateCupseySignalGate(candles, makeConfig());
    expect(result.pass).toBe(false);
    expect(result.rejectReason).toContain('price_chg');
  });

  it('rejects low buy ratio', () => {
    const candles = buildCandles(20, {
      volume: 300,
      tradeCount: 30,
      buyVolume: 100,   // 33% buy ratio
      sellVolume: 200,
      close: 1.005,
    }, {
      volume: 100,
      tradeCount: 10,
    });

    const result = evaluateCupseySignalGate(candles, makeConfig());
    expect(result.pass).toBe(false);
    expect(result.rejectReason).toContain('buy_ratio');
  });

  it('rejects low trade count ratio', () => {
    const candles = buildCandles(20, {
      volume: 300,
      tradeCount: 10,   // same as baseline — no organic increase
      buyVolume: 200,
      sellVolume: 100,
      close: 1.005,
    }, {
      volume: 100,
      tradeCount: 10,
    });

    const result = evaluateCupseySignalGate(candles, makeConfig());
    expect(result.pass).toBe(false);
    expect(result.rejectReason).toContain('trade_count');
  });

  it('passes with insufficient candles (graceful fallback)', () => {
    const candles = [makeCandle({ index: 0 }), makeCandle({ index: 1 })];
    const result = evaluateCupseySignalGate(candles, makeConfig());
    expect(result.pass).toBe(true);
    expect(result.score).toBe(50);
  });

  it('calculates weighted score correctly', () => {
    // Strong signal: 2x threshold on all factors
    const candles = buildCandles(20, {
      volume: 600,        // 6x baseline → ratio 6.0 (capped at 2x threshold)
      tradeCount: 60,     // 6x baseline → ratio 6.0
      buyVolume: 480,     // 80% buy ratio
      sellVolume: 120,
      open: 1.0,
      close: 1.01,        // +1% price change
    }, {
      volume: 100,
      tradeCount: 10,
    });

    const result = evaluateCupseySignalGate(candles, makeConfig());
    expect(result.pass).toBe(true);
    // All factors at 2x cap → score = 2*30 + 2*25 + 2*25 + 2*20 = 200, capped at 100
    expect(result.score).toBe(100);
  });

  it('handles sparse baseline with zero-volume candles', () => {
    const candles: Candle[] = [];
    // Baseline: mostly zero volume
    for (let i = 0; i < 17; i++) {
      candles.push(makeCandle({
        index: i,
        volume: i % 5 === 0 ? 50 : 0,
        tradeCount: i % 5 === 0 ? 5 : 0,
        buyVolume: i % 5 === 0 ? 30 : 0,
        sellVolume: i % 5 === 0 ? 20 : 0,
      }));
    }
    // Recent 3 bars: active
    for (let i = 17; i < 20; i++) {
      candles.push(makeCandle({
        index: i,
        volume: 200,
        tradeCount: 20,
        buyVolume: 130,
        sellVolume: 70,
        open: 1.0,
        close: 1.005,
      }));
    }

    const result = evaluateCupseySignalGate(candles, makeConfig());
    // Sparse baseline avg vol ≈ 14.7, recent avg = 200 → ratio ≈ 13.6 → pass
    expect(result.pass).toBe(true);
    expect(result.factors.volumeAccelRatio).toBeGreaterThan(5);
  });
});
