import { Candle } from '../utils/types';
import { StoredMicroCandle } from '../realtime/replayStore';
import { fillCandleGaps } from './microReplayEngine';

export interface SessionCandleAggregationOptions {
  targetIntervalSec?: number;
  baseIntervalSec?: number;
}

export interface AggregatedSessionCandles {
  targetIntervalSec: number;
  baseIntervalSec: number;
  byPair: Map<string, Candle[]>;
}

const DEFAULT_TARGET_INTERVAL_SEC = 300;

export function aggregateSessionCandlesToTarget(
  candles: StoredMicroCandle[],
  options: SessionCandleAggregationOptions = {}
): AggregatedSessionCandles {
  const targetIntervalSec = options.targetIntervalSec ?? DEFAULT_TARGET_INTERVAL_SEC;
  if (!Number.isFinite(targetIntervalSec) || targetIntervalSec <= 0) {
    throw new Error(`Invalid target interval: ${targetIntervalSec}`);
  }

  const availableIntervals = [...new Set(candles.map((candle) => candle.intervalSec))]
    .filter((intervalSec) => Number.isFinite(intervalSec) && intervalSec > 0)
    .sort((left, right) => left - right);
  const baseIntervalSec = resolveBaseIntervalSec(
    availableIntervals,
    targetIntervalSec,
    options.baseIntervalSec
  );

  // Why: zero-volume skip 후 sparse candle에서 gap을 복원하여 bucket open/low 정확성 보장
  const baseCandles = fillCandleGaps(
    candles.filter((candle) => candle.intervalSec === baseIntervalSec)
  );

  const buckets = new Map<string, Candle>();

  for (const candle of baseCandles) {
    const bucketStartMs = Math.floor(candle.timestamp.getTime() / 1000 / targetIntervalSec) * targetIntervalSec * 1000;
    const bucketKey = `${candle.pairAddress}:${bucketStartMs}`;
    const existing = buckets.get(bucketKey);

    if (!existing) {
      buckets.set(bucketKey, {
        pairAddress: candle.pairAddress,
        timestamp: new Date(bucketStartMs),
        intervalSec: targetIntervalSec,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        buyVolume: candle.buyVolume,
        sellVolume: candle.sellVolume,
        tradeCount: candle.tradeCount,
      });
      continue;
    }

    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
    existing.buyVolume += candle.buyVolume;
    existing.sellVolume += candle.sellVolume;
    existing.tradeCount += candle.tradeCount;
  }

  const byPair = new Map<string, Candle[]>();
  for (const aggregated of buckets.values()) {
    const history = byPair.get(aggregated.pairAddress) ?? [];
    history.push(aggregated);
    byPair.set(aggregated.pairAddress, history);
  }

  for (const history of byPair.values()) {
    history.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  }

  return {
    targetIntervalSec,
    baseIntervalSec,
    byPair,
  };
}

function resolveBaseIntervalSec(
  availableIntervals: number[],
  targetIntervalSec: number,
  requestedBaseIntervalSec?: number
): number {
  if (requestedBaseIntervalSec !== undefined) {
    if (!availableIntervals.includes(requestedBaseIntervalSec)) {
      throw new Error(`Requested base interval ${requestedBaseIntervalSec}s not found in session candles`);
    }
    if (targetIntervalSec % requestedBaseIntervalSec !== 0) {
      throw new Error(`Target interval ${targetIntervalSec}s is not divisible by base interval ${requestedBaseIntervalSec}s`);
    }
    return requestedBaseIntervalSec;
  }

  const candidate = availableIntervals.find((intervalSec) => targetIntervalSec % intervalSec === 0);
  if (!candidate) {
    throw new Error(
      `No base interval found that can aggregate into ${targetIntervalSec}s. Available: ${availableIntervals.join(', ')}`
    );
  }
  return candidate;
}
