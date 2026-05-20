import {
  buildPromotionLoopReport,
  renderPromotionLoopReport,
} from '../scripts/promotion-loop-report';
import { PROMOTION_LOOP_COHORT } from '../src/risk/promotionLoopGuard';
import { buildPromotionLoopResetPreflightReport } from '../src/risk/promotionLoopResetPreflight';

describe('promotion-loop-report', () => {
  const sinceMs = new Date('2026-05-18T00:00:00.000Z').getTime();
  const nowMs = new Date('2026-05-18T00:03:00.000Z').getTime();

  it('ignores unmarked eligible historical rows and surfaces no-sample verdict', () => {
    const report = buildPromotionLoopReport([
      {
        recordedAt: '2026-05-18T00:01:00.000Z',
        canaryLane: 'kol_hunter_rotation',
        profileArm: 'rotation_underfill_exit_flow_v1',
        walletDeltaSol: -0.1,
      },
    ], sinceMs);

    expect(report.verdict).toBe('NO_SAMPLE');
    expect(report.unmarkedEligibleRows).toBe(1);
    expect(report.closeCount).toBe(0);
  });

  it('flags a marked three-loss promotion loop as kill', () => {
    const rows = [0, 1, 2].map((i) => ({
      promotionLoopCohort: PROMOTION_LOOP_COHORT,
      recordedAt: `2026-05-18T00:00:0${i}.000Z`,
      canaryLane: 'kol_hunter_rotation',
      profileArm: 'rotation_underfill_exit_flow_v1',
      liveEquivalenceCandidateId: `candidate-${i}`,
      liveEquivalenceDecisionId: `decision-${i}`,
      walletDeltaSol: -0.001,
      exitReason: 'strategy_loss',
    }));

    const report = buildPromotionLoopReport(rows, sinceMs);
    const md = renderPromotionLoopReport(report);

    expect(report.verdict).toBe('KILL');
    expect(report.closeCount).toBe(3);
    expect(report.statusReason).toContain('consecutive_losers');
    expect(md).toContain('strategy_loss');
    expect(md).toContain('## Reset Preflight');
  });

  it('blocks promotion-loop reset when fresh paper is still DOA-heavy or negative', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      closedAt: `2026-05-18T00:00:${String(i).padStart(2, '0')}.000Z`,
      positionId: `kolh-paper-${i}`,
      canaryLane: 'kol_hunter_rotation',
      profileArm: 'rotation_underfill_exit_flow_v1',
      paperRole: 'fallback_execution_safety',
      liveEquivalenceCandidateId: `candidate-${i}`,
      liveEquivalenceDecisionId: `decision-${i}`,
      refundAdjustedNetSol: i < 12 ? -0.001 : 0.0005,
      netSol: i < 12 ? -0.001 : 0.0005,
      exitReason: i < 12 ? 'rotation_dead_on_arrival' : 'winner_trailing_t1',
      exitRouteFound: true,
    }));

    const report = buildPromotionLoopResetPreflightReport(rows, sinceMs, nowMs);

    expect(report.status).toBe('BLOCKED');
    expect(report.eligiblePaperRows).toBe(20);
    expect(report.routeProofCoverage).toBe(1);
    expect(report.comparableTraceCoverage).toBe(1);
    expect(report.admissionFailureRate).toBe(0.6);
    expect(report.recentAdmissionFailureRate).toBe(0.6);
    expect(report.reasons.join(' ')).toContain('refund-adjusted');
    expect(report.reasons.join(' ')).toContain('admission failure rate');
  });

  it('allows manual reset review only after fresh comparable paper quality recovers', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      closedAt: `2026-05-18T00:00:${String(i).padStart(2, '0')}.000Z`,
      positionId: `kolh-paper-${i}`,
      canaryLane: 'kol_hunter_rotation',
      profileArm: 'rotation_underfill_exit_flow_v1',
      paperRole: 'fallback_execution_safety',
      liveEquivalenceCandidateId: `candidate-${i}`,
      liveEquivalenceDecisionId: `decision-${i}`,
      refundAdjustedNetSol: i < 6 ? -0.0005 : 0.001,
      netSol: i < 6 ? -0.0005 : 0.001,
      exitReason: i < 6 ? 'probe_hard_cut' : 'winner_trailing_t1',
      exitSellQuoteEvidence: { routeFound: true },
      rotationMonetizableEdge: { pass: true },
    }));

    const report = buildPromotionLoopResetPreflightReport(rows, sinceMs, nowMs);

    expect(report.status).toBe('READY_TO_RESET');
    expect(report.nextAction).toContain('manual reset review');
    expect(report.refundAdjustedNetSol).toBeGreaterThan(0);
    expect(report.admissionFailureRate).toBe(0.3);
    expect(report.recentAdmissionFailureRate).toBe(0.3);
    expect(report.routeProofCoverage).toBe(1);
    expect(report.comparableTraceCoverage).toBe(1);
  });
});
