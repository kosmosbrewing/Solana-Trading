import { createModuleLogger } from '../utils/logger';
import { Signal, Order } from '../utils/types';
import type {
  ExitLiquidityData,
  TokenSecurityData,
} from '../ingester/onchainSecurity';
import {
  evaluateSecurityGate,
  type SecurityGateConfig,
  type SecurityGateResult,
} from '../gate/securityGate';
import {
  evaluateQuoteGate,
  type QuoteGateConfig,
  type QuoteGateResult,
} from '../gate/quoteGate';

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
  /** Slippage tolerance in bps for new LP swaps (default: 500 = 5%) */
  slippageBps: number;
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
  slippageBps: 500, // 5% — 새 LP 풀은 유동성이 낮아 높은 슬리피지 허용
};

export interface NewListingCandidate {
  tokenMint: string;
  tokenSymbol: string;
  pairAddress: string;
  sourceLabel?: string;
  liquidityUsd: number;
  liquidityAddedAt: Date;
  price: number;
  /** Ticket size after async security/quote gate reductions */
  recommendedTicketSizeSol?: number;
  /** Security gate results (default: false — must be explicitly set) */
  securityPassed?: boolean;
  /** Exit liquidity exists (default: false) */
  exitLiquidityOk?: boolean;
  /** Jupiter route exists with acceptable impact (default: false) */
  jupiterRouteOk?: boolean;
  /** Price impact from Jupiter quote (default: 1 = 100%, rejected) */
  priceImpactPct?: number;
}

export interface PrepareNewLpCandidateDependencies {
  getTokenSecurityDetailed(tokenMint: string): Promise<TokenSecurityData | null>;
  getExitLiquidity(tokenMint: string): Promise<ExitLiquidityData | null>;
  getTokenOverview?(tokenMint: string): Promise<Record<string, unknown> | undefined>;
  evaluateQuoteGate?: (
    tokenMint: string,
    estimatedPositionSol: number,
    config: Partial<QuoteGateConfig>
  ) => Promise<QuoteGateResult>;
}

export interface PrepareNewLpCandidateOptions {
  params?: Partial<NewLpSniperParams>;
  securityGate?: Partial<SecurityGateConfig>;
  quoteGate?: Partial<QuoteGateConfig>;
}

export interface PreparedNewLpCandidateResult {
  candidate?: NewListingCandidate;
  rejectionReason?: string;
  securityGate?: SecurityGateResult;
  quoteGate?: QuoteGateResult;
}

export interface NewLpListingInput {
  address?: string;
  symbol?: string;
  price?: number;
  liquidity?: number;
  liquidityAddedAt?: number;
  decimals?: number;
  source?: string;
}

export async function prepareNewLpCandidate(
  update: NewLpListingInput,
  deps: PrepareNewLpCandidateDependencies,
  options: PrepareNewLpCandidateOptions = {}
): Promise<PreparedNewLpCandidateResult> {
  const params = { ...DEFAULT_NEW_LP_PARAMS, ...options.params };
  const quoteGateRunner = deps.evaluateQuoteGate ?? evaluateQuoteGate;

  if (!update.address) {
    return { rejectionReason: 'missing_token_mint' };
  }

  const [securityData, exitLiquidityData, overview] = await Promise.all([
    deps.getTokenSecurityDetailed(update.address),
    deps.getExitLiquidity(update.address),
    deps.getTokenOverview?.(update.address) ?? Promise.resolve(undefined),
  ]);

  const securityGate = evaluateSecurityGate(
    securityData,
    exitLiquidityData,
    options.securityGate
  );
  if (!securityGate.approved) {
    return {
      rejectionReason: `security_rejected: ${securityGate.reason ?? 'unknown'}`,
      securityGate,
    };
  }

  const gatedTicketSizeSol = params.ticketSizeSol * securityGate.sizeMultiplier;
  const quoteGate = await quoteGateRunner(update.address, gatedTicketSizeSol, {
    ...options.quoteGate,
    maxPriceImpact: options.quoteGate?.maxPriceImpact ?? params.maxPriceImpact,
    slippageBps: options.quoteGate?.slippageBps ?? params.slippageBps,
  });

  if (!quoteGate.approved) {
    return {
      rejectionReason: `quote_rejected: ${quoteGate.reason ?? 'unknown'}`,
      securityGate,
      quoteGate,
    };
  }

  const price = resolveListingPrice({
    listingPrice: update.price,
    overview,
    decimals: update.decimals,
    quoteGate,
    ticketSizeSol: gatedTicketSizeSol,
  });
  if (!Number.isFinite(price) || price <= 0) {
    return {
      rejectionReason: 'price_unavailable',
      securityGate,
      quoteGate,
    };
  }

  const liquidityUsd = resolveLiquidityUsd(update.liquidity, overview);
  const recommendedTicketSizeSol = gatedTicketSizeSol * quoteGate.sizeMultiplier;

  return {
    candidate: {
      tokenMint: update.address,
      tokenSymbol: update.symbol ?? 'UNKNOWN',
      pairAddress: update.address,
      sourceLabel: update.source,
      liquidityUsd,
      liquidityAddedAt: new Date(update.liquidityAddedAt ?? Date.now()),
      price,
      recommendedTicketSizeSol,
      securityPassed: true,
      exitLiquidityOk: !securityGate.flags.includes('LOW_EXIT_LIQUIDITY'),
      jupiterRouteOk: quoteGate.routeFound,
      priceImpactPct: quoteGate.priceImpactPct,
    },
    securityGate,
    quoteGate,
  };
}

/**
 * Strategy D: New LP Sniper — 옵션성 베팅.
 *
 * 코어 전략이 아닌 별도 지갑의 고정 티켓 베팅:
 *   - 외부 listing source 이벤트로 후보 수집
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
  const ticketSizeSol = candidate.recommendedTicketSizeSol ?? p.ticketSizeSol;

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

  // Security gate (pre-checked by caller, default: false)
  if (!(candidate.securityPassed ?? false)) {
    return { ...noSignal, meta: { filterReason: 3 } };
  }

  // Exit liquidity (default: false)
  if (!(candidate.exitLiquidityOk ?? false)) {
    return { ...noSignal, meta: { filterReason: 4 } };
  }

  // Jupiter route & impact (default: false / 1.0)
  if (!(candidate.jupiterRouteOk ?? false)) {
    return { ...noSignal, meta: { filterReason: 5 } };
  }
  const impactPct = candidate.priceImpactPct ?? 1;
  if (impactPct > p.maxPriceImpact) {
    return { ...noSignal, meta: { filterReason: 6, priceImpactPct: impactPct } };
  }

  log.info(
    `New LP signal: ${candidate.tokenSymbol} (${candidate.pairAddress.slice(0, 8)}...) ` +
    `age=${ageMinutes.toFixed(1)}min liq=$${candidate.liquidityUsd.toFixed(0)} ` +
    `impact=${(impactPct * 100).toFixed(2)}%`
  );

  return {
    action: 'BUY',
    strategy: 'new_lp_sniper',
    pairAddress: candidate.pairAddress,
    price: candidate.price,
    timestamp: new Date(),
    sourceLabel: candidate.sourceLabel,
    meta: {
      ageMinutes,
      liquidityUsd: candidate.liquidityUsd,
      priceImpactPct: impactPct,
      ticketSizeSol,
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

  // SL = accept near-full loss (lottery ticket): 95% 손실 허용, 0은 불가 (SL 미트리거)
  const stopLoss = p.acceptFullLoss ? signal.price * 0.05 : signal.price * 0.5;

  // TP = entry × multiplier
  const takeProfit1 = signal.price * (1 + (p.takeProfitMultiplier - 1) * 0.5);
  const takeProfit2 = signal.price * p.takeProfitMultiplier;

  return {
    pairAddress: signal.pairAddress,
    strategy: 'new_lp_sniper',
    side: 'BUY',
    price: signal.price,
    quantity: ticketSol,
    sourceLabel: signal.sourceLabel,
    stopLoss,
    takeProfit1,
    takeProfit2,
    trailingStop: 0, // No trailing for lottery tickets
    timeStopMinutes: p.timeStopMinutes,
    slippageBps: p.slippageBps, // C-18: 새 LP 풀 전용 슬리피지 설정
  };
}

function resolveListingPrice(input: {
  listingPrice?: number;
  overview?: Record<string, unknown>;
  decimals?: number;
  quoteGate: QuoteGateResult;
  ticketSizeSol: number;
}): number {
  if (Number.isFinite(input.listingPrice) && (input.listingPrice ?? 0) > 0) {
    return input.listingPrice ?? 0;
  }

  const overviewPrice = parsePositiveNumber(
    input.overview,
    ['price', 'priceUsd', 'priceUSD', 'value', 'valueUsd']
  );
  if (overviewPrice != null) {
    return overviewPrice;
  }

  if (input.decimals != null && input.decimals >= 0 && input.quoteGate.outAmountLamports > 0n) {
    const tokenOut = Number(input.quoteGate.outAmountLamports) / 10 ** input.decimals;
    if (Number.isFinite(tokenOut) && tokenOut > 0) {
      return input.ticketSizeSol / tokenOut;
    }
  }

  return 0;
}

function resolveLiquidityUsd(
  listingLiquidity: number | undefined,
  overview?: Record<string, unknown>
): number {
  if (Number.isFinite(listingLiquidity) && (listingLiquidity ?? 0) > 0) {
    return listingLiquidity ?? 0;
  }

  return (
    parsePositiveNumber(overview, ['liquidity', 'liquidityUsd', 'liquidityUSD', 'tvl']) ?? 0
  );
}

function parsePositiveNumber(
  source: Record<string, unknown> | undefined,
  keys: string[]
): number | undefined {
  if (!source) return undefined;

  for (const key of keys) {
    const value = source[key];
    const parsed = typeof value === 'string' ? Number(value) : Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}
