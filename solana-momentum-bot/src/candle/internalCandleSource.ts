import { Candle } from '../utils/types';
import { CandleStore } from './candleStore';

const AGGREGATABLE_SOURCE_INTERVALS = [60, 300, 900, 3600] as const;

/**
 * InternalCandleSource — CandleStore를 source-of-truth로 사용하고,
 * 필요 시 더 작은 timeframe에서 상위 timeframe으로 집계한다.
 */
export class InternalCandleSource {
  constructor(private readonly candleStore: CandleStore) {}

  async getRecentCandles(
    pairAddress: string,
    intervalSec: number,
    limit: number
  ): Promise<Candle[]> {
    const candidates: Candle[][] = [];
    const direct = await this.candleStore.getRecentCandles(pairAddress, intervalSec, limit) ?? [];
    if (direct.length > 0) {
      candidates.push(direct);
    }

    for (const sourceIntervalSec of AGGREGATABLE_SOURCE_INTERVALS) {
      if (sourceIntervalSec >= intervalSec || intervalSec % sourceIntervalSec !== 0) continue;
      const sourceLimit = Math.max(2, limit * (intervalSec / sourceIntervalSec) + 2);
      const sourceCandles = await this.candleStore.getRecentCandles(
        pairAddress,
        sourceIntervalSec,
        sourceLimit
      ) ?? [];
      if (sourceCandles.length === 0) continue;

      const aggregated = aggregateCandles(sourceCandles, intervalSec, pairAddress).slice(-limit);
      if (aggregated.length > 0) {
        candidates.push(aggregated);
      }
    }

    return pickBestCandidate(candidates, limit);
  }

  async getCandlesInRange(
    pairAddress: string,
    intervalSec: number,
    from: Date,
    to: Date
  ): Promise<Candle[]> {
    const candidates: Candle[][] = [];
    const direct = await this.candleStore.getCandlesInRange(pairAddress, intervalSec, from, to) ?? [];
    if (direct.length > 0) {
      candidates.push(direct);
    }

    for (const sourceIntervalSec of AGGREGATABLE_SOURCE_INTERVALS) {
      if (sourceIntervalSec >= intervalSec || intervalSec % sourceIntervalSec !== 0) continue;
      const sourceCandles = await this.candleStore.getCandlesInRange(
        pairAddress,
        sourceIntervalSec,
        from,
        to
      ) ?? [];
      if (sourceCandles.length === 0) continue;

      const aggregated = aggregateCandles(sourceCandles, intervalSec, pairAddress).filter((candle) =>
        candle.timestamp >= from && candle.timestamp <= to
      );
      if (aggregated.length > 0) {
        candidates.push(aggregated);
      }
    }

    return pickBestCandidate(candidates);
  }
}

function aggregateCandles(
  candles: Candle[],
  targetIntervalSec: number,
  pairAddress: string
): Candle[] {
  const sorted = [...candles].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  const buckets = new Map<number, Candle[]>();

  for (const candle of sorted) {
    const timestampSec = Math.floor(candle.timestamp.getTime() / 1000);
    const bucketStartSec = Math.floor(timestampSec / targetIntervalSec) * targetIntervalSec;
    const bucket = buckets.get(bucketStartSec) ?? [];
    bucket.push(candle);
    buckets.set(bucketStartSec, bucket);
  }

  return [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([bucketStartSec, bucketCandles]) => {
      const first = bucketCandles[0];
      const last = bucketCandles[bucketCandles.length - 1];
      return {
        pairAddress,
        timestamp: new Date(bucketStartSec * 1000),
        intervalSec: targetIntervalSec,
        open: first.open,
        high: Math.max(...bucketCandles.map((candle) => candle.high)),
        low: Math.min(...bucketCandles.map((candle) => candle.low)),
        close: last.close,
        volume: bucketCandles.reduce((sum, candle) => sum + candle.volume, 0),
        buyVolume: bucketCandles.reduce((sum, candle) => sum + candle.buyVolume, 0),
        sellVolume: bucketCandles.reduce((sum, candle) => sum + candle.sellVolume, 0),
        tradeCount: bucketCandles.reduce((sum, candle) => sum + candle.tradeCount, 0),
      };
    });
}

function pickBestCandidate(candidates: Candle[][], preferredLength?: number): Candle[] {
  if (candidates.length === 0) return [];
  return candidates
    .sort((left, right) =>
      right.length - left.length
      || Math.abs((preferredLength ?? 0) - right.length) - Math.abs((preferredLength ?? 0) - left.length)
      || right[right.length - 1]?.timestamp.getTime() - left[left.length - 1]?.timestamp.getTime()
    )[0];
}
