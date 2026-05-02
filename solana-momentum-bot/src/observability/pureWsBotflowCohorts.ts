import type { PureWsBotflowCandidate, PureWsBotflowPaperTrade } from './pureWsBotflowTypes';

export type PureWsBotflowCohortName =
  | 'mayhem_only'
  | 'mayhem_organic'
  | 'mayhem_kol_overlap'
  | 'mayhem_organic_kol_overlap'
  | 'non_mayhem_new_pair'
  | 'non_mayhem_unknown_or_stale';

export interface PureWsBotflowCohortSummary {
  cohort: PureWsBotflowCohortName;
  candidates: number;
  observedCandidates: number;
  resolvedPaperTrades: number;
  paperNetSol: number;
  medianPostCostDeltaPct: number | null;
}

export function summarizePureWsBotflowCohorts(
  candidates: PureWsBotflowCandidate[],
  paperTrades: PureWsBotflowPaperTrade[],
): PureWsBotflowCohortSummary[] {
  const paperByCandidate = groupBy(paperTrades, (row) => row.candidateId);
  const cohorts = groupBy(candidates, candidateCohort);
  const ordered: PureWsBotflowCohortName[] = [
    'mayhem_only',
    'mayhem_organic',
    'mayhem_kol_overlap',
    'mayhem_organic_kol_overlap',
    'non_mayhem_new_pair',
    'non_mayhem_unknown_or_stale',
  ];
  return ordered.map((cohort) => {
    const rows = cohorts.get(cohort) ?? [];
    const paper = rows.flatMap((candidate) => paperByCandidate.get(candidate.candidateId) ?? []);
    const resolved = paper.filter((row) => row.simulatedNetSol != null);
    const postCost = resolved
      .map((row) => row.postCostDeltaPct)
      .filter((value): value is number => typeof value === 'number');
    return {
      cohort,
      candidates: rows.length,
      observedCandidates: rows.filter((row) => row.decision === 'observe').length,
      resolvedPaperTrades: resolved.length,
      paperNetSol: resolved.reduce((sum, row) => sum + (row.simulatedNetSol ?? 0), 0),
      medianPostCostDeltaPct: percentile(postCost, 0.5),
    };
  });
}

function candidateCohort(candidate: PureWsBotflowCandidate): PureWsBotflowCohortName {
  const flags = new Set(candidate.qualityFlags);
  const mayhem = candidate.mayhemMode === true || flags.has('MAYHEM_MODE_TRUE');
  if (!mayhem) return isFreshPair(candidate) ? 'non_mayhem_new_pair' : 'non_mayhem_unknown_or_stale';
  const organic = hasAnyPrefix(flags, ['ORGANIC_', 'NON_AGENT_BUYER_', 'BUYER_BREADTH_']);
  const kol = hasAnyPrefix(flags, ['KOL_', 'KOL_OVERLAP']);
  if (organic && kol) return 'mayhem_organic_kol_overlap';
  if (organic) return 'mayhem_organic';
  if (kol) return 'mayhem_kol_overlap';
  return 'mayhem_only';
}

function isFreshPair(candidate: PureWsBotflowCandidate): boolean {
  return candidate.pairAgeSec != null
    ? candidate.pairAgeSec <= 180
    : candidate.qualityFlags.includes('FRESH_PAIR_AGE_LE_180S');
}

function hasAnyPrefix(flags: Set<string>, prefixes: string[]): boolean {
  for (const flag of flags) {
    if (prefixes.some((prefix) => flag.startsWith(prefix))) return true;
  }
  return false;
}

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))];
}

function groupBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    out.set(key, [...(out.get(key) ?? []), item]);
  }
  return out;
}
