/**
 * Canary Auto-Halt tests (Block 4, 2026-04-18).
 * per-lane circuit-breaker: consecutive losers / cumulative budget / max trades.
 */
import {
  reportCanaryClose,
  getCanaryState,
  resetCanaryLaneState,
  resetAllCanaryStatesForTests,
} from '../src/risk/canaryAutoHalt';
import {
  isEntryHaltActive,
  resetAllEntryHaltsForTests,
} from '../src/orchestration/entryIntegrity';
import { config } from '../src/utils/config';

function setCfg(overrides: Partial<{
  canaryAutoHaltEnabled: boolean;
  canaryMaxConsecutiveLosers: number;
  canaryMaxBudgetSol: number;
  canaryMaxTrades: number;
  canaryMinLossToCountSol: number;
}>): void {
  for (const [k, v] of Object.entries(overrides)) {
    Object.defineProperty(config, k, { value: v, writable: true, configurable: true });
  }
}

describe('canaryAutoHalt', () => {
  beforeEach(() => {
    resetAllCanaryStatesForTests();
    resetAllEntryHaltsForTests();
    setCfg({
      canaryAutoHaltEnabled: true,
      canaryMaxConsecutiveLosers: 5,
      canaryMaxBudgetSol: 0.5,
      canaryMaxTrades: 100,
      canaryMinLossToCountSol: 0,
    });
  });

  it('tracks per-lane isolated state (cupsey halt does not affect pure_ws)', () => {
    for (let i = 0; i < 5; i++) reportCanaryClose('cupsey', -0.01);
    expect(isEntryHaltActive('cupsey')).toBe(true);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(false);
    expect(getCanaryState('cupsey').consecutiveLosers).toBe(5);
    expect(getCanaryState('pure_ws_breakout').consecutiveLosers).toBe(0);
  });

  it('halts on N consecutive losers', () => {
    setCfg({ canaryMaxConsecutiveLosers: 3 });
    reportCanaryClose('pure_ws_breakout', -0.002);
    reportCanaryClose('pure_ws_breakout', -0.003);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(false);
    reportCanaryClose('pure_ws_breakout', -0.001);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(true);
  });

  it('resets loser streak on winner', () => {
    setCfg({ canaryMaxConsecutiveLosers: 4 });
    reportCanaryClose('pure_ws_breakout', -0.001);
    reportCanaryClose('pure_ws_breakout', -0.001);
    reportCanaryClose('pure_ws_breakout', -0.001);
    reportCanaryClose('pure_ws_breakout', +0.002); // winner breaks streak
    reportCanaryClose('pure_ws_breakout', -0.001);
    reportCanaryClose('pure_ws_breakout', -0.001);
    reportCanaryClose('pure_ws_breakout', -0.001);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(false);
    expect(getCanaryState('pure_ws_breakout').consecutiveLosers).toBe(3);
  });

  it('halts on cumulative budget exhaust', () => {
    setCfg({ canaryMaxBudgetSol: 0.05, canaryMaxConsecutiveLosers: 100 });
    reportCanaryClose('pure_ws_breakout', -0.02);
    reportCanaryClose('pure_ws_breakout', -0.02);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(false);
    reportCanaryClose('pure_ws_breakout', -0.02);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(true);
    expect(getCanaryState('pure_ws_breakout').cumulativePnlSol).toBeLessThanOrEqual(-0.05);
  });

  it('halts on max trades reached (canary window complete)', () => {
    setCfg({ canaryMaxTrades: 3, canaryMaxConsecutiveLosers: 100 });
    reportCanaryClose('pure_ws_breakout', +0.01);
    reportCanaryClose('pure_ws_breakout', +0.01);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(false);
    reportCanaryClose('pure_ws_breakout', +0.01);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(true);
    expect(getCanaryState('pure_ws_breakout').tradeCount).toBe(3);
  });

  it('respects canaryAutoHaltEnabled=false (no-op)', () => {
    setCfg({ canaryAutoHaltEnabled: false, canaryMaxConsecutiveLosers: 2 });
    reportCanaryClose('pure_ws_breakout', -0.01);
    reportCanaryClose('pure_ws_breakout', -0.01);
    reportCanaryClose('pure_ws_breakout', -0.01);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(false);
    expect(getCanaryState('pure_ws_breakout').consecutiveLosers).toBe(0); // 진행 X
  });

  it('resetCanaryLaneState clears state for fresh canary', () => {
    setCfg({ canaryMaxConsecutiveLosers: 2 });
    reportCanaryClose('pure_ws_breakout', -0.01);
    reportCanaryClose('pure_ws_breakout', -0.01);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(true);
    resetCanaryLaneState('pure_ws_breakout');
    expect(getCanaryState('pure_ws_breakout').consecutiveLosers).toBe(0);
    expect(getCanaryState('pure_ws_breakout').tradeCount).toBe(0);
    // Note: entryIntegrity halt 는 별도 — operator 가 resetEntryHalt 로 해제해야 함
  });

  it('minLossToCount filters flat closes from streak', () => {
    setCfg({ canaryMaxConsecutiveLosers: 2, canaryMinLossToCountSol: 0.001 });
    reportCanaryClose('pure_ws_breakout', -0.0005); // below min → not a loser
    reportCanaryClose('pure_ws_breakout', -0.0005); // below min → not a loser
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(false);
    reportCanaryClose('pure_ws_breakout', -0.01);
    reportCanaryClose('pure_ws_breakout', -0.01);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(true);
  });
});
