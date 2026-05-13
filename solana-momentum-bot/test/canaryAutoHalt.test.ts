/**
 * Canary Auto-Halt tests (Block 4, 2026-04-18).
 * per-lane circuit-breaker: consecutive losers / cumulative budget / max trades.
 */
import {
  reportCanaryClose,
  getCanaryState,
  resetCanaryLaneState,
  resetAllCanaryStatesForTests,
  checkAndAutoResetHalt,
  hydrateCanaryStatesFromCloseRecords,
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
  canaryAutoResetEnabled: boolean;
  canaryAutoResetMinSec: number;
  canaryAutoHaltHydrateLookbackHours: number;
  canaryAutoHaltHydrateSince: string;
  // 2026-04-28 Sprint 2 Task 3: KOL hunter 별도 cap.
  kolHunterCanaryMaxConsecLosers: number;
  kolHunterCanaryMaxBudgetSol: number;
  kolHunterCanaryMaxTrades: number;
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
      canaryAutoHaltHydrateLookbackHours: 72,
      canaryAutoHaltHydrateSince: '',
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

  it('[2026-04-21 P2] auto-reset halt after canaryAutoResetMinSec elapsed', () => {
    setCfg({
      canaryMaxConsecutiveLosers: 3,
      canaryAutoResetEnabled: true,
      canaryAutoResetMinSec: 1800,
    });
    // 3 consecutive losers → halt (triggeredAt = now 기록)
    reportCanaryClose('pure_ws_breakout', -0.002);
    reportCanaryClose('pure_ws_breakout', -0.002);
    reportCanaryClose('pure_ws_breakout', -0.002);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(true);
    const nowMs = Date.now();

    // 10분 경과 — 아직 cooldown 미달
    expect(checkAndAutoResetHalt('pure_ws_breakout', nowMs + 10 * 60_000)).toBe(false);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(true);

    // 31분 경과 — auto reset 발동
    expect(checkAndAutoResetHalt('pure_ws_breakout', nowMs + 31 * 60_000)).toBe(true);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(false);
    expect(getCanaryState('pure_ws_breakout').consecutiveLosers).toBe(0);
    // budget/tradeCount 은 유지 — 실 자산 guard
    expect(getCanaryState('pure_ws_breakout').tradeCount).toBe(3);
  });

  it('[2026-04-21 P2] auto-reset skipped when budget exhausted (real asset guard)', () => {
    setCfg({
      canaryMaxConsecutiveLosers: 3,
      canaryMaxBudgetSol: 0.1,
      canaryAutoResetEnabled: true,
      canaryAutoResetMinSec: 1800,
    });
    // 큰 loss 로 budget 소진 + halt
    reportCanaryClose('pure_ws_breakout', -0.05);
    reportCanaryClose('pure_ws_breakout', -0.05);
    reportCanaryClose('pure_ws_breakout', -0.05);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(true);
    const nowMs = Date.now();

    // 31분 경과하더라도 budget 초과 → auto-reset skip
    expect(checkAndAutoResetHalt('pure_ws_breakout', nowMs + 31 * 60_000)).toBe(false);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(true);
  });

  it('[2026-04-30] auto-reset skipped when max trades reached (canary evaluation gate)', () => {
    setCfg({
      canaryMaxTrades: 3,
      canaryMaxConsecutiveLosers: 100,
      canaryMaxBudgetSol: 999,
      canaryAutoResetEnabled: true,
      canaryAutoResetMinSec: 1800,
    });
    reportCanaryClose('pure_ws_breakout', +0.001);
    reportCanaryClose('pure_ws_breakout', +0.001);
    reportCanaryClose('pure_ws_breakout', +0.001);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(true);

    expect(checkAndAutoResetHalt('pure_ws_breakout', Date.now() + 31 * 60_000)).toBe(false);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(true);
  });

  it('[2026-04-21 P2] auto-reset disabled via config (no-op)', () => {
    setCfg({
      canaryMaxConsecutiveLosers: 3,
      canaryAutoResetEnabled: false,
      canaryAutoResetMinSec: 1800,
    });
    reportCanaryClose('pure_ws_breakout', -0.002);
    reportCanaryClose('pure_ws_breakout', -0.002);
    reportCanaryClose('pure_ws_breakout', -0.002);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(true);
    // 긴 시간 경과해도 reset 안 됨
    expect(checkAndAutoResetHalt('pure_ws_breakout', Date.now() + 365 * 24 * 3600_000)).toBe(false);
    expect(isEntryHaltActive('pure_ws_breakout')).toBe(true);
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

  // 2026-04-28 Sprint 2 Task 3: KOL hunter 별도 cap (공용 0.3 SOL 분리).
  // 공용 cap (-0.3 SOL) 보다 더 보수적 (-0.1 SOL) 으로 적용 — paper 검증 단계 (n=401, 5x+ 1건) 정합.
  describe('kol_hunter lane 별도 cap (Sprint 2)', () => {
    it('uses kolHunterCanaryMaxConsecLosers (independent from default)', () => {
      setCfg({
        canaryMaxConsecutiveLosers: 100,         // 공용은 100
        kolHunterCanaryMaxConsecLosers: 3,       // KOL 만 3
        kolHunterCanaryMaxBudgetSol: 999,
        kolHunterCanaryMaxTrades: 999,
      });
      reportCanaryClose('kol_hunter', -0.001);
      reportCanaryClose('kol_hunter', -0.001);
      expect(isEntryHaltActive('kol_hunter')).toBe(false);
      reportCanaryClose('kol_hunter', -0.001);
      // KOL 전용 임계 (3) 도달 → halt. 공용 100 임계와 무관.
      expect(isEntryHaltActive('kol_hunter')).toBe(true);
      // pure_ws_breakout 은 영향 없음 (공용 100 적용)
      for (let i = 0; i < 10; i++) reportCanaryClose('pure_ws_breakout', -0.001);
      expect(isEntryHaltActive('pure_ws_breakout')).toBe(false);
    });

    it('isolates smart-v3 and rotation KOL canary halt streaks', () => {
      setCfg({
        canaryMaxConsecutiveLosers: 100,
        kolHunterCanaryMaxConsecLosers: 2,
        kolHunterCanaryMaxBudgetSol: 999,
        kolHunterCanaryMaxTrades: 999,
      });
      reportCanaryClose('kol_hunter_rotation', -0.001);
      reportCanaryClose('kol_hunter_rotation', -0.001);

      expect(isEntryHaltActive('kol_hunter_rotation')).toBe(true);
      expect(isEntryHaltActive('kol_hunter_smart_v3')).toBe(false);
      expect(isEntryHaltActive('kol_hunter')).toBe(false);
    });

    it('uses kolHunterCanaryMaxBudgetSol (more conservative than default)', () => {
      setCfg({
        canaryMaxBudgetSol: 0.5,                 // 공용은 0.5
        kolHunterCanaryMaxBudgetSol: 0.05,       // KOL 만 0.05
        kolHunterCanaryMaxConsecLosers: 100,
        kolHunterCanaryMaxTrades: 999,
      });
      reportCanaryClose('kol_hunter', -0.02);
      reportCanaryClose('kol_hunter', -0.02);
      expect(isEntryHaltActive('kol_hunter')).toBe(false);
      reportCanaryClose('kol_hunter', -0.02);  // 누적 -0.06 → cap -0.05 위반
      expect(isEntryHaltActive('kol_hunter')).toBe(true);
    });

    it('uses kolHunterCanaryMaxTrades (smaller paper canary window)', () => {
      setCfg({
        canaryMaxTrades: 200,
        kolHunterCanaryMaxTrades: 3,
        kolHunterCanaryMaxConsecLosers: 100,
        kolHunterCanaryMaxBudgetSol: 999,
      });
      reportCanaryClose('kol_hunter', +0.001);
      reportCanaryClose('kol_hunter', +0.001);
      expect(isEntryHaltActive('kol_hunter')).toBe(false);
      reportCanaryClose('kol_hunter', +0.001);
      // KOL 전용 max trades (3) 도달 → halt
      expect(isEntryHaltActive('kol_hunter')).toBe(true);
    });

    it('Real Asset Guard 정합: KOL cap 위반이 공용 cap 위반보다 먼저 trigger', () => {
      // 공용 cap (0.3) 보다 KOL cap (0.1) 이 작아 항상 KOL cap 이 먼저 trigger 되어야 함.
      setCfg({
        canaryMaxBudgetSol: 0.3,
        kolHunterCanaryMaxBudgetSol: 0.1,
        kolHunterCanaryMaxConsecLosers: 100,
        kolHunterCanaryMaxTrades: 999,
      });
      reportCanaryClose('kol_hunter', -0.05);
      reportCanaryClose('kol_hunter', -0.05);
      // 누적 -0.1 — KOL cap 도달
      reportCanaryClose('kol_hunter', -0.01);
      expect(isEntryHaltActive('kol_hunter')).toBe(true);
      // 공용 0.3 SOL 보다 한참 이른 시점 (0.11 SOL) 에 halt. 자산 보호 강화 정합.
      expect(getCanaryState('kol_hunter').cumulativePnlSol).toBeGreaterThan(-0.3);
    });
  });

  describe('restart hydration from executed-sells ledger (2026-04-30)', () => {
    it('replays walletDeltaSol rows and restores KOL budget halt', () => {
      setCfg({
        kolHunterCanaryMaxBudgetSol: 0.05,
        kolHunterCanaryMaxConsecLosers: 100,
        kolHunterCanaryMaxTrades: 999,
      });

      const summary = hydrateCanaryStatesFromCloseRecords([
        {
          strategy: 'kol_hunter',
          wallet: 'main',
          positionId: 'kolh-live-a',
          walletDeltaSol: -0.02,
          recordedAt: '2026-04-30T00:00:01.000Z',
        },
        {
          strategy: 'kol_hunter',
          wallet: 'main',
          positionId: 'kolh-live-b',
          walletDeltaSol: -0.04,
          recordedAt: '2026-04-30T00:00:02.000Z',
        },
      ], { resetBeforeHydrate: true });

      expect(summary.replayedRows).toBe(2);
      expect(summary.byLane.kol_hunter).toBe(2);
      expect(getCanaryState('kol_hunter').cumulativePnlSol).toBeCloseTo(-0.06, 6);
      expect(isEntryHaltActive('kol_hunter')).toBe(true);
    });

    it('maps strategies to lane state and skips rows before since', () => {
      const sinceMs = new Date('2026-04-30T00:00:00.000Z').getTime();
      const summary = hydrateCanaryStatesFromCloseRecords([
        {
          strategy: 'pure_ws_breakout',
          walletDeltaSol: -0.01,
          recordedAt: '2026-04-29T23:59:59.000Z',
        },
        {
          strategy: 'pure_ws_breakout',
          walletDeltaSol: -0.02,
          recordedAt: '2026-04-30T00:00:01.000Z',
        },
        {
          strategy: 'pure_ws_swing_v2',
          dbPnlSol: -0.03,
          recordedAt: '2026-04-30T00:00:02.000Z',
        },
        {
          strategy: 'cupsey_flip_10s',
          receivedSol: 0.008,
          solSpentNominal: 0.01,
          recordedAt: '2026-04-30T00:00:03.000Z',
        },
        {
          strategy: 'unknown',
          walletDeltaSol: -0.99,
          recordedAt: '2026-04-30T00:00:04.000Z',
        },
        {
          strategy: 'pure_ws_breakout',
          walletDeltaSol: -0.99,
        },
      ], { sinceMs, resetBeforeHydrate: true });

      expect(summary.replayedRows).toBe(3);
      expect(summary.skippedRows).toBe(3);
      expect(summary.byLane.pure_ws_breakout).toBe(1);
      expect(summary.byLane.pure_ws_swing_v2).toBe(1);
      expect(summary.byLane.cupsey).toBe(1);
      expect(getCanaryState('pure_ws_breakout').cumulativePnlSol).toBeCloseTo(-0.02, 6);
      expect(getCanaryState('pure_ws_swing_v2').cumulativePnlSol).toBeCloseTo(-0.03, 6);
      expect(getCanaryState('cupsey').cumulativePnlSol).toBeCloseTo(-0.002, 6);
    });

    it('does not count hydration rows as replayed when canary auto-halt is disabled', () => {
      setCfg({ canaryAutoHaltEnabled: false });

      const summary = hydrateCanaryStatesFromCloseRecords([
        {
          strategy: 'kol_hunter',
          walletDeltaSol: -0.10,
          recordedAt: '2026-04-30T00:00:01.000Z',
        },
      ], { resetBeforeHydrate: true });

      expect(summary.replayedRows).toBe(0);
      expect(summary.skippedRows).toBe(1);
      expect(getCanaryState('kol_hunter').tradeCount).toBe(0);
      expect(isEntryHaltActive('kol_hunter')).toBe(false);
    });

    it('skips live partial reduce sell rows because the position is still open', () => {
      const summary = hydrateCanaryStatesFromCloseRecords([
        {
          strategy: 'kol_hunter',
          wallet: 'main',
          positionId: 'kolh-live-partial',
          eventType: 'rotation_flow_live_reduce',
          isPartialReduce: true,
          positionStillOpen: true,
          walletDeltaSol: -0.01,
          recordedAt: '2026-04-30T00:00:01.000Z',
        },
      ], { resetBeforeHydrate: true });

      expect(summary.replayedRows).toBe(0);
      expect(summary.skippedRows).toBe(1);
      expect(getCanaryState('kol_hunter').tradeCount).toBe(0);
    });
  });
});
