import { readFile } from 'fs/promises';
import path from 'path';
import {
  type AnchorMeta,
  type JsonRow,
  type MarkoutCandidate,
  type ReturnStats,
} from './admissionEdgeTypes';

export async function readJsonl(file: string): Promise<JsonRow[]> {
  try {
    const raw = await readFile(file, 'utf8');
    return raw.split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as JsonRow];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

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
  const count = num(extras.independentKolCount) ?? num(extras.effectiveIndependentKolCount) ?? num(extras.kolCount);
  if (count == null) return 'KOL_unknown';
  if (count <= 1) return 'KOL_1';
  if (count === 2) return 'KOL_2';
  return 'KOL_3plus';
}

export function anchorKey(row: JsonRow): string {
  return `${str(row.positionId)}|${str(row.anchorType)}|${str(row.anchorAt)}`;
}

function isOkBuyMarkout(row: JsonRow): boolean {
  return str(row.anchorType) === 'buy' && str(row.quoteStatus) === 'ok' && num(row.deltaPct) != null;
}

function buildAnchorMap(anchorRows: JsonRow[]): Map<string, AnchorMeta> {
  const anchors = new Map<string, AnchorMeta>();
  for (const row of anchorRows) {
    if (str(row.anchorType) !== 'buy') continue;
    const positionId = str(row.positionId);
    const anchorAt = str(row.anchorAt);
    if (!positionId || !anchorAt) continue;
    const extras = extrasOf(row);
    const source = str(row.signalSource) || 'unknown';
    anchors.set(anchorKey(row), {
      key: anchorKey(row),
      positionId,
      anchorAt,
      source,
      family: sourceFamily(source),
      mode: str(extras.mode) || (positionId.includes('-live-') ? 'live' : 'paper_or_unknown'),
      kolBucket: kolBucket(extras),
    });
  }
  return anchors;
}

export function buildCandidates(anchorRows: JsonRow[], markoutRows: JsonRow[]): { candidates: MarkoutCandidate[]; okBuyMarkoutRows: number } {
  const anchors = buildAnchorMap(anchorRows);
  const candidates = new Map<string, MarkoutCandidate>();
  let okBuyMarkoutRows = 0;
  for (const row of markoutRows) {
    if (!isOkBuyMarkout(row)) continue;
    const key = anchorKey(row);
    const anchor = anchors.get(key);
    const horizonSec = num(row.horizonSec);
    const delta = num(row.deltaPct);
    if (!anchor || horizonSec == null || delta == null) continue;
    okBuyMarkoutRows += 1;
    if (!candidates.has(key)) candidates.set(key, { ...anchor, deltas: new Map() });
    candidates.get(key)?.deltas.set(horizonSec, delta);
  }
  return { candidates: [...candidates.values()], okBuyMarkoutRows };
}

export async function loadMarkoutCandidates(realtimeDir: string): Promise<{ anchorRows: JsonRow[]; markoutRows: JsonRow[]; candidates: MarkoutCandidate[]; okBuyMarkoutRows: number }> {
  const [anchorRows, markoutRows] = await Promise.all([
    readJsonl(path.join(realtimeDir, 'trade-markout-anchors.jsonl')),
    readJsonl(path.join(realtimeDir, 'trade-markouts.jsonl')),
  ]);
  const { candidates, okBuyMarkoutRows } = buildCandidates(anchorRows, markoutRows);
  return { anchorRows, markoutRows, candidates, okBuyMarkoutRows };
}

export function rounded(value: number | null): number | null {
  return value == null ? null : Number(value.toFixed(6));
}

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)];
}

function rate(values: number[], predicate: (value: number) => boolean): number | null {
  if (values.length === 0) return null;
  return values.filter(predicate).length / values.length;
}

export function summarizeReturns(values: number[]): ReturnStats {
  const sorted = [...values].sort((a, b) => a - b);
  const trimmed = sorted.slice(Math.floor(sorted.length * 0.05), Math.ceil(sorted.length * 0.95));
  const average = trimmed.length > 0 ? trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length : null;
  return {
    rows: values.length,
    median: rounded(percentile(values, 0.5)),
    p25: rounded(percentile(values, 0.25)),
    p75: rounded(percentile(values, 0.75)),
    p90: rounded(percentile(values, 0.9)),
    trimmedAverage: rounded(average),
    positiveRate: rounded(rate(values, (value) => value > 0)),
    ge5Rate: rounded(rate(values, (value) => value >= 0.05)),
    ge12Rate: rounded(rate(values, (value) => value >= 0.12)),
    ge50Rate: rounded(rate(values, (value) => value >= 0.5)),
    leNeg5Rate: rounded(rate(values, (value) => value <= -0.05)),
    leNeg10Rate: rounded(rate(values, (value) => value <= -0.1)),
    leNeg20Rate: rounded(rate(values, (value) => value <= -0.2)),
  };
}

export function deltaAt(candidate: MarkoutCandidate, horizonSec: number): number | null {
  return candidate.deltas.get(horizonSec) ?? null;
}

export function postCostAnchorReturn(candidate: MarkoutCandidate, horizonSec: number, roundTripCostPct: number): number | null {
  const delta = deltaAt(candidate, horizonSec);
  return delta == null ? null : delta - roundTripCostPct;
}

export function delayedReturn(candidate: MarkoutCandidate, fromHorizonSec: number, toHorizonSec: number, roundTripCostPct: number): number | null {
  const from = deltaAt(candidate, fromHorizonSec);
  const to = deltaAt(candidate, toHorizonSec);
  if (from == null || to == null || 1 + from <= 0) return null;
  return ((1 + to) / (1 + from) - 1) - roundTripCostPct;
}

export function compactReturns(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value != null && Number.isFinite(value));
}
