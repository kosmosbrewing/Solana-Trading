#!/usr/bin/env ts-node
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = Record<string, JsonValue | undefined>;

export type RotationPromotionGateStatus = 'READY' | 'WAIT' | 'REJECT';
export type RotationPromotionBlockerDisposition =
  | 'READY_REVIEW'
  | 'WAIT_MORE_FORWARD_SAMPLE'
  | 'CODE_OR_LEDGER_ATTRIBUTION_REVIEW'
  | 'STRATEGY_COST_REDESIGN'
  | 'NO_REPORT';
export type MicroCanaryPreflightStatus = 'READY_FOR_MANUAL_REVIEW' | 'BLOCKED_UNTIL_GATE_READY';

interface Args {
  reportJsonFiles: string[];
  primaryWindowHours: number;
  floorSol: number;
  sleeveLossCapSol: number;
  microCloseTarget: number;
  microActiveDaysTarget: number;
  maxTicketSol: number;
  jsonOut?: string;
  mdOut?: string;
  historyOut?: string;
}

interface ReadinessGap {
  minUniqueCandidates: number;
  currentUniqueCandidates: number;
  neededUniqueCandidates: number;
  minActiveDays: number;
  currentActiveDays: number;
  neededActiveDays: number;
  minPositiveDays: number;
  currentPositiveDays: number;
  neededPositiveDays: number;
  currentWalletStressSol: number;
  walletStressPositivePass: boolean;
  maxTopWinnerShare: number;
  currentTopWinnerShare: number | null;
  topWinnerSharePass: boolean;
  parentChildDeltaWalletStressSol: number;
  parentChildDeltaPass: boolean;
}

interface CountRow extends JsonObject {
  blocker?: string;
  classification?: string;
  step?: string;
  count?: number;
  rows?: number;
  uniqueCandidates?: number;
  refundAdjustedNetSol?: number;
  walletStressSol?: number;
}

interface BlockerSummary {
  blocker: string;
  count: number;
  refundAdjustedNetSol: number | null;
  walletStressSol: number | null;
}

interface BridgeReconciliationSummary {
  priority: string;
  disposition: string;
  blocker: string;
  action: string;
  rows: number;
  uniqueCandidates: number;
  walletStressSol: number | null;
}

interface FunnelSummary {
  step: string;
  rows: number;
}

export interface PromotionBlockerDrilldown {
  disposition: RotationPromotionBlockerDisposition;
  explanation: string;
  strictPromotionRows: number;
  bridgeRows: number;
  uniqueBridgeCandidates: number;
  safeBridgeRows: number;
  safeBridgeUniqueCandidates: number;
  missingMetadataRows: number;
  dominantBlocker: string | null;
  topBlockers: BlockerSummary[];
  singleBlockerNearMisses: BlockerSummary[];
  bridgeReconciliationBacklog: BridgeReconciliationSummary[];
  funnel: FunnelSummary[];
  bridgeFunnel: FunnelSummary[];
}

export interface RotationPromotionReportInput {
  [key: string]: unknown;
  generatedAt?: string;
  sinceHours?: number | null;
  verdict?: string;
  recommendedNextAction?: string;
  primaryBridgeReadinessGap?: Partial<ReadinessGap>;
  uniquePrimaryBridgeCandidates?: number;
  primaryBridgeActiveDays?: number;
  primaryBridgePositiveDays?: number;
  primaryBridgeWalletStressSol?: number;
  primaryBridgeTopWinnerShare?: number | null;
  primaryBridgeParentChildDelta?: {
    deltaWalletStressSol?: number;
  };
  promotionCandidateRows?: number;
  bridgeCandidateRows?: number;
  uniqueBridgeCandidates?: number;
  blockers?: CountRow[];
  singleBlockers?: CountRow[];
  funnel?: CountRow[];
  bridgeFunnel?: CountRow[];
  promotionEvidenceBuckets?: CountRow[];
  bridgeReconciliationBacklog?: JsonObject[];
}

export interface RotationPromotionWindowGate {
  windowHours: number | null;
  status: RotationPromotionGateStatus;
  verdict: string;
  reasons: string[];
  readinessGap: ReadinessGap;
  blockerDrilldown: PromotionBlockerDrilldown;
}

export interface RotationPromotionGatekeeperReport {
  generatedAt: string;
  status: RotationPromotionGateStatus;
  liveAutoEnableAllowed: false;
  primaryWindowHours: number;
  primaryWindowStatus: RotationPromotionGateStatus;
  primaryBlockerDisposition: RotationPromotionBlockerDisposition;
  nextAction: string;
  reasons: string[];
  microCanaryPlan: MicroCanaryPlan;
  windows: RotationPromotionWindowGate[];
}

export interface RotationPromotionGatekeeperHistoryRow {
  recordedAt: string;
  fingerprint: string;
  status: RotationPromotionGateStatus;
  primaryWindowHours: number;
  nextAction: string;
  reasons: string[];
  microCanaryReviewAllowed: boolean;
  microCanaryMaxSleeveLossSol: number;
  blockerDisposition: RotationPromotionBlockerDisposition;
  windows: Array<{
    windowHours: number | null;
    status: RotationPromotionGateStatus;
    currentUniqueCandidates: number;
    neededUniqueCandidates: number;
    currentActiveDays: number;
    neededActiveDays: number;
    currentPositiveDays: number;
    neededPositiveDays: number;
    walletStressSol: number;
    topWinnerShare: number | null;
    parentChildDeltaWalletStressSol: number;
    blockerDisposition: RotationPromotionBlockerDisposition;
    dominantBlocker: string | null;
    safeBridgeRows: number;
    safeBridgeUniqueCandidates: number;
    missingMetadataRows: number;
  }>;
}

export interface MicroCanaryPlan {
  reviewAllowed: boolean;
  liveAutoEnableAllowed: false;
  preflightStatus: MicroCanaryPreflightStatus;
  targetArm: string;
  floorSol: number;
  maxSleeveLossSol: number;
  maxSleeveLossAsFloorPct: number;
  maxCloseCount: number;
  minActiveDays: number;
  maxTicketSol: number;
  requiredEnvDiff: string[];
  rollbackConditions: string[];
  stopRules: string[];
}

export interface RotationPromotionGatekeeperOptions {
  primaryWindowHours?: number;
  floorSol?: number;
  sleeveLossCapSol?: number;
  microCloseTarget?: number;
  microActiveDaysTarget?: number;
  maxTicketSol?: number;
}

const DEFAULT_MIN_UNIQUE_CANDIDATES = 30;
const DEFAULT_MIN_ACTIVE_DAYS = 3;
const DEFAULT_MAX_TOP_WINNER_SHARE = 0.35;
const DEFAULT_FLOOR_SOL = 0.6;
const DEFAULT_SLEEVE_LOSS_CAP_SOL = 0.02;
const DEFAULT_MICRO_CLOSE_TARGET = 30;
const DEFAULT_MICRO_ACTIVE_DAYS_TARGET = 7;
const DEFAULT_MAX_TICKET_SOL = 0.002;
const MICRO_CANARY_TARGET_ARM = 'rotation_underfill_cost_aware_exit_v2';

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    reportJsonFiles: [],
    primaryWindowHours: 168,
    floorSol: DEFAULT_FLOOR_SOL,
    sleeveLossCapSol: DEFAULT_SLEEVE_LOSS_CAP_SOL,
    microCloseTarget: DEFAULT_MICRO_CLOSE_TARGET,
    microActiveDaysTarget: DEFAULT_MICRO_ACTIVE_DAYS_TARGET,
    maxTicketSol: DEFAULT_MAX_TICKET_SOL,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--report-json' && next) {
      args.reportJsonFiles.push(next);
      i += 1;
    } else if (arg.startsWith('--report-json=')) {
      args.reportJsonFiles.push(arg.slice('--report-json='.length));
    } else if (arg === '--primary-window-hours' && next) {
      args.primaryWindowHours = Number(next);
      i += 1;
    } else if (arg.startsWith('--primary-window-hours=')) {
      args.primaryWindowHours = Number(arg.slice('--primary-window-hours='.length));
    } else if (arg === '--floor-sol' && next) {
      args.floorSol = Number(next);
      i += 1;
    } else if (arg.startsWith('--floor-sol=')) {
      args.floorSol = Number(arg.slice('--floor-sol='.length));
    } else if (arg === '--sleeve-loss-cap-sol' && next) {
      args.sleeveLossCapSol = Number(next);
      i += 1;
    } else if (arg.startsWith('--sleeve-loss-cap-sol=')) {
      args.sleeveLossCapSol = Number(arg.slice('--sleeve-loss-cap-sol='.length));
    } else if (arg === '--micro-close-target' && next) {
      args.microCloseTarget = Number(next);
      i += 1;
    } else if (arg.startsWith('--micro-close-target=')) {
      args.microCloseTarget = Number(arg.slice('--micro-close-target='.length));
    } else if (arg === '--micro-active-days-target' && next) {
      args.microActiveDaysTarget = Number(next);
      i += 1;
    } else if (arg.startsWith('--micro-active-days-target=')) {
      args.microActiveDaysTarget = Number(arg.slice('--micro-active-days-target='.length));
    } else if (arg === '--max-ticket-sol' && next) {
      args.maxTicketSol = Number(next);
      i += 1;
    } else if (arg.startsWith('--max-ticket-sol=')) {
      args.maxTicketSol = Number(arg.slice('--max-ticket-sol='.length));
    } else if (arg === '--json-out' && next) {
      args.jsonOut = next;
      i += 1;
    } else if (arg.startsWith('--json-out=')) {
      args.jsonOut = arg.slice('--json-out='.length);
    } else if (arg === '--md-out' && next) {
      args.mdOut = next;
      i += 1;
    } else if (arg.startsWith('--md-out=')) {
      args.mdOut = arg.slice('--md-out='.length);
    } else if (arg === '--history-out' && next) {
      args.historyOut = next;
      i += 1;
    } else if (arg.startsWith('--history-out=')) {
      args.historyOut = arg.slice('--history-out='.length);
    }
  }
  return args;
}

async function readJsonReport(file: string): Promise<RotationPromotionReportInput | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return isObject(parsed) ? parsed as RotationPromotionReportInput : null;
  } catch {
    return null;
  }
}

function readinessGapFromReport(report: RotationPromotionReportInput): ReadinessGap {
  const gap = isObject(report.primaryBridgeReadinessGap) ? report.primaryBridgeReadinessGap : {};
  const minUnique = num(gap.minUniqueCandidates, DEFAULT_MIN_UNIQUE_CANDIDATES);
  const currentUnique = num(gap.currentUniqueCandidates, num(report.uniquePrimaryBridgeCandidates, 0));
  const minActiveDays = num(gap.minActiveDays, DEFAULT_MIN_ACTIVE_DAYS);
  const currentActiveDays = num(gap.currentActiveDays, num(report.primaryBridgeActiveDays, 0));
  const minPositiveDays = num(gap.minPositiveDays, DEFAULT_MIN_ACTIVE_DAYS);
  const currentPositiveDays = num(gap.currentPositiveDays, num(report.primaryBridgePositiveDays, 0));
  const walletStress = num(gap.currentWalletStressSol, num(report.primaryBridgeWalletStressSol, 0));
  const topWinnerShare = gap.currentTopWinnerShare == null
    ? (report.primaryBridgeTopWinnerShare == null ? null : num(report.primaryBridgeTopWinnerShare, 1))
    : num(gap.currentTopWinnerShare, 1);
  const parentDelta = num(
    gap.parentChildDeltaWalletStressSol,
    num(report.primaryBridgeParentChildDelta?.deltaWalletStressSol, 0)
  );
  const maxTopWinnerShare = num(gap.maxTopWinnerShare, DEFAULT_MAX_TOP_WINNER_SHARE);

  return {
    minUniqueCandidates: minUnique,
    currentUniqueCandidates: currentUnique,
    neededUniqueCandidates: Math.max(0, minUnique - currentUnique),
    minActiveDays,
    currentActiveDays,
    neededActiveDays: Math.max(0, minActiveDays - currentActiveDays),
    minPositiveDays,
    currentPositiveDays,
    neededPositiveDays: Math.max(0, minPositiveDays - currentPositiveDays),
    currentWalletStressSol: walletStress,
    walletStressPositivePass: walletStress > 0,
    maxTopWinnerShare,
    currentTopWinnerShare: topWinnerShare,
    topWinnerSharePass: (topWinnerShare ?? 1) <= maxTopWinnerShare,
    parentChildDeltaWalletStressSol: parentDelta,
    parentChildDeltaPass: parentDelta > 0,
  };
}

function blockerSummaries(value: unknown): BlockerSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObject)
    .map((row) => ({
      blocker: str(row.blocker, ''),
      count: num(row.count, 0),
      refundAdjustedNetSol: typeof row.refundAdjustedNetSol === 'number' ? row.refundAdjustedNetSol : null,
      walletStressSol: typeof row.walletStressSol === 'number' ? row.walletStressSol : null,
    }))
    .filter((row) => row.blocker.length > 0)
    .sort((a, b) => b.count - a.count || a.blocker.localeCompare(b.blocker));
}

function bridgeReconciliationSummaries(value: unknown): BridgeReconciliationSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObject)
    .map((row) => ({
      priority: str(row.priority, ''),
      disposition: str(row.disposition, ''),
      blocker: str(row.blocker, ''),
      action: str(row.action, ''),
      rows: num(row.rows, 0),
      uniqueCandidates: num(row.uniqueCandidates, 0),
      walletStressSol: typeof row.walletStressSol === 'number' ? row.walletStressSol : null,
    }))
    .filter((row) => row.priority.length > 0 && row.blocker.length > 0)
    .sort((a, b) =>
      a.priority.localeCompare(b.priority) ||
      b.rows - a.rows ||
      a.blocker.localeCompare(b.blocker)
    );
}

function funnelSummaries(value: unknown): FunnelSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObject)
    .map((row) => ({
      step: str(row.step, ''),
      rows: num(row.rows, 0),
    }))
    .filter((row) => row.step.length > 0);
}

function evidenceBucket(value: unknown, classification: string): CountRow | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter(isObject)
    .find((row) => str(row.classification, '') === classification) as CountRow | undefined ?? null;
}

function hasPositiveNearMiss(rows: BlockerSummary[], blocker: string): boolean {
  return rows.some((row) => row.blocker === blocker && (row.walletStressSol ?? 0) > 0);
}

function buildBlockerDrilldown(
  report: RotationPromotionReportInput,
  status: RotationPromotionGateStatus,
  readinessGap: ReadinessGap
): PromotionBlockerDrilldown {
  const strictPromotionRows = num(report.promotionCandidateRows, 0);
  const bridgeRows = num(report.bridgeCandidateRows, 0);
  const uniqueBridgeCandidates = num(report.uniqueBridgeCandidates, readinessGap.currentUniqueCandidates);
  const topBlockers = blockerSummaries(report.blockers).slice(0, 8);
  const singleBlockerNearMisses = blockerSummaries(report.singleBlockers).slice(0, 8);
  const bridgeReconciliationBacklog = bridgeReconciliationSummaries(report.bridgeReconciliationBacklog).slice(0, 8);
  const funnel = funnelSummaries(report.funnel);
  const bridgeFunnel = funnelSummaries(report.bridgeFunnel);
  const dominantBlocker = topBlockers[0]?.blocker ?? null;
  const hasEvidenceClassification = Array.isArray(report.promotionEvidenceBuckets);
  const safeBridgeBucket = evidenceBucket(report.promotionEvidenceBuckets, 'safe_bridge_candidate');
  const missingMetadataBucket = evidenceBucket(report.promotionEvidenceBuckets, 'missing_metadata');
  const safeBridgeRows = hasEvidenceClassification ? num(safeBridgeBucket?.rows, 0) : 0;
  const safeBridgeUniqueCandidates = hasEvidenceClassification ? num(safeBridgeBucket?.uniqueCandidates, 0) : 0;
  const missingMetadataRows = num(missingMetadataBucket?.rows, 0);
  const positiveBridgeExists = bridgeRows > 0 && readinessGap.currentWalletStressSol > 0;
  const attributionNearMiss =
    strictPromotionRows === 0 &&
    positiveBridgeExists &&
    safeBridgeRows === 0 &&
    (
      !hasEvidenceClassification ||
      hasPositiveNearMiss(singleBlockerNearMisses, 'non_comparable_role') ||
      hasPositiveNearMiss(singleBlockerNearMisses, 'missing_cost_aware_profile') ||
      hasPositiveNearMiss(singleBlockerNearMisses, 'missing_execution_plan_hash') ||
      hasPositiveNearMiss(singleBlockerNearMisses, 'missing_decision_id') ||
      hasPositiveNearMiss(singleBlockerNearMisses, 'missing_candidate_id')
    );

  if (status === 'READY') {
    return {
      disposition: 'READY_REVIEW',
      explanation: 'readiness gates passed; manual micro-canary review can be prepared, but live auto-enable stays blocked',
      strictPromotionRows,
      bridgeRows,
      uniqueBridgeCandidates,
      safeBridgeRows,
      safeBridgeUniqueCandidates,
      missingMetadataRows,
      dominantBlocker,
      topBlockers,
      singleBlockerNearMisses,
      bridgeReconciliationBacklog,
      funnel,
      bridgeFunnel,
    };
  }

  if (status === 'REJECT') {
    return {
      disposition: 'STRATEGY_COST_REDESIGN',
      explanation: 'wallet/cost/concentration gates failed; redesign the cohort before funded testing',
      strictPromotionRows,
      bridgeRows,
      uniqueBridgeCandidates,
      safeBridgeRows,
      safeBridgeUniqueCandidates,
      missingMetadataRows,
      dominantBlocker,
      topBlockers,
      singleBlockerNearMisses,
      bridgeReconciliationBacklog,
      funnel,
      bridgeFunnel,
    };
  }

  if (attributionNearMiss) {
    return {
      disposition: 'CODE_OR_LEDGER_ATTRIBUTION_REVIEW',
      explanation: 'positive bridge rows exist, but strict promotion rows are blocked by role/profile/id attribution',
      strictPromotionRows,
      bridgeRows,
      uniqueBridgeCandidates,
      safeBridgeRows,
      safeBridgeUniqueCandidates,
      missingMetadataRows,
      dominantBlocker,
      topBlockers,
      singleBlockerNearMisses,
      bridgeReconciliationBacklog,
      funnel,
      bridgeFunnel,
    };
  }

  return {
    disposition: 'WAIT_MORE_FORWARD_SAMPLE',
    explanation: 'readiness quality gates are not failed; collect more forward bridge candidates and active days',
    strictPromotionRows,
    bridgeRows,
    uniqueBridgeCandidates,
    safeBridgeRows,
    safeBridgeUniqueCandidates,
    missingMetadataRows,
    dominantBlocker,
    topBlockers,
    singleBlockerNearMisses,
    bridgeReconciliationBacklog,
    funnel,
    bridgeFunnel,
  };
}

export function evaluateRotationPromotionWindow(
  report: RotationPromotionReportInput
): RotationPromotionWindowGate {
  const readinessGap = readinessGapFromReport(report);
  const reasons: string[] = [];
  if (readinessGap.neededUniqueCandidates > 0) {
    reasons.push(`need +${readinessGap.neededUniqueCandidates} unique bridge candidates`);
  }
  if (readinessGap.neededActiveDays > 0) {
    reasons.push(`need +${readinessGap.neededActiveDays} active days`);
  }
  if (readinessGap.neededPositiveDays > 0) {
    reasons.push(`need +${readinessGap.neededPositiveDays} positive days`);
  }
  if (!readinessGap.walletStressPositivePass) {
    reasons.push(`wallet stress ${readinessGap.currentWalletStressSol.toFixed(6)} <= 0`);
  }
  if (!readinessGap.topWinnerSharePass) {
    reasons.push(
      `top winner share ${formatPct(readinessGap.currentTopWinnerShare)} > ${formatPct(readinessGap.maxTopWinnerShare)}`
    );
  }
  if (!readinessGap.parentChildDeltaPass) {
    reasons.push(`parent-child wallet delta ${readinessGap.parentChildDeltaWalletStressSol.toFixed(6)} <= 0`);
  }

  const hardRejected =
    !readinessGap.walletStressPositivePass ||
    !readinessGap.topWinnerSharePass ||
    !readinessGap.parentChildDeltaPass;
  const status: RotationPromotionGateStatus = hardRejected
    ? 'REJECT'
    : reasons.length > 0
      ? 'WAIT'
      : 'READY';

  return {
    windowHours: report.sinceHours ?? null,
    status,
    verdict: str(report.verdict, 'UNKNOWN'),
    reasons,
    readinessGap,
    blockerDrilldown: buildBlockerDrilldown(report, status, readinessGap),
  };
}

export function buildRotationPromotionGatekeeperReport(
  reports: RotationPromotionReportInput[],
  options: RotationPromotionGatekeeperOptions = {}
): RotationPromotionGatekeeperReport {
  const primaryWindowHours = options.primaryWindowHours ?? 168;
  const windows = reports
    .map(evaluateRotationPromotionWindow)
    .sort((a, b) => num(a.windowHours, 0) - num(b.windowHours, 0));
  const primary = windows.find((row) => row.windowHours === primaryWindowHours) ??
    windows[windows.length - 1];

  if (!primary) {
    return {
      generatedAt: new Date().toISOString(),
      status: 'WAIT',
      liveAutoEnableAllowed: false,
      primaryWindowHours,
      primaryWindowStatus: 'WAIT',
      primaryBlockerDisposition: 'NO_REPORT',
      nextAction: 'collect promotion candidate reports before any live change',
      reasons: ['no promotion candidate report json supplied'],
      microCanaryPlan: buildMicroCanaryPlan('WAIT', options),
      windows,
    };
  }

  const nextAction = primary.status === 'WAIT' &&
    primary.blockerDrilldown.disposition === 'CODE_OR_LEDGER_ATTRIBUTION_REVIEW'
    ? 'keep live unchanged; review paper role/cost-aware/id attribution before waiting on sample'
    : primary.status === 'READY'
    ? 'queue manual tiny micro-canary review; do not auto-enable live'
    : primary.status === 'REJECT'
      ? 'keep paper-only; redesign bridge cohort before any funded test'
      : 'keep live unchanged; collect missing bridge evidence';

  return {
    generatedAt: new Date().toISOString(),
    status: primary.status,
    liveAutoEnableAllowed: false,
    primaryWindowHours,
    primaryWindowStatus: primary.status,
    primaryBlockerDisposition: primary.blockerDrilldown.disposition,
    nextAction,
    reasons: primary.reasons,
    microCanaryPlan: buildMicroCanaryPlan(primary.status, options),
    windows,
  };
}

function buildMicroCanaryPlan(
  gateStatus: RotationPromotionGateStatus,
  options: RotationPromotionGatekeeperOptions
): MicroCanaryPlan {
  const floorSol = options.floorSol ?? DEFAULT_FLOOR_SOL;
  const maxSleeveLossSol = options.sleeveLossCapSol ?? DEFAULT_SLEEVE_LOSS_CAP_SOL;
  return {
    reviewAllowed: gateStatus === 'READY',
    liveAutoEnableAllowed: false,
    preflightStatus: gateStatus === 'READY' ? 'READY_FOR_MANUAL_REVIEW' : 'BLOCKED_UNTIL_GATE_READY',
    targetArm: MICRO_CANARY_TARGET_ARM,
    floorSol,
    maxSleeveLossSol,
    maxSleeveLossAsFloorPct: floorSol > 0 ? maxSleeveLossSol / floorSol : 0,
    maxCloseCount: options.microCloseTarget ?? DEFAULT_MICRO_CLOSE_TARGET,
    minActiveDays: options.microActiveDaysTarget ?? DEFAULT_MICRO_ACTIVE_DAYS_TARGET,
    maxTicketSol: options.maxTicketSol ?? DEFAULT_MAX_TICKET_SOL,
    requiredEnvDiff: gateStatus === 'READY'
      ? [
        `manual review only: include ${MICRO_CANARY_TARGET_ARM} in the explicit live canary allowlist for this sleeve`,
        `cap per-trade ticket at <= ${(options.maxTicketSol ?? DEFAULT_MAX_TICKET_SOL).toFixed(6)} SOL`,
        'do not enable broad rotation, smart-v3 scale-up, or research arms as part of this sleeve',
      ]
      : ['none; live configuration must remain unchanged until gate status is READY'],
    rollbackConditions: [
      `cumulative wallet loss reaches -${maxSleeveLossSol.toFixed(6)} SOL`,
      'any live close is missing comparable paper trace',
      'mirror/live or parent-child sign agreement breaks during the sleeve',
      'manual review rejects the first 30 closes or 7 active-day packet',
    ],
    stopRules: [
      `stop if cumulative wallet loss <= -${maxSleeveLossSol.toFixed(6)} SOL`,
      'stop on any live close without comparable paper trace',
      'stop if parent-child or mirror/live sign agreement breaks during review',
      'manual review required before any size increase',
    ],
  };
}

function formatPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function renderWindow(row: RotationPromotionWindowGate): string {
  const gap = row.readinessGap;
  return `| ${row.windowHours == null ? 'all' : `${row.windowHours}h`} | ${row.status} | ${row.verdict} | ` +
    `${gap.currentUniqueCandidates}/${gap.minUniqueCandidates} | ` +
    `${gap.currentActiveDays}/${gap.minActiveDays} | ` +
    `${gap.currentPositiveDays}/${gap.minPositiveDays} | ` +
    `${gap.currentWalletStressSol.toFixed(6)} | ${formatPct(gap.currentTopWinnerShare)} | ` +
    `${gap.parentChildDeltaWalletStressSol.toFixed(6)} | ${row.reasons.join('; ') || 'none'} |`;
}

function renderBlockerWindow(row: RotationPromotionWindowGate): string {
  const drilldown = row.blockerDrilldown;
  return `| ${row.windowHours == null ? 'all' : `${row.windowHours}h`} | ${drilldown.disposition} | ` +
    `${drilldown.strictPromotionRows} | ${drilldown.safeBridgeRows} | ${drilldown.safeBridgeUniqueCandidates} | ` +
    `${drilldown.missingMetadataRows} | ` +
    `${drilldown.dominantBlocker ?? 'none'} | ${drilldown.explanation} |`;
}

function renderBlockerRows(rows: BlockerSummary[]): string[] {
  if (rows.length === 0) return ['| none | 0 | n/a | n/a |'];
  return rows.map((row) =>
    `| ${row.blocker} | ${row.count} | ` +
    `${row.refundAdjustedNetSol == null ? 'n/a' : row.refundAdjustedNetSol.toFixed(6)} | ` +
    `${row.walletStressSol == null ? 'n/a' : row.walletStressSol.toFixed(6)} |`
  );
}

function renderBridgeReconciliationRows(rows: BridgeReconciliationSummary[]): string[] {
  if (rows.length === 0) return ['| none | none | none | 0 | 0 | n/a | n/a |'];
  return rows.map((row) =>
    `| ${row.priority} | ${row.disposition} | ${row.blocker} | ${row.rows} | ` +
    `${row.uniqueCandidates} | ${row.walletStressSol == null ? 'n/a' : row.walletStressSol.toFixed(6)} | ` +
    `${row.action} |`
  );
}

export function renderRotationPromotionGatekeeperReport(report: RotationPromotionGatekeeperReport): string {
  const lines: string[] = [];
  lines.push('# Rotation Promotion Gatekeeper');
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- status: ${report.status}`);
  lines.push(`- liveAutoEnableAllowed: ${report.liveAutoEnableAllowed}`);
  lines.push(`- primaryWindowHours: ${report.primaryWindowHours}`);
  lines.push(`- primaryBlockerDisposition: ${report.primaryBlockerDisposition}`);
  lines.push(`- nextAction: ${report.nextAction}`);
  lines.push(`- reasons: ${report.reasons.join('; ') || 'none'}`);
  lines.push('');
  lines.push('## Micro-Canary Sleeve');
  lines.push(`- reviewAllowed: ${report.microCanaryPlan.reviewAllowed}`);
  lines.push(`- liveAutoEnableAllowed: ${report.microCanaryPlan.liveAutoEnableAllowed}`);
  lines.push(`- preflightStatus: ${report.microCanaryPlan.preflightStatus}`);
  lines.push(`- targetArm: ${report.microCanaryPlan.targetArm}`);
  lines.push(`- floorSol: ${report.microCanaryPlan.floorSol.toFixed(6)}`);
  lines.push(`- maxSleeveLossSol: ${report.microCanaryPlan.maxSleeveLossSol.toFixed(6)}`);
  lines.push(`- maxSleeveLossAsFloorPct: ${formatPct(report.microCanaryPlan.maxSleeveLossAsFloorPct)}`);
  lines.push(`- maxCloseCount: ${report.microCanaryPlan.maxCloseCount}`);
  lines.push(`- minActiveDays: ${report.microCanaryPlan.minActiveDays}`);
  lines.push(`- maxTicketSol: ${report.microCanaryPlan.maxTicketSol.toFixed(6)}`);
  for (const rule of report.microCanaryPlan.stopRules) lines.push(`- ${rule}`);
  lines.push('');
  lines.push('## Micro-Canary Preflight Packet');
  if (report.microCanaryPlan.preflightStatus === 'READY_FOR_MANUAL_REVIEW') {
    lines.push(`- allowedArm: ${report.microCanaryPlan.targetArm}`);
    lines.push(`- maxTicketSol: ${report.microCanaryPlan.maxTicketSol.toFixed(6)}`);
    lines.push(`- maxSleeveLossSol: ${report.microCanaryPlan.maxSleeveLossSol.toFixed(6)}`);
    lines.push('- requiredEnvDiff:');
    for (const item of report.microCanaryPlan.requiredEnvDiff) lines.push(`  - ${item}`);
    lines.push('- rollbackConditions:');
    for (const item of report.microCanaryPlan.rollbackConditions) lines.push(`  - ${item}`);
  } else {
    lines.push('- live transition is blocked; keep current live configuration unchanged');
    lines.push('- requiredEnvDiff: none');
    lines.push('- rollbackConditions: n/a until gate status is READY');
  }
  lines.push('');
  lines.push('| window | status | sourceVerdict | unique | activeDays | positiveDays | walletStress | topWinnerShare | parentChildDelta | reasons |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---|');
  if (report.windows.length === 0) {
    lines.push('| none | WAIT | n/a | 0/30 | 0/3 | 0/3 | 0.000000 | n/a | 0.000000 | no reports |');
  } else {
    for (const row of report.windows) lines.push(renderWindow(row));
  }
  lines.push('');
  lines.push('## Promotion Blocker Drilldown');
  lines.push('| window | disposition | strictRows | safeBridgeRows | safeBridgeUnique | missingMetadataRows | dominantBlocker | explanation |');
  lines.push('|---|---|---:|---:|---:|---:|---|---|');
  if (report.windows.length === 0) {
    lines.push('| none | NO_REPORT | 0 | 0 | 0 | 0 | none | no promotion candidate report json supplied |');
  } else {
    for (const row of report.windows) lines.push(renderBlockerWindow(row));
  }
  lines.push('');
  const primaryWindow = report.windows.find((row) => row.windowHours === report.primaryWindowHours) ??
    report.windows[report.windows.length - 1];
  if (primaryWindow) {
    lines.push('### Primary Window Top Blockers');
    lines.push('| blocker | count | refund SOL | walletStress SOL |');
    lines.push('|---|---:|---:|---:|');
    lines.push(...renderBlockerRows(primaryWindow.blockerDrilldown.topBlockers.slice(0, 5)));
    lines.push('');
    lines.push('### Primary Window Single-Blocker Near Misses');
    lines.push('| blocker | count | refund SOL | walletStress SOL |');
    lines.push('|---|---:|---:|---:|');
    lines.push(...renderBlockerRows(primaryWindow.blockerDrilldown.singleBlockerNearMisses.slice(0, 5)));
    lines.push('');
    lines.push('### Primary Window Bridge Reconciliation Backlog');
    lines.push('| priority | disposition | blocker | rows | unique | walletStress SOL | action |');
    lines.push('|---|---|---|---:|---:|---:|---|');
    lines.push(...renderBridgeReconciliationRows(primaryWindow.blockerDrilldown.bridgeReconciliationBacklog.slice(0, 5)));
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function roundForFingerprint(value: number | null): number | null {
  return value == null ? null : Number(value.toFixed(9));
}

export function rotationPromotionHistoryFingerprint(
  report: RotationPromotionGatekeeperReport
): string {
  return JSON.stringify({
    status: report.status,
    primaryWindowHours: report.primaryWindowHours,
    primaryBlockerDisposition: report.primaryBlockerDisposition,
    reviewAllowed: report.microCanaryPlan.reviewAllowed,
    windows: report.windows.map((row) => ({
      windowHours: row.windowHours,
      status: row.status,
      currentUniqueCandidates: row.readinessGap.currentUniqueCandidates,
      neededUniqueCandidates: row.readinessGap.neededUniqueCandidates,
      currentActiveDays: row.readinessGap.currentActiveDays,
      neededActiveDays: row.readinessGap.neededActiveDays,
      currentPositiveDays: row.readinessGap.currentPositiveDays,
      neededPositiveDays: row.readinessGap.neededPositiveDays,
      walletStressSol: roundForFingerprint(row.readinessGap.currentWalletStressSol),
      topWinnerShare: roundForFingerprint(row.readinessGap.currentTopWinnerShare),
      parentChildDeltaWalletStressSol: roundForFingerprint(row.readinessGap.parentChildDeltaWalletStressSol),
      blockerDisposition: row.blockerDrilldown.disposition,
      dominantBlocker: row.blockerDrilldown.dominantBlocker,
      safeBridgeRows: row.blockerDrilldown.safeBridgeRows,
      safeBridgeUniqueCandidates: row.blockerDrilldown.safeBridgeUniqueCandidates,
      missingMetadataRows: row.blockerDrilldown.missingMetadataRows,
    })),
  });
}

export function toRotationPromotionHistoryRow(
  report: RotationPromotionGatekeeperReport
): RotationPromotionGatekeeperHistoryRow {
  return {
    recordedAt: report.generatedAt,
    fingerprint: rotationPromotionHistoryFingerprint(report),
    status: report.status,
    primaryWindowHours: report.primaryWindowHours,
    nextAction: report.nextAction,
    reasons: report.reasons,
    microCanaryReviewAllowed: report.microCanaryPlan.reviewAllowed,
    microCanaryMaxSleeveLossSol: report.microCanaryPlan.maxSleeveLossSol,
    blockerDisposition: report.primaryBlockerDisposition,
    windows: report.windows.map((row) => ({
      windowHours: row.windowHours,
      status: row.status,
      currentUniqueCandidates: row.readinessGap.currentUniqueCandidates,
      neededUniqueCandidates: row.readinessGap.neededUniqueCandidates,
      currentActiveDays: row.readinessGap.currentActiveDays,
      neededActiveDays: row.readinessGap.neededActiveDays,
      currentPositiveDays: row.readinessGap.currentPositiveDays,
      neededPositiveDays: row.readinessGap.neededPositiveDays,
      walletStressSol: row.readinessGap.currentWalletStressSol,
      topWinnerShare: row.readinessGap.currentTopWinnerShare,
      parentChildDeltaWalletStressSol: row.readinessGap.parentChildDeltaWalletStressSol,
      blockerDisposition: row.blockerDrilldown.disposition,
      dominantBlocker: row.blockerDrilldown.dominantBlocker,
      safeBridgeRows: row.blockerDrilldown.safeBridgeRows,
      safeBridgeUniqueCandidates: row.blockerDrilldown.safeBridgeUniqueCandidates,
      missingMetadataRows: row.blockerDrilldown.missingMetadataRows,
    })),
  };
}

function parseHistoryRows(text: string): RotationPromotionGatekeeperHistoryRow[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as RotationPromotionGatekeeperHistoryRow;
      } catch {
        return null;
      }
    })
    .filter((row): row is RotationPromotionGatekeeperHistoryRow => row != null);
}

export function shouldAppendRotationPromotionHistory(
  existingRows: RotationPromotionGatekeeperHistoryRow[],
  nextRow: RotationPromotionGatekeeperHistoryRow
): boolean {
  const last = existingRows[existingRows.length - 1];
  return !last || last.fingerprint !== nextRow.fingerprint;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const reports = (await Promise.all(args.reportJsonFiles.map(readJsonReport)))
    .filter((report): report is RotationPromotionReportInput => report != null);
  const report = buildRotationPromotionGatekeeperReport(reports, {
    primaryWindowHours: args.primaryWindowHours,
    floorSol: args.floorSol,
    sleeveLossCapSol: args.sleeveLossCapSol,
    microCloseTarget: args.microCloseTarget,
    microActiveDaysTarget: args.microActiveDaysTarget,
    maxTicketSol: args.maxTicketSol,
  });
  const md = renderRotationPromotionGatekeeperReport(report);
  if (args.mdOut) {
    await mkdir(path.dirname(args.mdOut), { recursive: true });
    await writeFile(args.mdOut, md, 'utf8');
  }
  if (args.jsonOut) {
    await mkdir(path.dirname(args.jsonOut), { recursive: true });
    await writeFile(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (args.historyOut) {
    const historyRow = toRotationPromotionHistoryRow(report);
    let existingRows: RotationPromotionGatekeeperHistoryRow[] = [];
    try {
      existingRows = parseHistoryRows(await readFile(args.historyOut, 'utf8'));
    } catch {
      existingRows = [];
    }
    if (shouldAppendRotationPromotionHistory(existingRows, historyRow)) {
      await mkdir(path.dirname(args.historyOut), { recursive: true });
      await appendFile(args.historyOut, `${JSON.stringify(historyRow)}\n`, 'utf8');
    }
  }
  if (!args.mdOut) process.stdout.write(md);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
