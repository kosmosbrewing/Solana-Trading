import type { Cohort } from '../scanner/cohort';
import { createCohortRecord } from '../scanner/cohort';
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
  /**
   * Phase 1 fresh-cohort instrumentation (optional).
   * 해당 signal 발화 당시의 scanner watchlist cohort 라벨. 소급 계산 불가능한
   * legacy 레코드는 필드가 없거나 'unknown'.
   */
  cohort?: Cohort;
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
    triggerMode?: number;
    buyRatio?: number;
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
    discoveryTimestamp?: string;
    triggerWarmupLatencyMs?: number;
    marketCapUsd?: number;
    volumeMcapRatio?: number;
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
  avgTriggerWarmupLatencyMs: number;
  p50TriggerWarmupLatencyMs: number;
  p95TriggerWarmupLatencyMs: number;
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

  // Why: 균등 포지션(SOL 기준) 트레이딩에서는 카운트 가중치가 달러 가중치보다 정확.
  // 토큰 가격이 천차만별인 밈코인에서 dollar-weighted는 고가 토큰에 편향됨.
  // pnl = adjustedReturnPct (정규화), entryPrice/stopLoss 고정으로 R-multiple 일관성 유지.
  // orderPreview 없는 백테스트 신호도 평가 가능.
  const pseudoTrades = horizonRecords.map((item) => ({
    entryPrice: 1,
    stopLoss: 0.9,
    quantity: 1,
    pnl: item.horizon.adjustedReturnPct,
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
  const triggerWarmupLatencies = records
    .map((record) => record.context?.triggerWarmupLatencyMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  const avgReturnPct = average(horizonRecords.map((item) => item.horizon.returnPct));
  const avgAdjustedReturnPct = average(horizonRecords.map((item) => item.horizon.adjustedReturnPct));
  const avgMfePct = average(horizonRecords.map((item) => item.horizon.mfePct));
  const avgMaePct = average(horizonRecords.map((item) => item.horizon.maePct));
  const netPnlPct = pseudoTrades.length > 0
    ? pseudoTrades.reduce((sum, trade) => sum + trade.pnl, 0) / pseudoTrades.length
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
    avgTriggerWarmupLatencyMs: average(triggerWarmupLatencies),
    p50TriggerWarmupLatencyMs: percentile(triggerWarmupLatencies, 50),
    p95TriggerWarmupLatencyMs: percentile(triggerWarmupLatencies, 95),
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

export interface RealtimeStrategyBreakdown {
  overall: RealtimeMeasurementSummary;
  byStrategy: Record<string, RealtimeMeasurementSummary>;
  /**
   * Phase 1 fresh-cohort instrumentation: cohort × strategy 2-D measurement.
   * 키는 `${cohort}:${strategy}` 형태. 비어있는 조합은 포함되지 않는다.
   */
  byCohortStrategy?: Record<string, RealtimeMeasurementSummary>;
  /** cohort 단독 집계 (strategy 합산) */
  byCohort?: Record<Cohort, RealtimeMeasurementSummary>;
}

export function summarizeRealtimeSignalsByStrategy(
  records: RealtimeSignalRecord[],
  horizonSec = 180
): RealtimeStrategyBreakdown {
  const overall = summarizeRealtimeSignals(records, horizonSec);

  const groups = new Map<string, RealtimeSignalRecord[]>();
  for (const record of records) {
    const group = groups.get(record.strategy) ?? [];
    group.push(record);
    groups.set(record.strategy, group);
  }

  const byStrategy: Record<string, RealtimeMeasurementSummary> = {};
  for (const [strategy, group] of groups) {
    byStrategy[strategy] = summarizeRealtimeSignals(group, horizonSec);
  }

  // Phase 1: cohort 단독 집계.
  // Why: 빈 cohort 에도 zero-summary 를 채워 다운스트림 리포트가 optional chain 없이
  //      읽을 수 있게 한다. 각 cohort 는 factory 로 독립 인스턴스를 만들어 공유-참조
  //      footgun 을 방지한다 (assessment 등 nested 필드가 mutable 하기 때문).
  const cohortGroups = new Map<Cohort, RealtimeSignalRecord[]>();
  for (const record of records) {
    const cohort: Cohort = record.cohort ?? 'unknown';
    const group = cohortGroups.get(cohort) ?? [];
    group.push(record);
    cohortGroups.set(cohort, group);
  }
  let byCohort: Record<Cohort, RealtimeMeasurementSummary> | undefined;
  if (cohortGroups.size > 0) {
    byCohort = createCohortRecord<RealtimeMeasurementSummary>(() =>
      summarizeRealtimeSignals([], horizonSec)
    );
    for (const [cohort, group] of cohortGroups) {
      if (group.length > 0) {
        byCohort[cohort] = summarizeRealtimeSignals(group, horizonSec);
      }
    }
  }

  // Phase 1: cohort × strategy 2-D breakdown
  const crossGroups = new Map<string, RealtimeSignalRecord[]>();
  for (const record of records) {
    const key = `${record.cohort ?? 'unknown'}:${record.strategy}`;
    const group = crossGroups.get(key) ?? [];
    group.push(record);
    crossGroups.set(key, group);
  }
  let byCohortStrategy: Record<string, RealtimeMeasurementSummary> | undefined;
  if (crossGroups.size > 0) {
    byCohortStrategy = {};
    for (const [key, group] of crossGroups) {
      byCohortStrategy[key] = summarizeRealtimeSignals(group, horizonSec);
    }
  }

  return { overall, byStrategy, byCohortStrategy, byCohort };
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
