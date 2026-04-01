import { SourceOutcomeStats, StrategyEdgeStats } from '../reporting';
import {
  formatStrategy,
} from './messageFormatter';
import {
  escapeHtml,
  formatDuration,
  formatPercent,
  formatRewardRisk,
  formatSignedPercent,
  formatSignedSol,
  shortenAddress,
} from './formatting';
import { formatEdgeState } from './messageFormatter';

export interface RealtimeAdmissionSummary {
  trackedPools: number;
  allowedPools: number;
  blockedPools: number;
  blockedDetails: Array<{
    pool: string;
    observedNotifications: number;
    parseRatePct: number;
    skippedRatePct: number;
  }>;
}

export interface DailyCadenceSummary {
  lastSignalAt?: string;
  lastTradeAt?: string;
  lastClosedTradeAt?: string;
  timeSinceLastSignalMs?: number;
  timeSinceLastTradeMs?: number;
  timeSinceLastClosedTradeMs?: number;
  windows: Array<{
    hours: number;
    detectedSignals: number;
    executedSignals: number;
    filteredSignals: number;
    trades: number;
    closedTrades: number;
  }>;
}

export interface DailyRejectionMixSummary {
  hours: number;
  lastCandleAt?: string;
  timeSinceLastCandleMs?: number;
  gateFilterReasonCounts: Array<{ reason: string; count: number }>;
  admissionSkipCounts: Array<{ reason: string; count: number }>;
  admissionSkipDetailCounts: Array<{ label: string; count: number }>;
  capacityCounts: Array<{ label: string; count: number }>;
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
}

export interface DailySummaryReport {
  totalTrades: number;
  wins: number;
  losses: number;
  pnl: number;
  portfolioValue: number;
  bestTrade?: { pair: string; pnl: number; score: number; grade: string };
  worstTrade?: { pair: string; pnl: number; score: number; grade: string };
  signalsDetected: number;
  signalsExecuted: number;
  signalsFiltered: number;
  dailyLossUsed: number;
  dailyLossLimit: number;
  consecutiveLosses: number;
  uptime: number;
  restarts: number;
  edgeStats?: StrategyEdgeStats[];
  sourceOutcomes?: SourceOutcomeStats[];
  realtimeAdmission?: RealtimeAdmissionSummary;
  cadence?: DailyCadenceSummary;
  rejectionMix?: DailyRejectionMixSummary;
}

export function buildDailySummaryMessage(report: DailySummaryReport, dateLabel: string): string {
  const winRate = report.totalTrades > 0 ? (report.wins / report.totalTrades) : 0;
  const pnlPct = report.portfolioValue > 0 ? (report.pnl / report.portfolioValue) : 0;
  const visibleEdgeStats = (report.edgeStats ?? []).filter(stat => stat.totalTrades > 0);
  const lines = [
    `📊 <b>Daily Report — ${dateLabel}</b>`,
    `- 체결 거래: ${report.totalTrades}건 (승 ${report.wins} / 패 ${report.losses})`,
    `- 실현 손익: ${formatSignedSol(report.pnl)} (${formatSignedPercent(pnlPct)})`,
    `- 승률: ${formatPercent(winRate)}`,
  ];

  if (report.bestTrade) {
    lines.push(
      `- 최고 거래: <code>${escapeHtml(shortenAddress(report.bestTrade.pair))}</code> ` +
      `${formatSignedSol(report.bestTrade.pnl)} (Score ${report.bestTrade.score} / ${escapeHtml(report.bestTrade.grade)})`
    );
  }

  if (report.worstTrade) {
    lines.push(
      `- 최저 거래: <code>${escapeHtml(shortenAddress(report.worstTrade.pair))}</code> ` +
      `${formatSignedSol(report.worstTrade.pnl)} (Score ${report.worstTrade.score} / ${escapeHtml(report.worstTrade.grade)})`
    );
  }

  lines.push(
    '',
    '시그널 처리',
    `- 감지 ${report.signalsDetected}건 -> 실행 ${report.signalsExecuted}건 / 제외 ${report.signalsFiltered}건`,
    '',
    '리스크 상태',
    `- 일일 손실 사용률: ${formatPercent(report.dailyLossUsed)} / ${formatPercent(report.dailyLossLimit)} (${describeDailyLoss(report.dailyLossUsed, report.dailyLossLimit)})`,
    `- 연속 손실: ${report.consecutiveLosses}회`,
    `- 가동 시간: ${formatDuration(report.uptime)} | 재시작 ${report.restarts}회`,
  );

  if (report.realtimeAdmission) {
    lines.push(
      '',
      '실시간 Admission',
      `- 추적 풀: ${report.realtimeAdmission.trackedPools}개 | 허용 ${report.realtimeAdmission.allowedPools}개 | 차단 ${report.realtimeAdmission.blockedPools}개`,
      '- 차단 기준: obs 50+ / parse < 1.0% / skipped >= 90.0%',
    );

    for (const blocked of report.realtimeAdmission.blockedDetails) {
      lines.push(
        `- <code>${escapeHtml(shortenAddress(blocked.pool))}</code> ` +
        `parse ${formatPercent(blocked.parseRatePct / 100)} / ` +
        `skip ${formatPercent(blocked.skippedRatePct / 100)} / ` +
        `obs ${blocked.observedNotifications}`
      );
    }
  }

  if (report.cadence) {
    lines.push(
      '',
      'Cadence',
      `- 최근 시그널: ${formatCadenceAge(report.cadence.timeSinceLastSignalMs, report.cadence.lastSignalAt)}`,
      `- 최근 진입: ${formatCadenceAge(report.cadence.timeSinceLastTradeMs, report.cadence.lastTradeAt)}`,
      `- 최근 종료: ${formatCadenceAge(report.cadence.timeSinceLastClosedTradeMs, report.cadence.lastClosedTradeAt)}`,
    );

    for (const window of report.cadence.windows) {
      lines.push(
        `- 최근 ${window.hours}h: signal ${window.detectedSignals} / 실행 ${window.executedSignals} / 제외 ${window.filteredSignals} / 진입 ${window.trades} / 종료 ${window.closedTrades}`
      );
    }

    const cadenceWarnings = buildCadenceWarnings(report.cadence);
    if (cadenceWarnings.length > 0) {
      lines.push('- cadence 경고: ' + cadenceWarnings.join(', '));
    }
  }

  if (report.rejectionMix) {
    lines.push(
      '',
      `Data Plane (${report.rejectionMix.hours}h)`,
      `- 최근 캔들: ${formatCadenceAge(report.rejectionMix.timeSinceLastCandleMs, report.rejectionMix.lastCandleAt)}`,
      `- realtime-ready ratio: ${report.rejectionMix.realtimeCandidateReadiness.ready}/` +
      `${report.rejectionMix.realtimeCandidateReadiness.totalCandidates} ` +
      `(${formatPercent(report.rejectionMix.realtimeCandidateReadiness.readinessRate)})`,
    );

    appendCountSection(lines, 'gate reject (unique token)', report.rejectionMix.gateFilterReasonCounts, 'reason');
    appendLabelCountSection(lines, 'pre-watchlist reject', report.rejectionMix.preWatchlistRejectDetailCounts);
    appendCountSection(lines, 'realtime skip', report.rejectionMix.admissionSkipCounts, 'reason');
    appendLabelCountSection(lines, 'realtime skip detail', report.rejectionMix.admissionSkipDetailCounts);
    appendLabelCountSection(lines, 'capacity', report.rejectionMix.capacityCounts);
    appendCountSection(lines, '429', report.rejectionMix.rateLimitCounts, 'source');
    appendCountSection(lines, 'poll failure', report.rejectionMix.pollFailureCounts, 'source');

    const rejectionWarnings = buildRejectionWarnings(report.rejectionMix);
    if (rejectionWarnings.length > 0) {
      lines.push('- data-plane 경고: ' + rejectionWarnings.join(', '));
    }
  }

  if (visibleEdgeStats.length > 0) {
    lines.push('', '전략 상태');
    for (const stat of visibleEdgeStats) {
      lines.push(
        `- ${escapeHtml(formatStrategy(stat.strategy))}: ${escapeHtml(formatEdgeState(stat.edgeState))} | ` +
        `승률 ${formatPercent(stat.winRate)} | 손익비 ${formatRewardRisk(stat.rewardRisk)} | ` +
        `Sharpe ${stat.sharpeRatio.toFixed(2)} | 최대 연속 손실 ${stat.maxConsecutiveLosses} | ` +
        `Kelly ${stat.kellyEligible ? formatPercent(stat.kellyFraction) : '잠금'}`
      );
    }
  }

  const visibleSourceOutcomes = (report.sourceOutcomes ?? []).filter(stat => stat.totalTrades > 0);
  if (visibleSourceOutcomes.length > 0) {
    lines.push('', '소스 성과');
    for (const stat of visibleSourceOutcomes.slice(0, 5)) {
      lines.push(
        `- ${escapeHtml(stat.sourceLabel)}: ${stat.totalTrades}건 | ` +
        `승률 ${formatPercent(stat.winRate)} | 손익 ${formatSignedSol(stat.pnl)}`
      );
    }
  }

  return lines.join('\n');
}

function describeDailyLoss(used: number, limit: number): string {
  if (limit <= 0) return '한도 없음';
  const usage = used / limit;
  if (usage >= 1) return '한도 초과';
  if (usage >= 0.7) return '주의 구간';
  return '여유 있음';
}

function formatCadenceAge(ageMs?: number, iso?: string): string {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || !iso) {
    return 'never';
  }
  return `${formatDuration(ageMs)} 전 (${iso})`;
}

function buildCadenceWarnings(cadence: DailyCadenceSummary): string[] {
  const warnings: string[] = [];
  if (typeof cadence.timeSinceLastTradeMs === 'number' && cadence.timeSinceLastTradeMs >= 12 * 3_600_000) {
    warnings.push('12h no entry');
  }
  if (
    typeof cadence.timeSinceLastClosedTradeMs !== 'number' ||
    cadence.timeSinceLastClosedTradeMs >= 24 * 3_600_000
  ) {
    warnings.push('24h no closed trade');
  }
  return warnings;
}

function appendCountSection<TKey extends 'reason' | 'source'>(
  lines: string[],
  label: string,
  items: Array<{ count: number } & Record<TKey, string>>,
  key: TKey
): void {
  if (items.length === 0) {
    lines.push(`- ${label}: none`);
    return;
  }
  const top = items
    .slice(0, 5)
    .map((item) => `${item[key]}=${item.count}`)
    .join(', ');
  lines.push(`- ${label}: ${escapeHtml(top)}`);
}

function buildRejectionWarnings(summary: DailyRejectionMixSummary): string[] {
  const warnings: string[] = [];
  if (
    typeof summary.timeSinceLastCandleMs !== 'number' ||
    summary.timeSinceLastCandleMs >= 10 * 60 * 1000
  ) {
    warnings.push('no candle >= 10m');
  }
  if (summary.rateLimitCounts.reduce((sum, item) => sum + item.count, 0) > 0) {
    warnings.push('429 observed');
  }
  if (
    summary.realtimeCandidateReadiness.totalCandidates > 0 &&
    summary.realtimeCandidateReadiness.readinessRate < 0.7
  ) {
    warnings.push('low realtime-ready ratio');
  }
  return warnings;
}

function appendLabelCountSection(
  lines: string[],
  label: string,
  items: Array<{ label: string; count: number }>
): void {
  if (items.length === 0) {
    lines.push(`- ${label}: none`);
    return;
  }
  const top = items
    .slice(0, 5)
    .map((item) => `${item.label}=${item.count}`)
    .join(', ');
  lines.push(`- ${label}: ${escapeHtml(top)}`);
}
