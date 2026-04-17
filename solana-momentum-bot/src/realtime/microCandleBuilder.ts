import { EventEmitter } from 'events';
import { Candle } from '../utils/types';
import { ParsedSwap } from './types';

export interface MicroCandleConfig {
  intervals: number[];
  maxHistory: number;
  sweepIntervalMs?: number;
  /**
   * Phase E1 (2026-04-08): tick sanity bound.
   * 신규 tick 이 last close 대비 이 ratio 바깥이면 reject 한다.
   * 기본값 0.5 = ±50% (즉 last * 0.5 ~ last * 1.5 만 accept).
   * Why: VDOR 같은 Raydium CLMM pair 에서 관측된 multi-swap-per-tx parser artifact 가
   * 5~12x 자릿수 bad tick 을 생산하는 케이스를 차단. monitor loop 가 bad tick 에서
   * TP2/SL trigger 발동 후 Jupiter swap 이 정상가에서 체결되어 intent≠actual gap 폭발.
   * 신규 pool (lastPriceByPool 미설정) 은 바운드 검증 없이 accept.
   * 0 으로 설정하면 전면 비활성.
   */
  tickSanityBoundPct?: number;
}

export class MicroCandleBuilder extends EventEmitter {
  private readonly intervals: number[];
  private readonly maxHistory: number;
  private readonly sweepIntervalMs: number;
  private readonly tickSanityBoundPct: number;
  private readonly openCandles = new Map<string, Map<number, Candle>>();
  private readonly closedCandles = new Map<string, Map<number, Candle[]>>();
  private readonly lastPriceByPool = new Map<string, number>();
  private sweepTimer?: NodeJS.Timeout;
  // Phase E1: per-pool reject count (snapshot via getSanityRejectCounts())
  private readonly sanityRejectCounts = new Map<string, number>();

  constructor(config: MicroCandleConfig) {
    super();
    this.intervals = [...new Set(config.intervals)].filter((value) => value > 0).sort((a, b) => a - b);
    this.maxHistory = config.maxHistory;
    this.sweepIntervalMs = config.sweepIntervalMs ?? 1000;
    // default 0.5 = ±50% band; 0 또는 음수 = 비활성
    this.tickSanityBoundPct = config.tickSanityBoundPct ?? 0.5;
  }

  /** Phase E1 telemetry: 각 pool 에서 sanity bound 로 reject 된 tick 누적 카운트. */
  getSanityRejectCounts(): ReadonlyMap<string, number> {
    return this.sanityRejectCounts;
  }

  /**
   * Phase E1 (2026-04-08): sanity bound 통과 여부 판정.
   * lastPriceByPool 미설정이면 무조건 accept (신규 pool).
   * tickSanityBoundPct ≤ 0 이면 비활성.
   */
  private isSaneTick(pool: string, priceNative: number): boolean {
    if (this.tickSanityBoundPct <= 0) return true;
    const lastPrice = this.lastPriceByPool.get(pool);
    if (lastPrice == null || !Number.isFinite(lastPrice) || lastPrice <= 0) return true;
    if (!Number.isFinite(priceNative) || priceNative <= 0) return false;
    const lo = lastPrice * (1 - this.tickSanityBoundPct);
    const hi = lastPrice * (1 + this.tickSanityBoundPct);
    return priceNative >= lo && priceNative <= hi;
  }

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.checkAndCloseCandles(Math.floor(Date.now() / 1000));
    }, this.sweepIntervalMs);
  }

  stop(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  flush(nowSec = Math.floor(Date.now() / 1000)): void {
    this.checkAndCloseCandles(nowSec);
  }

  onSwap(swap: ParsedSwap): void {
    this.applySwapEvent(swap, true);
  }

  seedSwaps(swaps: ParsedSwap[]): number {
    const ordered = [...swaps].sort((left, right) => left.timestamp - right.timestamp || left.slot - right.slot);
    for (const swap of ordered) {
      this.applySwapEvent(swap, false);
    }
    return ordered.length;
  }

  ingestClosedCandle(candle: Candle, emitEvents = true): void {
    // 2026-04-17 (HWM axis oxidation audit 후속): Phase E1 sanity bound 를 ingestClosedCandle
    // 에도 적용. 기존에는 `applySwapEvent` 경로에만 검사 → backfill/replay/internal source 가
    // 오염된 axis candle 을 넣으면 lastPriceByPool 오염 baseline 확정 → downstream peak HWM
    // 영구 고착. close 값이 기존 lastPrice 대비 ±50% 바깥이면 lastPrice 업데이트 skip
    // (candle 자체는 closedCandles 에는 기록 — gate/replay 로직은 그대로 작동).
    if (this.isSaneTick(candle.pairAddress, candle.close)) {
      this.lastPriceByPool.set(candle.pairAddress, candle.close);
    } else {
      const prev = this.sanityRejectCounts.get(candle.pairAddress) ?? 0;
      this.sanityRejectCounts.set(candle.pairAddress, prev + 1);
    }
    this.pushClosedCandle({ ...candle });
    if (emitEvents) {
      this.emit('candle', { ...candle });
    }
  }

  private applySwapEvent(swap: ParsedSwap, emitEvents: boolean): void {
    // Phase E1: per-pool price sanity check. last close 대비 ±50% 바깥 tick 은 reject.
    // reject 시 lastPriceByPool / candle 업데이트 전혀 안 함 → downstream (monitor trigger,
    // strategy, realtime outcome tracker) 가 bad tick 을 절대 관측하지 않는다.
    if (!this.isSaneTick(swap.pool, swap.priceNative)) {
      const prev = this.sanityRejectCounts.get(swap.pool) ?? 0;
      this.sanityRejectCounts.set(swap.pool, prev + 1);
      if (emitEvents) {
        this.emit('tickRejected', {
          pool: swap.pool,
          price: swap.priceNative,
          lastPrice: this.lastPriceByPool.get(swap.pool),
          timestamp: swap.timestamp,
        });
      }
      return;
    }
    this.lastPriceByPool.set(swap.pool, swap.priceNative);
    if (emitEvents) {
      this.emit('tick', {
        pool: swap.pool,
        price: swap.priceNative,
        timestamp: swap.timestamp,
      });
    }

    for (const intervalSec of this.intervals) {
      const bucketStartSec = this.getBucketStartSec(swap.timestamp, intervalSec);
      const candleMap = this.getOrCreateOpenMap(swap.pool);
      const existing = candleMap.get(intervalSec);

      if (existing && existing.timestamp.getTime() / 1000 !== bucketStartSec) {
        this.closeCandle(existing, emitEvents);
        this.fillMissingBuckets(swap.pool, intervalSec, existing, bucketStartSec, emitEvents);
        candleMap.delete(intervalSec);
      }

      const candle = candleMap.get(intervalSec) ?? this.createCandle(swap, intervalSec, bucketStartSec);
      this.applySwap(candle, swap);
      candleMap.set(intervalSec, candle);
    }
  }

  getRecentCandles(pool: string, intervalSec: number, count: number): Candle[] {
    const history = this.closedCandles.get(pool)?.get(intervalSec) ?? [];
    return history.slice(-count);
  }

  getCurrentPrice(pool: string): number | null {
    return this.lastPriceByPool.get(pool) ?? null;
  }

  removePair(pool: string): void {
    this.openCandles.delete(pool);
    this.closedCandles.delete(pool);
    this.lastPriceByPool.delete(pool);
  }

  private checkAndCloseCandles(nowSec: number): void {
    for (const [pool, intervals] of this.openCandles.entries()) {
      for (const [intervalSec, candle] of intervals.entries()) {
        const currentBucketStart = this.getBucketStartSec(nowSec, intervalSec);
        const candleBucketStart = candle.timestamp.getTime() / 1000;
        if (currentBucketStart <= candleBucketStart) continue;

        this.closeCandle(candle);
        this.fillMissingBuckets(pool, intervalSec, candle, currentBucketStart);
        intervals.delete(intervalSec);
      }
    }
  }

  private fillMissingBuckets(
    pool: string,
    intervalSec: number,
    previousCandle: Candle,
    nextBucketStartSec: number,
    emitEvents = true
  ): void {
    let bucketStartSec = previousCandle.timestamp.getTime() / 1000 + intervalSec;
    while (bucketStartSec < nextBucketStartSec) {
      const synthetic = this.createSyntheticCandle(pool, intervalSec, bucketStartSec, previousCandle.close);
      this.pushClosedCandle(synthetic);
      if (emitEvents) this.emit('candle', synthetic);
      bucketStartSec += intervalSec;
    }
  }

  private createCandle(swap: ParsedSwap, intervalSec: number, bucketStartSec: number): Candle {
    return {
      pairAddress: swap.pool,
      timestamp: new Date(bucketStartSec * 1000),
      intervalSec,
      open: swap.priceNative,
      high: swap.priceNative,
      low: swap.priceNative,
      close: swap.priceNative,
      volume: 0,
      buyVolume: 0,
      sellVolume: 0,
      tradeCount: 0,
    };
  }

  private createSyntheticCandle(
    pool: string,
    intervalSec: number,
    bucketStartSec: number,
    price: number
  ): Candle {
    return {
      pairAddress: pool,
      timestamp: new Date(bucketStartSec * 1000),
      intervalSec,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
      buyVolume: 0,
      sellVolume: 0,
      tradeCount: 0,
    };
  }

  private applySwap(candle: Candle, swap: ParsedSwap): void {
    candle.high = Math.max(candle.high, swap.priceNative);
    candle.low = Math.min(candle.low, swap.priceNative);
    candle.close = swap.priceNative;
    candle.volume += swap.amountQuote;
    candle.tradeCount += 1;
    if (swap.side === 'buy') candle.buyVolume += swap.amountQuote;
    else candle.sellVolume += swap.amountQuote;
  }

  private closeCandle(candle: Candle, emitEvents = true): void {
    this.pushClosedCandle({ ...candle });
    if (emitEvents) this.emit('candle', { ...candle });
  }

  private pushClosedCandle(candle: Candle): void {
    const intervalMap = this.getOrCreateClosedMap(candle.pairAddress);
    const history = intervalMap.get(candle.intervalSec) ?? [];
    history.push(candle);
    if (history.length > this.maxHistory) {
      history.splice(0, history.length - this.maxHistory);
    }
    intervalMap.set(candle.intervalSec, history);
  }

  private getBucketStartSec(timestampSec: number, intervalSec: number): number {
    return Math.floor(timestampSec / intervalSec) * intervalSec;
  }

  private getOrCreateOpenMap(pool: string): Map<number, Candle> {
    const current = this.openCandles.get(pool);
    if (current) return current;
    const created = new Map<number, Candle>();
    this.openCandles.set(pool, created);
    return created;
  }

  private getOrCreateClosedMap(pool: string): Map<number, Candle[]> {
    const current = this.closedCandles.get(pool);
    if (current) return current;
    const created = new Map<number, Candle[]>();
    this.closedCandles.set(pool, created);
    return created;
  }
}
