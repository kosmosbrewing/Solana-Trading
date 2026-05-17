import path from 'path';
import {
  num,
  readJsonl,
  str,
} from './markoutCandidateStore';
import {
  SMART_V3_FAST_FAIL_LIVE_ARM,
  SMART_V3_FAST_FAIL_LIVE_MIRROR_ARM,
  type KolLiveMirrorArgs,
  type KolLiveMirrorPair,
  type KolLiveMirrorReport,
  type KolLiveMirrorStats,
  type LiveMirrorClassification,
  type LiveMirrorVerdict,
} from './kolLiveMirrorTypes';

interface JsonRow {
  [key: string]: unknown;
}

const CLASSIFICATIONS: LiveMirrorClassification[] = [
  'strategy_loss',
  'execution_drag',
  'strategy_win_execution_ok',
  'paper_false_negative',
];

function extrasOf(row: JsonRow): JsonRow {
  return typeof row.extras === 'object' && row.extras != null ? row.extras as JsonRow : {};
}

function valueStr(row: JsonRow, key: string): string {
  return str(row[key]) || str(extrasOf(row)[key]);
}

function valueNum(row: JsonRow, key: string): number | null {
  return num(row[key]) ?? num(extrasOf(row)[key]);
}

function firstNum(row: JsonRow, keys: string[]): number | null {
  for (const key of keys) {
    const value = valueNum(row, key);
    if (value != null) return value;
  }
  return null;
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

function closeRowsSince(rows: JsonRow[], sinceMs: number): JsonRow[] {
  return rows.filter((row) => {
    const atMs = rowTimeMs(row);
    return Number.isFinite(atMs) && atMs >= sinceMs;
  });
}

function rounded(value: number | null): number | null {
  return value == null ? null : Number(value.toFixed(6));
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

function stats(rows: KolLiveMirrorPair[], mode: 'live' | 'mirror'): KolLiveMirrorStats {
  const netSols = rows.map((row) => mode === 'live' ? row.liveNetSol : row.mirrorNetSol);
  const netPcts = rows
    .map((row) => mode === 'live' ? row.liveNetPct : row.mirrorNetPct)
    .filter((value): value is number => value != null);
  const mfes = rows
    .map((row) => mode === 'live' ? row.liveMfePct : row.mirrorMfePct)
    .filter((value): value is number => value != null);
  const holds = rows
    .map((row) => mode === 'live' ? row.liveHoldSec : row.mirrorHoldSec)
    .filter((value): value is number => value != null);
  return {
    rows: rows.length,
    netSol: rounded(netSols.reduce((sum, value) => sum + value, 0)) ?? 0,
    medianNetSol: rounded(median(netSols)),
    medianNetPct: rounded(median(netPcts)),
    positiveRate: rounded(rate(netSols, (value) => value > 0)),
    medianMfePct: rounded(median(mfes)),
    medianHoldSec: rounded(median(holds)),
  };
}

function classifyPair(liveNetSol: number, mirrorNetSol: number): LiveMirrorClassification {
  if (liveNetSol <= 0 && mirrorNetSol <= 0) return 'strategy_loss';
  if (liveNetSol <= 0 && mirrorNetSol > 0) return 'execution_drag';
  if (liveNetSol > 0 && mirrorNetSol > 0) return 'strategy_win_execution_ok';
  return 'paper_false_negative';
}

function buildPairs(liveRows: JsonRow[], mirrorRows: JsonRow[]): KolLiveMirrorPair[] {
  const liveByPositionId = new Map<string, JsonRow>();
  for (const row of liveRows) {
    const positionId = valueStr(row, 'positionId');
    if (positionId) liveByPositionId.set(positionId, row);
  }
  const pairs: KolLiveMirrorPair[] = [];
  for (const mirror of mirrorRows) {
    const parentPositionId = valueStr(mirror, 'parentPositionId');
    const live = parentPositionId ? liveByPositionId.get(parentPositionId) : undefined;
    if (!live) continue;
    const liveNetSol = firstNum(live, ['netSol', 'walletDeltaSol', 'dbPnlSol']) ?? 0;
    const mirrorNetSol = firstNum(mirror, ['netSolTokenOnly', 'netSol']) ?? 0;
    const liveNetPct = firstNum(live, ['netPct', 'netPctTokenOnly']);
    const mirrorNetPct = firstNum(mirror, ['netPctTokenOnly', 'netPct']);
    const deltaNetPct = liveNetPct != null && mirrorNetPct != null
      ? rounded(mirrorNetPct - liveNetPct)
      : null;
    pairs.push({
      livePositionId: parentPositionId,
      mirrorPositionId: valueStr(mirror, 'positionId'),
      tokenMint: valueStr(live, 'tokenMint') || valueStr(mirror, 'tokenMint') || null,
      decisionId: valueStr(live, 'liveEquivalenceDecisionId') || valueStr(mirror, 'liveEquivalenceDecisionId') || null,
      liveExitReason: valueStr(live, 'exitReason') || 'unknown',
      mirrorExitReason: valueStr(mirror, 'exitReason') || 'unknown',
      liveNetSol,
      mirrorNetSol,
      liveNetPct,
      mirrorNetPct,
      liveMfePct: firstNum(live, ['mfePctPeakTokenOnly', 'mfePctPeak', 'mfePct']),
      mirrorMfePct: firstNum(mirror, ['mfePctPeakTokenOnly', 'mfePctPeak', 'mfePct']),
      liveHoldSec: valueNum(live, 'holdSec'),
      mirrorHoldSec: valueNum(mirror, 'holdSec'),
      liveClosedAt: valueStr(live, 'closedAt') || null,
      mirrorClosedAt: valueStr(mirror, 'closedAt') || null,
      deltaNetSol: rounded(mirrorNetSol - liveNetSol) ?? 0,
      deltaNetPct,
      classification: classifyPair(liveNetSol, mirrorNetSol),
    });
  }
  return pairs.sort((a, b) => (a.liveClosedAt ?? '').localeCompare(b.liveClosedAt ?? ''));
}

function classificationCounts(pairs: KolLiveMirrorPair[]): Record<LiveMirrorClassification, number> {
  const counts = Object.fromEntries(CLASSIFICATIONS.map((key) => [key, 0])) as Record<LiveMirrorClassification, number>;
  for (const pair of pairs) counts[pair.classification] += 1;
  return counts;
}

function classificationRates(
  counts: Record<LiveMirrorClassification, number>,
  total: number
): Record<LiveMirrorClassification, number | null> {
  return Object.fromEntries(
    CLASSIFICATIONS.map((key) => [key, total > 0 ? rounded(counts[key] / total) : null])
  ) as Record<LiveMirrorClassification, number | null>;
}

function verdictFor(
  pairs: KolLiveMirrorPair[],
  live: KolLiveMirrorStats,
  mirror: KolLiveMirrorStats,
  rates: Record<LiveMirrorClassification, number | null>,
  args: KolLiveMirrorArgs
): LiveMirrorVerdict {
  if (pairs.length < args.minPairs) return 'COLLECT';
  if ((rates.execution_drag ?? 0) >= args.executionDragRate && live.netSol < 0 && mirror.netSol > live.netSol) {
    return 'EXECUTION_DRAG_REVIEW';
  }
  if ((rates.strategy_loss ?? 0) >= args.strategyLossRate && live.netSol < 0 && mirror.netSol <= 0) {
    return 'STRATEGY_LOSS_REVIEW';
  }
  if (mirror.netSol > 0 && (mirror.positiveRate ?? 0) >= 0.5) return 'MIRROR_HEALTHY_REVIEW';
  return 'NO_CLEAR_SIGNAL';
}

function reasonsFor(report: Omit<KolLiveMirrorReport, 'reasons'>): string[] {
  const reasons: string[] = [];
  if (report.verdict === 'COLLECT') reasons.push(`collect paired closes: ${report.pairedRows}/${report.minPairs}`);
  if (report.verdict === 'EXECUTION_DRAG_REVIEW') {
    reasons.push('live wallet losses diverge from same-decision paper mirror; inspect fees, slippage, routing, and wallet drag');
  }
  if (report.verdict === 'STRATEGY_LOSS_REVIEW') {
    reasons.push('live and same-decision mirror both lose; treat this as strategy/exit-policy loss, not execution-only drag');
  }
  if (report.verdict === 'MIRROR_HEALTHY_REVIEW') {
    reasons.push('paper mirror is healthy enough for policy review, but live promotion is still blocked');
  }
  if (report.verdict === 'NO_CLEAR_SIGNAL') reasons.push('paired live/mirror rows do not isolate a dominant cause yet');
  if (report.liveWithoutMirrorRows > 0) reasons.push(`live closes without closed mirror: ${report.liveWithoutMirrorRows}`);
  if (report.unpairedMirrorRows > 0) reasons.push(`mirror closes without live parent close: ${report.unpairedMirrorRows}`);
  reasons.push('Report-only. Live promotion is blocked until separate wallet-truth review.');
  return reasons;
}

export async function buildKolLiveMirrorReport(args: KolLiveMirrorArgs): Promise<KolLiveMirrorReport> {
  const [rawLiveRows, rawPaperRows] = await Promise.all([
    readJsonl(path.join(args.realtimeDir, 'kol-live-trades.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'kol-paper-trades.jsonl')),
  ]);
  const liveRows = closeRowsSince(rawLiveRows, args.sinceMs)
    .filter((row) => valueStr(row, 'armName') === SMART_V3_FAST_FAIL_LIVE_ARM);
  const mirrorRows = closeRowsSince(rawPaperRows, args.sinceMs)
    .filter((row) =>
      valueStr(row, 'armName') === SMART_V3_FAST_FAIL_LIVE_MIRROR_ARM &&
      valueStr(row, 'paperRole') === 'mirror'
    );
  const pairs = buildPairs(liveRows, mirrorRows);
  const pairedLiveIds = new Set(pairs.map((pair) => pair.livePositionId));
  const pairedMirrorIds = new Set(pairs.map((pair) => pair.mirrorPositionId));
  const liveStats = stats(pairs, 'live');
  const mirrorStats = stats(pairs, 'mirror');
  const counts = classificationCounts(pairs);
  const rates = classificationRates(counts, pairs.length);
  const partial = {
    generatedAt: new Date().toISOString(),
    realtimeDir: args.realtimeDir,
    since: new Date(args.sinceMs).toISOString(),
    liveArm: SMART_V3_FAST_FAIL_LIVE_ARM,
    mirrorArm: SMART_V3_FAST_FAIL_LIVE_MIRROR_ARM,
    minPairs: args.minPairs,
    paperRows: rawPaperRows.length,
    liveRows: liveRows.length,
    mirrorRows: mirrorRows.length,
    pairedRows: pairs.length,
    unpairedMirrorRows: mirrorRows.filter((row) => !pairedMirrorIds.has(valueStr(row, 'positionId'))).length,
    liveWithoutMirrorRows: liveRows.filter((row) => !pairedLiveIds.has(valueStr(row, 'positionId'))).length,
    live: liveStats,
    mirror: mirrorStats,
    deltas: {
      medianNetPct: liveStats.medianNetPct != null && mirrorStats.medianNetPct != null
        ? rounded(mirrorStats.medianNetPct - liveStats.medianNetPct)
        : null,
      medianNetSol: liveStats.medianNetSol != null && mirrorStats.medianNetSol != null
        ? rounded(mirrorStats.medianNetSol - liveStats.medianNetSol)
        : null,
      positiveRate: liveStats.positiveRate != null && mirrorStats.positiveRate != null
        ? rounded(mirrorStats.positiveRate - liveStats.positiveRate)
        : null,
    },
    classifications: counts,
    classificationRates: rates,
    topExecutionDrags: pairs
      .filter((pair) => pair.classification === 'execution_drag')
      .sort((a, b) => b.deltaNetSol - a.deltaNetSol)
      .slice(0, 10),
    topStrategyLosses: pairs
      .filter((pair) => pair.classification === 'strategy_loss')
      .sort((a, b) => (a.liveNetSol + a.mirrorNetSol) - (b.liveNetSol + b.mirrorNetSol))
      .slice(0, 10),
    verdict: 'COLLECT' as LiveMirrorVerdict,
    promotionGate: {
      livePromotionAllowed: false as const,
      requiresSeparateWalletTruthReview: true as const,
    },
  };
  const withVerdict = {
    ...partial,
    verdict: verdictFor(pairs, liveStats, mirrorStats, rates, args),
  };
  return {
    ...withVerdict,
    reasons: reasonsFor(withVerdict),
  };
}
