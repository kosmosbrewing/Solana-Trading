import {
  type MarkoutCandidate,
  type ReturnStats,
} from './admissionEdgeTypes';
import {
  compactReturns,
  loadMarkoutCandidates,
  postCostAnchorReturn,
  rounded,
  str,
  summarizeReturns,
} from './markoutCandidateStore';
import {
  type LiveBleedSummary,
  type MissionEntryArgs,
  type MissionEntryCohort,
  type MissionEntryCohortVerdict,
  type MissionEntryReport,
  type MissionEntryVerdict,
  type PaperShadowArmSummary,
} from './missionEntryReportTypes';
import {
  buildLiveBleed,
  buildPaperShadows,
  loadMissionTradeRows,
} from './missionEntryReportTrades';

function statsAt(candidates: MarkoutCandidate[], horizonSec: number, roundTripCostPct: number): ReturnStats {
  return summarizeReturns(compactReturns(candidates.map((candidate) => postCostAnchorReturn(candidate, horizonSec, roundTripCostPct))));
}

function statMedian(cohort: MissionEntryCohort, horizonSec: number): number | null {
  return cohort.horizons.find((item) => item.horizonSec === horizonSec)?.stats.median ?? null;
}

function delta(after: number | null, before: number | null): number | null {
  if (after == null || before == null) return null;
  return rounded(after - before);
}

function buildCohort(
  cohort: string,
  candidates: MarkoutCandidate[],
  horizonsSec: number[],
  roundTripCostPct: number,
  minRows: number
): MissionEntryCohort {
  const horizons = horizonsSec.map((horizonSec) => ({
    horizonSec,
    stats: statsAt(candidates, horizonSec, roundTripCostPct),
  }));
  const draft: MissionEntryCohort = {
    cohort,
    sourceRows: candidates.length,
    horizons,
    decay30To300: null,
    decay300To1800: null,
    verdict: 'WATCH',
    reasons: [],
  };
  draft.decay30To300 = delta(statMedian(draft, 300), statMedian(draft, 30));
  draft.decay300To1800 = delta(statMedian(draft, 1800), statMedian(draft, 300));
  draft.verdict = cohortVerdict(draft, minRows);
  draft.reasons = cohortReasons(draft, minRows);
  return draft;
}

function cohortVerdict(cohort: MissionEntryCohort, minRows: number): MissionEntryCohortVerdict {
  const h300 = cohort.horizons.find((item) => item.horizonSec === 300)?.stats;
  const h1800 = cohort.horizons.find((item) => item.horizonSec === 1800)?.stats;
  if (!h300 || h300.rows < minRows) return 'DATA_GAP';
  if (h300.median != null && h300.median < 0 && h1800?.median != null && h1800.median < h300.median) {
    return 'ADMISSION_DECAY_CONFIRMED';
  }
  if (h300.median != null && h300.median < 0) return 'ADMISSION_EDGE_GAP';
  return 'WATCH';
}

function cohortReasons(cohort: MissionEntryCohort, minRows: number): string[] {
  const reasons: string[] = [];
  const h300 = cohort.horizons.find((item) => item.horizonSec === 300)?.stats;
  const h1800 = cohort.horizons.find((item) => item.horizonSec === 1800)?.stats;
  if (!h300 || h300.rows < minRows) reasons.push(`T+300 coverage ${h300?.rows ?? 0} < ${minRows}`);
  if (h300?.median != null && h300.median < 0) reasons.push('T+300 median is post-cost negative');
  if (h1800?.median != null && h300?.median != null && h1800.median < h300.median) {
    reasons.push('T+1800 decays below T+300');
  }
  if (cohort.decay30To300 != null && cohort.decay30To300 < 0) reasons.push('T+30 to T+300 path decays');
  if (reasons.length === 0) reasons.push('no post-cost decay trigger');
  return reasons;
}

function buildCohorts(candidates: MarkoutCandidate[], args: MissionEntryArgs): MissionEntryCohort[] {
  const groups: Array<[string, MarkoutCandidate[]]> = [
    ['all', candidates],
    ['family:rotation', candidates.filter((candidate) => candidate.family === 'rotation')],
    ['family:smart_v3', candidates.filter((candidate) => candidate.family === 'smart_v3')],
    ['family:pure_ws', candidates.filter((candidate) => candidate.family === 'pure_ws')],
    ['mode:live', candidates.filter((candidate) => candidate.mode === 'live')],
    ['mode:paper', candidates.filter((candidate) => candidate.mode === 'paper')],
    ['rotation:KOL_1', candidates.filter((candidate) => candidate.family === 'rotation' && candidate.kolBucket === 'KOL_1')],
    ['rotation:KOL_2plus', candidates.filter((candidate) => candidate.family === 'rotation' && candidate.kolBucket !== 'KOL_1' && candidate.kolBucket !== 'KOL_unknown')],
    ['smart_v3:KOL_3plus', candidates.filter((candidate) => candidate.family === 'smart_v3' && candidate.kolBucket === 'KOL_3plus')],
  ];
  return groups
    .map(([name, rows]) => buildCohort(name, rows, args.horizonsSec, args.roundTripCostPct, args.minRows))
    .filter((cohort) => cohort.sourceRows > 0);
}

function overallVerdict(cohorts: MissionEntryCohort[], liveBleed: LiveBleedSummary, args: MissionEntryArgs): MissionEntryVerdict {
  const all = cohorts.find((cohort) => cohort.cohort === 'all');
  if (!all || all.verdict === 'DATA_GAP' || liveBleed.liveRows < args.minRows) return 'DATA_GAP';
  if (
    all.verdict === 'ADMISSION_DECAY_CONFIRMED' &&
    liveBleed.bleedNetShare != null &&
    liveBleed.bleedNetShare >= args.bleedShareThreshold
  ) {
    return 'ADMISSION_QUALITY_ROOT_CAUSE';
  }
  if (all.verdict === 'ADMISSION_DECAY_CONFIRMED') return 'ADMISSION_DECAY_CONFIRMED';
  if (liveBleed.liveNetSol < 0 && (liveBleed.bleedNetShare == null || liveBleed.bleedNetShare < args.bleedShareThreshold)) {
    return 'EXECUTION_OR_COST_REVIEW';
  }
  return 'WATCH';
}

function overallReasons(cohorts: MissionEntryCohort[], liveBleed: LiveBleedSummary, args: MissionEntryArgs): string[] {
  const reasons: string[] = [];
  const all = cohorts.find((cohort) => cohort.cohort === 'all');
  if (!all) reasons.push('no markout cohorts');
  else reasons.push(...all.reasons.map((reason) => `all: ${reason}`));
  if (liveBleed.liveRows < args.minRows) reasons.push(`live closed rows ${liveBleed.liveRows} < ${args.minRows}`);
  if (liveBleed.liveNetSol < 0) reasons.push(`live wallet net is negative (${liveBleed.liveNetSol} SOL)`);
  if (liveBleed.bleedNetShare != null) reasons.push(`bleed buckets explain ${(liveBleed.bleedNetShare * 100).toFixed(1)}% of live loss`);
  if (liveBleed.bleedNetShare != null && liveBleed.bleedNetShare >= args.bleedShareThreshold) {
    reasons.push('bleed share crosses root-cause threshold');
  }
  return reasons;
}

function nextActions(verdict: MissionEntryVerdict, paperShadows: PaperShadowArmSummary[]): string[] {
  const actions = [
    'Keep funded live unchanged until mirror/live proof improves.',
    'Use paper shadow arms as promotion evidence only after forward closes, not as live profit proof.',
  ];
  if (verdict === 'ADMISSION_QUALITY_ROOT_CAUSE' || verdict === 'ADMISSION_DECAY_CONFIRMED') {
    actions.unshift('Prioritize admission veto/probe-first paper validation before exit/tail changes.');
  }
  if (!paperShadows.some((shadow) => shadow.armName === 'rotation_doa_veto_shadow_v1')) {
    actions.push('Collect rotation_doa_veto_shadow_v1 rows before relaxing rotation admission.');
  }
  if (!paperShadows.some((shadow) => shadow.armName === 'smart_v3_probe_confirm_shadow_v1')) {
    actions.push('Collect smart_v3_probe_confirm_shadow_v1 rows before restoring smart-v3 funded exposure.');
  }
  return actions;
}

export async function buildMissionEntryReport(args: MissionEntryArgs): Promise<MissionEntryReport> {
  const [
    markout,
    trades,
  ] = await Promise.all([
    loadMarkoutCandidates(args.realtimeDir),
    loadMissionTradeRows(args.realtimeDir),
  ]);

  const buyAnchors = markout.anchorRows.filter((row) => str(row.anchorType) === 'buy').length;
  const cohorts = buildCohorts(markout.candidates, args);
  const liveBleed = buildLiveBleed(trades.liveRows);
  const paperShadows = buildPaperShadows(trades.paperRows);
  const verdict = overallVerdict(cohorts, liveBleed, args);

  return {
    generatedAt: new Date().toISOString(),
    realtimeDir: args.realtimeDir,
    horizonsSec: args.horizonsSec,
    roundTripCostPct: args.roundTripCostPct,
    minRows: args.minRows,
    bleedShareThreshold: args.bleedShareThreshold,
    anchorRows: markout.anchorRows.length,
    buyAnchors,
    markoutRows: markout.markoutRows.length,
    okBuyMarkoutRows: markout.okBuyMarkoutRows,
    candidates: markout.candidates.length,
    verdict,
    reasons: overallReasons(cohorts, liveBleed, args),
    cohorts,
    liveBleed,
    paperShadows,
    nextActions: nextActions(verdict, paperShadows),
  };
}
