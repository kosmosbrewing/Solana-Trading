import {
  buildRotationPromotionGatekeeperReport,
  evaluateRotationPromotionWindow,
  renderRotationPromotionGatekeeperReport,
  rotationPromotionHistoryFingerprint,
  shouldAppendRotationPromotionHistory,
  toRotationPromotionHistoryRow,
  type RotationPromotionReportInput,
} from '../scripts/rotation-promotion-gatekeeper';

function baseReport(overrides: Partial<RotationPromotionReportInput> = {}): RotationPromotionReportInput {
  return {
    sinceHours: 168,
    verdict: 'BRIDGE_REVIEW_ONLY',
    primaryBridgeReadinessGap: {
      minUniqueCandidates: 30,
      currentUniqueCandidates: 30,
      neededUniqueCandidates: 0,
      minActiveDays: 3,
      currentActiveDays: 3,
      neededActiveDays: 0,
      minPositiveDays: 3,
      currentPositiveDays: 3,
      neededPositiveDays: 0,
      currentWalletStressSol: 0.05,
      walletStressPositivePass: true,
      maxTopWinnerShare: 0.35,
      currentTopWinnerShare: 0.2,
      topWinnerSharePass: true,
      parentChildDeltaWalletStressSol: 0.01,
      parentChildDeltaPass: true,
    },
    ...overrides,
  };
}

describe('rotation-promotion-gatekeeper', () => {
  it('waits when the primary bridge needs more candidates', () => {
    const report = buildRotationPromotionGatekeeperReport([
      baseReport({
        primaryBridgeReadinessGap: {
          ...baseReport().primaryBridgeReadinessGap,
          currentUniqueCandidates: 17,
          neededUniqueCandidates: 13,
        },
      }),
    ]);

    expect(report.status).toBe('WAIT');
    expect(report.liveAutoEnableAllowed).toBe(false);
    expect(report.reasons).toContain('need +13 unique bridge candidates');
  });

  it('treats classified safe bridge evidence as sample waiting instead of writer repair', () => {
    const report = buildRotationPromotionGatekeeperReport([
      baseReport({
        promotionCandidateRows: 0,
        bridgeCandidateRows: 39,
        uniqueBridgeCandidates: 17,
        promotionEvidenceBuckets: [
          { classification: 'strict_candidate', rows: 0, uniqueCandidates: 0 },
          { classification: 'safe_bridge_candidate', rows: 39, uniqueCandidates: 17 },
          { classification: 'missing_metadata', rows: 21, uniqueCandidates: 21 },
        ],
        blockers: [{ blocker: 'non_comparable_role', count: 100 }],
        singleBlockers: [{
          blocker: 'non_comparable_role',
          count: 39,
          refundAdjustedNetSol: 0.3,
          walletStressSol: 0.2,
        }],
        bridgeReconciliationBacklog: [{
          priority: 'P0',
          disposition: 'COLLECT_FORWARD_SAMPLE',
          blocker: 'primary_bridge_unique_gap',
          action: 'collect +13 unique primary bridge candidates before funded testing',
          rows: 17,
          uniqueCandidates: 17,
          walletStressSol: 0.2,
        }],
        primaryBridgeReadinessGap: {
          ...baseReport().primaryBridgeReadinessGap,
          currentUniqueCandidates: 17,
          neededUniqueCandidates: 13,
        },
      }),
    ]);

    expect(report.status).toBe('WAIT');
    expect(report.primaryBlockerDisposition).toBe('WAIT_MORE_FORWARD_SAMPLE');
    expect(report.windows[0].blockerDrilldown.safeBridgeRows).toBe(39);
    expect(report.windows[0].blockerDrilldown.missingMetadataRows).toBe(21);
    expect(report.windows[0].blockerDrilldown.bridgeReconciliationBacklog[0]).toMatchObject({
      priority: 'P0',
      blocker: 'primary_bridge_unique_gap',
    });
    expect(report.nextAction).toContain('collect missing bridge evidence');
  });

  it('keeps attribution review when positive bridge rows lack evidence classification', () => {
    const report = buildRotationPromotionGatekeeperReport([
      baseReport({
        promotionCandidateRows: 0,
        bridgeCandidateRows: 39,
        uniqueBridgeCandidates: 17,
        blockers: [{ blocker: 'non_comparable_role', count: 100 }],
        singleBlockers: [{
          blocker: 'non_comparable_role',
          count: 39,
          refundAdjustedNetSol: 0.3,
          walletStressSol: 0.2,
        }],
        primaryBridgeReadinessGap: {
          ...baseReport().primaryBridgeReadinessGap,
          currentUniqueCandidates: 17,
          neededUniqueCandidates: 13,
        },
      }),
    ]);

    expect(report.status).toBe('WAIT');
    expect(report.primaryBlockerDisposition).toBe('CODE_OR_LEDGER_ATTRIBUTION_REVIEW');
    expect(report.nextAction).toContain('review paper role/cost-aware/id attribution');
  });

  it('marks review-ready but still blocks automatic live enable', () => {
    const report = buildRotationPromotionGatekeeperReport([baseReport()], {
      floorSol: 0.6,
      sleeveLossCapSol: 0.02,
    });

    expect(report.status).toBe('READY');
    expect(report.liveAutoEnableAllowed).toBe(false);
    expect(report.microCanaryPlan.reviewAllowed).toBe(true);
    expect(report.microCanaryPlan.preflightStatus).toBe('READY_FOR_MANUAL_REVIEW');
    expect(report.microCanaryPlan.targetArm).toBe('rotation_underfill_cost_aware_exit_v2');
    expect(report.microCanaryPlan.requiredEnvDiff.join(' ')).toContain('explicit live canary allowlist');
    expect(report.microCanaryPlan.maxSleeveLossAsFloorPct).toBeCloseTo(0.02 / 0.6);
    expect(report.nextAction).toContain('manual tiny micro-canary review');
  });

  it('rejects when wallet truth stress is non-positive', () => {
    const window = evaluateRotationPromotionWindow(baseReport({
      primaryBridgeReadinessGap: {
        ...baseReport().primaryBridgeReadinessGap,
        currentWalletStressSol: -0.01,
        walletStressPositivePass: false,
      },
    }));

    expect(window.status).toBe('REJECT');
    expect(window.reasons.join(' ')).toContain('wallet stress');
  });

  it('renders window readiness gaps for operators', () => {
    const report = buildRotationPromotionGatekeeperReport([
      baseReport({ sinceHours: 24 }),
      baseReport(),
    ]);
    const md = renderRotationPromotionGatekeeperReport(report);

    expect(md).toContain('liveAutoEnableAllowed: false');
    expect(md).toContain('## Micro-Canary Sleeve');
    expect(md).toContain('## Micro-Canary Preflight Packet');
    expect(md).toContain('## Promotion Blocker Drilldown');
    expect(md).toContain('### Primary Window Bridge Reconciliation Backlog');
    expect(md).toContain('| 168h | READY |');
  });

  it('serializes compact history rows for readiness trend tracking', () => {
    const report = buildRotationPromotionGatekeeperReport([
      baseReport({
        primaryBridgeReadinessGap: {
          ...baseReport().primaryBridgeReadinessGap,
          currentUniqueCandidates: 17,
          neededUniqueCandidates: 13,
        },
      }),
    ]);
    const row = toRotationPromotionHistoryRow(report);

    expect(row.status).toBe('WAIT');
    expect(row.fingerprint).toBe(rotationPromotionHistoryFingerprint(report));
    expect(row.blockerDisposition).toBe('WAIT_MORE_FORWARD_SAMPLE');
    expect(row.windows[0]).toMatchObject({
      windowHours: 168,
      currentUniqueCandidates: 17,
      neededUniqueCandidates: 13,
    });
  });

  it('does not append duplicate readiness history fingerprints', () => {
    const report = buildRotationPromotionGatekeeperReport([
      baseReport({
        primaryBridgeReadinessGap: {
          ...baseReport().primaryBridgeReadinessGap,
          currentUniqueCandidates: 17,
          neededUniqueCandidates: 13,
        },
      }),
    ]);
    const row = toRotationPromotionHistoryRow(report);

    expect(shouldAppendRotationPromotionHistory([], row)).toBe(true);
    expect(shouldAppendRotationPromotionHistory([row], row)).toBe(false);
  });
});
