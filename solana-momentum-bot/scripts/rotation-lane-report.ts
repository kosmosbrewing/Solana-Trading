#!/usr/bin/env ts-node
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import {
  DEFAULT_DEV_WALLET_CANDIDATE_PATH,
  loadDevWalletCandidateIndex,
  lookupDevWalletCandidate,
  type DevWalletCandidateIndex,
} from '../src/observability/devWalletCandidateRegistry';
import {
  buildKolTransferPosteriorReport,
  loadKolPosteriorCoverageTargetsWithStatus,
  type KolPosteriorCoverage,
  type KolPosteriorCoverageLoadStatus,
  type KolPosteriorCoverageSummary,
  type KolPosteriorCoverageTarget,
  type KolPosteriorMetrics,
  type KolTransferRow,
} from './kol-transfer-posterior-report';

const ROTATION_PAPER_TRADES_FILE = 'rotation-v1-paper-trades.jsonl';
const ROTATION_LIVE_TRADES_FILE = 'rotation-v1-live-trades.jsonl';
const KOL_PAPER_TRADES_FILE = 'kol-paper-trades.jsonl';
const KOL_TRANSFER_INPUT_FILE = 'kol-transfers.jsonl';
const EVIDENCE_MIN_CLOSES = 50;
const EVIDENCE_PROMOTION_MIN_CLOSES = 100;
const EVIDENCE_MIN_OK_COVERAGE = 0.8;
const EVIDENCE_MIN_EDGE_COVERAGE = 0.8;
const EVIDENCE_MIN_EDGE_PASS_RATE = 0.5;
const EVIDENCE_PRIMARY_HORIZONS_SEC = [15, 30];
const EVIDENCE_DECAY_HORIZON_SEC = 60;
const EVIDENCE_REQUIRED_COVERAGE_HORIZONS_SEC = EVIDENCE_PRIMARY_HORIZONS_SEC;
const ROTATION_CONTROL_ARM = 'kol_hunter_rotation_v1';

interface Args {
  realtimeDir: string;
  sinceMs: number;
  horizonsSec: number[];
  roundTripCostPct: number;
  paperTradesFileName?: string;
  assumedAtaRentSol?: number;
  assumedNetworkFeeSol?: number;
  candidateFile?: string;
  kolTransferInput?: string;
  kolDbPath?: string;
  mdOut?: string;
  jsonOut?: string;
}

interface JsonRow {
  [key: string]: unknown;
}

interface HorizonStats {
  horizonSec: number;
  rows: number;
  okRows: number;
  positiveRows: number;
  strongRows: number;
  t1Rows: number;
  positivePostCostRows: number;
  avgDeltaPct: number | null;
  medianDeltaPct: number | null;
  p25DeltaPct: number | null;
  avgPostCostDeltaPct: number | null;
  medianPostCostDeltaPct: number | null;
  p25PostCostDeltaPct: number | null;
}

interface ArmHorizonStats {
  armName: string;
  afterBuy: HorizonStats[];
  afterSell: HorizonStats[];
}

interface PaperArmStats {
  armName: string;
  rows: number;
  wins: number;
  losses: number;
  netSol: number;
  netSolTokenOnly: number;
  refundAdjustedNetSol: number;
  rentAdjustedNetSol: number;
  edgeRows: number;
  edgePassRows: number;
  edgeFailRows: number;
  medianEdgeCostRatio: number | null;
  medianEdgeWalletDragRatio: number | null;
  medianRequiredGrossMovePct: number | null;
  hardCutRows: number;
  t1Rows: number;
  tokenOnlyWinnerRefundLoserRows: number;
  mfe5RefundLoserRows: number;
  mfe12RefundLoserRows: number;
  mae5Within15Rows: number;
  mae10BeforeT1Rows: number;
  medianMaeWorstPct: number | null;
  medianHardCutMaePct: number | null;
  medianHoldSec: number | null;
  topExitReasons: Array<{ reason: string; count: number }>;
}

interface WinnerEntryPairingStats {
  armName: string;
  exitBucket: 'winner_trailing_t1' | 'other_exits';
  rows: number;
  wins: number;
  losses: number;
  netSol: number;
  netSolTokenOnly: number;
  refundAdjustedNetSol: number;
  rentAdjustedNetSol: number;
  medianMfePct: number | null;
  medianMaePct: number | null;
  medianHoldSec: number | null;
}

interface WinnerEntryDiagnosticStats {
  armName: string;
  exitBucket: 'winner_trailing_t1' | 'other_exits';
  rows: number;
  medianTopupStrength: number | null;
  medianSellPressure30: number | null;
  medianAnchorBuySol: number | null;
  freshTopupRate: number | null;
  highRiskFlagRate: number | null;
  unknownQualityRate: number | null;
}

interface UnderfillEntryQualityStats {
  scope: 'paper' | 'live';
  rows: number;
  referenceRows: number;
  medianEntryVsKolFillPct: number | null;
  p75EntryVsKolFillPct: number | null;
  favorableRows: number;
  unfavorableRows: number;
}

type EvidenceVerdictStatus =
  | 'COLLECT'
  | 'DATA_GAP'
  | 'COST_REJECT'
  | 'POST_COST_REJECT'
  | 'WATCH'
  | 'PROMOTION_CANDIDATE';

interface EvidenceVerdict {
  armName: string;
  verdict: EvidenceVerdictStatus;
  reasons: string[];
  closes: number;
  minRequiredCloses: number;
  promotionRequiredCloses: number;
  minOkCoverage: number | null;
  requiredHorizonCoverage: Array<{ horizonSec: number; okCoverage: number | null }>;
  primaryHorizonPostCost: Array<{ horizonSec: number; medianPostCostDeltaPct: number | null }>;
  primaryHorizonSec: number | null;
  primaryMedianPostCostDeltaPct: number | null;
  controlPrimaryMedianPostCostDeltaPct: number | null;
  primaryBeatDeltaPct: number | null;
  decayHorizonSec: number;
  decayMedianPostCostDeltaPct: number | null;
  t60MedianPostCostDeltaPct: number | null;
  controlT60MedianPostCostDeltaPct: number | null;
  controlBeatDeltaPct: number | null;
  refundAdjustedNetSol: number | null;
  rentAdjustedNetSol: number | null;
  edgeCoverage: number | null;
  edgePassRate: number | null;
}

interface RotationReport {
  generatedAt: string;
  realtimeDir: string;
  since: string;
  horizonsSec: number[];
  roundTripCostPct: number;
  assumedAtaRentSol: number;
  assumedNetworkFeeSol: number;
  tradeMarkouts: {
    totalRows: number;
    rotationRows: number;
    afterBuy: HorizonStats[];
    afterSell: HorizonStats[];
    afterSellFinal: HorizonStats[];
    afterSellPartial: HorizonStats[];
    afterSellHardCut: HorizonStats[];
    afterSellMaeFastFail: HorizonStats[];
    byArm: ArmHorizonStats[];
  };
  paperTrades: {
    totalRows: number;
    rotationRows: number;
    byArm: PaperArmStats[];
    winnerEntryPairings: WinnerEntryPairingStats[];
    winnerEntryDiagnostics: WinnerEntryDiagnosticStats[];
  };
  liveTrades: {
    totalRows: number;
    rotationRows: number;
    byArm: PaperArmStats[];
  };
  underfillEntryQuality: UnderfillEntryQualityStats[];
  evidenceVerdicts: EvidenceVerdict[];
  noTrade: {
    totalRows: number;
    probeRows: number;
    byHorizon: HorizonStats[];
    byReason: Array<{
      reason: string;
      count: number;
      okRows: number;
      positiveRows: number;
      positivePostCostRows: number;
      medianDeltaPct: number | null;
      medianPostCostDeltaPct: number | null;
    }>;
  };
  byAnchor: Array<{
    anchor: string;
    rows: number;
    okRows: number;
    medianDeltaPct60s: number | null;
    medianPostCostDeltaPct60s: number | null;
    positive60s: number;
    positivePostCost60s: number;
  }>;
  byDevQuality: Array<{
    bucket: string;
    rows: number;
    okRows: number;
    medianDeltaPct60s: number | null;
    medianPostCostDeltaPct60s: number | null;
    positive60s: number;
    positivePostCost60s: number;
  }>;
  kolTransferPosterior: {
    input: string;
    kolDbPath?: string;
    coverageLoadStatus?: KolPosteriorCoverageLoadStatus;
    coverageLoadError?: string;
    rows: number;
    candidates: number;
    coverageSummary?: KolPosteriorCoverageSummary;
    coverage?: KolPosteriorCoverage[];
    topRotationFit: KolPosteriorMetrics[];
  };
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    realtimeDir: path.resolve(process.cwd(), 'data/realtime'),
    sinceMs: Date.now() - 24 * 3600_000,
    horizonsSec: [15, 30, 60],
    roundTripCostPct: 0.005,
    paperTradesFileName: ROTATION_PAPER_TRADES_FILE,
    assumedAtaRentSol: 0.00207408,
    assumedNetworkFeeSol: 0.000105,
    candidateFile: DEFAULT_DEV_WALLET_CANDIDATE_PATH,
    kolTransferInput: path.resolve(process.cwd(), 'data/research', KOL_TRANSFER_INPUT_FILE),
    kolDbPath: path.resolve(process.cwd(), 'data/kol/wallets.json'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--realtime-dir') args.realtimeDir = path.resolve(argv[++i]);
    else if (arg === '--since') args.sinceMs = parseSince(argv[++i]);
    else if (arg === '--horizons') args.horizonsSec = parseHorizons(argv[++i]);
    else if (arg === '--round-trip-cost-pct') args.roundTripCostPct = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--paper-trades-file') args.paperTradesFileName = argv[++i];
    else if (arg === '--assumed-ata-rent-sol') args.assumedAtaRentSol = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--assumed-network-fee-sol') args.assumedNetworkFeeSol = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--candidate-file') args.candidateFile = path.resolve(argv[++i]);
    else if (arg.startsWith('--candidate-file=')) args.candidateFile = path.resolve(arg.split('=')[1]);
    else if (arg === '--no-candidates') args.candidateFile = undefined;
    else if (arg === '--kol-transfer-input') args.kolTransferInput = path.resolve(argv[++i]);
    else if (arg.startsWith('--kol-transfer-input=')) args.kolTransferInput = path.resolve(arg.split('=')[1]);
    else if (arg === '--kol-db') args.kolDbPath = path.resolve(argv[++i]);
    else if (arg === '--no-kol-coverage') args.kolDbPath = undefined;
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

function obj(value: unknown): JsonRow {
  return typeof value === 'object' && value != null ? value as JsonRow : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timeMs(value: unknown): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function probe(row: JsonRow): JsonRow {
  return obj(row.probe);
}

function rowHorizon(row: JsonRow): number | null {
  return num(row.horizonSec) ?? num(probe(row).offsetSec);
}

function rowDelta(row: JsonRow): number | null {
  return num(row.deltaPct) ?? num(probe(row).deltaPct);
}

function rowPositionId(row: JsonRow): string {
  return str(row.positionId) || str(obj(row.extras).positionId);
}

function rowTokenMint(row: JsonRow): string {
  return str(row.tokenMint) || str(obj(row.extras).tokenMint);
}

function rowArmName(row: JsonRow): string {
  const extras = obj(row.extras);
  return str(row.profileArm) ||
    str(extras.profileArm) ||
    str(row.armName) ||
    str(extras.armName) ||
    str(row.signalSource) ||
    str(row.parameterVersion) ||
    str(extras.parameterVersion) ||
    '(unknown)';
}

function rotationEdge(row: JsonRow): JsonRow {
  const direct = obj(row.rotationMonetizableEdge);
  if (Object.keys(direct).length > 0) return direct;
  return obj(obj(row.extras).rotationMonetizableEdge);
}

function boolValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

function edgeTicketSol(edge: JsonRow): number | null {
  const value = num(edge.ticketSol);
  return value != null && value > 0 ? value : null;
}

function edgeCopyableCostRatio(edge: JsonRow): number | null {
  const ticketSol = edgeTicketSol(edge);
  const irreversibleCostSol = num(edge.irreversibleCostSol) ?? num(edge.bleedTotalSol);
  if (ticketSol != null && irreversibleCostSol != null && Number.isFinite(irreversibleCostSol)) {
    return irreversibleCostSol / ticketSol;
  }
  return num(edge.costRatio);
}

function edgeWalletDragRatio(edge: JsonRow): number | null {
  const direct = num(edge.walletDragRatio);
  if (direct != null) return direct;
  const ticketSol = edgeTicketSol(edge);
  const walletDragSol = num(edge.walletDragSol) ?? num(edge.totalCostSol);
  if (ticketSol != null && walletDragSol != null && Number.isFinite(walletDragSol)) {
    return walletDragSol / ticketSol;
  }
  return null;
}

function edgePassValue(edge: JsonRow): boolean | null {
  const costRatio = edgeCopyableCostRatio(edge);
  const maxCostRatio = num(edge.maxCostRatio);
  if (costRatio != null && maxCostRatio != null) return costRatio <= maxCostRatio;
  return boolValue(edge.pass);
}

function edgeRequiredGrossMovePct(edge: JsonRow): number | null {
  const copyableCostRatio = edgeCopyableCostRatio(edge);
  if (copyableCostRatio != null) return copyableCostRatio;
  return num(edge.requiredGrossMovePct);
}

function isRotationArmValue(value: string): boolean {
  return value === 'kol_hunter_rotation_v1' ||
    value.startsWith('rotation_') ||
    value.startsWith('rotation-') ||
    value.includes('rotation_v1');
}

function isOk(row: JsonRow): boolean {
  if (row.probe != null) return str(probe(row).quoteStatus) === 'ok' && rowDelta(row) != null;
  return str(row.quoteStatus) === 'ok' && rowDelta(row) != null;
}

function isRotationTradeMarkout(row: JsonRow): boolean {
  const extras = obj(row.extras);
  if (isRotationArmValue(rowArmName(row))) return true;
  if (str(row.signalSource) === 'kol_hunter_rotation_v1') return true;
  if (str(extras.entryReason) === 'rotation_v1') return true;
  return Array.isArray(extras.rotationAnchorKols) && extras.rotationAnchorKols.length > 0;
}

function isRotationPaperTrade(row: JsonRow): boolean {
  if (str(row.lane) !== 'kol_hunter' && str(row.strategy) !== 'kol_hunter') return false;
  if (isRotationArmValue(rowArmName(row))) return true;
  if (str(row.kolEntryReason) === 'rotation_v1') return true;
  if (str(row.entryReason) === 'rotation_v1') return true;
  return str(row.parameterVersion).startsWith('rotation-');
}

function isRotationNoTrade(row: JsonRow): boolean {
  const extras = obj(row.extras);
  return str(row.lane) === 'kol_hunter' &&
    (str(row.signalSource) === 'kol_hunter_rotation_v1' ||
      isRotationArmValue(str(row.signalSource)) ||
      str(extras.eventType) === 'rotation_no_trade' ||
      str(extras.eventType) === 'rotation_arm_skip' ||
      str(row.rejectReason).startsWith('rotation_v1_'));
}

function markoutEventType(row: JsonRow): string {
  return str(obj(row.extras).eventType);
}

function markoutExitReason(row: JsonRow): string {
  return str(obj(row.extras).exitReason) || str(row.exitReason);
}

function isPartialSellMarkout(row: JsonRow): boolean {
  const eventType = markoutEventType(row);
  return eventType === 'paper_partial_take' ||
    eventType === 'rotation_flow_reduce' ||
    eventType.includes('partial');
}

function isFinalSellMarkout(row: JsonRow): boolean {
  const eventType = markoutEventType(row);
  return eventType === 'paper_close' ||
    eventType === 'live_close' ||
    (!isPartialSellMarkout(row) && str(row.anchorType) === 'sell');
}

function isHardCutSellMarkout(row: JsonRow): boolean {
  const reason = markoutExitReason(row);
  return reason === 'probe_hard_cut' ||
    reason === 'rotation_dead_on_arrival' ||
    reason === 'rotation_mae_fast_fail' ||
    reason === 'rotation_flow_residual_timeout' ||
    reason === 'quick_reject_classifier_exit';
}

function isMaeFastFailSellMarkout(row: JsonRow): boolean {
  return markoutExitReason(row) === 'rotation_mae_fast_fail';
}

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[idx];
}

function summarize(rows: JsonRow[], horizonsSec: number[], roundTripCostPct: number): HorizonStats[] {
  return horizonsSec.map((horizonSec) => {
    const scoped = rows.filter((row) => rowHorizon(row) === horizonSec);
    const ok = scoped.filter(isOk);
    const deltas = ok.map(rowDelta).filter((value): value is number => value != null);
    const postCostDeltas = deltas.map((value) => value - roundTripCostPct);
    const avg = deltas.length > 0 ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null;
    const postCostAvg = postCostDeltas.length > 0
      ? postCostDeltas.reduce((sum, value) => sum + value, 0) / postCostDeltas.length
      : null;
    return {
      horizonSec,
      rows: scoped.length,
      okRows: ok.length,
      positiveRows: deltas.filter((value) => value > 0).length,
      strongRows: deltas.filter((value) => value >= 0.03).length,
      t1Rows: deltas.filter((value) => value >= 0.12).length,
      positivePostCostRows: postCostDeltas.filter((value) => value > 0).length,
      avgDeltaPct: avg,
      medianDeltaPct: percentile(deltas, 0.5),
      p25DeltaPct: percentile(deltas, 0.25),
      avgPostCostDeltaPct: postCostAvg,
      medianPostCostDeltaPct: percentile(postCostDeltas, 0.5),
      p25PostCostDeltaPct: percentile(postCostDeltas, 0.25),
    };
  });
}

function buildArmHorizonStats(rows: JsonRow[], horizonsSec: number[], roundTripCostPct: number): ArmHorizonStats[] {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows) {
    const key = rowArmName(row);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return [...buckets.entries()]
    .map(([armName, scoped]) => ({
      armName,
      afterBuy: summarize(scoped.filter((row) => str(row.anchorType) === 'buy'), horizonsSec, roundTripCostPct),
      afterSell: summarize(scoped.filter((row) => str(row.anchorType) === 'sell'), horizonsSec, roundTripCostPct),
    }))
    .sort((a, b) => {
      const aRows = a.afterBuy.reduce((sum, row) => sum + row.rows, 0) + a.afterSell.reduce((sum, row) => sum + row.rows, 0);
      const bRows = b.afterBuy.reduce((sum, row) => sum + row.rows, 0) + b.afterSell.reduce((sum, row) => sum + row.rows, 0);
      return bRows - aRows || a.armName.localeCompare(b.armName);
    });
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function buildTopExitReasons(rows: JsonRow[]): Array<{ reason: string; count: number }> {
  const buckets = new Map<string, number>();
  for (const row of rows) {
    const reason = str(row.exitReason) || '(unknown)';
    buckets.set(reason, (buckets.get(reason) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 5);
}

function normalizeReturnFraction(value: number | null): number | null {
  if (value == null) return null;
  return Math.abs(value) > 20 ? value / 100 : value;
}

function rowMaeWorstPct(row: JsonRow): number | null {
  return normalizeReturnFraction(num(row.maeWorstPct) ?? num(row.maePctTokenOnly) ?? num(row.maePct));
}

function rowNumWithExtras(row: JsonRow, keys: string[]): number | null {
  const extras = obj(row.extras);
  for (const key of keys) {
    const direct = num(row[key]);
    if (direct != null) return direct;
    const extra = num(extras[key]);
    if (extra != null) return extra;
  }
  return null;
}

function rowMaeAt5sPct(row: JsonRow): number | null {
  return normalizeReturnFraction(rowNumWithExtras(row, ['maeAt5s', 'rotationMaeAt5s']));
}

function rowMaeAt15sPct(row: JsonRow): number | null {
  return normalizeReturnFraction(rowNumWithExtras(row, ['maeAt15s', 'rotationMaeAt15s']));
}

function rowMfePct(row: JsonRow): number | null {
  return normalizeReturnFraction(num(row.mfePctPeak) ?? num(row.mfePctTokenOnly) ?? num(row.mfePct));
}

function rowHasT1(row: JsonRow): boolean {
  const extras = obj(row.extras);
  return row.t1VisitAtSec != null ||
    row.t1VisitedAt != null ||
    row.t1ReachedAt != null ||
    extras.t1VisitAtSec != null ||
    extras.t1VisitedAt != null ||
    extras.t1ReachedAt != null ||
    str(row.exitReason) === 'winner_trailing_t1';
}

function rowHardCutMaePct(row: JsonRow): number | null {
  return normalizeReturnFraction(num(row.hardCutTriggerMaePct) ?? num(row.maeWorstPct) ?? num(row.maePctTokenOnly) ?? num(row.maePct));
}

function rotationFlowMetrics(row: JsonRow): JsonRow {
  const direct = obj(row.rotationFlowMetrics);
  if (Object.keys(direct).length > 0) return direct;
  return obj(obj(row.extras).rotationFlowMetrics);
}

function rowSurvivalFlags(row: JsonRow): string[] {
  const direct = row.survivalFlags;
  const fromExtras = obj(row.extras).survivalFlags;
  const raw = Array.isArray(direct) ? direct : Array.isArray(fromExtras) ? fromExtras : [];
  return raw.flatMap((flag) => typeof flag === 'string' ? [flag] : []);
}

function rowUnderfillReferencePrice(row: JsonRow): number | null {
  const direct = num(row.underfillReferencePrice);
  if (direct != null && direct > 0) return direct;
  const extras = obj(row.extras);
  const extraDirect = num(extras.underfillReferencePrice);
  if (extraDirect != null && extraDirect > 0) return extraDirect;
  const sol = num(row.underfillReferenceSolAmount) ?? num(extras.underfillReferenceSolAmount);
  const tokens = num(row.underfillReferenceTokenAmount) ?? num(extras.underfillReferenceTokenAmount);
  if (sol != null && tokens != null && sol > 0 && tokens > 0) return sol / tokens;
  return null;
}

function rowEntryPriceForUnderfillQuality(row: JsonRow): number | null {
  return num(row.entryPriceTokenOnly) ??
    num(row.entryPrice) ??
    num(obj(row.extras).entryPrice);
}

function buildUnderfillEntryQualityStats(
  scope: UnderfillEntryQualityStats['scope'],
  rows: JsonRow[]
): UnderfillEntryQualityStats {
  const underfillRows = rows.filter((row) => {
    const arm = rowArmName(row);
    const entryArm = str(row.entryArm) || str(obj(row.extras).entryArm);
    return arm === 'rotation_underfill_v1' ||
      arm === 'rotation_underfill_exit_flow_v1' ||
      entryArm === 'rotation_underfill_v1';
  });
  const diffs = underfillRows
    .map((row) => {
      const ref = rowUnderfillReferencePrice(row);
      const entry = rowEntryPriceForUnderfillQuality(row);
      if (ref == null || entry == null || ref <= 0 || entry <= 0) return null;
      return entry / ref - 1;
    })
    .filter((value): value is number => value != null && Number.isFinite(value));
  return {
    scope,
    rows: underfillRows.length,
    referenceRows: diffs.length,
    medianEntryVsKolFillPct: percentile(diffs, 0.5),
    p75EntryVsKolFillPct: percentile(diffs, 0.75),
    favorableRows: diffs.filter((value) => value < 0).length,
    unfavorableRows: diffs.filter((value) => value >= 0).length,
  };
}

function hasHighRiskFlag(row: JsonRow): boolean {
  return rowSurvivalFlags(row).some((flag) =>
    flag.startsWith('UNCLEAN_TOKEN') ||
    flag.includes('NO_SECURITY_DATA') ||
    flag.includes('SEVERE') ||
    flag.includes('RUG') ||
    flag.includes('BLACKLIST')
  );
}

function hasUnknownQualityFlag(row: JsonRow): boolean {
  return rowSurvivalFlags(row).some((flag) =>
    flag === 'TOKEN_QUALITY_UNKNOWN' ||
    flag === 'EXIT_LIQUIDITY_UNKNOWN' ||
    flag === 'NO_HELIUS_PROVENANCE'
  );
}

function isHardCutTrade(row: JsonRow): boolean {
  const reason = str(row.exitReason);
  return reason === 'probe_hard_cut' ||
    reason === 'rotation_dead_on_arrival' ||
    reason === 'rotation_mae_fast_fail' ||
    reason === 'rotation_flow_residual_timeout' ||
    reason === 'quick_reject_classifier_exit';
}

function buildPaperArmStats(
  rows: JsonRow[],
  assumedAtaRentSol: number,
  assumedNetworkFeeSol: number
): PaperArmStats[] {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows) {
    const key = rowArmName(row);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  const assumedWalletDragSol = assumedAtaRentSol + assumedNetworkFeeSol;
  return [...buckets.entries()]
    .map(([armName, scoped]) => {
      const netSolValues = scoped.map((row) => numberOrZero(row.netSol));
      const tokenOnlyValues = scoped.map((row) => {
        const tokenOnly = num(row.netSolTokenOnly);
        return tokenOnly == null ? numberOrZero(row.netSol) : tokenOnly;
      });
      const holdSec = scoped.map((row) => num(row.holdSec)).filter((value): value is number => value != null);
      const edgeRows = scoped
        .map(rotationEdge)
        .filter((edge) => Object.keys(edge).length > 0);
      const edgeCostRatios = edgeRows
        .map(edgeCopyableCostRatio)
        .filter((value): value is number => value != null && Number.isFinite(value));
      const edgeWalletDragRatios = edgeRows
        .map(edgeWalletDragRatio)
        .filter((value): value is number => value != null && Number.isFinite(value));
      const edgeRequiredMoves = edgeRows
        .map(edgeRequiredGrossMovePct)
        .filter((value): value is number => value != null && Number.isFinite(value));
      const netSol = netSolValues.reduce((sum, value) => sum + value, 0);
      const netSolTokenOnly = tokenOnlyValues.reduce((sum, value) => sum + value, 0);
      const rowMetrics = scoped.map((row, index) => ({
        row,
        tokenOnlyNetSol: tokenOnlyValues[index],
        refundAdjustedNetSol: tokenOnlyValues[index] - assumedNetworkFeeSol,
      }));
      const maeWorstValues = scoped.map(rowMaeWorstPct).filter((value): value is number => value != null);
      const hardCutRows = scoped.filter(isHardCutTrade);
      const hardCutMaeValues = hardCutRows.map(rowHardCutMaePct).filter((value): value is number => value != null);
      return {
        armName,
        rows: scoped.length,
        wins: netSolValues.filter((value) => value > 0).length,
        losses: netSolValues.filter((value) => value <= 0).length,
        netSol,
        netSolTokenOnly,
        refundAdjustedNetSol: tokenOnlyValues
          .map((value) => value - assumedNetworkFeeSol)
          .reduce((sum, value) => sum + value, 0),
        rentAdjustedNetSol: tokenOnlyValues
          .map((value) => value - assumedWalletDragSol)
          .reduce((sum, value) => sum + value, 0),
        edgeRows: edgeRows.length,
        edgePassRows: edgeRows.filter((edge) => edgePassValue(edge) === true).length,
        edgeFailRows: edgeRows.filter((edge) => edgePassValue(edge) === false).length,
        medianEdgeCostRatio: percentile(edgeCostRatios, 0.5),
        medianEdgeWalletDragRatio: percentile(edgeWalletDragRatios, 0.5),
        medianRequiredGrossMovePct: percentile(edgeRequiredMoves, 0.5),
        hardCutRows: hardCutRows.length,
        t1Rows: scoped.filter(rowHasT1).length,
        tokenOnlyWinnerRefundLoserRows: rowMetrics
          .filter(({ tokenOnlyNetSol, refundAdjustedNetSol }) => tokenOnlyNetSol > 0 && refundAdjustedNetSol <= 0)
          .length,
        mfe5RefundLoserRows: rowMetrics
          .filter(({ row, refundAdjustedNetSol }) => (rowMfePct(row) ?? 0) >= 0.05 && refundAdjustedNetSol <= 0)
          .length,
        mfe12RefundLoserRows: rowMetrics
          .filter(({ row, refundAdjustedNetSol }) => (rowMfePct(row) ?? 0) >= 0.12 && refundAdjustedNetSol <= 0)
          .length,
        mae5Within15Rows: scoped.filter((row) => {
          const maeAt5s = rowMaeAt5sPct(row);
          const maeAt15s = rowMaeAt15sPct(row);
          return (maeAt5s != null && maeAt5s <= -0.05) || (maeAt15s != null && maeAt15s <= -0.05);
        }).length,
        mae10BeforeT1Rows: scoped.filter((row) => {
          const maeWorst = rowMaeWorstPct(row);
          return maeWorst != null && maeWorst <= -0.10 && !rowHasT1(row);
        }).length,
        medianMaeWorstPct: percentile(maeWorstValues, 0.5),
        medianHardCutMaePct: percentile(hardCutMaeValues, 0.5),
        medianHoldSec: percentile(holdSec, 0.5),
        topExitReasons: buildTopExitReasons(scoped),
      };
    })
    .sort((a, b) => b.rows - a.rows || b.netSolTokenOnly - a.netSolTokenOnly || a.armName.localeCompare(b.armName));
}

function buildWinnerEntryPairingStats(
  rows: JsonRow[],
  assumedAtaRentSol: number,
  assumedNetworkFeeSol: number
): WinnerEntryPairingStats[] {
  const buckets = new Map<string, { armName: string; exitBucket: WinnerEntryPairingStats['exitBucket']; rows: JsonRow[] }>();
  const assumedWalletDragSol = assumedAtaRentSol + assumedNetworkFeeSol;
  for (const row of rows) {
    const armName = rowArmName(row);
    const exitBucket: WinnerEntryPairingStats['exitBucket'] =
      str(row.exitReason) === 'winner_trailing_t1' ? 'winner_trailing_t1' : 'other_exits';
    const key = `${armName}:${exitBucket}`;
    const bucket = buckets.get(key) ?? { armName, exitBucket, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map(({ armName, exitBucket, rows: scoped }) => {
      const netSolValues = scoped.map((row) => numberOrZero(row.netSol));
      const tokenOnlyValues = scoped.map((row) => {
        const tokenOnly = num(row.netSolTokenOnly);
        return tokenOnly == null ? numberOrZero(row.netSol) : tokenOnly;
      });
      const holds = scoped.map((row) => num(row.holdSec)).filter((value): value is number => value != null);
      const mfeValues = scoped.map(rowMfePct).filter((value): value is number => value != null);
      const maeValues = scoped.map(rowMaeWorstPct).filter((value): value is number => value != null);
      return {
        armName,
        exitBucket,
        rows: scoped.length,
        wins: netSolValues.filter((value) => value > 0).length,
        losses: netSolValues.filter((value) => value <= 0).length,
        netSol: netSolValues.reduce((sum, value) => sum + value, 0),
        netSolTokenOnly: tokenOnlyValues.reduce((sum, value) => sum + value, 0),
        refundAdjustedNetSol: tokenOnlyValues
          .map((value) => value - assumedNetworkFeeSol)
          .reduce((sum, value) => sum + value, 0),
        rentAdjustedNetSol: tokenOnlyValues
          .map((value) => value - assumedWalletDragSol)
          .reduce((sum, value) => sum + value, 0),
        medianMfePct: percentile(mfeValues, 0.5),
        medianMaePct: percentile(maeValues, 0.5),
        medianHoldSec: percentile(holds, 0.5),
      };
    })
    .sort((a, b) => {
      if (a.exitBucket !== b.exitBucket) return a.exitBucket === 'winner_trailing_t1' ? -1 : 1;
      return b.netSolTokenOnly - a.netSolTokenOnly || b.rows - a.rows || a.armName.localeCompare(b.armName);
    });
}

function buildWinnerEntryDiagnosticStats(rows: JsonRow[]): WinnerEntryDiagnosticStats[] {
  const buckets = new Map<string, { armName: string; exitBucket: WinnerEntryDiagnosticStats['exitBucket']; rows: JsonRow[] }>();
  for (const row of rows) {
    const armName = rowArmName(row);
    const exitBucket: WinnerEntryDiagnosticStats['exitBucket'] =
      str(row.exitReason) === 'winner_trailing_t1' ? 'winner_trailing_t1' : 'other_exits';
    const key = `${armName}:${exitBucket}`;
    const bucket = buckets.get(key) ?? { armName, exitBucket, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map(({ armName, exitBucket, rows: scoped }) => {
      const topupStrength = scoped
        .map((row) => num(rotationFlowMetrics(row).topupStrength))
        .filter((value): value is number => value != null);
      const sellPressure = scoped
        .map((row) => num(rotationFlowMetrics(row).sellPressure30))
        .filter((value): value is number => value != null);
      const anchorBuySol = scoped
        .map((row) => num(rotationFlowMetrics(row).anchorBuySolBeforeFirstSell))
        .filter((value): value is number => value != null);
      const freshTopups = scoped.filter((row) => rotationFlowMetrics(row).freshTopup === true).length;
      const highRisk = scoped.filter(hasHighRiskFlag).length;
      const unknownQuality = scoped.filter(hasUnknownQualityFlag).length;
      return {
        armName,
        exitBucket,
        rows: scoped.length,
        medianTopupStrength: percentile(topupStrength, 0.5),
        medianSellPressure30: percentile(sellPressure, 0.5),
        medianAnchorBuySol: percentile(anchorBuySol, 0.5),
        freshTopupRate: scoped.length > 0 ? freshTopups / scoped.length : null,
        highRiskFlagRate: scoped.length > 0 ? highRisk / scoped.length : null,
        unknownQualityRate: scoped.length > 0 ? unknownQuality / scoped.length : null,
      };
    })
    .sort((a, b) => {
      if (a.exitBucket !== b.exitBucket) return a.exitBucket === 'winner_trailing_t1' ? -1 : 1;
      return b.rows - a.rows || a.armName.localeCompare(b.armName);
    });
}

function horizonOkCoverage(row: HorizonStats | undefined): number | null {
  if (!row) return null;
  return row.rows > 0 ? row.okRows / row.rows : 0;
}

function requiredHorizonCoverage(markout: ArmHorizonStats | undefined): Array<{ horizonSec: number; okCoverage: number | null }> {
  return EVIDENCE_REQUIRED_COVERAGE_HORIZONS_SEC.map((horizonSec) => ({
    horizonSec,
    okCoverage: horizonOkCoverage(markout?.afterBuy.find((row) => row.horizonSec === horizonSec)),
  }));
}

function minRequiredOkCoverage(rows: Array<{ horizonSec: number; okCoverage: number | null }>): number | null {
  const coverages = rows.map((row) => row.okCoverage);
  if (coverages.some((value) => value == null || !Number.isFinite(value))) return null;
  return percentile(coverages as number[], 0);
}

function verdictReasonCoverage(value: number | null): string {
  return value == null ? 'ok coverage missing' : `ok coverage ${formatPct(value)} < ${formatPct(EVIDENCE_MIN_OK_COVERAGE)}`;
}

function verdictCoverageReasons(rows: Array<{ horizonSec: number; okCoverage: number | null }>): string[] {
  return rows.flatMap((row) => {
    if (row.okCoverage == null) return [`T+${row.horizonSec}s coverage missing`];
    if (row.okCoverage < EVIDENCE_MIN_OK_COVERAGE) {
      return [`T+${row.horizonSec}s ok coverage ${formatPct(row.okCoverage)} < ${formatPct(EVIDENCE_MIN_OK_COVERAGE)}`];
    }
    return [];
  });
}

function horizonBySec(markout: ArmHorizonStats | undefined, horizonSec: number): HorizonStats | null {
  return markout?.afterBuy.find((row) => row.horizonSec === horizonSec) ?? null;
}

function bestPrimaryHorizon(markout: ArmHorizonStats | undefined): HorizonStats | null {
  const candidates = EVIDENCE_PRIMARY_HORIZONS_SEC
    .map((horizonSec) => horizonBySec(markout, horizonSec))
    .filter((row): row is HorizonStats => row != null && row.rows > 0 && row.medianPostCostDeltaPct != null);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) =>
    (b.medianPostCostDeltaPct ?? -Infinity) - (a.medianPostCostDeltaPct ?? -Infinity) ||
    a.horizonSec - b.horizonSec
  )[0];
}

function primaryHorizonPostCost(markout: ArmHorizonStats | undefined): Array<{ horizonSec: number; medianPostCostDeltaPct: number | null }> {
  return EVIDENCE_PRIMARY_HORIZONS_SEC.map((horizonSec) => ({
    horizonSec,
    medianPostCostDeltaPct: horizonBySec(markout, horizonSec)?.medianPostCostDeltaPct ?? null,
  }));
}

function weakPrimaryPostCostReasons(rows: Array<{ horizonSec: number; medianPostCostDeltaPct: number | null }>): string[] {
  return rows.flatMap((row) => {
    if (row.medianPostCostDeltaPct == null) return [`T+${row.horizonSec}s median postCost missing`];
    if (row.medianPostCostDeltaPct <= 0) {
      return [`T+${row.horizonSec}s median postCost ${formatPct(row.medianPostCostDeltaPct)} <= 0`];
    }
    return [];
  });
}

function buildEvidenceVerdicts(
  paperArms: PaperArmStats[],
  armMarkouts: ArmHorizonStats[]
): EvidenceVerdict[] {
  const markoutsByArm = new Map(armMarkouts.map((row) => [row.armName, row]));
  const controlPrimaryMedianPostCostDeltaPct =
    bestPrimaryHorizon(markoutsByArm.get(ROTATION_CONTROL_ARM))?.medianPostCostDeltaPct ?? null;
  const controlT60MedianPostCostDeltaPct =
    horizonBySec(markoutsByArm.get(ROTATION_CONTROL_ARM), EVIDENCE_DECAY_HORIZON_SEC)?.medianPostCostDeltaPct ?? null;
  return paperArms.map((arm) => {
    const markout = markoutsByArm.get(arm.armName);
    const coverageRows = requiredHorizonCoverage(markout);
    const minOkCoverage = minRequiredOkCoverage(coverageRows);
    const primary = bestPrimaryHorizon(markout);
    const primaryPostCostRows = primaryHorizonPostCost(markout);
    const weakPrimaryPostCost = weakPrimaryPostCostReasons(primaryPostCostRows);
    const decay = horizonBySec(markout, EVIDENCE_DECAY_HORIZON_SEC);
    const primaryBeatDeltaPct =
      primary?.medianPostCostDeltaPct != null && controlPrimaryMedianPostCostDeltaPct != null
        ? primary.medianPostCostDeltaPct - controlPrimaryMedianPostCostDeltaPct
        : null;
    const controlBeatDeltaPct = primaryBeatDeltaPct;
    const decayBeatDeltaPct = decay?.medianPostCostDeltaPct != null && controlT60MedianPostCostDeltaPct != null
      ? decay.medianPostCostDeltaPct - controlT60MedianPostCostDeltaPct
      : null;
    const edgeCoverage = arm.rows > 0 ? arm.edgeRows / arm.rows : null;
    const edgePassRate = arm.edgeRows > 0 ? arm.edgePassRows / arm.edgeRows : null;
    const reasons: string[] = [];
    let verdict: EvidenceVerdictStatus = 'PROMOTION_CANDIDATE';
    if (decay?.medianPostCostDeltaPct != null && decay.medianPostCostDeltaPct <= 0) {
      reasons.push(`T+${EVIDENCE_DECAY_HORIZON_SEC}s decay warning ${formatPct(decay.medianPostCostDeltaPct)} <= 0`);
    }

    if (arm.rows < EVIDENCE_MIN_CLOSES) {
      verdict = 'COLLECT';
      reasons.push(`sample ${arm.rows}/${EVIDENCE_MIN_CLOSES}`);
    } else if (
      minOkCoverage == null ||
      minOkCoverage < EVIDENCE_MIN_OK_COVERAGE ||
      primary == null ||
      primary.rows === 0 ||
      edgeCoverage == null ||
      edgeCoverage < EVIDENCE_MIN_EDGE_COVERAGE
    ) {
      verdict = 'DATA_GAP';
      reasons.push(...verdictCoverageReasons(coverageRows));
      if (minOkCoverage == null || minOkCoverage < EVIDENCE_MIN_OK_COVERAGE) {
        reasons.push(`min ${verdictReasonCoverage(minOkCoverage)}`);
      }
      if (primary == null || primary.rows === 0) {
        reasons.push(`T+${EVIDENCE_PRIMARY_HORIZONS_SEC.join('/')}s primary markout missing`);
      }
      if (edgeCoverage == null || edgeCoverage < EVIDENCE_MIN_EDGE_COVERAGE) {
        reasons.push(`edge coverage ${formatPct(edgeCoverage)} < ${formatPct(EVIDENCE_MIN_EDGE_COVERAGE)}`);
      }
    } else if (edgePassRate == null || edgePassRate < EVIDENCE_MIN_EDGE_PASS_RATE || arm.refundAdjustedNetSol <= 0) {
      verdict = 'COST_REJECT';
      if (edgePassRate == null) reasons.push('edge shadow rows missing');
      else if (edgePassRate < EVIDENCE_MIN_EDGE_PASS_RATE) {
        reasons.push(`edge pass ${formatPct(edgePassRate)} < ${formatPct(EVIDENCE_MIN_EDGE_PASS_RATE)}`);
      }
      if (arm.refundAdjustedNetSol <= 0) reasons.push(`refund-adjusted net ${formatSol(arm.refundAdjustedNetSol)} <= 0`);
    } else if (weakPrimaryPostCost.length > 0) {
      verdict = 'POST_COST_REJECT';
      reasons.push(...weakPrimaryPostCost);
    } else if (arm.armName !== ROTATION_CONTROL_ARM && controlPrimaryMedianPostCostDeltaPct == null) {
      verdict = 'WATCH';
      reasons.push(`control T+${EVIDENCE_PRIMARY_HORIZONS_SEC.join('/')}s baseline missing`);
    } else if (arm.armName !== ROTATION_CONTROL_ARM && primaryBeatDeltaPct != null && primaryBeatDeltaPct <= 0) {
      verdict = 'POST_COST_REJECT';
      reasons.push(`primary postCost ${formatPct(primary.medianPostCostDeltaPct)} <= control ${formatPct(controlPrimaryMedianPostCostDeltaPct)}`);
    } else if (arm.rows < EVIDENCE_PROMOTION_MIN_CLOSES) {
      verdict = 'WATCH';
      reasons.push(`sample ${arm.rows}/${EVIDENCE_PROMOTION_MIN_CLOSES}`);
    } else {
      reasons.push('promotion evidence threshold met');
    }

    return {
      armName: arm.armName,
      verdict,
      reasons,
      closes: arm.rows,
      minRequiredCloses: EVIDENCE_MIN_CLOSES,
      promotionRequiredCloses: EVIDENCE_PROMOTION_MIN_CLOSES,
      minOkCoverage,
      requiredHorizonCoverage: coverageRows,
      primaryHorizonPostCost: primaryPostCostRows,
      primaryHorizonSec: primary?.horizonSec ?? null,
      primaryMedianPostCostDeltaPct: primary?.medianPostCostDeltaPct ?? null,
      controlPrimaryMedianPostCostDeltaPct: arm.armName === ROTATION_CONTROL_ARM ? null : controlPrimaryMedianPostCostDeltaPct,
      primaryBeatDeltaPct: arm.armName === ROTATION_CONTROL_ARM ? null : primaryBeatDeltaPct,
      decayHorizonSec: EVIDENCE_DECAY_HORIZON_SEC,
      decayMedianPostCostDeltaPct: decay?.medianPostCostDeltaPct ?? null,
      t60MedianPostCostDeltaPct: decay?.medianPostCostDeltaPct ?? null,
      controlT60MedianPostCostDeltaPct: arm.armName === ROTATION_CONTROL_ARM ? null : controlT60MedianPostCostDeltaPct,
      controlBeatDeltaPct: arm.armName === ROTATION_CONTROL_ARM ? null : decayBeatDeltaPct,
      refundAdjustedNetSol: arm.refundAdjustedNetSol,
      rentAdjustedNetSol: arm.rentAdjustedNetSol,
      edgeCoverage,
      edgePassRate,
    };
  });
}

function anchorKey(row: JsonRow): string {
  const extras = obj(row.extras);
  const raw = extras.rotationAnchorKols;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((value) => String(value)).sort().join('+');
  }
  const nested = obj(extras.rotationV1).anchorKols;
  if (Array.isArray(nested) && nested.length > 0) {
    return nested.map((value) => String(value)).sort().join('+');
  }
  return '(unknown)';
}

interface QualityAttribution {
  tokenMint: string;
  positionId?: string;
  observedAtMs: number;
  creatorAddress?: string;
  devWallet?: string;
  firstLpProvider?: string;
  operatorDevStatus?: string;
}

interface QualityIndex {
  byPositionId: Map<string, QualityAttribution>;
  byTokenMint: Map<string, QualityAttribution>;
}

function buildQualityIndex(rows: JsonRow[]): QualityIndex {
  const byPositionId = new Map<string, QualityAttribution>();
  const byTokenMint = new Map<string, QualityAttribution>();
  for (const row of rows) {
    const tokenMint = str(row.tokenMint);
    if (!tokenMint) continue;
    const ctx = obj(row.observationContext);
    const attribution: QualityAttribution = {
      tokenMint,
      positionId: str(ctx.positionId) || undefined,
      observedAtMs: timeMs(row.observedAt),
      creatorAddress: str(row.creatorAddress) || undefined,
      devWallet: str(row.devWallet) || undefined,
      firstLpProvider: str(row.firstLpProvider) || undefined,
      operatorDevStatus: str(row.operatorDevStatus) || undefined,
    };
    if (attribution.positionId) {
      const prev = byPositionId.get(attribution.positionId);
      if (!prev || attribution.observedAtMs >= prev.observedAtMs) {
        byPositionId.set(attribution.positionId, attribution);
      }
    }
    const prevByMint = byTokenMint.get(tokenMint);
    if (!prevByMint || attribution.observedAtMs >= prevByMint.observedAtMs) {
      byTokenMint.set(tokenMint, attribution);
    }
  }
  return { byPositionId, byTokenMint };
}

function lookupQuality(row: JsonRow, index: QualityIndex): QualityAttribution | undefined {
  const positionId = rowPositionId(row);
  if (positionId) {
    const byPosition = index.byPositionId.get(positionId);
    if (byPosition) return byPosition;
  }
  const mint = rowTokenMint(row);
  return mint ? index.byTokenMint.get(mint) : undefined;
}

function devQualityBuckets(
  attribution: QualityAttribution | undefined,
  candidateIndex?: DevWalletCandidateIndex
): string[] {
  const buckets = new Set<string>();
  const status = attribution?.operatorDevStatus;
  if (status && status !== 'unknown') buckets.add(`DEV_STATUS_${status.toUpperCase()}`);

  const candidate = candidateIndex && attribution
    ? lookupDevWalletCandidate(attribution.devWallet, candidateIndex) ??
      lookupDevWalletCandidate(attribution.creatorAddress, candidateIndex) ??
      lookupDevWalletCandidate(attribution.firstLpProvider, candidateIndex)
    : undefined;
  if (candidate) {
    buckets.add('DEV_CANDIDATE_MATCHED');
    buckets.add(`DEV_CANDIDATE_RISK_${candidate.risk_class.toUpperCase()}`);
    buckets.add(`DEV_CANDIDATE_LANE_${candidate.lane.toUpperCase()}`);
    buckets.add(`DEV_CANDIDATE_STATUS_${candidate.status.toUpperCase()}`);
    buckets.add(`DEV_CANDIDATE_SOURCE_${candidate.source_tier.toUpperCase()}`);
  }
  if (buckets.size === 0) buckets.add('DEV_UNKNOWN');
  return [...buckets];
}

function buildAnchorStats(rows: JsonRow[], roundTripCostPct: number): RotationReport['byAnchor'] {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows.filter((item) => rowHorizon(item) === 60)) {
    const key = anchorKey(row);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return [...buckets.entries()]
    .map(([anchor, scoped]) => {
      const ok = scoped.filter(isOk);
      const deltas = ok.map(rowDelta).filter((value): value is number => value != null);
      const postCostDeltas = deltas.map((value) => value - roundTripCostPct);
      return {
        anchor,
        rows: scoped.length,
        okRows: ok.length,
        medianDeltaPct60s: percentile(deltas, 0.5),
        medianPostCostDeltaPct60s: percentile(postCostDeltas, 0.5),
        positive60s: deltas.filter((value) => value > 0).length,
        positivePostCost60s: postCostDeltas.filter((value) => value > 0).length,
      };
    })
    .sort((a, b) => b.okRows - a.okRows || b.positivePostCost60s - a.positivePostCost60s || a.anchor.localeCompare(b.anchor))
    .slice(0, 25);
}

function buildDevQualityStats(
  rows: JsonRow[],
  qualityIndex: QualityIndex,
  candidateIndex: DevWalletCandidateIndex | undefined,
  roundTripCostPct: number
): RotationReport['byDevQuality'] {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows.filter((item) => rowHorizon(item) === 60)) {
    const attribution = lookupQuality(row, qualityIndex);
    for (const bucket of devQualityBuckets(attribution, candidateIndex)) {
      buckets.set(bucket, [...(buckets.get(bucket) ?? []), row]);
    }
  }
  return [...buckets.entries()]
    .map(([bucket, scoped]) => {
      const ok = scoped.filter(isOk);
      const deltas = ok.map(rowDelta).filter((value): value is number => value != null);
      const postCostDeltas = deltas.map((value) => value - roundTripCostPct);
      return {
        bucket,
        rows: scoped.length,
        okRows: ok.length,
        medianDeltaPct60s: percentile(deltas, 0.5),
        medianPostCostDeltaPct60s: percentile(postCostDeltas, 0.5),
        positive60s: deltas.filter((value) => value > 0).length,
        positivePostCost60s: postCostDeltas.filter((value) => value > 0).length,
      };
    })
    .sort((a, b) => b.okRows - a.okRows || b.positivePostCost60s - a.positivePostCost60s || a.bucket.localeCompare(b.bucket))
    .slice(0, 50);
}

function buildReasonStats(rows: JsonRow[], roundTripCostPct: number): RotationReport['noTrade']['byReason'] {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows) {
    const key = str(obj(row.extras).noTradeReason) || str(row.rejectReason) || '(unknown)';
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return [...buckets.entries()]
    .map(([reason, scoped]) => {
      const ok = scoped.filter(isOk);
      const deltas = ok.map(rowDelta).filter((value): value is number => value != null);
      const postCostDeltas = deltas.map((value) => value - roundTripCostPct);
      return {
        reason,
        count: scoped.length,
        okRows: ok.length,
        positiveRows: deltas.filter((value) => value > 0).length,
        positivePostCostRows: postCostDeltas.filter((value) => value > 0).length,
        medianDeltaPct: percentile(deltas, 0.5),
        medianPostCostDeltaPct: percentile(postCostDeltas, 0.5),
      };
    })
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function formatPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function formatSol(value: number | null): string {
  return value == null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(6)}`;
}

function renderStatsTable(rows: HorizonStats[]): string {
  if (rows.length === 0) return '_No rows._';
  return [
    '| horizon | rows | ok | ok coverage | positive | postCost>0 | >=3% | >=12% | p25 | median | median postCostDelta | avg | avg postCostDelta |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.horizonSec}s | ${row.rows} | ${row.okRows} | ` +
      `${row.rows > 0 ? `${((row.okRows / row.rows) * 100).toFixed(1)}%` : 'n/a'} | ` +
      `${row.positiveRows} | ${row.positivePostCostRows} | ` +
      `${row.strongRows} | ${row.t1Rows} | ${formatPct(row.p25DeltaPct)} | ${formatPct(row.medianDeltaPct)} | ` +
      `${formatPct(row.medianPostCostDeltaPct)} | ${formatPct(row.avgDeltaPct)} | ${formatPct(row.avgPostCostDeltaPct)} |`
    ),
  ].join('\n');
}

function renderPaperArmTable(rows: PaperArmStats[]): string {
  if (rows.length === 0) return '_No rotation paper trade rows._';
  return [
    '| arm | closes | W/L | net SOL | token-only SOL | refund-adjusted SOL | wallet-drag stress SOL | edge pass/fail | median cost ratio | wallet drag ratio | required gross move | T1 hit | hardCut | tokenWinRefundLose | MFE>=5 refundLose | MFE>=12 refundLose | MAE<=-5 within15 | MAE<=-10 preT1 | med worst MAE | med hardCut MAE | median hold | top exits |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ...rows.map((row) =>
      `| ${row.armName} | ${row.rows} | ${row.wins}/${row.losses} | ${formatSol(row.netSol)} | ` +
      `${formatSol(row.netSolTokenOnly)} | ${formatSol(row.refundAdjustedNetSol)} | ${formatSol(row.rentAdjustedNetSol)} | ` +
      `${row.edgePassRows}/${row.edgeFailRows}${row.edgeRows === 0 ? ' (n/a)' : ''} | ` +
      `${formatPct(row.medianEdgeCostRatio)} | ${formatPct(row.medianEdgeWalletDragRatio)} | ${formatPct(row.medianRequiredGrossMovePct)} | ` +
      `${row.t1Rows}/${row.rows} | ${row.hardCutRows} | ${row.tokenOnlyWinnerRefundLoserRows} | ` +
      `${row.mfe5RefundLoserRows} | ${row.mfe12RefundLoserRows} | ${row.mae5Within15Rows} | ${row.mae10BeforeT1Rows} | ` +
      `${formatPct(row.medianMaeWorstPct)} | ${formatPct(row.medianHardCutMaePct)} | ` +
      `${row.medianHoldSec == null ? 'n/a' : `${row.medianHoldSec.toFixed(0)}s`} | ` +
      `${row.topExitReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} |`
    ),
  ].join('\n');
}

function renderWinnerEntryPairingTable(rows: WinnerEntryPairingStats[]): string {
  if (rows.length === 0) return '_No winner-entry pairing rows._';
  return [
    '| arm | exit bucket | closes | W/L | net SOL | token-only SOL | refund-adjusted SOL | wallet-drag stress SOL | med MFE | med MAE | median hold |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.armName} | ${row.exitBucket} | ${row.rows} | ${row.wins}/${row.losses} | ` +
      `${formatSol(row.netSol)} | ${formatSol(row.netSolTokenOnly)} | ${formatSol(row.refundAdjustedNetSol)} | ` +
      `${formatSol(row.rentAdjustedNetSol)} | ${formatPct(row.medianMfePct)} | ${formatPct(row.medianMaePct)} | ` +
      `${row.medianHoldSec == null ? 'n/a' : `${row.medianHoldSec.toFixed(0)}s`} |`
    ),
  ].join('\n');
}

function renderWinnerEntryDiagnosticsTable(rows: WinnerEntryDiagnosticStats[]): string {
  if (rows.length === 0) return '_No winner-entry diagnostic rows._';
  return [
    '| arm | exit bucket | closes | med topup | med sellPressure30 | med anchor buy SOL | fresh topup | high-risk flags | unknown-quality flags |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.armName} | ${row.exitBucket} | ${row.rows} | ${formatPct(row.medianTopupStrength)} | ` +
      `${formatPct(row.medianSellPressure30)} | ${row.medianAnchorBuySol == null ? 'n/a' : row.medianAnchorBuySol.toFixed(4)} | ` +
      `${formatPct(row.freshTopupRate)} | ${formatPct(row.highRiskFlagRate)} | ${formatPct(row.unknownQualityRate)} |`
    ),
  ].join('\n');
}

function renderUnderfillEntryQualityTable(rows: UnderfillEntryQualityStats[]): string {
  if (rows.length === 0) return '_No underfill entry-quality rows._';
  const lines = [
    '| scope | rows | reference rows | favorable/unfavorable | median entry vs KOL fill | p75 entry vs KOL fill |',
    '|---|---:|---:|---:|---:|---:|',
  ];
  for (const row of rows) {
    lines.push([
      row.scope,
      row.rows,
      row.referenceRows,
      `${row.favorableRows}/${row.unfavorableRows}`,
      formatPct(row.medianEntryVsKolFillPct),
      formatPct(row.p75EntryVsKolFillPct),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  return lines.join('\n');
}

function renderEvidenceVerdicts(rows: EvidenceVerdict[]): string {
  if (rows.length === 0) return '_No rotation paper arm evidence yet._';
  return [
    '| arm | verdict | closes | min ok coverage | edge coverage | edge pass | refund-adjusted | wallet-drag stress | primary postCost | best primary | vs control | T+60 decay | reasons |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---|',
    ...rows.map((row) =>
      `| ${row.armName} | ${row.verdict} | ${row.closes}/${row.promotionRequiredCloses} | ` +
      `${formatPct(row.minOkCoverage)} | ${formatPct(row.edgeCoverage)} | ${formatPct(row.edgePassRate)} | ` +
      `${formatSol(row.refundAdjustedNetSol)} | ${formatSol(row.rentAdjustedNetSol)} | ` +
      `${row.primaryHorizonPostCost.map((item) => `T+${item.horizonSec}s ${formatPct(item.medianPostCostDeltaPct)}`).join(', ') || 'n/a'} | ` +
      `${row.primaryHorizonSec == null ? 'n/a' : `T+${row.primaryHorizonSec}s ${formatPct(row.primaryMedianPostCostDeltaPct)}`} | ` +
      `${formatPct(row.primaryBeatDeltaPct)} | ${formatPct(row.decayMedianPostCostDeltaPct)} | ${row.reasons.join('; ') || 'n/a'} |`
    ),
  ].join('\n');
}

function renderKolTransferPosteriorTable(report: RotationReport['kolTransferPosterior']): string {
  if (report.rows === 0 || report.topRotationFit.length === 0) {
    return `_No KOL transfer posterior rows. Run \`npm run kol:transfer-backfill\` first. Input: ${report.input}_`;
  }
  return [
    '| KOL | tier | role | style | tx | buy | sell | reentry | sell/buy | med buy SOL | med hold | quick sell | rotation | smart-v3 | net SOL flow |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.topRotationFit.map((row) =>
      `| ${row.kolId} | ${row.kolTier ?? '-'} | ${row.laneRole ?? '-'} | ${row.tradingStyle ?? '-'} | ` +
      `${row.txGroups} | ${row.buyCandidates} | ${row.sellCandidates} | ${formatPct(row.sameMintReentryRatio)} | ` +
      `${formatPct(row.sellToBuyRatio)} | ${row.medianBuySol == null ? 'n/a' : row.medianBuySol.toFixed(4)} | ` +
      `${row.medianHoldSec == null ? 'n/a' : `${row.medianHoldSec.toFixed(0)}s`} | ${formatPct(row.quickSellRatio)} | ` +
      `${row.rotationFitScore.toFixed(2)} | ${row.smartV3FitScore.toFixed(2)} | ${formatSol(row.netSolFlow)} |`
    ),
  ].join('\n');
}

function renderKolTransferCoverageTable(report: RotationReport['kolTransferPosterior']): string {
  if (report.coverageLoadStatus === 'load_failed') {
    return `_Coverage load failed for \`${report.kolDbPath ?? 'unknown'}\`: ${report.coverageLoadError ?? 'unknown error'}_`;
  }
  if (report.coverageLoadStatus === 'disabled') {
    return '_Coverage disabled. Pass `--kol-db data/kol/wallets.json` to enable._';
  }
  if (!report.coverageSummary) return '_Coverage unavailable._';
  const visibleCoverage = (report.coverage ?? [])
    .filter((row) => row.rotationCandidate || row.status !== 'ok')
    .slice(0, 30);
  return [
    `- active targets: ${report.coverageSummary.targets} · ok=${report.coverageSummary.ok} · stale=${report.coverageSummary.stale} · missing=${report.coverageSummary.missing}`,
    `- rotation candidates: ${report.coverageSummary.rotationTargets} · ok=${report.coverageSummary.rotationOk} · stale=${report.coverageSummary.rotationStale} · missing=${report.coverageSummary.rotationMissing}`,
    '',
    '| KOL | tier | role | style | rotation? | status | rows all | rows since | candidates since | last transfer | age h |',
    '|---|---|---|---|---:|---|---:|---:|---:|---|---:|',
    ...(visibleCoverage.length > 0
      ? visibleCoverage.map((row) => [
          row.kolId,
          row.kolTier ?? '-',
          row.laneRole ?? '-',
          row.tradingStyle ?? '-',
          row.rotationCandidate ? 'yes' : 'no',
          row.status,
          String(row.rowsAll),
          String(row.rowsSince),
          String(row.candidatesSince),
          row.lastTransferAt ?? '-',
          row.lastAgeHours == null ? '-' : row.lastAgeHours.toFixed(1),
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
      : ['| n/a | - | - | - | - | ok | 0 | 0 | 0 | - | - |']),
  ].join('\n');
}

function renderArmMarkouts(rows: ArmHorizonStats[]): string {
  if (rows.length === 0) return '_No rotation arm markout rows._';
  return rows.map((row) => [
    `### ${row.armName}`,
    '',
    '**After Buy**',
    renderStatsTable(row.afterBuy),
    '',
    '**After Sell**',
    renderStatsTable(row.afterSell),
  ].join('\n')).join('\n\n');
}

function renderReport(report: RotationReport): string {
  const reasons = report.noTrade.byReason.length === 0
    ? '_No no-trade rows._'
    : [
        '| reason | rows | ok | ok coverage | positive | postCost>0 | median | median postCostDelta |',
        '|---|---:|---:|---:|---:|---:|---:|---:|',
        ...report.noTrade.byReason.map((row) =>
          `| ${row.reason} | ${row.count} | ${row.okRows} | ` +
          `${row.count > 0 ? `${((row.okRows / row.count) * 100).toFixed(1)}%` : 'n/a'} | ` +
          `${row.positiveRows} | ${row.positivePostCostRows} | ` +
          `${formatPct(row.medianDeltaPct)} | ${formatPct(row.medianPostCostDeltaPct)} |`
        ),
      ].join('\n');
  const anchors = report.byAnchor.length === 0
    ? '_No anchor rows._'
    : [
        '| anchor | T+60 rows | ok | positive | postCost>0 | median T+60 | median postCostDelta T+60 |',
        '|---|---:|---:|---:|---:|---:|---:|',
        ...report.byAnchor.map((row) =>
          `| ${row.anchor} | ${row.rows} | ${row.okRows} | ${row.positive60s} | ${row.positivePostCost60s} | ` +
          `${formatPct(row.medianDeltaPct60s)} | ${formatPct(row.medianPostCostDeltaPct60s)} |`
        ),
      ].join('\n');
  const devQuality = report.byDevQuality.length === 0
    ? '_No dev-quality rows._'
    : [
        '| dev bucket | T+60 rows | ok | positive | postCost>0 | median T+60 | median postCostDelta T+60 |',
        '|---|---:|---:|---:|---:|---:|---:|',
        ...report.byDevQuality.map((row) =>
          `| ${row.bucket} | ${row.rows} | ${row.okRows} | ${row.positive60s} | ${row.positivePostCost60s} | ` +
          `${formatPct(row.medianDeltaPct60s)} | ${formatPct(row.medianPostCostDeltaPct60s)} |`
        ),
      ].join('\n');
  return [
    '# KOL Hunter Rotation Lane Report',
    '',
    `Generated: ${report.generatedAt}`,
    `Since: ${report.since}`,
    `Realtime dir: ${report.realtimeDir}`,
    `Horizons: ${report.horizonsSec.map((horizon) => `T+${horizon}s`).join(', ')}`,
    `Round-trip cost assumption: ${formatPct(report.roundTripCostPct)}`,
    `Paper refund-adjusted assumption: network ${formatSol(report.assumedNetworkFeeSol)} SOL is irreversible; ATA rent ${formatSol(report.assumedAtaRentSol)} SOL is recoverable wallet drag`,
    '',
    `Rotation trade markout rows: ${report.tradeMarkouts.rotationRows}/${report.tradeMarkouts.totalRows}`,
    `Rotation paper close rows: ${report.paperTrades.rotationRows}/${report.paperTrades.totalRows}`,
    `Rotation live close rows: ${report.liveTrades.rotationRows}/${report.liveTrades.totalRows}`,
    `Rotation no-trade probe rows: ${report.noTrade.probeRows}/${report.noTrade.totalRows}`,
    '',
    '## KOL Transfer Posterior — Rotation Fit',
    '> Diagnostic only. Transfer candidates are not precise swap PnL. Use signature drill-down before policy changes.',
    '',
    '### Coverage',
    renderKolTransferCoverageTable(report.kolTransferPosterior),
    '',
    '### Top Rotation Fit',
    renderKolTransferPosteriorTable(report.kolTransferPosterior),
    '',
    '## Paper Trades By Arm',
    renderPaperArmTable(report.paperTrades.byArm),
    '',
    '## Winner Entry Pairing',
    '> `winner_trailing_t1` is an exit state after T1 promotion, so this table checks which entry arms most often reach that exit bucket.',
    renderWinnerEntryPairingTable(report.paperTrades.winnerEntryPairings),
    '',
    '## Winner Entry Diagnostics',
    '> Splits winner vs non-winner exits by flow/risk features. This is report-only and must not be used as a live allowlist.',
    renderWinnerEntryDiagnosticsTable(report.paperTrades.winnerEntryDiagnostics),
    '',
    '## Underfill Entry Quality',
    '> Entry/KOL-fill diff is the canary equivalence check. Negative values mean our entry was below the S/A KOL weighted fill.',
    renderUnderfillEntryQualityTable(report.underfillEntryQuality),
    '',
    '## Live Trades By Arm',
    renderPaperArmTable(report.liveTrades.byArm),
    '',
    '## Evidence Verdict By Arm',
    renderEvidenceVerdicts(report.evidenceVerdicts),
    '',
    '## After Buy',
    renderStatsTable(report.tradeMarkouts.afterBuy),
    '',
    '## After Sell',
    renderStatsTable(report.tradeMarkouts.afterSell),
    '',
    '## After Sell — Final Close Only',
    renderStatsTable(report.tradeMarkouts.afterSellFinal),
    '',
    '## After Sell — Partial/Reduce Only',
    renderStatsTable(report.tradeMarkouts.afterSellPartial),
    '',
    '## After Sell — Hard Cut Cohort',
    renderStatsTable(report.tradeMarkouts.afterSellHardCut),
    '',
    '## After Sell — MAE Fast-Fail Cohort',
    renderStatsTable(report.tradeMarkouts.afterSellMaeFastFail),
    '',
    '## Markouts By Arm',
    renderArmMarkouts(report.tradeMarkouts.byArm),
    '',
    '## No-Trade Markouts',
    renderStatsTable(report.noTrade.byHorizon),
    '',
    '## No-Trade By Reason',
    reasons,
    '',
    '## Anchor T+60',
    anchors,
    '',
    '## Dev Quality T+60',
    '_Buckets are non-exclusive labels joined from token-quality observations and the paper-only dev candidate file._',
    devQuality,
    '',
  ].join('\n');
}

export async function buildRotationLaneReport(args: Args): Promise<RotationReport> {
  const paperTradesFileName = args.paperTradesFileName ?? ROTATION_PAPER_TRADES_FILE;
  const assumedAtaRentSol = args.assumedAtaRentSol ?? 0.00207408;
  const assumedNetworkFeeSol = args.assumedNetworkFeeSol ?? 0.000105;
  const kolTransferInput = args.kolTransferInput ?? path.resolve(process.cwd(), 'data/research', KOL_TRANSFER_INPUT_FILE);
  const [tradeMarkouts, missedAlpha, tokenQuality, projectedPaperTrades, projectedLiveTrades, kolTransferRows] = await Promise.all([
    readJsonl(path.join(args.realtimeDir, 'trade-markouts.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'missed-alpha.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'token-quality-observations.jsonl')),
    readJsonl(path.join(args.realtimeDir, paperTradesFileName)),
    readJsonl(path.join(args.realtimeDir, ROTATION_LIVE_TRADES_FILE)),
    readJsonl(kolTransferInput),
  ]);
  const paperTrades = projectedPaperTrades.length > 0 || paperTradesFileName !== ROTATION_PAPER_TRADES_FILE
    ? projectedPaperTrades
    : await readJsonl(path.join(args.realtimeDir, KOL_PAPER_TRADES_FILE));
  const candidateIndex = args.candidateFile
    ? await loadDevWalletCandidateIndex(args.candidateFile)
    : undefined;
  const qualityIndex = buildQualityIndex(tokenQuality);
  const recentTradeRows = tradeMarkouts.filter((row) => {
    const t = timeMs(row.recordedAt) || timeMs(row.firedAt);
    return Number.isFinite(t) && t >= args.sinceMs;
  });
  const rotationRows = recentTradeRows.filter(isRotationTradeMarkout);
  const rotationSellRows = rotationRows.filter((row) => str(row.anchorType) === 'sell');
  const recentPaperRows = paperTrades.filter((row) => {
    const t = timeMs(row.closedAt) || timeMs(row.exitTimeSec) || timeMs(row.entryTimeSec);
    return Number.isFinite(t) && t >= args.sinceMs;
  });
  const rotationPaperRows = recentPaperRows.filter(isRotationPaperTrade);
  const recentLiveRows = projectedLiveTrades.filter((row) => {
    const t = timeMs(row.closedAt) || timeMs(row.exitTimeSec) || timeMs(row.entryTimeSec);
    return Number.isFinite(t) && t >= args.sinceMs;
  });
  const rotationLiveRows = recentLiveRows.filter(isRotationPaperTrade);
  const recentNoTradeRows = missedAlpha.filter((row) => {
    const t = timeMs(probe(row).firedAt) || timeMs(row.rejectedAt);
    return Number.isFinite(t) && t >= args.sinceMs && isRotationNoTrade(row);
  });
  const noTradeProbeRows = recentNoTradeRows.filter((row) => (rowHorizon(row) ?? 0) > 0);
  const armMarkouts = buildArmHorizonStats(rotationRows, args.horizonsSec, args.roundTripCostPct);
  const paperArmStats = buildPaperArmStats(rotationPaperRows, assumedAtaRentSol, assumedNetworkFeeSol);
  const winnerEntryPairings = buildWinnerEntryPairingStats(rotationPaperRows, assumedAtaRentSol, assumedNetworkFeeSol);
  const winnerEntryDiagnostics = buildWinnerEntryDiagnosticStats(rotationPaperRows);
  const coverageLoad: {
    status: KolPosteriorCoverageLoadStatus;
    targets: KolPosteriorCoverageTarget[];
    error?: string;
  } = args.kolDbPath
    ? await loadKolPosteriorCoverageTargetsWithStatus(args.kolDbPath)
    : { status: 'disabled', targets: [] };
  const kolTransferPosterior = buildKolTransferPosteriorReport(kolTransferRows as unknown as KolTransferRow[], {
    input: kolTransferInput,
    kolDbPath: args.kolDbPath,
    sinceSec: Math.floor(args.sinceMs / 1000),
    coverageTargets: coverageLoad.status === 'loaded' ? coverageLoad.targets : undefined,
    coverageLoadStatus: coverageLoad.status,
    coverageLoadError: coverageLoad.error,
  });
  return {
    generatedAt: new Date().toISOString(),
    realtimeDir: args.realtimeDir,
    since: new Date(args.sinceMs).toISOString(),
    horizonsSec: args.horizonsSec,
    roundTripCostPct: args.roundTripCostPct,
    assumedAtaRentSol,
    assumedNetworkFeeSol,
    tradeMarkouts: {
      totalRows: recentTradeRows.length,
      rotationRows: rotationRows.length,
      afterBuy: summarize(rotationRows.filter((row) => str(row.anchorType) === 'buy'), args.horizonsSec, args.roundTripCostPct),
      afterSell: summarize(rotationSellRows, args.horizonsSec, args.roundTripCostPct),
      afterSellFinal: summarize(rotationSellRows.filter(isFinalSellMarkout), args.horizonsSec, args.roundTripCostPct),
      afterSellPartial: summarize(rotationSellRows.filter(isPartialSellMarkout), args.horizonsSec, args.roundTripCostPct),
      afterSellHardCut: summarize(rotationSellRows.filter(isHardCutSellMarkout), args.horizonsSec, args.roundTripCostPct),
      afterSellMaeFastFail: summarize(rotationSellRows.filter(isMaeFastFailSellMarkout), args.horizonsSec, args.roundTripCostPct),
      byArm: armMarkouts,
    },
    paperTrades: {
      totalRows: recentPaperRows.length,
      rotationRows: rotationPaperRows.length,
      byArm: paperArmStats,
      winnerEntryPairings,
      winnerEntryDiagnostics,
    },
    liveTrades: {
      totalRows: recentLiveRows.length,
      rotationRows: rotationLiveRows.length,
      byArm: buildPaperArmStats(rotationLiveRows, assumedAtaRentSol, assumedNetworkFeeSol),
    },
    underfillEntryQuality: [
      buildUnderfillEntryQualityStats('paper', rotationPaperRows),
      buildUnderfillEntryQualityStats('live', rotationLiveRows),
    ],
    evidenceVerdicts: buildEvidenceVerdicts(paperArmStats, armMarkouts),
    noTrade: {
      totalRows: recentNoTradeRows.length,
      probeRows: noTradeProbeRows.length,
      byHorizon: summarize(noTradeProbeRows, args.horizonsSec, args.roundTripCostPct),
      byReason: buildReasonStats(noTradeProbeRows, args.roundTripCostPct),
    },
    byAnchor: buildAnchorStats(rotationRows.filter((row) => str(row.anchorType) === 'buy'), args.roundTripCostPct),
    byDevQuality: buildDevQualityStats(
      rotationRows.filter((row) => str(row.anchorType) === 'buy'),
      qualityIndex,
      candidateIndex,
      args.roundTripCostPct
    ),
    kolTransferPosterior: {
      input: kolTransferInput,
      kolDbPath: kolTransferPosterior.kolDbPath,
      coverageLoadStatus: kolTransferPosterior.coverageLoadStatus,
      coverageLoadError: kolTransferPosterior.coverageLoadError,
      rows: kolTransferPosterior.rows,
      candidates: kolTransferPosterior.candidates,
      coverageSummary: kolTransferPosterior.coverageSummary,
      coverage: kolTransferPosterior.coverage,
      topRotationFit: kolTransferPosterior.metrics
        .slice()
        .sort((a, b) => b.rotationFitScore - a.rotationFitScore || b.buyCandidates - a.buyCandidates)
        .slice(0, 12),
    },
  };
}

export function renderRotationLaneReportMarkdown(report: RotationReport): string {
  return renderReport(report);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildRotationLaneReport(args);
  const markdown = renderReport(report);
  if (args.mdOut) {
    await mkdir(path.dirname(args.mdOut), { recursive: true });
    await writeFile(args.mdOut, markdown, 'utf8');
  }
  if (args.jsonOut) {
    await mkdir(path.dirname(args.jsonOut), { recursive: true });
    await writeFile(args.jsonOut, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  if (!args.mdOut && !args.jsonOut) process.stdout.write(markdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
