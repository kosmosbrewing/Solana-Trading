import {
  type AdmissionEdgeArgs,
  type AdmissionEdgeReport,
  type AdmissionVerdict,
  type CohortAdmissionEdge,
  type MarkoutCandidate,
  type ReturnStats,
} from './admissionEdgeTypes';
import {
  compactReturns,
  delayedReturn,
  deltaAt,
  loadMarkoutCandidates,
  postCostAnchorReturn,
  str,
  summarizeReturns,
} from './markoutCandidateStore';

function cohortVerdict(baseline: ReturnStats, pass: ReturnStats, delayed: ReturnStats, holdCut: ReturnStats, coveredRows: number): AdmissionVerdict {
  if (coveredRows < 50) return 'DATA_GAP';
  if ((baseline.median ?? 0) < 0 && (pass.median ?? 0) > (baseline.median ?? 0) && (delayed.median ?? 0) < 0) {
    return 'ADMISSION_EDGE_GAP';
  }
  if ((baseline.median ?? 0) < 0 && (holdCut.median ?? -Infinity) > (baseline.median ?? Infinity)) {
    return 'PROBE_HOLD_CUT_REVIEW';
  }
  return 'WATCH';
}

function buildCohort(cohort: string, candidates: MarkoutCandidate[], args: AdmissionEdgeArgs): CohortAdmissionEdge {
  const covered = candidates.filter((candidate) => deltaAt(candidate, args.confirmHorizonSec) != null && deltaAt(candidate, args.targetHorizonSec) != null);
  const pass = covered.filter((candidate) => (deltaAt(candidate, args.confirmHorizonSec) ?? -Infinity) >= args.confirmThresholdPct);
  const fail = covered.filter((candidate) => (deltaAt(candidate, args.confirmHorizonSec) ?? -Infinity) < args.confirmThresholdPct);
  const baseline = summarizeReturns(compactReturns(covered.map((candidate) => postCostAnchorReturn(candidate, args.targetHorizonSec, args.roundTripCostPct))));
  const confirmPassAnchorToTarget = summarizeReturns(compactReturns(pass.map((candidate) => postCostAnchorReturn(candidate, args.targetHorizonSec, args.roundTripCostPct))));
  const confirmFailAnchorToTarget = summarizeReturns(compactReturns(fail.map((candidate) => postCostAnchorReturn(candidate, args.targetHorizonSec, args.roundTripCostPct))));
  const delayedEntryPassToTarget = summarizeReturns(compactReturns(pass.map((candidate) => delayedReturn(candidate, args.confirmHorizonSec, args.targetHorizonSec, args.roundTripCostPct))));
  const delayedEntryPassToCarry = summarizeReturns(compactReturns(pass.map((candidate) => delayedReturn(candidate, args.confirmHorizonSec, args.carryHorizonSec, args.roundTripCostPct))));
  const holdIfConfirmElseCut = summarizeReturns(compactReturns(covered.map((candidate) => {
    const confirmDelta = deltaAt(candidate, args.confirmHorizonSec);
    if (confirmDelta == null) return null;
    return confirmDelta >= args.confirmThresholdPct
      ? postCostAnchorReturn(candidate, args.targetHorizonSec, args.roundTripCostPct)
      : confirmDelta - args.roundTripCostPct;
  })));
  const reasons = cohortReasons(covered.length, baseline, confirmPassAnchorToTarget, confirmFailAnchorToTarget, delayedEntryPassToTarget, holdIfConfirmElseCut);
  return {
    cohort,
    rows: candidates.length,
    coverageRows: covered.length,
    baseline,
    confirmPassAnchorToTarget,
    confirmFailAnchorToTarget,
    delayedEntryPassToTarget,
    delayedEntryPassToCarry,
    holdIfConfirmElseCut,
    passRows: pass.length,
    failRows: fail.length,
    verdict: cohortVerdict(baseline, confirmPassAnchorToTarget, delayedEntryPassToTarget, holdIfConfirmElseCut, covered.length),
    reasons,
  };
}

function cohortReasons(coveredRows: number, baseline: ReturnStats, pass: ReturnStats, fail: ReturnStats, delayed: ReturnStats, holdCut: ReturnStats): string[] {
  const reasons: string[] = [];
  if (coveredRows < 50) reasons.push('sample below 50 covered buy anchors');
  if ((baseline.median ?? 0) < 0) reasons.push('baseline target-horizon median is negative after cost');
  if ((pass.median ?? -Infinity) > (fail.median ?? Infinity)) reasons.push('early continuation separates winners from losers');
  if ((delayed.median ?? 0) < 0) reasons.push('late entry after confirmation remains negative; avoid lookahead promotion');
  if ((holdCut.median ?? -Infinity) > (baseline.median ?? Infinity)) reasons.push('probe hold/cut improves median loss but does not prove live edge');
  return reasons;
}

function reportVerdict(cohorts: CohortAdmissionEdge[]): AdmissionVerdict {
  const all = cohorts.find((cohort) => cohort.cohort === 'ALL');
  if (!all || all.verdict === 'DATA_GAP') return 'DATA_GAP';
  if (cohorts.some((cohort) => cohort.verdict === 'ADMISSION_EDGE_GAP')) return 'ADMISSION_EDGE_GAP';
  if (cohorts.some((cohort) => cohort.verdict === 'PROBE_HOLD_CUT_REVIEW')) return 'PROBE_HOLD_CUT_REVIEW';
  return 'WATCH';
}

function buildReportReasons(cohorts: CohortAdmissionEdge[], verdict: AdmissionVerdict): string[] {
  const reasons = new Set<string>();
  if (verdict === 'ADMISSION_EDGE_GAP') {
    reasons.add('KOL discovery finds tail candidates, but full-risk entry timing is still not wallet-positive.');
    reasons.add('Early continuation is evidence for probe hold/cut, not proof that a delayed full entry is profitable.');
  }
  for (const cohort of cohorts) {
    for (const reason of cohort.reasons.slice(0, 2)) reasons.add(`${cohort.cohort}: ${reason}`);
  }
  return [...reasons];
}

export async function buildAdmissionEdgeReport(args: AdmissionEdgeArgs): Promise<AdmissionEdgeReport> {
  const { anchorRows, markoutRows, candidates, okBuyMarkoutRows } = await loadMarkoutCandidates(args.realtimeDir);
  const cohorts = [
    buildCohort('ALL', candidates, args),
    ...['rotation', 'smart_v3', 'pure_ws', 'kol_hunter_other']
      .map((family) => buildCohort(`family:${family}`, candidates.filter((candidate) => candidate.family === family), args))
      .filter((cohort) => cohort.rows > 0),
    ...['rotation', 'smart_v3']
      .flatMap((family) => ['KOL_1', 'KOL_2', 'KOL_3plus']
        .map((bucket) => buildCohort(`family:${family}:${bucket}`, candidates.filter((candidate) => candidate.family === family && candidate.kolBucket === bucket), args)))
      .filter((cohort) => cohort.rows > 0),
  ];
  const verdict = reportVerdict(cohorts);
  return {
    generatedAt: new Date().toISOString(),
    realtimeDir: args.realtimeDir,
    confirmHorizonSec: args.confirmHorizonSec,
    targetHorizonSec: args.targetHorizonSec,
    carryHorizonSec: args.carryHorizonSec,
    confirmThresholdPct: args.confirmThresholdPct,
    roundTripCostPct: args.roundTripCostPct,
    anchorRows: anchorRows.length,
    buyAnchors: anchorRows.filter((row) => str(row.anchorType) === 'buy').length,
    markoutRows: markoutRows.length,
    okBuyMarkoutRows,
    candidates: candidates.length,
    cohorts,
    verdict,
    reasons: buildReportReasons(cohorts, verdict),
  };
}
