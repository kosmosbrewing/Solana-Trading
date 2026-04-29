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

/**
 * 2026-04-29: 매 시간 KST snapshot — 잔고 + 1h 증감 + close 카운트.
 * Why: paper close 가 silent (kolPaperNotifier 가 hourly digest + 5x anomaly 만) 하여 운영자가
 *   close 알림 누락 인지. hourly snapshot 으로 매 시간 paper/live close 누적 표시.
 *   2h heartbeat 와 daily 는 그대로 유지 (더 자세). hourly 는 짧은 quick check.
 */
const HOURLY_SNAPSHOT_KST_HOURS = Array.from({ length: 24 }, (_, i) => i);

export function getScheduledReportType(now: Date): 'daily' | 'heartbeat' | 'hourly' | null {
  // 2026-04-29 fix: minute===0 strict 검사 제거.
  // 이전 로직: `setInterval(60_000) + minute === 0` 패턴은 event loop lag / 시작 시각 misalign
  //   시 매 시간 firing 을 통째로 skip 가능 (e.g., 시작 12:34:56 → fire 시각 HH:00:56 일 때 OK,
  //   누적 drift 5초만 발생해도 HH:01:01 으로 밀려 minute===0 false → 그 시간 skip).
  // 신규: 호출자가 hour boundary 1회 fire 보장 (lastFiredHour 추적). minute 조건 제거.
  const kstHour = (now.getUTCHours() + 9) % 24;

  // 우선순위: daily > heartbeat > hourly (같은 시각이면 더 자세한 보고만)
  if (kstHour === DAILY_KST_HOUR) {
    return 'daily';
  }

  if (HEARTBEAT_KST_HOURS.includes(kstHour)) {
    return 'heartbeat';
  }

  if (HOURLY_SNAPSHOT_KST_HOURS.includes(kstHour)) {
    return 'hourly';
  }

  return null;
}

// 2026-04-29 fix: UTC hour boundary 기반 fire-once tracking.
// scheduler 가 매 30s 깨어나서 현재 UTC hour 이 lastFiredHour 와 다른지 확인.
// 다르면 1회 fire 후 lastFiredHour 갱신 → event loop drift / 시작 misalign 무관 보장.
let lastFiredUtcHour = -1;

/** 테스트 / 재시작 시 fire tracker reset. */
export function resetReportSchedulerForTests(): void {
  lastFiredUtcHour = -1;
  hourlyBaseline = null;
}

export function scheduleDailySummary(ctx: BotContext): ReturnType<typeof setInterval> {
  // 2026-04-27: handle 반환하여 setupShutdown 에서 clearInterval. 이전엔 leak.
  // 2026-04-29 fix: 30s polling + lastFiredUtcHour 기반 fire-once-per-hour 보장.
  log.info('[Reporting] scheduler started — 30s poll, fire-once-per-UTC-hour, KST-aware');
  return setInterval(async () => {
    const now = new Date();
    const currentUtcHour = Math.floor(now.getTime() / 3_600_000);
    if (currentUtcHour === lastFiredUtcHour) return;  // 이미 이 hour 발사 — skip

    const reportType = getScheduledReportType(now);
    if (!reportType) return;  // KST 정의된 hour 가 아니면 skip (방어 — 실제론 매 시간 1개 type)

    // 발사 확정 — drift 보호 위해 mark 우선 (await 도중 다음 30s tick 진입 차단)
    lastFiredUtcHour = currentUtcHour;
    const kstHour = (now.getUTCHours() + 9) % 24;
    log.info(`[Reporting] firing ${reportType} (UTC ${now.toISOString()} / KST ${kstHour}:00)`);

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
    } else if (reportType === 'hourly') {
      try {
        await sendHourlySnapshot(ctx);
      } catch (error) {
        log.error(`Hourly snapshot failed: ${error}`);
      }
    }
  }, 30_000);
}

// ─── Hourly Snapshot (2026-04-29) ───
// 매 KST 시간 정각 — 잔고 + 1h 증감 + close 카운트 + 5x winner 누적.
// state: 직전 1h baseline 저장 (in-memory, 봇 재시작 시 reset 됨 — 첫 1h 는 증감 표시 없음).

interface HourlyBaseline {
  balanceSol: number;
  capturedAtMs: number;
}
let hourlyBaseline: HourlyBaseline | null = null;

function formatKstHour(now: Date): string {
  const kstHour = (now.getUTCHours() + 9) % 24;
  return `${kstHour.toString().padStart(2, '0')}:00`;
}

async function sendHourlySnapshot(ctx: BotContext): Promise<void> {
  const now = new Date();
  const balance = ctx.tradingMode === 'paper' && ctx.paperBalance != null
    ? ctx.paperBalance
    : await ctx.executor.getBalance();

  // 1h 증감 계산
  let deltaStr = '';
  if (hourlyBaseline != null) {
    const delta = balance - hourlyBaseline.balanceSol;
    const sign = delta >= 0 ? '+' : '';
    deltaStr = ` (${sign}${delta.toFixed(4)} SOL)`;
  }

  // 1h 누적 close 카운트 (live = DB trades) + 5x winner
  // Note: paper close 는 별도 jsonl ledger (kol-paper-trades.jsonl) 에 dump — DB 에 없음.
  //   향후 paper close 카운트 표시 필요 시 jsonl reader 추가 (별도 sub-task).
  const oneHourAgoMs = now.getTime() - 60 * 60 * 1000;
  const recentTrades = await ctx.tradeStore.getTradesCreatedWithinHours(1);
  const liveClosed = recentTrades.filter(
    (t) => t.status === 'CLOSED' && t.pnl !== undefined && t.closedAt && t.closedAt.getTime() >= oneHourAgoMs
  );
  const liveWinners = liveClosed.filter((t) => (t.pnl ?? 0) > 0).length;
  const liveLosers = liveClosed.filter((t) => (t.pnl ?? 0) <= 0).length;
  const liveCumPnl = liveClosed.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  // 5x+ winner 검출 (entry vs exit price 기반 — pnl 만으로는 mfe 알 수 없음, ratio 추정)
  const fivexWinners = liveClosed.filter((t) => {
    if (!t.entryPrice || !t.exitPrice || t.entryPrice <= 0) return false;
    return t.exitPrice / t.entryPrice >= 5.0;
  }).length;

  const lines: string[] = [];
  lines.push(`⏰ [HOURLY ${formatKstHour(now)} KST] balance=${balance.toFixed(4)} SOL${deltaStr}`);

  if (liveClosed.length > 0) {
    const cumSign = liveCumPnl >= 0 ? '+' : '';
    lines.push(`  · live close: ${liveClosed.length}건 (${liveWinners}W/${liveLosers}L) net ${cumSign}${liveCumPnl.toFixed(4)} SOL`);
    if (fivexWinners > 0) {
      lines.push(`  · 🎉 5x+ winner: ${fivexWinners}건 (사명 §3 phase gate)`);
    }
  } else {
    lines.push(`  · live close: 0건`);
  }

  await ctx.notifier.sendInfo(lines.join('\n'), 'hourly_snapshot');

  // baseline 갱신 (다음 시간 비교용)
  hourlyBaseline = { balanceSol: balance, capturedAtMs: now.getTime() };
}

/** 테스트 / 재시작 시 baseline reset. */
export function resetHourlyBaselineForTests(): void {
  hourlyBaseline = null;
  lastFiredUtcHour = -1;
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
    // 2026-04-29 (Option D): env override 반영 — Telegram digest 가 실 halt 임계 (riskManager.getActiveHalt) 와 정합.
    // null = tier 정책. 0 이하 = disable (해당 lane 은 wallet floor + canary cap 만 보호).
    dailyLossLimit: config.riskMaxDailyLossOverride != null
      ? config.riskMaxDailyLossOverride
      : (portfolio.riskTier?.maxDailyLoss ?? config.maxDailyLoss),
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
