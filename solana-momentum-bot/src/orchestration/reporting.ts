import { CostSummary, DailySummaryReport, RealtimeAdmissionSummary } from '../notifier/dailySummaryFormatter';
import {
  buildHeartbeatPerformanceSummary,
  buildHeartbeatRegimeSummary,
  buildHeartbeatTradingSummary,
  HEARTBEAT_WINDOW_HOURS,
} from '../reporting/heartbeatSummary';
import { buildSparseOpsSummaryMessage, loadSparseOpsSummary } from '../reporting/sparseOpsSummary';
import { RuntimeDiagnosticsSummary } from '../reporting/runtimeDiagnosticsTracker';
import { RealtimeAdmissionSnapshotEntry } from '../realtime';
import { EdgeTracker, sanitizeEdgeLikeTrades, summarizeTradesBySource, computeExplainedEntryRatio } from '../reporting';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { BotContext } from './types';
import { sendKolDailySummary } from './kolDailySummary';

const log = createModuleLogger('Reporting');

/** KST 전일 기준 짝수 시각(00, 02, ..., 22)에 heartbeat, 09시에 daily full report */
const HEARTBEAT_KST_HOURS = Array.from({ length: 12 }, (_, index) => index * 2);
const DAILY_KST_HOUR = 9;

export function getScheduledReportType(now: Date): 'daily' | 'heartbeat' | null {
  const kstHour = (now.getUTCHours() + 9) % 24;
  const minute = now.getMinutes();

  if (minute !== 0) {
    return null;
  }

  if (kstHour === DAILY_KST_HOUR) {
    return 'daily';
  }

  if (HEARTBEAT_KST_HOURS.includes(kstHour)) {
    return 'heartbeat';
  }

  return null;
}

export function scheduleDailySummary(ctx: BotContext): void {
  setInterval(async () => {
    const reportType = getScheduledReportType(new Date());

    if (reportType === 'daily') {
      try {
        await sendDailySummaryReport(ctx);
      } catch (error) {
        log.error(`Daily summary failed: ${error}`);
      }
    } else if (reportType === 'heartbeat') {
      try {
        await sendHeartbeatReport(ctx);
      } catch (error) {
        log.error(`Heartbeat report failed: ${error}`);
      }
    }
  }, 60_000);
}

/**
 * 2시간 간격 간략 리포트.
 * Why: 사용자 알림(잔액/전적/시장)과 운영 텔레메트리(희박/Freshness/Cohort funnel)를
 *      하나의 메시지에 섞으면 사용자가 노이즈에 묻혀 계좌 상태를 놓친다.
 *      별도 카테고리로 분리 발송해 throttle 키도 독립화한다.
 */
async function sendHeartbeatReport(ctx: BotContext): Promise<void> {
  const recentTrades = await ctx.tradeStore.getTradesCreatedWithinHours(HEARTBEAT_WINDOW_HOURS);
  const closedRecentTrades = recentTrades.filter(
    trade => trade.status === 'CLOSED' && trade.pnl !== undefined
  );
  const pnl = await ctx.tradeStore.getClosedPnlWithinHours(HEARTBEAT_WINDOW_HOURS);
  const balance = ctx.tradingMode === 'paper' && ctx.paperBalance != null
    ? ctx.paperBalance
    : await ctx.executor.getBalance();
  const portfolio = await ctx.riskManager.getPortfolioState(balance);

  const userLines: string[] = [
    buildHeartbeatTradingSummary({
      tradingMode: ctx.tradingMode,
      windowHours: HEARTBEAT_WINDOW_HOURS,
      balanceSol: balance,
      pnl,
      enteredTrades: recentTrades.length,
      closedTrades: closedRecentTrades.length,
      openTrades: portfolio.openTrades.length,
    }),
  ];

  if (ctx.paperMetrics) {
    const performanceSummary = buildHeartbeatPerformanceSummary(
      ctx.paperMetrics.getSummary(HEARTBEAT_WINDOW_HOURS)
    );
    if (performanceSummary) {
      userLines.push(performanceSummary);
    }
  }

  if (ctx.regimeFilter) {
    userLines.push(buildHeartbeatRegimeSummary(ctx.regimeFilter.getState()));
  }

  if (userLines.length > 0) {
    await ctx.notifier.sendInfo(userLines.join('\n\n'), 'heartbeat');
  }

  const sparseSummary = buildSparseOpsSummaryMessage(
    loadSparseOpsSummary(config.realtimeDataDir, HEARTBEAT_WINDOW_HOURS, 3)
  );
  if (sparseSummary) {
    await ctx.notifier.sendInfo(sparseSummary, 'heartbeat_ops');
  }
}

async function sendDailySummaryReport(ctx: BotContext): Promise<void> {
  const cadenceHours = [6, 12, 24];
  const rejectionMixHours = 24;
  const todayTrades = await ctx.tradeStore.getTodayTrades();
  const closedTodayTrades = todayTrades.filter(
    trade => trade.status === 'CLOSED' && trade.pnl !== undefined
  );
  const dailyPnl = await ctx.tradeStore.getTodayPnl();
  const signalCounts = await ctx.auditLogger.getTodaySignalCounts();
  const [signalCadence, tradeCadence, filterReasonCounts, strategyTelemetry, exitReasonBreakdown] = await Promise.all([
    ctx.auditLogger.getCadenceSignalSummary(cadenceHours),
    ctx.tradeStore.getCadenceTradeSummary(cadenceHours),
    ctx.auditLogger.getRecentGateFilterReasonCounts(rejectionMixHours),
    ctx.auditLogger.getRecentStrategyFilterBreakdown(rejectionMixHours),
    ctx.tradeStore.getExitReasonBreakdown(rejectionMixHours),
  ]);
  const balance = ctx.tradingMode === 'paper' && ctx.paperBalance != null
    ? ctx.paperBalance
    : await ctx.executor.getBalance();
  const status = ctx.healthMonitor.getStatus();
  const edgeTracker = new EdgeTracker(
    sanitizeEdgeLikeTrades(closedTodayTrades.map(trade => ({
      pairAddress: trade.pairAddress,
      strategy: trade.strategy,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      quantity: trade.quantity,
      pnl: trade.pnl ?? 0,
      // Phase B1: sanitizer가 오염된 row를 drop할 수 있도록 정합성 컨텍스트 전달.
      plannedEntryPrice: trade.plannedEntryPrice ?? null,
      exitReason: trade.exitReason ?? null,
      // 2026-04-07: fake-fill sanitizer filter 컨텍스트
      exitSlippageBps: trade.exitSlippageBps ?? null,
      exitAnomalyReason: trade.exitAnomalyReason ?? null,
    }))).trades
  );

  const wins = closedTodayTrades.filter(t => (t.pnl || 0) > 0);
  const losses = closedTodayTrades.filter(t => (t.pnl || 0) <= 0);
  const sourceOutcomes = summarizeTradesBySource(closedTodayTrades);
  // Why: MEASUREMENT.md "최근 50 executed trades" — 진입 기준 (open/closed 무관)
  const recentExecutedEntries = await ctx.tradeStore.getRecentExecutedEntries(50);
  const explainedEntry = computeExplainedEntryRatio(recentExecutedEntries);
  const portfolio = await ctx.riskManager.getPortfolioState(balance);
  const runtimeDiagnostics = ctx.runtimeDiagnosticsTracker?.buildSummary(rejectionMixHours);
  const todayUtcOps = ctx.runtimeDiagnosticsTracker?.buildTodayUtcOperationalSummary();

  let bestTrade: { pair: string; pnl: number; score: number; grade: string } | undefined;
  let worstTrade: { pair: string; pnl: number; score: number; grade: string } | undefined;

  for (const t of closedTodayTrades) {
    if (t.pnl !== undefined) {
      if (!bestTrade || t.pnl > bestTrade.pnl) {
        bestTrade = {
          pair: t.pairAddress,
          pnl: t.pnl,
          score: t.breakoutScore || 0,
          grade: t.breakoutGrade || 'N/A',
        };
      }
      if (!worstTrade || t.pnl < worstTrade.pnl) {
        worstTrade = {
          pair: t.pairAddress,
          pnl: t.pnl,
          score: t.breakoutScore || 0,
          grade: t.breakoutGrade || 'N/A',
        };
      }
    }
  }

  const costSummary = buildCostSummary(closedTodayTrades);

  await ctx.notifier.sendDailySummary({
    totalTrades: closedTodayTrades.length,
    wins: wins.length,
    losses: losses.length,
    pnl: dailyPnl,
    portfolioValue: balance,
    bestTrade,
    worstTrade,
    signalsDetected: signalCounts.detected,
    signalsExecuted: signalCounts.executed,
    signalsFiltered: signalCounts.filtered,
    dailyLossUsed: portfolio.equitySol > 0 ? Math.abs(dailyPnl) / portfolio.equitySol : 0,
    dailyLossLimit: portfolio.riskTier?.maxDailyLoss ?? config.maxDailyLoss,
    consecutiveLosses: portfolio.consecutiveLosses,
    uptime: status.uptime,
    restarts: 0,
    edgeStats: edgeTracker.getAllStrategyStats(),
    sourceOutcomes,
    explainedEntryRatio: {
      total: explainedEntry.total,
      explained: explainedEntry.explained,
      ratio: explainedEntry.ratio,
    },
    costSummary,
    todayUtcOps,
    realtimeAdmission: buildRealtimeAdmissionSummary(ctx),
    strategyTelemetry,
    exitReasonBreakdown,
    cadence: buildDailyCadenceSummary(signalCadence, tradeCadence),
    rejectionMix: buildDailyRejectionMixSummary({
      hours: rejectionMixHours,
      filterReasonCounts,
      runtimeDiagnostics,
      lastCandleAt: status.lastCandleAt,
    }),
  } satisfies DailySummaryReport);

  // Phase 1B: Paper metrics + regime status
  if (ctx.paperMetrics) {
    const paperText = ctx.paperMetrics.formatSummaryText(24);
    await ctx.notifier.sendInfo(paperText, 'paper_metrics');
  }
  if (ctx.regimeFilter) {
    await ctx.notifier.sendInfo(
      buildHeartbeatRegimeSummary(ctx.regimeFilter.getState()),
      'regime'
    );
  }

  // 2026-04-26 L3: KOL paper A/B daily summary (kol-paper-trades.jsonl 기준).
  // config.kolDailySummaryEnabled 로 gate. 24h 거래 0건이면 skip.
  await sendKolDailySummary(ctx.notifier);
}

function buildCostSummary(trades: import('../utils/types').Trade[]): CostSummary | undefined {
  // Why: 비용 필드가 있는 거래만 집계 (legacy trade는 null)
  const withCost = trades.filter(t => t.entrySlippageBps != null || t.exitSlippageBps != null);
  if (withCost.length === 0) return undefined;

  const avg = (values: number[]) => values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;

  return {
    tradeCount: withCost.length,
    avgEntrySlippageBps: avg(withCost.map(t => t.entrySlippageBps ?? 0)),
    avgExitSlippageBps: avg(withCost.map(t => t.exitSlippageBps ?? 0)),
    avgRoundTripCostPct: avg(withCost.filter(t => t.roundTripCostPct != null).map(t => t.roundTripCostPct!)),
    avgEffectiveRR: avg(withCost.filter(t => t.effectiveRR != null).map(t => t.effectiveRR!)),
  };
}

function buildDailyRejectionMixSummary(params: {
  hours: number;
  filterReasonCounts: Array<{ reason: string; count: number }>;
  runtimeDiagnostics?: RuntimeDiagnosticsSummary;
  lastCandleAt?: Date;
}): DailySummaryReport['rejectionMix'] {
  const nowMs = Date.now();
  return {
    hours: params.hours,
    lastCandleAt: params.lastCandleAt?.toISOString(),
    timeSinceLastCandleMs: params.lastCandleAt
      ? Math.max(0, nowMs - params.lastCandleAt.getTime())
      : undefined,
    gateFilterReasonCounts: params.filterReasonCounts,
    admissionSkipCounts: params.runtimeDiagnostics?.admissionSkipCounts ?? [],
    admissionSkipDetailCounts: params.runtimeDiagnostics?.admissionSkipDetailCounts ?? [],
    aliasMissCounts: params.runtimeDiagnostics?.aliasMissCounts ?? [],
    candidateEvictedCount: params.runtimeDiagnostics?.candidateEvictedCount ?? 0,
    candidateReaddedWithinGraceCount: params.runtimeDiagnostics?.candidateReaddedWithinGraceCount ?? 0,
    signalNotInWatchlistCount: params.runtimeDiagnostics?.signalNotInWatchlistCount ?? 0,
    signalNotInWatchlistRecentlyEvictedCount:
      params.runtimeDiagnostics?.signalNotInWatchlistRecentlyEvictedCount ?? 0,
    missedTokens: params.runtimeDiagnostics?.missedTokens ?? [],
    capacityCounts: params.runtimeDiagnostics?.capacityCounts ?? [],
    triggerStatsCounts: params.runtimeDiagnostics?.triggerStatsCounts ?? [],
    latestTriggerStats: params.runtimeDiagnostics?.latestTriggerStats,
    bootstrapBoostedSignalCount: params.runtimeDiagnostics?.bootstrapBoostedSignalCount ?? 0,
    preWatchlistRejectCounts: params.runtimeDiagnostics?.preWatchlistRejectCounts ?? [],
    preWatchlistRejectDetailCounts: params.runtimeDiagnostics?.preWatchlistRejectDetailCounts ?? [],
    rateLimitCounts: params.runtimeDiagnostics?.rateLimitCounts ?? [],
    pollFailureCounts: params.runtimeDiagnostics?.pollFailureCounts ?? [],
    riskRejectionCounts: params.runtimeDiagnostics?.riskRejectionCounts ?? [],
    realtimeCandidateReadiness: params.runtimeDiagnostics?.realtimeCandidateReadiness ?? {
      totalCandidates: 0,
      prefiltered: 0,
      admissionSkipped: 0,
      ready: 0,
      readinessRate: 0,
    },
  };
}

function buildDailyCadenceSummary(
  signalCadence: {
    lastSignalAt?: Date;
    windows: Array<{ hours: number; detected: number; executed: number; filtered: number }>;
  },
  tradeCadence: {
    lastTradeAt?: Date;
    lastClosedTradeAt?: Date;
    windows: Array<{ hours: number; trades: number; closedTrades: number }>;
  }
): DailySummaryReport['cadence'] {
  const nowMs = Date.now();
  const signalWindowMap = new Map(signalCadence.windows.map((window) => [window.hours, window]));
  const tradeWindowMap = new Map(tradeCadence.windows.map((window) => [window.hours, window]));
  const hours = [...new Set([...signalWindowMap.keys(), ...tradeWindowMap.keys()])].sort((a, b) => a - b);

  return {
    lastSignalAt: signalCadence.lastSignalAt?.toISOString(),
    lastTradeAt: tradeCadence.lastTradeAt?.toISOString(),
    lastClosedTradeAt: tradeCadence.lastClosedTradeAt?.toISOString(),
    timeSinceLastSignalMs: signalCadence.lastSignalAt ? Math.max(0, nowMs - signalCadence.lastSignalAt.getTime()) : undefined,
    timeSinceLastTradeMs: tradeCadence.lastTradeAt ? Math.max(0, nowMs - tradeCadence.lastTradeAt.getTime()) : undefined,
    timeSinceLastClosedTradeMs: tradeCadence.lastClosedTradeAt
      ? Math.max(0, nowMs - tradeCadence.lastClosedTradeAt.getTime())
      : undefined,
    windows: hours.map((hour) => ({
      hours: hour,
      detectedSignals: signalWindowMap.get(hour)?.detected ?? 0,
      executedSignals: signalWindowMap.get(hour)?.executed ?? 0,
      filteredSignals: signalWindowMap.get(hour)?.filtered ?? 0,
      trades: tradeWindowMap.get(hour)?.trades ?? 0,
      closedTrades: tradeWindowMap.get(hour)?.closedTrades ?? 0,
    })),
  };
}

function buildRealtimeAdmissionSummary(ctx: BotContext): RealtimeAdmissionSummary | undefined {
  if (!ctx.realtimeAdmissionTracker) return undefined;

  const entries = ctx.realtimeAdmissionTracker.exportSnapshot();
  if (entries.length === 0) return undefined;

  const blockedDetails = entries
    .filter((entry) => entry.blocked)
    .map((entry) => ({
      pool: entry.pool,
      observedNotifications: entry.observedNotifications,
      parseRatePct: calculateParseRatePct(entry),
      skippedRatePct: calculateSkippedRatePct(entry),
    }))
    .sort((left, right) => right.observedNotifications - left.observedNotifications)
    .slice(0, 3);

  const blockedPools = entries.filter((entry) => entry.blocked).length;
  return {
    trackedPools: entries.length,
    allowedPools: entries.length - blockedPools,
    blockedPools,
    blockedDetails,
  };
}

function calculateParseRatePct(entry: RealtimeAdmissionSnapshotEntry): number {
  if (entry.observedNotifications <= 0) return 0;
  return Number((((entry.logParsed + (entry.fallbackParsed ?? 0)) / entry.observedNotifications) * 100).toFixed(2));
}

function calculateSkippedRatePct(entry: RealtimeAdmissionSnapshotEntry): number {
  if (entry.observedNotifications <= 0) return 0;
  return Number(((entry.fallbackSkipped / entry.observedNotifications) * 100).toFixed(2));
}
