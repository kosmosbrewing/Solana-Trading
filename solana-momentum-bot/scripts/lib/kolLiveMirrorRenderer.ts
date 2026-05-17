import {
  type KolLiveMirrorPair,
  type KolLiveMirrorReport,
  type KolLiveMirrorStats,
} from './kolLiveMirrorTypes';

function fmtPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function fmtSol(value: number | null): string {
  return value == null ? 'n/a' : value.toFixed(6);
}

function fmtNum(value: number | null): string {
  return value == null ? 'n/a' : value.toFixed(1);
}

function statsRow(label: string, stats: KolLiveMirrorStats): string {
  return [
    label,
    String(stats.rows),
    fmtSol(stats.netSol),
    fmtSol(stats.medianNetSol),
    fmtPct(stats.medianNetPct),
    fmtPct(stats.positiveRate),
    fmtPct(stats.medianMfePct),
    fmtNum(stats.medianHoldSec),
  ].join(' | ');
}

function pairRow(pair: KolLiveMirrorPair): string {
  return [
    pair.classification,
    pair.livePositionId,
    pair.tokenMint?.slice(0, 8) ?? 'n/a',
    fmtSol(pair.liveNetSol),
    fmtSol(pair.mirrorNetSol),
    fmtSol(pair.deltaNetSol),
    fmtPct(pair.liveNetPct),
    fmtPct(pair.mirrorNetPct),
    pair.liveExitReason,
    pair.mirrorExitReason,
  ].join(' | ');
}

export function renderKolLiveMirrorReport(report: KolLiveMirrorReport): string {
  const lines: string[] = [];
  lines.push('# KOL Live Mirror Report');
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- verdict: ${report.verdict}`);
  lines.push(`- since: ${report.since}`);
  lines.push(`- live arm: ${report.liveArm}`);
  lines.push(`- mirror arm: ${report.mirrorArm}`);
  lines.push(`- paired closes: ${report.pairedRows}/${report.minPairs}`);
  lines.push(`- live closes: ${report.liveRows}`);
  lines.push(`- mirror closes: ${report.mirrorRows}`);
  lines.push(`- live without closed mirror: ${report.liveWithoutMirrorRows}`);
  lines.push(`- mirror without live parent close: ${report.unpairedMirrorRows}`);
  lines.push('');
  lines.push('## Reasons');
  for (const reason of report.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('## Live vs Mirror');
  lines.push('');
  lines.push('| cohort | rows | net SOL | median SOL | median net | positive | median MFE | median hold sec |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  lines.push(`| ${statsRow('live wallet', report.live)} |`);
  lines.push(`| ${statsRow('paper mirror token-only', report.mirror)} |`);
  lines.push('');
  lines.push('## Delta');
  lines.push('');
  lines.push(`- mirror - live median SOL: ${fmtSol(report.deltas.medianNetSol)}`);
  lines.push(`- mirror - live median net: ${fmtPct(report.deltas.medianNetPct)}`);
  lines.push(`- mirror - live positive rate: ${fmtPct(report.deltas.positiveRate)}`);
  lines.push('');
  lines.push('## Classification');
  lines.push('');
  lines.push('| class | count | rate |');
  lines.push('|---|---:|---:|');
  for (const [classification, count] of Object.entries(report.classifications)) {
    lines.push(`| ${classification} | ${count} | ${fmtPct(report.classificationRates[classification as keyof typeof report.classificationRates])} |`);
  }
  lines.push('');
  lines.push('## Top Execution Drags');
  lines.push('');
  lines.push('| class | live position | mint | live SOL | mirror SOL | delta SOL | live net | mirror net | live exit | mirror exit |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---|---|');
  if (report.topExecutionDrags.length === 0) lines.push('| none | - | - | - | - | - | - | - | - | - |');
  else for (const pair of report.topExecutionDrags) lines.push(`| ${pairRow(pair)} |`);
  lines.push('');
  lines.push('## Top Strategy Losses');
  lines.push('');
  lines.push('| class | live position | mint | live SOL | mirror SOL | delta SOL | live net | mirror net | live exit | mirror exit |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---|---|');
  if (report.topStrategyLosses.length === 0) lines.push('| none | - | - | - | - | - | - | - | - | - |');
  else for (const pair of report.topStrategyLosses) lines.push(`| ${pairRow(pair)} |`);
  lines.push('');
  lines.push('## Promotion Gate');
  lines.push(`- live promotion allowed: ${report.promotionGate.livePromotionAllowed}`);
  lines.push(`- requires separate wallet-truth review: ${report.promotionGate.requiresSeparateWalletTruthReview}`);
  lines.push('- This report explains cause; it does not promote live size by itself.');
  return lines.join('\n');
}
