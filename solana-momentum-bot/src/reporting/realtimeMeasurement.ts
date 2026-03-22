import { assessMeasuredEdgeStage, BacktestStageAssessment } from './measurement';
import { summarizeRiskMetrics } from './riskMetrics';

export type RealtimeSignalProcessingStatus =
  | 'executed_paper'
  | 'executed_live'
  | 'execution_failed'
  | 'gate_rejected'
  | 'trading_halted'
  | 'execution_lock'
  | 'stale'
  | 'risk_rejected'
  | 'regime_blocked'
  | 'wallet_limit'
  | 'execution_viability_rejected';

export interface RealtimeSignalHorizonOutcome {
  horizonSec: number;
  observedAt: string;
  price: number;
  returnPct: number;
  adjustedReturnPct: number;
  mfePct: number;
  maePct: number;
}

export interface RealtimeSignalRecord {
  version: 1;
  id: string;
  source: 'runtime' | 'replay';
  strategy: string;
  pairAddress: string;
  poolAddress?: string;
  tokenMint?: string;
  tokenSymbol?: string;
  signalTimestamp: string;
  referencePrice: number;
  estimatedCostPct: number;
  trigger: {
    primaryIntervalSec: number;
    confirmIntervalSec: number;
    primaryCandleStartSec?: number;
    primaryCandleCloseSec?: number;
    volumeRatio?: number;
    avgVolume?: number;
    currentVolume?: number;
    breakoutHigh?: number;
    confirmPriceChangePct?: number;
    confirmBullishBars?: number;
    atr?: number;
    breakoutScore?: number;
    breakoutGrade?: string;
  };
  orderPreview?: {
    stopLoss: number;
    takeProfit1: number;
    takeProfit2: number;
    trailingStop?: number;
    plannedRiskPct?: number;
  };
  gate: {
    startedAt: string;
    endedAt: string;
    latencyMs: number;
    rejected: boolean;
    filterReason?: string;
    breakoutScore?: number;
    breakoutGrade?: string;
  };
  processing: {
    startedAt: string;
    endedAt: string;
    latencyMs: number;
    status: RealtimeSignalProcessingStatus;
    filterReason?: string;
    tradeId?: string;
    txSignature?: string;
  };
  context?: {
    poolTvl?: number;
    attentionScore?: number;
    spreadPct?: number;
    ammFeePct?: number;
    mevMarginPct?: number;
    currentVolume24hUsd?: number;
  };
  horizons: RealtimeSignalHorizonOutcome[];
  summary: {
    completedAt: string;
    maxObservedSec: number;
    mfePct: number;
    maePct: number;
  };
}

export interface RealtimeMeasurementSummary {
  totalSignals: number;
  executedSignals: number;
  gateRejectedSignals: number;
  avgGateLatencyMs: number;
  p50GateLatencyMs: number;
  p95GateLatencyMs: number;
  avgSignalToFillLatencyMs: number;
  p50SignalToFillLatencyMs: number;
  p95SignalToFillLatencyMs: number;
  selectedHorizonSec: number;
  avgReturnPct: number;
  avgAdjustedReturnPct: number;
  avgMfePct: number;
  avgMaePct: number;
  assessment: BacktestStageAssessment;
}

export function summarizeRealtimeSignals(
  records: RealtimeSignalRecord[],
  horizonSec = 180
): RealtimeMeasurementSummary {
  const horizonRecords = records
    .map((record) => ({
      record,
      horizon: record.horizons.find((item) => item.horizonSec === horizonSec),
    }))
    .filter(
      (item): item is { record: RealtimeSignalRecord; horizon: RealtimeSignalHorizonOutcome } =>
        Boolean(item.horizon)
    );

  const pseudoTrades = horizonRecords
    .filter((item) => item.record.orderPreview?.stopLoss != null)
    .map((item) => ({
      entryPrice: item.record.referencePrice,
      stopLoss: item.record.orderPreview!.stopLoss,
      quantity: 1,
      pnl: item.horizon.adjustedReturnPct * item.record.referencePrice,
    }));

  const risk = summarizeRiskMetrics(pseudoTrades);
  const executedSignals = records.filter((record) =>
    record.processing.status === 'executed_paper' || record.processing.status === 'executed_live'
  );
  const gateRejectedSignals = records.filter((record) => record.gate.rejected).length;
  const gateLatencies = records.map((record) => record.gate.latencyMs);
  const fillLatencies = records
    .filter((record) => record.processing.status === 'executed_paper' || record.processing.status === 'executed_live')
    .map((record) => {
      const signalMs = Date.parse(record.signalTimestamp);
      const processedMs = Date.parse(record.processing.endedAt);
      return Number.isFinite(signalMs) && Number.isFinite(processedMs)
        ? Math.max(0, processedMs - signalMs)
        : record.processing.latencyMs;
    });

  const avgReturnPct = average(horizonRecords.map((item) => item.horizon.returnPct));
  const avgAdjustedReturnPct = average(horizonRecords.map((item) => item.horizon.adjustedReturnPct));
  const avgMfePct = average(horizonRecords.map((item) => item.horizon.mfePct));
  const avgMaePct = average(horizonRecords.map((item) => item.horizon.maePct));
  const notional = horizonRecords.reduce((sum, item) => sum + item.record.referencePrice, 0);
  const netPnlPct = notional > 0
    ? pseudoTrades.reduce((sum, trade) => sum + trade.pnl, 0) / notional
    : 0;

  return {
    totalSignals: records.length,
    executedSignals: executedSignals.length,
    gateRejectedSignals,
    avgGateLatencyMs: average(gateLatencies),
    p50GateLatencyMs: percentile(gateLatencies, 50),
    p95GateLatencyMs: percentile(gateLatencies, 95),
    avgSignalToFillLatencyMs: average(fillLatencies),
    p50SignalToFillLatencyMs: percentile(fillLatencies, 50),
    p95SignalToFillLatencyMs: percentile(fillLatencies, 95),
    selectedHorizonSec: horizonSec,
    avgReturnPct,
    avgAdjustedReturnPct,
    avgMfePct,
    avgMaePct,
    assessment: assessMeasuredEdgeStage({
      netPnlPct,
      expectancyR: risk.expectancyR,
      profitFactor: risk.profitFactor,
      sharpeRatio: risk.sharpeRatio,
      maxDrawdownPct: estimateDrawdownPct(horizonRecords.map((item) => item.horizon.adjustedReturnPct)),
      totalTrades: horizonRecords.length,
    }),
  };
}

function estimateDrawdownPct(returns: number[]): number {
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;

  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    }
  }

  return maxDrawdown;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)
  );
  return sorted[index];
}
