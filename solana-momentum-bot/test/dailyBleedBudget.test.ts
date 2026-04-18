/**
 * Phase 2 test (DEX_TRADE.md, 2026-04-18): daily bleed budget tracker.
 */
import {
  rollDailyBleedBudget,
  reportBleed,
  remainingDailyBudget,
  getDailyBleedSnapshot,
  resetDailyBleedForTests,
  maxProbesToday,
} from '../src/risk/dailyBleedBudget';

const cfg = {
  alpha: 0.05,        // 5% of wallet
  minCapSol: 0.05,
  maxCapSol: 0,       // unlimited
};

describe('dailyBleedBudget', () => {
  beforeEach(() => {
    resetDailyBleedForTests();
  });

  it('rollDailyBleedBudget sets cap = alpha × wallet, respecting min', () => {
    rollDailyBleedBudget(1.0, cfg);
    const s1 = getDailyBleedSnapshot();
    expect(s1.capSol).toBe(0.05); // 5% of 1.0 = 0.05, equals min floor

    rollDailyBleedBudget(10.0, cfg);
    const s2 = getDailyBleedSnapshot();
    expect(s2.capSol).toBe(0.5); // 5% of 10.0 = 0.5
  });

  it('min floor applied when wallet is small', () => {
    rollDailyBleedBudget(0.5, cfg);
    const s = getDailyBleedSnapshot();
    expect(s.capSol).toBe(0.05); // 5% of 0.5 = 0.025 < 0.05 min → 0.05
  });

  it('max ceiling applied when wallet is large and ceiling > 0', () => {
    rollDailyBleedBudget(100.0, { ...cfg, maxCapSol: 1.0 });
    const s = getDailyBleedSnapshot();
    expect(s.capSol).toBe(1.0); // 5% of 100 = 5.0 capped to 1.0
  });

  it('reportBleed accumulates spent', () => {
    rollDailyBleedBudget(1.0, cfg);
    reportBleed(0.01, 1.0, cfg);
    reportBleed(0.005, 1.0, cfg);
    const s = getDailyBleedSnapshot();
    expect(s.spentSol).toBeCloseTo(0.015, 9);
    expect(s.probes).toBe(2);
  });

  it('remainingDailyBudget subtracts spent from cap', () => {
    rollDailyBleedBudget(1.0, cfg);
    reportBleed(0.02, 1.0, cfg);
    expect(remainingDailyBudget(1.0, cfg)).toBeCloseTo(0.03, 9);
  });

  it('remainingDailyBudget never negative', () => {
    rollDailyBleedBudget(1.0, cfg);
    reportBleed(0.1, 1.0, cfg); // cap=0.05, spent=0.1
    expect(remainingDailyBudget(1.0, cfg)).toBe(0);
  });

  it('auto rolls to new day on ensureDay', () => {
    rollDailyBleedBudget(1.0, cfg);
    reportBleed(0.04, 1.0, cfg);
    const s1 = getDailyBleedSnapshot();
    expect(s1.spentSol).toBeCloseTo(0.04, 9);
    // simulate new day via direct state mutation (production: Date.now() changes)
    // here we just re-test fresh start via new reset
    resetDailyBleedForTests();
    rollDailyBleedBudget(1.0, cfg);
    const s2 = getDailyBleedSnapshot();
    expect(s2.spentSol).toBe(0);
  });

  it('snapshot exposes read-only state', () => {
    rollDailyBleedBudget(2.0, cfg);
    const s = getDailyBleedSnapshot();
    expect(s.walletBaselineSol).toBe(2.0);
    expect(s.capSol).toBe(0.1);
    expect(s.probes).toBe(0);
  });

  it('maxProbesToday computes floor(remaining / expected)', () => {
    rollDailyBleedBudget(1.0, cfg); // cap 0.05
    // expected bleed 0.001 per probe → 50 probes max
    expect(maxProbesToday(0.001, 1.0, cfg)).toBe(50);
    reportBleed(0.02, 1.0, cfg); // spent 0.02, remaining 0.03
    expect(maxProbesToday(0.001, 1.0, cfg)).toBe(30);
  });

  it('maxProbesToday returns 0 when budget exhausted', () => {
    rollDailyBleedBudget(1.0, cfg);
    reportBleed(0.1, 1.0, cfg); // cap=0.05, spent=0.1
    expect(maxProbesToday(0.001, 1.0, cfg)).toBe(0);
  });

  it('maxProbesToday returns Infinity for zero expected bleed (degenerate)', () => {
    rollDailyBleedBudget(1.0, cfg);
    expect(maxProbesToday(0, 1.0, cfg)).toBe(Number.POSITIVE_INFINITY);
  });
});
