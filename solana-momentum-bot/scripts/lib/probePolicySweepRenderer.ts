import {
  type ProbePolicyResult,
  type ProbePolicySweepReport,
} from './probePolicySweepTypes';

function fmtPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function fmtRate(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function renderPolicyRow(result: ProbePolicyResult): string {
  return [
    result.cohort,
    result.verdict,
    `T+${result.confirmHorizonSec}s`,
    fmtPct(result.confirmThresholdPct),
    `T+${result.targetHorizonSec}s`,
    String(result.coveredRows),
    String(result.passRows),
    fmtPct(result.baseline.median),
    fmtPct(result.probeHoldCut.median),
    fmtPct(result.medianLossReduction),
    fmtRate(result.loser20Reduction),
    fmtRate(result.tailKillDelta),
    fmtPct(result.delayedEntryPassToTarget.median),
    result.reasons.join('; '),
  ].join(' | ');
}

function renderPolicyTable(title: string, results: ProbePolicyResult[]): string[] {
  const lines = [`## ${title}`, ''];
  if (results.length === 0) {
    lines.push('- no eligible policies');
    lines.push('');
    return lines;
  }
  lines.push('| cohort | verdict | confirm | threshold | target | covered | pass | base median | probe median | loss reduction | <=-20 reduction | tail kill delta | delayed entry median | reasons |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const result of results) lines.push(`| ${renderPolicyRow(result)} |`);
  lines.push('');
  return lines;
}

export function renderProbePolicySweepReport(report: ProbePolicySweepReport): string {
  const lines: string[] = [];
  lines.push('# Probe Policy Sweep Report');
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- verdict: ${report.verdict}`);
  lines.push(`- realtimeDir: ${report.realtimeDir}`);
  lines.push(`- confirm horizons: ${report.confirmHorizonsSec.map((value) => `T+${value}s`).join(', ')}`);
  lines.push(`- confirm thresholds: ${report.confirmThresholdsPct.map(fmtPct).join(', ')}`);
  lines.push(`- target horizons: ${report.targetHorizonsSec.map((value) => `T+${value}s`).join(', ')}`);
  lines.push(`- round-trip cost assumption: ${fmtPct(report.roundTripCostPct)}`);
  lines.push(`- candidate rule: median loss reduction >= ${fmtPct(report.minMedianLossReduction)}, tail kill delta <= ${fmtRate(report.maxTailKillRate)}, min rows ${report.minRows}`);
  lines.push(`- buy anchors: ${report.buyAnchors}/${report.anchorRows}`);
  lines.push(`- markout candidates: ${report.candidates} (ok buy markout rows=${report.okBuyMarkoutRows}/${report.markoutRows})`);
  lines.push('');
  lines.push('## Reasons');
  for (const reason of report.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push(...renderPolicyTable('Top Policies', report.topPolicies));
  lines.push(...renderPolicyTable('Best By Cohort', report.bestByCohort));
  lines.push(...renderPolicyTable('Forward Paper-Shadow Candidates', report.forwardShadowCandidates.slice(0, 20)));
  lines.push('## Promotion Gate');
  lines.push('');
  lines.push(`- status: ${report.promotionGate.status}`);
  lines.push(`- forward paper minimum closes: ${report.promotionGate.forwardPaperMinCloses}`);
  lines.push(`- live promotion minimum closes after forward paper: ${report.promotionGate.livePromotionMinCloses}`);
  lines.push(`- requires no tail-kill increase: ${report.promotionGate.requiresNoTailKillIncrease}`);
  lines.push(`- requires wallet-truth review: ${report.promotionGate.requiresWalletTruthReview}`);
  lines.push('- historical candidates may become forward paper-shadow candidates only; live entry/exit changes require a separate review after fresh closes.');
  lines.push('');
  lines.push('## Interpretation');
  lines.push('- Report-only. This does not change live entry, exit, ticket sizing, or paper execution.');
  lines.push('- `probe median` means enter at the original anchor, cut losers at the confirmation horizon, and hold confirmed probes to the target horizon.');
  lines.push('- `delayed entry median` is shown separately because entering only after confirmation can be a lookahead trap.');
  lines.push('- A candidate policy is still not live-ready; it only qualifies for forward paper-shadow verification.');
  return lines.join('\n');
}
