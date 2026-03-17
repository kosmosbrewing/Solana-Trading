import { buildFibPullbackOrder, buildVolumeSpikeOrder } from '../strategy';
import { estimateSlippage } from '../risk';
import type { Candle, Order, PoolInfo, Signal } from '../utils/types';

const MIN_EFFECTIVE_RR_REJECT = 1.2;
const MIN_EFFECTIVE_RR_PASS = 1.5;
const DEFAULT_AMM_FEE_PCT = parseOptionalNumber(process.env.DEFAULT_AMM_FEE_PCT, 0.005);
const DEFAULT_MEV_MARGIN_PCT = parseOptionalNumber(process.env.DEFAULT_MEV_MARGIN_PCT, 0.0015);

export interface ExecutionViabilityResult {
  effectiveRR: number;
  roundTripCost: number;
  sizeMultiplier: number;
  rejected: boolean;
  filterReason?: string;
}

export function evaluateExecutionViability(
  signal: Signal,
  candles: Candle[],
  poolInfo: PoolInfo,
  estimatedQuantitySol?: number
): ExecutionViabilityResult {
  const probeQty = estimatedQuantitySol ?? 1;
  const order = signal.strategy === 'fib_pullback'
    ? buildFibPullbackOrder(signal, candles, probeQty)
    : buildVolumeSpikeOrder(signal, candles, probeQty);
  // H-03: SpreadMeasurer 실측값이 있으면 ammFeePct 대신 사용
  const measuredSpread = signal.spreadPct;
  return evaluateExecutionViabilityForOrder(order, poolInfo.tvl, {
    ammFeePct: measuredSpread != null ? measuredSpread : poolInfo.ammFeePct,
    mevMarginPct: poolInfo.mevMarginPct,
  });
}

export function evaluateExecutionViabilityForOrder(
  order: Pick<Order, 'price' | 'quantity' | 'stopLoss' | 'takeProfit2'>,
  poolTvl: number,
  costs: { ammFeePct?: number; mevMarginPct?: number } = {}
): ExecutionViabilityResult {
  if (order.quantity <= 0) {
    return {
      effectiveRR: 0,
      roundTripCost: 0,
      sizeMultiplier: 0,
      rejected: true,
      filterReason: 'poor_execution_viability: zero_quantity',
    };
  }

  const ammFeePct = costs.ammFeePct ?? DEFAULT_AMM_FEE_PCT;
  const mevMarginPct = costs.mevMarginPct ?? DEFAULT_MEV_MARGIN_PCT;
  const riskPct = order.price > 0 ? Math.max((order.price - order.stopLoss) / order.price, 0) : 0;
  const rewardPct = order.price > 0 ? Math.max((order.takeProfit2 - order.price) / order.price, 0) : 0;
  const entryPriceImpact = estimateSlippage(order.price * order.quantity, poolTvl, 0, 0);
  const exitPriceImpact = estimateSlippage(order.takeProfit2 * order.quantity, poolTvl, 0, 0);
  const roundTripCost = entryPriceImpact + exitPriceImpact + ammFeePct + mevMarginPct;
  const effectiveRR = riskPct > 0
    ? Math.max(rewardPct - roundTripCost, 0) / (riskPct + roundTripCost)
    : 0;

  if (effectiveRR < MIN_EFFECTIVE_RR_REJECT) {
    return {
      effectiveRR,
      roundTripCost,
      sizeMultiplier: 0,
      rejected: true,
      filterReason: formatExecutionFilterReason(effectiveRR, roundTripCost),
    };
  }

  if (effectiveRR < MIN_EFFECTIVE_RR_PASS) {
    return {
      effectiveRR,
      roundTripCost,
      sizeMultiplier: 0.5,
      rejected: false,
    };
  }

  return {
    effectiveRR,
    roundTripCost,
    sizeMultiplier: 1,
    rejected: false,
  };
}

function formatExecutionFilterReason(effectiveRR: number, roundTripCost: number): string {
  return (
    `poor_execution_viability: effectiveRR=${effectiveRR.toFixed(2)} ` +
    `roundTripCost=${(roundTripCost * 100).toFixed(2)}%`
  );
}

function parseOptionalNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
