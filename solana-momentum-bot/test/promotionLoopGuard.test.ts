jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import {
  assessPromotionLoopEntry,
  getPromotionLoopStateSnapshot,
  hydratePromotionLoopGuardFromCloseRecords,
  reportPromotionLoopClose,
  resetPromotionLoopGuardForTests,
  PROMOTION_LOOP_CHECKPOINT_CLOSES,
  PROMOTION_LOOP_COHORT,
} from '../src/risk/promotionLoopGuard';
import {
  isEntryHaltActive,
  resetAllEntryHaltsForTests,
} from '../src/state/entryHaltState';

describe('promotionLoopGuard', () => {
  beforeEach(() => {
    resetPromotionLoopGuardForTests();
    resetAllEntryHaltsForTests();
  });

  it('ignores non-rotation cohorts', () => {
    const gate = assessPromotionLoopEntry({
      lane: 'kol_hunter_smart_v3',
      profileArm: 'smart_v3_fast_fail_live_v1',
    });

    expect(gate.allowed).toBe(true);
    expect(gate.inScope).toBe(false);
  });

  it('blocks in-scope rotation live entries without comparable trace IDs', () => {
    const gate = assessPromotionLoopEntry({
      lane: 'kol_hunter_rotation',
      profileArm: 'rotation_underfill_exit_flow_v1',
    });

    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('promotion_loop_missing_live_equivalence_trace');
    expect(gate.flags).toContain('PROMOTION_LOOP_MISSING_TRACE');
  });

  it('allows traced rotation underfill micro-live candidates', () => {
    const gate = assessPromotionLoopEntry({
      lane: 'kol_hunter_rotation',
      profileArm: 'rotation_underfill_exit_flow_v1',
      liveEquivalenceCandidateId: 'candidate-1',
      liveEquivalenceDecisionId: 'decision-1',
    });

    expect(gate.allowed).toBe(true);
    expect(gate.inScope).toBe(true);
    expect(gate.flags).toContain('PROMOTION_LOOP_ACTIVE');
  });

  it('kills the loop on three consecutive losers and blocks later entries', () => {
    for (let i = 0; i < 3; i++) {
      reportPromotionLoopClose({
        lane: 'kol_hunter_rotation',
        profileArm: 'rotation_underfill_exit_flow_v1',
        liveEquivalenceCandidateId: 'candidate-1',
        liveEquivalenceDecisionId: 'decision-1',
        pnlSol: -0.001,
      });
    }

    expect(isEntryHaltActive('kol_hunter_rotation')).toBe(true);
    expect(getPromotionLoopStateSnapshot().status).toBe('killed');
    expect(assessPromotionLoopEntry({
      lane: 'kol_hunter_rotation',
      profileArm: 'rotation_underfill_exit_flow_v1',
      liveEquivalenceCandidateId: 'candidate-2',
      liveEquivalenceDecisionId: 'decision-2',
    }).allowed).toBe(false);
  });

  it('continues after a non-losing checkpoint and pauses at review close count', () => {
    for (let i = 0; i < PROMOTION_LOOP_CHECKPOINT_CLOSES; i++) {
      reportPromotionLoopClose({
        lane: 'kol_hunter_rotation',
        profileArm: 'rotation_underfill_exit_flow_v1',
        liveEquivalenceCandidateId: `candidate-${i}`,
        liveEquivalenceDecisionId: `decision-${i}`,
        pnlSol: 0.001,
      });
    }

    expect(isEntryHaltActive('kol_hunter_rotation')).toBe(false);
    expect(getPromotionLoopStateSnapshot().checkpointCloseCount).toBe(0);

    for (let i = PROMOTION_LOOP_CHECKPOINT_CLOSES; i < 15; i++) {
      reportPromotionLoopClose({
        lane: 'kol_hunter_rotation',
        profileArm: 'rotation_underfill_exit_flow_v1',
        liveEquivalenceCandidateId: `candidate-${i}`,
        liveEquivalenceDecisionId: `decision-${i}`,
        pnlSol: 0.001,
      });
    }

    expect(getPromotionLoopStateSnapshot().status).toBe('review');
    expect(isEntryHaltActive('kol_hunter_rotation')).toBe(true);
  });

  it('ignores unmarked historical live closes during restart hydration', () => {
    const summary = hydratePromotionLoopGuardFromCloseRecords([
      {
        canaryLane: 'kol_hunter_rotation',
        profileArm: 'rotation_underfill_exit_flow_v1',
        liveEquivalenceCandidateId: 'old-candidate',
        liveEquivalenceDecisionId: 'old-decision',
        walletDeltaSol: -0.1,
        recordedAt: '2026-05-18T00:00:00.000Z',
      },
    ], { resetBeforeHydrate: true });

    expect(summary.replayedRows).toBe(0);
    expect(getPromotionLoopStateSnapshot().closeCount).toBe(0);
    expect(isEntryHaltActive('kol_hunter_rotation')).toBe(false);
  });

  it('replays marked promotion-loop closes during restart hydration', () => {
    const rows = [0, 1, 2].map((i) => ({
      promotionLoopCohort: PROMOTION_LOOP_COHORT,
      canaryLane: 'kol_hunter_rotation',
      profileArm: 'rotation_underfill_exit_flow_v1',
      liveEquivalenceCandidateId: `candidate-${i}`,
      liveEquivalenceDecisionId: `decision-${i}`,
      walletDeltaSol: -0.001,
      recordedAt: `2026-05-18T00:00:0${i}.000Z`,
    }));

    const summary = hydratePromotionLoopGuardFromCloseRecords(rows, { resetBeforeHydrate: true });

    expect(summary.replayedRows).toBe(3);
    expect(getPromotionLoopStateSnapshot().status).toBe('killed');
    expect(isEntryHaltActive('kol_hunter_rotation')).toBe(true);
  });
});
