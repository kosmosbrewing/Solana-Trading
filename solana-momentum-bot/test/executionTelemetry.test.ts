/**
 * executionTelemetry tests (2026-05-01, Stream F).
 */

import {
  buildExecutionTelemetry,
  classifyCopyability,
  classifyFeeUnderpaid,
} from '../src/observability/executionTelemetry';

describe('buildExecutionTelemetry', () => {
  it('정상 path → executionCopyabilityFlag=normal', () => {
    const r = buildExecutionTelemetry({
      priorityFeeEstimateMicroLamports: 5000,
      priorityFeeLevel: 'Medium',
      landingLatencyMs: 200,
      anchorSlot: 100,
      confirmedSlot: 102,
    });
    expect(r.executionCopyabilityFlag).toBe('normal');
    expect(r.landingSlotDelta).toBe(2);
  });

  it('late landing → late_landing flag', () => {
    const r = buildExecutionTelemetry({
      landingLatencyMs: 6000, // > 5000 threshold
    });
    expect(r.executionCopyabilityFlag).toBe('late_landing');
  });

  it('slot drift → slot_drift flag', () => {
    const r = buildExecutionTelemetry({
      anchorSlot: 100,
      confirmedSlot: 110, // delta 10 > 8 threshold
    });
    expect(r.executionCopyabilityFlag).toBe('slot_drift');
    expect(r.landingSlotDelta).toBe(10);
  });

  it('priority over slot — late landing 우선 분류', () => {
    const r = buildExecutionTelemetry({
      landingLatencyMs: 8000,
      anchorSlot: 100,
      confirmedSlot: 200, // huge slot drift
    });
    expect(r.executionCopyabilityFlag).toBe('late_landing');
  });

  it('confirmedSlot < anchorSlot → delta clamp 0', () => {
    const r = buildExecutionTelemetry({ anchorSlot: 100, confirmedSlot: 90 });
    expect(r.landingSlotDelta).toBe(0);
  });

  it('anchor/confirmed 미공급 → landingSlotDelta undefined', () => {
    const r = buildExecutionTelemetry({});
    expect(r.landingSlotDelta).toBeUndefined();
  });

  it('threshold 보정 가능', () => {
    const r = buildExecutionTelemetry({
      landingLatencyMs: 1000,
      thresholds: { landingLatencyMsHigh: 500, slotDeltaHigh: 8 },
    });
    expect(r.executionCopyabilityFlag).toBe('late_landing');
  });
});

describe('classifyCopyability', () => {
  it('latency NaN → normal', () => {
    expect(classifyCopyability({
      landingLatencyMs: NaN,
      landingLatencyMsHigh: 5000,
      slotDeltaHigh: 8,
    })).toBe('normal');
  });
});

describe('classifyFeeUnderpaid', () => {
  it.each([
    [1000, 5000, true],   // paid 1k < recommended 5k
    [5000, 5000, false],  // equal
    [10000, 5000, false], // overpaid
    [undefined, 5000, false],
    [1000, undefined, false],
    [NaN, 5000, false],
  ])('paid=%s recommended=%s → %s', (paid, rec, expected) => {
    expect(classifyFeeUnderpaid(
      paid as number | undefined,
      rec as number | undefined,
    )).toBe(expected);
  });
});
