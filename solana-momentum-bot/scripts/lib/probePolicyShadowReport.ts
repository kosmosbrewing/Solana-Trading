import path from 'path';
import {
  readJsonl,
  str,
  num,
} from './markoutCandidateStore';
import {
  PROBE_POLICY_PARENT_ARM,
  PROBE_POLICY_PARENT_ARMS,
  PROBE_POLICY_SHADOW_ARM,
  PROBE_POLICY_SHADOW_ROLE,
  type ProbePolicyShadowArgs,
  type ProbePolicyShadowComparison,
  type ProbePolicyShadowCohortComparison,
  type ProbePolicyShadowFunnel,
  type ProbePolicyShadowQualitySplit,
  type ProbePolicyShadowReport,
  type ProbePolicyShadowStats,
  type ProbePolicyShadowVerdict,
  type ProbePolicyShadowWinnerKillAudit,
} from './probePolicyShadowTypes';

interface JsonRow {
  [key: string]: unknown;
}

function extrasOf(row: JsonRow): JsonRow {
  return typeof row.extras === 'object' && row.extras != null ? row.extras as JsonRow : {};
}

function valueStr(row: JsonRow, key: string): string {
  return str(row[key]) || str(extrasOf(row)[key]);
}

function valueNum(row: JsonRow, key: string): number | null {
  return num(row[key]) ?? num(extrasOf(row)[key]);
}

function valueArray(row: JsonRow, key: string): unknown[] {
  const direct = row[key];
  if (Array.isArray(direct)) return direct;
  const extra = extrasOf(row)[key];
  return Array.isArray(extra) ? extra : [];
}

function timeMs(value: unknown): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function rowTimeMs(row: JsonRow): number {
  for (const key of ['closedAt', 'exitAt', 'rejectedAt', 'recordedAt', 'openedAt']) {
    const parsed = timeMs(row[key]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function rate(values: number[], predicate: (value: number) => boolean): number | null {
  return values.length === 0 ? null : values.filter(predicate).length / values.length;
}

function rounded(value: number | null): number | null {
  return value == null ? null : Number(value.toFixed(6));
}

function metricDelta(after: number | null, before: number | null): number | null {
  if (after == null || before == null) return null;
  return rounded(after - before);
}

function metricLabel(value: number | null, suffix = ''): string {
  return value == null ? 'n/a' : `${value}${suffix}`;
}

function pctLabel(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function stats(rows: JsonRow[]): ProbePolicyShadowStats {
  const netPcts = rows.map((row) => valueNum(row, 'netPctTokenOnly') ?? valueNum(row, 'netPct')).filter((value): value is number => value != null);
  const netSols = rows.map((row) => valueNum(row, 'netSolTokenOnly') ?? valueNum(row, 'netSol')).filter((value): value is number => value != null);
  const mfes = rows.map((row) => valueNum(row, 'mfePctPeakTokenOnly') ?? valueNum(row, 'mfePctPeak') ?? valueNum(row, 'mfePct')).filter((value): value is number => value != null);
  return {
    rows: rows.length,
    medianNetPct: rounded(median(netPcts)),
    medianNetSol: rounded(median(netSols)),
    positiveRate: rounded(rate(netPcts, (value) => value > 0)),
    bigLossRate: rounded(rate(netPcts, (value) => value <= -0.2)),
    tail50Rate: rounded(rate(mfes, (value) => value >= 0.5)),
    fiveXRate: rounded(rate(mfes, (value) => value >= 4.0)),
  };
}

function isProbeShadow(row: JsonRow): boolean {
  return valueStr(row, 'paperRole') === PROBE_POLICY_SHADOW_ROLE ||
    valueStr(row, 'armName') === PROBE_POLICY_SHADOW_ARM;
}

function isParentRow(row: JsonRow): boolean {
  const armName = valueStr(row, 'armName');
  return PROBE_POLICY_PARENT_ARMS.some((parentArm) => parentArm === armName);
}

function hasBelowMinKolFlag(row: JsonRow): boolean {
  return valueArray(row, 'survivalFlags')
    .some((value) => typeof value === 'string' && value.startsWith('SMART_V3_PROBE_BELOW_MIN_KOL_'));
}

function kolCount(row: JsonRow): number | null {
  return valueNum(row, 'independentKolCount');
}

function isKol3Eligible(row: JsonRow): boolean {
  const kols = kolCount(row);
  return kols != null && kols >= 3 && !hasBelowMinKolFlag(row);
}

function isBelowMinKol(row: JsonRow): boolean {
  const kols = kolCount(row);
  return hasBelowMinKolFlag(row) || (kols != null && kols < 3);
}

function closeRowsSince(rows: JsonRow[], sinceMs: number): JsonRow[] {
  return rows.filter((row) => {
    const atMs = rowTimeMs(row);
    return Number.isFinite(atMs) && atMs >= sinceMs;
  });
}

function countExitReasons(rows: JsonRow[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const reason = valueStr(row, 'exitReason') || 'unknown';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));
}

function nestedObject(row: JsonRow, key: string): JsonRow {
  const value = row[key];
  return typeof value === 'object' && value != null ? value as JsonRow : {};
}

function topExitReasons(rows: JsonRow[], limit = 3): Array<{ reason: string; count: number }> {
  return countExitReasons(rows).slice(0, limit);
}

function buildComparison(probeRows: JsonRow[], rowsByPositionId: Map<string, JsonRow>): ProbePolicyShadowComparison {
  const pairedParents: JsonRow[] = [];
  const pairedProbes: JsonRow[] = [];
  for (const probe of probeRows) {
    const parentPositionId = valueStr(probe, 'parentPositionId');
    const parent = parentPositionId ? rowsByPositionId.get(parentPositionId) : undefined;
    if (!parent) continue;
    pairedParents.push(parent);
    pairedProbes.push(probe);
  }
  const parent = stats(pairedParents);
  const probe = stats(pairedProbes);
  return {
    pairedRows: pairedProbes.length,
    parent,
    probe,
    medianImprovement: metricDelta(probe.medianNetPct, parent.medianNetPct),
    bigLossReduction: metricDelta(parent.bigLossRate, probe.bigLossRate),
    tailKillDelta: metricDelta(parent.tail50Rate, probe.tail50Rate),
  };
}

function buildFunnel(
  parentRows: JsonRow[],
  probeRows: JsonRow[],
  rowsByPositionId: Map<string, JsonRow>
): ProbePolicyShadowFunnel {
  const parentIds = new Set(parentRows.map((row) => valueStr(row, 'positionId')).filter(Boolean));
  const eligibleParentIds = new Set(parentRows
    .filter(isKol3Eligible)
    .map((row) => valueStr(row, 'positionId'))
    .filter(Boolean));
  const pairedParentIds = new Set<string>();
  let pairedRows = 0;
  let eligiblePairedRows = 0;
  let unpairedProbeRows = 0;

  for (const probe of probeRows) {
    const parentPositionId = valueStr(probe, 'parentPositionId');
    const parent = parentPositionId ? rowsByPositionId.get(parentPositionId) : undefined;
    if (!parent || !parentIds.has(parentPositionId)) {
      unpairedProbeRows += 1;
      continue;
    }
    pairedRows += 1;
    pairedParentIds.add(parentPositionId);
    if (eligibleParentIds.has(parentPositionId) && isKol3Eligible(probe)) {
      eligiblePairedRows += 1;
    }
  }

  const eligibleParentWithoutProbeRows = [...eligibleParentIds]
    .filter((positionId) => !pairedParentIds.has(positionId))
    .length;
  const belowMinParentRows = parentRows.filter(isBelowMinKol).length;
  const belowMinProbeRows = probeRows.filter(isBelowMinKol).length;
  const unknownParentRows = parentRows.filter((row) => kolCount(row) == null && !hasBelowMinKolFlag(row)).length;
  const unknownProbeRows = probeRows.filter((row) => kolCount(row) == null && !hasBelowMinKolFlag(row)).length;
  const allPairCoverage = parentRows.length === 0 ? null : rounded(pairedRows / parentRows.length);
  const eligiblePairCoverage = eligibleParentIds.size === 0 ? null : rounded(eligiblePairedRows / eligibleParentIds.size);
  const reasons: string[] = [];

  if (eligibleParentIds.size === 0) reasons.push('no KOL_3plus parent closes were available for probe-policy promotion evidence');
  if (unknownParentRows > 0) reasons.push(`${unknownParentRows} parent closes are missing independentKolCount, so KOL_3plus coverage may be understated`);
  if (eligibleParentWithoutProbeRows > 0) reasons.push(`${eligibleParentWithoutProbeRows} KOL_3plus parent closes had no paired probe shadow close`);
  if (unpairedProbeRows > 0) reasons.push(`${unpairedProbeRows} probe shadow closes could not be joined to a parent close`);
  if (belowMinProbeRows > 0) reasons.push(`${belowMinProbeRows} below-min-KOL probe shadow closes are historical/research evidence only`);
  if (eligiblePairCoverage != null && eligiblePairCoverage < 0.95) reasons.push(`KOL_3plus probe coverage ${(eligiblePairCoverage * 100).toFixed(2)}% is below the 95% attribution target`);
  if (reasons.length === 0) reasons.push('KOL_3plus probe shadow funnel is fully attributed for this window');

  return {
    parentRows: parentRows.length,
    eligibleParentRows: eligibleParentIds.size,
    belowMinParentRows,
    unknownParentRows,
    probeRows: probeRows.length,
    eligibleProbeRows: probeRows.filter(isKol3Eligible).length,
    belowMinProbeRows,
    unknownProbeRows,
    pairedRows,
    eligiblePairedRows,
    eligibleParentWithoutProbeRows,
    unpairedProbeRows,
    allPairCoverage,
    eligiblePairCoverage,
    reasons,
  };
}

function missedAlphaPostMfe(row: JsonRow): number | null {
  const probe = nestedObject(row, 'probe');
  const delta = num(probe.deltaPct);
  const exitPrice = num(extrasOf(row).exitPrice);
  const signalPrice = valueNum(row, 'signalPrice');
  if (delta == null || exitPrice == null || signalPrice == null || exitPrice <= 0 || signalPrice <= 0) return null;
  const observedPrice = signalPrice * (1 + delta);
  return (observedPrice - exitPrice) / exitPrice;
}

function buildWinnerKillAudit(probeRows: JsonRow[], missedAlphaRows: JsonRow[]): ProbePolicyShadowWinnerKillAudit {
  const targetOffsetSec = 1800;
  const thresholdMfe = 4.0;
  const cutRows = probeRows.filter((row) => valueStr(row, 'exitReason') === 'probe_policy_confirm_fail_cut');
  const cutPositionIds = new Set(cutRows.map((row) => valueStr(row, 'positionId')).filter(Boolean));
  const maxPostMfeByPosition = new Map<string, { tokenMint: string; postMfe: number }>();

  for (const row of missedAlphaRows) {
    const extras = extrasOf(row);
    const positionId = str(extras.positionId);
    if (!positionId || !cutPositionIds.has(positionId)) continue;
    if (valueStr(row, 'rejectCategory') !== 'kol_close') continue;
    if (valueStr(row, 'rejectReason') !== 'probe_policy_confirm_fail_cut') continue;
    const probe = nestedObject(row, 'probe');
    if (num(probe.offsetSec) !== targetOffsetSec) continue;
    const postMfe = missedAlphaPostMfe(row);
    if (postMfe == null) continue;
    const prev = maxPostMfeByPosition.get(positionId);
    if (prev && prev.postMfe >= postMfe) continue;
    maxPostMfeByPosition.set(positionId, {
      tokenMint: valueStr(row, 'tokenMint'),
      postMfe,
    });
  }

  const examples = [...maxPostMfeByPosition.entries()]
    .map(([positionId, value]) => ({ positionId, tokenMint: value.tokenMint, postMfe: rounded(value.postMfe) ?? value.postMfe }))
    .filter((row) => row.postMfe >= thresholdMfe)
    .sort((a, b) => b.postMfe - a.postMfe)
    .slice(0, 5);
  const observedTargetRows = maxPostMfeByPosition.size;
  const winnerKillRows = [...maxPostMfeByPosition.values()].filter((value) => value.postMfe >= thresholdMfe).length;

  return {
    closeReason: 'probe_policy_confirm_fail_cut',
    targetOffsetSec,
    thresholdMfe,
    cutRows: cutRows.length,
    observedTargetRows,
    winnerKillRows,
    winnerKillRate: observedTargetRows === 0 ? null : rounded(winnerKillRows / observedTargetRows),
    observationCoverage: cutRows.length === 0 ? null : rounded(observedTargetRows / cutRows.length),
    examples,
  };
}

function stringValues(row: JsonRow, key: string): string[] {
  return valueArray(row, key).flatMap((value) => {
    if (typeof value === 'string') return [value];
    if (typeof value === 'object' && value != null) {
      const candidate = value as JsonRow;
      return [str(candidate.id), str(candidate.kolId), str(candidate.tier)]
        .filter(Boolean);
    }
    return [];
  });
}

function hasStrongKol(row: JsonRow): boolean {
  const participants = valueArray(row, 'participatingKols');
  for (const participant of participants) {
    if (typeof participant !== 'object' || participant == null) continue;
    const tier = str((participant as JsonRow).tier);
    if (tier === 'S') return true;
  }
  return stringValues(row, 'participatingKols').some((value) => value === 'S' || value.includes(':S'));
}

function qualityRiskLabel(row: JsonRow): string {
  const flags = valueArray(row, 'survivalFlags')
    .map((value) => typeof value === 'string' ? value : '')
    .filter(Boolean);
  const riskPattern = /NO_SELL_ROUTE|SECURITY|RUG|HONEYPOT|UNCLEAN|ENTRY_ADVANTAGE_ADVERSE|LOW_LIQUIDITY|DEV_RISK/i;
  return flags.some((flag) => riskPattern.test(flag)) ? 'quality:risk_flagged' : 'quality:clean_or_unknown';
}

function entryReasonLabel(row: JsonRow): string {
  const reason = valueStr(row, 'kolEntryReason') || valueStr(row, 'entryReason') || 'unknown';
  return `entry:${reason}`;
}

function tierLabel(row: JsonRow): string {
  if (hasStrongKol(row)) return 'tier:has_S';
  const participants = valueArray(row, 'participatingKols');
  return participants.length > 0 ? 'tier:no_S' : 'tier:unknown';
}

function buildQualitySplits(
  probeRows: JsonRow[],
  rowsByPositionId: Map<string, JsonRow>
): ProbePolicyShadowQualitySplit[] {
  const cohorts = new Map<string, JsonRow[]>();
  for (const probe of probeRows.filter(isKol3Eligible)) {
    for (const label of [qualityRiskLabel(probe), entryReasonLabel(probe), tierLabel(probe)]) {
      const rows = cohorts.get(label) ?? [];
      rows.push(probe);
      cohorts.set(label, rows);
    }
  }
  return [...cohorts.entries()]
    .map(([cohort, rows]) => ({
      cohort,
      pairedRows: buildComparison(rows, rowsByPositionId).pairedRows,
      stats: stats(rows),
      exitReasons: topExitReasons(rows),
    }))
    .sort((a, b) => b.stats.rows - a.stats.rows || a.cohort.localeCompare(b.cohort));
}

function parentArmForProbe(probe: JsonRow, rowsByPositionId: Map<string, JsonRow>): string {
  const parentPositionId = valueStr(probe, 'parentPositionId');
  const parent = parentPositionId ? rowsByPositionId.get(parentPositionId) : undefined;
  return parent ? valueStr(parent, 'armName') || 'unknown_parent' : 'unknown_parent';
}

function kolBucketForProbe(probe: JsonRow): string {
  const flags = valueArray(probe, 'survivalFlags')
    .map((value) => typeof value === 'string' ? value : '')
    .filter(Boolean);
  if (flags.some((flag) => flag.startsWith('SMART_V3_PROBE_BELOW_MIN_KOL_'))) {
    return 'kol:below_min';
  }
  const kols = valueNum(probe, 'independentKolCount');
  if (kols == null) return 'kol:unknown';
  if (kols >= 3) return 'kol:KOL_3plus';
  return `kol:KOL_${Math.max(0, Math.floor(kols))}`;
}

function buildCohortComparisons(
  probeRows: JsonRow[],
  rowsByPositionId: Map<string, JsonRow>
): ProbePolicyShadowCohortComparison[] {
  const cohorts = new Map<string, JsonRow[]>();
  for (const probe of probeRows) {
    const parentArm = parentArmForProbe(probe, rowsByPositionId);
    const labels = [
      `parent:${parentArm}`,
      kolBucketForProbe(probe),
    ];
    for (const label of labels) {
      const rows = cohorts.get(label) ?? [];
      rows.push(probe);
      cohorts.set(label, rows);
    }
  }
  return [...cohorts.entries()]
    .map(([cohort, rows]) => ({
      cohort,
      ...buildComparison(rows, rowsByPositionId),
    }))
    .sort((a, b) => b.pairedRows - a.pairedRows || a.cohort.localeCompare(b.cohort));
}

function verdictFor(comparison: ProbePolicyShadowComparison, args: ProbePolicyShadowArgs): ProbePolicyShadowVerdict {
  if (comparison.probe.rows < args.minCloses || comparison.pairedRows < args.minCloses) return 'COLLECT';
  if ((comparison.tailKillDelta ?? 0) > args.maxTailKillRate) return 'TAIL_KILL_RISK';
  if ((comparison.medianImprovement ?? 0) > 0 && (comparison.bigLossReduction ?? 0) > 0) return 'READY_FOR_REVIEW';
  return 'NO_IMPROVEMENT';
}

function buildPromotionGate(
  args: ProbePolicyShadowArgs,
  cohorts: ProbePolicyShadowCohortComparison[],
  funnel: ProbePolicyShadowFunnel,
  winnerKillAudit: ProbePolicyShadowWinnerKillAudit
): ProbePolicyShadowReport['promotionGate'] {
  const targetCohort = 'kol:KOL_3plus' as const;
  const target = cohorts.find((row) => row.cohort === targetCohort);
  const targetPairedCloses = target?.pairedRows ?? 0;
  const enoughTargetCloses = targetPairedCloses >= args.minCloses;
  const medianImprovement = target?.medianImprovement ?? null;
  const bigLossReduction = target?.bigLossReduction ?? null;
  const tailKillDelta = target?.tailKillDelta ?? null;
  const winnerKillCoverage = winnerKillAudit.observationCoverage;

  const checks: ProbePolicyShadowReport['promotionGate']['checks'] = [
    {
      name: 'forward_paper_min_closes',
      status: enoughTargetCloses ? 'PASS' : 'COLLECT',
      current: `${targetPairedCloses}`,
      required: `>=${args.minCloses} paired ${targetCohort} closes`,
    },
    {
      name: 'kol3_pair_coverage',
      status: funnel.eligiblePairCoverage != null && funnel.eligiblePairCoverage >= 0.95 ? 'PASS' : 'COLLECT',
      current: pctLabel(funnel.eligiblePairCoverage),
      required: '>=95.00%',
    },
    {
      name: 'median_improvement',
      status: !enoughTargetCloses ? 'COLLECT' : (medianImprovement != null && medianImprovement > 0 ? 'PASS' : 'FAIL'),
      current: pctLabel(medianImprovement),
      required: '>0.00%',
    },
    {
      name: 'big_loss_reduction',
      status: !enoughTargetCloses ? 'COLLECT' : (bigLossReduction != null && bigLossReduction > 0 ? 'PASS' : 'FAIL'),
      current: pctLabel(bigLossReduction),
      required: '>0.00%',
    },
    {
      name: 'tail50_kill_limit',
      status: !enoughTargetCloses ? 'COLLECT' : ((tailKillDelta ?? 0) <= args.maxTailKillRate ? 'PASS' : 'FAIL'),
      current: pctLabel(tailKillDelta),
      required: `<=${pctLabel(args.maxTailKillRate)}`,
    },
    {
      name: 'confirm_fail_winner_kill',
      status: winnerKillAudit.winnerKillRows > 0
        ? 'FAIL'
        : winnerKillAudit.cutRows > 0 && (winnerKillCoverage == null || winnerKillCoverage < 0.8)
          ? 'COLLECT'
          : 'PASS',
      current: `${winnerKillAudit.winnerKillRows} winner-kills / ${metricLabel(winnerKillCoverage == null ? null : rounded(winnerKillCoverage * winnerKillAudit.cutRows))} observed`,
      required: '0 winner-kills and >=80.00% observation coverage when cuts exist',
    },
  ];
  const hasFail = checks.some((check) => check.status === 'FAIL');
  const hasCollect = checks.some((check) => check.status === 'COLLECT');
  return {
    forwardPaperMinCloses: args.minCloses,
    livePromotionAllowed: false as const,
    requiresSeparateReview: true as const,
    targetCohort,
    targetPairedCloses,
    nextAction: hasFail
      ? 'BLOCK_PROMOTION_REVIEW_ROOT_CAUSE'
      : hasCollect
        ? 'COLLECT_FORWARD_PAPER'
        : 'BUILD_WALLET_TRUTH_REVIEW_PACKET',
    checks,
  };
}

function reasonsFor(report: Omit<ProbePolicyShadowReport, 'reasons'>): string[] {
  const reasons: string[] = [];
  if (report.verdict === 'COLLECT') reasons.push(`collect forward closes: paired ${report.pairedRows}/${report.minCloses}`);
  if (report.verdict === 'READY_FOR_REVIEW') reasons.push('probe shadow improved median and big-loss rate without breaching tail-kill limit');
  if (report.verdict === 'TAIL_KILL_RISK') reasons.push('probe shadow reduced too many +50% tail candidates versus parent');
  if (report.verdict === 'NO_IMPROVEMENT') reasons.push('probe shadow does not improve enough versus parent smart-v3 rows');
  if (report.winnerKillAudit.cutRows > 0 && (report.winnerKillAudit.observationCoverage ?? 0) < 0.8) {
    reasons.push('confirm-fail cut winner-kill audit has low missed-alpha coverage; tail safety is not proven yet');
  }
  if ((report.winnerKillAudit.winnerKillRows ?? 0) > 0) {
    reasons.push('confirm-fail cut has post-close 5x winner-kill examples; promotion requires stricter review');
  }
  reasons.push('Report-only. Live promotion is explicitly blocked until separate wallet-truth review.');
  return reasons;
}

export async function buildProbePolicyShadowReport(args: ProbePolicyShadowArgs): Promise<ProbePolicyShadowReport> {
  const paperRows = closeRowsSince(await readJsonl(path.join(args.realtimeDir, 'kol-paper-trades.jsonl')), args.sinceMs);
  const missedAlphaRows = closeRowsSince(await readJsonl(path.join(args.realtimeDir, 'missed-alpha.jsonl')), args.sinceMs);
  const rowsByPositionId = new Map<string, JsonRow>();
  for (const row of paperRows) {
    const positionId = valueStr(row, 'positionId');
    if (positionId) rowsByPositionId.set(positionId, row);
  }
  const probeRows = paperRows.filter(isProbeShadow);
  const parentRows = paperRows.filter(isParentRow);
  const comparison = buildComparison(probeRows, rowsByPositionId);
  const funnel = buildFunnel(parentRows, probeRows, rowsByPositionId);
  const winnerKillAudit = buildWinnerKillAudit(probeRows, missedAlphaRows);
  const cohorts = buildCohortComparisons(probeRows, rowsByPositionId);
  const qualitySplits = buildQualitySplits(probeRows, rowsByPositionId);
  const partial = {
    generatedAt: new Date().toISOString(),
    realtimeDir: args.realtimeDir,
    since: new Date(args.sinceMs).toISOString(),
    minCloses: args.minCloses,
    maxTailKillRate: args.maxTailKillRate,
    probeArm: PROBE_POLICY_SHADOW_ARM,
    parentArm: PROBE_POLICY_PARENT_ARM,
    parentArms: [...PROBE_POLICY_PARENT_ARMS],
    paperRows: paperRows.length,
    probeRows: probeRows.length,
    parentRows: parentRows.length,
    pairedRows: comparison.pairedRows,
    funnel,
    winnerKillAudit,
    comparison,
    cohorts,
    qualitySplits,
    exitReasons: countExitReasons(probeRows),
    verdict: verdictFor(comparison, args),
    promotionGate: buildPromotionGate(args, cohorts, funnel, winnerKillAudit),
  };
  return {
    ...partial,
    reasons: reasonsFor(partial),
  };
}
