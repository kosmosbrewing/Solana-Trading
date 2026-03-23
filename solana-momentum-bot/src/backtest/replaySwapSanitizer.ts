import { StoredRealtimeSwap } from '../realtime/replayStore';

export interface ReplaySwapSanitizerResult {
  swaps: StoredRealtimeSwap[];
  droppedCount: number;
  keptCount: number;
}

interface PoolSanitizerOptions {
  minSamples: number;
  minLogDeviation: number;
  maxLogDeviation: number;
}

const DEFAULT_OPTIONS: PoolSanitizerOptions = {
  minSamples: 8,
  minLogDeviation: 2,
  maxLogDeviation: 4,
};

export function sanitizeReplaySwaps(
  swaps: StoredRealtimeSwap[],
  options: Partial<PoolSanitizerOptions> = {}
): ReplaySwapSanitizerResult {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const pools = new Map<string, StoredRealtimeSwap[]>();

  for (const swap of swaps) {
    if (!isFinitePositive(swap.priceNative)) continue;
    const bucket = pools.get(swap.pairAddress) ?? [];
    bucket.push(swap);
    pools.set(swap.pairAddress, bucket);
  }

  const sanitized: StoredRealtimeSwap[] = [];
  let droppedCount = 0;

  for (const poolSwaps of pools.values()) {
    const ordered = [...poolSwaps].sort((left, right) => left.timestamp - right.timestamp);
    if (ordered.length < config.minSamples) {
      sanitized.push(...ordered);
      continue;
    }

    const logs = ordered.map((swap) => Math.log10(swap.priceNative));
    const medianLog = median(logs);
    const deviations = logs.map((value) => Math.abs(value - medianLog));
    const mad = median(deviations);
    const allowedDeviation = Math.max(
      config.minLogDeviation,
      Math.min(config.maxLogDeviation, mad > 0 ? mad * 8 : config.minLogDeviation)
    );

    for (let index = 0; index < ordered.length; index += 1) {
      const deviation = Math.abs(logs[index] - medianLog);
      if (deviation <= allowedDeviation) {
        sanitized.push(ordered[index]);
      } else {
        droppedCount += 1;
      }
    }
  }

  sanitized.sort((left, right) => left.timestamp - right.timestamp);
  return {
    swaps: sanitized,
    droppedCount,
    keptCount: sanitized.length,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
