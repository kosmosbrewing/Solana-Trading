import {
  PURE_WS_BOTFLOW_PAPER_SCHEMA_VERSION,
  type PureWsBotflowCandidate,
  type PureWsBotflowMarkout,
  type PureWsBotflowPaperConfig,
  type PureWsBotflowPaperExitReason,
  type PureWsBotflowPaperTrade,
} from './pureWsBotflowTypes';

export const DEFAULT_PURE_WS_BOTFLOW_PAPER_CONFIG: PureWsBotflowPaperConfig = {
  ticketSol: 0.005,
  hardCutPostCostPct: -0.06,
  t1GrossPct: 0.06,
  t1PostCostPct: 0.02,
  t2GrossPct: 0.10,
  t2PostCostPct: 0.05,
  maxHoldSec: 30,
};

export function simulateBotflowPaperTrades(
  candidates: PureWsBotflowCandidate[],
  markouts: PureWsBotflowMarkout[],
  config: Partial<PureWsBotflowPaperConfig> = {},
): PureWsBotflowPaperTrade[] {
  const cfg = { ...DEFAULT_PURE_WS_BOTFLOW_PAPER_CONFIG, ...config };
  const markoutsByCandidate = groupBy(markouts, (row) => row.candidateId);
  return candidates
    .filter((candidate) => candidate.decision === 'observe')
    .map((candidate) => simulateOne(candidate, markoutsByCandidate.get(candidate.candidateId) ?? [], cfg));
}

function simulateOne(
  candidate: PureWsBotflowCandidate,
  markouts: PureWsBotflowMarkout[],
  cfg: PureWsBotflowPaperConfig,
): PureWsBotflowPaperTrade {
  const okRows = markouts
    .filter((row) => row.quoteStatus === 'ok' && row.deltaPct != null && row.postCostDeltaPct != null)
    .sort((a, b) => a.horizonSec - b.horizonSec);
  const selected = selectExit(okRows, cfg);
  const exitReason = selected ? classifyExit(selected, cfg) : fallbackReason(markouts);
  const deltaPct = selected?.deltaPct;
  const postCostDeltaPct = selected?.postCostDeltaPct;
  return {
    schemaVersion: PURE_WS_BOTFLOW_PAPER_SCHEMA_VERSION,
    paperTradeId: `pwbfp:${candidate.candidateId}`,
    candidateId: candidate.candidateId,
    observedAt: new Date().toISOString(),
    tokenMint: candidate.tokenMint,
    entryAt: candidate.observedAt,
    exitAt: selected?.observedAt,
    horizonSec: selected?.horizonSec,
    ticketSol: cfg.ticketSol,
    entryPriceSol: selected?.entryPriceSol,
    exitPriceSol: selected?.markoutPriceSol,
    deltaPct,
    postCostDeltaPct,
    simulatedNetSol: postCostDeltaPct == null ? undefined : cfg.ticketSol * postCostDeltaPct,
    exitReason,
    decisionContext: {
      windowSec: candidate.windowSec,
      buyCount: candidate.buyCount,
      sellCount: candidate.sellCount,
      netFlowSol: candidate.netFlowSol,
      pairAgeSec: candidate.pairAgeSec,
      qualityFlags: candidate.qualityFlags,
    },
  };
}

function selectExit(rows: PureWsBotflowMarkout[], cfg: PureWsBotflowPaperConfig): PureWsBotflowMarkout | undefined {
  for (const row of rows) {
    if ((row.postCostDeltaPct ?? 0) <= cfg.hardCutPostCostPct) return row;
    if (isT2(row, cfg)) return row;
    if (isT1(row, cfg)) return row;
    if (row.horizonSec >= cfg.maxHoldSec) return row;
  }
  return undefined;
}

function classifyExit(row: PureWsBotflowMarkout, cfg: PureWsBotflowPaperConfig): PureWsBotflowPaperExitReason {
  if ((row.postCostDeltaPct ?? 0) <= cfg.hardCutPostCostPct) return 'hard_cut';
  if (isT2(row, cfg)) return 't2_take_profit';
  if (isT1(row, cfg)) return 't1_take_profit';
  return 'max_hold';
}

function fallbackReason(markouts: PureWsBotflowMarkout[]): PureWsBotflowPaperExitReason {
  if (markouts.some((row) => row.quoteStatus === 'bad_entry_price')) return 'missing_entry_price';
  return 'missing_price_trajectory';
}

function isT1(row: PureWsBotflowMarkout, cfg: PureWsBotflowPaperConfig): boolean {
  return (row.deltaPct ?? -Infinity) >= cfg.t1GrossPct && (row.postCostDeltaPct ?? -Infinity) >= cfg.t1PostCostPct;
}

function isT2(row: PureWsBotflowMarkout, cfg: PureWsBotflowPaperConfig): boolean {
  return (row.deltaPct ?? -Infinity) >= cfg.t2GrossPct && (row.postCostDeltaPct ?? -Infinity) >= cfg.t2PostCostPct;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    out.set(key, [...(out.get(key) ?? []), item]);
  }
  return out;
}
