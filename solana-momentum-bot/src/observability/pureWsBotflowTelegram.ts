import type { BotflowReport, HorizonSummary } from './pureWsBotflowReport';

export function renderPureWsBotflowTelegram(report: BotflowReport): string {
  const t15 = horizon(report, 15);
  const t30 = horizon(report, 30);
  const t60 = horizon(report, 60);
  const mayhem = cohortNet(report, ['mayhem_only', 'mayhem_organic', 'mayhem_kol_overlap', 'mayhem_organic_kol_overlap']);
  const nonMayhemFresh = cohortNet(report, ['non_mayhem_new_pair']);
  const nonMayhemUnknown = cohortNet(report, ['non_mayhem_unknown_or_stale']);
  return [
    'Pure WS paper',
    `profile: ${safe(report.botProfile)} | role ${safe(report.walletRole)}`,
    `verdict: ${safe(report.phase0Verdict)}`,
    `flow: tx ${report.txFetched} | events ${report.events} | mints ${report.uniqueMints}`,
    `candidates: observed/rejected ${report.observedCandidates}/${report.rejectedCandidates}`,
    `cohort: mayhem ${mayhem.resolved}/${fmtSol(mayhem.net)} | non-mayhem fresh ${nonMayhemFresh.resolved}/${fmtSol(nonMayhemFresh.net)} | stale ${nonMayhemUnknown.resolved}/${fmtSol(nonMayhemUnknown.net)}`,
    `context: known/missing ${report.contextKnownCandidates}/${report.contextMissingCandidates} | pairAge ${report.pairAgeKnownCandidates}`,
    `markout: ${markoutPart(t15)} | ${markoutPart(t30)} | ${markoutPart(t60)}`,
    `paper: resolved ${report.paper.resolvedTrades}/${report.paper.trades} | W/L ${report.paper.winners}/${report.paper.losers} | net ${fmtSol(report.paper.totalNetSol)} SOL`,
    `postCostDelta: median ${fmtPct(report.paper.medianPostCostDeltaPct)} | exits ${safe(reasonCounts(report.paper.byExitReason))}`,
    `blockers: ${safe(blockers(report.phase0Reasons))}`,
  ].join('\n');
}

function horizon(report: BotflowReport, horizonSec: number): HorizonSummary | undefined {
  return report.byHorizon.find((row) => row.horizonSec === horizonSec);
}

function cohortNet(report: BotflowReport, names: string[]): { resolved: number; net: number } {
  return report.byCohort
    .filter((row) => names.includes(row.cohort))
    .reduce((acc, row) => ({
      resolved: acc.resolved + row.resolvedPaperTrades,
      net: acc.net + row.paperNetSol,
    }), { resolved: 0, net: 0 });
}

function markoutPart(row: HorizonSummary | undefined): string {
  if (!row) return 'T+n/a';
  return `T+${row.horizonSec}s ok ${row.okRows}/${row.rows} pos ${row.positivePostCostRows} med ${fmtPct(row.medianPostCostDeltaPct)}`;
}

function blockers(reasons: string[]): string {
  if (reasons.length === 0) return 'none';
  const normalized = reasons.slice(0, 4).map((reason) => reason.replace(/</g, 'below').replace(/>/g, 'above'));
  const suffix = reasons.length > normalized.length ? `; +${reasons.length - normalized.length} more` : '';
  return `${normalized.join('; ')}${suffix}`;
}

function reasonCounts(counts: Record<string, number>): string {
  return Object.entries(counts).map(([key, value]) => `${key}:${value}`).join(', ') || 'n/a';
}

function fmtSol(value: number): string {
  return value.toFixed(4);
}

function fmtPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function safe(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
