import {
  buildRotationPromotionReadinessTrendReport,
  dedupeReadinessHistoryRows,
  renderRotationPromotionReadinessTrendReport,
  type ReadinessHistoryRow,
} from '../scripts/rotation-promotion-readiness-trend';

function row(
  recordedAt: string,
  neededUniqueCandidates: number,
  walletStressSol: number,
  topWinnerShare = 0.2,
  parentChildDeltaWalletStressSol = 0.01,
  fingerprint?: string
): ReadinessHistoryRow {
  return {
    recordedAt,
    fingerprint,
    status: 'WAIT',
    primaryWindowHours: 168,
    nextAction: 'keep live unchanged',
    reasons: [],
    windows: [{
      windowHours: 168,
      status: 'WAIT',
      currentUniqueCandidates: 30 - neededUniqueCandidates,
      neededUniqueCandidates,
      currentActiveDays: 3,
      neededActiveDays: 0,
      currentPositiveDays: 3,
      neededPositiveDays: 0,
      walletStressSol,
      topWinnerShare,
      parentChildDeltaWalletStressSol,
    }],
  };
}

describe('rotation-promotion-readiness-trend', () => {
  it('marks improving when needed candidates fall and wallet stress improves', () => {
    const report = buildRotationPromotionReadinessTrendReport([
      row('2026-05-19T00:00:00.000Z', 20, 0.03),
      row('2026-05-19T01:00:00.000Z', 13, 0.05),
    ]);

    expect(report.verdict).toBe('IMPROVING');
    expect(report.deltaNeededUniqueCandidates).toBe(-7);
  });

  it('marks deteriorating when concentration worsens', () => {
    const report = buildRotationPromotionReadinessTrendReport([
      row('2026-05-19T00:00:00.000Z', 13, 0.05, 0.2),
      row('2026-05-19T01:00:00.000Z', 13, 0.05, 0.3),
    ]);

    expect(report.verdict).toBe('DETERIORATING');
    expect(report.topWinnerShareWorsened).toBe(true);
  });

  it('marks flat when no material readiness metric moves', () => {
    const report = buildRotationPromotionReadinessTrendReport([
      row('2026-05-19T00:00:00.000Z', 13, 0.05),
      row('2026-05-19T01:00:00.000Z', 13, 0.05, 0.21),
    ]);
    const md = renderRotationPromotionReadinessTrendReport(report);

    expect(report.verdict).toBe('FLAT');
    expect(md).toContain('Rotation Promotion Readiness Trend');
  });

  it('dedupes consecutive identical fingerprints before judging trend', () => {
    const report = buildRotationPromotionReadinessTrendReport([
      row('2026-05-19T00:00:00.000Z', 20, 0.03, 0.2, 0.01, 'same'),
      row('2026-05-19T00:05:00.000Z', 20, 0.03, 0.2, 0.01, 'same'),
      row('2026-05-19T01:00:00.000Z', 13, 0.05, 0.2, 0.01, 'improved'),
    ]);

    expect(report.samples).toBe(2);
    expect(report.verdict).toBe('IMPROVING');
    expect(report.deltaNeededUniqueCandidates).toBe(-7);
  });

  it('treats repeated legacy rows as one sample even without stored fingerprints', () => {
    const rows = [
      row('2026-05-19T00:00:00.000Z', 13, 0.05),
      row('2026-05-19T01:00:00.000Z', 13, 0.05),
    ];
    const report = buildRotationPromotionReadinessTrendReport(rows);

    expect(dedupeReadinessHistoryRows(rows)).toHaveLength(1);
    expect(report.samples).toBe(1);
    expect(report.verdict).toBe('NO_SAMPLE');
  });

  it('does not treat report-code fingerprint changes as readiness movement', () => {
    const rows = [
      row('2026-05-19T00:00:00.000Z', 13, 0.05, 0.2, 0.01, 'old-classification'),
      row('2026-05-19T01:00:00.000Z', 13, 0.05, 0.2, 0.01, 'new-classification'),
    ];

    expect(dedupeReadinessHistoryRows(rows)).toHaveLength(1);
    expect(buildRotationPromotionReadinessTrendReport(rows).verdict).toBe('NO_SAMPLE');
  });
});
