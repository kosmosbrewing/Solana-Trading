import {
  buildRotationPromotionMicroCanaryPreflightReport,
  renderRotationPromotionMicroCanaryPreflightReport,
} from '../scripts/rotation-promotion-micro-canary-preflight';

describe('rotation-promotion-micro-canary-preflight', () => {
  it('blocks live changes while the gatekeeper is waiting', () => {
    const report = buildRotationPromotionMicroCanaryPreflightReport({
      status: 'WAIT',
      primaryBlockerDisposition: 'WAIT_MORE_FORWARD_SAMPLE',
      reasons: ['need +13 unique bridge candidates'],
      microCanaryPlan: {
        reviewAllowed: false,
        preflightStatus: 'BLOCKED_UNTIL_GATE_READY',
        targetArm: 'rotation_underfill_cost_aware_exit_v2',
        maxTicketSol: 0.002,
      },
    });
    const md = renderRotationPromotionMicroCanaryPreflightReport(report);

    expect(report.verdict).toBe('BLOCKED');
    expect(report.liveAutoEnableAllowed).toBe(false);
    expect(report.requiredEnvDiff).toEqual(['none; gatekeeper is not READY']);
    expect(md).toContain('reviewAllowed: false');
  });

  it('emits a manual review packet only when the gatekeeper is ready', () => {
    const report = buildRotationPromotionMicroCanaryPreflightReport({
      status: 'READY',
      microCanaryPlan: {
        reviewAllowed: true,
        preflightStatus: 'READY_FOR_MANUAL_REVIEW',
        targetArm: 'rotation_underfill_cost_aware_exit_v2',
        maxTicketSol: 0.002,
        maxSleeveLossSol: 0.02,
        maxCloseCount: 30,
        minActiveDays: 7,
        requiredEnvDiff: ['include rotation_underfill_cost_aware_exit_v2'],
        rollbackConditions: ['cumulative wallet loss reaches -0.020000 SOL'],
        stopRules: ['manual review required before any size increase'],
      },
    });

    expect(report.verdict).toBe('READY_FOR_MANUAL_REVIEW');
    expect(report.liveAutoEnableAllowed).toBe(false);
    expect(report.reviewAllowed).toBe(true);
    expect(report.requiredEnvDiff).toEqual(['include rotation_underfill_cost_aware_exit_v2']);
  });
});
