jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import {
  applyPromotionLoopManualApprovalForTests,
  applyPromotionLoopResetPreflightRowsForTests,
  assessPromotionLoopEntry,
  getPromotionLoopStateSnapshot,
  hydratePromotionLoopGuardFromCloseRecords,
  reportPromotionLoopClose,
  resetPromotionLoopGuardForTests,
  PROMOTION_LOOP_CHECKPOINT_CLOSES,
  PROMOTION_LOOP_COHORT,
  PROMOTION_LOOP_MICRO_LIVE_MAX_TICKET_SOL,
  PROMOTION_LOOP_MICRO_LIVE_TARGET_ARM,
} from '../src/risk/promotionLoopGuard';
import {
  isEntryHaltActive,
  resetAllEntryHaltsForTests,
} from '../src/state/entryHaltState';

function readyPreflightRows(nowMs = Date.parse('2026-05-18T00:30:00.000Z')) {
  return Array.from({ length: 20 }, (_, i) => ({
    positionId: `paper-${i}`,
    paperRole: 'fallback_execution_safety',
    profileArm: PROMOTION_LOOP_MICRO_LIVE_TARGET_ARM,
    liveEquivalenceCandidateId: `candidate-${i}`,
    liveEquivalenceDecisionId: `decision-${i}`,
    refundAdjustedNetSol: 0.001,
    netSol: 0.001,
    exitRouteFound: true,
    exitReason: 'winner_trailing_t1',
    recordedAt: new Date(nowMs - i * 60_000).toISOString(),
  }));
}

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

  it('blocks READY reset preflight until manual approval is present', () => {
    const nowMs = Date.parse('2026-05-18T00:30:00.000Z');
    applyPromotionLoopResetPreflightRowsForTests(
      readyPreflightRows(nowMs),
      nowMs - 72 * 60 * 60 * 1000,
      nowMs
    );

    const gate = assessPromotionLoopEntry({
      lane: 'kol_hunter_rotation',
      profileArm: PROMOTION_LOOP_MICRO_LIVE_TARGET_ARM,
      ticketSol: PROMOTION_LOOP_MICRO_LIVE_MAX_TICKET_SOL,
      liveEquivalenceCandidateId: 'candidate-1',
      liveEquivalenceDecisionId: 'decision-1',
    });

    expect(gate.allowed).toBe(false);
    expect(gate.inScope).toBe(true);
    expect(gate.reason).toBe('promotion_loop_manual_review_required');
    expect(gate.flags).toContain('PROMOTION_LOOP_RESET_PREFLIGHT_READY');
    expect(gate.flags).toContain('PROMOTION_LOOP_MANUAL_REVIEW_REQUIRED');
  });

  it('allows only manually approved cost-aware micro-live candidates under the ticket cap', () => {
    const nowMs = Date.parse('2026-05-18T00:30:00.000Z');
    applyPromotionLoopResetPreflightRowsForTests(
      readyPreflightRows(nowMs),
      nowMs - 72 * 60 * 60 * 1000,
      nowMs
    );
    applyPromotionLoopManualApprovalForTests({
      approved: true,
      cohort: PROMOTION_LOOP_COHORT,
      targetArm: PROMOTION_LOOP_MICRO_LIVE_TARGET_ARM,
      maxTicketSol: PROMOTION_LOOP_MICRO_LIVE_MAX_TICKET_SOL,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      reason: 'test approval',
    });

    const gate = assessPromotionLoopEntry({
      lane: 'kol_hunter_rotation',
      profileArm: PROMOTION_LOOP_MICRO_LIVE_TARGET_ARM,
      ticketSol: PROMOTION_LOOP_MICRO_LIVE_MAX_TICKET_SOL,
      liveEquivalenceCandidateId: 'candidate-1',
      liveEquivalenceDecisionId: 'decision-1',
    });

    expect(gate.allowed).toBe(true);
    expect(gate.inScope).toBe(true);
    expect(gate.flags).toContain('PROMOTION_LOOP_ACTIVE');
    expect(gate.flags).toContain('PROMOTION_LOOP_MANUAL_APPROVED');
    expect(gate.flags).toContain('PROMOTION_LOOP_MICRO_TICKET_CAP_OK');
  });

  it('blocks old underfill live arms even when manual approval exists for cost-aware micro-live', () => {
    const nowMs = Date.parse('2026-05-18T00:30:00.000Z');
    applyPromotionLoopResetPreflightRowsForTests(
      readyPreflightRows(nowMs),
      nowMs - 72 * 60 * 60 * 1000,
      nowMs
    );
    applyPromotionLoopManualApprovalForTests({
      approved: true,
      cohort: PROMOTION_LOOP_COHORT,
      targetArm: PROMOTION_LOOP_MICRO_LIVE_TARGET_ARM,
      maxTicketSol: PROMOTION_LOOP_MICRO_LIVE_MAX_TICKET_SOL,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const gate = assessPromotionLoopEntry({
      lane: 'kol_hunter_rotation',
      profileArm: 'rotation_underfill_exit_flow_v1',
      ticketSol: PROMOTION_LOOP_MICRO_LIVE_MAX_TICKET_SOL,
      liveEquivalenceCandidateId: 'candidate-1',
      liveEquivalenceDecisionId: 'decision-1',
    });

    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('promotion_loop_manual_approval_target_mismatch');
  });

  it('blocks approved micro-live candidates above the ticket cap', () => {
    const nowMs = Date.parse('2026-05-18T00:30:00.000Z');
    applyPromotionLoopResetPreflightRowsForTests(
      readyPreflightRows(nowMs),
      nowMs - 72 * 60 * 60 * 1000,
      nowMs
    );
    applyPromotionLoopManualApprovalForTests({
      approved: true,
      cohort: PROMOTION_LOOP_COHORT,
      targetArm: PROMOTION_LOOP_MICRO_LIVE_TARGET_ARM,
      maxTicketSol: PROMOTION_LOOP_MICRO_LIVE_MAX_TICKET_SOL,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const gate = assessPromotionLoopEntry({
      lane: 'kol_hunter_rotation',
      profileArm: PROMOTION_LOOP_MICRO_LIVE_TARGET_ARM,
      ticketSol: 0.02,
      liveEquivalenceCandidateId: 'candidate-1',
      liveEquivalenceDecisionId: 'decision-1',
    });

    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('promotion_loop_micro_ticket_too_large');
  });

  it('blocks traced rotation underfill live candidates until paper reset preflight is ready', () => {
    const gate = assessPromotionLoopEntry({
      lane: 'kol_hunter_rotation',
      profileArm: 'rotation_underfill_exit_flow_v1',
      liveEquivalenceCandidateId: 'candidate-1',
      liveEquivalenceDecisionId: 'decision-1',
    });

    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('promotion_loop_reset_preflight_missing');
    expect(gate.flags).toContain('PROMOTION_LOOP_RESET_PREFLIGHT_MISSING');
  });

  it('blocks traced rotation underfill live candidates when recent paper quality is bad', () => {
    const nowMs = Date.parse('2026-05-18T00:30:00.000Z');
    applyPromotionLoopResetPreflightRowsForTests(
      readyPreflightRows(nowMs).map((row, i) => ({
        ...row,
        refundAdjustedNetSol: i < 14 ? -0.001 : 0.001,
        netSol: i < 14 ? -0.001 : 0.001,
        exitReason: i < 14 ? 'probe_hard_cut' : 'winner_trailing_t1',
      })),
      nowMs - 72 * 60 * 60 * 1000,
      nowMs
    );

    const gate = assessPromotionLoopEntry({
      lane: 'kol_hunter_rotation',
      profileArm: 'rotation_underfill_exit_flow_v1',
      liveEquivalenceCandidateId: 'candidate-1',
      liveEquivalenceDecisionId: 'decision-1',
    });

    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('promotion_loop_reset_preflight_blocked');
    expect(gate.flags).toContain('PROMOTION_LOOP_RESET_PREFLIGHT_BLOCKED');
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
