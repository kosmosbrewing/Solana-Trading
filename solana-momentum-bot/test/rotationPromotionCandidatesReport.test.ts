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
});
