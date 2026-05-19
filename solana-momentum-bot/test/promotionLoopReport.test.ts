import {
  buildPromotionLoopReport,
  renderPromotionLoopReport,
} from '../scripts/promotion-loop-report';
import { PROMOTION_LOOP_COHORT } from '../src/risk/promotionLoopGuard';

describe('promotion-loop-report', () => {
  const sinceMs = new Date('2026-05-18T00:00:00.000Z').getTime();

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
  });
});
