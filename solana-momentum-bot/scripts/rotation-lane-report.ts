#!/usr/bin/env ts-node
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import {
  DEFAULT_DEV_WALLET_CANDIDATE_PATH,
  loadDevWalletCandidateIndex,
  lookupDevWalletCandidate,
  type DevWalletCandidateIndex,
} from '../src/observability/devWalletCandidateRegistry';

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
  medianHoldSec: number | null;
  topExitReasons: Array<{ reason: string; count: number }>;
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
    byArm: ArmHorizonStats[];
  };
  paperTrades: {
    totalRows: number;
    rotationRows: number;
    byArm: PaperArmStats[];
  };
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
    paperTradesFileName: 'kol-paper-trades.jsonl',
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
        medianHoldSec: percentile(holdSec, 0.5),
        topExitReasons: buildTopExitReasons(scoped),
      };
    })
    .sort((a, b) => b.rows - a.rows || b.netSolTokenOnly - a.netSolTokenOnly || a.armName.localeCompare(b.armName));
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
    '| arm | closes | W/L | net SOL | token-only SOL | rent-adjusted stress SOL | median hold | top exits |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
    ...rows.map((row) =>
      `| ${row.armName} | ${row.rows} | ${row.wins}/${row.losses} | ${formatSol(row.netSol)} | ` +
      `${formatSol(row.netSolTokenOnly)} | ${formatSol(row.rentAdjustedNetSol)} | ` +
      `${row.medianHoldSec == null ? 'n/a' : `${row.medianHoldSec.toFixed(0)}s`} | ` +
      `${row.topExitReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} |`
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
    '## After Buy',
    renderStatsTable(report.tradeMarkouts.afterBuy),
    '',
    '## After Sell',
    renderStatsTable(report.tradeMarkouts.afterSell),
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
  const paperTradesFileName = args.paperTradesFileName ?? 'kol-paper-trades.jsonl';
  const assumedAtaRentSol = args.assumedAtaRentSol ?? 0.00207408;
  const assumedNetworkFeeSol = args.assumedNetworkFeeSol ?? 0.000105;
  const [tradeMarkouts, missedAlpha, tokenQuality, paperTrades] = await Promise.all([
    readJsonl(path.join(args.realtimeDir, 'trade-markouts.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'missed-alpha.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'token-quality-observations.jsonl')),
    readJsonl(path.join(args.realtimeDir, paperTradesFileName)),
  ]);
  const candidateIndex = args.candidateFile
    ? await loadDevWalletCandidateIndex(args.candidateFile)
    : undefined;
  const qualityIndex = buildQualityIndex(tokenQuality);
  const recentTradeRows = tradeMarkouts.filter((row) => {
    const t = timeMs(row.recordedAt) || timeMs(row.firedAt);
    return Number.isFinite(t) && t >= args.sinceMs;
  });
  const rotationRows = recentTradeRows.filter(isRotationTradeMarkout);
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
      afterSell: summarize(rotationRows.filter((row) => str(row.anchorType) === 'sell'), args.horizonsSec, args.roundTripCostPct),
      byArm: buildArmHorizonStats(rotationRows, args.horizonsSec, args.roundTripCostPct),
    },
    paperTrades: {
      totalRows: recentPaperRows.length,
      rotationRows: rotationPaperRows.length,
      byArm: buildPaperArmStats(rotationPaperRows, assumedAtaRentSol, assumedNetworkFeeSol),
    },
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
