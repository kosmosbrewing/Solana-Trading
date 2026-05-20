#!/usr/bin/env ts-node
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import {
  assessPromotionLoopManualApproval,
  PROMOTION_LOOP_CHECKPOINT_CLOSES,
  PROMOTION_LOOP_CHECKPOINT_LOSS_CAP_SOL,
  PROMOTION_LOOP_COHORT,
  PROMOTION_LOOP_MANUAL_APPROVAL_FILE,
  PROMOTION_LOOP_MAX_CLOSES,
  PROMOTION_LOOP_MAX_CONSECUTIVE_LOSERS,
  PROMOTION_LOOP_MICRO_LIVE_MAX_TICKET_SOL,
  PROMOTION_LOOP_MICRO_LIVE_TARGET_ARM,
  PROMOTION_LOOP_TOTAL_LOSS_CAP_SOL,
  parsePromotionLoopManualApproval,
  type PromotionLoopManualApproval,
} from '../src/risk/promotionLoopGuard';
import {
  buildPromotionLoopResetPreflightReport,
  type PromotionLoopJsonRow,
  type PromotionLoopResetPreflightReport,
} from '../src/risk/promotionLoopResetPreflight';

type JsonRow = PromotionLoopJsonRow;

interface Args {
  realtimeDir: string;
  sinceMs: number;
  mdOut?: string;
  jsonOut?: string;
}

export interface PromotionLoopReportRow {
  recordedAtMs: number;
  positionId: string | null;
  tokenMint: string | null;
  canaryLane: string | null;
  armName: string | null;
  profileArm: string | null;
  entryArm: string | null;
  liveEquivalenceCandidateId: string | null;
  liveEquivalenceDecisionId: string | null;
  pnlSol: number;
  exitReason: string | null;
}

export interface PromotionLoopReport {
  cohort: typeof PROMOTION_LOOP_COHORT;
  verdict: 'NO_SAMPLE' | 'COLLECT' | 'KILL' | 'REVIEW';
  nextAction: string;
  resetPreflight: PromotionLoopResetPreflightReport;
  manualApproval: PromotionLoopManualApproval | null;
  runtimeResetDecision: 'BLOCKED' | 'ALLOWED';
  runtimeResetBlockReason: string | null;
  rows: number;
  unmarkedEligibleRows: number;
  missingTraceRows: number;
  closeCount: number;
  checkpointCloseCount: number;
  cumulativePnlSol: number;
  checkpointPnlSol: number;
  consecutiveLosers: number;
  statusReason: string | null;
  topExitReasons: Array<{ reason: string; rows: number; netSol: number }>;
}

function str(row: JsonRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(row: JsonRow, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(row: JsonRow, key: string): boolean {
  return row[key] === true;
}

function parseJsonl(text: string): JsonRow[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as JsonRow;
      } catch {
        return null;
      }
    })
    .filter((row): row is JsonRow => row !== null);
}

async function readJsonlMaybe(file: string): Promise<JsonRow[]> {
  try {
    return parseJsonl(await readFile(file, 'utf8'));
  } catch {
    return [];
  }
}

async function readJsonMaybe(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function parseSinceMs(value: string, nowMs = Date.now()): number {
  if (/^\d+h$/i.test(value)) return nowMs - Number(value.slice(0, -1)) * 60 * 60 * 1000;
  if (/^\d+d$/i.test(value)) return nowMs - Number(value.slice(0, -1)) * 24 * 60 * 60 * 1000;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : nowMs - 72 * 60 * 60 * 1000;
}

function parseArgs(argv: string[]): Args {
  let realtimeDir = 'data/realtime';
  let since = '72h';
  let mdOut: string | undefined;
  let jsonOut: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--realtime-dir' && next) {
      realtimeDir = next;
      i += 1;
    } else if (arg === '--since' && next) {
      since = next;
      i += 1;
    } else if (arg === '--md' && next) {
      mdOut = next;
      i += 1;
    } else if (arg === '--json' && next) {
      jsonOut = next;
      i += 1;
    }
  }
  return { realtimeDir, sinceMs: parseSinceMs(since), mdOut, jsonOut };
}

function isPartialReduce(row: JsonRow): boolean {
  return bool(row, 'isPartialReduce') ||
    bool(row, 'positionStillOpen') ||
    str(row, 'eventType') === 'rotation_flow_live_reduce';
}

function recordedAtMs(row: JsonRow): number | null {
  const raw = str(row, 'recordedAt') ?? str(row, 'closedAt');
  if (!raw) return null;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function rowPnlSol(row: JsonRow): number | null {
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

function isUnderfillEligible(row: JsonRow): boolean {
  const lane = str(row, 'canaryLane') ?? str(row, 'lane');
  if (lane !== 'kol_hunter_rotation') return false;
  return hasUnderfillLabel(row);
}

function hasUnderfillLabel(row: JsonRow): boolean {
  const labels = [str(row, 'armName'), str(row, 'profileArm'), str(row, 'entryArm')]
    .map((value) => String(value ?? '').toLowerCase());
  return labels.some((label) => label.includes('rotation_underfill'));
}

function toReportRow(row: JsonRow): PromotionLoopReportRow | null {
  const atMs = recordedAtMs(row);
  const pnlSol = rowPnlSol(row);
  if (atMs == null || pnlSol == null || isPartialReduce(row)) return null;
  return {
    recordedAtMs: atMs,
    positionId: str(row, 'positionId'),
    tokenMint: str(row, 'tokenMint') ?? str(row, 'pairAddress'),
    canaryLane: str(row, 'canaryLane') ?? str(row, 'lane'),
    armName: str(row, 'armName'),
    profileArm: str(row, 'profileArm'),
    entryArm: str(row, 'entryArm'),
    liveEquivalenceCandidateId: str(row, 'liveEquivalenceCandidateId'),
    liveEquivalenceDecisionId: str(row, 'liveEquivalenceDecisionId'),
    pnlSol,
    exitReason: str(row, 'exitReason'),
  };
}

export function buildPromotionLoopReport(
  rows: JsonRow[],
  sinceMs: number,
  paperRows: JsonRow[] = [],
  approval: PromotionLoopManualApproval | null = null,
  nowMs = Date.now()
): PromotionLoopReport {
  const recentRows = rows.filter((row) => {
    const atMs = recordedAtMs(row);
    return atMs != null && atMs >= sinceMs && !isPartialReduce(row);
  });
  const unmarkedEligibleRows = recentRows.filter((row) =>
    isUnderfillEligible(row) && row.promotionLoopCohort !== PROMOTION_LOOP_COHORT
  ).length;
  const markedRows = recentRows
    .filter((row) => row.promotionLoopCohort === PROMOTION_LOOP_COHORT)
    .map(toReportRow)
    .filter((row): row is PromotionLoopReportRow => row !== null)
    .sort((a, b) => a.recordedAtMs - b.recordedAtMs);

  let verdict: PromotionLoopReport['verdict'] = markedRows.length === 0 ? 'NO_SAMPLE' : 'COLLECT';
  let statusReason: string | null = null;
  let closeCount = 0;
  let checkpointCloseCount = 0;
  let cumulativePnlSol = 0;
  let checkpointPnlSol = 0;
  let consecutiveLosers = 0;
  let collecting = true;
  let missingTraceRows = 0;
  const exitBuckets = new Map<string, { rows: number; netSol: number }>();

  for (const row of markedRows) {
    closeCount += 1;
    checkpointCloseCount += 1;
    cumulativePnlSol += row.pnlSol;
    checkpointPnlSol += row.pnlSol;
    consecutiveLosers = row.pnlSol < 0 ? consecutiveLosers + 1 : 0;
    if (!row.liveEquivalenceCandidateId || !row.liveEquivalenceDecisionId) missingTraceRows += 1;
    const reason = row.exitReason ?? 'unknown';
    const bucket = exitBuckets.get(reason) ?? { rows: 0, netSol: 0 };
    bucket.rows += 1;
    bucket.netSol += row.pnlSol;
    exitBuckets.set(reason, bucket);

    if (collecting) {
      if (cumulativePnlSol <= -PROMOTION_LOOP_TOTAL_LOSS_CAP_SOL) {
        verdict = 'KILL';
        statusReason = `total_loss_cap ${cumulativePnlSol.toFixed(6)} <= -${PROMOTION_LOOP_TOTAL_LOSS_CAP_SOL}`;
        collecting = false;
      } else if (consecutiveLosers >= PROMOTION_LOOP_MAX_CONSECUTIVE_LOSERS) {
        verdict = 'KILL';
        statusReason = `consecutive_losers ${consecutiveLosers} >= ${PROMOTION_LOOP_MAX_CONSECUTIVE_LOSERS}`;
        collecting = false;
      } else if (
        checkpointCloseCount >= PROMOTION_LOOP_CHECKPOINT_CLOSES &&
        checkpointPnlSol <= -PROMOTION_LOOP_CHECKPOINT_LOSS_CAP_SOL
      ) {
        verdict = 'KILL';
        statusReason = `checkpoint_loss ${checkpointPnlSol.toFixed(6)} <= -${PROMOTION_LOOP_CHECKPOINT_LOSS_CAP_SOL}`;
        collecting = false;
      } else if (closeCount >= PROMOTION_LOOP_MAX_CLOSES) {
        verdict = 'REVIEW';
        statusReason = `review_checkpoint closes=${closeCount}/${PROMOTION_LOOP_MAX_CLOSES} net=${cumulativePnlSol.toFixed(6)}`;
        collecting = false;
      }
    }

    if (collecting && checkpointCloseCount >= PROMOTION_LOOP_CHECKPOINT_CLOSES) {
      checkpointCloseCount = 0;
      checkpointPnlSol = 0;
    }
  }

  const nextAction = (() => {
    if (verdict === 'NO_SAMPLE') return 'collect marked rotation_underfill micro-live closes; do not scale';
    if (verdict === 'KILL') return 'keep lane halted; redesign cohort before any funded retry';
    if (verdict === 'REVIEW') return 'manual GO/KILL/REDESIGN review before more live entries';
    return 'continue tiny micro-live only until next 5-close checkpoint; no scale-up';
  })();

  const topExitReasons = [...exitBuckets.entries()]
    .map(([reason, bucket]) => ({ reason, rows: bucket.rows, netSol: bucket.netSol }))
    .sort((a, b) => Math.abs(b.netSol) - Math.abs(a.netSol))
    .slice(0, 8);

  const resetPreflight = buildPromotionLoopResetPreflightReport(paperRows, sinceMs, nowMs);
  const runtimeResetBlockReason = resetPreflight.status === 'READY_TO_RESET'
    ? assessPromotionLoopManualApproval(approval, {
        lane: 'kol_hunter_rotation',
        profileArm: approval?.targetArm ?? PROMOTION_LOOP_MICRO_LIVE_TARGET_ARM,
        ticketSol: Math.min(approval?.maxTicketSol ?? PROMOTION_LOOP_MICRO_LIVE_MAX_TICKET_SOL, PROMOTION_LOOP_MICRO_LIVE_MAX_TICKET_SOL),
        liveEquivalenceCandidateId: 'report-candidate',
        liveEquivalenceDecisionId: 'report-decision',
      }, nowMs)
    : `promotion_loop_reset_preflight_${resetPreflight.status.toLowerCase()}`;

  return {
    cohort: PROMOTION_LOOP_COHORT,
    verdict,
    nextAction,
    resetPreflight,
    manualApproval: approval,
    runtimeResetDecision: runtimeResetBlockReason == null ? 'ALLOWED' : 'BLOCKED',
    runtimeResetBlockReason,
    rows: markedRows.length,
    unmarkedEligibleRows,
    missingTraceRows,
    closeCount,
    checkpointCloseCount,
    cumulativePnlSol,
    checkpointPnlSol,
    consecutiveLosers,
    statusReason,
    topExitReasons,
  };
}

export function renderPromotionLoopReport(report: PromotionLoopReport): string {
  const lines: string[] = [];
  lines.push(`# Promotion Loop Report`);
  lines.push('');
  lines.push(`- cohort: ${report.cohort}`);
  lines.push(`- verdict: ${report.verdict}`);
  lines.push(`- nextAction: ${report.nextAction}`);
  lines.push(`- closes: ${report.closeCount}/${PROMOTION_LOOP_MAX_CLOSES}`);
  lines.push(`- cumulativeNet: ${report.cumulativePnlSol.toFixed(6)} SOL`);
  lines.push(`- checkpoint: ${report.checkpointCloseCount}/${PROMOTION_LOOP_CHECKPOINT_CLOSES}, net=${report.checkpointPnlSol.toFixed(6)} SOL`);
  lines.push(`- consecutiveLosers: ${report.consecutiveLosers}/${PROMOTION_LOOP_MAX_CONSECUTIVE_LOSERS}`);
  lines.push(`- missingTraceRows: ${report.missingTraceRows}`);
  lines.push(`- legacyUnmarkedEligibleRows: ${report.unmarkedEligibleRows}`);
  if (report.statusReason) lines.push(`- statusReason: ${report.statusReason}`);
  lines.push('');
  lines.push('## Reset Preflight');
  lines.push('');
  lines.push(`- status: ${report.resetPreflight.status}`);
  lines.push(`- nextAction: ${report.resetPreflight.nextAction}`);
  lines.push(`- targetArm: ${report.resetPreflight.targetArm}`);
  lines.push(`- runtimeResetDecision: ${report.runtimeResetDecision}`);
  if (report.runtimeResetBlockReason) lines.push(`- runtimeResetBlockReason: ${report.runtimeResetBlockReason}`);
  lines.push(`- manualApprovalFile: ${PROMOTION_LOOP_MANUAL_APPROVAL_FILE}`);
  lines.push(`- manualApprovalPresent: ${report.manualApproval != null}`);
  lines.push(`- manualApprovalTarget: ${report.manualApproval?.targetArm ?? 'n/a'}`);
  lines.push(`- manualApprovalMaxTicket: ${report.manualApproval?.maxTicketSol?.toFixed(6) ?? 'n/a'} SOL`);
  lines.push(`- microTicketHardCap: ${PROMOTION_LOOP_MICRO_LIVE_MAX_TICKET_SOL.toFixed(6)} SOL`);
  lines.push(`- preferredTargetArm: ${PROMOTION_LOOP_MICRO_LIVE_TARGET_ARM}`);
  lines.push(`- eligiblePaperRows: ${report.resetPreflight.eligiblePaperRows}/${report.resetPreflight.minPaperCloses}`);
  lines.push(
    `- recent${report.resetPreflight.recentWindowHours}hEligiblePaperRows: ` +
    `${report.resetPreflight.recentEligiblePaperRows}/${report.resetPreflight.minRecentPaperCloses}`
  );
  lines.push(`- refundAdjustedNet: ${report.resetPreflight.refundAdjustedNetSol.toFixed(6)} SOL`);
  lines.push(`- recentRefundAdjustedNet: ${report.resetPreflight.recentRefundAdjustedNetSol.toFixed(6)} SOL`);
  lines.push(`- netSol: ${report.resetPreflight.netSol.toFixed(6)} SOL`);
  lines.push(`- recentNetSol: ${report.resetPreflight.recentNetSol.toFixed(6)} SOL`);
  lines.push(`- routeProofCoverage: ${formatRate(report.resetPreflight.routeProofCoverage)}`);
  lines.push(`- comparableTraceCoverage: ${formatRate(report.resetPreflight.comparableTraceCoverage)}`);
  lines.push(`- costEvidenceCoverage: ${formatRate(report.resetPreflight.costEvidenceCoverage)}`);
  lines.push(
    `- admissionFailureRate: ${formatRate(report.resetPreflight.admissionFailureRate)} ` +
    `(${report.resetPreflight.admissionFailureRows}/${report.resetPreflight.eligiblePaperRows})`
  );
  lines.push(
    `- recentAdmissionFailureRate: ${formatRate(report.resetPreflight.recentAdmissionFailureRate)} ` +
    `(${report.resetPreflight.recentAdmissionFailureRows}/${report.resetPreflight.recentEligiblePaperRows})`
  );
  if (report.resetPreflight.reasons.length > 0) {
    for (const reason of report.resetPreflight.reasons) lines.push(`- blocker: ${reason}`);
  }
  lines.push('');
  lines.push(`| exitReason | rows | net SOL |`);
  lines.push(`|---|---:|---:|`);
  if (report.topExitReasons.length === 0) {
    lines.push(`| none | 0 | 0.000000 |`);
  } else {
    for (const row of report.topExitReasons) {
      lines.push(`| ${row.reason} | ${row.rows} | ${row.netSol.toFixed(6)} |`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function formatRate(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows = await readJsonlMaybe(path.join(args.realtimeDir, 'executed-sells.jsonl'));
  const paperRows = await readJsonlMaybe(path.join(args.realtimeDir, 'rotation-v1-paper-trades.jsonl'));
  const approval = parsePromotionLoopManualApproval(
    await readJsonMaybe(path.join(args.realtimeDir, PROMOTION_LOOP_MANUAL_APPROVAL_FILE))
  );
  const report = buildPromotionLoopReport(rows, args.sinceMs, paperRows, approval);
  const md = renderPromotionLoopReport(report);
  if (args.mdOut) {
    await mkdir(path.dirname(args.mdOut), { recursive: true });
    await writeFile(args.mdOut, md, 'utf8');
  }
  if (args.jsonOut) {
    await mkdir(path.dirname(args.jsonOut), { recursive: true });
    await writeFile(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (!args.mdOut && !args.jsonOut) process.stdout.write(md);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
