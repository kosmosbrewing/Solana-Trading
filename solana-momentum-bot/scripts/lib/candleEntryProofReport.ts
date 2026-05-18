import { createReadStream } from 'fs';
import { mkdir, readdir, writeFile } from 'fs/promises';
import path from 'path';
import readline from 'readline';
import {
  type CandleAnchorFeatureRow,
  type CandleEntryProofArgs,
  type CandleEntryProofReport,
  type CandleHorizonOutcome,
  type CandleProofArmEvaluation,
  type CandleProofArmRole,
  type CandleCoverageGroupSummary,
  type CandleProofFoldSummary,
  type CandleProofReentryCluster,
  type CandleProofVerdict,
  type CandleWindowFeature,
} from './candleEntryProofTypes';
import {
  anchorKey,
  compactReturns,
  num,
  readJsonl,
  rounded,
  str,
  summarizeReturns,
} from './markoutCandidateStore';

interface JsonRow {
  [key: string]: unknown;
}

interface CandleRow {
  tokenMint: string;
  timestampMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  buyVolume: number;
  sellVolume: number;
  tradeCount: number;
}

interface AnchorWork {
  key: string;
  positionId: string;
  tokenMint: string;
  anchorAt: string;
  anchorAtMs: number;
  day: string;
  source: string;
  family: string;
  mode: string;
  kolBucket: string;
  anchorPrice: number;
  quoteDeltas: Map<number, number>;
  candles: CandleRow[];
  tokenCandleRows?: number;
  tokenFirstCandleMs?: number | null;
  tokenLastCandleMs?: number | null;
}

interface TokenCandleStats {
  rows: number;
  firstMs: number;
  lastMs: number;
}

const FOLDS = [
  { name: 'A', start: '2026-04-21', end: '2026-04-27' },
  { name: 'B', start: '2026-04-28', end: '2026-05-04' },
  { name: 'C', start: '2026-05-05', end: '2026-05-11' },
  { name: 'D', start: '2026-05-12', end: '2026-05-18' },
] as const;

const MAX_REASONABLE_CANDLE_RETURN_PCT = 50;

function extrasOf(row: JsonRow): JsonRow {
  return typeof row.extras === 'object' && row.extras != null ? row.extras as JsonRow : {};
}

function sourceFamily(source: string): string {
  if (source.includes('rotation')) return 'rotation';
  if (source.includes('smart')) return 'smart_v3';
  if (source.includes('pure_ws')) return 'pure_ws';
  if (source.includes('kol_hunter')) return 'kol_hunter_other';
  return source || 'unknown';
}

function kolBucket(extras: JsonRow): string {
  const count = num(extras.independentKolCount) ?? num(extras.effectiveIndependentCount) ?? num(extras.kolCount);
  if (count == null) return 'KOL_unknown';
  if (count <= 1) return 'KOL_1';
  if (count === 2) return 'KOL_2';
  return 'KOL_3plus';
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function pct(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : rounded(value);
}

function rate(count: number, total: number): number | null {
  return total > 0 ? rounded(count / total) : null;
}

function postCost(value: number | null, cost: number): number | null {
  return value == null ? null : value - cost;
}

function saneReturn(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.abs(value) <= MAX_REASONABLE_CANDLE_RETURN_PCT ? pct(value) : null;
}

function parseCandle(line: string): CandleRow | null {
  try {
    const row = JSON.parse(line) as JsonRow;
    if (num(row.intervalSec) !== 5) return null;
    const tokenMint = str(row.tokenMint);
    const timestampMs = Date.parse(str(row.timestamp));
    const open = num(row.open);
    const high = num(row.high);
    const low = num(row.low);
    const close = num(row.close);
    if (!tokenMint || !Number.isFinite(timestampMs) || open == null || high == null || low == null || close == null) {
      return null;
    }
    return {
      tokenMint,
      timestampMs,
      open,
      high,
      low,
      close,
      buyVolume: num(row.buyVolume) ?? 0,
      sellVolume: num(row.sellVolume) ?? 0,
      tradeCount: Math.max(0, num(row.tradeCount) ?? 0),
    };
  } catch {
    return null;
  }
}

async function listFiles(root: string, fileName: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name === fileName) out.push(full);
    }
  }
  await walk(root);
  return out.sort();
}

function buildQuoteDeltas(markoutRows: JsonRow[]): Map<string, Map<number, number>> {
  const byAnchor = new Map<string, Map<number, number>>();
  for (const row of markoutRows) {
    if (str(row.anchorType) !== 'buy' || str(row.quoteStatus) !== 'ok') continue;
    const horizon = num(row.horizonSec);
    const delta = num(row.deltaPct);
    if (horizon == null || delta == null) continue;
    const key = anchorKey(row);
    if (!byAnchor.has(key)) byAnchor.set(key, new Map());
    byAnchor.get(key)?.set(horizon, delta);
  }
  return byAnchor;
}

function buildAnchors(anchorRows: JsonRow[], markoutRows: JsonRow[]): AnchorWork[] {
  const quoteDeltas = buildQuoteDeltas(markoutRows);
  const anchors: AnchorWork[] = [];
  for (const row of anchorRows) {
    if (str(row.anchorType) !== 'buy') continue;
    const positionId = str(row.positionId);
    const tokenMint = str(row.tokenMint);
    const anchorAt = str(row.anchorAt);
    const anchorAtMs = Date.parse(anchorAt);
    const anchorPrice = num(row.anchorPrice);
    if (!positionId || !tokenMint || !Number.isFinite(anchorAtMs) || anchorPrice == null || anchorPrice <= 0) continue;
    const extras = extrasOf(row);
    const source = str(row.signalSource) || 'unknown';
    anchors.push({
      key: anchorKey(row),
      positionId,
      tokenMint,
      anchorAt,
      anchorAtMs,
      day: dayOf(anchorAtMs),
      source,
      family: sourceFamily(source),
      mode: str(extras.mode) || (positionId.includes('-live-') ? 'live' : 'paper_or_unknown'),
      kolBucket: kolBucket(extras),
      anchorPrice,
      quoteDeltas: quoteDeltas.get(anchorKey(row)) ?? new Map(),
      candles: [],
    });
  }
  return anchors;
}

async function attachCandles(
  anchors: AnchorWork[],
  sessionsDir: string,
  preWindowSec: number,
  postWindowSec: number,
  maxCandles?: number
): Promise<{ candleFiles: number; candleRowsScanned: number; tokenStats: Map<string, TokenCandleStats> }> {
  const byToken = new Map<string, AnchorWork[]>();
  const tokenStats = new Map<string, TokenCandleStats>();
  for (const anchor of anchors) {
    const arr = byToken.get(anchor.tokenMint) ?? [];
    arr.push(anchor);
    byToken.set(anchor.tokenMint, arr);
  }
  for (const arr of byToken.values()) arr.sort((a, b) => a.anchorAtMs - b.anchorAtMs);
  const finalize = (): void => {
    for (const anchor of anchors) {
      const stats = tokenStats.get(anchor.tokenMint);
      anchor.tokenCandleRows = stats?.rows ?? 0;
      anchor.tokenFirstCandleMs = stats?.firstMs ?? null;
      anchor.tokenLastCandleMs = stats?.lastMs ?? null;
    }
  };

  const files = await listFiles(sessionsDir, 'micro-candles.jsonl');
  let scanned = 0;
  for (const file of files) {
    const rl = readline.createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (maxCandles != null && scanned >= maxCandles) {
        rl.close();
        finalize();
        return { candleFiles: files.length, candleRowsScanned: scanned, tokenStats };
      }
      scanned += 1;
      const candle = parseCandle(String(line));
      if (!candle) continue;
      const tokenAnchors = byToken.get(candle.tokenMint);
      if (!tokenAnchors) continue;
      const stats = tokenStats.get(candle.tokenMint);
      if (stats) {
        stats.rows += 1;
        stats.firstMs = Math.min(stats.firstMs, candle.timestampMs);
        stats.lastMs = Math.max(stats.lastMs, candle.timestampMs);
      } else {
        tokenStats.set(candle.tokenMint, {
          rows: 1,
          firstMs: candle.timestampMs,
          lastMs: candle.timestampMs,
        });
      }
      for (const anchor of tokenAnchors) {
        if (candle.timestampMs < anchor.anchorAtMs - preWindowSec * 1000) continue;
        if (candle.timestampMs > anchor.anchorAtMs + postWindowSec * 1000) continue;
        anchor.candles.push(candle);
      }
    }
  }
  finalize();
  return { candleFiles: files.length, candleRowsScanned: scanned, tokenStats };
}

function dedupeAndSort(candles: CandleRow[]): CandleRow[] {
  const byTs = new Map<number, CandleRow>();
  for (const candle of candles) byTs.set(candle.timestampMs, candle);
  return [...byTs.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

function buildWindowFeature(candles: CandleRow[], anchorAtMs: number, windowSec: number): CandleWindowFeature {
  const startMs = anchorAtMs - windowSec * 1000;
  const rows = candles.filter((candle) => candle.timestampMs >= startMs && candle.timestampMs <= anchorAtMs);
  const tradeCount = rows.reduce((sum, candle) => sum + candle.tradeCount, 0);
  const buyVolume = rows.reduce((sum, candle) => sum + candle.buyVolume, 0);
  const sellVolume = rows.reduce((sum, candle) => sum + candle.sellVolume, 0);
  const first = rows[0];
  const last = rows[rows.length - 1];
  const highs = rows.map((row) => row.high);
  const lows = rows.map((row) => row.low);
  const high = highs.length > 0 ? Math.max(...highs) : null;
  const low = lows.length > 0 ? Math.min(...lows) : null;
  const candleReturns = rows
    .map((row) => (row.open > 0 ? row.close / row.open - 1 : null))
    .filter((value): value is number => value != null && Number.isFinite(value));
  const range = high != null && low != null ? high - low : null;
  return {
    rows: rows.length,
    tradeCount,
    buyVolume: rounded(buyVolume) ?? 0,
    sellVolume: rounded(sellVolume) ?? 0,
    buyRatio: buyVolume + sellVolume > 0 ? pct(buyVolume / (buyVolume + sellVolume)) : null,
    returnPct: first && last && first.open > 0 ? pct(last.close / first.open - 1) : null,
    maxAbsReturnPct: candleReturns.length > 0 ? pct(Math.max(...candleReturns.map((value) => Math.abs(value)))) : null,
    realizedAbsSumPct: candleReturns.length > 0 ? pct(candleReturns.reduce((sum, value) => sum + Math.abs(value), 0)) : null,
    upCloseShare: rate(candleReturns.filter((value) => value > 0).length, candleReturns.length),
    downCloseShare: rate(candleReturns.filter((value) => value < 0).length, candleReturns.length),
    terminalPosInRange: last && low != null && range != null && range > 0 ? pct((last.close - low) / range) : null,
  };
}

function buildHorizonOutcome(
  candles: CandleRow[],
  anchor: AnchorWork,
  horizonSec: number
): CandleHorizonOutcome {
  const endMs = anchor.anchorAtMs + horizonSec * 1000;
  const rows = candles.filter((candle) => candle.timestampMs > anchor.anchorAtMs && candle.timestampMs <= endMs);
  const last = rows[rows.length - 1];
  const maxHigh = rows.length > 0 ? Math.max(...rows.map((row) => row.high)) : null;
  const minLow = rows.length > 0 ? Math.min(...rows.map((row) => row.low)) : null;
  return {
    horizonSec,
    closePct: last ? saneReturn(last.close / anchor.anchorPrice - 1) : null,
    mfePct: maxHigh != null ? saneReturn(maxHigh / anchor.anchorPrice - 1) : null,
    maePct: minLow != null ? saneReturn(minLow / anchor.anchorPrice - 1) : null,
    quoteDeltaPct: pct(anchor.quoteDeltas.get(horizonSec) ?? null),
  };
}

function isoOrNull(ms: number | null | undefined): string | null {
  return ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

function buildCoverageReason(
  anchor: AnchorWork,
  pre60Rows: number,
  outcome300: CandleHorizonOutcome | undefined
): { reason: string; detail: string } {
  const hasPre = pre60Rows > 0;
  const hasOutcome = outcome300?.closePct != null;
  if (hasPre && hasOutcome) return { reason: 'covered', detail: 'pre60_and_t300_present' };
  const first = anchor.tokenFirstCandleMs ?? null;
  const last = anchor.tokenLastCandleMs ?? null;
  if ((anchor.tokenCandleRows ?? 0) <= 0 || first == null || last == null) {
    return { reason: 'no_token_candles', detail: 'no 5s candle rows for this token in scanned sessions' };
  }
  if (!hasPre && !hasOutcome) {
    if (first > anchor.anchorAtMs + 300_000) {
      return { reason: 'candles_start_after_horizon', detail: `first=${isoOrNull(first)}` };
    }
    if (last < anchor.anchorAtMs - 60_000) {
      return { reason: 'candles_end_before_pre_window', detail: `last=${isoOrNull(last)}` };
    }
    if (first > anchor.anchorAtMs) {
      return { reason: 'candles_start_after_anchor', detail: `first=${isoOrNull(first)}` };
    }
    if (last < anchor.anchorAtMs) {
      return { reason: 'candles_end_before_anchor', detail: `last=${isoOrNull(last)}` };
    }
    return { reason: 'candle_gap_around_anchor', detail: `first=${isoOrNull(first)} last=${isoOrNull(last)}` };
  }
  if (!hasPre) return { reason: 'pre_window_missing', detail: `first=${isoOrNull(first)} last=${isoOrNull(last)}` };
  return { reason: 'post_window_missing', detail: `first=${isoOrNull(first)} last=${isoOrNull(last)}` };
}

function buildAnchorRows(
  anchors: AnchorWork[],
  preWindowsSec: number[],
  horizonsSec: number[]
): CandleAnchorFeatureRow[] {
  return anchors.map((anchor) => {
    const candles = dedupeAndSort(anchor.candles);
    const pre: Record<string, CandleWindowFeature> = {};
    const outcomes: Record<string, CandleHorizonOutcome> = {};
    for (const windowSec of preWindowsSec) {
      pre[String(windowSec)] = buildWindowFeature(candles, anchor.anchorAtMs, windowSec);
    }
    for (const horizonSec of horizonsSec) {
      outcomes[String(horizonSec)] = buildHorizonOutcome(candles, anchor, horizonSec);
    }
    const coverage = buildCoverageReason(anchor, pre['60']?.rows ?? 0, outcomes['300']);
    return {
      key: anchor.key,
      positionId: anchor.positionId,
      tokenMint: anchor.tokenMint,
      anchorAt: anchor.anchorAt,
      anchorAtMs: anchor.anchorAtMs,
      day: anchor.day,
      source: anchor.source,
      family: anchor.family,
      mode: anchor.mode,
      kolBucket: anchor.kolBucket,
      anchorPrice: anchor.anchorPrice,
      tokenCandleRows: anchor.tokenCandleRows ?? 0,
      tokenFirstCandleAt: isoOrNull(anchor.tokenFirstCandleMs),
      tokenLastCandleAt: isoOrNull(anchor.tokenLastCandleMs),
      coverageReason: coverage.reason,
      coverageDetail: coverage.detail,
      pre,
      outcomes,
    };
  });
}

function outcome(row: CandleAnchorFeatureRow, horizon: number): CandleHorizonOutcome | null {
  return row.outcomes[String(horizon)] ?? null;
}

function closeReturn(row: CandleAnchorFeatureRow, horizon: number, cost: number): number | null {
  return postCost(outcome(row, horizon)?.closePct ?? null, cost);
}

function maxLossStreak(rows: CandleAnchorFeatureRow[], returns: Map<string, number>): number {
  let current = 0;
  let max = 0;
  for (const row of [...rows].sort((a, b) => a.anchorAtMs - b.anchorAtMs)) {
    const value = returns.get(row.key);
    if (value == null) continue;
    if (value <= 0) current += 1;
    else current = 0;
    max = Math.max(max, current);
  }
  return max;
}

function topWinnerShare(values: number[], topN: number): number | null {
  const positives = values.filter((value) => value > 0).sort((a, b) => b - a);
  const total = positives.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  return rounded(positives.slice(0, topN).reduce((sum, value) => sum + value, 0) / total);
}

function evaluateRows(
  arm: string,
  role: CandleProofArmRole,
  family: string,
  selectedRows: CandleAnchorFeatureRow[],
  parentRows: CandleAnchorFeatureRow[],
  returnByKey: Map<string, number>,
  cost: number,
  minRows: number,
  blockedRows = 0,
  winnerLeakage12Rate: number | null = null
): CandleProofArmEvaluation {
  const selectedPairs = selectedRows.flatMap((row) => {
    const value = returnByKey.get(row.key) ?? closeReturn(row, 300, cost);
    return value == null ? [] : [{ row, value }];
  });
  const selectedValues = selectedPairs.map((pair) => pair.value);
  const parentValues = compactReturns(parentRows.map((row) => closeReturn(row, 300, cost)));
  const stats = summarizeReturns(selectedValues);
  const parentStats = summarizeReturns(parentValues);
  const medianDelta = stats.median != null && parentStats.median != null ? rounded(stats.median - parentStats.median) : null;
  const parentLose20 = parentStats.leNeg20Rate;
  const lose20Reduction = parentLose20 != null && parentLose20 > 0 && stats.leNeg20Rate != null
    ? rounded((parentLose20 - stats.leNeg20Rate) / parentLose20)
    : null;
  const returns = new Map<string, number>();
  selectedPairs.forEach((pair) => returns.set(pair.row.key, pair.value));
  const activeDays = new Set(selectedRows.map((row) => row.day)).size;
  const reasons: string[] = [];
  let verdict: CandleProofVerdict = 'COLLECT';
  if (selectedRows.length < minRows || activeDays < 3) {
    verdict = 'DATA_GAP';
    reasons.push(`sample rows/days below proof floor (${selectedRows.length}/${activeDays})`);
  } else {
    if ((medianDelta ?? 0) > 0) reasons.push('median improves vs parent');
    if ((lose20Reduction ?? 0) > 0) reasons.push('left-tail loss rate improves vs parent');
    if ((stats.median ?? -Infinity) < 0 && role !== 'veto_trigger') reasons.push('post-cost median still negative');
    if ((topWinnerShare(selectedValues, 5) ?? 0) > 0.35) reasons.push('top5 winner concentration exceeds 35%');
    if ((medianDelta ?? -Infinity) > 0 && (lose20Reduction ?? -Infinity) > 0 && (topWinnerShare(selectedValues, 5) ?? 0) <= 0.35) {
      verdict = 'CANDIDATE';
    }
    if ((medianDelta ?? 0) < 0 && (lose20Reduction ?? 0) < 0) verdict = 'REJECT';
  }
  return {
    arm,
    role,
    family,
    rows: selectedRows.length,
    activeDays,
    parentRows: parentRows.length,
    blockedRows,
    stats,
    parentStats,
    medianDeltaVsParent: medianDelta,
    lose20ReductionVsParent: lose20Reduction,
    maxLossStreak: maxLossStreak(selectedRows, returns),
    top5WinnerShare: topWinnerShare(selectedValues, 5),
    top10WinnerShare: topWinnerShare(selectedValues, 10),
    winnerLeakage12Rate,
    verdict,
    reasons,
  };
}

function preStable(row: CandleAnchorFeatureRow): boolean {
  const f = row.pre['60'];
  return !!f &&
    f.tradeCount >= 6 &&
    (f.buyRatio ?? -Infinity) >= 0.55 &&
    (f.returnPct ?? -Infinity) >= 0 &&
    (f.maxAbsReturnPct ?? Infinity) <= 0.03 &&
    (f.downCloseShare ?? Infinity) <= 0.4;
}

function strongerPreStable(row: CandleAnchorFeatureRow): boolean {
  const f = row.pre['60'];
  return !!f &&
    f.tradeCount >= 6 &&
    (f.buyRatio ?? -Infinity) >= 0.6 &&
    (f.returnPct ?? -Infinity) >= 0.005 &&
    (f.maxAbsReturnPct ?? Infinity) <= 0.02 &&
    (f.downCloseShare ?? Infinity) <= 0.35;
}

function doa15(row: CandleAnchorFeatureRow): boolean {
  const o = outcome(row, 15);
  return (o?.mfePct ?? Infinity) < 0.015 && (o?.closePct ?? Infinity) <= 0;
}

function fail30(row: CandleAnchorFeatureRow): boolean {
  const o = outcome(row, 30);
  return (o?.mfePct ?? Infinity) < 0.02 && (o?.closePct ?? Infinity) < 0;
}

function pass30(row: CandleAnchorFeatureRow): boolean {
  const o = outcome(row, 30);
  return (o?.mfePct ?? -Infinity) >= 0.02 && (o?.closePct ?? -Infinity) > 0;
}

function trailReturn(row: CandleAnchorFeatureRow, cost: number): number | null {
  if (!pass30(row)) return null;
  const mfe30 = outcome(row, 30)?.mfePct;
  const close300 = outcome(row, 300)?.closePct;
  const mfe300 = outcome(row, 300)?.mfePct;
  if (mfe30 == null || close300 == null || mfe300 == null) return null;
  const trailPct = Math.max(0.015, 0.5 * mfe30);
  const stopRawReturn = Math.max(cost, mfe300 - trailPct);
  return rounded(Math.min(close300, stopRawReturn) - cost);
}

function cooldownKeptRows(rows: CandleAnchorFeatureRow[], cooldownSec: number): { kept: CandleAnchorFeatureRow[]; blocked: CandleAnchorFeatureRow[] } {
  const sorted = [...rows].sort((a, b) => a.anchorAtMs - b.anchorAtMs);
  const blockedUntilByToken = new Map<string, number>();
  const kept: CandleAnchorFeatureRow[] = [];
  const blocked: CandleAnchorFeatureRow[] = [];
  for (const row of sorted) {
    const blockedUntil = blockedUntilByToken.get(row.tokenMint) ?? 0;
    if (row.anchorAtMs < blockedUntil) {
      blocked.push(row);
      continue;
    }
    kept.push(row);
    if (fail30(row)) blockedUntilByToken.set(row.tokenMint, row.anchorAtMs + cooldownSec * 1000);
  }
  return { kept, blocked };
}

function buildEvaluations(rows: CandleAnchorFeatureRow[], args: CandleEntryProofArgs): CandleProofArmEvaluation[] {
  const rotation = rows.filter((row) => row.family === 'rotation' && closeReturn(row, 300, args.roundTripCostPct) != null);
  const smartV3 = rows.filter((row) => row.family === 'smart_v3' && closeReturn(row, 300, args.roundTripCostPct) != null);
  const evaluations: CandleProofArmEvaluation[] = [];
  const prestable = rotation.filter(preStable);
  evaluations.push(evaluateRows(
    'rotation_prestable_admission_v2',
    'allow_filter',
    'rotation',
    prestable,
    rotation,
    new Map(),
    args.roundTripCostPct,
    args.minRows
  ));
  const doa = rotation.filter(doa15);
  evaluations.push(evaluateRows(
    'rotation_doa15_failfast_v1',
    'veto_trigger',
    'rotation',
    doa,
    rotation,
    new Map(doa.map((row) => [row.key, closeReturn(row, 300, args.roundTripCostPct) ?? 0])),
    args.roundTripCostPct,
    args.minRows,
    doa.length,
    rate(doa.filter((row) => (outcome(row, 300)?.closePct ?? -Infinity) >= 0.12).length, doa.length)
  ));
  const passRows = rotation.filter(pass30);
  evaluations.push(evaluateRows(
    'rotation_pass30_trail_v1',
    'survivor_trail',
    'rotation',
    passRows,
    rotation,
    new Map(passRows.flatMap((row) => {
      const value = trailReturn(row, args.roundTripCostPct);
      return value == null ? [] : [[row.key, value] as const];
    })),
    args.roundTripCostPct,
    args.minRows
  ));
  const cooldown = cooldownKeptRows(rotation, 180);
  evaluations.push(evaluateRows(
    'rotation_fail30_cooldown_v1',
    'cooldown_keep',
    'rotation',
    cooldown.kept,
    rotation,
    new Map(),
    args.roundTripCostPct,
    args.minRows,
    cooldown.blocked.length,
    rate(cooldown.blocked.filter((row) => (outcome(row, 300)?.closePct ?? -Infinity) >= 0.12).length, cooldown.blocked.length)
  ));
  const smartQuarantine = smartV3.filter((row) => strongerPreStable(row) && pass30(row));
  evaluations.push(evaluateRows(
    'smartv3_candle_quarantine_v1',
    'allow_filter',
    'smart_v3',
    smartQuarantine,
    smartV3,
    new Map(),
    args.roundTripCostPct,
    args.minRows
  ));
  return evaluations;
}

function buildFoldSummaries(
  rows: CandleAnchorFeatureRow[],
  evaluations: CandleProofArmEvaluation[],
  args: CandleEntryProofArgs
): CandleProofFoldSummary[] {
  const armRows = new Map<string, CandleAnchorFeatureRow[]>();
  armRows.set('rotation_prestable_admission_v2', rows.filter((row) => row.family === 'rotation' && preStable(row)));
  armRows.set('rotation_doa15_failfast_v1', rows.filter((row) => row.family === 'rotation' && doa15(row)));
  armRows.set('rotation_pass30_trail_v1', rows.filter((row) => row.family === 'rotation' && pass30(row)));
  armRows.set('rotation_fail30_cooldown_v1', cooldownKeptRows(rows.filter((row) => row.family === 'rotation'), 180).kept);
  armRows.set('smartv3_candle_quarantine_v1', rows.filter((row) => row.family === 'smart_v3' && strongerPreStable(row) && pass30(row)));
  const byArm = new Map(evaluations.map((evaluation) => [evaluation.arm, evaluation]));
  const folds: CandleProofFoldSummary[] = [];
  for (const fold of FOLDS) {
    for (const [arm, sourceRows] of armRows) {
      const evaluation = byArm.get(arm);
      if (!evaluation) continue;
      const foldRows = sourceRows.filter((row) => row.day >= fold.start && row.day <= fold.end);
      const values = compactReturns(foldRows.map((row) => {
        if (arm === 'rotation_pass30_trail_v1') return trailReturn(row, args.roundTripCostPct);
        return closeReturn(row, 300, args.roundTripCostPct);
      }));
      const returns = new Map<string, number>();
      const coveredRows = foldRows.filter((row) => {
        if (arm === 'rotation_pass30_trail_v1') return trailReturn(row, args.roundTripCostPct) != null;
        return closeReturn(row, 300, args.roundTripCostPct) != null;
      });
      coveredRows.forEach((row) => {
        const value = arm === 'rotation_pass30_trail_v1'
          ? trailReturn(row, args.roundTripCostPct)
          : closeReturn(row, 300, args.roundTripCostPct);
        if (value != null) returns.set(row.key, value);
      });
      const stats = summarizeReturns(values);
      let verdict: CandleProofVerdict = 'COLLECT';
      if (coveredRows.length < args.minRows) verdict = 'DATA_GAP';
      else if ((stats.median ?? -Infinity) >= 0 && (stats.leNeg20Rate ?? 1) <= 0.2) verdict = 'CANDIDATE';
      else if ((stats.median ?? 0) < -0.05) verdict = 'REJECT';
      folds.push({
        fold: fold.name,
        arm,
        role: evaluation.role,
        rows: coveredRows.length,
        activeDays: new Set(coveredRows.map((row) => row.day)).size,
        stats,
        maxLossStreak: maxLossStreak(coveredRows, returns),
        top5WinnerShare: topWinnerShare(values, 5),
        verdict,
      });
    }
  }
  return folds;
}

function buildReentryClusters(rows: CandleAnchorFeatureRow[]): CandleProofReentryCluster[] {
  const byTokenDay = new Map<string, CandleAnchorFeatureRow[]>();
  for (const row of rows.filter((item) => item.family === 'rotation')) {
    const key = `${row.tokenMint}|${row.day}`;
    const arr = byTokenDay.get(key) ?? [];
    arr.push(row);
    byTokenDay.set(key, arr);
  }
  const clusters: CandleProofReentryCluster[] = [];
  for (const arr of byTokenDay.values()) {
    const sorted = arr.sort((a, b) => a.anchorAtMs - b.anchorAtMs);
    let current: CandleAnchorFeatureRow[] = [];
    const flush = (): void => {
      if (current.length <= 1) {
        current = [];
        return;
      }
      const values = compactReturns(current.map((row) => closeReturn(row, 300, 0)));
      clusters.push({
        tokenMint: current[0].tokenMint,
        day: current[0].day,
        clusterStartAt: current[0].anchorAt,
        clusterEndAt: current[current.length - 1].anchorAt,
        attempts: current.length,
        fail30Attempts: current.filter(fail30).length,
        sumReturn300: values.length > 0 ? rounded(values.reduce((sum, value) => sum + value, 0)) : null,
        bestReturn300: values.length > 0 ? rounded(Math.max(...values)) : null,
        worstReturn300: values.length > 0 ? rounded(Math.min(...values)) : null,
      });
      current = [];
    };
    for (const row of sorted) {
      const last = current[current.length - 1];
      if (last && row.anchorAtMs - last.anchorAtMs > 10 * 60 * 1000) flush();
      current.push(row);
    }
    flush();
  }
  return clusters.sort((a, b) => b.attempts - a.attempts || (a.clusterStartAt < b.clusterStartAt ? -1 : 1));
}

function reportVerdict(evaluations: CandleProofArmEvaluation[]): CandleProofVerdict {
  if (evaluations.some((evaluation) => evaluation.verdict === 'CANDIDATE')) return 'CANDIDATE';
  if (evaluations.every((evaluation) => evaluation.verdict === 'DATA_GAP')) return 'DATA_GAP';
  if (evaluations.every((evaluation) => evaluation.verdict === 'REJECT')) return 'REJECT';
  return 'COLLECT';
}

function reasonSummaries(rows: CandleAnchorFeatureRow[], maxReasons = 5): Array<{ reason: string; count: number; share: number | null }> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.coverageReason, (counts.get(row.coverageReason) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxReasons)
    .map(([reason, count]) => ({ reason, count, share: rows.length > 0 ? rounded(count / rows.length) : null }));
}

function coverageGroup(rows: CandleAnchorFeatureRow[], groupBy: 'family' | 'source' | 'day', group: string): CandleCoverageGroupSummary {
  const pre60 = rows.filter((row) => (row.pre['60']?.rows ?? 0) > 0).length;
  const outcome300 = rows.filter((row) => outcome(row, 300)?.closePct != null).length;
  const fullCoverage = rows.filter((row) => row.coverageReason === 'covered').length;
  return {
    groupBy,
    group,
    anchors: rows.length,
    pre60,
    outcome300,
    fullCoverage,
    fullCoverageRate: rows.length > 0 ? rounded(fullCoverage / rows.length) : null,
    topReasons: reasonSummaries(rows),
  };
}

function buildCoverageGroups(rows: CandleAnchorFeatureRow[]): CandleCoverageGroupSummary[] {
  const out: CandleCoverageGroupSummary[] = [];
  for (const groupBy of ['family', 'source', 'day'] as const) {
    const grouped = new Map<string, CandleAnchorFeatureRow[]>();
    for (const row of rows) {
      const key = groupBy === 'family' ? row.family : groupBy === 'source' ? row.source : row.day;
      const arr = grouped.get(key) ?? [];
      arr.push(row);
      grouped.set(key, arr);
    }
    out.push(...[...grouped.entries()]
      .map(([group, groupRows]) => coverageGroup(groupRows, groupBy, group))
      .sort((a, b) => {
        if (a.groupBy !== b.groupBy) return a.groupBy.localeCompare(b.groupBy);
        return b.anchors - a.anchors || a.group.localeCompare(b.group);
      }));
  }
  return out;
}

async function writeJsonl(file: string, rows: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''), 'utf8');
}

export async function writeCandleProofMarts(
  martDir: string,
  rows: CandleAnchorFeatureRow[],
  folds: CandleProofFoldSummary[],
  reentryClusters: CandleProofReentryCluster[]
): Promise<void> {
  const anchorRows = rows.map((row) => ({
    key: row.key,
    positionId: row.positionId,
    tokenMint: row.tokenMint,
    anchorAt: row.anchorAt,
    day: row.day,
    source: row.source,
    family: row.family,
    mode: row.mode,
    kolBucket: row.kolBucket,
    tokenCandleRows: row.tokenCandleRows,
    tokenFirstCandleAt: row.tokenFirstCandleAt,
    tokenLastCandleAt: row.tokenLastCandleAt,
    coverageReason: row.coverageReason,
    coverageDetail: row.coverageDetail,
    pre: row.pre,
  }));
  const horizonRows = rows.flatMap((row) => Object.values(row.outcomes).map((out) => ({
    key: row.key,
    positionId: row.positionId,
    tokenMint: row.tokenMint,
    anchorAt: row.anchorAt,
    day: row.day,
    family: row.family,
    horizonSec: out.horizonSec,
    closePct: out.closePct,
    mfePct: out.mfePct,
    maePct: out.maePct,
    quoteDeltaPct: out.quoteDeltaPct,
  })));
  await writeJsonl(path.join(martDir, 'anchor_feature_mart.jsonl'), anchorRows);
  await writeJsonl(path.join(martDir, 'horizon_outcome_mart.jsonl'), horizonRows);
  await writeJsonl(path.join(martDir, 'fold_summary_mart.jsonl'), folds);
  await writeJsonl(path.join(martDir, 'reentry_cluster_mart.jsonl'), reentryClusters);
}

export async function buildCandleEntryProofReport(args: CandleEntryProofArgs): Promise<CandleEntryProofReport> {
  const [anchorRows, markoutRows] = await Promise.all([
    readJsonl(path.join(args.realtimeDir, 'trade-markout-anchors.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'trade-markouts.jsonl')),
  ]);
  const anchors = buildAnchors(anchorRows, markoutRows);
  const maxPre = Math.max(...args.preWindowsSec);
  const maxPost = Math.max(...args.horizonsSec);
  const scan = await attachCandles(anchors, args.sessionsDir, maxPre, maxPost, args.maxCandles);
  const rows = buildAnchorRows(anchors, args.preWindowsSec, args.horizonsSec);
  const evaluations = buildEvaluations(rows, args);
  const folds = buildFoldSummaries(rows, evaluations, args);
  const reentryClusters = buildReentryClusters(rows).slice(0, 100);
  const coverageGroups = buildCoverageGroups(rows);
  if (args.martDir) await writeCandleProofMarts(args.martDir, rows, folds, reentryClusters);
  const verdict = reportVerdict(evaluations);
  const reasons = [
    'report-only: no live routing, ticket sizing, or wallet behavior changed',
    'delayed full entry remains excluded; pass30 is evaluated as survivor management only',
    `${evaluations.filter((evaluation) => evaluation.verdict === 'CANDIDATE').length} candidate arm(s), ${evaluations.filter((evaluation) => evaluation.verdict === 'DATA_GAP').length} data-gap arm(s)`,
  ];
  return {
    generatedAt: new Date().toISOString(),
    realtimeDir: args.realtimeDir,
    sessionsDir: args.sessionsDir,
    horizonsSec: args.horizonsSec,
    preWindowsSec: args.preWindowsSec,
    roundTripCostPct: args.roundTripCostPct,
    minRows: args.minRows,
    anchorRows: anchorRows.length,
    buyAnchors: anchors.length,
    candleFiles: scan.candleFiles,
    candleRowsScanned: scan.candleRowsScanned,
    anchorsWithPre60: rows.filter((row) => (row.pre['60']?.rows ?? 0) > 0).length,
    anchorsWithOutcome300: rows.filter((row) => outcome(row, 300)?.closePct != null).length,
    anchorsWithFullCoverage: rows.filter((row) => row.coverageReason === 'covered').length,
    directCoverage: rows.length > 0 ? rounded(rows.filter((row) => outcome(row, 300)?.closePct != null).length / rows.length) : null,
    fullCoverage: rows.length > 0 ? rounded(rows.filter((row) => row.coverageReason === 'covered').length / rows.length) : null,
    coverageGroups,
    evaluations,
    folds,
    reentryClusters,
    verdict,
    reasons,
    nextActions: [
      'Use candidate arms as paper-only hypotheses; do not promote without forward paper closes.',
      'Audit doa15/fail30 winner leakage before converting either into live veto behavior.',
      'If candle coverage remains low, fix candle anchor alignment before interpreting profitability.',
    ],
  };
}
