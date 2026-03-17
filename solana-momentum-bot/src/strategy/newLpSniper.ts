import { createModuleLogger } from '../utils/logger';
import { Signal, Order, Candle } from '../utils/types';

const log = createModuleLogger('StrategyD');

export interface NewLpSniperParams {
  /** Minimum token age in minutes (default: 3) */
  minAgeMinutes: number;
  /** Maximum token age in minutes (default: 20) */
  maxAgeMinutes: number;
  /** Minimum liquidity USD (default: 10_000) */
  minLiquidityUsd: number;
  /** Fixed ticket size in SOL (default: 0.02) */
  ticketSizeSol: number;
  /** Maximum price impact for Jupiter quote (default: 5%) */
  maxPriceImpact: number;
  /** Stop loss: full position (accept total loss) */
  acceptFullLoss: boolean;
  /** Time stop in minutes (default: 15) */
  timeStopMinutes: number;
  /** Take profit multiplier (default: 3x) */
  takeProfitMultiplier: number;
}

export const DEFAULT_NEW_LP_PARAMS: NewLpSniperParams = {
  minAgeMinutes: 3,
  maxAgeMinutes: 20,
  minLiquidityUsd: 10_000,
  ticketSizeSol: 0.02,
  maxPriceImpact: 0.05,
  acceptFullLoss: true,
  timeStopMinutes: 15,
  takeProfitMultiplier: 3.0,
};

export interface NewListingCandidate {
  tokenMint: string;
  tokenSymbol: string;
  pairAddress: string;
  liquidityUsd: number;
  liquidityAddedAt: Date;
  price: number;
  /** Security gate results (must be pre-checked) */
  securityPassed: boolean;
  /** Exit liquidity exists */
  exitLiquidityOk: boolean;
  /** Jupiter route exists with acceptable impact */
  jupiterRouteOk: boolean;
  priceImpactPct: number;
}

/**
 * Strategy D: New LP Sniper — 옵션성 베팅.
 *
 * 코어 전략이 아닌 별도 지갑의 고정 티켓 베팅:
 *   - Birdeye WS new_listing/new_pair 이벤트로 후보 수집
 *   - age 3~20분 필터
 *   - 강화된 security gate 전항목 통과 필수
 *   - Jupiter route + impact 검증
 *   - Jito bundle로 TX 전송 (MEV 보호)
 *   - 고정 티켓: 0.01~0.05 SOL (risk% 사이징 아님)
 *
 * Phase 3 전제조건:
 *   - Jito bundle 통합 완료
 *   - 별도 지갑 (메인 자본 격리)
 *   - 별도 일일 손실 한도
 */
export function evaluateNewLpSniper(
  candidate: NewListingCandidate,
  params: Partial<NewLpSniperParams> = {}
): Signal {
  const p = { ...DEFAULT_NEW_LP_PARAMS, ...params };

  const noSignal: Signal = {
    action: 'HOLD',
    strategy: 'new_lp_sniper',
    pairAddress: candidate.pairAddress,
    price: candidate.price,
    timestamp: new Date(),
    meta: {},
  };

  // Age filter
  const ageMinutes = (Date.now() - candidate.liquidityAddedAt.getTime()) / 60_000;
  if (ageMinutes < p.minAgeMinutes || ageMinutes > p.maxAgeMinutes) {
    return { ...noSignal, meta: { filterReason: 1, ageMinutes } };
  }

  // Liquidity filter
  if (candidate.liquidityUsd < p.minLiquidityUsd) {
    return { ...noSignal, meta: { filterReason: 2, liquidityUsd: candidate.liquidityUsd } };
  }

  // Security gate (pre-checked by caller)
  if (!candidate.securityPassed) {
    return { ...noSignal, meta: { filterReason: 3 } };
  }

  // Exit liquidity
  if (!candidate.exitLiquidityOk) {
    return { ...noSignal, meta: { filterReason: 4 } };
  }

  // Jupiter route & impact
  if (!candidate.jupiterRouteOk) {
    return { ...noSignal, meta: { filterReason: 5 } };
  }
  if (candidate.priceImpactPct > p.maxPriceImpact) {
    return { ...noSignal, meta: { filterReason: 6, priceImpactPct: candidate.priceImpactPct } };
  }

  log.info(
    `New LP signal: ${candidate.tokenSymbol} (${candidate.pairAddress.slice(0, 8)}...) ` +
    `age=${ageMinutes.toFixed(1)}min liq=$${candidate.liquidityUsd.toFixed(0)} ` +
    `impact=${(candidate.priceImpactPct * 100).toFixed(2)}%`
  );

  return {
    action: 'BUY',
    strategy: 'new_lp_sniper',
    pairAddress: candidate.pairAddress,
    price: candidate.price,
    timestamp: new Date(),
    meta: {
      ageMinutes,
      liquidityUsd: candidate.liquidityUsd,
      priceImpactPct: candidate.priceImpactPct,
      ticketSizeSol: p.ticketSizeSol,
    },
  };
}

/**
 * Build order for Strategy D.
 * Fixed ticket sizing — not risk-based.
 */
export function buildNewLpOrder(
  signal: Signal,
  params: Partial<NewLpSniperParams> = {}
): Order {
  const p = { ...DEFAULT_NEW_LP_PARAMS, ...params };
  const ticketSol = signal.meta.ticketSizeSol ?? p.ticketSizeSol;

  // SL = accept full loss (lottery ticket)
  const stopLoss = p.acceptFullLoss ? 0 : signal.price * 0.5;

  // TP = entry × multiplier
  const takeProfit1 = signal.price * (1 + (p.takeProfitMultiplier - 1) * 0.5);
  const takeProfit2 = signal.price * p.takeProfitMultiplier;

  return {
    pairAddress: signal.pairAddress,
    strategy: 'new_lp_sniper',
    side: 'BUY',
    price: signal.price,
    quantity: ticketSol,
    stopLoss,
    takeProfit1,
    takeProfit2,
    trailingStop: 0, // No trailing for lottery tickets
    timeStopMinutes: p.timeStopMinutes,
  };
}
