import { readFile } from 'fs/promises';
import path from 'path';

export type PromotionLoopJsonRow = Record<string, unknown>;

export type PromotionLoopResetPreflightStatus = 'READY_TO_RESET' | 'BLOCKED' | 'COLLECT';

export interface PromotionLoopResetPreflightReport {
  status: PromotionLoopResetPreflightStatus;
  nextAction: string;
  minPaperCloses: number;
  minRecentPaperCloses: number;
  recentWindowHours: number;
  maxAdmissionFailureRate: number;
  minRouteProofCoverage: number;
  minComparableTraceCoverage: number;
  eligiblePaperRows: number;
  recentEligiblePaperRows: number;
  comparableTraceRows: number;
  routeProofRows: number;
  costEvidenceRows: number;
  admissionFailureRows: number;
  recentAdmissionFailureRows: number;
  refundAdjustedNetSol: number;
  recentRefundAdjustedNetSol: number;
  netSol: number;
  recentNetSol: number;
  routeProofCoverage: number | null;
  comparableTraceCoverage: number | null;
  costEvidenceCoverage: number | null;
  admissionFailureRate: number | null;
  recentAdmissionFailureRate: number | null;
  reasons: string[];
}

export const RESET_PREFLIGHT_MIN_PAPER_CLOSES = 20;
export const RESET_PREFLIGHT_RECENT_WINDOW_MS = 3 * 60 * 60 * 1000;
export const RESET_PREFLIGHT_MIN_RECENT_CLOSES = 10;
export const RESET_PREFLIGHT_MAX_ADMISSION_FAILURE_RATE = 0.5;
export const RESET_PREFLIGHT_MIN_ROUTE_PROOF_COVERAGE = 0.95;
export const RESET_PREFLIGHT_MIN_COMPARABLE_TRACE_COVERAGE = 0.95;

const ADMISSION_FAILURE_REASONS = new Set([
  'probe_hard_cut',
  'rotation_dead_on_arrival',
  'entry_advantage_emergency_exit',
  'rotation_candle_confirm_fail_cut',
  'probe_policy_confirm_fail_cut',
]);

function str(row: PromotionLoopJsonRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(row: PromotionLoopJsonRow, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(row: PromotionLoopJsonRow, key: string): boolean {
  return row[key] === true;
}

function obj(row: PromotionLoopJsonRow, key: string): PromotionLoopJsonRow | null {
  const value = row[key];
  return typeof value === 'object' && value != null && !Array.isArray(value)
    ? value as PromotionLoopJsonRow
    : null;
}

export function parsePromotionLoopJsonl(text: string): PromotionLoopJsonRow[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as PromotionLoopJsonRow;
      } catch {
        return null;
      }
    })
    .filter((row): row is PromotionLoopJsonRow => row !== null);
}

export async function readPromotionLoopPaperRows(
  realtimeDir: string
): Promise<PromotionLoopJsonRow[]> {
  try {
    return parsePromotionLoopJsonl(
      await readFile(path.join(realtimeDir, 'rotation-v1-paper-trades.jsonl'), 'utf8')
    );
  } catch {
    return [];
  }
}

function recordedAtMs(row: PromotionLoopJsonRow): number | null {
  const raw = str(row, 'recordedAt') ?? str(row, 'closedAt');
  if (!raw) return null;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isPartialReduce(row: PromotionLoopJsonRow): boolean {
  return bool(row, 'isPartialReduce') ||
    bool(row, 'positionStillOpen') ||
    str(row, 'eventType') === 'rotation_flow_live_reduce';
}

function rowPnlSol(row: PromotionLoopJsonRow): number | null {
  const wallet = num(row, 'walletDeltaSol');
  if (wallet != null) return wallet;
  const net = num(row, 'netSol');
  if (net != null) return net;
  const db = num(row, 'dbPnlSol');
  if (db != null) return db;
  const pnl = num(row, 'pnlSol');
  if (pnl != null) return pnl;
  const received = num(row, 'receivedSol');
  const spent = num(row, 'solSpentNominal');
  return received != null && spent != null ? received - spent : null;
}

function refundAdjustedPnlSol(row: PromotionLoopJsonRow): number | null {
  return num(row, 'refundAdjustedNetSol') ?? rowPnlSol(row);
}

function arrayOfStrings(row: PromotionLoopJsonRow, key: string): string[] {
  const value = row[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function paperRole(row: PromotionLoopJsonRow): string | null {
  return str(row, 'paperRole') ?? str(obj(row, 'extras') ?? {}, 'paperRole');
}

function isComparablePaperRole(row: PromotionLoopJsonRow): boolean {
  const role = paperRole(row);
  return role === 'mirror' ||
    role === 'fallback_execution_safety';
}

function hasUnderfillLabel(row: PromotionLoopJsonRow): boolean {
  const labels = [str(row, 'armName'), str(row, 'profileArm'), str(row, 'entryArm')]
    .map((value) => String(value ?? '').toLowerCase());
  return labels.some((label) => label.includes('rotation_underfill'));
}

function paperPositionId(row: PromotionLoopJsonRow): string | null {
  return str(row, 'positionId');
}

function isPaperRow(row: PromotionLoopJsonRow): boolean {
  const id = paperPositionId(row);
  return id == null || !id.startsWith('kolh-live-');
}

function hasComparableTrace(row: PromotionLoopJsonRow): boolean {
  return Boolean(
    str(row, 'liveEquivalenceCandidateId') &&
    str(row, 'liveEquivalenceDecisionId')
  );
}

function hasRouteProof(row: PromotionLoopJsonRow): boolean {
  if (bool(row, 'exitRouteFound') || bool(row, 'exitSellRouteKnown')) return true;
  const entryEvidence = obj(row, 'entrySellQuoteEvidence');
  const exitEvidence = obj(row, 'exitSellQuoteEvidence');
  if (entryEvidence?.routeFound === true || exitEvidence?.routeFound === true) return true;
  const flags = [
    ...arrayOfStrings(row, 'survivalFlags'),
    ...arrayOfStrings(obj(row, 'extras') ?? {}, 'survivalFlags'),
  ];
  return flags.includes('SELL_ROUTE_OK') ||
    flags.includes('EXIT_LIQUIDITY_KNOWN') ||
    flags.includes('ROTATION_UNDERFILL_PRELIVE_SELL_ROUTE_OK');
}

function hasCostEvidence(row: PromotionLoopJsonRow): boolean {
  return num(row, 'refundAdjustedNetSol') != null ||
    num(row, 'netSolTokenOnly') != null ||
    obj(row, 'rotationMonetizableEdge') != null ||
    obj(obj(row, 'extras') ?? {}, 'rotationMonetizableEdge') != null;
}

function isAdmissionFailure(row: PromotionLoopJsonRow): boolean {
  const reason = str(row, 'exitReason') ?? str(row, 'closeReason');
  return reason != null && ADMISSION_FAILURE_REASONS.has(reason);
}

function rate(numRows: number, totalRows: number): number | null {
  return totalRows > 0 ? numRows / totalRows : null;
}

function resetPreflightEligiblePaperRows(
  rows: PromotionLoopJsonRow[],
  sinceMs: number
): PromotionLoopJsonRow[] {
  return rows.filter((row) => {
    const atMs = recordedAtMs(row);
    return atMs != null &&
      atMs >= sinceMs &&
      !isPartialReduce(row) &&
      isPaperRow(row) &&
      hasUnderfillLabel(row) &&
      isComparablePaperRole(row);
  });
}

export function buildPromotionLoopResetPreflightReport(
  paperRows: PromotionLoopJsonRow[],
  sinceMs: number,
  nowMs = Date.now()
): PromotionLoopResetPreflightReport {
  const rows = resetPreflightEligiblePaperRows(paperRows, sinceMs);
  const recentSinceMs = Math.max(sinceMs, nowMs - RESET_PREFLIGHT_RECENT_WINDOW_MS);
  const recentRows = rows.filter((row) => {
    const atMs = recordedAtMs(row);
    return atMs != null && atMs >= recentSinceMs;
  });
  const routeProofRows = rows.filter(hasRouteProof).length;
  const comparableTraceRows = rows.filter(hasComparableTrace).length;
  const costEvidenceRows = rows.filter(hasCostEvidence).length;
  const admissionFailureRows = rows.filter(isAdmissionFailure).length;
  const recentAdmissionFailureRows = recentRows.filter(isAdmissionFailure).length;
  const refundAdjustedNetSol = rows.reduce((sum, row) => sum + (refundAdjustedPnlSol(row) ?? 0), 0);
  const netSol = rows.reduce((sum, row) => sum + (rowPnlSol(row) ?? 0), 0);
  const recentRefundAdjustedNetSol = recentRows.reduce((sum, row) => sum + (refundAdjustedPnlSol(row) ?? 0), 0);
  const recentNetSol = recentRows.reduce((sum, row) => sum + (rowPnlSol(row) ?? 0), 0);
  const routeProofCoverage = rate(routeProofRows, rows.length);
  const comparableTraceCoverage = rate(comparableTraceRows, rows.length);
  const costEvidenceCoverage = rate(costEvidenceRows, rows.length);
  const admissionFailureRate = rate(admissionFailureRows, rows.length);
  const recentAdmissionFailureRate = rate(recentAdmissionFailureRows, recentRows.length);
  const reasons: string[] = [];
  if (rows.length < RESET_PREFLIGHT_MIN_PAPER_CLOSES) {
    reasons.push(`fresh comparable underfill paper closes ${rows.length} < ${RESET_PREFLIGHT_MIN_PAPER_CLOSES}`);
  }
  if (recentRows.length < RESET_PREFLIGHT_MIN_RECENT_CLOSES) {
    reasons.push(`recent 3h comparable underfill paper closes ${recentRows.length} < ${RESET_PREFLIGHT_MIN_RECENT_CLOSES}`);
  }
  if (refundAdjustedNetSol < 0) {
    reasons.push(`refund-adjusted paper net ${refundAdjustedNetSol.toFixed(6)} < 0`);
  }
  if (recentRows.length >= RESET_PREFLIGHT_MIN_RECENT_CLOSES && recentRefundAdjustedNetSol < 0) {
    reasons.push(`recent 3h refund-adjusted paper net ${recentRefundAdjustedNetSol.toFixed(6)} < 0`);
  }
  if (rows.length > 0 && (routeProofCoverage ?? 0) < RESET_PREFLIGHT_MIN_ROUTE_PROOF_COVERAGE) {
    reasons.push(
      `route proof coverage ${((routeProofCoverage ?? 0) * 100).toFixed(1)}% < ${(RESET_PREFLIGHT_MIN_ROUTE_PROOF_COVERAGE * 100).toFixed(1)}%`
    );
  }
  if (rows.length > 0 && (comparableTraceCoverage ?? 0) < RESET_PREFLIGHT_MIN_COMPARABLE_TRACE_COVERAGE) {
    reasons.push(
      `comparable trace coverage ${((comparableTraceCoverage ?? 0) * 100).toFixed(1)}% < ${(RESET_PREFLIGHT_MIN_COMPARABLE_TRACE_COVERAGE * 100).toFixed(1)}%`
    );
  }
  if (rows.length > 0 && (admissionFailureRate ?? 1) >= RESET_PREFLIGHT_MAX_ADMISSION_FAILURE_RATE) {
    reasons.push(
      `admission failure rate ${((admissionFailureRate ?? 1) * 100).toFixed(1)}% >= ${(RESET_PREFLIGHT_MAX_ADMISSION_FAILURE_RATE * 100).toFixed(1)}%`
    );
  }
  if (
    recentRows.length >= RESET_PREFLIGHT_MIN_RECENT_CLOSES &&
    (recentAdmissionFailureRate ?? 1) >= RESET_PREFLIGHT_MAX_ADMISSION_FAILURE_RATE
  ) {
    reasons.push(
      `recent 3h admission failure rate ${((recentAdmissionFailureRate ?? 1) * 100).toFixed(1)}% >= ${(RESET_PREFLIGHT_MAX_ADMISSION_FAILURE_RATE * 100).toFixed(1)}%`
    );
  }

  const sampleReady = rows.length >= RESET_PREFLIGHT_MIN_PAPER_CLOSES &&
    recentRows.length >= RESET_PREFLIGHT_MIN_RECENT_CLOSES;
  const status: PromotionLoopResetPreflightStatus = !sampleReady
    ? 'COLLECT'
    : reasons.length === 0
      ? 'READY_TO_RESET'
      : 'BLOCKED';
  const nextAction = status === 'READY_TO_RESET'
    ? 'manual reset review may clear promotion-loop halt for tiny rotation-underfill canary only'
    : status === 'COLLECT'
      ? 'keep promotion loop halted; collect more fresh comparable underfill paper closes'
      : 'keep promotion loop halted; paper quality is not strong enough for funded reset';

  return {
    status,
    nextAction,
    minPaperCloses: RESET_PREFLIGHT_MIN_PAPER_CLOSES,
    minRecentPaperCloses: RESET_PREFLIGHT_MIN_RECENT_CLOSES,
    recentWindowHours: RESET_PREFLIGHT_RECENT_WINDOW_MS / 3_600_000,
    maxAdmissionFailureRate: RESET_PREFLIGHT_MAX_ADMISSION_FAILURE_RATE,
    minRouteProofCoverage: RESET_PREFLIGHT_MIN_ROUTE_PROOF_COVERAGE,
    minComparableTraceCoverage: RESET_PREFLIGHT_MIN_COMPARABLE_TRACE_COVERAGE,
    eligiblePaperRows: rows.length,
    recentEligiblePaperRows: recentRows.length,
    comparableTraceRows,
    routeProofRows,
    costEvidenceRows,
    admissionFailureRows,
    recentAdmissionFailureRows,
    refundAdjustedNetSol,
    recentRefundAdjustedNetSol,
    netSol,
    recentNetSol,
    routeProofCoverage,
    comparableTraceCoverage,
    costEvidenceCoverage,
    admissionFailureRate,
    recentAdmissionFailureRate,
    reasons,
  };
}
