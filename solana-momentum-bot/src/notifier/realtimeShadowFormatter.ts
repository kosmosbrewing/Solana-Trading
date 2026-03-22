import { RealtimeShadowReport } from '../reporting';
import {
  escapeHtml,
  formatPercent,
  formatSignedPercent,
  shortenAddress,
} from './messageFormatter';

export function buildRealtimeShadowSummaryMessage(report: RealtimeShadowReport): string {
  const lines: string[] = [
    `📡 <b>Realtime Shadow Report</b>`,
    `- Dataset: <code>${escapeHtml(shortenPath(report.datasetDir))}</code>`,
    `- Samples: swaps ${report.counts.swaps} / candles ${report.counts.candles} / signals ${report.counts.signals}`,
    `- Horizon ${report.horizonSec}s: avg ${formatSignedPercent(report.summary.avgAdjustedReturnPct)} | ` +
      `MFE ${formatSignedPercent(report.summary.avgMfePct)} | MAE ${formatSignedPercent(report.summary.avgMaePct)}`,
    `- Decision: ${escapeHtml(report.summary.assessment.decision)} | Edge ${report.summary.assessment.edgeScore.toFixed(1)} | Gate ${escapeHtml(report.summary.assessment.gateStatus)}`,
    `- Execution: executed ${report.summary.executedSignals} / gateRejected ${report.summary.gateRejectedSignals}`,
    `- Gate latency: avg ${report.summary.avgGateLatencyMs.toFixed(1)}ms / p95 ${report.summary.p95GateLatencyMs.toFixed(1)}ms`,
  ];

  if (report.statusCounts.length > 0) {
    lines.push('', '<b>Status</b>');
    for (const entry of report.statusCounts.slice(0, 5)) {
      lines.push(`- ${escapeHtml(entry.status)}: ${entry.count}`);
    }
  }

  if (report.reasonCounts.length > 0) {
    lines.push('', '<b>Filter Reasons</b>');
    for (const entry of report.reasonCounts.slice(0, 3)) {
      lines.push(`- ${escapeHtml(entry.reason)}: ${entry.count}`);
    }
  }

  if (report.latestSignal) {
    lines.push(
      '',
      '<b>Latest Signal</b>',
      `- <code>${escapeHtml(shortenAddress(report.latestSignal.pairAddress))}</code> ` +
        `${escapeHtml(report.latestSignal.status)} ` +
        `${report.latestSignal.adjustedReturnPct != null ? `(${formatSignedPercent(report.latestSignal.adjustedReturnPct)})` : ''}`,
    );
    if (report.latestSignal.filterReason) {
      lines.push(`- 이유: ${escapeHtml(report.latestSignal.filterReason)}`);
    }
  }

  if (report.admission) {
    lines.push(
      '',
      '<b>Realtime Admission</b>',
      `- tracked ${report.admission.trackedPools} / allowed ${report.admission.allowedPools} / blocked ${report.admission.blockedPools}`,
    );
    for (const blocked of report.admission.blockedDetails.slice(0, 3)) {
      lines.push(
        `- <code>${escapeHtml(shortenAddress(blocked.pool))}</code> ` +
          `parse ${formatPercent(blocked.parseRatePct / 100)} / ` +
          `skip ${formatPercent(blocked.skippedRatePct / 100)} / ` +
          `obs ${blocked.observedNotifications}`
      );
    }
  }

  return lines.join('\n');
}

function shortenPath(value: string): string {
  return value.length <= 48 ? value : `...${value.slice(-45)}`;
}
