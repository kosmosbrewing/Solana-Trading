import { DailySummaryReport, RealtimeAdmissionSummary } from '../notifier/dailySummaryFormatter';
import { RealtimeAdmissionSnapshotEntry } from '../realtime';
import { EdgeTracker, sanitizeEdgeLikeTrades, summarizeTradesBySource } from '../reporting';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { BotContext } from './types';

const log = createModuleLogger('Reporting');

/** KST 08~24시 사이 짝수 시각에 heartbeat, 09시에 daily full report */
const HEARTBEAT_KST_HOURS = [8, 10, 12, 14, 16, 18, 20, 22, 24];
const DAILY_KST_HOUR = 9;

export function scheduleDailySummary(ctx: BotContext): void {
  setInterval(async () => {
    const now = new Date();
    const kstHour = (now.getUTCHours() + 9) % 24;
    const minute = now.getMinutes();

    if (kstHour === DAILY_KST_HOUR && minute === 0) {
      try {
        await sendDailySummaryReport(ctx);
      } catch (error) {
        log.error(`Daily summary failed: ${error}`);
      }
    } else if (HEARTBEAT_KST_HOURS.includes(kstHour) && minute === 0) {
      try {
        await sendHeartbeatReport(ctx);
      } catch (error) {
        log.error(`Heartbeat report failed: ${error}`);
      }
    }
  }, 60_000);
}

/** 2시간 간격 간략 리포트: Paper 전적 + 시장 체제 */
async function sendHeartbeatReport(ctx: BotContext): Promise<void> {
  const lines: string[] = [];

  if (ctx.paperMetrics) {
    lines.push(ctx.paperMetrics.formatSummaryText(24));
  }

  if (ctx.regimeFilter) {
    const regime = ctx.regimeFilter.getState();
    const regimeIcon = regime.regime === 'risk_on' ? '🟢' : regime.regime === 'risk_off' ? '🔴' : '🟡';
    const solIcon = regime.solTrendBullish ? '🟢' : '🔴';
    const solLabel = regime.solTrendBullish ? '강세' : '약세';
    lines.push(
      `🔍 시장: ${regimeIcon} ${regime.regime} (${regime.sizeMultiplier}x)\n` +
      `SOL ${solIcon}${solLabel} | 확산 ${(regime.breadthPct * 100).toFixed(0)}% | 후속 ${(regime.followThroughPct * 100).toFixed(0)}%`
    );
  }

  if (lines.length > 0) {
    await ctx.notifier.sendInfo(lines.join('\n\n'));
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
  const [signalCadence, tradeCadence, filterReasonCounts] = await Promise.all([
    ctx.auditLogger.getCadenceSignalSummary(cadenceHours),
    ctx.tradeStore.getCadenceTradeSummary(cadenceHours),
    ctx.auditLogger.getRecentGateFilterReasonCounts(rejectionMixHours),
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
    }))).trades
  );

  const wins = closedTodayTrades.filter(t => (t.pnl || 0) > 0);
  const losses = closedTodayTrades.filter(t => (t.pnl || 0) <= 0);
  const sourceOutcomes = summarizeTradesBySource(closedTodayTrades);
  const portfolio = await ctx.riskManager.getPortfolioState(balance);
  const runtimeDiagnostics = ctx.runtimeDiagnosticsTracker?.buildSummary(rejectionMixHours);

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
    realtimeAdmission: buildRealtimeAdmissionSummary(ctx),
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
    await ctx.notifier.sendInfo(paperText);
  }
  if (ctx.regimeFilter) {
    const regime = ctx.regimeFilter.getState();
    const regimeIcon = regime.regime === 'risk_on' ? '🟢' : regime.regime === 'risk_off' ? '🔴' : '🟡';
    const solIcon = regime.solTrendBullish ? '🟢' : '🔴';
    const solLabel = regime.solTrendBullish ? '강세' : '약세';
    await ctx.notifier.sendInfo(
      `🔍 시장: ${regimeIcon} ${regime.regime} (${regime.sizeMultiplier}x)\n` +
      `SOL ${solIcon}${solLabel} | 확산 ${(regime.breadthPct * 100).toFixed(0)}% | 후속 ${(regime.followThroughPct * 100).toFixed(0)}%`
    );
  }
}

function buildDailyRejectionMixSummary(params: {
  hours: number;
    filterReasonCounts: Array<{ reason: string; count: number }>;
    runtimeDiagnostics?: {
      admissionSkipCounts: Array<{ reason: string; count: number }>;
      admissionSkipDetailCounts: Array<{ label: string; count: number }>;
      capacityCounts: Array<{ label: string; count: number }>;
      triggerStatsCounts: Array<{ label: string; count: number }>;
      preWatchlistRejectCounts: Array<{ reason: string; count: number }>;
      preWatchlistRejectDetailCounts: Array<{ label: string; count: number }>;
      rateLimitCounts: Array<{ source: string; count: number }>;
      pollFailureCounts: Array<{ source: string; count: number }>;
      realtimeCandidateReadiness: {
        totalCandidates: number;
        prefiltered: number;
        admissionSkipped: number;
        ready: number;
        readinessRate: number;
      };
    };
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
    capacityCounts: params.runtimeDiagnostics?.capacityCounts ?? [],
    triggerStatsCounts: params.runtimeDiagnostics?.triggerStatsCounts ?? [],
    preWatchlistRejectCounts: params.runtimeDiagnostics?.preWatchlistRejectCounts ?? [],
    preWatchlistRejectDetailCounts: params.runtimeDiagnostics?.preWatchlistRejectDetailCounts ?? [],
    rateLimitCounts: params.runtimeDiagnostics?.rateLimitCounts ?? [],
    pollFailureCounts: params.runtimeDiagnostics?.pollFailureCounts ?? [],
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
