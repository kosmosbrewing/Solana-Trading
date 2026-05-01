/**
 * Pool Prewarm Admission Context (2026-05-01, Helius Stream D).
 *
 * ADR: docs/exec-plans/active/helius-credit-edge-plan-2026-05-01.md §6 Stream D
 *
 * 목적: KOL buy 직후 token 의 pool 정보가 scanner 에 warm 되어 있는지 즉시 검사 →
 *       sparse/no-pair miss 가 silently 발생하지 않도록 admission context 기록.
 *
 * 정책:
 *   - HeliusPoolRegistry 조회는 pure cache lookup (RPC 0)
 *   - prewarm 실패해도 hard reject 안 함 (Plan §6 Stream D step 5: "Do not hard reject")
 *   - 결과는 admission ledger 의 reason tag 로 기록 (sparse/no_pair/unsupported_dex/parse_miss/pool_prewarm_miss/capacity)
 *
 * 의존:
 *   - HeliusPoolRegistry (cache lookup, 신규 RPC 호출 0)
 *   - kolSignalHandler 가 호출자 — runtime wiring 은 PR 3 마무리 단계
 */

import type { HeliusPoolRegistry } from '../scanner/heliusPoolRegistry';

export type PrewarmSkipReason =
  | 'no_pair'
  | 'unsupported_dex'
  | 'parse_miss'
  | 'pool_prewarm_miss'
  | 'capacity'
  | 'cooldown'
  | 'shadow_kol'
  | 'unknown';

export type CandidateCohort =
  | 'kol_active'
  | 'kol_shadow'
  | 'cupsey_benchmark'
  | 'unknown';

export interface PoolPrewarmContext {
  /** Helius pool registry 에 hit (≥1 pool 알려짐) — pure cache 결과 */
  poolRegistryHit: boolean;
  /** 발견된 pool 수 (registry 안) */
  knownPoolCount: number;
  /** primary pool address (있으면) */
  primaryPool?: string;
  /** primary pool 의 dexId — 알려진 dex 만 admission 통과 */
  primaryDexId?: string;
  /** prewarm 시도 여부 — 현재는 cache lookup 만, RPC backfill 은 future enhancement */
  prewarmAttempted: boolean;
  /** prewarm 성공 여부 — registry hit 이거나 backfill 성공 시 true */
  prewarmSuccess: boolean;
  /** prewarm skip 사유 — registry miss 시 reason 명시 */
  prewarmSkipReason?: PrewarmSkipReason;
  /** 후보 cohort (admission ledger 분석 시 분리) */
  candidateCohort: CandidateCohort;
}

const KNOWN_DEX_IDS: ReadonlySet<string> = new Set([
  'pumpfun',
  'pumpswap',
  'raydium',
  'meteora',
  'orca',
  'jupiter',
]);

/**
 * Pool prewarm admission context 산출.
 *
 * 사용 예 (kolSignalHandler entry path):
 *   const ctx = await checkPoolPrewarm(registry, tokenMint, { isShadow: false });
 *   if (!ctx.prewarmSuccess) {
 *     log.info(`[POOL_PREWARM_MISS] ${tokenMint} reason=${ctx.prewarmSkipReason}`);
 *   }
 *   // admission ledger 에 ctx 전체 기록 (admission-skips-dex.jsonl 에 reason tag)
 */
export async function checkPoolPrewarm(
  registry: HeliusPoolRegistry,
  tokenMint: string,
  options: {
    isShadowKol?: boolean;
    /** 외부 capacity check — true 면 capacity skip */
    capacityExceeded?: boolean;
    /** 외부 cooldown check — true 면 cooldown skip */
    onCooldown?: boolean;
  } = {},
): Promise<PoolPrewarmContext> {
  const cohort: CandidateCohort = options.isShadowKol ? 'kol_shadow' : 'kol_active';

  // 사전 차단 사유 (cohort/capacity/cooldown) — registry 조회 전 빠른 path
  if (options.isShadowKol) {
    return {
      poolRegistryHit: false,
      knownPoolCount: 0,
      prewarmAttempted: false,
      prewarmSuccess: false,
      prewarmSkipReason: 'shadow_kol',
      candidateCohort: 'kol_shadow',
    };
  }
  if (options.capacityExceeded) {
    return {
      poolRegistryHit: false,
      knownPoolCount: 0,
      prewarmAttempted: false,
      prewarmSuccess: false,
      prewarmSkipReason: 'capacity',
      candidateCohort: cohort,
    };
  }
  if (options.onCooldown) {
    return {
      poolRegistryHit: false,
      knownPoolCount: 0,
      prewarmAttempted: false,
      prewarmSuccess: false,
      prewarmSkipReason: 'cooldown',
      candidateCohort: cohort,
    };
  }

  // Registry cache lookup — 정상 path
  const pairs = await registry.getTokenPairs(tokenMint);
  const knownPoolCount = pairs.length;
  const poolRegistryHit = knownPoolCount > 0;

  if (!poolRegistryHit) {
    // pair 자체 없음 — sparse / no_pair
    return {
      poolRegistryHit: false,
      knownPoolCount: 0,
      prewarmAttempted: true,
      prewarmSuccess: false,
      prewarmSkipReason: 'no_pair',
      candidateCohort: cohort,
    };
  }

  const primary = pairs[0];
  const primaryDexId = primary?.dexId;

  // 알려지지 않은 dex 만 등장 → unsupported_dex
  if (primaryDexId && !KNOWN_DEX_IDS.has(primaryDexId.toLowerCase())) {
    return {
      poolRegistryHit: true,
      knownPoolCount,
      primaryPool: primary?.pairAddress,
      primaryDexId,
      prewarmAttempted: true,
      prewarmSuccess: false,
      prewarmSkipReason: 'unsupported_dex',
      candidateCohort: cohort,
    };
  }

  // 정상 — registry hit + supported dex
  return {
    poolRegistryHit: true,
    knownPoolCount,
    primaryPool: primary?.pairAddress,
    primaryDexId,
    prewarmAttempted: true,
    prewarmSuccess: true,
    candidateCohort: cohort,
  };
}

/**
 * Admission ledger 에 prewarm 결과 추가 시 사용할 row 구조.
 * 신규 jsonl 신설 안 함 — 기존 `admission-skips-dex.jsonl` 의 reason tag 확장 추천.
 */
export interface PoolPrewarmAdmissionTag {
  prewarmContext: PoolPrewarmContext;
  /** Plan §6 Stream D acceptance: sparse/admission summary 5 reason 분리 */
  admissionReason:
    | 'no_pair'
    | 'unsupported_dex'
    | 'parse_miss'
    | 'pool_prewarm_miss'
    | 'capacity'
    | 'admitted';
}

export function classifyAdmissionReason(ctx: PoolPrewarmContext): PoolPrewarmAdmissionTag['admissionReason'] {
  if (ctx.prewarmSuccess) return 'admitted';
  if (ctx.prewarmSkipReason === 'no_pair') return 'no_pair';
  if (ctx.prewarmSkipReason === 'unsupported_dex') return 'unsupported_dex';
  if (ctx.prewarmSkipReason === 'capacity') return 'capacity';
  return 'pool_prewarm_miss';
}
