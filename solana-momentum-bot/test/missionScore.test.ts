import { computeMissionScore, computeCompositeScore } from '../src/reporting/missionScore';

describe('computeMissionScore', () => {
  it('returns 0 when all inputs are 0', () => {
    const result = computeMissionScore({
      explainedEntryRatio: 0,
      eventEntryPct: 0,
      unexplainedSuppressionRate: 0,
      safetyDiscipline: 0,
      traceability: 0,
    });
    expect(result.total).toBe(0);
    expect(result.components.contextClarity).toBe(0);
  });

  it('returns 100 when all inputs are 1.0', () => {
    const result = computeMissionScore({
      explainedEntryRatio: 1,
      eventEntryPct: 1,
      unexplainedSuppressionRate: 1,
      safetyDiscipline: 1,
      traceability: 1,
    });
    expect(result.total).toBe(100);
    expect(result.components.contextClarity).toBe(25);
    expect(result.components.eventAlignment).toBe(20);
    expect(result.components.unexplainedSuppression).toBe(20);
    expect(result.components.safetyDiscipline).toBe(20);
    expect(result.components.traceability).toBe(15);
  });

  it('contextClarity is 25 * explainedEntryRatio', () => {
    const result = computeMissionScore({
      explainedEntryRatio: 0.9,
      eventEntryPct: 0,
      unexplainedSuppressionRate: 0,
      safetyDiscipline: 0,
      traceability: 0,
    });
    expect(result.components.contextClarity).toBeCloseTo(22.5);
    expect(result.total).toBeCloseTo(22.5);
  });

  it('clamps inputs to 0~1', () => {
    const result = computeMissionScore({
      explainedEntryRatio: 1.5,
      eventEntryPct: -0.5,
      unexplainedSuppressionRate: 2,
      safetyDiscipline: 1,
      traceability: 1,
    });
    expect(result.components.contextClarity).toBe(25);
    expect(result.components.eventAlignment).toBe(0);
    expect(result.components.unexplainedSuppression).toBe(20);
    expect(result.total).toBe(25 + 0 + 20 + 20 + 15);
  });
});

describe('computeCompositeScore', () => {
  it('computes weighted sum: Mission*0.40 + Execution*0.25 + Edge*0.35', () => {
    const result = computeCompositeScore(80, 70, 90);
    expect(result.composite).toBeCloseTo(80 * 0.4 + 70 * 0.25 + 90 * 0.35);
    expect(result.mission).toBe(80);
    expect(result.execution).toBe(70);
    expect(result.edge).toBe(90);
  });

  it('returns 100 for all perfect scores', () => {
    const result = computeCompositeScore(100, 100, 100);
    expect(result.composite).toBeCloseTo(100);
  });

  it('returns 0 for all zero scores', () => {
    const result = computeCompositeScore(0, 0, 0);
    expect(result.composite).toBe(0);
  });
});
