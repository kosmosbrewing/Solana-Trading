import { buildMomentumTriggerOrder, MomentumOrderParams, MomentumTrigger, MomentumTriggerConfig, TriggerRejectStats } from '../strategy';
import { MicroCandleBuilder } from '../realtime';
import { StoredRealtimeSwap } from '../realtime/replayStore';
import { RealtimeOutcomeTracker, RealtimeSignalRecord, summarizeRealtimeSignals } from '../reporting';
import { Candle } from '../utils/types';

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
    swapCount: number;
    replayedSignalCount: number;
    gateMode: 'off' | 'stored';
  };
  rejectStats: TriggerRejectStats;
}

export async function replayRealtimeDataset(
  swaps: StoredRealtimeSwap[],
  options: MicroReplayOptions
): Promise<MicroReplayResult> {
  const orderedSwaps = [...swaps].sort((left, right) => left.timestamp - right.timestamp);
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
      swapCount: orderedSwaps.length,
      replayedSignalCount: collectedRecords.length,
      gateMode,
    },
    rejectStats: trigger.getRejectStats(),
  };
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

  const candles = builder.getRecentCandles(signal.pairAddress, options.triggerConfig.primaryIntervalSec, 30);
  if (candles.length === 0) return;

  const preview = buildMomentumTriggerOrder(signal, candles, 1, options.orderParams);
  const matchedStoredSignal = gateMode === 'stored'
    ? matchStoredSignal(storedSignals, signal.pairAddress, signal.timestamp.getTime() / 1000)
    : undefined;
  const gateRejected = matchedStoredSignal?.gate.rejected ?? false;
  const processingStatus = matchedStoredSignal?.processing.status ?? 'executed_paper';
  const filterReason = matchedStoredSignal?.processing.filterReason ?? matchedStoredSignal?.gate.filterReason;
  const estimatedCostPct = matchedStoredSignal?.estimatedCostPct ?? options.estimatedCostPct ?? 0;

  outcomeTracker.track({
    version: 1,
    id: `replay:${signal.strategy}:${signal.pairAddress}:${signal.timestamp.toISOString()}`,
    source: 'replay',
    strategy: signal.strategy,
    pairAddress: signal.pairAddress,
    poolAddress: matchedStoredSignal?.poolAddress ?? signal.pairAddress,
    tokenMint: matchedStoredSignal?.tokenMint ?? signal.pairAddress,
    tokenSymbol: matchedStoredSignal?.tokenSymbol,
    signalTimestamp: signal.timestamp.toISOString(),
    referencePrice: signal.price,
    estimatedCostPct,
    trigger: {
      primaryIntervalSec: signal.meta.primaryIntervalSec,
      confirmIntervalSec: signal.meta.confirmIntervalSec,
      primaryCandleStartSec: signal.meta.primaryCandleStartSec,
      primaryCandleCloseSec: signal.meta.primaryCandleCloseSec,
      volumeRatio: signal.meta.volumeRatio,
      avgVolume: signal.meta.avgVolume,
      currentVolume: signal.meta.currentVolume,
      breakoutHigh: signal.meta.highestHigh,
      confirmPriceChangePct: signal.meta.confirmPriceChangePct,
      confirmBullishBars: signal.meta.confirmBullishBars,
      atr: signal.meta.atr,
    },
    orderPreview: {
      stopLoss: preview.stopLoss,
      takeProfit1: preview.takeProfit1,
      takeProfit2: preview.takeProfit2,
      trailingStop: preview.trailingStop,
      plannedRiskPct: signal.price > 0 ? Math.abs(signal.price - preview.stopLoss) / signal.price : undefined,
    },
    gate: {
      startedAt: signal.timestamp.toISOString(),
      endedAt: signal.timestamp.toISOString(),
      latencyMs: 0,
      rejected: gateRejected,
      filterReason,
      breakoutScore: matchedStoredSignal?.gate.breakoutScore,
      breakoutGrade: matchedStoredSignal?.gate.breakoutGrade,
    },
    processing: {
      startedAt: signal.timestamp.toISOString(),
      endedAt: signal.timestamp.toISOString(),
      latencyMs: 0,
      status: processingStatus,
      filterReason,
      txSignature: matchedStoredSignal?.processing.txSignature ?? 'REPLAY',
      tradeId: matchedStoredSignal?.processing.tradeId,
    },
    context: matchedStoredSignal?.context,
  }, builder.getRecentCandles(signal.pairAddress, 5, outcomeTracker.getRequiredHistoryCount()));
}

function matchStoredSignal(
  records: RealtimeSignalRecord[],
  pairAddress: string,
  signalTimeSec: number
): RealtimeSignalRecord | undefined {
  return records.find((record) => {
    if (record.pairAddress !== pairAddress) return false;
    const recordTimeSec = typeof record.trigger.primaryCandleCloseSec === 'number'
      ? record.trigger.primaryCandleCloseSec
      : Math.floor(Date.parse(record.signalTimestamp) / 1000);
    return Math.abs(recordTimeSec - signalTimeSec) <= 1;
  });
}

async function drainTasks(tasks: Promise<void>[]): Promise<void> {
  if (tasks.length === 0) return;
  const snapshot = tasks.splice(0, tasks.length);
  await Promise.all(snapshot);
}
