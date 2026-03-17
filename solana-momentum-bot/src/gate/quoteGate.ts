import axios from 'axios';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('QuoteGate');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;

export interface QuoteGateResult {
  approved: boolean;
  reason?: string;
  priceImpactPct: number;
  routeFound: boolean;
  outAmountLamports: bigint;
  sizeMultiplier: number;
}

export interface QuoteGateConfig {
  jupiterApiUrl: string;
  jupiterApiKey?: string;
  /** Maximum price impact % (0.02 = 2%) */
  maxPriceImpact: number;
  /** Slippage tolerance (bps) */
  slippageBps: number;
  /** Quote timeout (ms) */
  timeoutMs: number;
}

const DEFAULT_CONFIG: QuoteGateConfig = {
  jupiterApiUrl: 'https://api.jup.ag',
  maxPriceImpact: 0.02,
  slippageBps: 100,
  timeoutMs: 10_000,
};

/**
 * Gate: Jupiter Quote Gate — 진입 전 실제 price impact 검증.
 *
 * Jupiter API에 실제 swap quote를 요청해서:
 *   1. route 존재 여부 확인
 *   2. priceImpact 측정
 *   3. stale/unavailable route → reject
 */
export async function evaluateQuoteGate(
  tokenMint: string,
  estimatedPositionSol: number,
  config: Partial<QuoteGateConfig> = {}
): Promise<QuoteGateResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const amountLamports = BigInt(Math.round(estimatedPositionSol * 10 ** SOL_DECIMALS));

  try {
    const headers: Record<string, string> = {};
    if (cfg.jupiterApiKey) {
      headers['X-API-Key'] = cfg.jupiterApiKey;
    }

    const response = await axios.get(`${cfg.jupiterApiUrl}/quote`, {
      params: {
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: amountLamports.toString(),
        slippageBps: cfg.slippageBps,
      },
      headers,
      timeout: cfg.timeoutMs,
    });

    const quote = response.data;

    if (!quote || !quote.outAmount) {
      log.warn(`No route found for ${tokenMint}`);
      return {
        approved: false,
        reason: 'No swap route found',
        priceImpactPct: 0,
        routeFound: false,
        outAmountLamports: 0n,
        sizeMultiplier: 0,
      };
    }

    const priceImpactPct = parsePriceImpact(quote);
    const outAmountLamports = BigInt(quote.outAmount);

    log.info(
      `Quote: ${estimatedPositionSol.toFixed(4)} SOL → ${tokenMint.slice(0, 8)}... ` +
      `impact=${(priceImpactPct * 100).toFixed(3)}% routes=${quote.routePlan?.length ?? 0}`
    );

    // Hard reject if price impact too high
    if (priceImpactPct > cfg.maxPriceImpact) {
      return {
        approved: false,
        reason: `Price impact too high: ${(priceImpactPct * 100).toFixed(2)}% > ${(cfg.maxPriceImpact * 100).toFixed(2)}%`,
        priceImpactPct,
        routeFound: true,
        outAmountLamports,
        sizeMultiplier: 0,
      };
    }

    // Graduated sizing based on impact
    let sizeMultiplier = 1.0;
    if (priceImpactPct > cfg.maxPriceImpact * 0.6) {
      sizeMultiplier = 0.5;
      log.info(`High impact zone (${(priceImpactPct * 100).toFixed(2)}%) — sizing reduced 50%`);
    }

    return {
      approved: true,
      priceImpactPct,
      routeFound: true,
      outAmountLamports,
      sizeMultiplier,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // Network/timeout errors → cautious reject
    if (msg.includes('timeout') || msg.includes('ECONNREFUSED')) {
      log.warn(`Quote gate timeout for ${tokenMint}: ${msg}`);
      return {
        approved: false,
        reason: `Quote unavailable: ${msg}`,
        priceImpactPct: 0,
        routeFound: false,
        outAmountLamports: 0n,
        sizeMultiplier: 0,
      };
    }

    // 4xx → likely no route
    log.warn(`Quote gate error for ${tokenMint}: ${msg}`);
    return {
      approved: false,
      reason: `Quote error: ${msg}`,
      priceImpactPct: 0,
      routeFound: false,
      outAmountLamports: 0n,
      sizeMultiplier: 0,
    };
  }
}

function parsePriceImpact(quote: Record<string, unknown>): number {
  // Jupiter returns priceImpactPct as string or number
  const raw = quote.priceImpactPct ?? quote.priceImpact ?? 0;
  const pct = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
  // Jupiter returns percentage (e.g. "0.5" = 0.5%), convert to decimal
  return Math.abs(pct) / 100;
}
