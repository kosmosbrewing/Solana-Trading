import type {
  AdmissionVetoRow,
  AdmissionVetoCombinationRow,
  ApiCostSummaryRow,
  ApiCostActionRow,
  DataFileSummary,
  FinalDecisionRow,
  JoinMethod,
  MissionOfflineSimulatorReport,
  RoleSummary,
  RotationCandidateCohortSummary,
} from './missionOfflineSimulatorTypes';

function fmtSol(value: number | null): string {
  return value == null ? 'n/a' : value.toFixed(6);
}

function fmtPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function fileRow(row: DataFileSummary): string {
  // rawRows/dedupRows 는 trade ledger 에만 존재한다 (positionId dedup 대상이 아닌
  // markout/credit 파일은 n/a). audit 이 이중 계상 여부를 표에서 바로 검증하게 한다.
  const rawRows = row.rawRows == null ? 'n/a' : String(row.rawRows);
  const dedupRows = row.dedupRows == null ? 'n/a' : String(row.dedupRows);
  return `${row.file} | ${row.rows} | ${rawRows} | ${dedupRows}`;
}

function roleRow(row: RoleSummary): string {
  return `${row.role} | ${row.rows} | ${fmtSol(row.netSol)}`;
}

function vetoRow(row: AdmissionVetoRow): string {
  return [
    row.reason,
    String(row.rows),
    fmtSol(row.removedNetSol),
    fmtSol(row.savedLossSol),
    String(row.missedRunner50Count),
    String(row.missedRunner5xCount),
    fmtPct(row.falseNegativeRate),
    fmtSol(row.netAfterVetoSol),
  ].join(' | ');
}

function vetoCombinationRow(row: AdmissionVetoCombinationRow): string {
  return [
    row.reason,
    String(row.rows),
    fmtSol(row.savedLossSol),
    String(row.missedRunner5xCount),
    fmtSol(row.netAfterVetoSol),
    String(row.maxLossStreakAfterVeto),
    row.decision,
    row.decisionReasons.join('; '),
  ].join(' | ');
}

function rotationCandidateRow(row: RotationCandidateCohortSummary): string {
  return [
    row.cohort,
    row.decision,
    String(row.rows),
    String(row.activeDays),
    fmtSol(row.walletStressNetSol),
    fmtPct(row.postCostPositiveRatio),
    String(row.maxLossStreak),
    fmtPct(row.executionPlanHashCoveragePct),
    fmtPct(row.routeProofCoveragePct),
    fmtPct(row.comparableRoleCoveragePct),
    String(row.failedChronologicalSlices),
    row.leakageVerdict,
    row.reasons.join('; '),
  ].join(' | ');
}

function costRow(row: ApiCostSummaryRow): string {
  return `${row.key} | ${row.credits} | ${row.requests} | ${row.rows}`;
}

function apiActionRow(row: ApiCostActionRow): string {
  return `${row.feature} | ${row.decision} | ${row.action} | ${row.credits} | ${fmtPct(row.sharePct)} | ${row.reason}`;
}

function decisionRow(row: FinalDecisionRow): string {
  return `${row.cohort} | ${row.decision} | ${row.reasons.join('; ')}`;
}

function joinMethodRow(method: JoinMethod, count: number): string {
  return `${method} | ${count}`;
}

export function renderMissionOfflineSimulatorReport(report: MissionOfflineSimulatorReport): string {
  const lines: string[] = [];
  lines.push('# Mission Offline Simulator');
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- protocol: ${report.protocol}`);
  lines.push(`- realtimeDir: ${report.realtimeDir}`);
  lines.push(`- reportsDir: ${report.reportsDir}`);
  lines.push('');
  lines.push('## Data Files');
  lines.push('| file | rows | raw rows | dedup rows |');
  lines.push('|---|---:|---:|---:|');
  for (const row of report.dataFiles) lines.push(`| ${fileRow(row)} |`);
  const dedupFiles = report.dataFiles.filter((row) => row.rawRows != null && row.dedupRows != null);
  const rawTotal = dedupFiles.reduce((total, row) => total + (row.rawRows ?? 0), 0);
  const dedupTotal = dedupFiles.reduce((total, row) => total + (row.dedupRows ?? 0), 0);
  lines.push('');
  lines.push('### Dedup');
  lines.push('- positionId dedup keeps aggregate ledger rows (kol-live/kol-paper); projection ledgers only add positionIds missing from the aggregate.');
  lines.push(`- trade ledger rows raw/dedup: ${rawTotal} / ${dedupTotal} (duplicates removed: ${rawTotal - dedupTotal})`);
  lines.push('');
  lines.push('## Baseline Replay');
  lines.push(`- live rows/net: ${report.baseline.liveRows} / ${fmtSol(report.baseline.liveNetSol)}`);
  lines.push(`- paper rows/net: ${report.baseline.paperRows} / ${fmtSol(report.baseline.paperNetSol)}`);
  lines.push(`- win rate: ${fmtPct(report.baseline.winRate)}`);
  lines.push(`- max drawdown SOL: ${fmtSol(report.baseline.maxDrawdownSol)}`);
  lines.push(`- max loss streak: ${report.baseline.maxLossStreak}`);
  lines.push(`- top5/top10 winner share: ${fmtPct(report.baseline.top5WinnerShare)} / ${fmtPct(report.baseline.top10WinnerShare)}`);
  lines.push('');
  lines.push('### Role Net');
  lines.push('| role | rows | net SOL |');
  lines.push('|---|---:|---:|');
  for (const row of report.baseline.roleSummaries) lines.push(`| ${roleRow(row)} |`);
  lines.push('');
  lines.push('### Join Coverage');
  lines.push(`- join coverage: ${fmtPct(report.baseline.joinSummary.joinCoveragePct)}`);
  lines.push(`- promotion-grade join coverage: ${fmtPct(report.baseline.joinSummary.promotionGradeJoinCoveragePct)}`);
  lines.push('| method | rows |');
  lines.push('|---|---:|');
  for (const [method, count] of Object.entries(report.baseline.joinSummary.joinMethodCounts) as Array<[JoinMethod, number]>) {
    lines.push(`| ${joinMethodRow(method, count)} |`);
  }
  lines.push('');
  lines.push('## Admission Veto Simulation');
  lines.push('| reason | rows | removed net | saved loss | missed 50% MFE | missed 5x MFE | false negative | live net after veto |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  if (report.admissionVeto.length === 0) lines.push('| none | 0 | 0.000000 | 0.000000 | 0 | 0 | n/a | 0.000000 |');
  else for (const row of report.admissionVeto) lines.push(`| ${vetoRow(row)} |`);
  lines.push('');
  lines.push('### Veto Combination Search');
  lines.push('| combination | rows | saved loss | missed 5x MFE | live net after veto | max loss streak after veto | decision | reasons |');
  lines.push('|---|---:|---:|---:|---:|---:|---|---|');
  if (report.admissionVetoCombinations.length === 0) lines.push('| none | 0 | 0.000000 | 0 | 0.000000 | 0 | COLLECT_OFFLINE | no matching rows |');
  else for (const row of report.admissionVetoCombinations) lines.push(`| ${vetoCombinationRow(row)} |`);
  lines.push('');
  lines.push('## Probe-First Simulation');
  lines.push(`- rows: ${report.probeFirst.rows}`);
  lines.push(`- baseline T+300 median: ${fmtPct(report.probeFirst.baselineMedianT300Pct)}`);
  lines.push(`- simulated median: ${fmtPct(report.probeFirst.simulatedMedianPct)}`);
  lines.push(`- baseline/simulated positive rate: ${fmtPct(report.probeFirst.baselinePositiveRate)} / ${fmtPct(report.probeFirst.simulatedPositiveRate)}`);
  lines.push(`- fail15/pass30 rows: ${report.probeFirst.fail15Rows} / ${report.probeFirst.pass30Rows}`);
  lines.push(`- leakage verdict: ${report.probeFirst.leakageVerdict}`);
  lines.push('');
  lines.push('## Rotation Bridge');
  lines.push(`- decision: ${report.rotationBridge.decision}`);
  lines.push(`- rows/activeDays: ${report.rotationBridge.rows} / ${report.rotationBridge.activeDays}`);
  lines.push(`- refund/wallet-stress net: ${fmtSol(report.rotationBridge.refundAdjustedNetSol)} / ${fmtSol(report.rotationBridge.walletStressNetSol)}`);
  lines.push(`- post-cost positive ratio: ${fmtPct(report.rotationBridge.postCostPositiveRatio)}`);
  lines.push(`- max loss streak: ${report.rotationBridge.maxLossStreak}`);
  lines.push(`- top5/top10 winner share: ${fmtPct(report.rotationBridge.top5WinnerShare)} / ${fmtPct(report.rotationBridge.top10WinnerShare)}`);
  lines.push(`- executionPlanHash coverage: ${fmtPct(report.rotationBridge.executionPlanHashCoveragePct)}`);
  lines.push(`- route/cost-aware/comparable-role coverage: ${fmtPct(report.rotationBridge.routeProofCoveragePct)} / ${fmtPct(report.rotationBridge.costAwareCoveragePct)} / ${fmtPct(report.rotationBridge.comparableRoleCoveragePct)}`);
  lines.push(`- stress source: ${report.rotationBridge.stressSource}`);
  lines.push('Reasons:');
  for (const reason of report.rotationBridge.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('### Rotation Chronological Slices');
  lines.push('| slice | verdict | rows | active days | start | end | wallet-stress net | positive ratio | max loss streak | reasons |');
  lines.push('|---|---|---:|---:|---|---|---:|---:|---:|---|');
  if (report.rotationBridge.chronologicalSlices.length === 0) lines.push('| none | DATA_GAP | 0 | 0 | n/a | n/a | 0.000000 | n/a | 0 | no rows |');
  else {
    for (const slice of report.rotationBridge.chronologicalSlices) {
      lines.push(`| ${slice.slice} | ${slice.verdict} | ${slice.rows} | ${slice.activeDays} | ${slice.start} | ${slice.end} | ${fmtSol(slice.walletStressNetSol)} | ${fmtPct(slice.postCostPositiveRatio)} | ${slice.maxLossStreak} | ${slice.reasons.join('; ')} |`);
    }
  }
  lines.push('');
  lines.push('### Rotation Candidate Cohorts');
  lines.push('| cohort | decision | rows | active days | wallet-stress net | positive ratio | max loss streak | plan hash cov | route cov | comparable role cov | failed slices | leakage | reasons |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|');
  if (report.rotationBridge.candidateCohorts.length === 0) lines.push('| none | COLLECT_OFFLINE | 0 | 0 | 0.000000 | n/a | 0 | n/a | n/a | n/a | 0 | PASS | no rows |');
  else for (const row of report.rotationBridge.candidateCohorts) lines.push(`| ${rotationCandidateRow(row)} |`);
  lines.push('');
  lines.push('## Smart-v3 Quarantine');
  lines.push(`- decision: ${report.smartV3.decision}`);
  lines.push(`- rows/liveRows/net: ${report.smartV3.rows} / ${report.smartV3.liveRows} / ${fmtSol(report.smartV3.netSol)}`);
  lines.push(`- runner50/5x: ${report.smartV3.runner50Count} / ${report.smartV3.runner5xCount}`);
  lines.push(`- max loss streak: ${report.smartV3.maxLossStreak}`);
  lines.push(`- loss per 5x: ${fmtSol(report.smartV3.lossPer5xSol)}`);
  lines.push('Reasons:');
  for (const reason of report.smartV3.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('## API Cost-To-Edge');
  lines.push(`- decision: ${report.apiCost.decision}`);
  lines.push(`- rows/estimated credits: ${report.apiCost.rows} / ${report.apiCost.estimatedCredits}`);
  lines.push('Reasons:');
  for (const reason of report.apiCost.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('### By Feature');
  lines.push('| feature | credits | requests | rows |');
  lines.push('|---|---:|---:|---:|');
  for (const row of report.apiCost.byFeature) lines.push(`| ${costRow(row)} |`);
  lines.push('');
  lines.push('### By Purpose');
  lines.push('| purpose | credits | requests | rows |');
  lines.push('|---|---:|---:|---:|');
  for (const row of report.apiCost.byPurpose) lines.push(`| ${costRow(row)} |`);
  lines.push('');
  lines.push('### Paid Path Actions');
  lines.push('| feature | decision | action | credits | share | reason |');
  lines.push('|---|---|---|---:|---:|---|');
  if (report.apiCost.actions.length === 0) lines.push('| none | COLLECT_OFFLINE | keep_with_metering | 0 | n/a | no credit rows |');
  else for (const row of report.apiCost.actions) lines.push(`| ${apiActionRow(row)} |`);
  lines.push('');
  lines.push('## Micro-Canary Ruin Simulation');
  lines.push(`- decision: ${report.microCanary.decision}`);
  lines.push(`- source cohort: ${report.microCanary.sourceCohort}`);
  lines.push(`- rows/window/windows: ${report.microCanary.rows} / ${report.microCanary.windowSize} / ${report.microCanary.windows}`);
  lines.push(`- positive window rate: ${fmtPct(report.microCanary.positiveWindowRate)}`);
  lines.push(`- sleeve ruin rate: ${fmtPct(report.microCanary.sleeveRuinRate)}`);
  lines.push(`- expected/worst window net: ${fmtSol(report.microCanary.expectedWindowNetSol)} / ${fmtSol(report.microCanary.worstWindowNetSol)}`);
  lines.push('Reasons:');
  for (const reason of report.microCanary.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('## Final Decisions');
  lines.push('| cohort | decision | reasons |');
  lines.push('|---|---|---|');
  for (const row of report.finalDecisions) lines.push(`| ${decisionRow(row)} |`);
  lines.push('');
  lines.push('## Guardrails');
  lines.push('- Offline-only. No Helius calls and no live route changes.');
  lines.push('- Fuzzy token/time joins are diagnostic only and cannot promote live.');
  lines.push('- Unknown role is non-promotable.');
  lines.push('- Future-data leakage blocks promotion.');
  return lines.join('\n');
}
