import {
  type LiveBleedExitBucket,
  type MissionEntryCohort,
  type MissionEntryReport,
  type PaperShadowArmSummary,
  type RotationDoaVetoSkipReasonSummary,
} from './missionEntryReportTypes';

function fmtPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function fmtRate(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function fmtSol(value: number | null): string {
  return value == null ? 'n/a' : value.toFixed(6);
}

function fmtNum(value: number | null): string {
  return value == null ? 'n/a' : String(value);
}

function medianAt(cohort: MissionEntryCohort, horizonSec: number): number | null {
  return cohort.horizons.find((item) => item.horizonSec === horizonSec)?.stats.median ?? null;
}

function rowsAt(cohort: MissionEntryCohort, horizonSec: number): number {
  return cohort.horizons.find((item) => item.horizonSec === horizonSec)?.stats.rows ?? 0;
}

function cohortRow(cohort: MissionEntryCohort): string {
  return [
    cohort.cohort,
    cohort.verdict,
    String(cohort.sourceRows),
    String(rowsAt(cohort, 300)),
    fmtPct(medianAt(cohort, 30)),
    fmtPct(medianAt(cohort, 60)),
    fmtPct(medianAt(cohort, 300)),
    fmtPct(medianAt(cohort, 1800)),
    fmtPct(cohort.decay30To300),
    fmtPct(cohort.decay300To1800),
    cohort.reasons.join('; '),
  ].join(' | ');
}

function bucketRow(bucket: LiveBleedExitBucket): string {
  return [
    bucket.exitReason,
    String(bucket.rows),
    fmtSol(bucket.netSol),
    fmtRate(bucket.winRate),
    fmtPct(bucket.medianMfePct),
    fmtNum(bucket.medianHoldSec),
  ].join(' | ');
}

function shadowRow(shadow: PaperShadowArmSummary): string {
  return [
    shadow.armName,
    String(shadow.rows),
    fmtSol(shadow.netSol),
    fmtRate(shadow.winRate),
    fmtPct(shadow.medianNetPct),
    fmtPct(shadow.medianMfePct),
    fmtNum(shadow.medianHoldSec),
  ].join(' | ');
}

function skipReasonRow(reason: RotationDoaVetoSkipReasonSummary): string {
  return [
    reason.reason,
    String(reason.count),
  ].join(' | ');
}

export function renderMissionEntryReport(report: MissionEntryReport): string {
  const lines: string[] = [];
  lines.push('# Mission Entry Report');
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- verdict: ${report.verdict}`);
  lines.push(`- realtimeDir: ${report.realtimeDir}`);
  lines.push(`- horizons: ${report.horizonsSec.map((horizon) => `T+${horizon}s`).join(', ')}`);
  lines.push(`- round-trip cost assumption: ${fmtPct(report.roundTripCostPct)}`);
  lines.push(`- min rows: ${report.minRows}`);
  lines.push(`- buy anchors: ${report.buyAnchors}/${report.anchorRows}`);
  lines.push(`- markout candidates: ${report.candidates} (ok buy markout rows=${report.okBuyMarkoutRows}/${report.markoutRows})`);
  lines.push('');
  lines.push('## Root Cause Reasons');
  for (const reason of report.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('## Entry Path Cohorts');
  lines.push('| cohort | verdict | source rows | T+300 rows | T+30 median | T+60 median | T+300 median | T+1800 median | decay 30->300 | decay 300->1800 | reasons |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const cohort of report.cohorts) lines.push(`| ${cohortRow(cohort)} |`);
  lines.push('');
  lines.push('## Live Bleed Buckets');
  lines.push(`- live closed rows: ${report.liveBleed.liveRows}`);
  lines.push(`- live net SOL: ${fmtSol(report.liveBleed.liveNetSol)}`);
  lines.push(`- bleed rows/net/share: ${report.liveBleed.bleedRows} / ${fmtSol(report.liveBleed.bleedNetSol)} / ${fmtRate(report.liveBleed.bleedNetShare)}`);
  lines.push('');
  lines.push('| exit reason | rows | net SOL | win rate | median MFE | median hold sec |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  if (report.liveBleed.buckets.length === 0) lines.push('| none | 0 | 0.000000 | n/a | n/a | n/a |');
  else for (const bucket of report.liveBleed.buckets) lines.push(`| ${bucketRow(bucket)} |`);
  lines.push('');
  lines.push('## Paper Shadow Arms');
  lines.push('| arm | rows | net SOL | win rate | median net | median MFE | median hold sec |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  if (report.paperShadows.length === 0) lines.push('| none | 0 | 0.000000 | n/a | n/a | n/a | n/a |');
  else for (const shadow of report.paperShadows) lines.push(`| ${shadowRow(shadow)} |`);
  lines.push('');
  lines.push('## Rotation DOA Veto Coverage');
  lines.push(`- verdict: ${report.rotationDoaVetoCoverage.verdict}`);
  lines.push(`- parent/shadow/paired: ${report.rotationDoaVetoCoverage.parentRows} / ${report.rotationDoaVetoCoverage.shadowRows} / ${report.rotationDoaVetoCoverage.pairedRows}`);
  lines.push(`- skips raw/unique: ${report.rotationDoaVetoCoverage.rawSkipRows} / ${report.rotationDoaVetoCoverage.uniqueSkipRows}`);
  lines.push(`- attributed coverage: ${fmtRate(report.rotationDoaVetoCoverage.attributedCoverage)}`);
  lines.push(`- unattributed parent rows: ${report.rotationDoaVetoCoverage.unattributedParentRows}`);
  lines.push(`- parent/shadow net SOL: ${fmtSol(report.rotationDoaVetoCoverage.parentNetSol)} / ${fmtSol(report.rotationDoaVetoCoverage.shadowNetSol)}`);
  lines.push(`- paired parent/shadow/delta SOL: ${fmtSol(report.rotationDoaVetoCoverage.pairedParentNetSol)} / ${fmtSol(report.rotationDoaVetoCoverage.pairedShadowNetSol)} / ${fmtSol(report.rotationDoaVetoCoverage.pairedNetDeltaSol)}`);
  lines.push('');
  lines.push('Reasons:');
  for (const reason of report.rotationDoaVetoCoverage.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('| skip reason | unique candidates |');
  lines.push('|---|---:|');
  if (report.rotationDoaVetoCoverage.skipReasons.length === 0) lines.push('| none | 0 |');
  else for (const reason of report.rotationDoaVetoCoverage.skipReasons) lines.push(`| ${skipReasonRow(reason)} |`);
  lines.push('');
  lines.push('## Next Actions');
  for (const action of report.nextActions) lines.push(`- ${action}`);
  lines.push('');
  lines.push('## Guardrails');
  lines.push('- Report-only. This does not change live entry, exit, ticket sizing, or wallet behavior.');
  lines.push('- Live promotion is blocked until paper shadow closes are forward-collected and mirror/live coverage is sufficient.');
  lines.push('- Markout path is a trajectory diagnostic. Wallet-truth live closes remain the highest authority.');
  return lines.join('\n');
}
