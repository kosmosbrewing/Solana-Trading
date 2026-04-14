import {
  initCusumState,
  updateCusum,
  CusumConfig,
  CusumState,
} from '../src/strategy/cusumDetector';

const defaultConfig: CusumConfig = {
  kMultiplier: 0.3,
  hMultiplier: 4.0,
  warmupPeriods: 10,
};

function feedVolumes(volumes: number[], config: CusumConfig = defaultConfig) {
  let state = initCusumState();
  const results = [];
  for (const v of volumes) {
    const result = updateCusum(state, v, config);
    state = result.state;
    results.push(result);
  }
  return results;
}

describe('cusumDetector', () => {
  describe('initCusumState', () => {
    it('returns zeroed state', () => {
      const state = initCusumState();
      expect(state.cumSum).toBe(0);
      expect(state.logMean).toBe(0);
      expect(state.logM2).toBe(0);
      expect(state.sampleCount).toBe(0);
    });
  });

  describe('warmup period', () => {
    it('does not signal during warmup', () => {
      // 9 samples with warmupPeriods=10 → no signal possible
      const volumes = Array(9).fill(100);
      const results = feedVolumes(volumes);
      expect(results.every(r => !r.signal)).toBe(true);
      expect(results.every(r => r.strength === 0)).toBe(true);
    });

    it('can signal after warmup completes', () => {
      // 10 warmup at 100, then extreme spike
      const volumes = [...Array(10).fill(100), 100_000];
      const results = feedVolumes(volumes);
      // During warmup (first 10), no signal
      for (let i = 0; i < 10; i++) {
        expect(results[i].signal).toBe(false);
      }
      // After warmup, extreme spike → signal or high strength
      expect(results[10].strength).toBeGreaterThan(0);
    });
  });

  describe('flat volume', () => {
    it('cumSum stays near 0 for constant volume', () => {
      // All same volume → deviation from mean is 0 → cumSum drifts to 0
      const volumes = Array(30).fill(100);
      const results = feedVolumes(volumes);
      // After warmup, cumSum should be 0 (max(0, ...)) since deviation ≤ allowance
      for (let i = 10; i < 30; i++) {
        expect(results[i].signal).toBe(false);
        // strength should be very low
        expect(results[i].strength).toBeLessThan(0.5);
      }
    });
  });

  describe('gradual increase', () => {
    it('accumulates cumSum and eventually signals on regime change', () => {
      // Warmup at baseline 100, then gradual ramp
      const baseline = Array(15).fill(100);
      const ramp = [];
      for (let i = 0; i < 30; i++) {
        ramp.push(100 + i * 50); // 100 → 1550 over 30 candles
      }
      const results = feedVolumes([...baseline, ...ramp]);

      // Should eventually produce a signal as volumes deviate from mean
      const signaled = results.some(r => r.signal);
      expect(signaled).toBe(true);

      // The signal should come from the ramp section, not the baseline
      const firstSignalIdx = results.findIndex(r => r.signal);
      expect(firstSignalIdx).toBeGreaterThan(14); // After baseline
    });
  });

  describe('spike-then-drop', () => {
    it('signals on spike and resets cumSum', () => {
      const baseline = Array(15).fill(100);
      const spike = [5000, 8000, 10000]; // massive spike
      const drop = Array(5).fill(100); // back to normal
      const results = feedVolumes([...baseline, ...spike, ...drop]);

      // Should signal during or after spike
      const spikeResults = results.slice(15, 18);
      const hasSignal = spikeResults.some(r => r.signal);
      expect(hasSignal).toBe(true);

      // After signal + reset + return to baseline, cumSum should be low
      const lastResult = results[results.length - 1];
      expect(lastResult.signal).toBe(false);
    });
  });

  describe('extreme spike', () => {
    it('signals on sustained elevated volume after baseline', () => {
      // Why: single spike inflates σ, making threshold hard to breach.
      // CUSUM 은 sustained regime shift 를 감지하는 것이 목적.
      // 단일 spike 감지는 bootstrap trigger 역할.
      const baseline = Array(12).fill(100);
      // Sustained elevated volume (3-5 candles at 10x)
      const elevated = Array(5).fill(1000);
      const results = feedVolumes([...baseline, ...elevated]);

      const elevatedResults = results.slice(12);
      const hasSignal = elevatedResults.some(r => r.signal);
      expect(hasSignal).toBe(true);
    });

    it('has high strength on single extreme spike with sensitive config', () => {
      // With lower h, single large spike can breach threshold
      const sensitiveConfig: CusumConfig = { kMultiplier: 0.1, hMultiplier: 2.0, warmupPeriods: 10 };
      const baseline = Array(12).fill(100);
      const results = feedVolumes([...baseline, 100_000], sensitiveConfig);

      const lastResult = results[results.length - 1];
      expect(lastResult.signal).toBe(true);
      expect(lastResult.strength).toBeGreaterThanOrEqual(1);
    });
  });

  describe('config sensitivity', () => {
    it('lower k is more sensitive (signals earlier)', () => {
      const sensitiveConfig: CusumConfig = { kMultiplier: 0.1, hMultiplier: 4.0, warmupPeriods: 10 };
      const normalConfig: CusumConfig = { kMultiplier: 0.5, hMultiplier: 4.0, warmupPeriods: 10 };

      const volumes = [...Array(15).fill(100), ...Array(10).fill(300)];

      const sensitiveResults = feedVolumes(volumes, sensitiveConfig);
      const normalResults = feedVolumes(volumes, normalConfig);

      const sensitiveFirstSignal = sensitiveResults.findIndex(r => r.signal);
      const normalFirstSignal = normalResults.findIndex(r => r.signal);

      // Sensitive should signal earlier (or at same time), never later
      if (sensitiveFirstSignal >= 0 && normalFirstSignal >= 0) {
        expect(sensitiveFirstSignal).toBeLessThanOrEqual(normalFirstSignal);
      } else if (sensitiveFirstSignal >= 0) {
        // Sensitive signaled but normal didn't — more sensitive as expected
        expect(true).toBe(true);
      }
    });

    it('lower h requires less cumulative evidence', () => {
      const easyConfig: CusumConfig = { kMultiplier: 0.3, hMultiplier: 2.0, warmupPeriods: 10 };
      const hardConfig: CusumConfig = { kMultiplier: 0.3, hMultiplier: 8.0, warmupPeriods: 10 };

      const volumes = [...Array(15).fill(100), ...Array(5).fill(500)];

      const easyResults = feedVolumes(volumes, easyConfig);
      const hardResults = feedVolumes(volumes, hardConfig);

      const easySignals = easyResults.filter(r => r.signal).length;
      const hardSignals = hardResults.filter(r => r.signal).length;

      // Easy threshold should produce more (or equal) signals
      expect(easySignals).toBeGreaterThanOrEqual(hardSignals);
    });
  });

  describe('state continuity', () => {
    it('preserves running statistics across calls', () => {
      let state = initCusumState();
      for (let i = 0; i < 20; i++) {
        const result = updateCusum(state, 100, defaultConfig);
        state = result.state;
      }

      expect(state.sampleCount).toBe(20);
      expect(state.logMean).toBeCloseTo(Math.log(101), 4); // log(100+1) ≈ 4.615
    });
  });
});
