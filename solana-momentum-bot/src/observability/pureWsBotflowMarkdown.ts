import type { BotflowReport } from './pureWsBotflowReport';

export function renderPureWsBotflowMarkdown(report: BotflowReport): string {
  const lines: string[] = ['# Pure WS Bot-Flow Report', '', `Generated: ${report.generatedAt}`, `Tracked address: \`${report.trackedAddress}\``, ''];
  lines.push(`Bot profile: \`${report.botProfile}\``, `Wallet role: \`${report.walletRole}\``, `Provenance: \`${report.provenanceConfidence}\``);
  if (report.feePayerFilter) lines.push(`Fee payer filter: \`${report.feePayerFilter}\``);
  if (report.mayhemAgentWallet) lines.push(`Mayhem agent wallet: \`${report.mayhemAgentWallet}\``);
  if (report.mayhemProgramId) lines.push(`Mayhem program id: \`${report.mayhemProgramId}\``);
  if (report.profileNotes.length > 0) lines.push(`Profile notes: ${report.profileNotes.join('; ')}`);
  lines.push('');
  lines.push('## Summary', '', '| metric | value |', '|---|---:|');
  lines.push(`| tx fetched | ${report.txFetched} |`);
  lines.push(`| parsed events | ${report.events} |`);
  lines.push(`| buys / sells | ${report.buyEvents} / ${report.sellEvents} |`);
  lines.push(`| buy / sell SOL | ${fmtSol(report.buySol)} / ${fmtSol(report.sellSol)} |`);
  lines.push(`| net flow SOL | ${fmtSol(report.netFlowSol)} |`);
  lines.push(`| unique mints | ${report.uniqueMints} |`);
  lines.push(`| unique sub-accounts | ${report.uniqueSubAccounts} |`);
  lines.push(`| observed / rejected candidates | ${report.observedCandidates} / ${report.rejectedCandidates} |`);
  lines.push(`| context known / missing candidates | ${report.contextKnownCandidates} / ${report.contextMissingCandidates} |`);
  lines.push(`| pair age known / fresh / stale | ${report.pairAgeKnownCandidates} / ${report.freshPairCandidates} / ${report.stalePairCandidates} |`);
  lines.push(`| pool prewarm success candidates | ${report.poolPrewarmSuccessCandidates} |`);
  lines.push(`| evidence verdict | ${report.phase0Verdict} |`, '');
  if (report.phase0Reasons.length > 0) {
    lines.push('Evidence blockers:');
    for (const reason of report.phase0Reasons) lines.push(`- ${reason}`);
    lines.push('');
  }
  lines.push('## Paper Simulation', '', '| metric | value |', '|---|---:|');
  lines.push(`| trades | ${report.paper.trades} |`);
  lines.push(`| resolved / unresolved | ${report.paper.resolvedTrades} / ${report.paper.unresolvedTrades} |`);
  lines.push(`| winners / losers | ${report.paper.winners} / ${report.paper.losers} |`);
  lines.push(`| win rate | ${fmtPct(report.paper.winRate)} |`);
  lines.push(`| simulated net SOL | ${fmtSol(report.paper.totalNetSol)} |`);
  lines.push(`| median post-cost | ${fmtPct(report.paper.medianPostCostDeltaPct)} |`);
  lines.push(`| avg hold sec | ${report.paper.avgHoldSec == null ? 'n/a' : report.paper.avgHoldSec.toFixed(1)} |`);
  lines.push(`| exit reasons | ${formatReasonCounts(report.paper.byExitReason)} |`, '');
  lines.push('## Markouts', '', '| horizon | rows | ok | post-cost > 0 | median delta | p25 post-cost | median post-cost |');
  lines.push('|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of report.byHorizon) {
    lines.push(
      `| T+${row.horizonSec}s | ${row.rows} | ${row.okRows} | ${row.positivePostCostRows} | ` +
      `${fmtPct(row.medianDeltaPct)} | ${fmtPct(row.p25PostCostDeltaPct)} | ${fmtPct(row.medianPostCostDeltaPct)} |`
    );
  }
  lines.push('', '## Cohorts', '', '| cohort | candidates | observed | resolved paper | paper net SOL | median post-cost |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const row of report.byCohort) {
    lines.push(
      `| ${row.cohort} | ${row.candidates} | ${row.observedCandidates} | ${row.resolvedPaperTrades} | ` +
      `${fmtSol(row.paperNetSol)} | ${fmtPct(row.medianPostCostDeltaPct)} |`
    );
  }
  lines.push('', '## Top Candidates', '', '| token | window | dex | pair age | buys | sells | buy SOL | sell SOL | net SOL | flags | decision | reason |');
  lines.push('|---|---:|---|---:|---:|---:|---:|---:|---:|---|---|---|');
  for (const row of report.topCandidates) {
    lines.push(
      `| \`${short(row.tokenMint)}\` | ${row.windowSec}s | ${row.dexId ?? ''} | ${fmtSec(row.pairAgeSec)} | ` +
      `${row.buyCount} | ${row.sellCount} | ${fmtSol(row.buySol)} | ${fmtSol(row.sellSol)} | ${fmtSol(row.netFlowSol)} | ` +
      `${formatFlags(row.qualityFlags)} | ${row.decision} | ${row.rejectReason ?? ''} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function fmtSol(value: number): string {
  return value.toFixed(4);
}

function fmtPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function formatReasonCounts(counts: Record<string, number>): string {
  return Object.entries(counts).map(([key, value]) => `${key}:${value}`).join(', ') || 'n/a';
}

function fmtSec(value: number | undefined): string {
  return value == null ? 'n/a' : value.toFixed(1);
}

function formatFlags(flags: string[]): string {
  if (flags.length === 0) return '';
  return flags.slice(0, 3).join(',');
}

function short(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}
