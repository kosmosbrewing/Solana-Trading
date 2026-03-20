import { PoolInfo, TokenSafety } from '../utils/types';

type SafetyPoolInfo = Pick<
  PoolInfo,
  'tvl' | 'tokenAgeHours' | 'lpBurned' | 'ownershipRenounced' | 'top10HolderPct'
>;

export function buildTokenSafety(poolInfo?: SafetyPoolInfo): TokenSafety | undefined {
  if (!poolInfo) return undefined;

  return {
    poolLiquidity: poolInfo.tvl,
    tokenAgeHours: poolInfo.tokenAgeHours,
    lpBurned: poolInfo.lpBurned,
    ownershipRenounced: poolInfo.ownershipRenounced,
    top10HolderPct: poolInfo.top10HolderPct,
  };
}

/** v4: 설정 가능한 Age Bucket 구간 */
export interface AgeBucketTier {
  upperHours: number;
  multiplier: number;
}

/** v4: Equity 기반 TVL 최소 기준 tier */
export interface LiquidityTier {
  minEquitySol: number;
  minPoolLiquidity: number;
}

export interface SafetyGateThresholds {
  minPoolLiquidity: number;
  minTokenAgeHours: number;
  maxHolderConcentration: number;
  /** v2: Age bucket graduated sizing (default true) */
  enableAgeBuckets?: boolean;
  /** v4: reject 기준 (분). 기본값 15분 */
  ageBucketHardFloorMin?: number;
  /** v4: 구간별 승수 배열 (upperHours 오름차순). 마지막 구간 초과 → 1.0x */
  ageBucketTiers?: AgeBucketTier[];
  /** v4: Equity 기반 TVL 최소 기준 tiers (minEquitySol 내림차순 평가) */
  liquidityTiers?: LiquidityTier[];
  /** v4: 현재 포트폴리오 equity (동적 TVL 기준에 사용) */
  equitySol?: number;
}

export interface SafetyGateResult {
  approved: boolean;
  reason?: string;
  sizeMultiplier: number;
  appliedAdjustments: string[];
}

/**
 * v4: Equity 기반 동적 minPoolLiquidity 결정
 * 포트폴리오가 클수록 저유동성 토큰 진입 차단
 */
function resolveMinPoolLiquidity(
  baseMin: number,
  equitySol?: number,
  tiers?: LiquidityTier[]
): number {
  if (equitySol == null || !tiers || tiers.length === 0) return baseMin;

  // tiers를 minEquitySol 내림차순으로 평가
  const sorted = [...tiers].sort((a, b) => b.minEquitySol - a.minEquitySol);
  for (const tier of sorted) {
    if (equitySol >= tier.minEquitySol) {
      return Math.max(baseMin, tier.minPoolLiquidity);
    }
  }
  return baseMin;
}

/** v4 기본 Age Bucket 구간 (Step 2 완화 적용) */
const DEFAULT_AGE_BUCKET_TIERS: AgeBucketTier[] = [
  { upperHours: 1, multiplier: 0.25 },
  { upperHours: 4, multiplier: 0.5 },
  { upperHours: 24, multiplier: 0.75 },
];

const DEFAULT_HARD_FLOOR_MIN = 15;

/**
 * v4 Age Bucket Graduated Sizing (설정 가능):
 *   < hardFloorMin   → reject
 *   구간 배열 순회    → 해당 승수 적용
 *   마지막 구간 초과  → 1.0x
 *
 * enableAgeBuckets=false 시 기존 binary reject(< minTokenAgeHours) 유지.
 */
function applyAgeBucket(
  ageHours: number,
  enableAgeBuckets: boolean,
  hardFloorMin: number = DEFAULT_HARD_FLOOR_MIN,
  tiers: AgeBucketTier[] = DEFAULT_AGE_BUCKET_TIERS
): { multiplier: number; adjustment?: string; rejectReason?: string } {
  if (!enableAgeBuckets) return { multiplier: 1.0 };

  const ageMinutes = ageHours * 60;

  if (ageMinutes < hardFloorMin) {
    return { multiplier: 0, rejectReason: `Token too new: ${ageMinutes.toFixed(0)}min (< ${hardFloorMin}min hard floor)` };
  }

  // 구간 배열 순회 (upperHours 오름차순)
  for (const tier of tiers) {
    if (ageHours < tier.upperHours) {
      const pct = Math.round(tier.multiplier * 100);
      return {
        multiplier: tier.multiplier,
        adjustment: `AGE_BUCKET_LT${tier.upperHours}H_${pct}PCT`,
      };
    }
  }

  return { multiplier: 1.0 };
}

export function checkTokenSafety(
  safety: TokenSafety,
  thresholds: SafetyGateThresholds
): SafetyGateResult {
  let sizeMultiplier = 1.0;
  const appliedAdjustments: string[] = [];
  const enableAgeBuckets = thresholds.enableAgeBuckets ?? true;

  // v4: Equity 기반 동적 minPoolLiquidity 계산
  const effectiveMinPool = resolveMinPoolLiquidity(
    thresholds.minPoolLiquidity,
    thresholds.equitySol,
    thresholds.liquidityTiers
  );

  if (safety.poolLiquidity < effectiveMinPool) {
    return {
      approved: false,
      reason: `Pool liquidity too low: $${safety.poolLiquidity.toFixed(0)}`,
      sizeMultiplier,
      appliedAdjustments,
    };
  }

  // v2: Age bucket graduated sizing
  if (enableAgeBuckets) {
    const bucket = applyAgeBucket(
      safety.tokenAgeHours,
      enableAgeBuckets,
      thresholds.ageBucketHardFloorMin,
      thresholds.ageBucketTiers
    );
    if (bucket.rejectReason) {
      return {
        approved: false,
        reason: bucket.rejectReason,
        sizeMultiplier,
        appliedAdjustments,
      };
    }
    if (bucket.multiplier < 1.0) {
      sizeMultiplier *= bucket.multiplier;
      appliedAdjustments.push(bucket.adjustment!);
    }
  } else {
    // Legacy binary reject
    if (safety.tokenAgeHours < thresholds.minTokenAgeHours) {
      return {
        approved: false,
        reason: `Token too new: ${safety.tokenAgeHours.toFixed(1)}h old`,
        sizeMultiplier,
        appliedAdjustments,
      };
    }
  }

  if (safety.top10HolderPct > thresholds.maxHolderConcentration) {
    return {
      approved: false,
      reason: `Holder concentration too high: ${(safety.top10HolderPct * 100).toFixed(1)}%`,
      sizeMultiplier,
      appliedAdjustments,
    };
  }

  // LP/ownership 감산은 age bucket과 곱셈 누적
  if (!safety.lpBurned) {
    sizeMultiplier *= 0.5;
    appliedAdjustments.push('LP_NOT_BURNED_HALF');
  }

  if (!safety.ownershipRenounced) {
    sizeMultiplier *= 0.5;
    appliedAdjustments.push('OWNERSHIP_NOT_RENOUNCED_HALF');
  }

  return {
    approved: true,
    reason: appliedAdjustments.length > 0
      ? `Safety adjustments applied: ${appliedAdjustments.join(', ')}`
      : undefined,
    sizeMultiplier,
    appliedAdjustments,
  };
}
