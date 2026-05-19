#!/usr/bin/env ts-node
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

const ROTATION_PAPER_TRADES_FILE = 'rotation-v1-paper-trades.jsonl';
const KOL_PAPER_TRADES_FILE = 'kol-paper-trades.jsonl';
const COMPARABLE_ROLES = new Set(['mirror', 'fallback_execution_safety']);
const PRIMARY_BRIDGE_ARM = 'rotation_underfill_cost_aware_exit_v2';
const BRIDGE_REVIEW_MIN_UNIQUE_CANDIDATES = 30;
const BRIDGE_REVIEW_MIN_ACTIVE_DAYS = 3;
const BRIDGE_REVIEW_MAX_TOP_WINNER_SHARE = 0.35;

interface JsonRow {
  [key: string]: unknown;
}

interface Args {
  realtimeDir: string;
  sinceHours: number | null;
  assumedAtaRentSol: number;
  assumedNetworkFeeSol: number;
  jsonOut?: string;
}

interface CandidateRow {
  closedAt: string;
  armName: string;
  paperRole: string;
  parentPositionId?: string;
  parentPaperRole?: string;
  candidateId: string;
  decisionId: string;
  executionPlanHash: string;
  tokenMint: string;
  exitReason: string;
  refundAdjustedNetSol: number;
  walletStressSol: number;
}

interface DayBucketStats {
  day: string;
  candidates: number;
  refundAdjustedNetSol: number;
  walletStressSol: number;
}

interface ParentChildDeltaSummary {
  pairs: number;
  childBetterRows: number;
  childWorseRows: number;
  childEqualRows: number;
  parentWalletStressSol: number;
  childWalletStressSol: number;
  deltaWalletStressSol: number;
  parentRefundAdjustedNetSol: number;
  childRefundAdjustedNetSol: number;
  deltaRefundAdjustedNetSol: number;
}

type PromotionEvidenceClassification =
  | 'strict_candidate'
  | 'safe_bridge_candidate'
  | 'missing_metadata'
  | 'true_non_promotable';

interface PromotionEvidenceBucket {
  classification: PromotionEvidenceClassification;
  rows: number;
  uniqueCandidates: number;
  refundAdjustedNetSol: number;
  walletStressSol: number;
}

interface BridgeReadinessGap {
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

interface PrimaryBridgeNextNeededPacket {
  status: 'COLLECT_MORE' | 'READY_FOR_OOS_REVIEW';
  targetUniqueCandidates: number;
  currentUniqueCandidates: number;
  neededUniqueCandidates: number;
  activeDays: number;
  positiveDays: number;
  walletStressSol: number;
  topWinnerShare: number | null;
  parentChildDeltaWalletStressSol: number;
}

interface PromotionReport {
  generatedAt: string;
  sinceHours: number | null;
  verdict:
    | 'NO_SAMPLE'
    | 'STRICT_PROMOTION_READY'
    | 'BRIDGE_OOS_REVIEW'
    | 'BRIDGE_REVIEW_ONLY'
    | 'NO_PROMOTION_EDGE';
  recommendedNextAction: string;
  verdictReasons: string[];
  scopedRows: number;
  comparableRows: number;
  completeIdRows: number;
  routeProofRows: number;
  costAwareRows: number;
  walletStressPositiveRows: number;
  promotionCandidateRows: number;
  uniquePromotionCandidates: number;
  promotionRefundAdjustedNetSol: number;
  promotionWalletStressSol: number;
  funnel: Array<{ step: string; rows: number }>;
  bridgeFunnel: Array<{ step: string; rows: number }>;
  bridgeCandidateRows: number;
  uniqueBridgeCandidates: number;
  bridgeRefundAdjustedNetSol: number;
  bridgeWalletStressSol: number;
  primaryBridgeCandidateRows: number;
  uniquePrimaryBridgeCandidates: number;
  primaryBridgeRefundAdjustedNetSol: number;
  primaryBridgeWalletStressSol: number;
  primaryBridgeActiveDays: number;
  primaryBridgePositiveDays: number;
  primaryBridgeTopWinnerShare: number | null;
  primaryBridgeReadinessGap: BridgeReadinessGap;
  primaryBridgeDayBuckets: DayBucketStats[];
  primaryBridgeParentChildDelta: ParentChildDeltaSummary;
  primaryBridgeNextNeededPacket: PrimaryBridgeNextNeededPacket;
  primaryBridgeRoster: CandidateRow[];
  blockers: Array<{ blocker: string; count: number }>;
  singleBlockerRows: number;
  singleBlockers: Array<{ blocker: string; count: number; refundAdjustedNetSol: number; walletStressSol: number }>;
  promotionEvidenceBuckets: PromotionEvidenceBucket[];
  topArms: Array<{ arm: string; rows: number; walletStressSol: number }>;
  bridgeTopArms: Array<{ arm: string; rows: number; walletStressSol: number }>;
  candidates: CandidateRow[];
  bridgeCandidates: CandidateRow[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    realtimeDir: path.join('data', 'realtime'),
    sinceHours: 24,
    assumedAtaRentSol: 0.00207408,
    assumedNetworkFeeSol: 0.000105,
  };
  for (const arg of argv) {
    if (arg === '--all') args.sinceHours = null;
    else if (arg.startsWith('--realtime-dir=')) args.realtimeDir = arg.slice('--realtime-dir='.length);
    else if (arg.startsWith('--since-hours=')) args.sinceHours = Number(arg.slice('--since-hours='.length));
    else if (arg.startsWith('--assumed-ata-rent-sol=')) {
      args.assumedAtaRentSol = Number(arg.slice('--assumed-ata-rent-sol='.length));
    } else if (arg.startsWith('--assumed-network-fee-sol=')) {
      args.assumedNetworkFeeSol = Number(arg.slice('--assumed-network-fee-sol='.length));
    } else if (arg.startsWith('--json-out=')) args.jsonOut = arg.slice('--json-out='.length);
  }
  return args;
}

async function readJsonl(file: string): Promise<JsonRow[]> {
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

async function readRotationPaperTrades(realtimeDir: string): Promise<JsonRow[]> {
  const projected = await readJsonl(path.join(realtimeDir, ROTATION_PAPER_TRADES_FILE));
  if (projected.length > 0) return projected;
  return readJsonl(path.join(realtimeDir, KOL_PAPER_TRADES_FILE));
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function obj(value: unknown): JsonRow {
  return typeof value === 'object' && value != null ? value as JsonRow : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function timeMs(value: unknown): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function kstDay(valueMs: number): string {
  if (!Number.isFinite(valueMs)) return 'unknown';
  const kst = new Date(valueMs + 9 * 3600_000);
  return kst.toISOString().slice(0, 10);
}

function extrasOf(row: JsonRow): JsonRow {
  return obj(row.extras);
}

function rowArmName(row: JsonRow): string {
  const extras = extrasOf(row);
  return str(row.profileArm) ||
    str(extras.profileArm) ||
    str(row.armName) ||
    str(row.signalSource) ||
    str(extras.armName) ||
    str(row.parameterVersion) ||
    str(extras.parameterVersion) ||
    '(unknown)';
}

function isRotationArmValue(value: string): boolean {
  return value === 'kol_hunter_rotation_v1' ||
    value.startsWith('rotation_') ||
    value.startsWith('rotation-') ||
    value.includes('rotation_v1');
}

function isRotationPaperTrade(row: JsonRow): boolean {
  if (str(row.strategy) !== 'kol_hunter' && str(row.lane) !== 'kol_hunter') return false;
  if (isRotationArmValue(rowArmName(row))) return true;
  if (str(row.kolEntryReason) === 'rotation_v1' || str(row.entryReason) === 'rotation_v1') return true;
  return str(row.parameterVersion).startsWith('rotation-');
}

function survivalFlags(row: JsonRow): string[] {
  const extras = extrasOf(row);
  return [...arr(row.survivalFlags), ...arr(extras.survivalFlags)]
    .map(String)
    .filter(Boolean);
}

function paperRole(row: JsonRow): string {
  const extras = extrasOf(row);
  return str(row.paperRole) || str(extras.paperRole);
}

function executionPlan(row: JsonRow): JsonRow {
  return obj(row.executionPlanSnapshot);
}

function candidateId(row: JsonRow): string {
  const plan = executionPlan(row);
  const extras = extrasOf(row);
  return str(row.liveEquivalenceCandidateId) ||
    str(row.candidateId) ||
    str(plan.candidateId) ||
    str(extras.liveEquivalenceCandidateId) ||
    str(extras.candidateId);
}

function decisionId(row: JsonRow): string {
  const plan = executionPlan(row);
  const extras = extrasOf(row);
  return str(row.liveEquivalenceDecisionId) ||
    str(row.decisionId) ||
    str(plan.decisionId) ||
    str(extras.liveEquivalenceDecisionId) ||
    str(extras.decisionId);
}

function executionPlanHash(row: JsonRow): string {
  const plan = executionPlan(row);
  const extras = extrasOf(row);
  return str(row.executionPlanHash) ||
    str(plan.executionPlanHash) ||
    str(extras.executionPlanHash);
}

function tokenMint(row: JsonRow): string {
  const extras = extrasOf(row);
  return str(row.tokenMint) || str(row.mint) || str(extras.tokenMint);
}

function positionId(row: JsonRow): string {
  return str(row.positionId);
}

function parentPositionId(row: JsonRow): string {
  return str(row.parentPositionId);
}

function tokenOnlyNetSol(row: JsonRow): number {
  return num(row.netSolTokenOnly) ?? num(row.tokenOnlyNetSol) ?? num(row.netSol) ?? 0;
}

function refundAdjustedNetSol(row: JsonRow, assumedNetworkFeeSol: number): number {
  return tokenOnlyNetSol(row) - assumedNetworkFeeSol;
}

function walletStressSol(row: JsonRow, assumedAtaRentSol: number, assumedNetworkFeeSol: number): number {
  return tokenOnlyNetSol(row) - assumedNetworkFeeSol - assumedAtaRentSol;
}

function hasExplicitRouteBlock(row: JsonRow): boolean {
  const extras = extrasOf(row);
  const plan = executionPlan(row);
  const entryEvidence = obj(row.entrySellQuoteEvidence);
  const extraEntryEvidence = obj(extras.entrySellQuoteEvidence);
  const exitEvidence = obj(row.exitSellQuoteEvidence);
  const extraExitEvidence = obj(extras.exitSellQuoteEvidence);
  if (plan.routeFound === false) return true;
  if (row.routeFound === false || extras.routeFound === false) return true;
  if (row.sellRouteKnown === false || extras.sellRouteKnown === false) return true;
  if (row.exitRouteFound === false || extras.exitRouteFound === false) return true;
  if (row.exitSellRouteKnown === false || extras.exitSellRouteKnown === false) return true;
  if (entryEvidence.routeFound === false || extraEntryEvidence.routeFound === false) return true;
  if (exitEvidence.routeFound === false || extraExitEvidence.routeFound === false) return true;
  return survivalFlags(row).some((flag) =>
    flag === 'NO_SELL_ROUTE' ||
    flag === 'SELL_NO_ROUTE' ||
    flag === 'NO_ROUTE' ||
    flag.includes('NO_SELL_ROUTE')
  );
}

function hasRouteProof(row: JsonRow): boolean {
  if (hasExplicitRouteBlock(row)) return false;
  const extras = extrasOf(row);
  const plan = executionPlan(row);
  const entryEvidence = obj(row.entrySellQuoteEvidence);
  const extraEntryEvidence = obj(extras.entrySellQuoteEvidence);
  const exitEvidence = obj(row.exitSellQuoteEvidence);
  const extraExitEvidence = obj(extras.exitSellQuoteEvidence);
  if (plan.routeFound === true) return true;
  if (row.routeFound === true || extras.routeFound === true) return true;
  if (row.sellRouteKnown === true || extras.sellRouteKnown === true) return true;
  if (row.exitRouteFound === true || extras.exitRouteFound === true) return true;
  if (row.exitSellRouteKnown === true || extras.exitSellRouteKnown === true) return true;
  if (entryEvidence.routeFound === true || extraEntryEvidence.routeFound === true) return true;
  if (exitEvidence.routeFound === true || extraExitEvidence.routeFound === true) return true;
  return survivalFlags(row).some((flag) =>
    flag === 'SELL_ROUTE_OK' ||
    flag === 'EXIT_LIQUIDITY_KNOWN' ||
    flag === 'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_KNOWN'
  );
}

function isCostAware(row: JsonRow): boolean {
  const arm = rowArmName(row);
  const extras = extrasOf(row);
  const profileArm = str(row.profileArm) || str(extras.profileArm);
  const parameterVersion = str(row.parameterVersion) || str(extras.parameterVersion);
  return arm === 'rotation_underfill_cost_aware_exit_v2' ||
    profileArm === 'rotation_underfill_cost_aware_exit_v2' ||
    arm.includes('cost_aware') ||
    profileArm.includes('cost_aware') ||
    parameterVersion.includes('cost-aware') ||
    parameterVersion.includes('cost_aware') ||
    survivalFlags(row).includes('ROTATION_COST_AWARE_EXIT_V2');
}

function blockersFor(row: JsonRow, args: Args): string[] {
  const blockers: string[] = [];
  if (!COMPARABLE_ROLES.has(paperRole(row))) blockers.push('non_comparable_role');
  if (!candidateId(row)) blockers.push('missing_candidate_id');
  if (!decisionId(row)) blockers.push('missing_decision_id');
  if (!executionPlanHash(row)) blockers.push('missing_execution_plan_hash');
  if (!hasRouteProof(row)) blockers.push('missing_route_proof');
  if (!isCostAware(row)) blockers.push('missing_cost_aware_profile');
  if (walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol) <= 0) {
    blockers.push('wallet_stress_non_positive');
  }
  return blockers;
}

function hasCompleteIds(row: JsonRow): boolean {
  return Boolean(candidateId(row) && decisionId(row) && executionPlanHash(row));
}

function sameDecisionContext(child: JsonRow, parent: JsonRow): boolean {
  const childCandidate = candidateId(child);
  const childDecision = decisionId(child);
  const childHash = executionPlanHash(child);
  return Boolean(
    childCandidate &&
    childDecision &&
    childHash &&
    childCandidate === candidateId(parent) &&
    childDecision === decisionId(parent) &&
    childHash === executionPlanHash(parent)
  );
}

function buildFunnel(rows: JsonRow[], args: Args): Array<{ step: string; rows: number }> {
  const comparable = rows.filter((row) => COMPARABLE_ROLES.has(paperRole(row)));
  const completeIds = comparable.filter(hasCompleteIds);
  const routeProof = completeIds.filter(hasRouteProof);
  const costAware = routeProof.filter(isCostAware);
  const walletStressPositive = costAware.filter((row) =>
    walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol) > 0
  );
  return [
    { step: 'scoped', rows: rows.length },
    { step: 'comparable_role', rows: comparable.length },
    { step: 'complete_ids', rows: completeIds.length },
    { step: 'route_proof', rows: routeProof.length },
    { step: 'cost_aware', rows: costAware.length },
    { step: 'wallet_stress_positive', rows: walletStressPositive.length },
  ];
}

function countBlockers(rows: JsonRow[], args: Args): Array<{ blocker: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const blocker of blockersFor(row, args)) {
      counts.set(blocker, (counts.get(blocker) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([blocker, count]) => ({ blocker, count }))
    .sort((a, b) => b.count - a.count || a.blocker.localeCompare(b.blocker));
}

function topArms(rows: JsonRow[], args: Args): Array<{ arm: string; rows: number; walletStressSol: number }> {
  const byArm = new Map<string, { rows: number; walletStressSol: number }>();
  for (const row of rows) {
    const arm = rowArmName(row);
    const current = byArm.get(arm) ?? { rows: 0, walletStressSol: 0 };
    current.rows += 1;
    current.walletStressSol += walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol);
    byArm.set(arm, current);
  }
  return [...byArm.entries()]
    .map(([arm, value]) => ({ arm, ...value }))
    .sort((a, b) => b.walletStressSol - a.walletStressSol || b.rows - a.rows || a.arm.localeCompare(b.arm))
    .slice(0, 10);
}

function bridgeParent(row: JsonRow, byPositionId: Map<string, JsonRow>): JsonRow | null {
  const parentId = parentPositionId(row);
  if (!parentId) return null;
  return byPositionId.get(parentId) ?? null;
}

function buildBridgeFunnel(rows: JsonRow[], args: Args): Array<{ step: string; rows: number }> {
  const byPositionId = new Map(rows.map((row) => [positionId(row), row]).filter(([id]) => Boolean(id)) as Array<[string, JsonRow]>);
  const costAware = rows.filter(isCostAware);
  const withParent = costAware.filter((row) => bridgeParent(row, byPositionId));
  const parentComparable = withParent.filter((row) => {
    const parent = bridgeParent(row, byPositionId);
    return parent != null && COMPARABLE_ROLES.has(paperRole(parent));
  });
  const sameDecision = parentComparable.filter((row) => {
    const parent = bridgeParent(row, byPositionId);
    return parent != null && sameDecisionContext(row, parent);
  });
  const routeProof = sameDecision.filter((row) => {
    const parent = bridgeParent(row, byPositionId);
    return hasRouteProof(row) || (parent != null && hasRouteProof(parent));
  });
  const walletStressPositive = routeProof.filter((row) =>
    walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol) > 0
  );
  return [
    { step: 'cost_aware_rows', rows: costAware.length },
    { step: 'has_parent', rows: withParent.length },
    { step: 'parent_comparable_role', rows: parentComparable.length },
    { step: 'same_decision_context', rows: sameDecision.length },
    { step: 'route_proof', rows: routeProof.length },
    { step: 'wallet_stress_positive', rows: walletStressPositive.length },
  ];
}

function bridgeCandidateRows(rows: JsonRow[], args: Args): JsonRow[] {
  const byPositionId = new Map(rows.map((row) => [positionId(row), row]).filter(([id]) => Boolean(id)) as Array<[string, JsonRow]>);
  return rows.filter((row) => {
    if (!isCostAware(row)) return false;
    const parent = bridgeParent(row, byPositionId);
    return parent != null &&
      COMPARABLE_ROLES.has(paperRole(parent)) &&
      sameDecisionContext(row, parent) &&
      (hasRouteProof(row) || hasRouteProof(parent)) &&
      walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol) > 0;
  });
}

function isBridgeCandidate(row: JsonRow, byPositionId: Map<string, JsonRow>, args: Args): boolean {
  if (!isCostAware(row)) return false;
  const parent = bridgeParent(row, byPositionId);
  return parent != null &&
    COMPARABLE_ROLES.has(paperRole(parent)) &&
    sameDecisionContext(row, parent) &&
    (hasRouteProof(row) || hasRouteProof(parent)) &&
    walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol) > 0;
}

function primaryBridgeRows(rows: JsonRow[]): JsonRow[] {
  return rows.filter((row) => rowArmName(row) === PRIMARY_BRIDGE_ARM);
}

function dedupeRowsByCandidate(rows: JsonRow[]): JsonRow[] {
  const seen = new Set<string>();
  const out: JsonRow[] = [];
  for (const row of rows) {
    const key = candidateId(row) || positionId(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function dayBucketStats(
  rows: JsonRow[],
  args: Args
): DayBucketStats[] {
  const byDay = new Map<string, { candidates: number; refundAdjustedNetSol: number; walletStressSol: number }>();
  for (const row of rows) {
    const day = kstDay(timeMs(row.closedAt));
    const current = byDay.get(day) ?? { candidates: 0, refundAdjustedNetSol: 0, walletStressSol: 0 };
    current.candidates += 1;
    current.refundAdjustedNetSol += refundAdjustedNetSol(row, args.assumedNetworkFeeSol);
    current.walletStressSol += walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol);
    byDay.set(day, current);
  }
  return [...byDay.entries()]
    .map(([day, value]) => ({ day, ...value }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function parentChildDeltaSummary(
  childRows: JsonRow[],
  byPositionId: Map<string, JsonRow>,
  args: Args
): ParentChildDeltaSummary {
  let pairs = 0;
  let childBetterRows = 0;
  let childWorseRows = 0;
  let childEqualRows = 0;
  let parentWalletStressSol = 0;
  let childWalletStressSol = 0;
  let parentRefundAdjustedNetSol = 0;
  let childRefundAdjustedNetSol = 0;

  for (const child of childRows) {
    const parent = bridgeParent(child, byPositionId);
    if (!parent) continue;
    pairs += 1;
    const parentWallet = walletStressSol(parent, args.assumedAtaRentSol, args.assumedNetworkFeeSol);
    const childWallet = walletStressSol(child, args.assumedAtaRentSol, args.assumedNetworkFeeSol);
    const parentRefund = refundAdjustedNetSol(parent, args.assumedNetworkFeeSol);
    const childRefund = refundAdjustedNetSol(child, args.assumedNetworkFeeSol);
    parentWalletStressSol += parentWallet;
    childWalletStressSol += childWallet;
    parentRefundAdjustedNetSol += parentRefund;
    childRefundAdjustedNetSol += childRefund;
    const delta = childWallet - parentWallet;
    if (delta > 1e-12) childBetterRows += 1;
    else if (delta < -1e-12) childWorseRows += 1;
    else childEqualRows += 1;
  }

  return {
    pairs,
    childBetterRows,
    childWorseRows,
    childEqualRows,
    parentWalletStressSol,
    childWalletStressSol,
    deltaWalletStressSol: childWalletStressSol - parentWalletStressSol,
    parentRefundAdjustedNetSol,
    childRefundAdjustedNetSol,
    deltaRefundAdjustedNetSol: childRefundAdjustedNetSol - parentRefundAdjustedNetSol,
  };
}

function topWinnerShare(rows: JsonRow[], args: Args): number | null {
  const positives = rows
    .map((row) => walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol))
    .filter((value) => value > 0);
  const totalPositive = positives.reduce((sum, value) => sum + value, 0);
  if (totalPositive <= 0 || positives.length === 0) return null;
  return Math.max(...positives) / totalPositive;
}

function buildBridgeReadinessGap(
  currentUniqueCandidates: number,
  currentActiveDays: number,
  currentPositiveDays: number,
  currentWalletStressSol: number,
  currentTopWinnerShare: number | null,
  parentChildDeltaWalletStressSol: number
): BridgeReadinessGap {
  return {
    minUniqueCandidates: BRIDGE_REVIEW_MIN_UNIQUE_CANDIDATES,
    currentUniqueCandidates,
    neededUniqueCandidates: Math.max(0, BRIDGE_REVIEW_MIN_UNIQUE_CANDIDATES - currentUniqueCandidates),
    minActiveDays: BRIDGE_REVIEW_MIN_ACTIVE_DAYS,
    currentActiveDays,
    neededActiveDays: Math.max(0, BRIDGE_REVIEW_MIN_ACTIVE_DAYS - currentActiveDays),
    minPositiveDays: BRIDGE_REVIEW_MIN_ACTIVE_DAYS,
    currentPositiveDays,
    neededPositiveDays: Math.max(0, BRIDGE_REVIEW_MIN_ACTIVE_DAYS - currentPositiveDays),
    currentWalletStressSol,
    walletStressPositivePass: currentWalletStressSol > 0,
    maxTopWinnerShare: BRIDGE_REVIEW_MAX_TOP_WINNER_SHARE,
    currentTopWinnerShare,
    topWinnerSharePass: (currentTopWinnerShare ?? 1) <= BRIDGE_REVIEW_MAX_TOP_WINNER_SHARE,
    parentChildDeltaWalletStressSol,
    parentChildDeltaPass: parentChildDeltaWalletStressSol > 0,
  };
}

function singleBlockers(
  rows: JsonRow[],
  args: Args
): Array<{ blocker: string; count: number; refundAdjustedNetSol: number; walletStressSol: number }> {
  const byBlocker = new Map<string, { count: number; refundAdjustedNetSol: number; walletStressSol: number }>();
  for (const row of rows) {
    const blockers = blockersFor(row, args);
    if (blockers.length !== 1) continue;
    const blocker = blockers[0];
    const current = byBlocker.get(blocker) ?? { count: 0, refundAdjustedNetSol: 0, walletStressSol: 0 };
    current.count += 1;
    current.refundAdjustedNetSol += refundAdjustedNetSol(row, args.assumedNetworkFeeSol);
    current.walletStressSol += walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol);
    byBlocker.set(blocker, current);
  }
  return [...byBlocker.entries()]
    .map(([blocker, value]) => ({ blocker, ...value }))
    .sort((a, b) => b.count - a.count || a.blocker.localeCompare(b.blocker));
}

function evidenceClassification(
  row: JsonRow,
  args: Args,
  byPositionId: Map<string, JsonRow>
): PromotionEvidenceClassification {
  const blockers = blockersFor(row, args);
  if (blockers.length === 0) return 'strict_candidate';
  if (isBridgeCandidate(row, byPositionId, args)) return 'safe_bridge_candidate';
  if (blockers.some((blocker) =>
    blocker === 'missing_candidate_id' ||
    blocker === 'missing_decision_id' ||
    blocker === 'missing_execution_plan_hash' ||
    blocker === 'missing_route_proof' ||
    blocker === 'missing_cost_aware_profile'
  )) {
    return 'missing_metadata';
  }
  return 'true_non_promotable';
}

function promotionEvidenceBuckets(
  rows: JsonRow[],
  args: Args,
  byPositionId: Map<string, JsonRow>
): PromotionEvidenceBucket[] {
  const order: PromotionEvidenceClassification[] = [
    'strict_candidate',
    'safe_bridge_candidate',
    'missing_metadata',
    'true_non_promotable',
  ];
  const buckets = new Map<PromotionEvidenceClassification, {
    rows: JsonRow[];
    refundAdjustedNetSol: number;
    walletStressSol: number;
  }>();
  for (const classification of order) {
    buckets.set(classification, { rows: [], refundAdjustedNetSol: 0, walletStressSol: 0 });
  }
  for (const row of rows) {
    const classification = evidenceClassification(row, args, byPositionId);
    const bucket = buckets.get(classification)!;
    bucket.rows.push(row);
    bucket.refundAdjustedNetSol += refundAdjustedNetSol(row, args.assumedNetworkFeeSol);
    bucket.walletStressSol += walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol);
  }
  return order.map((classification) => {
    const bucket = buckets.get(classification)!;
    return {
      classification,
      rows: bucket.rows.length,
      uniqueCandidates: new Set(bucket.rows.map(candidateId).filter(Boolean)).size,
      refundAdjustedNetSol: bucket.refundAdjustedNetSol,
      walletStressSol: bucket.walletStressSol,
    };
  });
}

function candidateRow(
  row: JsonRow,
  args: Args,
  byPositionId?: Map<string, JsonRow>
): CandidateRow {
  const parent = byPositionId ? bridgeParent(row, byPositionId) : null;
  return {
    closedAt: str(row.closedAt),
    armName: rowArmName(row),
    paperRole: paperRole(row),
    parentPositionId: parentPositionId(row) || undefined,
    parentPaperRole: parent ? paperRole(parent) : undefined,
    candidateId: candidateId(row),
    decisionId: decisionId(row),
    executionPlanHash: executionPlanHash(row),
    tokenMint: tokenMint(row),
    exitReason: str(row.exitReason),
    refundAdjustedNetSol: refundAdjustedNetSol(row, args.assumedNetworkFeeSol),
    walletStressSol: walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol),
  };
}

export function buildReport(rows: JsonRow[], args: Args): PromotionReport {
  const blockers = countBlockers(rows, args);
  const candidates = rows.filter((row) => blockersFor(row, args).length === 0);
  const singleBlockerStats = singleBlockers(rows, args);
  const uniqueCandidateIds = new Set(candidates.map(candidateId).filter(Boolean));
  const bridgeRows = bridgeCandidateRows(rows, args);
  const primaryBridge = primaryBridgeRows(bridgeRows);
  const uniquePrimaryBridge = dedupeRowsByCandidate(primaryBridge);
  const byPositionId = new Map(rows.map((row) => [positionId(row), row]).filter(([id]) => Boolean(id)) as Array<[string, JsonRow]>);
  const uniqueBridgeCandidateIds = new Set(bridgeRows.map(candidateId).filter(Boolean));
  const uniquePrimaryBridgeCandidateIds = new Set(uniquePrimaryBridge.map(candidateId).filter(Boolean));
  const promotionWalletStress = candidates.reduce(
    (sum, row) => sum + walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol),
    0
  );
  const primaryBridgeWalletStress = uniquePrimaryBridge.reduce(
    (sum, row) => sum + walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol),
    0
  );
  const primaryBridgeDayBuckets = dayBucketStats(uniquePrimaryBridge, args);
  const primaryBridgePositiveDays = primaryBridgeDayBuckets.filter((row) => row.walletStressSol > 0).length;
  const primaryBridgeTopShare = topWinnerShare(uniquePrimaryBridge, args);
  const primaryBridgeDelta = parentChildDeltaSummary(uniquePrimaryBridge, byPositionId, args);
  const primaryBridgeReadinessGap = buildBridgeReadinessGap(
    uniquePrimaryBridge.length,
    primaryBridgeDayBuckets.length,
    primaryBridgePositiveDays,
    primaryBridgeWalletStress,
    primaryBridgeTopShare,
    primaryBridgeDelta.deltaWalletStressSol
  );
  const bridgeOosReady =
    uniquePrimaryBridge.length >= BRIDGE_REVIEW_MIN_UNIQUE_CANDIDATES &&
    primaryBridgeWalletStress > 0 &&
    primaryBridgeDayBuckets.length >= BRIDGE_REVIEW_MIN_ACTIVE_DAYS &&
    primaryBridgePositiveDays >= BRIDGE_REVIEW_MIN_ACTIVE_DAYS &&
    (primaryBridgeTopShare ?? 1) <= BRIDGE_REVIEW_MAX_TOP_WINNER_SHARE &&
    primaryBridgeDelta.deltaWalletStressSol > 0;
  const primaryBridgeNextNeededPacket: PrimaryBridgeNextNeededPacket = {
    status: bridgeOosReady ? 'READY_FOR_OOS_REVIEW' : 'COLLECT_MORE',
    targetUniqueCandidates: BRIDGE_REVIEW_MIN_UNIQUE_CANDIDATES,
    currentUniqueCandidates: uniquePrimaryBridge.length,
    neededUniqueCandidates: primaryBridgeReadinessGap.neededUniqueCandidates,
    activeDays: primaryBridgeDayBuckets.length,
    positiveDays: primaryBridgePositiveDays,
    walletStressSol: primaryBridgeWalletStress,
    topWinnerShare: primaryBridgeTopShare,
    parentChildDeltaWalletStressSol: primaryBridgeDelta.deltaWalletStressSol,
  };
  const primaryBridgeRoster = uniquePrimaryBridge
    .slice()
    .sort((a, b) => timeMs(a.closedAt) - timeMs(b.closedAt))
    .map((row) => candidateRow(row, args, byPositionId));
  const verdict = rows.length === 0
    ? 'NO_SAMPLE'
    : candidates.length > 0 && promotionWalletStress > 0
      ? 'STRICT_PROMOTION_READY'
      : bridgeOosReady
        ? 'BRIDGE_OOS_REVIEW'
        : uniquePrimaryBridge.length > 0 && primaryBridgeWalletStress > 0
        ? 'BRIDGE_REVIEW_ONLY'
        : 'NO_PROMOTION_EDGE';
  const verdictReasons = [
    ...(candidates.length === 0 ? ['strict promotion candidates are empty'] : []),
    ...(uniquePrimaryBridge.length < BRIDGE_REVIEW_MIN_UNIQUE_CANDIDATES
      ? [`primary bridge unique ${uniquePrimaryBridge.length} < ${BRIDGE_REVIEW_MIN_UNIQUE_CANDIDATES}`]
      : []),
    ...(primaryBridgeDayBuckets.length < BRIDGE_REVIEW_MIN_ACTIVE_DAYS
      ? [`primary bridge active days ${primaryBridgeDayBuckets.length} < ${BRIDGE_REVIEW_MIN_ACTIVE_DAYS}`]
      : []),
    ...(primaryBridgeTopShare != null && primaryBridgeTopShare > BRIDGE_REVIEW_MAX_TOP_WINNER_SHARE
      ? [`top winner share ${formatPct(primaryBridgeTopShare)} > ${formatPct(BRIDGE_REVIEW_MAX_TOP_WINNER_SHARE)}`]
      : []),
    ...(primaryBridgeDelta.deltaWalletStressSol <= 0
      ? [`parent-child wallet delta ${formatSol(primaryBridgeDelta.deltaWalletStressSol)} <= 0`]
      : []),
  ];
  const recommendedNextAction =
    verdict === 'STRICT_PROMOTION_READY'
      ? 'review strict candidates for tiny micro-canary; do not auto-enable live'
      : verdict === 'BRIDGE_OOS_REVIEW'
        ? 'run focused OOS/mirror review for primary bridge; live remains unchanged until review passes'
      : verdict === 'BRIDGE_REVIEW_ONLY'
        ? 'keep live unchanged; validate primary bridge forward/OOS before changing live profile'
        : verdict === 'NO_SAMPLE'
          ? 'collect more paper closes before promotion analysis'
          : 'keep paper-only; focus on admission/cost filters';
  return {
    generatedAt: new Date().toISOString(),
    sinceHours: args.sinceHours,
    verdict,
    recommendedNextAction,
    verdictReasons,
    scopedRows: rows.length,
    comparableRows: rows.filter((row) => COMPARABLE_ROLES.has(paperRole(row))).length,
    completeIdRows: rows.filter((row) => candidateId(row) && decisionId(row) && executionPlanHash(row)).length,
    routeProofRows: rows.filter(hasRouteProof).length,
    costAwareRows: rows.filter(isCostAware).length,
    walletStressPositiveRows: rows.filter((row) =>
      walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol) > 0
    ).length,
    promotionCandidateRows: candidates.length,
    uniquePromotionCandidates: uniqueCandidateIds.size,
    promotionRefundAdjustedNetSol: candidates.reduce(
      (sum, row) => sum + refundAdjustedNetSol(row, args.assumedNetworkFeeSol),
      0
    ),
    promotionWalletStressSol: candidates.reduce(
      (sum, row) => sum + walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol),
      0
    ),
    funnel: buildFunnel(rows, args),
    bridgeFunnel: buildBridgeFunnel(rows, args),
    bridgeCandidateRows: bridgeRows.length,
    uniqueBridgeCandidates: uniqueBridgeCandidateIds.size,
    bridgeRefundAdjustedNetSol: bridgeRows.reduce(
      (sum, row) => sum + refundAdjustedNetSol(row, args.assumedNetworkFeeSol),
      0
    ),
    bridgeWalletStressSol: bridgeRows.reduce(
      (sum, row) => sum + walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol),
      0
    ),
    primaryBridgeCandidateRows: primaryBridge.length,
    uniquePrimaryBridgeCandidates: uniquePrimaryBridgeCandidateIds.size,
    primaryBridgeRefundAdjustedNetSol: uniquePrimaryBridge.reduce(
      (sum, row) => sum + refundAdjustedNetSol(row, args.assumedNetworkFeeSol),
      0
    ),
    primaryBridgeWalletStressSol: uniquePrimaryBridge.reduce(
      (sum, row) => sum + walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol),
      0
    ),
    primaryBridgeActiveDays: primaryBridgeDayBuckets.length,
    primaryBridgePositiveDays,
    primaryBridgeTopWinnerShare: primaryBridgeTopShare,
    primaryBridgeReadinessGap,
    primaryBridgeDayBuckets,
    primaryBridgeParentChildDelta: primaryBridgeDelta,
    primaryBridgeNextNeededPacket,
    primaryBridgeRoster,
    blockers,
    singleBlockerRows: singleBlockerStats.reduce((sum, row) => sum + row.count, 0),
    singleBlockers: singleBlockerStats,
    promotionEvidenceBuckets: promotionEvidenceBuckets(rows, args, byPositionId),
    topArms: topArms(candidates, args),
    bridgeTopArms: topArms(bridgeRows, args),
    candidates: candidates
      .slice()
      .sort((a, b) =>
        walletStressSol(b, args.assumedAtaRentSol, args.assumedNetworkFeeSol) -
        walletStressSol(a, args.assumedAtaRentSol, args.assumedNetworkFeeSol)
      )
      .slice(0, 20)
      .map((row) => candidateRow(row, args)),
    bridgeCandidates: bridgeRows
      .slice()
      .sort((a, b) =>
        walletStressSol(b, args.assumedAtaRentSol, args.assumedNetworkFeeSol) -
        walletStressSol(a, args.assumedAtaRentSol, args.assumedNetworkFeeSol)
      )
      .slice(0, 20)
      .map((row) => candidateRow(row, args, byPositionId)),
  };
}

function formatSol(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(6)}`;
}

function formatPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function renderReport(report: PromotionReport): string {
  const lines = [
    '# Rotation Promotion Candidate Report',
    '',
    `generatedAt: ${report.generatedAt}`,
    `window: ${report.sinceHours == null ? 'all' : `${report.sinceHours}h`}`,
    `verdict: ${report.verdict}`,
    `recommendedNextAction: ${report.recommendedNextAction}`,
    `verdictReasons: ${report.verdictReasons.length > 0 ? report.verdictReasons.join('; ') : 'none'}`,
    '',
    `scopedRows=${report.scopedRows}`,
    `comparableRows=${report.comparableRows}`,
    `completeIdRows=${report.completeIdRows}`,
    `routeProofRows=${report.routeProofRows}`,
    `costAwareRows=${report.costAwareRows}`,
    `walletStressPositiveRows=${report.walletStressPositiveRows}`,
    `promotionCandidateRows=${report.promotionCandidateRows}`,
    `uniquePromotionCandidates=${report.uniquePromotionCandidates}`,
    `promotionRefundAdjustedNetSol=${formatSol(report.promotionRefundAdjustedNetSol)}`,
    `promotionWalletStressSol=${formatSol(report.promotionWalletStressSol)}`,
    `bridgeCandidateRows=${report.bridgeCandidateRows}`,
    `uniqueBridgeCandidates=${report.uniqueBridgeCandidates}`,
    `bridgeRefundAdjustedNetSol=${formatSol(report.bridgeRefundAdjustedNetSol)}`,
    `bridgeWalletStressSol=${formatSol(report.bridgeWalletStressSol)}`,
    `primaryBridgeCandidateRows=${report.primaryBridgeCandidateRows}`,
    `uniquePrimaryBridgeCandidates=${report.uniquePrimaryBridgeCandidates}`,
    `primaryBridgeRefundAdjustedNetSol=${formatSol(report.primaryBridgeRefundAdjustedNetSol)}`,
    `primaryBridgeWalletStressSol=${formatSol(report.primaryBridgeWalletStressSol)}`,
    `primaryBridgeActiveDays=${report.primaryBridgeActiveDays}`,
    `primaryBridgePositiveDays=${report.primaryBridgePositiveDays}`,
    `primaryBridgeTopWinnerShare=${formatPct(report.primaryBridgeTopWinnerShare)}`,
    `primaryBridgeNeededUniqueCandidates=${report.primaryBridgeReadinessGap.neededUniqueCandidates}`,
    `primaryBridgeNeededActiveDays=${report.primaryBridgeReadinessGap.neededActiveDays}`,
    `primaryBridgeNeededPositiveDays=${report.primaryBridgeReadinessGap.neededPositiveDays}`,
    `primaryBridgeParentChildPairs=${report.primaryBridgeParentChildDelta.pairs}`,
    `primaryBridgeChildBetterRows=${report.primaryBridgeParentChildDelta.childBetterRows}`,
    `primaryBridgeChildWorseRows=${report.primaryBridgeParentChildDelta.childWorseRows}`,
    `primaryBridgeChildEqualRows=${report.primaryBridgeParentChildDelta.childEqualRows}`,
    `primaryBridgeParentWalletStressSol=${formatSol(report.primaryBridgeParentChildDelta.parentWalletStressSol)}`,
    `primaryBridgeChildWalletStressSol=${formatSol(report.primaryBridgeParentChildDelta.childWalletStressSol)}`,
    `primaryBridgeDeltaWalletStressSol=${formatSol(report.primaryBridgeParentChildDelta.deltaWalletStressSol)}`,
    `primaryBridgeParentRefundAdjustedNetSol=${formatSol(report.primaryBridgeParentChildDelta.parentRefundAdjustedNetSol)}`,
    `primaryBridgeChildRefundAdjustedNetSol=${formatSol(report.primaryBridgeParentChildDelta.childRefundAdjustedNetSol)}`,
    `primaryBridgeDeltaRefundAdjustedNetSol=${formatSol(report.primaryBridgeParentChildDelta.deltaRefundAdjustedNetSol)}`,
    '',
    '## Primary Bridge Readiness Gap',
    `- unique candidates: ${report.primaryBridgeReadinessGap.currentUniqueCandidates}/` +
      `${report.primaryBridgeReadinessGap.minUniqueCandidates} ` +
      `(need +${report.primaryBridgeReadinessGap.neededUniqueCandidates})`,
    `- active days: ${report.primaryBridgeReadinessGap.currentActiveDays}/` +
      `${report.primaryBridgeReadinessGap.minActiveDays} ` +
      `(need +${report.primaryBridgeReadinessGap.neededActiveDays})`,
    `- positive days: ${report.primaryBridgeReadinessGap.currentPositiveDays}/` +
      `${report.primaryBridgeReadinessGap.minPositiveDays} ` +
      `(need +${report.primaryBridgeReadinessGap.neededPositiveDays})`,
    `- wallet stress: ${formatSol(report.primaryBridgeReadinessGap.currentWalletStressSol)} ` +
      `(${report.primaryBridgeReadinessGap.walletStressPositivePass ? 'pass' : 'fail'})`,
    `- top winner share: ${formatPct(report.primaryBridgeReadinessGap.currentTopWinnerShare)} / ` +
      `${formatPct(report.primaryBridgeReadinessGap.maxTopWinnerShare)} ` +
      `(${report.primaryBridgeReadinessGap.topWinnerSharePass ? 'pass' : 'fail'})`,
    `- parent-child wallet delta: ${formatSol(report.primaryBridgeReadinessGap.parentChildDeltaWalletStressSol)} ` +
      `(${report.primaryBridgeReadinessGap.parentChildDeltaPass ? 'pass' : 'fail'})`,
    '',
    '## Primary Bridge Next-Needed Packet',
    `- status: ${report.primaryBridgeNextNeededPacket.status}`,
    `- unique candidates: ${report.primaryBridgeNextNeededPacket.currentUniqueCandidates}/` +
      `${report.primaryBridgeNextNeededPacket.targetUniqueCandidates} ` +
      `(need +${report.primaryBridgeNextNeededPacket.neededUniqueCandidates})`,
    `- active days: ${report.primaryBridgeNextNeededPacket.activeDays}`,
    `- positive days: ${report.primaryBridgeNextNeededPacket.positiveDays}`,
    `- wallet stress: ${formatSol(report.primaryBridgeNextNeededPacket.walletStressSol)}`,
    `- top winner share: ${formatPct(report.primaryBridgeNextNeededPacket.topWinnerShare)}`,
    `- parent-child wallet delta: ${formatSol(report.primaryBridgeNextNeededPacket.parentChildDeltaWalletStressSol)}`,
    '',
    '## Primary Bridge Roster',
    ...report.primaryBridgeRoster.map((row) =>
      `- ${row.closedAt} ${row.tokenMint} candidate=${row.candidateId} decision=${row.decisionId} ` +
      `walletStress=${formatSol(row.walletStressSol)} exit=${row.exitReason}`
    ),
    '',
    '## Promotion Funnel',
    ...report.funnel.map((row) => `- ${row.step}: ${row.rows}`),
    '',
    '## Blockers',
    ...report.blockers.map((row) => `- ${row.blocker}: ${row.count}`),
    '',
    '## Single-Blocker Near Misses',
    `singleBlockerRows=${report.singleBlockerRows}`,
    ...report.singleBlockers.map((row) =>
      `- ${row.blocker}: rows=${row.count} refund=${formatSol(row.refundAdjustedNetSol)} ` +
      `walletStress=${formatSol(row.walletStressSol)}`
    ),
    '',
    '## Promotion Evidence Classification',
    ...report.promotionEvidenceBuckets.map((row) =>
      `- ${row.classification}: rows=${row.rows} unique=${row.uniqueCandidates} ` +
      `refund=${formatSol(row.refundAdjustedNetSol)} walletStress=${formatSol(row.walletStressSol)}`
    ),
    '',
    '## Cost-Aware Comparable Bridge',
    ...report.bridgeFunnel.map((row) => `- ${row.step}: ${row.rows}`),
    '',
    '## Bridge Arms',
    ...report.bridgeTopArms.map((row) => `- ${row.arm}: rows=${row.rows} walletStress=${formatSol(row.walletStressSol)}`),
    '',
    '## Primary Bridge Day Buckets',
    ...report.primaryBridgeDayBuckets.map((row) =>
      `- ${row.day}: candidates=${row.candidates} refund=${formatSol(row.refundAdjustedNetSol)} ` +
      `walletStress=${formatSol(row.walletStressSol)}`
    ),
    '',
    '## Top Bridge Candidates',
    ...report.bridgeCandidates.map((row) =>
      `- ${row.closedAt} ${row.armName} parentRole=${row.parentPaperRole ?? 'n/a'} ` +
      `${row.tokenMint} refund=${formatSol(row.refundAdjustedNetSol)} ` +
      `walletStress=${formatSol(row.walletStressSol)} exit=${row.exitReason} candidate=${row.candidateId}`
    ),
    '',
    '## Candidate Arms',
    ...report.topArms.map((row) => `- ${row.arm}: rows=${row.rows} walletStress=${formatSol(row.walletStressSol)}`),
    '',
    '## Top Candidates',
    ...report.candidates.map((row) =>
      `- ${row.closedAt} ${row.armName} ${row.tokenMint} refund=${formatSol(row.refundAdjustedNetSol)} ` +
      `walletStress=${formatSol(row.walletStressSol)} exit=${row.exitReason} candidate=${row.candidateId}`
    ),
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const allRows = await readRotationPaperTrades(args.realtimeDir);
  const nowMs = Date.now();
  const sinceMs = args.sinceHours == null ? Number.NEGATIVE_INFINITY : nowMs - args.sinceHours * 3600_000;
  const scopedRows = allRows.filter((row) => {
    const closedAt = timeMs(row.closedAt);
    return isRotationPaperTrade(row) &&
      Number.isFinite(closedAt) &&
      closedAt >= sinceMs &&
      closedAt < nowMs;
  });
  const report = buildReport(scopedRows, args);
  const rendered = renderReport(report);
  console.log(rendered);
  if (args.jsonOut) {
    await mkdir(path.dirname(args.jsonOut), { recursive: true });
    await writeFile(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
