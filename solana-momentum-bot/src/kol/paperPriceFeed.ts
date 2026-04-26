/**
 * Paper Price Feed (Option 5 Phase 3, 2026-04-23)
 *
 * ADR: docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md
 *
 * 목적:
 *   Lane T paper position 의 가격 track 을 위해 Jupiter SOL→token quote 를 주기적으로
 *   fetch. observer 의 `fetchForwardQuote` 와 같은 패턴이지만 별도 관심사 (position
 *   management vs trajectory 측정) 로 분리.
 *
 * 설계:
 *  - 각 mint 에 대해 subscribe → 주기 (default 3s) 마다 Jupiter quote
 *  - 결과를 EventEmitter 로 방송 (`price` event with { tokenMint, price, outAmount })
 *  - 429 는 `jupiterRateLimitMetric` 에 기록, in-flight dedup
 *  - unsubscribe 시 timer 정리
 *
 * NOT a real-time price oracle — polling 기반, 3s latency 허용.
 *   (Lane T paper 는 stalk 2-5min / hold 30min+ 이라 sub-second 필요 없음)
 */
import { EventEmitter } from 'events';
import axios from 'axios';
import { createModuleLogger } from '../utils/logger';
import { SOL_MINT, LAMPORTS_PER_SOL } from '../utils/constants';
import { normalizeJupiterSwapApiUrl } from '../utils/jupiterApi';
import { recordJupiter429 } from '../observability/jupiterRateLimitMetric';

const log = createModuleLogger('PaperPriceFeed');

export interface PaperPriceFeedConfig {
  jupiterApiUrl: string;
  jupiterApiKey?: string;
  /** Poll 주기 (ms). 기본 3s */
  pollIntervalMs: number;
  /** Forward quote 용 probe SOL amount (가격 측정용, 실거래 아님) */
  probeSolAmount: number;
  /** 429 cooldown 후 poll skip 기간 (ms) */
  rateLimitCooldownMs: number;
  timeoutMs: number;
  slippageBps: number;
}

export const DEFAULT_PAPER_PRICE_FEED_CONFIG: PaperPriceFeedConfig = {
  jupiterApiUrl: '',
  pollIntervalMs: 3_000,
  probeSolAmount: 0.01,
  rateLimitCooldownMs: 10_000,
  timeoutMs: 6_000,
  slippageBps: 200,
};

export interface PriceTick {
  tokenMint: string;
  price: number; // SOL / token (UI)
  outAmountUi: number;
  outputDecimals: number | null;
  probeSolAmount: number;
  timestamp: number;
}

interface Subscription {
  tokenMint: string;
  timer: NodeJS.Timeout;
  lastPrice: number | null;
  lastTimestamp: number;
  /** 2026-04-26 P1 fix: first poll 의 known decimals 보존. unknown 은 null 로 유지. */
  lastOutputDecimals: number | null;
  inFlight: Promise<void> | null;
}

export class PaperPriceFeed extends EventEmitter {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly cfg: PaperPriceFeedConfig;
  private rateLimitedUntilMs = 0;

  constructor(config: Partial<PaperPriceFeedConfig>) {
    super();
    const merged = { ...DEFAULT_PAPER_PRICE_FEED_CONFIG, ...config };
    this.cfg = {
      ...merged,
      jupiterApiUrl: normalizeJupiterSwapApiUrl(merged.jupiterApiUrl, merged.jupiterApiKey),
    };
  }

  subscribe(tokenMint: string): void {
    if (this.subscriptions.has(tokenMint)) return;
    const sub: Subscription = {
      tokenMint,
      timer: setInterval(() => this.poll(tokenMint), this.cfg.pollIntervalMs),
      lastPrice: null,
      lastTimestamp: 0,
      lastOutputDecimals: null,
      inFlight: null,
    };
    if (sub.timer.unref) sub.timer.unref();
    this.subscriptions.set(tokenMint, sub);
    // 즉시 1회 poll
    void this.poll(tokenMint);
  }

  unsubscribe(tokenMint: string): void {
    const sub = this.subscriptions.get(tokenMint);
    if (!sub) return;
    clearInterval(sub.timer);
    this.subscriptions.delete(tokenMint);
  }

  /** 현재 cached price (poll 결과 없으면 null). */
  getLastPrice(tokenMint: string): { price: number; timestamp: number } | null {
    const sub = this.subscriptions.get(tokenMint);
    if (!sub || sub.lastPrice === null) return null;
    return { price: sub.lastPrice, timestamp: sub.lastTimestamp };
  }

  /**
   * 2026-04-26 P1 fix: 첫 tick 의 known decimals 까지 cached 반환.
   * Jupiter 가 decimals 를 안 주면 fallback 값을 숨기고 null 을 반환한다.
   */
  getLastTick(tokenMint: string): { price: number; timestamp: number; outputDecimals: number | null } | null {
    const sub = this.subscriptions.get(tokenMint);
    if (!sub || sub.lastPrice === null) return null;
    return {
      price: sub.lastPrice,
      timestamp: sub.lastTimestamp,
      outputDecimals: sub.lastOutputDecimals,
    };
  }

  getActiveSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  stopAll(): void {
    for (const sub of this.subscriptions.values()) {
      clearInterval(sub.timer);
    }
    this.subscriptions.clear();
  }

  // ─── Internal ────────────────────────────────────────

  private async poll(tokenMint: string): Promise<void> {
    const sub = this.subscriptions.get(tokenMint);
    if (!sub) return;
    if (sub.inFlight) return; // 이전 poll 진행 중 → skip

    const now = Date.now();
    if (now < this.rateLimitedUntilMs) return; // cooldown

    sub.inFlight = this.fetchAndEmit(tokenMint).finally(() => {
      const curr = this.subscriptions.get(tokenMint);
      if (curr) curr.inFlight = null;
    });
    await sub.inFlight;
  }

  private async fetchAndEmit(tokenMint: string): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      if (this.cfg.jupiterApiKey) headers['X-API-Key'] = this.cfg.jupiterApiKey;
      const amountLamports = BigInt(Math.round(this.cfg.probeSolAmount * LAMPORTS_PER_SOL));
      const resp = await axios.get(`${this.cfg.jupiterApiUrl}/quote`, {
        params: {
          inputMint: SOL_MINT,
          outputMint: tokenMint,
          amount: amountLamports.toString(),
          slippageBps: this.cfg.slippageBps,
        },
        headers,
        timeout: this.cfg.timeoutMs,
      });
      const quote = resp.data;
      if (!quote || !quote.outAmount) return;
      const outAmountRaw = BigInt(quote.outAmount);
      if (outAmountRaw <= 0n) return;
      const outputDecimals =
        typeof quote.outputDecimals === 'number' &&
        Number.isFinite(quote.outputDecimals) &&
        quote.outputDecimals >= 0 &&
        quote.outputDecimals <= 18
          ? quote.outputDecimals
          : null;
      // Price tracking keeps the legacy fallback so paper state machine does not stall when
      // Jupiter omits decimals. The nullable outputDecimals is kept separate and is never used
      // as a trusted observer hint unless Jupiter/security provided an actual value.
      const priceDecimals = outputDecimals ?? 6;
      const outAmountUi = Number(outAmountRaw) / Math.pow(10, priceDecimals);
      if (outAmountUi <= 0) return;
      const price = this.cfg.probeSolAmount / outAmountUi;
      const now = Date.now();
      const sub = this.subscriptions.get(tokenMint);
      if (sub) {
        sub.lastPrice = price;
        sub.lastTimestamp = now;
        sub.lastOutputDecimals = outputDecimals;
      }
      const tick: PriceTick = {
        tokenMint,
        price,
        outAmountUi,
        outputDecimals,
        probeSolAmount: this.cfg.probeSolAmount,
        timestamp: now,
      };
      this.emit('price', tick);
    } catch (err) {
      if (is429Error(err)) {
        recordJupiter429('paper_price_feed');
        this.rateLimitedUntilMs = Date.now() + this.cfg.rateLimitCooldownMs;
        log.debug(`[PAPER_PRICE] 429 → cooldown ${this.cfg.rateLimitCooldownMs}ms`);
      } else {
        log.debug(`[PAPER_PRICE] ${tokenMint.slice(0, 8)} poll error: ${String(err)}`);
      }
    }
  }
}

function is429Error(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/status code 429|rate[_ ]?limit|too many requests/i.test(msg)) return true;
  const anyErr = err as { response?: { status?: number } };
  return anyErr?.response?.status === 429;
}
