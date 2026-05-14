#!/usr/bin/env ts-node
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import {
  buildKolTransferPosteriorReport,
  type KolPosteriorMetrics,
  type KolTransferRow,
} from './kol-transfer-posterior-report';

const SMART_V3_PAPER_TRADES_FILE = 'smart-v3-paper-trades.jsonl';
const SMART_V3_LIVE_TRADES_FILE = 'smart-v3-live-trades.jsonl';
const KOL_PAPER_TRADES_FILE = 'kol-paper-trades.jsonl';
const KOL_LIVE_TRADES_FILE = 'kol-live-trades.jsonl';
const KOL_TRANSFER_INPUT_FILE = 'kol-transfers.jsonl';
const SMART_V3_ARM = 'kol_hunter_smart_v3';
const SMART_V3_REASONS = new Set(['pullback', 'velocity', 'pullback_and_velocity']);
const REQUIRED_COVERAGE_HORIZONS_SEC = [30, 60, 300, 1800];
const EVIDENCE_MIN_CLOSES = 50;
const EVIDENCE_PROMOTION_MIN_CLOSES = 100;
const EVIDENCE_MIN_OK_COVERAGE = 0.8;

interface JsonRow {
  [key: string]: unknown;
}

interface Args {
  realtimeDir: string;
  sinceMs: number;
  horizonsSec: number[];
  roundTripCostPct: number;
  assumedAtaRentSol: number;
  assumedNetworkFeeSol: number;
  kolTransferInput?: string;
  mdOut?: string;
  jsonOut?: string;
}

interface HorizonStats {
  horizonSec: number;
  rows: number;
  okRows: number;
  expectedAnchors: number | null;
  observedAnchors: number | null;
  okAnchors: number | null;
  positiveRows: number;
  positivePostCostRows: number;
  tailRows: number;
  medianDeltaPct: number | null;
  medianPostCostDeltaPct: number | null;
  p25PostCostDeltaPct: number | null;
  rowOkCoverage: number | null;
  okCoverage: number | null;
}

interface SmartV3CohortStats {
  cohort: string;
  mode: 'paper' | 'live';
  entryReason: string;
  armName?: string | null;
  rows: number;
  wins: number;
  losses: number;
  tokenOnlyWins: number;
  tokenOnlyLosses: number;
  netSol: number;
  netSolTokenOnly: number;
  rentAdjustedNetSol: number;
  copyableEdgeRows: number;
  copyablePassRows: number;
  hardCutRows: number;
  maeFastFailRows: number;
  stagedMae5Rows: number;
  stagedMae15Rows: number;
  stagedMaeAnyRows: number;
  stagedMaeTailRiskRows: number;
  tokenOnlyWinnerWalletLoserRows: number;
  mfe5WalletLoserRows: number;
  mfe12WalletLoserRows: number;
  mae5Within15Rows: number;
  mae10BeforeT1Rows: number;
  maeRecoveryHoldRows: number;
  mfeStageProbeRows: number;
  mfeStageBreakevenRows: number;
  mfeStageProfitLockRows: number;
  mfeStageRunnerRows: number;
  mfeStageConvexityRows: number;
  profitFloorExitRows: number;
  preT1Mfe10_20Rows: number;
  preT1Mfe20_30Rows: number;
  preT1Mfe30_50Rows: number;
  medianMaeWorstPct: number | null;
  medianHardCutMaePct: number | null;
  t1Rows: number;
  t2Rows: number;
  t3Rows: number;
  fiveXRows: number;
  medianHoldSec: number | null;
  topExitReasons: Array<{ reason: string; count: number }>;
}

type EvidenceVerdictStatus =
  | 'COLLECT'
  | 'DATA_GAP'
  | 'COST_REJECT'
  | 'POST_COST_REJECT'
  | 'WATCH'
  | 'PROMOTION_CANDIDATE';

interface SmartV3EvidenceVerdict {
  cohort: string;
  verdict: EvidenceVerdictStatus;
  reasons: string[];
  closes: number;
  minRequiredCloses: number;
  promotionRequiredCloses: number;
  minOkCoverage: number | null;
  requiredHorizonCoverage: Array<{
    horizonSec: number;
    buyOkCoverage: number | null;
    sellOkCoverage: number | null;
    minOkCoverage: number | null;
  }>;
  t300BuyMedianPostCostDeltaPct: number | null;
  t1800BuyMedianPostCostDeltaPct: number | null;
  t300SellMedianPostCostDeltaPct: number | null;
  t1800SellMedianPostCostDeltaPct: number | null;
  netSol: number;
  netSolTokenOnly: number;
  rentAdjustedNetSol: number;
  fiveXRows: number;
}

interface SmartV3EvidenceReport {
  generatedAt: string;
  realtimeDir: string;
  since: string;
  horizonsSec: number[];
  roundTripCostPct: number;
  assumedAtaRentSol: number;
  assumedNetworkFeeSol: number;
  tradeRows: {
    paperRows: number;
    paperLiveEligibleRows: number;
    paperLiveBlockedRows: number;
    paperLiveBlockReasons: Array<{ reason: string; count: number }>;
    paperLiveBlockFlags: Array<{ reason: string; count: number }>;
    liveRows: number;
    byCohort: SmartV3CohortStats[];
  };
  markouts: {
    smartV3Rows: number;
    afterBuy: HorizonStats[];
    afterSell: HorizonStats[];
    afterSellMaeFastFail: HorizonStats[];
    byCohort: Array<{
      cohort: string;
      afterBuy: HorizonStats[];
      afterSell: HorizonStats[];
    }>;
  };
  evidenceVerdicts: SmartV3EvidenceVerdict[];
  kolTransferPosterior: {
    input: string;
    rows: number;
    candidates: number;
    topSmartV3Fit: KolPosteriorMetrics[];
  };
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    realtimeDir: path.resolve(process.cwd(), 'data/realtime'),
    sinceMs: Date.now() - 24 * 3600_000,
    horizonsSec: [30, 60, 300, 1800],
    roundTripCostPct: 0.005,
    assumedAtaRentSol: 0.00207408,
    assumedNetworkFeeSol: 0.000105,
    kolTransferInput: path.resolve(process.cwd(), 'data/research', KOL_TRANSFER_INPUT_FILE),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--realtime-dir') args.realtimeDir = path.resolve(argv[++i]);
    else if (arg === '--since') args.sinceMs = parseSince(argv[++i]);
    else if (arg === '--horizons') args.horizonsSec = parseHorizons(argv[++i]);
    else if (arg === '--round-trip-cost-pct') args.roundTripCostPct = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--assumed-ata-rent-sol') args.assumedAtaRentSol = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--assumed-network-fee-sol') args.assumedNetworkFeeSol = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--kol-transfer-input') args.kolTransferInput = path.resolve(argv[++i]);
    else if (arg.startsWith('--kol-transfer-input=')) args.kolTransferInput = path.resolve(arg.split('=')[1]);
    else if (arg === '--md') args.mdOut = path.resolve(argv[++i]);
    else if (arg === '--json') args.jsonOut = path.resolve(argv[++i]);
  }
  return args;
}

function parseNonNegativeNumber(raw: string, label: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid ${label}: ${raw}`);
  return parsed;
}

function parseSince(raw: string): number {
  if (/^\d+h$/.test(raw)) return Date.now() - Number(raw.slice(0, -1)) * 3600_000;
  if (/^\d+d$/.test(raw)) return Date.now() - Number(raw.slice(0, -1)) * 86400_000;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`invalid --since: ${raw}`);
}

function parseHorizons(raw: string): number[] {
  const values = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) throw new Error(`invalid --horizons: ${raw}`);
  return [...new Set(values)].sort((a, b) => a - b);
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

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function obj(value: unknown): JsonRow {
  return typeof value === 'object' && value != null ? value as JsonRow : {};
}

function firstNum(row: JsonRow, keys: string[]): number | null {
  for (const key of keys) {
    const value = num(row[key]);
    if (value != null) return value;
  }
  return null;
}

function firstNumWithExtras(row: JsonRow, keys: string[]): number | null {
  const direct = firstNum(row, keys);
  if (direct != null) return direct;
  return firstNum(extrasOf(row), keys);
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
  const candidates = [
    row.closedAt,
    row.exitAt,
    row.recordedAt,
    row.openedAt,
    row.entryAt,
    row.anchorAt,
    row.observedAt,
  ];
  for (const candidate of candidates) {
    const parsed = timeMs(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

function countTop(rows: JsonRow[], fn: (row: JsonRow) => string, limit = 5): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = fn(row) || '(missing)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function countTopStrings(values: string[], limit = 8): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value || '(missing)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function extrasOf(row: JsonRow): JsonRow {
  return obj(row.extras);
}

function armNameOf(row: JsonRow): string {
  const extras = extrasOf(row);
  return str(row.armName) || str(extras.armName) || str(row.signalSource);
}

function parameterVersionOf(row: JsonRow): string {
  const extras = extrasOf(row);
  return str(row.parameterVersion) || str(extras.parameterVersion);
}

function modeOf(row: JsonRow): 'paper' | 'live' | '' {
  const extras = extrasOf(row);
  const mode = str(row.mode) || str(row.tradingMode) || str(extras.mode) || str(extras.tradingMode);
  if (mode === 'paper' || mode === 'live') return mode;
  return '';
}

function entryReasonOf(row: JsonRow): string {
  const extras = extrasOf(row);
  const reason = str(row.kolEntryReason) || str(row.entryReason) || str(extras.kolEntryReason) || str(extras.entryReason);
  if (SMART_V3_REASONS.has(reason)) return reason;
  return reason || 'unknown';
}

function isRotationRow(row: JsonRow): boolean {
  const arm = armNameOf(row);
  const version = parameterVersionOf(row);
  const reason = entryReasonOf(row);
  return arm.includes('rotation') || version.includes('rotation') || reason === 'rotation_v1';
}

function isSmartV3Row(row: JsonRow): boolean {
  if (isRotationRow(row)) return false;
  const arm = armNameOf(row);
  const version = parameterVersionOf(row);
  const reason = entryReasonOf(row);
  const strategy = str(row.strategy) || str(extrasOf(row).strategy);
  if (arm === SMART_V3_ARM || arm === 'smart_v3' || arm === 'smart-v3') return true;
  if (version.startsWith('smart-v3') || version.startsWith('smart_v3')) return true;
  return strategy === 'kol_hunter' && SMART_V3_REASONS.has(reason);
}

function isSmartV3LiveEligibleShadowRow(row: JsonRow): boolean {
  const extras = extrasOf(row);
  return row.smartV3LiveEligibleShadow === true || extras.smartV3LiveEligibleShadow === true;
}

function smartV3LiveBlockReasonOf(row: JsonRow): string {
  const extras = extrasOf(row);
  return str(row.smartV3LiveBlockReason) || str(extras.smartV3LiveBlockReason);
}

function smartV3LiveBlockFlagsOf(row: JsonRow): string[] {
  const extras = extrasOf(row);
  const direct = Array.isArray(row.smartV3LiveBlockFlags) ? row.smartV3LiveBlockFlags : [];
  const extra = Array.isArray(extras.smartV3LiveBlockFlags) ? extras.smartV3LiveBlockFlags : [];
  return [...direct, ...extra].filter((flag): flag is string => typeof flag === 'string' && flag.length > 0);
}

function isSmartV3LiveBlockedShadowRow(row: JsonRow): boolean {
  const extras = extrasOf(row);
  return row.smartV3LiveEligibleShadow === false ||
    extras.smartV3LiveEligibleShadow === false ||
    smartV3LiveBlockReasonOf(row).length > 0 ||
    smartV3LiveBlockFlagsOf(row).length > 0;
}

function smartV3MfeStageOf(row: JsonRow): string {
  const extras = extrasOf(row);
  return str(row.smartV3MfeStage) || str(extras.smartV3MfeStage);
}

function isSmartV3ProfitFloorExit(row: JsonRow): boolean {
  const extras = extrasOf(row);
  const reason = str(row.exitReason) || str(row.closeReason) || str(extras.exitReason) || str(extras.closeReason);
  return reason === 'smart_v3_mfe_floor_exit' ||
    row.smartV3ProfitFloorExit === true ||
    extras.smartV3ProfitFloorExit === true;
}

function isOkMarkout(row: JsonRow): boolean {
  return str(row.quoteStatus) === 'ok' && num(row.deltaPct) != null;
}

function horizonSecOf(row: JsonRow): number | null {
  return num(row.horizonSec);
}

function anchorTypeOf(row: JsonRow): 'buy' | 'sell' | '' {
  const anchorType = str(row.anchorType);
  if (anchorType === 'buy' || anchorType === 'sell') return anchorType;
  return '';
}

function normalizeReturnFraction(value: number | null): number | null {
  if (value == null) return null;
  return Math.abs(value) > 20 ? value / 100 : value;
}

function tradeNetSol(row: JsonRow): number {
  return firstNum(row, ['netSol', 'walletDeltaSol', 'realizedPnlSol', 'pnlSol']) ?? 0;
}

function tradeNetSolTokenOnly(row: JsonRow): number {
  return firstNum(row, ['netSolTokenOnly', 'netSolTokenOnlyP', 'tokenOnlyNetSol']) ?? tradeNetSol(row);
}

function tradeNetPctTokenOnly(row: JsonRow): number | null {
  return normalizeReturnFraction(firstNum(row, ['netPctTokenOnly', 'netPctTokenOnlyP', 'netPct', 'returnPct']));
}

function tradeHoldSec(row: JsonRow): number | null {
  return firstNum(row, ['holdSec', 'holdSeconds']);
}

function tradePositionId(row: JsonRow): string {
  return str(row.positionId) || str(extrasOf(row).positionId);
}

function tokenOnlyIsWin(row: JsonRow): boolean {
  const pct = tradeNetPctTokenOnly(row);
  if (pct != null) return pct > 0;
  return tradeNetSolTokenOnly(row) > 0;
}

function hasFieldWithExtras(row: JsonRow, keys: string[]): boolean {
  const extras = extrasOf(row);
  return keys.some((key) => (row[key] != null && row[key] !== '') || (extras[key] != null && extras[key] !== ''));
}

function maxMfe(row: JsonRow): number {
  const candidates = [
    normalizeReturnFraction(firstNum(row, ['mfePctPeak', 'mfePct', 'maxMfePct'])),
    normalizeReturnFraction(firstNum(row, ['mfePctPeakTokenOnly', 'actualMfePctPeak'])),
  ].filter((value): value is number => value != null);
  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

function isHardCut(row: JsonRow): boolean {
  const reason = str(row.exitReason) || str(row.closeReason);
  return reason.includes('hard_cut') || reason.includes('mae_fast_fail') || reason.includes('stat_stop') || reason.includes('quick_reject');
}

function isSmartV3MaeFastFail(row: JsonRow): boolean {
  const extras = extrasOf(row);
  const reason = str(row.exitReason) || str(row.closeReason) || str(extras.exitReason) || str(extras.closeReason);
  return reason === 'smart_v3_mae_fast_fail' || row.smartV3MaeFastFail === true || extras.smartV3MaeFastFail === true;
}

function isSmartV3MaeRecoveryHold(row: JsonRow): boolean {
  const extras = extrasOf(row);
  return row.smartV3MaeRecoveryHold === true || extras.smartV3MaeRecoveryHold === true;
}

function maeAt5sPctOf(row: JsonRow): number | null {
  return normalizeReturnFraction(firstNumWithExtras(row, ['maeAt5s', 'smartV3MaeAt5s']));
}

function maeAt15sPctOf(row: JsonRow): number | null {
  return normalizeReturnFraction(firstNumWithExtras(row, ['maeAt15s', 'smartV3MaeAt15s']));
}

function wouldSmartV3StagedMae5(row: JsonRow): boolean {
  const maeAt5s = maeAt5sPctOf(row);
  return maeAt5s != null && maeAt5s <= -0.04 && maxMfe(row) < 0.015;
}

function wouldSmartV3StagedMae15(row: JsonRow): boolean {
  const maeAt15s = maeAt15sPctOf(row);
  return maeAt15s != null && maeAt15s <= -0.05 && maxMfe(row) < 0.03;
}

function wouldSmartV3StagedMaeAny(row: JsonRow): boolean {
  const maeWorst = maeWorstPctOf(row);
  return maeWorst != null && maeWorst <= -0.10 && maxMfe(row) < 0.05;
}

function hasSmartV3StagedMaePressure(row: JsonRow): boolean {
  const maeAt5s = maeAt5sPctOf(row);
  const maeAt15s = maeAt15sPctOf(row);
  const maeWorst = maeWorstPctOf(row);
  return (maeAt5s != null && maeAt5s <= -0.04) ||
    (maeAt15s != null && maeAt15s <= -0.05) ||
    (maeWorst != null && maeWorst <= -0.10);
}

function isSmartV3TailCandidate(row: JsonRow): boolean {
  return maxMfe(row) >= 0.20 || hasFieldWithExtras(row, ['t1VisitAtSec', 't1VisitedAt', 't1ReachedAt']);
}

function smartV3PreT1MfeBand(row: JsonRow): string | null {
  const extras = extrasOf(row);
  return str(row.smartV3PreT1MfeBand) || str(extras.smartV3PreT1MfeBand) || null;
}

function maeWorstPctOf(row: JsonRow): number | null {
  return normalizeReturnFraction(firstNum(row, ['maeWorstPct', 'maePctTokenOnly', 'maePct']));
}

function hardCutMaePctOf(row: JsonRow): number | null {
  return normalizeReturnFraction(firstNum(row, ['hardCutTriggerMaePct', 'maeWorstPct', 'maePctTokenOnly', 'maePct']));
}

function recoverableRentSolOfRow(row: JsonRow, assumedAtaRentSol: number): number {
  const direct = firstNum(row, ['ataRentSol', 'entryRentSol']);
  if (direct != null) return Math.max(0, direct);
  const edge = smartV3CopyableEdgeOf(row);
  const edgeRent = edge ? num(edge.assumedAtaRentSol) : null;
  return edgeRent != null && edgeRent > 0 ? edgeRent : assumedAtaRentSol;
}

function copyableNetSolOfRow(
  mode: 'paper' | 'live',
  row: JsonRow,
  assumedAtaRentSol: number,
  assumedNetworkFeeSol: number,
): number {
  const edge = smartV3CopyableEdgeOf(row);
  const edgeNet = edge ? num(edge.copyableNetSol) : null;
  if (mode === 'live') {
    const baseNet = edgeNet ?? tradeNetSol(row);
    return baseNet + recoverableRentSolOfRow(row, assumedAtaRentSol);
  }
  if (edgeNet != null) return edgeNet;
  return tradeNetSolTokenOnly(row) - assumedAtaRentSol - assumedNetworkFeeSol;
}

function summarizeTradeCohort(
  mode: 'paper' | 'live',
  entryReason: string,
  rows: JsonRow[],
  assumedAtaRentSol: number,
  assumedNetworkFeeSol: number,
  cohortPrefix: string = mode,
  armName?: string | null,
): SmartV3CohortStats {
  const copyableNetByRow = rows.map((row) => copyableNetSolOfRow(mode, row, assumedAtaRentSol, assumedNetworkFeeSol));
  const wins = copyableNetByRow.filter((value) => value > 0).length;
  const tokenOnlyWins = rows.filter(tokenOnlyIsWin).length;
  const netSol = rows.reduce((sum, row) => sum + tradeNetSol(row), 0);
  const netSolTokenOnly = rows.reduce((sum, row) => sum + tradeNetSolTokenOnly(row), 0);
  const holds = rows.map(tradeHoldSec).filter((value): value is number => value != null);
  const copyableEdges = rows.map(smartV3CopyableEdgeOf).filter((edge): edge is JsonRow => edge != null);
  const copyableNetSol = copyableNetByRow.reduce((sum, value) => sum + value, 0);
  const rowsWithCopyableNet = rows.map((row, index) => ({ row, copyableNetSol: copyableNetByRow[index] }));
  const maeWorstValues = rows.map(maeWorstPctOf).filter((value): value is number => value != null);
  const hardCutMaeValues = rows
    .filter(isHardCut)
    .map(hardCutMaePctOf)
    .filter((value): value is number => value != null);
  return {
    cohort: `${cohortPrefix}:${armName ?? entryReason}`,
    mode,
    entryReason,
    armName: armName ?? null,
    rows: rows.length,
    wins,
    losses: rows.length - wins,
    tokenOnlyWins,
    tokenOnlyLosses: rows.length - tokenOnlyWins,
    netSol,
    netSolTokenOnly,
    rentAdjustedNetSol: copyableNetSol,
    copyableEdgeRows: copyableEdges.length,
    copyablePassRows: copyableEdges.filter((edge) => edge.pass === true).length,
    hardCutRows: rows.filter(isHardCut).length,
    maeFastFailRows: rows.filter(isSmartV3MaeFastFail).length,
    stagedMae5Rows: rows.filter(wouldSmartV3StagedMae5).length,
    stagedMae15Rows: rows.filter(wouldSmartV3StagedMae15).length,
    stagedMaeAnyRows: rows.filter(wouldSmartV3StagedMaeAny).length,
    stagedMaeTailRiskRows: rows.filter((row) => hasSmartV3StagedMaePressure(row) && isSmartV3TailCandidate(row)).length,
    tokenOnlyWinnerWalletLoserRows: rowsWithCopyableNet
      .filter(({ row, copyableNetSol: rowCopyableNetSol }) => tokenOnlyIsWin(row) && rowCopyableNetSol <= 0)
      .length,
    mfe5WalletLoserRows: rowsWithCopyableNet
      .filter(({ row, copyableNetSol: rowCopyableNetSol }) => maxMfe(row) >= 0.05 && rowCopyableNetSol <= 0)
      .length,
    mfe12WalletLoserRows: rowsWithCopyableNet
      .filter(({ row, copyableNetSol: rowCopyableNetSol }) => maxMfe(row) >= 0.12 && rowCopyableNetSol <= 0)
      .length,
    mae5Within15Rows: rows.filter((row) => {
      const maeAt5s = maeAt5sPctOf(row);
      const maeAt15s = maeAt15sPctOf(row);
      return (maeAt5s != null && maeAt5s <= -0.05) || (maeAt15s != null && maeAt15s <= -0.05);
    }).length,
    mae10BeforeT1Rows: rows.filter((row) => {
      const maeWorst = maeWorstPctOf(row);
      return maeWorst != null && maeWorst <= -0.10 && !hasFieldWithExtras(row, ['t1VisitAtSec', 't1VisitedAt', 't1ReachedAt']);
    }).length,
    maeRecoveryHoldRows: rows.filter(isSmartV3MaeRecoveryHold).length,
    mfeStageProbeRows: rows.filter((row) => smartV3MfeStageOf(row) === 'probe').length,
    mfeStageBreakevenRows: rows.filter((row) => smartV3MfeStageOf(row) === 'breakeven_watch').length,
    mfeStageProfitLockRows: rows.filter((row) => smartV3MfeStageOf(row) === 'profit_lock').length,
    mfeStageRunnerRows: rows.filter((row) => smartV3MfeStageOf(row) === 'runner').length,
    mfeStageConvexityRows: rows.filter((row) => smartV3MfeStageOf(row) === 'convexity').length,
    profitFloorExitRows: rows.filter(isSmartV3ProfitFloorExit).length,
    preT1Mfe10_20Rows: rows.filter((row) => smartV3PreT1MfeBand(row) === '10_20').length,
    preT1Mfe20_30Rows: rows.filter((row) => smartV3PreT1MfeBand(row) === '20_30').length,
    preT1Mfe30_50Rows: rows.filter((row) => smartV3PreT1MfeBand(row) === '30_50').length,
    medianMaeWorstPct: median(maeWorstValues),
    medianHardCutMaePct: median(hardCutMaeValues),
    t1Rows: rows.filter((row) => hasFieldWithExtras(row, ['t1VisitAtSec', 't1VisitedAt', 't1ReachedAt'])).length,
    t2Rows: rows.filter((row) => hasFieldWithExtras(row, ['t2VisitAtSec', 't2VisitedAt', 't2ReachedAt'])).length,
    t3Rows: rows.filter((row) => hasFieldWithExtras(row, ['t3VisitAtSec', 't3VisitedAt', 't3ReachedAt'])).length,
    fiveXRows: rows.filter((row) => maxMfe(row) >= 4).length,
    medianHoldSec: median(holds),
    topExitReasons: countTop(rows, (row) => str(row.exitReason) || str(row.closeReason)),
  };
}

function smartV3CopyableEdgeOf(row: JsonRow): JsonRow | null {
  const direct = obj(row.smartV3CopyableEdge);
  if (str(direct.schemaVersion) === 'smart-v3-copyable-edge/v1') return direct;
  const extras = extrasOf(row);
  const extra = obj(extras.smartV3CopyableEdge);
  return str(extra.schemaVersion) === 'smart-v3-copyable-edge/v1' ? extra : null;
}

function summarizeMarkoutRows(
  rows: JsonRow[],
  horizonsSec: number[],
  roundTripCostPct: number,
  expectedPositionIds?: Set<string>,
): HorizonStats[] {
  return horizonsSec.map((horizonSec) => {
    const selected = rows.filter((row) => horizonSecOf(row) === horizonSec);
    const okRows = selected.filter(isOkMarkout);
    const expectedAnchors = expectedPositionIds && expectedPositionIds.size > 0 ? expectedPositionIds.size : null;
    const observedAnchors = expectedAnchors == null
      ? null
      : new Set(
        selected
          .map(tradePositionId)
          .filter((positionId) => positionId && expectedPositionIds?.has(positionId))
      ).size;
    const okAnchors = expectedAnchors == null
      ? null
      : new Set(
        okRows
          .map(tradePositionId)
          .filter((positionId) => positionId && expectedPositionIds?.has(positionId))
      ).size;
    const deltas = okRows
      .map((row) => normalizeReturnFraction(num(row.deltaPct)))
      .filter((value): value is number => value != null);
    const postCost = deltas.map((value) => value - roundTripCostPct);
    const rowOkCoverage = selected.length > 0 ? okRows.length / selected.length : null;
    return {
      horizonSec,
      rows: selected.length,
      okRows: okRows.length,
      expectedAnchors,
      observedAnchors,
      okAnchors,
      positiveRows: deltas.filter((value) => value > 0).length,
      positivePostCostRows: postCost.filter((value) => value > 0).length,
      tailRows: deltas.filter((value) => value >= 4).length,
      medianDeltaPct: median(deltas),
      medianPostCostDeltaPct: median(postCost),
      p25PostCostDeltaPct: percentile(postCost, 0.25),
      rowOkCoverage,
      okCoverage: expectedAnchors == null || okAnchors == null ? rowOkCoverage : okAnchors / expectedAnchors,
    };
  });
}

function markoutsForCohort(markouts: JsonRow[], cohort: SmartV3CohortStats, positionIds: Set<string>): JsonRow[] {
  return markouts.filter((row) => {
    const positionId = tradePositionId(row);
    const rowMode = modeOf(row);
    const rowReason = entryReasonOf(row);
    const modeMatches = rowMode === cohort.mode;
    const reasonMatches = cohort.entryReason === 'all' || rowReason === cohort.entryReason;
    const armMatches = !cohort.armName || armNameOf(row) === cohort.armName;
    return positionId !== '' && positionIds.has(positionId) && modeMatches && reasonMatches && armMatches;
  });
}

function statAt(stats: HorizonStats[], horizonSec: number): HorizonStats | undefined {
  return stats.find((stat) => stat.horizonSec === horizonSec);
}

function minNullable(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => value != null);
  return filtered.length > 0 ? Math.min(...filtered) : null;
}

function buildVerdict(
  cohort: SmartV3CohortStats,
  afterBuy: HorizonStats[],
  afterSell: HorizonStats[],
): SmartV3EvidenceVerdict {
  const coverage = REQUIRED_COVERAGE_HORIZONS_SEC.map((horizonSec) => {
    const buy = statAt(afterBuy, horizonSec);
    const sell = statAt(afterSell, horizonSec);
    const buyOkCoverage = buy?.okCoverage ?? null;
    const sellOkCoverage = sell?.okCoverage ?? null;
    return {
      horizonSec,
      buyOkCoverage,
      sellOkCoverage,
      minOkCoverage: buyOkCoverage == null || sellOkCoverage == null ? null : Math.min(buyOkCoverage, sellOkCoverage),
    };
  });
  const minOkCoverage = minNullable(coverage.map((row) => row.minOkCoverage));
  const t300Buy = statAt(afterBuy, 300)?.medianPostCostDeltaPct ?? null;
  const t1800Buy = statAt(afterBuy, 1800)?.medianPostCostDeltaPct ?? null;
  const t300Sell = statAt(afterSell, 300)?.medianPostCostDeltaPct ?? null;
  const t1800Sell = statAt(afterSell, 1800)?.medianPostCostDeltaPct ?? null;
  const reasons: string[] = [];
  let verdict: EvidenceVerdictStatus = 'WATCH';

  if (cohort.rows < EVIDENCE_MIN_CLOSES) {
    verdict = 'COLLECT';
    reasons.push(`need ${EVIDENCE_MIN_CLOSES}+ closes, have ${cohort.rows}`);
  } else {
    const dataGap = coverage.some((row) => row.minOkCoverage == null || row.minOkCoverage < EVIDENCE_MIN_OK_COVERAGE);
    if (dataGap) {
      verdict = 'DATA_GAP';
      reasons.push('required buy/sell T+ coverage below 80%');
    } else if (cohort.netSol <= 0 && cohort.rentAdjustedNetSol <= 0 && cohort.fiveXRows === 0) {
      verdict = 'COST_REJECT';
      reasons.push('wallet and copyable PnL are non-positive without 5x evidence');
    } else if ((t300Buy ?? 0) <= 0 && (t1800Buy ?? 0) <= 0 && (t300Sell ?? 0) <= 0 && (t1800Sell ?? 0) <= 0 && cohort.fiveXRows === 0) {
      verdict = 'POST_COST_REJECT';
      reasons.push('T+300/T+1800 post-cost continuation is non-positive');
    } else if (cohort.rows >= EVIDENCE_PROMOTION_MIN_CLOSES) {
      verdict = 'PROMOTION_CANDIDATE';
      reasons.push('sample, coverage, PnL/tail, and continuation gates passed');
    } else {
      verdict = 'WATCH';
      reasons.push(`need ${EVIDENCE_PROMOTION_MIN_CLOSES}+ closes for promotion, have ${cohort.rows}`);
    }
  }

  return {
    cohort: cohort.cohort,
    verdict,
    reasons,
    closes: cohort.rows,
    minRequiredCloses: EVIDENCE_MIN_CLOSES,
    promotionRequiredCloses: EVIDENCE_PROMOTION_MIN_CLOSES,
    minOkCoverage,
    requiredHorizonCoverage: coverage,
    t300BuyMedianPostCostDeltaPct: t300Buy,
    t1800BuyMedianPostCostDeltaPct: t1800Buy,
    t300SellMedianPostCostDeltaPct: t300Sell,
    t1800SellMedianPostCostDeltaPct: t1800Sell,
    netSol: cohort.netSol,
    netSolTokenOnly: cohort.netSolTokenOnly,
    rentAdjustedNetSol: cohort.rentAdjustedNetSol,
    fiveXRows: cohort.fiveXRows,
  };
}

function groupByEntryReason(mode: 'paper' | 'live', rows: JsonRow[]): Array<{ reason: string; rows: JsonRow[] }> {
  const groups = new Map<string, JsonRow[]>();
  groups.set('all', rows);
  for (const row of rows) {
    const reason = entryReasonOf(row);
    const key = SMART_V3_REASONS.has(reason) ? reason : 'unknown';
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .filter(([, groupRows]) => groupRows.length > 0)
    .map(([reason, groupRows]) => ({ reason, rows: groupRows }));
}

function groupByArm(rows: JsonRow[]): Array<{ armName: string; rows: JsonRow[] }> {
  const groups = new Map<string, JsonRow[]>();
  for (const row of rows) {
    const armName = armNameOf(row) || 'unknown';
    groups.set(armName, [...(groups.get(armName) ?? []), row]);
  }
  return [...groups.entries()]
    .filter(([, groupRows]) => groupRows.length > 0)
    .map(([armName, groupRows]) => ({ armName, rows: groupRows }));
}

async function smartV3TradeRows(realtimeDir: string, mode: 'paper' | 'live', sinceMs: number): Promise<JsonRow[]> {
  const projectionFile = mode === 'paper' ? SMART_V3_PAPER_TRADES_FILE : SMART_V3_LIVE_TRADES_FILE;
  const legacyFile = mode === 'paper' ? KOL_PAPER_TRADES_FILE : KOL_LIVE_TRADES_FILE;
  const [legacyRows, projectionRows] = await Promise.all([
    readJsonl(path.join(realtimeDir, legacyFile)),
    readJsonl(path.join(realtimeDir, projectionFile)),
  ]);
  const rowsByKey = new Map<string, JsonRow>();
  for (const row of [...legacyRows, ...projectionRows]) {
    if (!isSmartV3Row(row)) continue;
    const key = tradeRowDedupeKey(row);
    rowsByKey.set(key, row);
  }
  return [...rowsByKey.values()]
    .filter(isSmartV3Row)
    .filter((row) => {
      const atMs = rowTimeMs(row);
      return Number.isFinite(atMs) && atMs >= sinceMs;
    })
    .map((row) => ({ ...row, mode: modeOf(row) || mode }));
}

function tradeRowDedupeKey(row: JsonRow): string {
  const positionId = str(row.positionId);
  if (positionId) return positionId;
  return `${str(row.tokenMint)}:${str(row.closedAt)}:${entryReasonOf(row)}:${tradeNetSol(row)}`;
}

async function smartV3MarkoutRows(realtimeDir: string, sinceMs: number): Promise<JsonRow[]> {
  const rows = await readJsonl(path.join(realtimeDir, 'trade-markouts.jsonl'));
  return rows
    .filter(isSmartV3Row)
    .filter((row) => {
      const atMs = rowTimeMs(row);
      return Number.isFinite(atMs) && atMs >= sinceMs;
    });
}

export async function buildSmartV3EvidenceReport(args: Args): Promise<SmartV3EvidenceReport> {
  const kolTransferInput = args.kolTransferInput ?? path.resolve(process.cwd(), 'data/research', KOL_TRANSFER_INPUT_FILE);
  const [paperRows, liveRows, markoutRows, kolTransferRows] = await Promise.all([
    smartV3TradeRows(args.realtimeDir, 'paper', args.sinceMs),
    smartV3TradeRows(args.realtimeDir, 'live', args.sinceMs),
    smartV3MarkoutRows(args.realtimeDir, args.sinceMs),
    readJsonl(kolTransferInput),
  ]);
  const paperLiveEligibleRows = paperRows.filter(isSmartV3LiveEligibleShadowRow);
  const paperLiveBlockedRows = paperRows.filter(isSmartV3LiveBlockedShadowRow);
  const cohortInputs = [
    ...groupByEntryReason('paper', paperRows).map((group) => ({
      rows: group.rows,
      stats: summarizeTradeCohort('paper', group.reason, group.rows, args.assumedAtaRentSol, args.assumedNetworkFeeSol),
    })),
    ...groupByEntryReason('paper', paperLiveEligibleRows).map((group) => ({
      rows: group.rows,
      stats: summarizeTradeCohort(
        'paper',
        group.reason,
        group.rows,
        args.assumedAtaRentSol,
        args.assumedNetworkFeeSol,
        'paper_live_eligible',
      ),
    })),
    ...groupByArm(paperRows).map((group) => ({
      rows: group.rows,
      stats: summarizeTradeCohort(
        'paper',
        'all',
        group.rows,
        args.assumedAtaRentSol,
        args.assumedNetworkFeeSol,
        'paper_arm',
        group.armName,
      ),
    })),
    ...groupByArm(paperLiveEligibleRows).map((group) => ({
      rows: group.rows,
      stats: summarizeTradeCohort(
        'paper',
        'all',
        group.rows,
        args.assumedAtaRentSol,
        args.assumedNetworkFeeSol,
        'paper_live_eligible_arm',
        group.armName,
      ),
    })),
    ...groupByEntryReason('live', liveRows).map((group) => ({
      rows: group.rows,
      stats: summarizeTradeCohort('live', group.reason, group.rows, args.assumedAtaRentSol, args.assumedNetworkFeeSol),
    })),
    ...groupByArm(liveRows).map((group) => ({
      rows: group.rows,
      stats: summarizeTradeCohort(
        'live',
        'all',
        group.rows,
        args.assumedAtaRentSol,
        args.assumedNetworkFeeSol,
        'live_arm',
        group.armName,
      ),
    })),
  ];
  const cohorts = cohortInputs.map((entry) => entry.stats);

  const afterBuy = summarizeMarkoutRows(markoutRows.filter((row) => anchorTypeOf(row) === 'buy'), args.horizonsSec, args.roundTripCostPct);
  const afterSell = summarizeMarkoutRows(markoutRows.filter((row) => anchorTypeOf(row) === 'sell'), args.horizonsSec, args.roundTripCostPct);
  const afterSellMaeFastFail = summarizeMarkoutRows(
    markoutRows.filter((row) => anchorTypeOf(row) === 'sell' && isSmartV3MaeFastFail(row)),
    args.horizonsSec,
    args.roundTripCostPct,
  );
  const byCohort = cohortInputs.map(({ stats: cohort, rows: cohortRows }) => {
    const positionIds = new Set(cohortRows.map(tradePositionId).filter(Boolean));
    const rows = markoutsForCohort(markoutRows, cohort, positionIds);
    return {
      cohort: cohort.cohort,
      afterBuy: summarizeMarkoutRows(rows.filter((row) => anchorTypeOf(row) === 'buy'), args.horizonsSec, args.roundTripCostPct, positionIds),
      afterSell: summarizeMarkoutRows(rows.filter((row) => anchorTypeOf(row) === 'sell'), args.horizonsSec, args.roundTripCostPct, positionIds),
    };
  });
  const evidenceVerdicts = cohorts.map((cohort) => {
    const cohortMarkouts = byCohort.find((entry) => entry.cohort === cohort.cohort);
    return buildVerdict(cohort, cohortMarkouts?.afterBuy ?? [], cohortMarkouts?.afterSell ?? []);
  });
  const kolTransferPosterior = buildKolTransferPosteriorReport(kolTransferRows as unknown as KolTransferRow[], {
    input: kolTransferInput,
    sinceSec: Math.floor(args.sinceMs / 1000),
  });

  return {
    generatedAt: new Date().toISOString(),
    realtimeDir: args.realtimeDir,
    since: new Date(args.sinceMs).toISOString(),
    horizonsSec: args.horizonsSec,
    roundTripCostPct: args.roundTripCostPct,
    assumedAtaRentSol: args.assumedAtaRentSol,
    assumedNetworkFeeSol: args.assumedNetworkFeeSol,
    tradeRows: {
      paperRows: paperRows.length,
      paperLiveEligibleRows: paperLiveEligibleRows.length,
      paperLiveBlockedRows: paperLiveBlockedRows.length,
      paperLiveBlockReasons: countTop(paperLiveBlockedRows, smartV3LiveBlockReasonOf, 8),
      paperLiveBlockFlags: countTopStrings(paperLiveBlockedRows.flatMap(smartV3LiveBlockFlagsOf), 12),
      liveRows: liveRows.length,
      byCohort: cohorts,
    },
    markouts: {
      smartV3Rows: markoutRows.length,
      afterBuy,
      afterSell,
      afterSellMaeFastFail,
      byCohort,
    },
    evidenceVerdicts,
    kolTransferPosterior: {
      input: kolTransferInput,
      rows: kolTransferPosterior.rows,
      candidates: kolTransferPosterior.candidates,
      topSmartV3Fit: kolTransferPosterior.metrics
        .slice()
        .sort((a, b) => b.smartV3FitScore - a.smartV3FitScore || b.buyCandidates - a.buyCandidates)
        .slice(0, 12),
    },
  };
}

function pct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function sol(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}

function ratio(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(0)}%`;
}

function renderHorizonTable(stats: HorizonStats[]): string {
  const lines = ['| T+ | rows | ok | anchorOk | rowOk | medDelta | medPostCost | p25PostCost | postCost+ | tail5x+ |', '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const stat of stats) {
    lines.push([
      `| ${stat.horizonSec}s`,
      stat.rows,
      stat.okRows,
      stat.expectedAnchors == null ? 'n/a' : ratio(stat.okCoverage),
      ratio(stat.rowOkCoverage),
      pct(stat.medianDeltaPct),
      pct(stat.medianPostCostDeltaPct),
      pct(stat.p25PostCostDeltaPct),
      stat.positivePostCostRows,
      stat.tailRows,
    ].join(' | ') + ' |');
  }
  return lines.join('\n');
}

function renderKolTransferPosteriorTable(report: SmartV3EvidenceReport['kolTransferPosterior']): string {
  if (report.rows === 0 || report.topSmartV3Fit.length === 0) {
    return `_No KOL transfer posterior rows. Run \`npm run kol:transfer-backfill\` first. Input: ${report.input}_`;
  }
  const lines = [
    '| KOL | tier | role | style | tx | buy | sell | sell/buy | med buy SOL | med hold | quick sell | rotation | smart-v3 | net SOL flow |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of report.topSmartV3Fit) {
    lines.push([
      `| ${row.kolId}`,
      row.kolTier ?? '-',
      row.laneRole ?? '-',
      row.tradingStyle ?? '-',
      row.txGroups,
      row.buyCandidates,
      row.sellCandidates,
      pct(row.sellToBuyRatio),
      row.medianBuySol == null ? 'n/a' : row.medianBuySol.toFixed(4),
      row.medianHoldSec == null ? 'n/a' : `${row.medianHoldSec.toFixed(0)}s`,
      pct(row.quickSellRatio),
      row.rotationFitScore.toFixed(2),
      row.smartV3FitScore.toFixed(2),
      sol(row.netSolFlow),
    ].join(' | ') + ' |');
  }
  return lines.join('\n');
}

export function renderSmartV3EvidenceReportMarkdown(report: SmartV3EvidenceReport): string {
  const lines: string[] = [];
  lines.push('# Smart-v3 Evidence Report');
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- since: ${report.since}`);
  lines.push(`- realtimeDir: ${report.realtimeDir}`);
  lines.push(`- horizons: ${report.horizonsSec.join(', ')}s`);
  lines.push(`- round-trip cost assumption: ${(report.roundTripCostPct * 100).toFixed(2)}%`);
  lines.push(`- wallet drag stress: ${(report.assumedAtaRentSol + report.assumedNetworkFeeSol).toFixed(6)} SOL / close`);
  lines.push('');

  lines.push('## KOL Transfer Posterior — Smart-v3 Fit');
  lines.push('> Diagnostic only. Transfer candidates are not precise swap PnL. Use signature drill-down before policy changes.');
  lines.push(renderKolTransferPosteriorTable(report.kolTransferPosterior));
  lines.push('');

  lines.push('## Evidence Verdicts');
  lines.push('| cohort | verdict | closes | minCov | netSOL | tokenOnly | copyable | 5x | T+300 buy | T+300 sell | reasons |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const verdict of report.evidenceVerdicts) {
    lines.push([
      `| ${verdict.cohort}`,
      verdict.verdict,
      verdict.closes,
      ratio(verdict.minOkCoverage),
      sol(verdict.netSol),
      sol(verdict.netSolTokenOnly),
      sol(verdict.rentAdjustedNetSol),
      verdict.fiveXRows,
      pct(verdict.t300BuyMedianPostCostDeltaPct),
      pct(verdict.t300SellMedianPostCostDeltaPct),
      verdict.reasons.join('; '),
    ].join(' | ') + ' |');
  }
  if (report.evidenceVerdicts.length === 0) lines.push('| n/a | COLLECT | 0 | n/a | +0.0000 | +0.0000 | +0.0000 | 0 | n/a | n/a | no smart-v3 closes |');
  lines.push('');

  lines.push('## Closed Trades');
  lines.push(`- paper rows: ${report.tradeRows.paperRows}`);
  lines.push(`- paper live-eligible rows: ${report.tradeRows.paperLiveEligibleRows}`);
  lines.push(`- paper live-blocked rows: ${report.tradeRows.paperLiveBlockedRows}`);
  lines.push(`- live rows: ${report.tradeRows.liveRows}`);
  if (report.tradeRows.paperLiveBlockReasons.length > 0) {
    lines.push(`- live block reasons: ${report.tradeRows.paperLiveBlockReasons.map((entry) => `${entry.reason}:${entry.count}`).join(', ')}`);
  }
  if (report.tradeRows.paperLiveBlockFlags.length > 0) {
    lines.push(`- live block flags: ${report.tradeRows.paperLiveBlockFlags.map((entry) => `${entry.reason}:${entry.count}`).join(', ')}`);
  }
  lines.push('');
  lines.push('| cohort | rows | copyable W/L | token W/L | netSOL | tokenOnly | rent-adj | edgeRows | hardCut | maeFastFail | stagedFF5 | stagedFF15 | stagedFFAny | stagedTailRisk | tokenWinWalletLose | MFE>=5 walletLose | MFE>=12 walletLose | MAE<=-5 within15 | MAE<=-10 preT1 | recoveryHold | floorExit | stage>=20 | stage>=50 | stage>=100 | preT1 10-20 | preT1 20-30 | preT1 30-50 | med worst MAE | med hardCut MAE | T1 | T2 | T3 | 5x | medHold | top exits |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const cohort of report.tradeRows.byCohort) {
    lines.push([
      `| ${cohort.cohort}`,
      cohort.rows,
      `${cohort.wins}/${cohort.losses}`,
      `${cohort.tokenOnlyWins}/${cohort.tokenOnlyLosses}`,
      sol(cohort.netSol),
      sol(cohort.netSolTokenOnly),
      sol(cohort.rentAdjustedNetSol),
      `${cohort.copyablePassRows}/${cohort.copyableEdgeRows}`,
      cohort.hardCutRows,
      cohort.maeFastFailRows,
      cohort.stagedMae5Rows,
      cohort.stagedMae15Rows,
      cohort.stagedMaeAnyRows,
      cohort.stagedMaeTailRiskRows,
      cohort.tokenOnlyWinnerWalletLoserRows,
      cohort.mfe5WalletLoserRows,
      cohort.mfe12WalletLoserRows,
      cohort.mae5Within15Rows,
      cohort.mae10BeforeT1Rows,
      cohort.maeRecoveryHoldRows,
      cohort.profitFloorExitRows,
      cohort.mfeStageProfitLockRows + cohort.mfeStageRunnerRows + cohort.mfeStageConvexityRows,
      cohort.mfeStageRunnerRows + cohort.mfeStageConvexityRows,
      cohort.mfeStageConvexityRows,
      cohort.preT1Mfe10_20Rows,
      cohort.preT1Mfe20_30Rows,
      cohort.preT1Mfe30_50Rows,
      pct(cohort.medianMaeWorstPct),
      pct(cohort.medianHardCutMaePct),
      cohort.t1Rows,
      cohort.t2Rows,
      cohort.t3Rows,
      cohort.fiveXRows,
      cohort.medianHoldSec == null ? 'n/a' : `${cohort.medianHoldSec.toFixed(0)}s`,
      cohort.topExitReasons.map((entry) => `${entry.reason}:${entry.count}`).join(', ') || 'n/a',
    ].join(' | ') + ' |');
  }
  if (report.tradeRows.byCohort.length === 0) lines.push('| n/a | 0 | 0/0 | 0/0 | +0.0000 | +0.0000 | +0.0000 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a | n/a | 0 | 0 | 0 | 0 | n/a | n/a |');
  lines.push('');

  lines.push('## T+ After Buy');
  lines.push(renderHorizonTable(report.markouts.afterBuy));
  lines.push('');
  lines.push('## T+ After Sell');
  lines.push(renderHorizonTable(report.markouts.afterSell));
  lines.push('');
  lines.push('## T+ After Sell — MAE Fast-Fail Cohort');
  lines.push(renderHorizonTable(report.markouts.afterSellMaeFastFail));
  lines.push('');
  lines.push('## Interpretation');
  lines.push('- This report is diagnostic only. It does not change smart-v3 entry/exit behavior.');
  lines.push('- `COST_REJECT` means the cohort is not copyable after wallet/token-only PnL checks unless tail evidence exists.');
  lines.push('- `anchorOk` is close-position coverage for cohort verdicts; `rowOk` is only observed-row quote quality.');
  lines.push('- `DATA_GAP` means policy tuning should wait for T+ coverage recovery.');
  lines.push('- `PROMOTION_CANDIDATE` is an investigation queue, not an automatic live promotion.');
  return lines.join('\n');
}

async function writeOutput(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildSmartV3EvidenceReport(args);
  const markdown = renderSmartV3EvidenceReportMarkdown(report);
  if (args.jsonOut) await writeOutput(args.jsonOut, JSON.stringify(report, null, 2));
  if (args.mdOut) await writeOutput(args.mdOut, markdown);
  if (!args.jsonOut && !args.mdOut) console.log(markdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
