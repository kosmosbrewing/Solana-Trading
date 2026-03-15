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
}

export interface SafetyGateResult {
  approved: boolean;
  reason?: string;
  sizeMultiplier: number;
  appliedAdjustments: string[];
}

export function checkTokenSafety(
  safety: TokenSafety,
  thresholds: SafetyGateThresholds
): SafetyGateResult {
  let sizeMultiplier = 1.0;
  const appliedAdjustments: string[] = [];

  if (safety.poolLiquidity < thresholds.minPoolLiquidity) {
    return {
      approved: false,
      reason: `Pool liquidity too low: $${safety.poolLiquidity.toFixed(0)}`,
      sizeMultiplier,
      appliedAdjustments,
    };
  }

  if (safety.tokenAgeHours < thresholds.minTokenAgeHours) {
    return {
      approved: false,
      reason: `Token too new: ${safety.tokenAgeHours.toFixed(1)}h old`,
      sizeMultiplier,
      appliedAdjustments,
    };
  }

  if (safety.top10HolderPct > thresholds.maxHolderConcentration) {
    return {
      approved: false,
      reason: `Holder concentration too high: ${(safety.top10HolderPct * 100).toFixed(1)}%`,
      sizeMultiplier,
      appliedAdjustments,
    };
  }

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
