import { SizeConstraint } from '../utils/types';

export interface LiquidityParams {
  maxSlippagePct: number;    // L1: 0.01 (1%)
  maxPoolImpactPct: number;  // L2: 0.02 (2%)
  emergencyHaircut: number;  // L3: 0.50 (50%)
}

export const DEFAULT_LIQUIDITY_PARAMS: LiquidityParams = {
  maxSlippagePct: 0.01,
  maxPoolImpactPct: 0.02,
  emergencyHaircut: 0.50,
};

export interface SizingResult {
  maxSize: number;
  constraint: SizeConstraint;
  estimatedSlippage: number;
  riskSize: number;
  liquiditySize: number;
  emergencySize: number;
}

/**
 * LiquiditySizer — AMM 유동성 기반 포지션 사이징
 *
 * 3-Constraint Model:
 * 1. 리스크 기반: portfolio × riskPerTrade / stopLossPct
 * 2. 유동성 기반: TVL × maxPoolImpactPct
 * 3. 비상청산 기반: TVL 50% 감소 가정 후 worstCaseLoss ≤ maxRisk
 *
 * 포지션 사이즈 = min(리스크, 유동성, 비상청산)
 */
export function calculateLiquiditySize(
  portfolioValue: number,
  riskPerTrade: number,
  stopLossPct: number,
  poolTvl: number,
  feeRate: number = 0.003,
  params: Partial<LiquidityParams> = {}
): SizingResult {
  const p = { ...DEFAULT_LIQUIDITY_PARAMS, ...params };

  // Constraint 1: 리스크 기반
  const maxRisk = portfolioValue * riskPerTrade;
  const riskSize = stopLossPct > 0 ? maxRisk / stopLossPct : 0;

  // Constraint 2: 유동성 기반
  const liquiditySize = poolTvl * p.maxPoolImpactPct;

  // Constraint 3: 비상청산 기반
  const emergencyTvl = poolTvl * (1 - p.emergencyHaircut);
  const emergencySize = calcEmergencySize(emergencyTvl, maxRisk, feeRate);

  // 최솟값 채택
  let maxSize: number;
  let constraint: SizeConstraint;

  if (riskSize <= liquiditySize && riskSize <= emergencySize) {
    maxSize = riskSize;
    constraint = 'RISK';
  } else if (liquiditySize <= emergencySize) {
    maxSize = liquiditySize;
    constraint = 'LIQUIDITY';
  } else {
    maxSize = emergencySize;
    constraint = 'EMERGENCY';
  }

  // 슬리피지 추정
  const estimatedSlippage = estimateSlippage(maxSize, poolTvl);

  // 슬리피지가 허용치 초과 시 추가 축소
  if (estimatedSlippage > p.maxSlippagePct) {
    const adjustedSize = findMaxSizeForSlippage(poolTvl, p.maxSlippagePct);
    if (adjustedSize < maxSize) {
      maxSize = adjustedSize;
      constraint = 'LIQUIDITY';
    }
  }

  return {
    maxSize: Math.max(0, maxSize),
    constraint,
    estimatedSlippage,
    riskSize,
    liquiditySize,
    emergencySize,
  };
}

/**
 * Constant Product AMM 슬리피지 추정 (fee + MEV 마진 포함)
 *
 * priceImpact = tradeSize / (poolReserve + tradeSize)
 * + AMM fee (0.3% default)
 * + MEV/frontrunning 마진 (0.1% — Solana 환경 추정)
 *
 * poolReserve = TVL / 2
 */
export function estimateSlippage(
  tradeSize: number,
  poolTvl: number,
  feeRate: number = 0.003,
  mevMarginPct: number = 0.001
): number {
  if (poolTvl <= 0 || tradeSize <= 0) return 0;
  const poolReserve = poolTvl / 2;
  const priceImpact = tradeSize / (poolReserve + tradeSize);
  return priceImpact + feeRate + mevMarginPct;
}

/**
 * 비상청산 시뮬레이션
 * TVL이 haircut 후 감소한 상태에서 포지션 청산 시
 * 실제 손실이 maxRisk 이내인 최대 사이즈 계산
 */
function calcEmergencySize(
  emergencyTvl: number,
  maxRisk: number,
  feeRate: number
): number {
  if (emergencyTvl <= 0) return 0;

  const poolReserve = emergencyTvl / 2;

  // Binary search for max position where loss <= maxRisk
  let lo = 0;
  let hi = poolReserve; // 풀 reserve보다 클 수 없음
  const iterations = 20;

  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const slippage = mid / (poolReserve + mid);
    const received = mid * (1 - slippage) * (1 - feeRate);
    const loss = mid - received;

    if (loss <= maxRisk) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return lo;
}

/**
 * 목표 슬리피지 이하가 되는 최대 사이즈
 */
function findMaxSizeForSlippage(poolTvl: number, maxSlippage: number): number {
  if (poolTvl <= 0 || maxSlippage <= 0) return 0;
  const poolReserve = poolTvl / 2;
  // slippage = size / (reserve + size)
  // size = slippage * reserve / (1 - slippage)
  return maxSlippage * poolReserve / (1 - maxSlippage);
}
