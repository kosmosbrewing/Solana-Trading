import path from 'path';
import type { JsonRow } from './admissionEdgeTypes';
import {
  num,
  readJsonl,
  rounded,
  str,
} from './markoutCandidateStore';
import {
  MISSION_BLEED_EXIT_REASONS,
  MISSION_SHADOW_ARMS,
  type LiveBleedExitBucket,
  type LiveBleedSummary,
  type PaperShadowArmSummary,
} from './missionEntryReportTypes';

const LIVE_TRADE_FILES = [
  'kol-live-trades.jsonl',
  'smart-v3-live-trades.jsonl',
  'rotation-v1-live-trades.jsonl',
  'pure-ws-live-trades.jsonl',
];

const PAPER_TRADE_FILES = [
  'kol-paper-trades.jsonl',
  'smart-v3-paper-trades.jsonl',
  'rotation-v1-paper-trades.jsonl',
  'pure-ws-paper-trades.jsonl',
  'capitulation-rebound-paper-trades.jsonl',
];

export interface MissionTradeRows {
  liveRows: JsonRow[];
  paperRows: JsonRow[];
}

export async function loadMissionTradeRows(realtimeDir: string): Promise<MissionTradeRows> {
  const [liveRows, paperRows] = await Promise.all([
    readTradeFiles(realtimeDir, LIVE_TRADE_FILES),
    readTradeFiles(realtimeDir, PAPER_TRADE_FILES),
  ]);
  return { liveRows, paperRows };
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

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function rate(values: number[], predicate: (value: number) => boolean): number | null {
  return values.length === 0 ? null : rounded(values.filter(predicate).length / values.length);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function netSol(row: JsonRow): number {
  return valueNum(row, 'walletDeltaSol') ??
    valueNum(row, 'refundAdjustedNetSol') ??
    valueNum(row, 'netSol') ??
    valueNum(row, 'netSolTokenOnly') ??
    0;
}

function netPct(row: JsonRow): number | null {
  return valueNum(row, 'walletDeltaPct') ??
    valueNum(row, 'netPctTokenOnly') ??
    valueNum(row, 'netPct');
}

function mfePct(row: JsonRow): number | null {
  return valueNum(row, 'actualMfePct') ??
    valueNum(row, 'mfePctPeakTokenOnly') ??
    valueNum(row, 'mfePctPeak') ??
    valueNum(row, 'mfePct');
}

function holdSec(row: JsonRow): number | null {
  return valueNum(row, 'holdSec') ?? valueNum(row, 'holdSeconds');
}

function closedRows(rows: JsonRow[]): JsonRow[] {
  return rows.filter((row) => valueStr(row, 'status') !== 'open');
}

async function readTradeFiles(realtimeDir: string, files: string[]): Promise<JsonRow[]> {
  const chunks = await Promise.all(files.map((file) => readJsonl(path.join(realtimeDir, file))));
  return chunks.flat();
}

function summarizeBleedBucket(exitReason: string, rows: JsonRow[]): LiveBleedExitBucket {
  const nets = rows.map(netSol);
  const mfes = rows.map(mfePct).filter((value): value is number => value != null);
  const holds = rows.map(holdSec).filter((value): value is number => value != null);
  return {
    exitReason,
    rows: rows.length,
    netSol: rounded(sum(nets)) ?? 0,
    winRate: rate(nets, (value) => value > 0),
    medianMfePct: rounded(median(mfes)),
    medianHoldSec: rounded(median(holds)),
  };
}

export function buildLiveBleed(rows: JsonRow[]): LiveBleedSummary {
  const closed = closedRows(rows);
  const liveNet = sum(closed.map(netSol));
  const bleedSet = new Set<string>(MISSION_BLEED_EXIT_REASONS);
  const bleedRows = closed.filter((row) => bleedSet.has(valueStr(row, 'exitReason')));
  const bleedNet = sum(bleedRows.map(netSol));
  const buckets = MISSION_BLEED_EXIT_REASONS
    .map((reason) => summarizeBleedBucket(reason, bleedRows.filter((row) => valueStr(row, 'exitReason') === reason)))
    .filter((bucket) => bucket.rows > 0)
    .sort((a, b) => a.netSol - b.netSol);
  return {
    liveRows: closed.length,
    liveNetSol: rounded(liveNet) ?? 0,
    bleedRows: bleedRows.length,
    bleedNetSol: rounded(bleedNet) ?? 0,
    bleedNetShare: liveNet < 0 ? rounded(Math.abs(bleedNet) / Math.abs(liveNet)) : null,
    buckets,
  };
}

function isPaperShadowArmRow(row: JsonRow, armName: string): boolean {
  const rowArmName = valueStr(row, 'armName');
  const paperRole = valueStr(row, 'paperRole');
  if (rowArmName === armName || paperRole === armName) return true;
  return armName === 'smart_v3_probe_confirm_shadow_v1' && paperRole === 'probe_policy_shadow';
}

function summarizePaperArm(armName: string, rows: JsonRow[]): PaperShadowArmSummary {
  const armRows = closedRows(rows.filter((row) => isPaperShadowArmRow(row, armName)));
  const nets = armRows.map(netSol);
  const netPcts = armRows.map(netPct).filter((value): value is number => value != null);
  const mfes = armRows.map(mfePct).filter((value): value is number => value != null);
  const holds = armRows.map(holdSec).filter((value): value is number => value != null);
  return {
    armName,
    rows: armRows.length,
    netSol: rounded(sum(nets)) ?? 0,
    winRate: rate(nets, (value) => value > 0),
    medianNetPct: rounded(median(netPcts)),
    medianMfePct: rounded(median(mfes)),
    medianHoldSec: rounded(median(holds)),
  };
}

export function buildPaperShadows(rows: JsonRow[]): PaperShadowArmSummary[] {
  return MISSION_SHADOW_ARMS
    .map((armName) => summarizePaperArm(armName, rows))
    .filter((summary) => summary.rows > 0);
}
