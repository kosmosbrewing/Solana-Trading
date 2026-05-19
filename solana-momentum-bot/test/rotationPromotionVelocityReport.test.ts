import {
  buildRotationPromotionVelocityReport,
  renderRotationPromotionVelocityReport,
} from '../scripts/rotation-promotion-velocity-report';

function candidate(id: number, closedAt: string): Record<string, unknown> {
  return {
    closedAt,
    candidateId: `candidate-${id}`,
    tokenMint: `Mint${id}`,
    walletStressSol: 0.01,
  };
}

describe('rotation-promotion-velocity-report', () => {
  it('estimates ETA from recent safe bridge candidate flow', () => {
    const report = buildRotationPromotionVelocityReport({
      generatedAt: '2026-05-19T00:00:00.000Z',
      sinceHours: 168,
      primaryBridgeNextNeededPacket: {
        targetUniqueCandidates: 30,
        currentUniqueCandidates: 17,
        neededUniqueCandidates: 13,
      },
      primaryBridgeRoster: [
        candidate(1, '2026-05-17T00:00:00.000Z'),
        candidate(2, '2026-05-18T00:00:00.000Z'),
        candidate(3, '2026-05-19T00:00:00.000Z'),
        candidate(4, '2026-05-19T01:00:00.000Z'),
      ],
    });

    expect(report.verdict).toBe('COLLECTING');
    expect(report.neededUniqueCandidates).toBe(13);
    expect(report.recent24hCandidates).toBe(2);
    expect(report.etaDays).toBeCloseTo(13 / 2, 5);
  });

  it('reports ready once the target candidate count is reached', () => {
    const report = buildRotationPromotionVelocityReport({
      sinceHours: 168,
      primaryBridgeNextNeededPacket: {
        targetUniqueCandidates: 30,
        currentUniqueCandidates: 30,
        neededUniqueCandidates: 0,
      },
      primaryBridgeRoster: [candidate(1, '2026-05-19T00:00:00.000Z')],
    });
    const md = renderRotationPromotionVelocityReport(report);

    expect(report.verdict).toBe('READY');
    expect(report.etaDays).toBe(0);
    expect(md).toContain('Rotation Promotion Candidate Velocity');
  });
});
