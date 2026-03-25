import { MomentumOrderParams, MomentumTrigger, MomentumTriggerConfig, TriggerRejectStats } from '../strategy';
import { MicroCandleBuilder } from '../realtime';
import { StoredRealtimeSwap } from '../realtime/replayStore';
import { RealtimeOutcomeTracker, RealtimeSignalRecord, summarizeRealtimeSignals } from '../reporting';
import { Candle } from '../utils/types';
import { trackReplaySignal } from './replaySignalTracker';
import { sanitizeReplaySwaps } from './replaySwapSanitizer';

export interface MicroReplayOptions {
  triggerConfig: MomentumTriggerConfig;
  orderParams?: Partial<MomentumOrderParams>;
  horizonsSec?: number[];
  gateMode?: 'off' | 'stored';
  storedSignals?: RealtimeSignalRecord[];
  estimatedCostPct?: number;
}

export interface MicroReplayResult {
  records: RealtimeSignalRecord[];
  summary: ReturnType<typeof summarizeRealtimeSignals>;
  dataset: {
    inputMode: 'swaps' | 'candles';
    swapCount: number;
    keptSwapCount: number;
    droppedSwapCount: number;
    candleCount: number;
    keptCandleCount: number;
    droppedCandleCount: number;
    replayedSignalCount: number;
    gateMode: 'off' | 'stored';
  };
  rejectStats: TriggerRejectStats;
}

interface ReplayCandleSanitizer {
  recentAcceptedClosesBySeries: Map<string, number[]>;
  droppedCount: number;
}

interface ReplayCandleSanitizerStats {
  keptCount: number;
  droppedCount: number;
}

const MAX_INTRA_CANDLE_RANGE_RATIO = 100;
const MAX_SEQUENTIAL_CLOSE_RATIO = 100;
const MAX_ROLLING_MEDIAN_CLOSE_RATIO = 20;
const ROLLING_CLOSE_WINDOW = 5;

export async function replayRealtimeDataset(
  swaps: StoredRealtimeSwap[],
  options: MicroReplayOptions
): Promise<MicroReplayResult> {
  const sanitized = sanitizeReplaySwaps(swaps);
  const orderedSwaps = sanitized.swaps;
  const horizonsSec = options.horizonsSec ?? [30, 60, 180, 300];
  const builder = new MicroCandleBuilder({
    intervals: [5, options.triggerConfig.primaryIntervalSec, options.triggerConfig.confirmIntervalSec],
    maxHistory: 512,
  });
  const trigger = new MomentumTrigger(options.triggerConfig);
  const collectedRecords: RealtimeSignalRecord[] = [];
  const pendingTasks: Promise<void>[] = [];
  const outcomeTracker = new RealtimeOutcomeTracker(
    {
      horizonsSec,
      observationIntervalSec: 5,
    },
    {
      async log(record: RealtimeSignalRecord) {
        collectedRecords.push(record);
      },
    }
  );
  const storedSignals = options.storedSignals ?? [];
  const gateMode = options.gateMode ?? 'off';

  builder.on('candle', (candle) => {
    pendingTasks.push(handleReplayCandle({
      candle,
      builder,
      trigger,
      outcomeTracker,
      options,
      gateMode,
      storedSignals,
    }));
  });

  for (const swap of orderedSwaps) {
    builder.onSwap({
      ...swap,
      pool: swap.pairAddress,
    });
    await drainTasks(pendingTasks);
  }

  const lastTimestamp = orderedSwaps[orderedSwaps.length - 1]?.timestamp ?? Math.floor(Date.now() / 1000);
  builder.flush(lastTimestamp + (horizonsSec[horizonsSec.length - 1] ?? 300) + options.triggerConfig.confirmIntervalSec + 5);
  await drainTasks(pendingTasks);

  return {
    records: collectedRecords.sort((left, right) => Date.parse(left.signalTimestamp) - Date.parse(right.signalTimestamp)),
    summary: summarizeRealtimeSignals(collectedRecords, horizonsSec.includes(180) ? 180 : horizonsSec[0] ?? 180),
    dataset: {
      inputMode: 'swaps',
      swapCount: swaps.length,
      keptSwapCount: sanitized.keptCount,
      droppedSwapCount: sanitized.droppedCount,
      candleCount: 0,
      keptCandleCount: 0,
      droppedCandleCount: 0,
      replayedSignalCount: collectedRecords.length,
      gateMode,
    },
    rejectStats: trigger.getRejectStats(),
  };
}

export async function replayRealtimeCandles(
  candles: Candle[],
  options: MicroReplayOptions
): Promise<MicroReplayResult> {
  const sanitized = sanitizeReplayCandles(candles);
  return replayOrderedCandles(sanitized.candles, {
    ...options,
    totalCandleCount: candles.length,
    keptCandleCount: sanitized.keptCount,
    droppedCandleCount: sanitized.droppedCount,
  });
}

export async function replayRealtimeCandlesStream(
  candles: AsyncIterable<Candle>,
  options: MicroReplayOptions
): Promise<MicroReplayResult> {
  const runtime = createCandleReplayRuntime(options);
  let totalCandleCount = 0;
  const bufferedCandles = new Map<number, Candle[]>();
  const maxOrderingDelayMs = Math.max(5, options.triggerConfig.primaryIntervalSec, options.triggerConfig.confirmIntervalSec) * 1000;
  let maxSeenTimestampMs = Number.NEGATIVE_INFINITY;
  const sanitizer = createReplayCandleSanitizer();

  for await (const candle of candles) {
    totalCandleCount++;
    if (!isReplayableCandle(candle)) {
      sanitizer.droppedCount++;
      continue;
    }
    const timestampMs = candle.timestamp.getTime();
    maxSeenTimestampMs = Math.max(maxSeenTimestampMs, timestampMs);
    const bucket = bufferedCandles.get(timestampMs) ?? [];
    bucket.push(candle);
    bufferedCandles.set(timestampMs, bucket);
    await flushBufferedCandles(bufferedCandles, maxSeenTimestampMs - maxOrderingDelayMs, runtime, options, sanitizer);
  }

  await flushBufferedCandles(
    bufferedCandles,
    Number.POSITIVE_INFINITY,
    runtime,
    options,
    sanitizer
  );
  const keptCandleCount = totalCandleCount - sanitizer.droppedCount;
  return buildCandleReplayResult(runtime, {
    totalCandleCount,
    keptCandleCount,
    droppedCandleCount: sanitizer.droppedCount,
  });
}

async function handleReplayCandle(input: {
  candle: Candle;
  builder: MicroCandleBuilder;
  trigger: MomentumTrigger;
  outcomeTracker: RealtimeOutcomeTracker;
  options: MicroReplayOptions;
  gateMode: 'off' | 'stored';
  storedSignals: RealtimeSignalRecord[];
}): Promise<void> {
  const { candle, builder, trigger, outcomeTracker, options, gateMode, storedSignals } = input;
  await outcomeTracker.onCandle(candle);

  const signal = trigger.onCandle(candle, builder);
  if (!signal) return;
  trackReplaySignal({
    signal,
    builder,
    outcomeTracker,
    storedSignals,
    gateMode,
    orderParams: options.orderParams,
    estimatedCostPct: options.estimatedCostPct,
  });
}

async function drainTasks(tasks: Promise<void>[]): Promise<void> {
  if (tasks.length === 0) return;
  const snapshot = tasks.splice(0, tasks.length);
  await Promise.all(snapshot);
}

function sanitizeReplayCandles(candles: Candle[]): {
  candles: Candle[];
  keptCount: number;
  droppedCount: number;
} {
  const filtered = candles.filter((candle) => isReplayableCandle(candle));

  filtered.sort((left, right) =>
    left.timestamp.getTime() - right.timestamp.getTime()
    || left.intervalSec - right.intervalSec
    || left.pairAddress.localeCompare(right.pairAddress)
  );

  const sanitizer = createReplayCandleSanitizer();
  const sanitized = filtered.filter((candle) => acceptReplayCandle(candle, sanitizer));

  return {
    candles: sanitized,
    keptCount: sanitized.length,
    droppedCount: Math.max(0, candles.length - filtered.length) + sanitizer.droppedCount,
  };
}

async function replayOrderedCandles(
  candles: Iterable<Candle>,
  options: MicroReplayOptions & {
    totalCandleCount: number;
    keptCandleCount: number;
    droppedCandleCount: number;
  }
): Promise<MicroReplayResult> {
  const runtime = createCandleReplayRuntime(options);

  for (const candle of candles) {
    await processReplayCandle(candle, runtime, options);
  }

  return buildCandleReplayResult(runtime, options);
}

function createCandleReplayRuntime(options: MicroReplayOptions): {
  horizonsSec: number[];
  builder: MicroCandleBuilder;
  trigger: MomentumTrigger;
  collectedRecords: RealtimeSignalRecord[];
  outcomeTracker: RealtimeOutcomeTracker;
  storedSignals: RealtimeSignalRecord[];
  gateMode: 'off' | 'stored';
} {
  const horizonsSec = options.horizonsSec ?? [30, 60, 180, 300];
  const collectedRecords: RealtimeSignalRecord[] = [];
  return {
    horizonsSec,
    builder: new MicroCandleBuilder({
      intervals: [5, options.triggerConfig.primaryIntervalSec, options.triggerConfig.confirmIntervalSec],
      maxHistory: 512,
    }),
    trigger: new MomentumTrigger(options.triggerConfig),
    collectedRecords,
    outcomeTracker: new RealtimeOutcomeTracker(
      {
        horizonsSec,
        observationIntervalSec: 5,
      },
      {
        async log(record: RealtimeSignalRecord) {
          collectedRecords.push(record);
        },
      }
    ),
    storedSignals: options.storedSignals ?? [],
    gateMode: options.gateMode ?? 'off',
  };
}

async function processReplayCandle(
  candle: Candle,
  runtime: ReturnType<typeof createCandleReplayRuntime>,
  options: MicroReplayOptions
): Promise<void> {
  runtime.builder.ingestClosedCandle(candle, false);
  await runtime.outcomeTracker.onCandle(candle);

  if (candle.intervalSec !== options.triggerConfig.primaryIntervalSec) {
    return;
  }

  const signal = runtime.trigger.onCandle(candle, runtime.builder);
  if (!signal) return;
  trackReplaySignal({
    signal,
    builder: runtime.builder,
    outcomeTracker: runtime.outcomeTracker,
    storedSignals: runtime.storedSignals,
    gateMode: runtime.gateMode,
    orderParams: options.orderParams,
    estimatedCostPct: options.estimatedCostPct,
  });
}

function buildCandleReplayResult(
  runtime: ReturnType<typeof createCandleReplayRuntime>,
  options: {
    totalCandleCount: number;
    keptCandleCount: number;
    droppedCandleCount: number;
  }
): MicroReplayResult {
  return {
    records: runtime.collectedRecords.sort((left, right) => Date.parse(left.signalTimestamp) - Date.parse(right.signalTimestamp)),
    summary: summarizeRealtimeSignals(runtime.collectedRecords, runtime.horizonsSec.includes(180) ? 180 : runtime.horizonsSec[0] ?? 180),
    dataset: {
      inputMode: 'candles',
      swapCount: 0,
      keptSwapCount: 0,
      droppedSwapCount: 0,
      candleCount: options.totalCandleCount,
      keptCandleCount: options.keptCandleCount,
      droppedCandleCount: options.droppedCandleCount,
      replayedSignalCount: runtime.collectedRecords.length,
      gateMode: runtime.gateMode,
    },
    rejectStats: runtime.trigger.getRejectStats(),
  };
}

function isReplayableCandle(candle: Candle): boolean {
  return Boolean(candle.pairAddress)
    && candle.timestamp instanceof Date
    && Number.isFinite(candle.timestamp.getTime())
    && Number.isFinite(candle.intervalSec)
    && candle.intervalSec > 0
    && Number.isFinite(candle.open)
    && Number.isFinite(candle.high)
    && Number.isFinite(candle.low)
    && Number.isFinite(candle.close)
    && Number.isFinite(candle.volume)
    && Number.isFinite(candle.buyVolume)
    && Number.isFinite(candle.sellVolume)
    && Number.isFinite(candle.tradeCount);
}

async function flushBufferedCandles(
  bufferedCandles: Map<number, Candle[]>,
  flushBeforeOrAtMs: number,
  runtime: ReturnType<typeof createCandleReplayRuntime>,
  options: MicroReplayOptions,
  sanitizer: ReplayCandleSanitizer
): Promise<ReplayCandleSanitizerStats> {
  const readyTimestamps = [...bufferedCandles.keys()]
    .filter((timestampMs) => timestampMs <= flushBeforeOrAtMs)
    .sort((left, right) => left - right);
  let keptCount = 0;

  for (const timestampMs of readyTimestamps) {
    const candles = bufferedCandles.get(timestampMs) ?? [];
    candles.sort((left, right) =>
      left.intervalSec - right.intervalSec
      || left.pairAddress.localeCompare(right.pairAddress)
    );
    for (const candle of candles) {
      if (!acceptReplayCandle(candle, sanitizer)) {
        continue;
      }
      await processReplayCandle(candle, runtime, options);
      keptCount++;
    }
    bufferedCandles.delete(timestampMs);
  }
  return {
    keptCount,
    droppedCount: sanitizer.droppedCount,
  };
}

function createReplayCandleSanitizer(): ReplayCandleSanitizer {
  return {
    recentAcceptedClosesBySeries: new Map<string, number[]>(),
    droppedCount: 0,
  };
}

function acceptReplayCandle(candle: Candle, sanitizer: ReplayCandleSanitizer): boolean {
  const prices = [candle.open, candle.high, candle.low, candle.close];
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  if (minPrice <= 0 || maxPrice / minPrice > MAX_INTRA_CANDLE_RANGE_RATIO) {
    sanitizer.droppedCount++;
    return false;
  }

  const seriesKey = `${candle.pairAddress}:${candle.intervalSec}`;
  const recentCloses = sanitizer.recentAcceptedClosesBySeries.get(seriesKey) ?? [];
  const previousClose = recentCloses[recentCloses.length - 1];
  if (previousClose && previousClose > 0) {
    const closeRatio = Math.max(previousClose, candle.close) / Math.min(previousClose, candle.close);
    if (closeRatio > MAX_SEQUENTIAL_CLOSE_RATIO) {
      sanitizer.droppedCount++;
      return false;
    }
  }

  if (recentCloses.length >= 3) {
    const medianClose = median(recentCloses);
    if (medianClose > 0) {
      const medianRatio = Math.max(medianClose, candle.close) / Math.min(medianClose, candle.close);
      if (medianRatio > MAX_ROLLING_MEDIAN_CLOSE_RATIO) {
        sanitizer.droppedCount++;
        return false;
      }
    }
  }

  const nextHistory = [...recentCloses.slice(-(ROLLING_CLOSE_WINDOW - 1)), candle.close];
  sanitizer.recentAcceptedClosesBySeries.set(seriesKey, nextHistory);
  return true;
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
