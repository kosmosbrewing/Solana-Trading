import { StrategyEdgeStats } from '../reporting';
import {
  escapeHtml,
  formatDuration,
  formatEdgeState,
  formatPercent,
  formatRewardRisk,
  formatSignedPercent,
  formatSignedSol,
  formatStrategy,
  shortenAddress,
} from './messageFormatter';

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
  realtimeAdmission?: RealtimeAdmissionSummary;
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

  return lines.join('\n');
}

function describeDailyLoss(used: number, limit: number): string {
  if (limit <= 0) return '한도 없음';
  const usage = used / limit;
  if (usage >= 1) return '한도 초과';
  if (usage >= 0.7) return '주의 구간';
  return '여유 있음';
}
