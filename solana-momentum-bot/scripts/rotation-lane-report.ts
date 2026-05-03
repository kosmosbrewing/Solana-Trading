#!/usr/bin/env ts-node
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import {
  DEFAULT_DEV_WALLET_CANDIDATE_PATH,
  loadDevWalletCandidateIndex,
  lookupDevWalletCandidate,
  type DevWalletCandidateIndex,
} from '../src/observability/devWalletCandidateRegistry';

const ROTATION_PAPER_TRADES_FILE = 'rotation-v1-paper-trades.jsonl';
const KOL_PAPER_TRADES_FILE = 'kol-paper-trades.jsonl';
const EVIDENCE_MIN_CLOSES = 50;
const EVIDENCE_PROMOTION_MIN_CLOSES = 100;
const EVIDENCE_MIN_OK_COVERAGE = 0.8;
const EVIDENCE_MIN_EDGE_COVERAGE = 0.8;
const EVIDENCE_MIN_EDGE_PASS_RATE = 0.5;
const EVIDENCE_VERDICT_HORIZON_SEC = 60;
const EVIDENCE_REQUIRED_COVERAGE_HORIZONS_SEC = [15, 30, 60];
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
  rentAdjustedNetSol: number;
  edgeRows: number;
  edgePassRows: number;
  edgeFailRows: number;
  medianEdgeCostRatio: number | null;
  medianRequiredGrossMovePct: number | null;
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

interface EvidenceVerdict {
  armName: string;
  verdict: EvidenceVerdictStatus;
  reasons: string[];
  closes: number;
  minRequiredCloses: number;
  promotionRequiredCloses: number;
  minOkCoverage: number | null;
  requiredHorizonCoverage: Array<{ horizonSec: number; okCoverage: number | null }>;
  t60MedianPostCostDeltaPct: number | null;
  controlT60MedianPostCostDeltaPct: number | null;
  controlBeatDeltaPct: number | null;
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
    byArm: ArmHorizonStats[];
  };
  paperTrades: {
    totalRows: number;
    rotationRows: number;
    byArm: PaperArmStats[];
  };
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
  return str(row.armName) ||
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
    reason === 'rotation_flow_residual_timeout' ||
    reason === 'quick_reject_classifier_exit';
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
        .map((edge) => num(edge.costRatio))
        .filter((value): value is number => value != null && Number.isFinite(value));
      const edgeRequiredMoves = edgeRows
        .map((edge) => num(edge.requiredGrossMovePct))
        .filter((value): value is number => value != null && Number.isFinite(value));
      const netSol = netSolValues.reduce((sum, value) => sum + value, 0);
      const netSolTokenOnly = tokenOnlyValues.reduce((sum, value) => sum + value, 0);
      return {
        armName,
        rows: scoped.length,
        wins: netSolValues.filter((value) => value > 0).length,
        losses: netSolValues.filter((value) => value <= 0).length,
        netSol,
        netSolTokenOnly,
        rentAdjustedNetSol: tokenOnlyValues
          .map((value) => value - assumedWalletDragSol)
          .reduce((sum, value) => sum + value, 0),
        edgeRows: edgeRows.length,
        edgePassRows: edgeRows.filter((edge) => boolValue(edge.pass) === true).length,
        edgeFailRows: edgeRows.filter((edge) => boolValue(edge.pass) === false).length,
        medianEdgeCostRatio: percentile(edgeCostRatios, 0.5),
        medianRequiredGrossMovePct: percentile(edgeRequiredMoves, 0.5),
        medianHoldSec: percentile(holdSec, 0.5),
        topExitReasons: buildTopExitReasons(scoped),
      };
    })
    .sort((a, b) => b.rows - a.rows || b.netSolTokenOnly - a.netSolTokenOnly || a.armName.localeCompare(b.armName));
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

function armVerdictHorizon(markout: ArmHorizonStats | undefined): HorizonStats | null {
  return markout?.afterBuy.find((row) => row.horizonSec === EVIDENCE_VERDICT_HORIZON_SEC) ?? null;
}

function buildEvidenceVerdicts(
  paperArms: PaperArmStats[],
  armMarkouts: ArmHorizonStats[]
): EvidenceVerdict[] {
  const markoutsByArm = new Map(armMarkouts.map((row) => [row.armName, row]));
  const controlT60MedianPostCostDeltaPct =
    armVerdictHorizon(markoutsByArm.get(ROTATION_CONTROL_ARM))?.medianPostCostDeltaPct ?? null;
  return paperArms.map((arm) => {
    const markout = markoutsByArm.get(arm.armName);
    const coverageRows = requiredHorizonCoverage(markout);
    const minOkCoverage = minRequiredOkCoverage(coverageRows);
    const t60 = armVerdictHorizon(markout);
    const controlBeatDeltaPct = t60?.medianPostCostDeltaPct != null && controlT60MedianPostCostDeltaPct != null
      ? t60.medianPostCostDeltaPct - controlT60MedianPostCostDeltaPct
      : null;
    const edgeCoverage = arm.rows > 0 ? arm.edgeRows / arm.rows : null;
    const edgePassRate = arm.edgeRows > 0 ? arm.edgePassRows / arm.edgeRows : null;
    const reasons: string[] = [];
    let verdict: EvidenceVerdictStatus = 'PROMOTION_CANDIDATE';

    if (arm.rows < EVIDENCE_MIN_CLOSES) {
      verdict = 'COLLECT';
      reasons.push(`sample ${arm.rows}/${EVIDENCE_MIN_CLOSES}`);
    } else if (
      minOkCoverage == null ||
      minOkCoverage < EVIDENCE_MIN_OK_COVERAGE ||
      t60 == null ||
      t60.rows === 0 ||
      edgeCoverage == null ||
      edgeCoverage < EVIDENCE_MIN_EDGE_COVERAGE
    ) {
      verdict = 'DATA_GAP';
      reasons.push(...verdictCoverageReasons(coverageRows));
      if (minOkCoverage == null || minOkCoverage < EVIDENCE_MIN_OK_COVERAGE) {
        reasons.push(`min ${verdictReasonCoverage(minOkCoverage)}`);
      }
      if (t60 == null || t60.rows === 0) reasons.push(`T+${EVIDENCE_VERDICT_HORIZON_SEC}s markout missing`);
      if (edgeCoverage == null || edgeCoverage < EVIDENCE_MIN_EDGE_COVERAGE) {
        reasons.push(`edge coverage ${formatPct(edgeCoverage)} < ${formatPct(EVIDENCE_MIN_EDGE_COVERAGE)}`);
      }
    } else if (edgePassRate == null || edgePassRate < EVIDENCE_MIN_EDGE_PASS_RATE || arm.rentAdjustedNetSol <= 0) {
      verdict = 'COST_REJECT';
      if (edgePassRate == null) reasons.push('edge shadow rows missing');
      else if (edgePassRate < EVIDENCE_MIN_EDGE_PASS_RATE) {
        reasons.push(`edge pass ${formatPct(edgePassRate)} < ${formatPct(EVIDENCE_MIN_EDGE_PASS_RATE)}`);
      }
      if (arm.rentAdjustedNetSol <= 0) reasons.push(`rent stress ${formatSol(arm.rentAdjustedNetSol)} <= 0`);
    } else if (t60.medianPostCostDeltaPct == null || t60.medianPostCostDeltaPct <= 0) {
      verdict = 'POST_COST_REJECT';
      reasons.push(`T+${EVIDENCE_VERDICT_HORIZON_SEC}s median postCost ${formatPct(t60.medianPostCostDeltaPct)} <= 0`);
    } else if (arm.armName !== ROTATION_CONTROL_ARM && controlT60MedianPostCostDeltaPct == null) {
      verdict = 'WATCH';
      reasons.push('control T+60 baseline missing');
    } else if (arm.armName !== ROTATION_CONTROL_ARM && controlBeatDeltaPct != null && controlBeatDeltaPct <= 0) {
      verdict = 'POST_COST_REJECT';
      reasons.push(`T+${EVIDENCE_VERDICT_HORIZON_SEC}s postCost ${formatPct(t60.medianPostCostDeltaPct)} <= control ${formatPct(controlT60MedianPostCostDeltaPct)}`);
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
      t60MedianPostCostDeltaPct: t60?.medianPostCostDeltaPct ?? null,
      controlT60MedianPostCostDeltaPct: arm.armName === ROTATION_CONTROL_ARM ? null : controlT60MedianPostCostDeltaPct,
      controlBeatDeltaPct: arm.armName === ROTATION_CONTROL_ARM ? null : controlBeatDeltaPct,
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
    '| arm | closes | W/L | net SOL | token-only SOL | rent-adjusted stress SOL | edge pass/fail | median cost ratio | required gross move | median hold | top exits |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ...rows.map((row) =>
      `| ${row.armName} | ${row.rows} | ${row.wins}/${row.losses} | ${formatSol(row.netSol)} | ` +
      `${formatSol(row.netSolTokenOnly)} | ${formatSol(row.rentAdjustedNetSol)} | ` +
      `${row.edgePassRows}/${row.edgeFailRows}${row.edgeRows === 0 ? ' (n/a)' : ''} | ` +
      `${formatPct(row.medianEdgeCostRatio)} | ${formatPct(row.medianRequiredGrossMovePct)} | ` +
      `${row.medianHoldSec == null ? 'n/a' : `${row.medianHoldSec.toFixed(0)}s`} | ` +
      `${row.topExitReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} |`
    ),
  ].join('\n');
}

function renderEvidenceVerdicts(rows: EvidenceVerdict[]): string {
  if (rows.length === 0) return '_No rotation paper arm evidence yet._';
  return [
    '| arm | verdict | closes | min ok coverage | edge coverage | edge pass | rent stress | T+60 median postCost | vs control | reasons |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
    ...rows.map((row) =>
      `| ${row.armName} | ${row.verdict} | ${row.closes}/${row.promotionRequiredCloses} | ` +
      `${formatPct(row.minOkCoverage)} | ${formatPct(row.edgeCoverage)} | ${formatPct(row.edgePassRate)} | ${formatSol(row.rentAdjustedNetSol)} | ` +
      `${formatPct(row.t60MedianPostCostDeltaPct)} | ${formatPct(row.controlBeatDeltaPct)} | ${row.reasons.join('; ') || 'n/a'} |`
    ),
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
    `Paper wallet-drag stress assumption: ATA rent ${formatSol(report.assumedAtaRentSol)} SOL + network ${formatSol(report.assumedNetworkFeeSol)} SOL`,
    '',
    `Rotation trade markout rows: ${report.tradeMarkouts.rotationRows}/${report.tradeMarkouts.totalRows}`,
    `Rotation paper close rows: ${report.paperTrades.rotationRows}/${report.paperTrades.totalRows}`,
    `Rotation no-trade probe rows: ${report.noTrade.probeRows}/${report.noTrade.totalRows}`,
    '',
    '## Paper Trades By Arm',
    renderPaperArmTable(report.paperTrades.byArm),
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
  const [tradeMarkouts, missedAlpha, tokenQuality, projectedPaperTrades] = await Promise.all([
    readJsonl(path.join(args.realtimeDir, 'trade-markouts.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'missed-alpha.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'token-quality-observations.jsonl')),
    readJsonl(path.join(args.realtimeDir, paperTradesFileName)),
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
  const recentNoTradeRows = missedAlpha.filter((row) => {
    const t = timeMs(probe(row).firedAt) || timeMs(row.rejectedAt);
    return Number.isFinite(t) && t >= args.sinceMs && isRotationNoTrade(row);
  });
  const noTradeProbeRows = recentNoTradeRows.filter((row) => (rowHorizon(row) ?? 0) > 0);
  const armMarkouts = buildArmHorizonStats(rotationRows, args.horizonsSec, args.roundTripCostPct);
  const paperArmStats = buildPaperArmStats(rotationPaperRows, assumedAtaRentSol, assumedNetworkFeeSol);
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
      byArm: armMarkouts,
    },
    paperTrades: {
      totalRows: recentPaperRows.length,
      rotationRows: rotationPaperRows.length,
      byArm: paperArmStats,
    },
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
