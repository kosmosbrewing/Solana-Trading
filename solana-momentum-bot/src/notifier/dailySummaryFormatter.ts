import { SourceOutcomeStats, StrategyEdgeStats } from '../reporting';
import {
  formatStrategy,
} from './messageFormatter';
import {
  escapeHtml,
  formatDuration,
  formatKstDateTimeLabel,
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
  aliasMissCounts: Array<{ pool: string; count: number }>;
  candidateEvictedCount: number;
  candidateReaddedWithinGraceCount: number;
  signalNotInWatchlistCount: number;
  signalNotInWatchlistRecentlyEvictedCount: number;
  missedTokens: Array<{
    tokenMint: string;
    evicted: number;
    readded: number;
    notInWatchlist: number;
    recentlyEvicted: number;
    admissionBlocked: number;
  }>;
  capacityCounts: Array<{ label: string; count: number }>;
  triggerStatsCounts: Array<{ label: string; count: number }>;
  latestTriggerStats?: { source: string; detail: string };
  bootstrapBoostedSignalCount: number;
  preWatchlistRejectCounts: Array<{ reason: string; count: number }>;
  preWatchlistRejectDetailCounts: Array<{ label: string; count: number }>;
  rateLimitCounts: Array<{ source: string; count: number }>;
  pollFailureCounts: Array<{ source: string; count: number }>;
  riskRejectionCounts: Array<{ reason: string; count: number }>;
  realtimeCandidateReadiness: {
    totalCandidates: number;
    prefiltered: number;
    admissionSkipped: number;
    ready: number;
    readinessRate: number;
  };
}

export interface CostSummary {
  tradeCount: number;
  avgEntrySlippageBps: number;
  avgExitSlippageBps: number;
  avgRoundTripCostPct: number;
  avgEffectiveRR: number;
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
  explainedEntryRatio?: {
    total: number;
    explained: number;
    ratio: number;
  };
  costSummary?: CostSummary;
  todayUtcOps?: {
    capSuppressedPairs: number;
    capSuppressedCandles: number;
  };
  realtimeAdmission?: RealtimeAdmissionSummary;
  cadence?: DailyCadenceSummary;
  rejectionMix?: DailyRejectionMixSummary;
  strategyTelemetry?: Array<{
    strategy: string;
    action: string;
    count: number;
    topReasons: Array<{ reason: string; count: number }>;
  }>;
  exitReasonBreakdown?: Array<{
    strategy: string;
    exitReason: string;
    count: number;
    avgPnl: number;
  }>;
}

export function buildDailySummaryMessage(report: DailySummaryReport, dateLabel: string): string {
  const winRate = report.totalTrades > 0 ? (report.wins / report.totalTrades) : 0;
  const pnlPct = report.portfolioValue > 0 ? (report.pnl / report.portfolioValue) : 0;
  const visibleEdgeStats = (report.edgeStats ?? []).filter(stat => stat.totalTrades > 0);
  const lines = [
    `📊 <b>일간 요약 — ${dateLabel} KST</b>`,
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
    '신호 흐름',
    `- 감지 ${report.signalsDetected}건 | 실행 ${report.signalsExecuted}건 | 제외 ${report.signalsFiltered}건`,
    '',
    '운영 상태',
    `- 일일 손실 사용률: ${formatPercent(report.dailyLossUsed)} / ${formatPercent(report.dailyLossLimit)} (${describeDailyLoss(report.dailyLossUsed, report.dailyLossLimit)})`,
    `- 연속 손실: ${report.consecutiveLosses}회`,
    `- 가동 시간: ${formatDuration(report.uptime)} | 재시작 ${report.restarts}회`,
  );

  if (report.costSummary && report.costSummary.tradeCount > 0) {
    const cs = report.costSummary;
    lines.push(
      '',
      '체결 비용',
      `- 대상: ${cs.tradeCount}건`,
      `- 평균 진입 슬리피지: ${cs.avgEntrySlippageBps.toFixed(0)}bps / 청산 슬리피지: ${cs.avgExitSlippageBps.toFixed(0)}bps`,
      `- 평균 왕복 비용: ${formatPercent(cs.avgRoundTripCostPct)} / 실효 R:R: ${cs.avgEffectiveRR.toFixed(2)}`,
    );
  }

  if (report.realtimeAdmission) {
    lines.push(
      '',
      '실시간 수집 상태',
      `- 추적 풀: ${report.realtimeAdmission.trackedPools}개 | 허용 ${report.realtimeAdmission.allowedPools}개 | 차단 ${report.realtimeAdmission.blockedPools}개`,
      '- 차단 기준: 알림 50+ / 파싱률 < 1.0% / skip >= 90.0%',
    );

    for (const blocked of report.realtimeAdmission.blockedDetails) {
      lines.push(
        `- <code>${escapeHtml(shortenAddress(blocked.pool))}</code> ` +
        `파싱 ${formatPercent(blocked.parseRatePct / 100)} / ` +
        `skip ${formatPercent(blocked.skippedRatePct / 100)} / ` +
        `알림 ${blocked.observedNotifications}`
      );
    }
  }

  if (report.cadence) {
    lines.push(
      '',
      '최근 흐름',
      `- 최근 시그널: ${formatCadenceAge(report.cadence.timeSinceLastSignalMs, report.cadence.lastSignalAt)}`,
      `- 최근 진입: ${formatCadenceAge(report.cadence.timeSinceLastTradeMs, report.cadence.lastTradeAt)}`,
      `- 최근 종료: ${formatCadenceAge(report.cadence.timeSinceLastClosedTradeMs, report.cadence.lastClosedTradeAt)}`,
    );

    for (const window of report.cadence.windows) {
      lines.push(
        `- 최근 ${window.hours}h: 신호 ${window.detectedSignals} / 실행 ${window.executedSignals} / 제외 ${window.filteredSignals} / 진입 ${window.trades} / 종료 ${window.closedTrades}`
      );
    }

    const cadenceWarnings = buildCadenceWarnings(report.cadence);
    if (cadenceWarnings.length > 0) {
      lines.push('- 흐름 경고: ' + cadenceWarnings.join(', '));
    }
  }

  if (report.rejectionMix) {
    lines.push(
      '',
      `데이터 상태 (${report.rejectionMix.hours}h)`,
      `- 최근 캔들: ${formatCadenceAge(report.rejectionMix.timeSinceLastCandleMs, report.rejectionMix.lastCandleAt)}`,
      `- 실시간 준비율: ${report.rejectionMix.realtimeCandidateReadiness.ready}/` +
      `${report.rejectionMix.realtimeCandidateReadiness.totalCandidates} ` +
      `(${formatPercent(report.rejectionMix.realtimeCandidateReadiness.readinessRate)})`,
    );

    appendReadableReasonSection(lines, '게이트 제외(토큰 기준)', report.rejectionMix.gateFilterReasonCounts);
    appendReadableReasonSection(lines, '워치리스트 전 제외', report.rejectionMix.preWatchlistRejectCounts);
    appendReadableReasonSection(lines, '실시간 스킵', report.rejectionMix.admissionSkipCounts);
    appendReadableReasonSection(lines, '리스크 제외', report.rejectionMix.riskRejectionCounts);
    appendAliasMissSection(lines, report.rejectionMix.aliasMissCounts);
    appendWatchlistLifecycleSection(lines, report.rejectionMix);
    appendMissedTokensSection(lines, report.rejectionMix.missedTokens);
    appendBootstrapBoostSection(lines, report.rejectionMix.bootstrapBoostedSignalCount);
    appendCountSection(lines, '429 제한', report.rejectionMix.rateLimitCounts, 'source');
    appendCountSection(lines, '폴링 실패', report.rejectionMix.pollFailureCounts, 'source');

    const rejectionWarnings = buildRejectionWarnings(report.rejectionMix);
    if (rejectionWarnings.length > 0) {
      lines.push('- 데이터 경고: ' + rejectionWarnings.join(', '));
    }

    appendEngineeringDetailSection(lines, report.rejectionMix);
  }

  if (report.todayUtcOps && report.todayUtcOps.capSuppressedCandles > 0) {
    lines.push(
      '',
      '운영 보정(UTC)',
      `- eval 억제: ${report.todayUtcOps.capSuppressedPairs} pairs / ${report.todayUtcOps.capSuppressedCandles} candles skipped`
    );
  }

  if (report.strategyTelemetry && report.strategyTelemetry.length > 0) {
    appendStrategyTelemetrySection(lines, report.strategyTelemetry);
  }

  if (report.exitReasonBreakdown && report.exitReasonBreakdown.length > 0) {
    appendExitReasonSection(lines, report.exitReasonBreakdown);
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

  if (report.explainedEntryRatio && report.explainedEntryRatio.total > 0) {
    const er = report.explainedEntryRatio;
    const pct = formatPercent(er.ratio);
    const icon = er.ratio >= 0.9 ? '✅' : '⚠';
    lines.push(`- 진입 근거 기록률: ${er.explained}/${er.total} (${pct}) ${icon} 목표 ≥90%`);
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
  return `${formatDuration(ageMs)} 전 (${formatKstDateTimeLabel(iso)})`;
}

function buildCadenceWarnings(cadence: DailyCadenceSummary): string[] {
  const warnings: string[] = [];
  if (typeof cadence.timeSinceLastTradeMs === 'number' && cadence.timeSinceLastTradeMs >= 12 * 3_600_000) {
    warnings.push('12h 진입 없음');
  }
  if (
    typeof cadence.timeSinceLastClosedTradeMs !== 'number' ||
    cadence.timeSinceLastClosedTradeMs >= 24 * 3_600_000
  ) {
    warnings.push('24h 종료 없음');
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
    lines.push(`- ${label}: 없음`);
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
    warnings.push('캔들 업데이트 10분 이상 없음');
  }
  if (summary.rateLimitCounts.reduce((sum, item) => sum + item.count, 0) > 0) {
    warnings.push('429 발생');
  }
  if (
    summary.realtimeCandidateReadiness.totalCandidates > 0 &&
    summary.realtimeCandidateReadiness.readinessRate < 0.7
  ) {
    warnings.push('실시간 준비율 낮음');
  }
  if (summary.preWatchlistRejectCounts.some((item) => item.reason === 'operator_blacklist' && item.count > 0)) {
    warnings.push('운영자 블랙리스트 적중');
  }
  if (summary.signalNotInWatchlistRecentlyEvictedCount > 0) {
    warnings.push(`최근 축출 신호 ${summary.signalNotInWatchlistRecentlyEvictedCount}건`);
  }
  if (summary.admissionSkipDetailCounts.some((item) => item.label.includes('all_pairs_blocked'))) {
    warnings.push('all_pairs_blocked 발생');
  }
  return warnings;
}

function appendLabelCountSection(
  lines: string[],
  label: string,
  items: Array<{ label: string; count: number }>
): void {
  if (items.length === 0) {
    lines.push(`- ${label}: 없음`);
    return;
  }
  const top = items
    .slice(0, 5)
    .map((item) => `${item.label}=${item.count}`)
    .join(', ');
  lines.push(`- ${label}: ${escapeHtml(top)}`);
}

function appendAliasMissSection(
  lines: string[],
  items: Array<{ pool: string; count: number }>
): void {
  const total = items.reduce((sum, item) => sum + item.count, 0);
  if (total === 0) {
    lines.push('- alias miss: 0건');
    return;
  }
  const top = items
    .slice(0, 3)
    .map((item) => `${shortenAddress(item.pool)} ${item.count}건`)
    .join(', ');
  lines.push(`- alias miss: 총 ${total}건 (${escapeHtml(top)})`);
}

// Why: trigger_stats는 최신 1건의 detail만 보여주면 충분 (누적 카운터 스냅샷)
function appendTriggerStatsSection(
  lines: string[],
  latest?: { source: string; detail: string }
): void {
  if (!latest) {
    lines.push('- 트리거 통계: 없음');
    return;
  }
  lines.push(`- 트리거 통계 (${escapeHtml(latest.source)}): ${escapeHtml(latest.detail)}`);
}

function appendWatchlistLifecycleSection(
  lines: string[],
  summary: DailyRejectionMixSummary
): void {
  lines.push(
    '- 워치리스트 변동: ' +
    `축출 ${summary.candidateEvictedCount}건 | ` +
    `재편입 ${summary.candidateReaddedWithinGraceCount}건 | ` +
    `목록 밖 신호 ${summary.signalNotInWatchlistCount}건` +
    ` (최근 축출 ${summary.signalNotInWatchlistRecentlyEvictedCount}건)`
  );
}

function appendMissedTokensSection(
  lines: string[],
  missedTokens: DailyRejectionMixSummary['missedTokens']
): void {
  if (missedTokens.length === 0) {
    return;
  }

  lines.push('- 놓친 토큰 (상위 3개):');
  for (const token of missedTokens.slice(0, 3)) {
    lines.push(
      `- <code>${escapeHtml(shortenAddress(token.tokenMint))}</code> ` +
      `축출 ${token.evicted} / 재편입 ${token.readded} / 목록 밖 ${token.notInWatchlist}` +
      (token.recentlyEvicted > 0 ? ` / 최근 축출 ${token.recentlyEvicted}` : '') +
      (token.admissionBlocked > 0 ? ` / 수집 차단 ${token.admissionBlocked}` : '')
    );
  }
}

function appendStrategyTelemetrySection(
  lines: string[],
  items: NonNullable<DailySummaryReport['strategyTelemetry']>
): void {
  // Group by strategy
  const byStrategy = new Map<string, Array<{ action: string; count: number; topReasons: Array<{ reason: string; count: number }> }>>();
  for (const item of items) {
    let arr = byStrategy.get(item.strategy);
    if (!arr) { arr = []; byStrategy.set(item.strategy, arr); }
    arr.push(item);
  }

  lines.push('', '전략별 흐름 (24h)');
  for (const [strategy, entries] of byStrategy) {
    const executed = entries.find(e => e.action === 'EXECUTED')?.count ?? 0;
    const filtered = entries.find(e => e.action === 'FILTERED')?.count ?? 0;
    const total = entries.reduce((s, e) => s + e.count, 0);
    lines.push(`- ${escapeHtml(strategy)}: total=${total} exec=${executed} filtered=${filtered}`);

    // Show top 3 filter reasons for this strategy
    const filteredEntry = entries.find(e => e.action === 'FILTERED');
    if (filteredEntry && filteredEntry.topReasons.length > 0) {
      const top = filteredEntry.topReasons.slice(0, 3)
        .map(r => `${r.reason}=${r.count}`)
        .join(', ');
      lines.push(`- 주요 제외 사유: ${escapeHtml(top)}`);
    }
  }
}

function appendExitReasonSection(
  lines: string[],
  items: NonNullable<DailySummaryReport['exitReasonBreakdown']>
): void {
  // Group by strategy
  const byStrategy = new Map<string, Array<{ exitReason: string; count: number; avgPnl: number }>>();
  for (const item of items) {
    let arr = byStrategy.get(item.strategy);
    if (!arr) { arr = []; byStrategy.set(item.strategy, arr); }
    arr.push(item);
  }

  lines.push('', '종료 사유 분포 (24h)');
  for (const [strategy, reasons] of byStrategy) {
    const total = reasons.reduce((s, r) => s + r.count, 0);
    const detail = reasons.slice(0, 4)
      .map(r => `${r.exitReason}=${r.count}(${formatSignedSol(r.avgPnl)})`)
      .join(', ');
    lines.push(`- ${escapeHtml(strategy)} (${total}): ${escapeHtml(detail)}`);
  }
}

function appendBootstrapBoostSection(lines: string[], boostedSignalCount: number): void {
  lines.push(`- 부스트 신호: ${boostedSignalCount}건 (누적)`);
}

function appendReadableReasonSection(
  lines: string[],
  label: string,
  items: Array<{ reason: string; count: number }>
): void {
  if (items.length === 0) {
    lines.push(`- ${label}: 없음`);
    return;
  }
  const top = items
    .slice(0, 5)
    .map((item) => `${translateDiagnosticReason(item.reason)} ${item.count}건`)
    .join(', ');
  lines.push(`- ${label}: ${escapeHtml(top)}`);
}

function appendEngineeringDetailSection(
  lines: string[],
  summary: DailyRejectionMixSummary
): void {
  const detailLines: string[] = [];
  appendLabelCountSection(detailLines, '워치리스트 전 제외(raw)', summary.preWatchlistRejectDetailCounts);
  appendLabelCountSection(detailLines, '실시간 스킵 상세(raw)', summary.admissionSkipDetailCounts);
  appendLabelCountSection(detailLines, '용량 제한(raw)', summary.capacityCounts);
  appendTriggerStatsSection(detailLines, summary.latestTriggerStats);
  if (detailLines.length === 0) return;

  lines.push('', '엔지니어링 상세');
  lines.push(...detailLines);
}

function translateDiagnosticReason(reason: string): string {
  if (reason.startsWith('quote_rejected')) return '호가 품질 부족';
  if (reason.startsWith('security_rejected')) return '보안 게이트 차단';
  if (reason === 'unsupported_pool_program') return '미지원 풀 프로그램';
  if (reason === 'unsupported_dex') return '미지원 DEX';
  if (reason === 'operator_blacklist') return '운영자 블랙리스트';
  if (reason === 'same_pair_open_position_block') return '동일 종목 포지션 중복';
  if (reason === 'max_concurrent_position_limit') return '동시 포지션 한도';
  if (reason === 'daily_loss_limit') return '일일 손실 한도';
  return reason;
}
