import {
  type ProbePolicyShadowReport,
  type ProbePolicyShadowStats,
} from './probePolicyShadowTypes';

function fmtPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function fmtSol(value: number | null): string {
  return value == null ? 'n/a' : value.toFixed(6);
}

function statsRow(label: string, stats: ProbePolicyShadowStats): string {
  return [
    label,
    String(stats.rows),
    fmtPct(stats.medianNetPct),
    fmtSol(stats.medianNetSol),
    fmtPct(stats.positiveRate),
    fmtPct(stats.bigLossRate),
    fmtPct(stats.tail50Rate),
    fmtPct(stats.fiveXRate),
  ].join(' | ');
}

export function renderProbePolicyShadowReport(report: ProbePolicyShadowReport): string {
  const lines: string[] = [];
  lines.push('# Probe Policy Shadow Report');
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- verdict: ${report.verdict}`);
  lines.push(`- since: ${report.since}`);
  lines.push(`- probe arm: ${report.probeArm}`);
  lines.push(`- parent arm: ${report.parentArm}`);
  lines.push(`- parent arms: ${report.parentArms.join(', ')}`);
  lines.push(`- paper rows: ${report.paperRows}`);
  lines.push(`- probe closes: ${report.probeRows}`);
  lines.push(`- paired closes: ${report.pairedRows}/${report.minCloses}`);
  lines.push('');
  lines.push('## Reasons');
  for (const reason of report.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('## Parent vs Probe');
  lines.push('');
  lines.push('| cohort | rows | median net | median SOL | positive | <=-20% | +50% tail | 5x |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  lines.push(`| ${statsRow('parent paired', report.comparison.parent)} |`);
  lines.push(`| ${statsRow('probe paired', report.comparison.probe)} |`);
  lines.push('');
  lines.push('## Delta');
  lines.push('');
  lines.push(`- median improvement: ${fmtPct(report.comparison.medianImprovement)}`);
  lines.push(`- <=-20% big-loss reduction: ${fmtPct(report.comparison.bigLossReduction)}`);
  lines.push(`- +50% tail kill delta: ${fmtPct(report.comparison.tailKillDelta)}`);
  lines.push('');
  lines.push('## Probe Funnel');
  lines.push('');
  lines.push(`- parent closes: ${report.funnel.parentRows}`);
  lines.push(`- KOL_3plus parent closes: ${report.funnel.eligibleParentRows}`);
  lines.push(`- KOL_3plus paired probe closes: ${report.funnel.eligiblePairedRows}`);
  lines.push(`- KOL_3plus parent closes without probe: ${report.funnel.eligibleParentWithoutProbeRows}`);
  lines.push(`- below-min parent/probe closes: ${report.funnel.belowMinParentRows}/${report.funnel.belowMinProbeRows}`);
  lines.push(`- unknown parent/probe KOL closes: ${report.funnel.unknownParentRows}/${report.funnel.unknownProbeRows}`);
  lines.push(`- all pair coverage: ${fmtPct(report.funnel.allPairCoverage)}`);
  lines.push(`- KOL_3plus pair coverage: ${fmtPct(report.funnel.eligiblePairCoverage)}`);
  for (const reason of report.funnel.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('## Confirm-Fail Winner-Kill Audit');
  lines.push('');
  lines.push(`- close reason: ${report.winnerKillAudit.closeReason}`);
  lines.push(`- target offset: T+${report.winnerKillAudit.targetOffsetSec}s`);
  lines.push(`- 5x threshold: ${fmtPct(report.winnerKillAudit.thresholdMfe)}`);
  lines.push(`- cut closes: ${report.winnerKillAudit.cutRows}`);
  lines.push(`- observed target closes: ${report.winnerKillAudit.observedTargetRows}`);
  lines.push(`- observation coverage: ${fmtPct(report.winnerKillAudit.observationCoverage)}`);
  lines.push(`- winner-kill closes: ${report.winnerKillAudit.winnerKillRows}`);
  lines.push(`- winner-kill rate: ${fmtPct(report.winnerKillAudit.winnerKillRate)}`);
  if (report.winnerKillAudit.examples.length > 0) {
    for (const example of report.winnerKillAudit.examples) {
      lines.push(`- ${example.positionId} mint=${example.tokenMint.slice(0, 12)} postMfe=${fmtPct(example.postMfe)}`);
    }
  }
  lines.push('');
  lines.push('## Cohorts');
  lines.push('');
  lines.push('| cohort | pairs | parent median | probe median | median delta | big-loss reduction | +50% tail kill delta |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  if (report.cohorts.length === 0) lines.push('| none | 0 | n/a | n/a | n/a | n/a | n/a |');
  else {
    for (const cohort of report.cohorts) {
      lines.push([
        `| ${cohort.cohort}`,
        String(cohort.pairedRows),
        fmtPct(cohort.parent.medianNetPct),
        fmtPct(cohort.probe.medianNetPct),
        fmtPct(cohort.medianImprovement),
        fmtPct(cohort.bigLossReduction),
        `${fmtPct(cohort.tailKillDelta)} |`,
      ].join(' | '));
    }
  }
  lines.push('');
  lines.push('## KOL_3plus Quality Splits');
  lines.push('');
  lines.push('| cohort | rows | pairs | median net | positive | <=-20% | 5x | top exits |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---|');
  if (report.qualitySplits.length === 0) lines.push('| none | 0 | 0 | n/a | n/a | n/a | n/a | n/a |');
  else {
    for (const split of report.qualitySplits) {
      const exits = split.exitReasons.map((row) => `${row.reason}:${row.count}`).join(', ') || 'n/a';
      lines.push([
        `| ${split.cohort}`,
        String(split.stats.rows),
        String(split.pairedRows),
        fmtPct(split.stats.medianNetPct),
        fmtPct(split.stats.positiveRate),
        fmtPct(split.stats.bigLossRate),
        fmtPct(split.stats.fiveXRate),
        `${exits} |`,
      ].join(' | '));
    }
  }
  lines.push('');
  lines.push('## Probe Exit Reasons');
  if (report.exitReasons.length === 0) lines.push('- none');
  else for (const row of report.exitReasons) lines.push(`- ${row.reason}: ${row.count}`);
  lines.push('');
  lines.push('## Promotion Gate');
  lines.push(`- forward paper minimum closes: ${report.promotionGate.forwardPaperMinCloses}`);
  lines.push(`- target cohort: ${report.promotionGate.targetCohort}`);
  lines.push(`- target paired closes: ${report.promotionGate.targetPairedCloses}`);
  lines.push(`- next action: ${report.promotionGate.nextAction}`);
  lines.push(`- live promotion allowed: ${report.promotionGate.livePromotionAllowed}`);
  lines.push(`- requires separate wallet-truth review: ${report.promotionGate.requiresSeparateReview}`);
  lines.push('');
  lines.push('| check | status | current | required |');
  lines.push('|---|---|---:|---:|');
  for (const check of report.promotionGate.checks) {
    lines.push(`| ${check.name} | ${check.status} | ${check.current} | ${check.required} |`);
  }
  lines.push('- This report can only move the arm to review, never directly to live.');
  return lines.join('\n');
}
