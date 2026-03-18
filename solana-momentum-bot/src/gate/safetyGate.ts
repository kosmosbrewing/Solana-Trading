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

export interface SafetyGateThresholds {
  minPoolLiquidity: number;
  minTokenAgeHours: number;
  maxHolderConcentration: number;
  /** v2: Age bucket graduated sizing (default true) */
  enableAgeBuckets?: boolean;
}

export interface SafetyGateResult {
  approved: boolean;
  reason?: string;
  sizeMultiplier: number;
  appliedAdjustments: string[];
}

/**
 * v2 Age Bucket Graduated Sizing:
 *   < 20min         → reject (rug 위험 극대)
 *   20min ~ 2h      → sizeMultiplier × 0.25
 *   2h ~ 24h        → sizeMultiplier × 0.5
 *   ≥ 24h           → sizeMultiplier × 1.0 (감산 없음)
 *
 * enableAgeBuckets=false 시 기존 binary reject(< minTokenAgeHours) 유지.
 */
function applyAgeBucket(
  ageHours: number,
  enableAgeBuckets: boolean
): { multiplier: number; adjustment?: string; rejectReason?: string } {
  if (!enableAgeBuckets) return { multiplier: 1.0 };

  const ageMinutes = ageHours * 60;

  if (ageMinutes < 20) {
    return { multiplier: 0, rejectReason: `Token too new: ${ageMinutes.toFixed(0)}min (< 20min hard floor)` };
  }
  if (ageHours < 2) {
    return { multiplier: 0.25, adjustment: `AGE_BUCKET_20MIN_2H_25PCT` };
  }
  if (ageHours < 24) {
    return { multiplier: 0.5, adjustment: `AGE_BUCKET_2H_24H_50PCT` };
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

  if (safety.poolLiquidity < thresholds.minPoolLiquidity) {
    return {
      approved: false,
      reason: `Pool liquidity too low: $${safety.poolLiquidity.toFixed(0)}`,
      sizeMultiplier,
      appliedAdjustments,
    };
  }

  // v2: Age bucket graduated sizing
  if (enableAgeBuckets) {
    const bucket = applyAgeBucket(safety.tokenAgeHours, enableAgeBuckets);
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
