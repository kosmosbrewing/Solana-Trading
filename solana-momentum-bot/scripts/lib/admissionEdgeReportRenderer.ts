import {
  type AdmissionEdgeReport,
  type CohortAdmissionEdge,
} from './admissionEdgeTypes';

function fmtPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function fmtRate(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function renderCohortRow(cohort: CohortAdmissionEdge): string {
  return [
    cohort.cohort,
    cohort.verdict,
    String(cohort.coverageRows),
    fmtPct(cohort.baseline.median),
    fmtRate(cohort.baseline.ge50Rate),
    fmtRate(cohort.baseline.leNeg20Rate),
    String(cohort.passRows),
    fmtPct(cohort.confirmPassAnchorToTarget.median),
    fmtPct(cohort.confirmFailAnchorToTarget.median),
    fmtPct(cohort.delayedEntryPassToTarget.median),
    fmtPct(cohort.holdIfConfirmElseCut.median),
    cohort.reasons.join('; '),
  ].join(' | ');
}

export function renderAdmissionEdgeReport(report: AdmissionEdgeReport): string {
  const lines: string[] = [];
  lines.push('# Admission Edge Report');
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- verdict: ${report.verdict}`);
  lines.push(`- realtimeDir: ${report.realtimeDir}`);
  lines.push(`- confirm horizon: T+${report.confirmHorizonSec}s >= ${fmtPct(report.confirmThresholdPct)}`);
  lines.push(`- target horizon: T+${report.targetHorizonSec}s`);
  lines.push(`- carry horizon: T+${report.carryHorizonSec}s`);
  lines.push(`- round-trip cost assumption: ${fmtPct(report.roundTripCostPct)}`);
  lines.push(`- buy anchors: ${report.buyAnchors}/${report.anchorRows}`);
  lines.push(`- markout candidates: ${report.candidates} (ok buy markout rows=${report.okBuyMarkoutRows}/${report.markoutRows})`);
  lines.push('');
  lines.push('## Reasons');
  if (report.reasons.length === 0) lines.push('- none');
  else for (const reason of report.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('## Cohorts');
  lines.push('| cohort | verdict | covered | base median | base +50% | base <=-20% | pass rows | pass anchor->target median | fail anchor->target median | delayed pass->target median | hold-if-confirm-else-cut median | reasons |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const cohort of report.cohorts) lines.push(`| ${renderCohortRow(cohort)} |`);
  lines.push('');
  lines.push('## Interpretation');
  lines.push('- Report-only. This does not change live entry, exit, or ticket sizing.');
  lines.push('- `pass anchor->target` can contain lookahead if used as a delayed buy rule.');
  lines.push('- `delayed pass->target` estimates entering only after the confirmation horizon; if negative, confirmation should not be promoted as a fresh full-entry signal.');
  lines.push('- `hold-if-confirm-else-cut` estimates probe-first behavior: enter at anchor, keep confirmed probes to target, cut unconfirmed probes at confirmation horizon.');
  lines.push('- Live promotion still requires wallet-truth execution, route, sell-liquidity, and cost evidence.');
  return lines.join('\n');
}
