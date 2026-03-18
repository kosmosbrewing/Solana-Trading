import axios from 'axios';
import { createModuleLogger } from '../utils/logger';
import { SOL_MINT, LAMPORTS_PER_SOL } from '../utils/constants';

const log = createModuleLogger('SpreadMeasurer');

export interface SpreadMeasurement {
  tokenMint: string;
  /** Bid-ask spread estimated from buy/sell quote difference (%) */
  spreadPct: number;
  /** Buy price impact for probe size (%) */
  buyImpactPct: number;
  /** Sell price impact for probe size (%) */
  sellImpactPct: number;
  /** Effective AMM fee from route (%) */
  effectiveFeePct: number;
  /** Number of available routes */
  routeCount: number;
  /** Measurement timestamp */
  measuredAt: Date;
}

export interface SpreadMeasurerConfig {
  jupiterApiUrl: string;
  jupiterApiKey?: string;
  /** Probe size in SOL lamports (default: 0.1 SOL = 100_000_000 lamports) */
  probeSizeLamports: number;
  /** Timeout for quote requests (ms) */
  timeoutMs: number;
  /** M-04: Cache TTL in ms (default: 60_000 = 1 min) */
  cacheTTLMs: number;
}

const DEFAULT_CONFIG: SpreadMeasurerConfig = {
  jupiterApiUrl: 'https://api.jup.ag',
  probeSizeLamports: 100_000_000, // 0.1 SOL
  timeoutMs: 5000,
  cacheTTLMs: 60_000,
};

/**
 * Jupiter Quote-based Spread & Fee Measurer (H-2 / H-3).
 *
 * Replaces the high/low candle-based spread proxy with actual
 * Jupiter quote data:
 *   - Buy quote: SOL → Token (buy impact)
 *   - Sell quote: Token → SOL (sell impact)
 *   - Spread = buy impact + sell impact
 *   - Effective fee = derived from quote vs mid-price
 */
export class SpreadMeasurer {
  private config: SpreadMeasurerConfig;
  private cache = new Map<string, SpreadMeasurement>();

  constructor(config: Partial<SpreadMeasurerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Measure actual spread and fee for a token using Jupiter quotes.
   * Returns cached result if available and fresh.
   */
  async measure(tokenMint: string): Promise<SpreadMeasurement | null> {
    // Check cache
    const cached = this.cache.get(tokenMint);
    if (cached && Date.now() - cached.measuredAt.getTime() < this.config.cacheTTLMs) {
      return cached;
    }

    try {
      const [buyQuote, sellQuote] = await Promise.all([
        this.getQuote(SOL_MINT, tokenMint, this.config.probeSizeLamports),
        this.getQuote(tokenMint, SOL_MINT, 0, true), // reverse probe
      ]);

      if (!buyQuote || !sellQuote) return null;

      const buyImpactPct = this.parsePriceImpact(buyQuote);
      const sellImpactPct = this.parsePriceImpact(sellQuote);

      // Spread = round-trip cost estimate
      const spreadPct = buyImpactPct + sellImpactPct;

      // Effective fee from route plan
      const effectiveFeePct = this.extractRouteFees(buyQuote);

      const routeCount = buyQuote.routePlan?.length ?? 0;

      const measurement: SpreadMeasurement = {
        tokenMint,
        spreadPct,
        buyImpactPct,
        sellImpactPct,
        effectiveFeePct,
        routeCount,
        measuredAt: new Date(),
      };

      this.cache.set(tokenMint, measurement);

      log.debug(
        `Spread: ${tokenMint.slice(0, 8)}... ` +
        `buy=${(buyImpactPct * 100).toFixed(3)}% sell=${(sellImpactPct * 100).toFixed(3)}% ` +
        `spread=${(spreadPct * 100).toFixed(3)}% fee=${(effectiveFeePct * 100).toFixed(3)}%`
      );

      return measurement;
    } catch (error) {
      // C-20: quote 실패 시 stale cache 경고 (있으면 반환, 없으면 null)
      const stale = this.cache.get(tokenMint);
      if (stale) {
        const ageMs = Date.now() - stale.measuredAt.getTime();
        log.warn(`Spread measurement failed for ${tokenMint}: ${error}. Using stale cache (age=${(ageMs / 1000).toFixed(0)}s)`);
        return stale;
      }
      log.warn(`Spread measurement failed for ${tokenMint}: ${error}. No cache available.`);
      return null;
    }
  }

  /**
   * Get spread for execution viability calculation.
   * Falls back to default estimate if quote fails.
   */
  async getSpreadOrDefault(tokenMint: string, defaultSpreadPct = 0.005): Promise<number> {
    const m = await this.measure(tokenMint);
    return m ? m.spreadPct : defaultSpreadPct;
  }

  /**
   * Measure sell-side impact at actual position size (exit gate용).
   * Why: 기본 measure()는 0.1 SOL probe — 실제 포지션(1~5 SOL)의 sell impact와 다를 수 있음.
   * 시그널 발생 시에만 호출하여 API 사용량 최소화.
   */
  async measureSellImpact(
    tokenMint: string,
    positionSizeSol: number
  ): Promise<number | null> {
    if (positionSizeSol <= 0) return null;
    try {
      const positionLamports = Math.round(positionSizeSol * LAMPORTS_PER_SOL);
      // Buy quote at position size → 토큰 수량 산출
      const buyQuote = await this.getQuote(SOL_MINT, tokenMint, positionLamports);
      if (!buyQuote) return null;
      const tokenAmount = parseInt(buyQuote.outAmount, 10);
      if (tokenAmount <= 0) return null;
      // Sell quote at 실제 토큰 수량
      const sellQuote = await this.getQuote(tokenMint, SOL_MINT, tokenAmount);
      if (!sellQuote) return null;
      const impact = this.parsePriceImpact(sellQuote);
      log.debug(
        `SellImpact(${positionSizeSol.toFixed(2)} SOL): ${tokenMint.slice(0, 8)}... ` +
        `impact=${(impact * 100).toFixed(3)}%`
      );
      return impact;
    } catch (error) {
      log.warn(`Sell impact measurement failed for ${tokenMint}: ${error}`);
      return null;
    }
  }

  /**
   * Get effective AMM fee for a token.
   * Falls back to standard 0.3% if unavailable.
   */
  async getFeeOrDefault(tokenMint: string, defaultFeePct = 0.003): Promise<number> {
    const m = await this.measure(tokenMint);
    return m ? m.effectiveFeePct : defaultFeePct;
  }

  private async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    reverseProbe = false
  ): Promise<JupiterQuoteResponse | null> {
    try {
      // For reverse probe (sell), we need to determine a token amount.
      // Use a small fixed amount based on the buy quote if available.
      let queryAmount = amount;
      if (reverseProbe && amount === 0) {
        // Get the buy output amount first for proportional sell probe
        const buyResult = await this.getQuote(
          SOL_MINT,
          inputMint,
          this.config.probeSizeLamports
        );
        if (!buyResult) return null;
        queryAmount = parseInt(buyResult.outAmount, 10);
      }

      const headers: Record<string, string> = {};
      if (this.config.jupiterApiKey) {
        headers['X-API-Key'] = this.config.jupiterApiKey;
      }

      const response = await axios.get<JupiterQuoteResponse>(
        `${this.config.jupiterApiUrl}/quote`,
        {
          params: {
            inputMint,
            outputMint,
            amount: queryAmount.toString(),
            slippageBps: 100,
          },
          headers,
          timeout: this.config.timeoutMs,
        }
      );

      return response.data;
    } catch (error) {
      log.debug(`Quote failed ${inputMint.slice(0, 8)} → ${outputMint.slice(0, 8)}: ${error}`);
      return null;
    }
  }

  private parsePriceImpact(quote: JupiterQuoteResponse): number {
    const raw = quote.priceImpactPct ?? 0;
    const pct = typeof raw === 'string' ? parseFloat(raw) : raw;
    return Math.abs(isNaN(pct) ? 0 : pct / 100); // Convert percentage to decimal
  }

  private extractRouteFees(quote: JupiterQuoteResponse): number {
    if (!quote.routePlan || quote.routePlan.length === 0) return 0.003; // default 0.3%

    let totalFeePct = 0;
    for (const step of quote.routePlan) {
      const feePct = step.swapInfo?.feeAmount && step.swapInfo?.inAmount
        ? parseInt(step.swapInfo.feeAmount, 10) / parseInt(step.swapInfo.inAmount, 10)
        : 0;
      totalFeePct += feePct;
    }

    return totalFeePct || 0.003;
  }
}

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct?: string | number;
  routePlan?: Array<{
    swapInfo?: {
      ammKey: string;
      feeAmount: string;
      feeMint: string;
      inAmount: string;
      outAmount: string;
    };
    percent: number;
  }>;
}
