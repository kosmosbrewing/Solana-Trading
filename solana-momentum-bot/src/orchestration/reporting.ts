import { DailySummaryReport, RealtimeAdmissionSummary } from '../notifier/dailySummaryFormatter';
import { RealtimeAdmissionSnapshotEntry } from '../realtime';
import { EdgeTracker } from '../reporting';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { BotContext } from './types';

const log = createModuleLogger('Reporting');

export function scheduleDailySummary(ctx: BotContext): void {
  setInterval(async () => {
    const now = new Date();
    const kstHour = (now.getUTCHours() + 9) % 24;
    const minute = now.getMinutes();

    if (kstHour === 9 && minute === 0) {
      try {
        await sendDailySummaryReport(ctx);
      } catch (error) {
        log.error(`Daily summary failed: ${error}`);
      }
    }
  }, 60_000);
}

async function sendDailySummaryReport(ctx: BotContext): Promise<void> {
  const todayTrades = await ctx.tradeStore.getTodayTrades();
  const closedTodayTrades = todayTrades.filter(
    trade => trade.status === 'CLOSED' && trade.pnl !== undefined
  );
  const dailyPnl = await ctx.tradeStore.getTodayPnl();
  const signalCounts = await ctx.auditLogger.getTodaySignalCounts();
  const balance = ctx.tradingMode === 'paper' && ctx.paperBalance != null
    ? ctx.paperBalance
    : await ctx.executor.getBalance();
  const status = ctx.healthMonitor.getStatus();
  const edgeTracker = new EdgeTracker(
    closedTodayTrades.map(trade => ({
      pairAddress: trade.pairAddress,
      strategy: trade.strategy,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      quantity: trade.quantity,
      pnl: trade.pnl ?? 0,
    }))
  );

  const wins = closedTodayTrades.filter(t => (t.pnl || 0) > 0);
  const losses = closedTodayTrades.filter(t => (t.pnl || 0) <= 0);
  const portfolio = await ctx.riskManager.getPortfolioState(balance);

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
    realtimeAdmission: buildRealtimeAdmissionSummary(ctx),
  } satisfies DailySummaryReport);

  // Phase 1B: Paper metrics + regime status
  if (ctx.paperMetrics) {
    const paperText = ctx.paperMetrics.formatSummaryText(24);
    await ctx.notifier.sendInfo(paperText);
  }
  if (ctx.regimeFilter) {
    const regime = ctx.regimeFilter.getState();
    await ctx.notifier.sendInfo(
      `🔍 Regime: ${regime.regime} (size=${regime.sizeMultiplier}x) ` +
      `SOL=${regime.solTrendBullish ? 'bull' : 'bear'} ` +
      `breadth=${(regime.breadthPct * 100).toFixed(0)}% follow=${(regime.followThroughPct * 100).toFixed(0)}%`
    );
  }
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
