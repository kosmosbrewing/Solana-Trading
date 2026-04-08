/**
 * Cohort resolver 경계값 테스트.
 *
 * Why: Phase 1 instrumentation 의 판정 소스(resolveCohort / resolveCohortFromSources) 는
 *      이후 Phase 2 feature flag 에서 라우팅 분기점으로 승격된다. 경계값 오류가 누적되면
 *      fresh 토큰이 mature 로 새어나가거나 그 반대가 되어 측정이 오염되므로, Phase 1 에서
 *      가장 먼저 고정해 둔다.
 */

import {
  COHORT_FRESH_MAX_HOURS,
  COHORT_MID_MAX_HOURS,
  COHORT_ORDER,
  resolveCohort,
  resolveCohortFromSources,
} from '../src/scanner/cohort';

describe('resolveCohort', () => {
  it('returns "unknown" for null/undefined/NaN/Infinity/negative inputs', () => {
    expect(resolveCohort(null)).toBe('unknown');
    expect(resolveCohort(undefined)).toBe('unknown');
    expect(resolveCohort(Number.NaN)).toBe('unknown');
    expect(resolveCohort(Number.POSITIVE_INFINITY)).toBe('unknown');
    expect(resolveCohort(Number.NEGATIVE_INFINITY)).toBe('unknown');
    expect(resolveCohort(-0.01)).toBe('unknown');
  });

  it('treats age 0 as fresh (brand-new pair)', () => {
    expect(resolveCohort(0)).toBe('fresh');
  });

  it('labels the boundary exactly at 20 minutes as fresh (inclusive)', () => {
    // 19 min / 20 min (= COHORT_FRESH_MAX_HOURS) → fresh
    expect(resolveCohort(19 / 60)).toBe('fresh');
    expect(resolveCohort(COHORT_FRESH_MAX_HOURS)).toBe('fresh');
  });

  it('flips to mid immediately after 20 minutes', () => {
    // 20 min + 1 sec → mid
    expect(resolveCohort(COHORT_FRESH_MAX_HOURS + 1 / 3600)).toBe('mid');
    expect(resolveCohort(1)).toBe('mid'); // 1 hour
    expect(resolveCohort(COHORT_MID_MAX_HOURS)).toBe('mid'); // 6h inclusive
  });

  it('flips to mature immediately after 6 hours', () => {
    expect(resolveCohort(COHORT_MID_MAX_HOURS + 1 / 3600)).toBe('mature');
    expect(resolveCohort(7)).toBe('mature');
    expect(resolveCohort(24)).toBe('mature');
  });
});

describe('resolveCohortFromSources', () => {
  const NOW = Date.parse('2026-04-08T12:00:00.000Z');

  it('returns "unknown" when all sources are missing', () => {
    expect(resolveCohortFromSources({}, NOW)).toBe('unknown');
    expect(resolveCohortFromSources({ birdeyeUpdatedAt: null, pairCreatedAtMs: null }, NOW)).toBe('unknown');
  });

  it('honors explicit ageHours override without reading timestamp sources', () => {
    expect(resolveCohortFromSources({ ageHours: 0 }, NOW)).toBe('fresh');
    expect(resolveCohortFromSources({ ageHours: 0.1 }, NOW)).toBe('fresh'); // 6 min
    expect(resolveCohortFromSources({ ageHours: 1 }, NOW)).toBe('mid');
    expect(resolveCohortFromSources({ ageHours: 24, birdeyeUpdatedAt: new Date(NOW).toISOString() }, NOW)).toBe(
      'mature'
    );
  });

  it('uses the earliest timestamp across sources (prevents false-fresh)', () => {
    // Birdeye says "seen 5 min ago" but DexScreener pair was created 2 hours ago.
    // → earliest source wins, cohort should be 'mid' (not fresh).
    const birdeyeIso = new Date(NOW - 5 * 60 * 1000).toISOString();
    const pairCreatedAtMs = NOW - 2 * 60 * 60 * 1000;
    expect(
      resolveCohortFromSources({ birdeyeUpdatedAt: birdeyeIso, pairCreatedAtMs }, NOW)
    ).toBe('mid');
  });

  it('falls through to "unknown" when the earliest timestamp is in the future (clock skew)', () => {
    const futureMs = NOW + 10 * 60 * 1000;
    expect(resolveCohortFromSources({ pairCreatedAtMs: futureMs }, NOW)).toBe('unknown');
  });

  it('labels helius-only brand-new pools as fresh', () => {
    const heliusPoolCreatedAtMs = NOW - 3 * 60 * 1000; // 3 min ago
    expect(resolveCohortFromSources({ heliusPoolCreatedAtMs }, NOW)).toBe('fresh');
  });

  it('ignores malformed ISO strings and unsupported numeric values', () => {
    // Invalid ISO → Date.parse returns NaN → candidate skipped.
    // With no other source → 'unknown'.
    expect(resolveCohortFromSources({ birdeyeUpdatedAt: 'not-a-date' }, NOW)).toBe('unknown');
    expect(resolveCohortFromSources({ pairCreatedAtMs: Number.NaN }, NOW)).toBe('unknown');
  });
});

describe('COHORT_ORDER', () => {
  it('exposes the canonical reporting order fresh → mid → mature → unknown', () => {
    expect(COHORT_ORDER).toEqual(['fresh', 'mid', 'mature', 'unknown']);
  });
});
