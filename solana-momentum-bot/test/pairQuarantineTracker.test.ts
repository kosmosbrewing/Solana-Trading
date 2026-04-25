/**
 * pairQuarantineTracker tests — Phase 4 P2-1/P2-2.
 */
import {
  recordDriftReject,
  recordFavorableDrift,
  isQuarantined,
  getActiveQuarantines,
  resetPairQuarantineForTests,
  configurePairQuarantine,
  getPairQuarantineState,
  DEFAULT_PAIR_QUARANTINE_CONFIG,
} from '../src/risk/pairQuarantineTracker';

const PAIR = 'PairAddress11111111111111111111111111111111';

describe('pairQuarantineTracker', () => {
  beforeEach(() => {
    resetPairQuarantineForTests();
  });

  it('20 drift_reject within 10min triggers quarantine', () => {
    const baseTs = 1_000_000;
    let triggered = false;
    for (let i = 0; i < 20; i++) {
      const r = recordDriftReject({ pair: PAIR, nowMs: baseTs + i * 1000 });
      triggered = r.triggered;
    }
    expect(triggered).toBe(true);
    expect(isQuarantined(PAIR, baseTs + 30_000)).toBe(true);
  });

  it('5 favorable_drift events trigger quarantine', () => {
    const baseTs = 2_000_000;
    let triggered = false;
    for (let i = 0; i < 5; i++) {
      const r = recordFavorableDrift({ pair: PAIR, nowMs: baseTs + i * 1000 });
      triggered = r.triggered;
    }
    expect(triggered).toBe(true);
  });

  it('events outside window do not trigger', () => {
    const baseTs = 3_000_000;
    // 10 events at baseTs, then advance past window
    for (let i = 0; i < 10; i++) {
      recordDriftReject({ pair: PAIR, nowMs: baseTs + i });
    }
    const lateMs = baseTs + DEFAULT_PAIR_QUARANTINE_CONFIG.windowMs + 1_000;
    // 10 more after window — old events pruned, no trigger
    for (let i = 0; i < 10; i++) {
      const r = recordDriftReject({ pair: PAIR, nowMs: lateMs + i });
      expect(r.triggered).toBe(false);
    }
  });

  it('quarantine auto-expires after duration', () => {
    const baseTs = 4_000_000;
    for (let i = 0; i < 20; i++) {
      recordDriftReject({ pair: PAIR, nowMs: baseTs + i });
    }
    expect(isQuarantined(PAIR, baseTs + 1000)).toBe(true);
    const expireMs = baseTs + DEFAULT_PAIR_QUARANTINE_CONFIG.durationMs + 1_000;
    expect(isQuarantined(PAIR, expireMs)).toBe(false);
  });

  it('disabled config returns false for everything', () => {
    configurePairQuarantine({ enabled: false });
    for (let i = 0; i < 20; i++) {
      const r = recordDriftReject({ pair: PAIR, nowMs: i * 1000 });
      expect(r.triggered).toBe(false);
    }
    expect(isQuarantined(PAIR)).toBe(false);
  });

  it('getActiveQuarantines lists fired pairs', () => {
    const baseTs = 5_000_000;
    for (let i = 0; i < 20; i++) recordDriftReject({ pair: PAIR, nowMs: baseTs + i });
    const list = getActiveQuarantines(baseTs + 1000);
    expect(list).toHaveLength(1);
    expect(list[0].pair).toBe(PAIR);
  });

  it('totalQuarantines counter increments', () => {
    const baseTs = 6_000_000;
    for (let i = 0; i < 20; i++) recordDriftReject({ pair: PAIR, nowMs: baseTs + i });
    expect(getPairQuarantineState(PAIR)?.totalQuarantines).toBe(1);
    // expire then re-trigger
    const expireMs = baseTs + DEFAULT_PAIR_QUARANTINE_CONFIG.durationMs + 1_000;
    isQuarantined(PAIR, expireMs); // triggers cleanup
    // re-fire
    for (let i = 0; i < 20; i++) recordDriftReject({ pair: PAIR, nowMs: expireMs + i });
    expect(getPairQuarantineState(PAIR)?.totalQuarantines).toBe(1);
  });
});
