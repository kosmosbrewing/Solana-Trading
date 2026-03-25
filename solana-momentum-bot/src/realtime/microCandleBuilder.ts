import { EventEmitter } from 'events';
import { Candle } from '../utils/types';
import { ParsedSwap } from './types';

export interface MicroCandleConfig {
  intervals: number[];
  maxHistory: number;
  sweepIntervalMs?: number;
}

export class MicroCandleBuilder extends EventEmitter {
  private readonly intervals: number[];
  private readonly maxHistory: number;
  private readonly sweepIntervalMs: number;
  private readonly openCandles = new Map<string, Map<number, Candle>>();
  private readonly closedCandles = new Map<string, Map<number, Candle[]>>();
  private readonly lastPriceByPool = new Map<string, number>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(config: MicroCandleConfig) {
    super();
    this.intervals = [...new Set(config.intervals)].filter((value) => value > 0).sort((a, b) => a - b);
    this.maxHistory = config.maxHistory;
    this.sweepIntervalMs = config.sweepIntervalMs ?? 1000;
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
    this.lastPriceByPool.set(candle.pairAddress, candle.close);
    this.pushClosedCandle({ ...candle });
    if (emitEvents) {
      this.emit('candle', { ...candle });
    }
  }

  private applySwapEvent(swap: ParsedSwap, emitEvents: boolean): void {
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
