/**
 * Promotion Loop Guard v1
 *
 * 역할: paper edge 를 넓게 live 로 여는 장치가 아니라, 이미 허용된 rotation micro-live 를
 * 5-close 단위로 멈춰 세우는 자산 보호 루프다. 수익을 만들지는 않고, 가설이 틀렸을 때
 * floor 훼손 전 빠르게 kill/review 상태로 보낸다.
 */
import { readFile } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import {
  triggerEntryHalt,
  type EntryLane,
} from '../state/entryHaltState';
import { config } from '../utils/config';
import {
  buildPromotionLoopResetPreflightReport,
  readPromotionLoopPaperRows,
  type PromotionLoopJsonRow,
  type PromotionLoopResetPreflightReport,
} from './promotionLoopResetPreflight';

const log = createModuleLogger('PromotionLoopGuard');

export const PROMOTION_LOOP_COHORT = 'rotation_underfill_micro_live_v1' as const;
export const PROMOTION_LOOP_CHECKPOINT_CLOSES = 5;
export const PROMOTION_LOOP_MAX_CLOSES = 15;
export const PROMOTION_LOOP_CHECKPOINT_LOSS_CAP_SOL = 0.01;
export const PROMOTION_LOOP_TOTAL_LOSS_CAP_SOL = 0.02;
export const PROMOTION_LOOP_MAX_CONSECUTIVE_LOSERS = 3;
const PROMOTION_LOOP_RESET_PREFLIGHT_REFRESH_MS = 60_000;

type PromotionLoopStatus = 'collecting' | 'killed' | 'review';

export interface PromotionLoopEntryInput {
  lane?: EntryLane | null;
  armName?: string | null;
  profileArm?: string | null;
  entryArm?: string | null;
  liveEquivalenceCandidateId?: string | null;
  liveEquivalenceDecisionId?: string | null;
}

export interface PromotionLoopCloseInput extends PromotionLoopEntryInput {
  positionId?: string | null;
  tokenMint?: string | null;
  pnlSol: number;
  exitReason?: string | null;
}

export interface PromotionLoopCloseLedgerRecord {
  promotionLoopCohort?: string | null;
  canaryLane?: string | null;
  lane?: string | null;
  armName?: string | null;
  profileArm?: string | null;
  entryArm?: string | null;
  liveEquivalenceCandidateId?: string | null;
  liveEquivalenceDecisionId?: string | null;
  positionId?: string | null;
  tokenMint?: string | null;
  walletDeltaSol?: number;
  netSol?: number;
  dbPnlSol?: number;
  pnlSol?: number;
  receivedSol?: number;
  solSpentNominal?: number;
  recordedAt?: string;
  closedAt?: string;
  eventType?: string;
  isPartialReduce?: boolean;
  positionStillOpen?: boolean;
  exitReason?: string | null;
}

export interface PromotionLoopHydrationSummary {
  loadedRows: number;
  replayedRows: number;
  skippedRows: number;
  sinceMs: number | null;
  cohort: typeof PROMOTION_LOOP_COHORT;
}

export interface PromotionLoopStateSnapshot {
  cohort: typeof PROMOTION_LOOP_COHORT;
  status: PromotionLoopStatus;
  closeCount: number;
  checkpointCloseCount: number;
  cumulativePnlSol: number;
  checkpointPnlSol: number;
  consecutiveLosers: number;
  lastHaltReason: string | null;
}

export interface PromotionLoopEntryAssessment {
  allowed: boolean;
  inScope: boolean;
  cohort: typeof PROMOTION_LOOP_COHORT | null;
  reason: string | null;
  flags: string[];
}

interface PromotionLoopState {
  status: PromotionLoopStatus;
  closeCount: number;
  checkpointCloseCount: number;
  cumulativePnlSol: number;
  checkpointPnlSol: number;
  consecutiveLosers: number;
  lastHaltReason: string | null;
}

const state: PromotionLoopState = {
  status: 'collecting',
  closeCount: 0,
  checkpointCloseCount: 0,
  cumulativePnlSol: 0,
  checkpointPnlSol: 0,
  consecutiveLosers: 0,
  lastHaltReason: null,
};

let resetPreflightReport: PromotionLoopResetPreflightReport | null = null;
let resetPreflightRefreshedAtMs = 0;

function normalize(value?: string | null): string {
  return String(value ?? '').toLowerCase();
}

function isRotationUnderfillArm(input: PromotionLoopEntryInput): boolean {
  const labels = [
    normalize(input.profileArm),
    normalize(input.entryArm),
    normalize(input.armName),
  ];
  return labels.some((label) =>
    label === 'rotation_underfill_exit_flow_v1' ||
    label === 'rotation_underfill_v1' ||
    label === 'rotation_underfill_cost_aware_exit_v2' ||
    label.includes('rotation_underfill')
  );
}

export function resolvePromotionLoopCohort(
  input: PromotionLoopEntryInput
): typeof PROMOTION_LOOP_COHORT | null {
  if (input.lane !== 'kol_hunter_rotation') return null;
  return isRotationUnderfillArm(input) ? PROMOTION_LOOP_COHORT : null;
}

function hasLiveTrace(input: PromotionLoopEntryInput): boolean {
  return Boolean(input.liveEquivalenceCandidateId && input.liveEquivalenceDecisionId);
}

function parseRecordedAtMs(row: PromotionLoopCloseLedgerRecord): number | null {
  const raw = row.recordedAt ?? row.closedAt;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

function resolveLedgerLane(row: PromotionLoopCloseLedgerRecord): EntryLane | null {
  const lane = row.canaryLane ?? row.lane;
  return lane === 'kol_hunter_rotation' ? lane : null;
}

function resolveLedgerPnlSol(row: PromotionLoopCloseLedgerRecord): number | null {
  if (typeof row.walletDeltaSol === 'number') return row.walletDeltaSol;
  if (typeof row.netSol === 'number') return row.netSol;
  if (typeof row.dbPnlSol === 'number') return row.dbPnlSol;
  if (typeof row.pnlSol === 'number') return row.pnlSol;
  if (typeof row.receivedSol === 'number' && typeof row.solSpentNominal === 'number') {
    return row.receivedSol - row.solSpentNominal;
  }
  return null;
}

function isPartialReduceLedgerRow(row: PromotionLoopCloseLedgerRecord): boolean {
  return row.isPartialReduce === true ||
    row.positionStillOpen === true ||
    row.eventType === 'rotation_flow_live_reduce';
}

function parseJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((row): row is T => row !== null);
}

function hydrationSinceMs(nowMs: number): number | null {
  if (config.canaryAutoHaltHydrateSince) {
    const t = new Date(config.canaryAutoHaltHydrateSince).getTime();
    return Number.isFinite(t) ? t : null;
  }
  const hours = config.canaryAutoHaltHydrateLookbackHours;
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return nowMs - hours * 60 * 60 * 1000;
}

export function assessPromotionLoopEntry(
  input: PromotionLoopEntryInput
): PromotionLoopEntryAssessment {
  const cohort = resolvePromotionLoopCohort(input);
  if (!cohort) {
    return { allowed: true, inScope: false, cohort: null, reason: null, flags: [] };
  }
  if (state.status !== 'collecting') {
    const reason = state.lastHaltReason ?? `promotion_loop_${state.status}`;
    return {
      allowed: false,
      inScope: true,
      cohort,
      reason,
      flags: ['PROMOTION_LOOP_HALTED', `PROMOTION_LOOP_STATUS_${state.status.toUpperCase()}`],
    };
  }
  if (!hasLiveTrace(input)) {
    return {
      allowed: false,
      inScope: true,
      cohort,
      reason: 'promotion_loop_missing_live_equivalence_trace',
      flags: ['PROMOTION_LOOP_MISSING_TRACE'],
    };
  }
  if (!resetPreflightReport) {
    return {
      allowed: false,
      inScope: true,
      cohort,
      reason: 'promotion_loop_reset_preflight_missing',
      flags: ['PROMOTION_LOOP_RESET_PREFLIGHT_MISSING'],
    };
  }
  if (resetPreflightReport.status !== 'READY_TO_RESET') {
    const detail = resetPreflightReport.reasons[0] ?? resetPreflightReport.nextAction;
    return {
      allowed: false,
      inScope: true,
      cohort,
      reason: `promotion_loop_reset_preflight_${resetPreflightReport.status.toLowerCase()}: ${detail}`,
      flags: [
        'PROMOTION_LOOP_RESET_PREFLIGHT_BLOCKED',
        `PROMOTION_LOOP_RESET_PREFLIGHT_${resetPreflightReport.status}`,
      ],
    };
  }
  return {
    allowed: true,
    inScope: true,
    cohort,
    reason: null,
    flags: ['PROMOTION_LOOP_ACTIVE', 'PROMOTION_LOOP_RESET_PREFLIGHT_READY'],
  };
}

function haltPromotionLoop(
  lane: EntryLane,
  status: PromotionLoopStatus,
  reason: string
): void {
  if (state.status !== 'collecting') return;
  state.status = status;
  state.lastHaltReason = reason;
  triggerEntryHalt(lane, `promotion loop ${status}: ${reason}`);
  log.warn(
    `[PROMOTION_LOOP_${status.toUpperCase()}] cohort=${PROMOTION_LOOP_COHORT} ` +
    `closes=${state.closeCount} cum=${state.cumulativePnlSol.toFixed(6)} ` +
    `checkpoint=${state.checkpointPnlSol.toFixed(6)} streak=${state.consecutiveLosers} reason=${reason}`
  );
}

function applyPromotionLoopClose(input: PromotionLoopCloseInput): PromotionLoopStateSnapshot | null {
  const cohort = resolvePromotionLoopCohort(input);
  if (!cohort || input.lane == null) return null;
  if (!Number.isFinite(input.pnlSol)) return getPromotionLoopStateSnapshot();

  state.closeCount += 1;
  state.checkpointCloseCount += 1;
  state.cumulativePnlSol += input.pnlSol;
  state.checkpointPnlSol += input.pnlSol;
  state.consecutiveLosers = input.pnlSol < 0 ? state.consecutiveLosers + 1 : 0;

  if (state.status === 'collecting') {
    if (state.cumulativePnlSol <= -PROMOTION_LOOP_TOTAL_LOSS_CAP_SOL) {
      haltPromotionLoop(
        input.lane,
        'killed',
        `total_loss_cap ${state.cumulativePnlSol.toFixed(6)} <= -${PROMOTION_LOOP_TOTAL_LOSS_CAP_SOL}`
      );
    } else if (state.consecutiveLosers >= PROMOTION_LOOP_MAX_CONSECUTIVE_LOSERS) {
      haltPromotionLoop(
        input.lane,
        'killed',
        `consecutive_losers ${state.consecutiveLosers} >= ${PROMOTION_LOOP_MAX_CONSECUTIVE_LOSERS}`
      );
    } else if (
      state.checkpointCloseCount >= PROMOTION_LOOP_CHECKPOINT_CLOSES &&
      state.checkpointPnlSol <= -PROMOTION_LOOP_CHECKPOINT_LOSS_CAP_SOL
    ) {
      haltPromotionLoop(
        input.lane,
        'killed',
        `checkpoint_loss ${state.checkpointPnlSol.toFixed(6)} <= -${PROMOTION_LOOP_CHECKPOINT_LOSS_CAP_SOL}`
      );
    } else if (state.closeCount >= PROMOTION_LOOP_MAX_CLOSES) {
      haltPromotionLoop(
        input.lane,
        'review',
        `review_checkpoint closes=${state.closeCount}/${PROMOTION_LOOP_MAX_CLOSES} net=${state.cumulativePnlSol.toFixed(6)}`
      );
    }
  }

  if (state.status === 'collecting' && state.checkpointCloseCount >= PROMOTION_LOOP_CHECKPOINT_CLOSES) {
    log.info(
      `[PROMOTION_LOOP_CHECKPOINT] cohort=${PROMOTION_LOOP_COHORT} ` +
      `checkpointNet=${state.checkpointPnlSol.toFixed(6)} totalNet=${state.cumulativePnlSol.toFixed(6)}`
    );
    state.checkpointCloseCount = 0;
    state.checkpointPnlSol = 0;
  }

  return getPromotionLoopStateSnapshot();
}

export function reportPromotionLoopClose(input: PromotionLoopCloseInput): PromotionLoopStateSnapshot | null {
  return applyPromotionLoopClose(input);
}

export function hydratePromotionLoopGuardFromCloseRecords(
  rows: PromotionLoopCloseLedgerRecord[],
  opts: { sinceMs?: number | null; resetBeforeHydrate?: boolean } = {}
): PromotionLoopHydrationSummary {
  if (opts.resetBeforeHydrate) resetPromotionLoopGuardForTests();
  const sinceMs = opts.sinceMs ?? null;
  const ordered = [...rows].sort((a, b) =>
    (parseRecordedAtMs(a) ?? 0) - (parseRecordedAtMs(b) ?? 0)
  );
  const summary: PromotionLoopHydrationSummary = {
    loadedRows: rows.length,
    replayedRows: 0,
    skippedRows: 0,
    sinceMs,
    cohort: PROMOTION_LOOP_COHORT,
  };

  for (const row of ordered) {
    if (row.promotionLoopCohort !== PROMOTION_LOOP_COHORT) {
      summary.skippedRows += 1;
      continue;
    }
    const rowMs = parseRecordedAtMs(row);
    if (sinceMs != null && (rowMs == null || rowMs < sinceMs)) {
      summary.skippedRows += 1;
      continue;
    }
    if (isPartialReduceLedgerRow(row)) {
      summary.skippedRows += 1;
      continue;
    }
    const lane = resolveLedgerLane(row);
    const pnlSol = resolveLedgerPnlSol(row);
    if (!lane || pnlSol == null) {
      summary.skippedRows += 1;
      continue;
    }
    const snapshot = applyPromotionLoopClose({
      lane,
      armName: row.armName,
      profileArm: row.profileArm,
      entryArm: row.entryArm,
      liveEquivalenceCandidateId: row.liveEquivalenceCandidateId,
      liveEquivalenceDecisionId: row.liveEquivalenceDecisionId,
      positionId: row.positionId,
      tokenMint: row.tokenMint,
      pnlSol,
      exitReason: row.exitReason,
    });
    if (!snapshot) {
      summary.skippedRows += 1;
      continue;
    }
    summary.replayedRows += 1;
  }

  return summary;
}

export async function hydratePromotionLoopGuardFromLedger(
  ledgerDir = config.realtimeDataDir,
  nowMs = Date.now()
): Promise<PromotionLoopHydrationSummary> {
  const file = path.join(ledgerDir, 'executed-sells.jsonl');
  let rows: PromotionLoopCloseLedgerRecord[] = [];
  try {
    rows = parseJsonl<PromotionLoopCloseLedgerRecord>(await readFile(file, 'utf8'));
  } catch (err) {
    log.info(`[PROMOTION_LOOP_HYDRATE] skipped — ${file} unavailable (${err})`);
  }
  const summary = hydratePromotionLoopGuardFromCloseRecords(rows, {
    sinceMs: hydrationSinceMs(nowMs),
    resetBeforeHydrate: false,
  });
  await refreshPromotionLoopResetPreflightFromPaperLedger(ledgerDir, nowMs, true);
  const snapshot = getPromotionLoopStateSnapshot();
  log.info(
    `[PROMOTION_LOOP_HYDRATE] loaded=${summary.loadedRows} replayed=${summary.replayedRows} ` +
    `skipped=${summary.skippedRows} since=${summary.sinceMs ? new Date(summary.sinceMs).toISOString() : 'all'} ` +
    `status=${snapshot.status} closes=${snapshot.closeCount} net=${snapshot.cumulativePnlSol.toFixed(6)}`
  );
  return summary;
}

export async function refreshPromotionLoopResetPreflightFromPaperLedger(
  ledgerDir = config.realtimeDataDir,
  nowMs = Date.now(),
  force = false
): Promise<PromotionLoopResetPreflightReport> {
  if (
    !force &&
    resetPreflightReport &&
    nowMs - resetPreflightRefreshedAtMs < PROMOTION_LOOP_RESET_PREFLIGHT_REFRESH_MS
  ) {
    return resetPreflightReport;
  }
  const paperRows = await readPromotionLoopPaperRows(ledgerDir);
  const sinceMs = hydrationSinceMs(nowMs) ?? 0;
  const report = buildPromotionLoopResetPreflightReport(paperRows, sinceMs, nowMs);
  const previousStatus = resetPreflightReport?.status ?? null;
  resetPreflightReport = report;
  resetPreflightRefreshedAtMs = nowMs;
  if (previousStatus !== report.status) {
    log.warn(
      `[PROMOTION_LOOP_RESET_PREFLIGHT] status=${report.status} ` +
      `eligible=${report.eligiblePaperRows}/${report.minPaperCloses} ` +
      `recent=${report.recentEligiblePaperRows}/${report.minRecentPaperCloses} ` +
      `recentNet=${report.recentRefundAdjustedNetSol.toFixed(6)} ` +
      `reason=${report.reasons[0] ?? 'ready'}`
    );
  }
  return report;
}

export function applyPromotionLoopResetPreflightRowsForTests(
  rows: PromotionLoopJsonRow[],
  sinceMs: number,
  nowMs = Date.now()
): PromotionLoopResetPreflightReport {
  resetPreflightReport = buildPromotionLoopResetPreflightReport(rows, sinceMs, nowMs);
  resetPreflightRefreshedAtMs = nowMs;
  return resetPreflightReport;
}

export function getPromotionLoopResetPreflightSnapshot(): PromotionLoopResetPreflightReport | null {
  return resetPreflightReport;
}

export function getPromotionLoopStateSnapshot(): PromotionLoopStateSnapshot {
  return {
    cohort: PROMOTION_LOOP_COHORT,
    status: state.status,
    closeCount: state.closeCount,
    checkpointCloseCount: state.checkpointCloseCount,
    cumulativePnlSol: state.cumulativePnlSol,
    checkpointPnlSol: state.checkpointPnlSol,
    consecutiveLosers: state.consecutiveLosers,
    lastHaltReason: state.lastHaltReason,
  };
}

export function resetPromotionLoopGuardForTests(): void {
  state.status = 'collecting';
  state.closeCount = 0;
  state.checkpointCloseCount = 0;
  state.cumulativePnlSol = 0;
  state.checkpointPnlSol = 0;
  state.consecutiveLosers = 0;
  state.lastHaltReason = null;
  resetPreflightReport = null;
  resetPreflightRefreshedAtMs = 0;
}
