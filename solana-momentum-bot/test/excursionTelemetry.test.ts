import {
  buildExcursionTelemetryRecord,
  emptyExcursionTelemetry,
  updateExcursionTelemetry,
} from '../src/orchestration/excursionTelemetry';

describe('excursion telemetry', () => {
  it('captures MAE snapshots and worst/recovery values over time', () => {
    let telemetry = emptyExcursionTelemetry();

    telemetry = updateExcursionTelemetry(telemetry, {
      elapsedSec: 4,
      maePct: -0.02,
      mfePct: 0.01,
      currentPct: -0.01,
    });
    telemetry = updateExcursionTelemetry(telemetry, {
      elapsedSec: 8,
      maePct: -0.06,
      mfePct: 0.03,
      currentPct: -0.04,
    });
    telemetry = updateExcursionTelemetry(telemetry, {
      elapsedSec: 35,
      maePct: -0.08,
      mfePct: 0.15,
      currentPct: 0.02,
    });

    expect(telemetry.maeAt5s).toBeCloseTo(-0.06);
    expect(telemetry.maeAt15s).toBeCloseTo(-0.08);
    expect(telemetry.maeAt30s).toBeCloseTo(-0.08);
    expect(telemetry.maeAt60s).toBeNull();
    expect(telemetry.maeWorstPct).toBeCloseTo(-0.08);
    expect(telemetry.maeWorstAtSec).toBe(35);
    expect(telemetry.maeRecoveryPct).toBeCloseTo(0.10);
  });

  it('emits hard-cut trigger fields only for hard-cut style exits', () => {
    const telemetry = updateExcursionTelemetry(emptyExcursionTelemetry(), {
      elapsedSec: 12,
      maePct: -0.11,
      mfePct: 0.02,
      currentPct: -0.10,
    });

    const hardCut = buildExcursionTelemetryRecord(telemetry, {
      reason: 'REJECT_HARD_CUT',
      maePctAtClose: -0.11,
      elapsedSec: 12,
    });
    const trailing = buildExcursionTelemetryRecord(telemetry, {
      reason: 'winner_trailing_t1',
      maePctAtClose: -0.11,
      elapsedSec: 12,
    });

    expect(hardCut.hardCutTriggerMaePct).toBeCloseTo(-0.11);
    expect(hardCut.hardCutTriggerElapsedSec).toBe(12);
    expect(trailing.hardCutTriggerMaePct).toBeNull();
    expect(trailing.hardCutTriggerElapsedSec).toBeNull();
  });
});
