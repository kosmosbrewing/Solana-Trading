import { VolumeMcapSpikeTrigger } from '../src/strategy/volumeMcapSpikeTrigger';
import { Candle } from '../src/utils/types';
import { MicroCandleBuilder } from '../src/realtime';

function makeCandle(overrides: Partial<Candle> & { pairAddress: string }): Candle {
  return {
    intervalSec: 10,
    open: 1.0,
    high: 1.1,
    low: 0.9,
    close: 1.0,
    volume: 100,
    buyVolume: 60,
    sellVolume: 40,
    tradeCount: 10,
    timestamp: new Date(),
    ...overrides,
  };
}

function buildCandleBuilder(candles: Candle[]): MicroCandleBuilder {
  return {
    getRecentCandles: (_pair: string, _interval: number, _count: number) => candles,
  } as unknown as MicroCandleBuilder;
}

const DEFAULT_CONFIG = {
  primaryIntervalSec: 10,
  volumeSurgeLookback: 5,
  volumeSurgeMultiplier: 2.5,
  cooldownSec: 300,
  minBuyRatio: 0.55,
  atrPeriod: 14,
};

describe('VolumeMcapSpikeTrigger', () => {
  let trigger: VolumeMcapSpikeTrigger;

  beforeEach(() => {
    trigger = new VolumeMcapSpikeTrigger(DEFAULT_CONFIG);
  });

  it('emits signal on volume spike with sufficient buy ratio', () => {
    const pair = 'TOKEN_A';
    const previous = Array.from({ length: 5 }, (_, i) =>
      makeCandle({ pairAddress: pair, volume: 100, timestamp: new Date(1000 * i) })
    );
    const current = makeCandle({
      pairAddress: pair,
      volume: 300,
      buyVolume: 70,
      sellVolume: 30,
      timestamp: new Date(6000),
    });
    const candles = [...previous, current];
    const builder = buildCandleBuilder(candles);

    const signal = trigger.onCandle(
      makeCandle({ pairAddress: pair, intervalSec: 10, timestamp: new Date(6000) }),
      builder
    );

    expect(signal).not.toBeNull();
    expect(signal!.action).toBe('BUY');
    expect(signal!.strategy).toBe('bootstrap_10s');
    expect(signal!.meta.realtimeSignal).toBe(1);
    expect(signal!.meta.triggerMode).toBe(1);
    expect(signal!.meta.volumeRatio).toBeCloseTo(3.0, 1);
    expect(signal!.meta.buyRatio).toBeCloseTo(0.7, 1);

    const stats = trigger.getRejectStats();
    expect(stats.signals).toBe(1);
  });

  it('returns null when volume insufficient', () => {
    const pair = 'TOKEN_B';
    const previous = Array.from({ length: 5 }, (_, i) =>
      makeCandle({ pairAddress: pair, volume: 100, timestamp: new Date(1000 * i) })
    );
    const current = makeCandle({
      pairAddress: pair,
      volume: 200,
      timestamp: new Date(6000),
    });
    const candles = [...previous, current];
    const builder = buildCandleBuilder(candles);

    const signal = trigger.onCandle(
      makeCandle({ pairAddress: pair, intervalSec: 10 }),
      builder
    );

    expect(signal).toBeNull();
    expect(trigger.getRejectStats().volumeInsufficient).toBe(1);
  });

  it('returns null when buy ratio too low', () => {
    const pair = 'TOKEN_C';
    const previous = Array.from({ length: 5 }, (_, i) =>
      makeCandle({ pairAddress: pair, volume: 100, timestamp: new Date(1000 * i) })
    );
    const current = makeCandle({
      pairAddress: pair,
      volume: 300,
      buyVolume: 40,
      sellVolume: 60,
      timestamp: new Date(6000),
    });
    const candles = [...previous, current];
    const builder = buildCandleBuilder(candles);

    const signal = trigger.onCandle(
      makeCandle({ pairAddress: pair, intervalSec: 10 }),
      builder
    );

    expect(signal).toBeNull();
    expect(trigger.getRejectStats().lowBuyRatio).toBe(1);
  });

  it('returns neutral buy ratio (0.5) when no directional data', () => {
    const pair = 'TOKEN_D';
    const previous = Array.from({ length: 5 }, (_, i) =>
      makeCandle({ pairAddress: pair, volume: 100, buyVolume: 0, sellVolume: 0, timestamp: new Date(1000 * i) })
    );
    const current = makeCandle({
      pairAddress: pair,
      volume: 300,
      buyVolume: 0,
      sellVolume: 0,
      timestamp: new Date(6000),
    });
    const candles = [...previous, current];
    const builder = buildCandleBuilder(candles);

    const signal = trigger.onCandle(
      makeCandle({ pairAddress: pair, intervalSec: 10 }),
      builder
    );

    // 0.5 < 0.55 threshold
    expect(signal).toBeNull();
    expect(trigger.getRejectStats().lowBuyRatio).toBe(1);
  });

  it('returns null when cooldown not elapsed', () => {
    const pair = 'TOKEN_E';
    const baseTime = 1000000;
    const makeHistory = (ts: number) => {
      const previous = Array.from({ length: 5 }, (_, i) =>
        makeCandle({ pairAddress: pair, volume: 100, timestamp: new Date((ts - 5 + i) * 1000) })
      );
      const current = makeCandle({
        pairAddress: pair,
        volume: 300,
        buyVolume: 70,
        sellVolume: 30,
        timestamp: new Date(ts * 1000),
      });
      return [...previous, current];
    };

    const candles1 = makeHistory(baseTime);
    const builder1 = buildCandleBuilder(candles1);
    const signal1 = trigger.onCandle(
      makeCandle({ pairAddress: pair, intervalSec: 10, timestamp: new Date(baseTime * 1000) }),
      builder1
    );
    expect(signal1).not.toBeNull();

    const candles2 = makeHistory(baseTime + 100);
    const builder2 = buildCandleBuilder(candles2);
    const signal2 = trigger.onCandle(
      makeCandle({ pairAddress: pair, intervalSec: 10, timestamp: new Date((baseTime + 100) * 1000) }),
      builder2
    );
    expect(signal2).toBeNull();
    expect(trigger.getRejectStats().cooldown).toBe(1);
  });

  it('includes volumeMcapPct when pool context is set', () => {
    const pair = 'TOKEN_F';
    trigger.setPoolContext(pair, { marketCap: 1000 });

    const previous = Array.from({ length: 5 }, (_, i) =>
      makeCandle({ pairAddress: pair, volume: 100, timestamp: new Date(1000 * i) })
    );
    const current = makeCandle({
      pairAddress: pair,
      volume: 300,
      buyVolume: 70,
      sellVolume: 30,
      timestamp: new Date(6000),
    });
    const candles = [...previous, current];
    const builder = buildCandleBuilder(candles);

    const signal = trigger.onCandle(
      makeCandle({ pairAddress: pair, intervalSec: 10, timestamp: new Date(6000) }),
      builder
    );

    expect(signal).not.toBeNull();
    expect(signal!.meta.volumeMcapPct).toBeCloseTo(0.3, 1);
  });

  it('returns null when insufficient candles', () => {
    const pair = 'TOKEN_G';
    const candles = [makeCandle({ pairAddress: pair })];
    const builder = buildCandleBuilder(candles);

    const signal = trigger.onCandle(
      makeCandle({ pairAddress: pair, intervalSec: 10 }),
      builder
    );

    expect(signal).toBeNull();
    expect(trigger.getRejectStats().insufficientCandles).toBe(1);
  });

  it('ignores candles from non-primary intervals', () => {
    const pair = 'TOKEN_H';
    const candles = Array.from({ length: 6 }, (_, i) =>
      makeCandle({ pairAddress: pair, volume: 300, timestamp: new Date(1000 * i) })
    );
    const builder = buildCandleBuilder(candles);

    const signal = trigger.onCandle(
      makeCandle({ pairAddress: pair, intervalSec: 60 }),
      builder
    );

    expect(signal).toBeNull();
    expect(trigger.getRejectStats().evaluations).toBe(0);
  });

  describe('volumeMcapBoost', () => {
    it('lowers multiplier when volume/mcap >= boostThreshold', () => {
      // volume=200 → ratio=2.0 < default 2.5 → normally rejected
      // But with mcap=10000, volume/mcap=0.02 >= 0.01 → boost to 1.5 → 2.0 >= 1.5 → pass
      const boostedTrigger = new VolumeMcapSpikeTrigger({
        ...DEFAULT_CONFIG,
        volumeMcapBoostThreshold: 0.01,
        volumeMcapBoostMultiplier: 1.5,
      });
      const pair = 'TOKEN_BOOST_A';
      boostedTrigger.setPoolContext(pair, { marketCap: 10000 });

      const previous = Array.from({ length: 5 }, (_, i) =>
        makeCandle({ pairAddress: pair, volume: 100, timestamp: new Date(1000 * i) })
      );
      const current = makeCandle({
        pairAddress: pair,
        volume: 200,
        buyVolume: 70,
        sellVolume: 30,
        timestamp: new Date(6000),
      });
      const builder = buildCandleBuilder([...previous, current]);

      const signal = boostedTrigger.onCandle(
        makeCandle({ pairAddress: pair, intervalSec: 10, timestamp: new Date(6000) }),
        builder
      );

      expect(signal).not.toBeNull();
      expect(signal!.meta.volumeMcapBoosted).toBe(1);
      expect(signal!.meta.effectiveMultiplier).toBe(1.5);
      expect(boostedTrigger.getRejectStats().volumeMcapBoosted).toBe(1);
    });

    it('uses default multiplier when no mcap context', () => {
      const pair = 'TOKEN_BOOST_B';
      // No setPoolContext → no boost
      const previous = Array.from({ length: 5 }, (_, i) =>
        makeCandle({ pairAddress: pair, volume: 100, timestamp: new Date(1000 * i) })
      );
      const current = makeCandle({
        pairAddress: pair,
        volume: 200,
        buyVolume: 70,
        sellVolume: 30,
        timestamp: new Date(6000),
      });
      const builder = buildCandleBuilder([...previous, current]);

      const signal = trigger.onCandle(
        makeCandle({ pairAddress: pair, intervalSec: 10, timestamp: new Date(6000) }),
        builder
      );

      // ratio=2.0 < 2.5 → rejected
      expect(signal).toBeNull();
      expect(trigger.getRejectStats().volumeInsufficient).toBeGreaterThanOrEqual(1);
    });

    it('uses default multiplier when volume/mcap < boostThreshold', () => {
      const boostedTrigger = new VolumeMcapSpikeTrigger({
        ...DEFAULT_CONFIG,
        volumeMcapBoostThreshold: 0.01,
        volumeMcapBoostMultiplier: 1.5,
      });
      const pair = 'TOKEN_BOOST_C';
      // mcap=100000, volume=200 → volume/mcap=0.002 < 0.01 → no boost
      boostedTrigger.setPoolContext(pair, { marketCap: 100000 });

      const previous = Array.from({ length: 5 }, (_, i) =>
        makeCandle({ pairAddress: pair, volume: 100, timestamp: new Date(1000 * i) })
      );
      const current = makeCandle({
        pairAddress: pair,
        volume: 200,
        buyVolume: 70,
        sellVolume: 30,
        timestamp: new Date(6000),
      });
      const builder = buildCandleBuilder([...previous, current]);

      const signal = boostedTrigger.onCandle(
        makeCandle({ pairAddress: pair, intervalSec: 10, timestamp: new Date(6000) }),
        builder
      );

      // ratio=2.0 < 2.5 → rejected (no boost applied)
      expect(signal).toBeNull();
      expect(boostedTrigger.getRejectStats().volumeInsufficient).toBe(1);
    });

    it('non-boosted signal has no volumeMcapBoosted in meta', () => {
      const pair = 'TOKEN_BOOST_D';
      const previous = Array.from({ length: 5 }, (_, i) =>
        makeCandle({ pairAddress: pair, volume: 100, timestamp: new Date(1000 * i) })
      );
      const current = makeCandle({
        pairAddress: pair,
        volume: 300,
        buyVolume: 70,
        sellVolume: 30,
        timestamp: new Date(6000),
      });
      const builder = buildCandleBuilder([...previous, current]);

      const signal = trigger.onCandle(
        makeCandle({ pairAddress: pair, intervalSec: 10, timestamp: new Date(6000) }),
        builder
      );

      expect(signal).not.toBeNull();
      expect(signal!.meta.volumeMcapBoosted).toBeUndefined();
      expect(trigger.getRejectStats().volumeMcapBoosted).toBe(0);
    });

    it('tracks volumeMcapBoosted count in rejectStats', () => {
      const boostedTrigger = new VolumeMcapSpikeTrigger({
        ...DEFAULT_CONFIG,
        volumeMcapBoostThreshold: 0.01,
        volumeMcapBoostMultiplier: 1.5,
      });
      const pair = 'TOKEN_BOOST_E';
      boostedTrigger.setPoolContext(pair, { marketCap: 5000 });

      const previous = Array.from({ length: 5 }, (_, i) =>
        makeCandle({ pairAddress: pair, volume: 100, timestamp: new Date(1000 * i) })
      );
      // volume=200 → ratio=2.0, volume/mcap=0.04 → boosted
      const current = makeCandle({
        pairAddress: pair,
        volume: 200,
        buyVolume: 70,
        sellVolume: 30,
        timestamp: new Date(6000),
      });
      const builder = buildCandleBuilder([...previous, current]);

      boostedTrigger.onCandle(
        makeCandle({ pairAddress: pair, intervalSec: 10, timestamp: new Date(6000) }),
        builder
      );

      expect(boostedTrigger.getRejectStats().volumeMcapBoosted).toBe(1);
      expect(boostedTrigger.getRejectStats().signals).toBe(1);
    });
  });
});
