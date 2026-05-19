#!/usr/bin/env ts-node
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

const ROTATION_PAPER_TRADES_FILE = 'rotation-v1-paper-trades.jsonl';
const KOL_PAPER_TRADES_FILE = 'kol-paper-trades.jsonl';
const COMPARABLE_ROLES = new Set(['mirror', 'fallback_execution_safety']);

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
  candidateId: string;
  decisionId: string;
  executionPlanHash: string;
  tokenMint: string;
  exitReason: string;
  refundAdjustedNetSol: number;
  walletStressSol: number;
}

interface PromotionReport {
  generatedAt: string;
  sinceHours: number | null;
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
  blockers: Array<{ blocker: string; count: number }>;
  topArms: Array<{ arm: string; rows: number; walletStressSol: number }>;
  candidates: CandidateRow[];
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

function buildReport(rows: JsonRow[], args: Args): PromotionReport {
  const blockers = countBlockers(rows, args);
  const candidates = rows.filter((row) => blockersFor(row, args).length === 0);
  const uniqueCandidateIds = new Set(candidates.map(candidateId).filter(Boolean));
  return {
    generatedAt: new Date().toISOString(),
    sinceHours: args.sinceHours,
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
    blockers,
    topArms: topArms(candidates, args),
    candidates: candidates
      .slice()
      .sort((a, b) =>
        walletStressSol(b, args.assumedAtaRentSol, args.assumedNetworkFeeSol) -
        walletStressSol(a, args.assumedAtaRentSol, args.assumedNetworkFeeSol)
      )
      .slice(0, 20)
      .map((row) => ({
        closedAt: str(row.closedAt),
        armName: rowArmName(row),
        paperRole: paperRole(row),
        candidateId: candidateId(row),
        decisionId: decisionId(row),
        executionPlanHash: executionPlanHash(row),
        tokenMint: tokenMint(row),
        exitReason: str(row.exitReason),
        refundAdjustedNetSol: refundAdjustedNetSol(row, args.assumedNetworkFeeSol),
        walletStressSol: walletStressSol(row, args.assumedAtaRentSol, args.assumedNetworkFeeSol),
      })),
  };
}

function formatSol(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(6)}`;
}

function renderReport(report: PromotionReport): string {
  const lines = [
    '# Rotation Promotion Candidate Report',
    '',
    `generatedAt: ${report.generatedAt}`,
    `window: ${report.sinceHours == null ? 'all' : `${report.sinceHours}h`}`,
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
    '',
    '## Blockers',
    ...report.blockers.map((row) => `- ${row.blocker}: ${row.count}`),
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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
