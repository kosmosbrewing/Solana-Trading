import { type MarkoutCandidate } from './admissionEdgeTypes';
import {
  compactReturns,
  delayedReturn,
  deltaAt,
  loadMarkoutCandidates,
  postCostAnchorReturn,
  str,
  summarizeReturns,
} from './markoutCandidateStore';
import {
  type ProbePolicyResult,
  type ProbePolicySweepArgs,
  type ProbePolicySweepReport,
  type ProbePolicyVerdict,
} from './probePolicySweepTypes';

function rounded(value: number | null): number | null {
  return value == null ? null : Number(value.toFixed(6));
}

function metricDelta(after: number | null, before: number | null): number | null {
  if (after == null || before == null) return null;
  return rounded(after - before);
}

function medianLossReduction(baselineMedian: number | null, probeMedian: number | null): number | null {
  if (baselineMedian == null || probeMedian == null || baselineMedian >= 0) return null;
  return rounded((probeMedian - baselineMedian) / Math.abs(baselineMedian));
}

function evaluateVerdict(result: Omit<ProbePolicyResult, 'verdict' | 'reasons'>, args: ProbePolicySweepArgs): ProbePolicyVerdict {
  if (result.coveredRows < args.minRows) return 'DATA_GAP';
  if ((result.tailKillDelta ?? 0) > args.maxTailKillRate) return 'REJECT_TAIL_KILL';
  if ((result.medianImprovement ?? 0) <= 0) return 'REJECT_NO_IMPROVEMENT';
  if ((result.medianLossReduction ?? 0) >= args.minMedianLossReduction && (result.loser20Reduction ?? 0) > 0) return 'PROBE_POLICY_CANDIDATE';
  return 'WATCH';
}

function resultReasons(result: Omit<ProbePolicyResult, 'verdict' | 'reasons'>, args: ProbePolicySweepArgs): string[] {
  const reasons: string[] = [];
  if (result.coveredRows < args.minRows) reasons.push(`covered rows below ${args.minRows}`);
  if ((result.medianLossReduction ?? 0) >= args.minMedianLossReduction) reasons.push('median loss reduction meets threshold');
  if ((result.loser20Reduction ?? 0) > 0) reasons.push('<=-20% loser rate improves');
  if ((result.tailKillDelta ?? 0) > args.maxTailKillRate) reasons.push('tail retention risk exceeds limit');
  if ((result.delayedEntryPassToTarget.median ?? 0) < 0) reasons.push('delayed fresh entry remains negative');
  if ((result.medianImprovement ?? 0) <= 0) reasons.push('probe hold/cut does not improve median');
  return reasons;
}

function buildResult(cohort: string, candidates: MarkoutCandidate[], args: ProbePolicySweepArgs, confirmHorizonSec: number, confirmThresholdPct: number, targetHorizonSec: number): ProbePolicyResult {
  const covered = candidates.filter((candidate) => deltaAt(candidate, confirmHorizonSec) != null && deltaAt(candidate, targetHorizonSec) != null);
  const pass = covered.filter((candidate) => (deltaAt(candidate, confirmHorizonSec) ?? -Infinity) >= confirmThresholdPct);
  const fail = covered.filter((candidate) => (deltaAt(candidate, confirmHorizonSec) ?? -Infinity) < confirmThresholdPct);
  const baseline = summarizeReturns(compactReturns(covered.map((candidate) => postCostAnchorReturn(candidate, targetHorizonSec, args.roundTripCostPct))));
  const probeHoldCut = summarizeReturns(compactReturns(covered.map((candidate) => {
    const confirmDelta = deltaAt(candidate, confirmHorizonSec);
    if (confirmDelta == null) return null;
    return confirmDelta >= confirmThresholdPct
      ? postCostAnchorReturn(candidate, targetHorizonSec, args.roundTripCostPct)
      : confirmDelta - args.roundTripCostPct;
  })));
  const delayedEntryPassToTarget = summarizeReturns(compactReturns(pass.map((candidate) => delayedReturn(candidate, confirmHorizonSec, targetHorizonSec, args.roundTripCostPct))));
  const medianImprovement = metricDelta(probeHoldCut.median, baseline.median);
  const loser20Reduction = metricDelta(baseline.leNeg20Rate, probeHoldCut.leNeg20Rate);
  const tailKillDelta = metricDelta(baseline.ge50Rate, probeHoldCut.ge50Rate);
  const lossReduction = medianLossReduction(baseline.median, probeHoldCut.median);
  const score = rounded((lossReduction ?? 0) + (loser20Reduction ?? 0) - Math.max(0, tailKillDelta ?? 0) * 3);
  const partial = {
    cohort,
    confirmHorizonSec,
    confirmThresholdPct,
    targetHorizonSec,
    coveredRows: covered.length,
    passRows: pass.length,
    failRows: fail.length,
    baseline,
    probeHoldCut,
    delayedEntryPassToTarget,
    medianImprovement,
    medianLossReduction: lossReduction,
    loser20Reduction,
    tailKillDelta,
    score,
  };
  return {
    ...partial,
    verdict: evaluateVerdict(partial, args),
    reasons: resultReasons(partial, args),
  };
}

function cohortCandidates(candidates: MarkoutCandidate[]): Array<{ cohort: string; candidates: MarkoutCandidate[] }> {
  const cohorts = [
    { cohort: 'ALL', candidates },
    ...['rotation', 'smart_v3', 'pure_ws', 'kol_hunter_other']
      .map((family) => ({ cohort: `family:${family}`, candidates: candidates.filter((candidate) => candidate.family === family) })),
    ...['rotation', 'smart_v3']
      .flatMap((family) => ['KOL_1', 'KOL_2', 'KOL_3plus']
        .map((bucket) => ({ cohort: `family:${family}:${bucket}`, candidates: candidates.filter((candidate) => candidate.family === family && candidate.kolBucket === bucket) }))),
  ];
  return cohorts.filter((cohort) => cohort.candidates.length > 0);
}

function sortResults(results: ProbePolicyResult[]): ProbePolicyResult[] {
  return [...results].sort((a, b) => {
    const candidateDelta = Number(b.verdict === 'PROBE_POLICY_CANDIDATE') - Number(a.verdict === 'PROBE_POLICY_CANDIDATE');
    if (candidateDelta !== 0) return candidateDelta;
    return (b.score ?? -Infinity) - (a.score ?? -Infinity);
  });
}

function bestByCohort(results: ProbePolicyResult[]): ProbePolicyResult[] {
  const byCohort = new Map<string, ProbePolicyResult>();
  for (const result of sortResults(results)) {
    if (!byCohort.has(result.cohort)) byCohort.set(result.cohort, result);
  }
  return [...byCohort.values()];
}

function reportVerdict(results: ProbePolicyResult[]): ProbePolicyVerdict {
  if (results.some((result) => result.verdict === 'PROBE_POLICY_CANDIDATE')) return 'PROBE_POLICY_CANDIDATE';
  if (results.every((result) => result.verdict === 'DATA_GAP')) return 'DATA_GAP';
  if (results.some((result) => result.verdict === 'WATCH')) return 'WATCH';
  if (results.some((result) => result.verdict === 'REJECT_TAIL_KILL')) return 'REJECT_TAIL_KILL';
  return 'REJECT_NO_IMPROVEMENT';
}

function buildReasons(verdict: ProbePolicyVerdict, topPolicies: ProbePolicyResult[], forwardShadowCandidates: ProbePolicyResult[]): string[] {
  const reasons: string[] = [];
  if (verdict === 'PROBE_POLICY_CANDIDATE') reasons.push('At least one probe hold/cut policy reduces median loss without breaching the tail-kill limit.');
  if (topPolicies.length > 0) {
    const top = topPolicies[0];
    reasons.push(`best=${top.cohort} T+${top.confirmHorizonSec}s >= ${(top.confirmThresholdPct * 100).toFixed(1)}% -> T+${top.targetHorizonSec}s`);
  }
  if (forwardShadowCandidates.length > 0) reasons.push(`${forwardShadowCandidates.length} policy candidate(s) qualify for forward paper-shadow review, not live promotion.`);
  reasons.push('Report-only. This is a historical policy sweep and does not change live or paper execution.');
  return reasons;
}

export async function buildProbePolicySweepReport(args: ProbePolicySweepArgs): Promise<ProbePolicySweepReport> {
  const { anchorRows, markoutRows, candidates, okBuyMarkoutRows } = await loadMarkoutCandidates(args.realtimeDir);
  const results = cohortCandidates(candidates).flatMap(({ cohort, candidates: cohortRows }) => args.confirmHorizonsSec.flatMap((confirmHorizonSec) => args.confirmThresholdsPct.flatMap((confirmThresholdPct) => args.targetHorizonsSec.map((targetHorizonSec) => buildResult(cohort, cohortRows, args, confirmHorizonSec, confirmThresholdPct, targetHorizonSec)))));
  const topPolicies = sortResults(results).filter((result) => result.verdict !== 'DATA_GAP').slice(0, 20);
  const forwardShadowCandidates = sortResults(results).filter((result) => result.verdict === 'PROBE_POLICY_CANDIDATE');
  const verdict = reportVerdict(results);
  return {
    generatedAt: new Date().toISOString(),
    realtimeDir: args.realtimeDir,
    confirmHorizonsSec: args.confirmHorizonsSec,
    confirmThresholdsPct: args.confirmThresholdsPct,
    targetHorizonsSec: args.targetHorizonsSec,
    roundTripCostPct: args.roundTripCostPct,
    minRows: args.minRows,
    maxTailKillRate: args.maxTailKillRate,
    minMedianLossReduction: args.minMedianLossReduction,
    anchorRows: anchorRows.length,
    buyAnchors: anchorRows.filter((row) => str(row.anchorType) === 'buy').length,
    markoutRows: markoutRows.length,
    okBuyMarkoutRows,
    candidates: candidates.length,
    verdict,
    topPolicies,
    bestByCohort: bestByCohort(results).filter((result) => result.verdict !== 'DATA_GAP'),
    forwardShadowCandidates,
    promotionGate: {
      status: forwardShadowCandidates.length > 0 ? 'FORWARD_PAPER_SHADOW_READY' : 'NO_FORWARD_SHADOW_CANDIDATE',
      forwardPaperMinCloses: 50,
      livePromotionMinCloses: 50,
      requiresNoTailKillIncrease: true,
      requiresWalletTruthReview: true,
    },
    results,
    reasons: buildReasons(verdict, topPolicies, forwardShadowCandidates),
  };
}
