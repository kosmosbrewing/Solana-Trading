/**
 * Live Price Tracker — Phase 2 P1-1 (2026-04-25)
 *
 * Why: 6h 운영 로그에서 CATCOIN PROBE close 가 `peak=0.00%` 인데 실제 sell quote 는 +99.91%.
 * candleBuilder 의 internal price 가 burst pump 를 못 잡아 T1 promotion 미발동.
 * → Jupiter `token → SOL` reverse quote 을 size-aware 하게 (실 보유량 그대로) 주기 fetch
 *    해서 `quote-based MFE` 를 별도 추적. T1 promotion 신호 보강.
 *
 * 설계:
 *  - PaperPriceFeed 와 별개 모듈 (그 쪽은 forward quote SOL→token, 진입 의도용).
 *  - 본 tracker 는 reverse quote token→SOL, 보유 position 의 매도 가능성/MFE 측정용.
 *  - subscribe(tokenMint, quantityUi, decimals) 로 등록 → 주기 (default 12s) Jupiter quote.
 *  - emit('reverse_quote', { tokenMint, solOut, mfeVsEntry, ... })
 *  - 429 cooldown + in-flight dedup + 자체 metric (jupiterRateLimitMetric).
 *
 * Trade pipeline latency 무영향. 실패는 silent — 진입/exit 결정 절대 차단 금지.
 */
import { EventEmitter } from 'events';
import axios from 'axios';
import { createModuleLogger } from '../utils/logger';
import { SOL_MINT, LAMPORTS_PER_SOL } from '../utils/constants';
import { normalizeJupiterSwapApiUrl } from '../utils/jupiterApi';
import { uiAmountToRaw } from '../utils/units';
import { recordJupiter429 } from './jupiterRateLimitMetric';

const log = createModuleLogger('LivePriceTracker');

export interface LivePriceTrackerConfig {
  jupiterApiUrl: string;
  jupiterApiKey?: string;
  /** Poll 주기 ms — default 12s (CATCOIN +99% 24s 기록을 두 번 sample) */
  pollIntervalMs: number;
  /** 429 cooldown ms */
  rateLimitCooldownMs: number;
  timeoutMs: number;
  slippageBps: number;
}

export const DEFAULT_LIVE_PRICE_TRACKER_CONFIG: LivePriceTrackerConfig = {
  jupiterApiUrl: '',
  pollIntervalMs: 12_000,
  rateLimitCooldownMs: 10_000,
  timeoutMs: 5_000,
  slippageBps: 200,
};

export interface ReverseQuoteTick {
  tokenMint: string;
  /** 실 보유량 (UI) */
  quantityUi: number;
  /** Jupiter 가 회신한 SOL out (UI) */
  solOut: number;
  /** entry cost (SOL) — `entryPrice × quantity` */
  entryNotionalSol: number;
  /** mfe relative to entry. (solOut - entryNotionalSol) / entryNotionalSol */
  mfeVsEntry: number;
  outputDecimals: number;
  timestamp: number;
}

interface Subscription {
  tokenMint: string;
  quantityUi: number;
  decimals: number;
  entryNotionalSol: number;
  rawAmount: bigint;
  timer: NodeJS.Timeout;
  inFlight: Promise<void> | null;
  lastTick: ReverseQuoteTick | null;
}

export class LivePriceTracker extends EventEmitter {
  private readonly subs = new Map<string, Subscription>();
  private readonly cfg: LivePriceTrackerConfig;
  private rateLimitedUntilMs = 0;

  constructor(config: Partial<LivePriceTrackerConfig>) {
    super();
    const merged = { ...DEFAULT_LIVE_PRICE_TRACKER_CONFIG, ...config };
    this.cfg = {
      ...merged,
      jupiterApiUrl: normalizeJupiterSwapApiUrl(merged.jupiterApiUrl, merged.jupiterApiKey),
    };
  }

  subscribe(opts: {
    tokenMint: string;
    quantityUi: number;
    decimals: number;
    entryNotionalSol: number;
  }): void {
    if (this.subs.has(opts.tokenMint)) return;
    if (opts.quantityUi <= 0 || opts.decimals < 0 || opts.entryNotionalSol <= 0) return;
    // 2026-04-26 (QA fix): JS number 정밀도 (2^53) 방어. microcap token 수량이 크면
    // Math.floor(ui * 10^decimals) 가 정밀 손실 → reverse quote amount 왜곡.
    // utils/units.ts 의 uiAmountToRaw 로 string 기반 BigInt 변환.
    const rawAmount = uiAmountToRaw(opts.quantityUi, opts.decimals);
    if (rawAmount <= 0n) return; // invalid input — subscribe skip
    const sub: Subscription = {
      tokenMint: opts.tokenMint,
      quantityUi: opts.quantityUi,
      decimals: opts.decimals,
      entryNotionalSol: opts.entryNotionalSol,
      rawAmount,
      lastTick: null,
      inFlight: null,
      timer: setInterval(() => this.poll(opts.tokenMint).catch(() => {}), this.cfg.pollIntervalMs),
    };
    this.subs.set(opts.tokenMint, sub);
  }

  unsubscribe(tokenMint: string): void {
    const sub = this.subs.get(tokenMint);
    if (!sub) return;
    clearInterval(sub.timer);
    this.subs.delete(tokenMint);
  }

  getLastTick(tokenMint: string): ReverseQuoteTick | null {
    return this.subs.get(tokenMint)?.lastTick ?? null;
  }

  getActiveSubscriptionCount(): number {
    return this.subs.size;
  }

  stopAll(): void {
    for (const sub of this.subs.values()) clearInterval(sub.timer);
    this.subs.clear();
  }

  private async poll(tokenMint: string): Promise<void> {
    const sub = this.subs.get(tokenMint);
    if (!sub) return;
    if (sub.inFlight) return;
    if (Date.now() < this.rateLimitedUntilMs) return;
    sub.inFlight = this.fetchAndEmit(tokenMint).finally(() => {
      const curr = this.subs.get(tokenMint);
      if (curr) curr.inFlight = null;
    });
    await sub.inFlight;
  }

  private async fetchAndEmit(tokenMint: string): Promise<void> {
    const sub = this.subs.get(tokenMint);
    if (!sub) return;
    try {
      const headers: Record<string, string> = {};
      if (this.cfg.jupiterApiKey) headers['X-API-Key'] = this.cfg.jupiterApiKey;
      const resp = await axios.get(`${this.cfg.jupiterApiUrl}/quote`, {
        params: {
          inputMint: tokenMint,
          outputMint: SOL_MINT,
          amount: sub.rawAmount.toString(),
          slippageBps: this.cfg.slippageBps,
        },
        headers,
        timeout: this.cfg.timeoutMs,
      });
      const quote = resp.data;
      if (!quote || !quote.outAmount) return;
      const lamports = BigInt(quote.outAmount);
      if (lamports <= 0n) return;
      const solOut = Number(lamports) / LAMPORTS_PER_SOL;
      const mfeVsEntry =
        sub.entryNotionalSol > 0 ? (solOut - sub.entryNotionalSol) / sub.entryNotionalSol : 0;
      const tick: ReverseQuoteTick = {
        tokenMint,
        quantityUi: sub.quantityUi,
        solOut,
        entryNotionalSol: sub.entryNotionalSol,
        mfeVsEntry,
        outputDecimals: typeof quote.outputDecimals === 'number' ? quote.outputDecimals : 9,
        timestamp: Date.now(),
      };
      sub.lastTick = tick;
      this.emit('reverse_quote', tick);
    } catch (err) {
      if (is429Error(err)) {
        recordJupiter429('live_price_tracker');
        this.rateLimitedUntilMs = Date.now() + this.cfg.rateLimitCooldownMs;
        log.debug(`[LIVE_PRICE_TRACKER] 429 → cooldown ${this.cfg.rateLimitCooldownMs}ms`);
      } else {
        log.debug(`[LIVE_PRICE_TRACKER] ${tokenMint.slice(0, 8)} poll error: ${String(err)}`);
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
