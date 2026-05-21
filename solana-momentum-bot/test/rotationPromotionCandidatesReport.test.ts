import { buildReport } from '../scripts/rotation-promotion-candidates-report';

const args = {
  realtimeDir: 'unused',
  sinceHours: 168,
  assumedAtaRentSol: 0.002,
  assumedNetworkFeeSol: 0.0001,
};

function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    strategy: 'kol_hunter',
    closedAt: '2026-05-19T00:00:00.000Z',
    tokenMint: 'Mint111',
    liveEquivalenceCandidateId: 'candidate-1',
    liveEquivalenceDecisionId: 'decision-1',
    executionPlanHash: 'hash-1',
    routeFound: true,
    netSolTokenOnly: 0.01,
    exitReason: 'winner_trailing_t1',
    ...overrides,
  };
}

function bridgePair(id: number, overrides: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  const candidate = `candidate-${id}`;
  const decision = `decision-${id}`;
  const hash = `hash-${id}`;
  return [
    baseRow({
      positionId: `parent-${id}`,
      paperRole: 'fallback_execution_safety',
      profileArm: 'rotation_underfill_exit_flow_v1',
      liveEquivalenceCandidateId: candidate,
      liveEquivalenceDecisionId: decision,
      executionPlanHash: hash,
      closedAt: `2026-05-19T0${id}:00:00.000Z`,
    }),
    baseRow({
      positionId: `child-${id}`,
      parentPositionId: `parent-${id}`,
      paperRole: 'shadow',
      profileArm: 'rotation_underfill_cost_aware_exit_v2',
      liveEquivalenceCandidateId: candidate,
      liveEquivalenceDecisionId: decision,
      executionPlanHash: hash,
      closedAt: `2026-05-19T0${id}:01:00.000Z`,
      ...overrides,
    }),
  ];
}

describe('rotation-promotion-candidates-report', () => {
  it('classifies same-decision shadow bridge rows separately from strict candidates', () => {
    const parent = baseRow({
      positionId: 'parent-1',
      paperRole: 'fallback_execution_safety',
      profileArm: 'rotation_underfill_exit_flow_v1',
    });
    const child = baseRow({
      positionId: 'child-1',
      parentPositionId: 'parent-1',
      paperRole: 'shadow',
      profileArm: 'rotation_underfill_cost_aware_exit_v2',
    });

    const report = buildReport([parent, child], args);

    expect(report.promotionCandidateRows).toBe(0);
    expect(report.bridgeCandidateRows).toBe(1);
    expect(report.promotionEvidenceBuckets.find((row) =>
      row.classification === 'safe_bridge_candidate'
    )).toMatchObject({ rows: 1, uniqueCandidates: 1 });
  });

  it('keeps missing profile rows out of safe bridge evidence', () => {
    const row = baseRow({
      positionId: 'missing-profile-1',
      paperRole: 'mirror',
      profileArm: 'rotation_underfill_exit_flow_v1',
    });

    const report = buildReport([row], args);

    expect(report.promotionEvidenceBuckets.find((bucket) =>
      bucket.classification === 'missing_metadata'
    )).toMatchObject({ rows: 1 });
  });

  it('reports the primary bridge next-needed packet from unique safe bridge candidates', () => {
    const report = buildReport([
      ...bridgePair(1),
      ...bridgePair(2),
    ], args);

    expect(report.primaryBridgeNextNeededPacket).toMatchObject({
      status: 'COLLECT_MORE',
      targetUniqueCandidates: 30,
      currentUniqueCandidates: 2,
      neededUniqueCandidates: 28,
    });
  });

  it('dedupes the primary bridge roster by candidate id', () => {
    const [parent, child] = bridgePair(1);
    const duplicateChild = {
      ...child,
      positionId: 'child-duplicate-1',
      closedAt: '2026-05-19T01:02:00.000Z',
    };

    const report = buildReport([parent, child, duplicateChild], args);

    expect(report.primaryBridgeCandidateRows).toBe(2);
    expect(report.uniquePrimaryBridgeCandidates).toBe(1);
    expect(report.primaryBridgeRoster).toHaveLength(1);
    expect(report.primaryBridgeRoster[0].candidateId).toBe('candidate-1');
  });

  it('does not mark strict promotion ready from a sparse strict row', () => {
    const report = buildReport([
      baseRow({
        paperRole: 'mirror',
        profileArm: 'rotation_underfill_cost_aware_exit_v2',
        liveEquivalenceCandidateId: 'strict-candidate-1',
        liveEquivalenceDecisionId: 'strict-decision-1',
        executionPlanHash: 'strict-hash-1',
        routeFound: true,
        netSolTokenOnly: 0.02,
      }),
    ], args);

    expect(report.promotionCandidateRows).toBe(1);
    expect(report.verdict).not.toBe('STRICT_PROMOTION_READY');
    expect(report.verdictReasons).toContain('strict promotion unique 1 < 30');
  });

  it('marks strict promotion ready only after the strict sample gate is met', () => {
    const rows = Array.from({ length: 30 }, (_, index) => baseRow({
      closedAt: `2026-05-${String(17 + (index % 3)).padStart(2, '0')}T00:00:00.000Z`,
      paperRole: 'mirror',
      profileArm: 'rotation_underfill_cost_aware_exit_v2',
      liveEquivalenceCandidateId: `strict-candidate-${index}`,
      liveEquivalenceDecisionId: `strict-decision-${index}`,
      executionPlanHash: `strict-hash-${index}`,
      routeFound: true,
      netSolTokenOnly: 0.01,
    }));

    const report = buildReport(rows, args);

    expect(report.uniquePromotionCandidates).toBe(30);
    expect(report.verdict).toBe('STRICT_PROMOTION_READY');
  });

  it('builds a bridge reconciliation backlog for the shortest safe promotion path', () => {
    const report = buildReport([
      ...bridgePair(1),
      baseRow({
        positionId: 'repair-1',
        paperRole: 'mirror',
        profileArm: 'rotation_underfill_exit_flow_v1',
        liveEquivalenceCandidateId: 'repair-candidate:rotation_underfill_cost_aware_exit_v2',
        liveEquivalenceDecisionId: 'repair-decision:rotation_underfill_cost_aware_exit_v2',
        executionPlanHash: 'repair-hash',
        routeFound: true,
        netSolTokenOnly: 0.02,
      }),
      baseRow({
        positionId: 'legacy-positive-1',
        paperRole: 'mirror',
        profileArm: 'rotation_underfill_exit_flow_v1',
        liveEquivalenceCandidateId: 'legacy-candidate',
        liveEquivalenceDecisionId: 'legacy-decision',
        executionPlanHash: 'legacy-hash',
        routeFound: true,
        netSolTokenOnly: 0.015,
      }),
      baseRow({
        positionId: 'cost-loss-1',
        paperRole: 'mirror',
        profileArm: 'rotation_underfill_cost_aware_exit_v2',
        liveEquivalenceCandidateId: 'loss-candidate',
        liveEquivalenceDecisionId: 'loss-decision',
        executionPlanHash: 'loss-hash',
        routeFound: true,
        netSolTokenOnly: -0.01,
      }),
    ], args);

    expect(report.bridgeReconciliationBacklog[0]).toMatchObject({
      priority: 'P0',
      disposition: 'COLLECT_FORWARD_SAMPLE',
      blocker: 'primary_bridge_unique_gap',
      action: expect.stringContaining('collect +29 unique primary bridge candidates'),
    });
    expect(report.bridgeReconciliationBacklog).toEqual(expect.arrayContaining([
      expect.objectContaining({
        priority: 'P0',
        disposition: 'REPAIR_ATTRIBUTION',
        blocker: 'missing_cost_aware_profile',
        uniqueCandidates: 1,
      }),
      expect.objectContaining({
        priority: 'P2',
        disposition: 'POLICY_MISMATCH',
        blocker: 'missing_cost_aware_profile',
        uniqueCandidates: 1,
      }),
      expect.objectContaining({
        priority: 'P1',
        disposition: 'COUNTED_AS_BRIDGE',
        blocker: 'safe_bridge:non_comparable_role',
        uniqueCandidates: 1,
      }),
      expect.objectContaining({
        priority: 'P2',
        disposition: 'KEEP_BLOCKED',
        blocker: 'wallet_stress_non_positive',
        uniqueCandidates: 1,
      }),
    ]));
  });
});
