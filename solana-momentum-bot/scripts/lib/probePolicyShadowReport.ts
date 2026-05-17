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
  type ProbePolicyShadowReport,
  type ProbePolicyShadowStats,
  type ProbePolicyShadowVerdict,
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
  for (const key of ['closedAt', 'exitAt', 'recordedAt', 'openedAt']) {
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

function reasonsFor(report: Omit<ProbePolicyShadowReport, 'reasons'>): string[] {
  const reasons: string[] = [];
  if (report.verdict === 'COLLECT') reasons.push(`collect forward closes: paired ${report.pairedRows}/${report.minCloses}`);
  if (report.verdict === 'READY_FOR_REVIEW') reasons.push('probe shadow improved median and big-loss rate without breaching tail-kill limit');
  if (report.verdict === 'TAIL_KILL_RISK') reasons.push('probe shadow reduced too many +50% tail candidates versus parent');
  if (report.verdict === 'NO_IMPROVEMENT') reasons.push('probe shadow does not improve enough versus parent smart-v3 rows');
  reasons.push('Report-only. Live promotion is explicitly blocked until separate wallet-truth review.');
  return reasons;
}

export async function buildProbePolicyShadowReport(args: ProbePolicyShadowArgs): Promise<ProbePolicyShadowReport> {
  const paperRows = closeRowsSince(await readJsonl(path.join(args.realtimeDir, 'kol-paper-trades.jsonl')), args.sinceMs);
  const rowsByPositionId = new Map<string, JsonRow>();
  for (const row of paperRows) {
    const positionId = valueStr(row, 'positionId');
    if (positionId) rowsByPositionId.set(positionId, row);
  }
  const probeRows = paperRows.filter(isProbeShadow);
  const parentRows = paperRows.filter(isParentRow);
  const comparison = buildComparison(probeRows, rowsByPositionId);
  const cohorts = buildCohortComparisons(probeRows, rowsByPositionId);
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
    comparison,
    cohorts,
    exitReasons: countExitReasons(probeRows),
    verdict: verdictFor(comparison, args),
    promotionGate: {
      forwardPaperMinCloses: args.minCloses,
      livePromotionAllowed: false as const,
      requiresSeparateReview: true as const,
    },
  };
  return {
    ...partial,
    reasons: reasonsFor(partial),
  };
}
