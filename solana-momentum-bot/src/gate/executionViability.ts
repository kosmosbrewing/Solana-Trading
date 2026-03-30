import { buildFibPullbackOrder, buildVolumeSpikeOrder } from '../strategy';
import { estimateSlippage } from '../risk';
import type { Candle, Order, PoolInfo, Signal } from '../utils/types';

const DEFAULT_MIN_EFFECTIVE_RR_REJECT = 1.2;
const DEFAULT_MIN_EFFECTIVE_RR_PASS = 1.5;
// Why: config.ts import 시 required env vars 체크가 테스트를 깨뜨리므로 로컬 파싱 유지
// 값 기본값은 config.ts의 defaultAmmFeePct / defaultMevMarginPct와 동일하게 유지
const DEFAULT_AMM_FEE_PCT = parseOptionalNumber(process.env.DEFAULT_AMM_FEE_PCT, 0.005);
const DEFAULT_MEV_MARGIN_PCT = parseOptionalNumber(process.env.DEFAULT_MEV_MARGIN_PCT, 0.0015);

export interface ExecutionViabilityResult {
  effectiveRR: number;
  roundTripCost: number;
  sizeMultiplier: number;
  rejected: boolean;
  filterReason?: string;
  riskPct?: number;
  rewardPct?: number;
  entryPriceImpactPct?: number;
  exitPriceImpactPct?: number;
  quantity?: number;
  notionalSol?: number;
}

export function evaluateExecutionViability(
  signal: Signal,
  candles: Candle[],
  poolInfo: PoolInfo,
  estimatedPositionSol?: number
): ExecutionViabilityResult {
  const probeNotionalSol = estimatedPositionSol ?? 1;
  const probeQty = signal.price > 0 ? probeNotionalSol / signal.price : 0;
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
  costs: { ammFeePct?: number; mevMarginPct?: number } = {},
  thresholds: { rrReject?: number; rrPass?: number } = {}
): ExecutionViabilityResult {
  if (order.quantity <= 0) {
    return {
      effectiveRR: 0,
      roundTripCost: 0,
      sizeMultiplier: 0,
      rejected: true,
      filterReason: 'poor_execution_viability: zero_quantity',
      riskPct: 0,
      rewardPct: 0,
      entryPriceImpactPct: 0,
      exitPriceImpactPct: 0,
      quantity: order.quantity,
      notionalSol: 0,
    };
  }

  const ammFeePct = costs.ammFeePct ?? DEFAULT_AMM_FEE_PCT;
  const mevMarginPct = costs.mevMarginPct ?? DEFAULT_MEV_MARGIN_PCT;
  const riskPct = order.price > 0 ? Math.max((order.price - order.stopLoss) / order.price, 0) : 0;
  const rewardPct = order.price > 0 ? Math.max((order.takeProfit2 - order.price) / order.price, 0) : 0;
  const notionalSol = order.price * order.quantity;
  // Why fee=0, mev=0: estimateSlippage()에 순수 price impact만 추출, AMM fee/MEV는 별도 가산(L59).
  // ⚠️ live 전환 시 Jupiter quote 기반으로 교체하면 fee가 이미 포함되므로 이중계산 주의.
  const entryPriceImpact = estimateSlippage(notionalSol, poolTvl, 0, 0);
  const exitPriceImpact = estimateSlippage(order.takeProfit2 * order.quantity, poolTvl, 0, 0);
  const roundTripCost = entryPriceImpact + exitPriceImpact + ammFeePct + mevMarginPct;
  const effectiveRR = riskPct > 0
    ? Math.max(rewardPct - roundTripCost, 0) / (riskPct + roundTripCost)
    : 0;

  const rrReject = thresholds.rrReject ?? DEFAULT_MIN_EFFECTIVE_RR_REJECT;
  const rrPass = thresholds.rrPass ?? DEFAULT_MIN_EFFECTIVE_RR_PASS;

  if (effectiveRR < rrReject) {
    return {
      effectiveRR,
      roundTripCost,
      sizeMultiplier: 0,
      rejected: true,
      filterReason: formatExecutionFilterReason(effectiveRR, roundTripCost),
      riskPct,
      rewardPct,
      entryPriceImpactPct: entryPriceImpact,
      exitPriceImpactPct: exitPriceImpact,
      quantity: order.quantity,
      notionalSol,
    };
  }

  if (effectiveRR < rrPass) {
    return {
      effectiveRR,
      roundTripCost,
      sizeMultiplier: 0.5,
      rejected: false,
      riskPct,
      rewardPct,
      entryPriceImpactPct: entryPriceImpact,
      exitPriceImpactPct: exitPriceImpact,
      quantity: order.quantity,
      notionalSol,
    };
  }

  return {
    effectiveRR,
    roundTripCost,
    sizeMultiplier: 1,
    rejected: false,
    riskPct,
    rewardPct,
    entryPriceImpactPct: entryPriceImpact,
    exitPriceImpactPct: exitPriceImpact,
    quantity: order.quantity,
    notionalSol,
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
