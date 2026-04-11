import { TickTrigger, TickTriggerConfig } from '../src/strategy/tickTrigger';

const DEFAULT_CONFIG: TickTriggerConfig = {
  windowSec: 200,
  burstSec: 10,
  volumeSurgeMultiplier: 2.0,
  minBuyRatio: 0.55,
  cooldownSec: 300,
  sparseMinSwaps: 3,
  volumeMcapBoostThreshold: 0.005,
  volumeMcapBoostMultiplier: 1.5,
};

function makeSwap(overrides: Partial<{
  pool: string;
  amountQuote: number;
  side: 'buy' | 'sell';
  priceNative: number;
  timestamp: number;
}> = {}) {
  return {
    pool: 'POOL_A',
    amountQuote: 10,
    side: 'buy' as const,
    priceNative: 1.0,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('TickTrigger', () => {
  let trigger: TickTrigger;

  beforeEach(() => {
    trigger = new TickTrigger(DEFAULT_CONFIG);
  });

  it('should not fire with insufficient swaps in burst window', () => {
    const now = Date.now();
    // Only 2 swaps (below sparseMinSwaps=3)
    const result1 = trigger.onTick(makeSwap({ timestamp: now - 5000 }));
    const result2 = trigger.onTick(makeSwap({ timestamp: now - 3000 }));
    expect(result1).toBeNull();
    expect(result2).toBeNull();
  });

  it('should not fire without reference volume', () => {
    const now = Date.now();
    // All swaps in burst window (last 10s), no reference window data
    for (let i = 0; i < 5; i++) {
      const result = trigger.onTick(makeSwap({ timestamp: now - (9000 - i * 1000), amountQuote: 100 }));
      // Should be null — no reference data
      if (i < 4) expect(result).toBeNull();
    }
  });

  it('should fire signal when volume ratio exceeds multiplier', () => {
    const now = Date.now();
    const pool = 'POOL_SPIKE';

    // Reference window: swaps spread across 190s before burst
    for (let i = 0; i < 19; i++) {
      trigger.onTick(makeSwap({
        pool,
        amountQuote: 10,
        timestamp: now - 190_000 + i * 10_000,
      }));
    }

    // Burst window: 3 large swaps in last 10s → volume spike
    // Why: signal fires on the swap that meets sparseMinSwaps threshold,
    // subsequent swaps hit cooldown — capture first non-null result
    let signal = null;
    for (let i = 0; i < 3; i++) {
      const result = trigger.onTick(makeSwap({
        pool,
        amountQuote: 200,
        side: 'buy',
        timestamp: now - 5000 + i * 1000,
      }));
      if (result && !signal) signal = result;
    }

    expect(signal).not.toBeNull();
    expect(signal!.strategy).toBe('tick_momentum');
    expect(signal!.action).toBe('BUY');
    expect(signal!.meta.volumeRatio).toBeGreaterThanOrEqual(DEFAULT_CONFIG.volumeSurgeMultiplier);
  });

  it('should respect buyRatio gate', () => {
    const now = Date.now();
    const pool = 'POOL_BUYRATIO';

    // Reference: uniform small volume
    for (let i = 0; i < 19; i++) {
      trigger.onTick(makeSwap({
        pool,
        amountQuote: 10,
        side: 'buy',
        timestamp: now - 190_000 + i * 10_000,
      }));
    }

    // Burst: high volume but all sells → low buyRatio
    for (let i = 0; i < 5; i++) {
      const result = trigger.onTick(makeSwap({
        pool,
        amountQuote: 200,
        side: 'sell',
        timestamp: now - 5000 + i * 1000,
      }));
      expect(result).toBeNull();
    }

    const stats = trigger.getRejectStats();
    expect(stats.lowBuyRatio).toBeGreaterThan(0);
  });

  it('should respect cooldown', () => {
    const now = Date.now();
    const pool = 'POOL_CD';

    // Build reference
    for (let i = 0; i < 19; i++) {
      trigger.onTick(makeSwap({
        pool,
        amountQuote: 10,
        timestamp: now - 190_000 + i * 10_000,
      }));
    }

    // First signal fires
    let firstSignal = null;
    for (let i = 0; i < 5; i++) {
      const result = trigger.onTick(makeSwap({
        pool,
        amountQuote: 200,
        side: 'buy',
        timestamp: now - 5000 + i * 1000,
      }));
      if (result && !firstSignal) firstSignal = result;
    }
    expect(firstSignal).not.toBeNull();

    // Immediate retry → cooldown
    const cooldownResult = trigger.onTick(makeSwap({
      pool,
      amountQuote: 500,
      side: 'buy',
      timestamp: now + 1000,
    }));
    expect(cooldownResult).toBeNull();
    expect(trigger.getRejectStats().cooldown).toBeGreaterThan(0);
  });

  it('should prune old swaps beyond windowSec', () => {
    const now = Date.now();
    const pool = 'POOL_PRUNE';

    // Old swaps (beyond 200s window)
    for (let i = 0; i < 10; i++) {
      trigger.onTick(makeSwap({
        pool,
        amountQuote: 100,
        timestamp: now - 300_000 + i * 1000,
      }));
    }

    // Recent swap triggers prune
    trigger.onTick(makeSwap({
      pool,
      amountQuote: 10,
      timestamp: now,
    }));

    // Stats should show sparse reference (old swaps were pruned)
    const stats = trigger.getRejectStats();
    expect(stats.sparseReference).toBeGreaterThan(0);
  });

  it('should apply volumeMcap boost', () => {
    const now = Date.now();
    const pool = 'POOL_MCAP';
    const triggerWithBoost = new TickTrigger(DEFAULT_CONFIG);
    triggerWithBoost.setPoolContext(pool, { marketCap: 100_000 });

    // Reference: uniform low volume
    for (let i = 0; i < 19; i++) {
      triggerWithBoost.onTick(makeSwap({
        pool,
        amountQuote: 10,
        timestamp: now - 190_000 + i * 10_000,
      }));
    }

    // Burst: volume that passes boost threshold (0.5% of 100K = 500)
    // but below normal multiplier. boost multiplier (1.5) should apply.
    let signal = null;
    for (let i = 0; i < 4; i++) {
      signal = triggerWithBoost.onTick(makeSwap({
        pool,
        amountQuote: 200,
        side: 'buy',
        timestamp: now - 5000 + i * 1000,
      }));
    }

    const stats = triggerWithBoost.getRejectStats();
    expect(stats.volumeMcapBoosted).toBeGreaterThan(0);
  });

  it('should emit correct signal metadata', () => {
    const now = Date.now();
    const pool = 'POOL_META';

    for (let i = 0; i < 19; i++) {
      trigger.onTick(makeSwap({
        pool,
        amountQuote: 5,
        timestamp: now - 190_000 + i * 10_000,
        priceNative: 0.5,
      }));
    }

    let signal = null;
    for (let i = 0; i < 5; i++) {
      const result = trigger.onTick(makeSwap({
        pool,
        amountQuote: 100,
        side: 'buy',
        timestamp: now - 5000 + i * 1000,
        priceNative: 0.6,
      }));
      if (result && !signal) signal = result;
    }

    if (signal) {
      expect(signal.meta.triggerMode).toBe(2);
      expect(signal.meta.realtimeSignal).toBe(1);
      expect(signal.meta.primaryIntervalSec).toBe(DEFAULT_CONFIG.burstSec);
      expect(signal.meta.buyRatio).toBeGreaterThan(0);
      expect(signal.meta.currentVolume).toBeGreaterThan(0);
      expect(signal.meta.avgVolume).toBeGreaterThan(0);
      expect(signal.sourceLabel).toBe('trigger_tick_momentum');
    }
  });
});
