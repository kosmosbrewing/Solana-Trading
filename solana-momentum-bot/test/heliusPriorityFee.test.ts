/**
 * Helius Priority Fee client + classifier tests (2026-05-01, Stream F).
 */

import {
  parsePriorityFeeResponse,
  classifyPriorityFee,
} from '../src/ingester/heliusPriorityFeeClient';

describe('parsePriorityFeeResponse', () => {
  it('정상 response → estimate + levels', () => {
    const r = parsePriorityFeeResponse({
      priorityFeeEstimate: 5000,
      priorityFeeLevels: { min: 100, low: 1000, medium: 5000, high: 20000, veryHigh: 100000 },
    });
    expect(r).toBeDefined();
    expect(r!.priorityFeeEstimate).toBe(5000);
    expect(r!.priorityFeeLevels?.Min).toBe(100);
    expect(r!.priorityFeeLevels?.Medium).toBe(5000);
    expect(r!.priorityFeeLevels?.VeryHigh).toBe(100000);
  });

  it('priorityFeeEstimate 누락 → undefined', () => {
    expect(parsePriorityFeeResponse({})).toBeUndefined();
    expect(parsePriorityFeeResponse({ priorityFeeLevels: {} })).toBeUndefined();
  });

  it('priorityFeeEstimate NaN → undefined', () => {
    expect(parsePriorityFeeResponse({ priorityFeeEstimate: NaN })).toBeUndefined();
  });

  it('priorityFeeLevels 미존재 → estimate 만 반환', () => {
    const r = parsePriorityFeeResponse({ priorityFeeEstimate: 1000 });
    expect(r).toBeDefined();
    expect(r!.priorityFeeEstimate).toBe(1000);
    expect(r!.priorityFeeLevels).toBeUndefined();
  });

  it('null / non-object → undefined', () => {
    expect(parsePriorityFeeResponse(null)).toBeUndefined();
    expect(parsePriorityFeeResponse(undefined)).toBeUndefined();
    expect(parsePriorityFeeResponse('string')).toBeUndefined();
  });

  it('알려지지 않은 level key → 무시', () => {
    const r = parsePriorityFeeResponse({
      priorityFeeEstimate: 1000,
      priorityFeeLevels: { min: 100, fakeLevel: 999, medium: 500 },
    });
    expect(r!.priorityFeeLevels?.Min).toBe(100);
    expect(r!.priorityFeeLevels?.Medium).toBe(500);
    expect(Object.keys(r!.priorityFeeLevels ?? {})).not.toContain('fakeLevel');
  });
});

describe('classifyPriorityFee — heuristic 6 level', () => {
  it.each([
    [0, 'Min'],
    [999, 'Min'],
    [1000, 'Low'],
    [9999, 'Low'],
    [10_000, 'Medium'],
    [49_999, 'Medium'],
    [50_000, 'High'],
    [199_999, 'High'],
    [200_000, 'VeryHigh'],
    [999_999, 'VeryHigh'],
    [1_000_000, 'UnsafeMax'],
    [10_000_000, 'UnsafeMax'],
  ])('%d microLamports → %s', (input, expected) => {
    expect(classifyPriorityFee(input)).toBe(expected);
  });

  it('NaN / 음수 → undefined', () => {
    expect(classifyPriorityFee(NaN)).toBeUndefined();
    expect(classifyPriorityFee(-1)).toBeUndefined();
    expect(classifyPriorityFee(Infinity)).toBeUndefined();
  });
});
