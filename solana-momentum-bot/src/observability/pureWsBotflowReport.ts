import {
  type PureWsBotflowBotProfile,
  type PureWsBotflowCandidate,
  type PureWsBotflowEvent,
  type PureWsBotflowMarkout,
  type PureWsBotflowPaperTrade,
  type PureWsBotflowProvenanceConfidence,
  type PureWsBotflowWalletRole,
} from './pureWsBotflowTypes';
import {
  summarizePureWsBotflowCohorts,
  type PureWsBotflowCohortSummary,
} from './pureWsBotflowCohorts';

export { renderPureWsBotflowMarkdown } from './pureWsBotflowMarkdown';

export interface HorizonSummary {
  horizonSec: number;
  rows: number;
  okRows: number;
  positivePostCostRows: number;
  medianDeltaPct: number | null;
  p25PostCostDeltaPct: number | null;
  medianPostCostDeltaPct: number | null;
}

export interface BotflowReport {
  generatedAt: string;
  trackedAddress: string;
  feePayerFilter?: string;
  botProfile: PureWsBotflowBotProfile;
  walletRole: PureWsBotflowWalletRole;
  provenanceConfidence: PureWsBotflowProvenanceConfidence;
  mayhemAgentWallet?: string;
  mayhemProgramId?: string;
  profileNotes: string[];
  txFetched: number;
  events: number;
  candidates: number;
  observedCandidates: number;
  rejectedCandidates: number;
  buyEvents: number;
  sellEvents: number;
  buySol: number;
  sellSol: number;
  netFlowSol: number;
  uniqueMints: number;
  uniqueSubAccounts: number;
  contextKnownCandidates: number;
  contextMissingCandidates: number;
  pairAgeKnownCandidates: number;
  freshPairCandidates: number;
  stalePairCandidates: number;
  poolPrewarmSuccessCandidates: number;
  paper: PaperSummary;
  phase0Verdict: 'observe_only' | 'canary_candidate';
  phase0Reasons: string[];
  byHorizon: HorizonSummary[];
  byCohort: PureWsBotflowCohortSummary[];
  topCandidates: Array<{
    tokenMint: string;
    windowSec: number;
    buyCount: number;
    sellCount: number;
    buySol: number;
    sellSol: number;
    netFlowSol: number;
    dexId?: string;
    pairAgeSec?: number;
    knownPoolCount?: number;
    qualityFlags: string[];
    decision: string;
    rejectReason?: string;
  }>;
}

export interface PaperSummary {
  trades: number;
  resolvedTrades: number;
  unresolvedTrades: number;
  winners: number;
  losers: number;
  winRate: number | null;
  totalNetSol: number;
  medianPostCostDeltaPct: number | null;
  avgHoldSec: number | null;
  byExitReason: Record<string, number>;
}

export function buildPureWsBotflowReport(
  args: Pick<BotflowReport, 'trackedAddress' | 'botProfile' | 'walletRole' | 'provenanceConfidence'> & {
    feePayerFilter?: string;
    mayhemAgentWallet?: string;
    mayhemProgramId?: string;
    profileNotes?: string[];
    horizonsSec: number[];
  },
  txFetched: number,
  events: PureWsBotflowEvent[],
  candidates: PureWsBotflowCandidate[],
  markouts: PureWsBotflowMarkout[],
  paperTrades: PureWsBotflowPaperTrade[] = [],
): BotflowReport {
  const observed = candidates.filter((row) => row.decision === 'observe');
  const buys = events.filter((row) => row.side === 'buy');
  const sells = events.filter((row) => row.side === 'sell');
  const byHorizon = summarizeMarkouts(markouts, args.horizonsSec);
  const phase0Reasons = phase0Gate(candidates, byHorizon);
  return {
    generatedAt: new Date().toISOString(),
    trackedAddress: args.trackedAddress,
    feePayerFilter: args.feePayerFilter,
    botProfile: args.botProfile,
    walletRole: args.walletRole,
    provenanceConfidence: args.provenanceConfidence,
    mayhemAgentWallet: args.mayhemAgentWallet,
    mayhemProgramId: args.mayhemProgramId,
    profileNotes: args.profileNotes ?? [],
    txFetched,
    events: events.length,
    candidates: candidates.length,
    observedCandidates: observed.length,
    rejectedCandidates: candidates.length - observed.length,
    buyEvents: buys.length,
    sellEvents: sells.length,
    buySol: sum(buys.map((row) => row.solAmount)),
    sellSol: sum(sells.map((row) => row.solAmount)),
    netFlowSol: sum(buys.map((row) => row.solAmount)) - sum(sells.map((row) => row.solAmount)),
    uniqueMints: new Set(events.map((row) => row.tokenMint)).size,
    uniqueSubAccounts: new Set(events.map((row) => row.tradingUser)).size,
    contextKnownCandidates: candidates.filter((row) => !row.qualityFlags.includes('PAIR_CONTEXT_MISSING')).length,
    contextMissingCandidates: candidates.filter((row) => row.qualityFlags.includes('PAIR_CONTEXT_MISSING')).length,
    pairAgeKnownCandidates: candidates.filter((row) => typeof row.pairAgeSec === 'number').length,
    freshPairCandidates: candidates.filter((row) => typeof row.pairAgeSec === 'number' && row.pairAgeSec <= 180).length,
    stalePairCandidates: candidates.filter((row) => typeof row.pairAgeSec === 'number' && row.pairAgeSec > 180).length,
    poolPrewarmSuccessCandidates: candidates.filter((row) => row.poolPrewarmSuccess === true).length,
    paper: summarizePaper(paperTrades),
    phase0Verdict: phase0Reasons.length === 0 ? 'canary_candidate' : 'observe_only',
    phase0Reasons,
    byHorizon,
    byCohort: summarizePureWsBotflowCohorts(candidates, paperTrades),
    topCandidates: topCandidates(candidates),
  };
}

function summarizeMarkouts(markouts: PureWsBotflowMarkout[], horizonsSec: number[]): HorizonSummary[] {
  return horizonsSec.map((horizonSec) => {
    const rows = markouts.filter((row) => row.horizonSec === horizonSec);
    const ok = rows.filter((row) => row.quoteStatus === 'ok' && row.deltaPct != null);
    const deltas = ok.map((row) => row.deltaPct).filter((value): value is number => value != null);
    const postCost = ok.map((row) => row.postCostDeltaPct).filter((value): value is number => value != null);
    return {
      horizonSec,
      rows: rows.length,
      okRows: ok.length,
      positivePostCostRows: postCost.filter((value) => value > 0).length,
      medianDeltaPct: percentile(deltas, 0.5),
      p25PostCostDeltaPct: percentile(postCost, 0.25),
      medianPostCostDeltaPct: percentile(postCost, 0.5),
    };
  });
}

function phase0Gate(candidates: PureWsBotflowCandidate[], byHorizon: HorizonSummary[]): string[] {
  const reasons: string[] = [];
  const observedRows = candidates.filter((row) => row.decision === 'observe');
  const observed = observedRows.length;
  const contextKnownObserved = observedRows.filter((row) => !row.qualityFlags.includes('PAIR_CONTEXT_MISSING')).length;
  const pairAgeKnownObserved = observedRows.filter((row) => typeof row.pairAgeSec === 'number').length;
  const t15 = byHorizon.find((row) => row.horizonSec === 15);
  const t30 = byHorizon.find((row) => row.horizonSec === 30);
  if (observed < 200) reasons.push(`observe candidates ${observed} < 200`);
  if (contextKnownObserved < 30) reasons.push(`context-known observed candidates ${contextKnownObserved} < 30`);
  if (pairAgeKnownObserved < 30) reasons.push(`pair-age-known observed candidates ${pairAgeKnownObserved} < 30`);
  if (!t15 || t15.okRows < 30) reasons.push(`T+15 ok rows ${t15?.okRows ?? 0} < 30`);
  else if ((t15.p25PostCostDeltaPct ?? -Infinity) < 0) reasons.push(`T+15 p25 post-cost ${fmtPct(t15.p25PostCostDeltaPct)} < 0%`);
  if (!t30 || t30.okRows < 30) reasons.push(`T+30 ok rows ${t30?.okRows ?? 0} < 30`);
  else if ((t30.medianPostCostDeltaPct ?? -Infinity) < 0.02) {
    reasons.push(`T+30 median post-cost ${fmtPct(t30.medianPostCostDeltaPct)} < +2%`);
  }
  return reasons;
}

function topCandidates(candidates: PureWsBotflowCandidate[]): BotflowReport['topCandidates'] {
  return [...candidates].sort((a, b) => b.netFlowSol - a.netFlowSol || b.buySol - a.buySol).slice(0, 20).map((row) => ({
    tokenMint: row.tokenMint,
    windowSec: row.windowSec,
    buyCount: row.buyCount,
    sellCount: row.sellCount,
    buySol: row.buySol,
    sellSol: row.sellSol,
    netFlowSol: row.netFlowSol,
    dexId: row.dexId,
    pairAgeSec: row.pairAgeSec,
    knownPoolCount: row.knownPoolCount,
    qualityFlags: row.qualityFlags,
    decision: row.decision,
    rejectReason: row.rejectReason,
  }));
}

function summarizePaper(rows: PureWsBotflowPaperTrade[]): PaperSummary {
  const resolved = rows.filter((row) => row.simulatedNetSol != null);
  const net = resolved.map((row) => row.simulatedNetSol).filter((value): value is number => value != null);
  const postCost = resolved.map((row) => row.postCostDeltaPct).filter((value): value is number => value != null);
  const holds = resolved.map((row) => row.horizonSec).filter((value): value is number => value != null);
  const winners = net.filter((value) => value > 0).length;
  const losers = net.filter((value) => value < 0).length;
  return {
    trades: rows.length,
    resolvedTrades: resolved.length,
    unresolvedTrades: rows.length - resolved.length,
    winners,
    losers,
    winRate: resolved.length > 0 ? winners / resolved.length : null,
    totalNetSol: sum(net),
    medianPostCostDeltaPct: percentile(postCost, 0.5),
    avgHoldSec: holds.length > 0 ? sum(holds) / holds.length : null,
    byExitReason: countBy(rows.map((row) => row.exitReason)),
  };
}

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))];
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function fmtPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}
