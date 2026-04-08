/**
 * Cohort 분류 — fresh pair 측정 축의 단일 소스.
 *
 * Why:
 *   - 1 SOL → 100 SOL 사명의 edge는 "신생 low-marketcap 토큰의 초기 volume spike" 구간에 있다.
 *   - 기존 funnel 메트릭은 cohort 를 구분하지 않아 fresh 탈락 병목이 보이지 않는다.
 *   - 본 모듈은 Phase 1 instrumentation 의 기반으로서, 모든 cohort 판정을 단일 API 로 수렴시킨다.
 *
 * 경계값:
 *   - fresh  : age ≤ 20 분 — 초기 spike 구간
 *   - mid    : 20 분 < age ≤ 6 시간 — transition
 *   - mature : age > 6 시간 — 성숙 pair
 *   - unknown: age source 미도착 (신생에서 흔함)
 *
 * unknown grace:
 *   - Phase 2 feature flag (BOT_FRESH_UNKNOWN_AS_FRESH) 에서 fresh 와 동등 취급하기 위한
 *     판정 결과를 분리 노출한다. Phase 1 에서는 '라벨' 만 제공, 분기 동작 변경 없음.
 */

export type Cohort = 'fresh' | 'mid' | 'mature' | 'unknown';

export const COHORT_FRESH_MAX_HOURS = 20 / 60; // 20 minutes
export const COHORT_MID_MAX_HOURS = 6;          // 6 hours

export interface CohortAgeSources {
  /** Birdeye / GeckoTerminal updated_at (ISO string) */
  birdeyeUpdatedAt?: string | null;
  /** DexScreener pairCreatedAt (ms since epoch) */
  pairCreatedAtMs?: number | null;
  /** Helius pool registry createdAt (ms since epoch) */
  heliusPoolCreatedAtMs?: number | null;
  /** Explicit ageHours override (e.g., from existing PoolInfo.tokenAgeHours) */
  ageHours?: number | null;
}

/**
 * ageHours → Cohort. 경계값 포함 (≤) 방식.
 * - unknown: ageHours 가 null/undefined/NaN/Infinity
 */
export function resolveCohort(ageHours: number | null | undefined): Cohort {
  if (ageHours == null || !Number.isFinite(ageHours) || ageHours < 0) {
    return 'unknown';
  }
  if (ageHours <= COHORT_FRESH_MAX_HOURS) return 'fresh';
  if (ageHours <= COHORT_MID_MAX_HOURS) return 'mid';
  return 'mature';
}

/**
 * 여러 age source 중 가장 이른(= 가장 오래된) timestamp 를 채택해 ageHours 를 계산한다.
 * Why: source 간 skew 가 있을 때, "가장 먼저 본 시점" 기준으로 판정해야
 *      신생 pair 의 cohort 가 실제보다 젊게 나오는 허위양성(false fresh) 을 방지한다.
 */
export function resolveCohortFromSources(sources: CohortAgeSources, nowMs = Date.now()): Cohort {
  if (sources.ageHours != null && Number.isFinite(sources.ageHours) && sources.ageHours >= 0) {
    return resolveCohort(sources.ageHours);
  }

  const candidates: number[] = [];

  if (sources.birdeyeUpdatedAt) {
    const ts = Date.parse(sources.birdeyeUpdatedAt);
    if (Number.isFinite(ts)) candidates.push(ts);
  }
  if (sources.pairCreatedAtMs != null && Number.isFinite(sources.pairCreatedAtMs)) {
    candidates.push(sources.pairCreatedAtMs);
  }
  if (sources.heliusPoolCreatedAtMs != null && Number.isFinite(sources.heliusPoolCreatedAtMs)) {
    candidates.push(sources.heliusPoolCreatedAtMs);
  }

  if (candidates.length === 0) return 'unknown';

  const earliestMs = Math.min(...candidates);
  if (earliestMs > nowMs) return 'unknown'; // clock skew 방어
  const ageHours = (nowMs - earliestMs) / 3_600_000;
  return resolveCohort(ageHours);
}

/** 리포팅/로그용 고정 순서 */
export const COHORT_ORDER: readonly Cohort[] = ['fresh', 'mid', 'mature', 'unknown'] as const;

/**
 * COHORT_ORDER 기반으로 cohort → value 레코드를 초기화한다.
 * Why: 여러 리포트 집계 함수가 `{fresh, mid, mature, unknown}` literal 과
 *      for-loop 초기화를 중복 작성하고 있었다 — 단일 헬퍼로 통일해 dead-init 과
 *      COHORT_ORDER 변경 시 누락 위험을 제거한다.
 */
export function createCohortRecord<T>(factory: () => T): Record<Cohort, T> {
  const result = {} as Record<Cohort, T>;
  for (const cohort of COHORT_ORDER) {
    result[cohort] = factory();
  }
  return result;
}
