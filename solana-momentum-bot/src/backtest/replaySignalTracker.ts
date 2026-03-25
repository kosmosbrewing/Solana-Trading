import { buildMomentumTriggerOrder, MomentumOrderParams } from '../strategy';
import { MicroCandleBuilder } from '../realtime';
import { RealtimeOutcomeTracker, RealtimeSignalRecord } from '../reporting';
import { Signal } from '../utils/types';

export function trackReplaySignal(input: {
  signal: Signal;
  builder: MicroCandleBuilder;
  outcomeTracker: RealtimeOutcomeTracker;
  storedSignals: RealtimeSignalRecord[];
  gateMode: 'off' | 'stored';
  orderParams?: Partial<MomentumOrderParams>;
  estimatedCostPct?: number;
}): void {
  const matchedStoredSignal = input.gateMode === 'stored'
    ? matchStoredSignal(
      input.storedSignals,
      input.signal.pairAddress,
      input.signal.timestamp.getTime() / 1000
    )
    : undefined;
  const candles = input.builder.getRecentCandles(
    input.signal.pairAddress,
    input.signal.meta.primaryIntervalSec,
    30
  );
  if (candles.length === 0) return;

  const preview = buildMomentumTriggerOrder(input.signal, candles, 1, input.orderParams);
  const gateRejected = matchedStoredSignal?.gate.rejected ?? false;
  const processingStatus = matchedStoredSignal?.processing.status ?? 'executed_paper';
  const filterReason = matchedStoredSignal?.processing.filterReason ?? matchedStoredSignal?.gate.filterReason;
  const estimatedCostPct = matchedStoredSignal?.estimatedCostPct ?? input.estimatedCostPct ?? 0;

  input.outcomeTracker.track({
    version: 1,
    id: `replay:${input.signal.strategy}:${input.signal.pairAddress}:${input.signal.timestamp.toISOString()}`,
    source: 'replay',
    strategy: input.signal.strategy,
    pairAddress: input.signal.pairAddress,
    poolAddress: matchedStoredSignal?.poolAddress ?? input.signal.pairAddress,
    tokenMint: matchedStoredSignal?.tokenMint ?? input.signal.pairAddress,
    tokenSymbol: matchedStoredSignal?.tokenSymbol,
    signalTimestamp: input.signal.timestamp.toISOString(),
    referencePrice: input.signal.price,
    estimatedCostPct,
    trigger: {
      primaryIntervalSec: input.signal.meta.primaryIntervalSec,
      confirmIntervalSec: input.signal.meta.confirmIntervalSec,
      primaryCandleStartSec: input.signal.meta.primaryCandleStartSec,
      primaryCandleCloseSec: input.signal.meta.primaryCandleCloseSec,
      volumeRatio: input.signal.meta.volumeRatio,
      avgVolume: input.signal.meta.avgVolume,
      currentVolume: input.signal.meta.currentVolume,
      breakoutHigh: input.signal.meta.highestHigh,
      confirmPriceChangePct: input.signal.meta.confirmPriceChangePct,
      confirmBullishBars: input.signal.meta.confirmBullishBars,
      atr: input.signal.meta.atr,
    },
    orderPreview: {
      stopLoss: preview.stopLoss,
      takeProfit1: preview.takeProfit1,
      takeProfit2: preview.takeProfit2,
      trailingStop: preview.trailingStop,
      plannedRiskPct: input.signal.price > 0
        ? Math.abs(input.signal.price - preview.stopLoss) / input.signal.price
        : undefined,
    },
    gate: {
      startedAt: input.signal.timestamp.toISOString(),
      endedAt: input.signal.timestamp.toISOString(),
      latencyMs: 0,
      rejected: gateRejected,
      filterReason,
      breakoutScore: matchedStoredSignal?.gate.breakoutScore,
      breakoutGrade: matchedStoredSignal?.gate.breakoutGrade,
    },
    processing: {
      startedAt: input.signal.timestamp.toISOString(),
      endedAt: input.signal.timestamp.toISOString(),
      latencyMs: 0,
      status: processingStatus,
      filterReason,
      txSignature: matchedStoredSignal?.processing.txSignature ?? 'REPLAY',
      tradeId: matchedStoredSignal?.processing.tradeId,
    },
    context: matchedStoredSignal?.context,
  }, input.builder.getRecentCandles(input.signal.pairAddress, 5, input.outcomeTracker.getRequiredHistoryCount()));
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
