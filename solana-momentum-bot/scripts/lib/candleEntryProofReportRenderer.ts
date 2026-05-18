import type {
  CandleCoverageGroupSummary,
  CandleEntryProofReport,
  CandleProofArmEvaluation,
  CandleProofFoldSummary,
} from './candleEntryProofTypes';

function fmtPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function fmtNum(value: number | null): string {
  return value == null ? 'n/a' : value.toFixed(4);
}

function armRow(row: CandleProofArmEvaluation): string {
  return [
    `| ${row.arm}`,
    row.role,
    row.verdict,
    String(row.rows),
    String(row.activeDays),
    String(row.parentRows),
    String(row.blockedRows),
    fmtPct(row.stats.median),
    fmtPct(row.parentStats.median),
    fmtPct(row.medianDeltaVsParent),
    fmtPct(row.stats.leNeg20Rate),
    fmtPct(row.lose20ReductionVsParent),
    String(row.maxLossStreak),
    fmtPct(row.top5WinnerShare),
    fmtPct(row.winnerLeakage12Rate),
    `${row.reasons.join('; ') || 'n/a'} |`,
  ].join(' | ');
}

function foldRow(row: CandleProofFoldSummary): string {
  return [
    `| ${row.fold}`,
    row.arm,
    row.role,
    row.verdict,
    String(row.rows),
    String(row.activeDays),
    fmtPct(row.stats.median),
    fmtPct(row.stats.leNeg20Rate),
    String(row.maxLossStreak),
    fmtPct(row.top5WinnerShare),
    '|',
  ].join(' | ');
}

function coverageGroupRow(row: CandleCoverageGroupSummary): string {
  const reasons = row.topReasons
    .map((reason) => `${reason.reason} ${reason.count}(${fmtPct(reason.share)})`)
    .join('; ');
  return [
    `| ${row.groupBy}`,
    row.group,
    String(row.anchors),
    String(row.pre60),
    String(row.outcome300),
    String(row.fullCoverage),
    fmtPct(row.fullCoverageRate),
    `${reasons || 'n/a'} |`,
  ].join(' | ');
}

export function renderCandleEntryProofReport(report: CandleEntryProofReport): string {
  const lines: string[] = [];
  lines.push('# Candle Entry Proof Report');
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- verdict: ${report.verdict}`);
  lines.push(`- realtimeDir: ${report.realtimeDir}`);
  lines.push(`- sessionsDir: ${report.sessionsDir}`);
  lines.push(`- horizons: ${report.horizonsSec.map((h) => `T+${h}s`).join(', ')}`);
  lines.push(`- pre windows: ${report.preWindowsSec.map((h) => `${h}s`).join(', ')}`);
  lines.push(`- round-trip cost assumption: ${fmtPct(report.roundTripCostPct)}`);
  lines.push('');
  lines.push('## Coverage');
  lines.push('');
  lines.push(`- trade-markout anchor rows: ${report.anchorRows}`);
  lines.push(`- buy anchors with usable price: ${report.buyAnchors}`);
  lines.push(`- candle files scanned: ${report.candleFiles}`);
  lines.push(`- candle rows scanned: ${report.candleRowsScanned}`);
  lines.push(`- anchors with pre60 candles: ${report.anchorsWithPre60}`);
  lines.push(`- anchors with candle T+300 outcome: ${report.anchorsWithOutcome300}`);
  lines.push(`- anchors with full pre60 + T+300 coverage: ${report.anchorsWithFullCoverage}`);
  lines.push(`- direct candle coverage: ${fmtPct(report.directCoverage)}`);
  lines.push(`- full candle coverage: ${fmtPct(report.fullCoverage)}`);
  lines.push('');
  lines.push('### Coverage Reasons');
  lines.push('');
  lines.push('| groupBy | group | anchors | pre60 | T+300 | full | full rate | top reasons |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---|');
  for (const row of report.coverageGroups.filter((group) => group.groupBy !== 'source').slice(0, 30)) {
    lines.push(coverageGroupRow(row));
  }
  const sourceGroups = report.coverageGroups
    .filter((group) => group.groupBy === 'source')
    .slice(0, 10);
  for (const row of sourceGroups) lines.push(coverageGroupRow(row));
  lines.push('');
  lines.push('## Arm Evaluations');
  lines.push('');
  lines.push('> Report-only. These are paper-only hypotheses for reducing admission bleed. Delayed full entry is intentionally excluded.');
  lines.push('');
  lines.push('| arm | role | verdict | rows | days | parent | blocked | median | parent median | median delta | <=-20 | <=-20 reduction | max loss streak | top5 winner share | winner leakage >=12 | reasons |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const row of report.evaluations) lines.push(armRow(row));
  lines.push('');
  lines.push('## Fold Summary');
  lines.push('');
  lines.push('| fold | arm | role | verdict | rows | days | median | <=-20 | max loss streak | top5 winner share |');
  lines.push('|---|---|---|---|---:|---:|---:|---:|---:|---:|');
  for (const row of report.folds) lines.push(foldRow(row));
  lines.push('');
  lines.push('## Reentry Cluster Sample');
  lines.push('');
  lines.push('| token | day | attempts | fail30 | sum T+300 | best | worst | window |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---|');
  for (const row of report.reentryClusters.slice(0, 20)) {
    lines.push([
      `| ${row.tokenMint.slice(0, 8)}...`,
      row.day,
      String(row.attempts),
      String(row.fail30Attempts),
      fmtNum(row.sumReturn300),
      fmtNum(row.bestReturn300),
      fmtNum(row.worstReturn300),
      `${row.clusterStartAt} -> ${row.clusterEndAt} |`,
    ].join(' | '));
  }
  if (report.reentryClusters.length === 0) lines.push('_No repeated same-token rotation clusters found._');
  lines.push('');
  lines.push('## Reasons');
  for (const reason of report.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('## Next Actions');
  for (const action of report.nextActions) lines.push(`- ${action}`);
  lines.push('');
  lines.push('## Guardrails');
  lines.push('- This report does not change live entry, exit, ticket sizing, or wallet behavior.');
  lines.push('- Treat CANDIDATE as paper-only evidence until forward paper, mirror, and wallet-truth checks pass.');
  lines.push('- Veto-trigger rows prove risk only if later-winner leakage remains low in forward data.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}
