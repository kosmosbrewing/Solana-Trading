/**
 * KOL Transfer Posterior Report (2026-05-05).
 *
 * Input: data/research/kol-transfers.jsonl from kol-transfer-backfill.
 * 목적: getTransfersByAddress transfer rows 를 signature 단위 후보 거래로 재구성해
 *       smart-v3 / rotation lane 의 KOL 행동 prior 입력을 만든다.
 *
 * 주의:
 *   - transfer 기반 후보라 precise PnL/route 는 아니다.
 *   - live policy 에 연결하지 않는 diagnostic report 다.
 *   - 중요한 signature 만 후속 gTFA drill-down 으로 검증한다.
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111111';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_INPUT = 'kol-transfers.jsonl';

interface Args {
  input: string;
  kolDbPath?: string;
  sinceSec?: number;
  mdOut?: string;
  jsonOut?: string;
}

type WalletDirection = 'in' | 'out' | 'self' | 'unknown';
type CandidateSide = 'buy' | 'sell' | 'transfer_only' | 'ambiguous';

interface TransferLike {
  signature: string;
  blockTime?: number;
  slot: number;
  type: string;
  mint: string;
  uiAmount: string;
  amount: string;
  instructionIdx?: number;
  innerInstructionIdx?: number;
}

export interface KolTransferRow {
  schemaVersion?: string;
  kolId: string;
  kolAddress: string;
  kolTier?: string;
  laneRole?: string;
  tradingStyle?: string;
  walletDirection: WalletDirection;
  eventId?: string;
  transfer: TransferLike;
}

export interface KolPosteriorCoverageTarget {
  kolId: string;
  kolAddress: string;
  kolTier?: string;
  laneRole?: string;
  tradingStyle?: string;
}

export interface TradeCandidate {
  kolId: string;
  kolAddress: string;
  signature: string;
  blockTime?: number;
  side: CandidateSide;
  tokenMints: string[];
  solIn: number;
  solOut: number;
  nonSolInCount: number;
  nonSolOutCount: number;
  transferCount: number;
}

export interface KolPosteriorMetrics {
  kolId: string;
  kolAddress: string;
  kolTier?: string;
  laneRole?: string;
  tradingStyle?: string;
  txGroups: number;
  buyCandidates: number;
  sellCandidates: number;
  ambiguousCandidates: number;
  uniqueBuyMints: number;
  sameMintReentryRatio: number | null;
  sellToBuyRatio: number | null;
  medianBuySol: number | null;
  avgBuySol: number | null;
  netSolFlow: number;
  matchedHoldSamples: number;
  medianHoldSec: number | null;
  quickSellRatio: number | null;
  multiSellMintRatio: number | null;
  rotationFitScore: number;
  smartV3FitScore: number;
}

export type KolPosteriorCoverageStatus = 'ok' | 'stale' | 'missing';

export interface KolPosteriorCoverage {
  kolId: string;
  kolAddress: string;
  kolTier?: string;
  laneRole?: string;
  tradingStyle?: string;
  rotationCandidate: boolean;
  status: KolPosteriorCoverageStatus;
  rowsAll: number;
  rowsSince: number;
  candidatesSince: number;
  firstTransferAt?: string;
  lastTransferAt?: string;
  firstSinceAt?: string;
  lastSinceAt?: string;
  lastAgeHours: number | null;
}

export interface KolPosteriorCoverageSummary {
  targets: number;
  ok: number;
  stale: number;
  missing: number;
  rotationTargets: number;
  rotationOk: number;
  rotationStale: number;
  rotationMissing: number;
}

export type KolPosteriorCoverageLoadStatus = 'disabled' | 'loaded' | 'load_failed';

export interface KolPosteriorCoverageTargetLoadResult {
  status: Exclude<KolPosteriorCoverageLoadStatus, 'disabled'>;
  targets: KolPosteriorCoverageTarget[];
  error?: string;
}

export interface KolTransferPosteriorReport {
  generatedAt: string;
  input: string;
  kolDbPath?: string;
  coverageLoadStatus?: KolPosteriorCoverageLoadStatus;
  coverageLoadError?: string;
  since?: string;
  rows: number;
  candidates: number;
  metrics: KolPosteriorMetrics[];
  coverageSummary?: KolPosteriorCoverageSummary;
  coverage?: KolPosteriorCoverage[];
}

export function parseArgs(argv: string[], nowSec = Math.floor(Date.now() / 1000)): Args {
  const args: Args = {
    input: path.resolve(process.cwd(), 'data/research', DEFAULT_INPUT),
    kolDbPath: path.resolve(process.cwd(), 'data/kol/wallets.json'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') args.input = path.resolve(requireValue(argv[++i], arg));
    else if (arg === '--research-dir') args.input = path.resolve(requireValue(argv[++i], arg), DEFAULT_INPUT);
    else if (arg === '--kol-db') args.kolDbPath = path.resolve(requireValue(argv[++i], arg));
    else if (arg === '--no-coverage') args.kolDbPath = undefined;
    else if (arg === '--since') args.sinceSec = nowSec - parseDurationSec(requireValue(argv[++i], arg));
    else if (arg === '--since-unix') args.sinceSec = parsePositiveInt(requireValue(argv[++i], arg), arg);
    else if (arg === '--md') args.mdOut = path.resolve(requireValue(argv[++i], arg));
    else if (arg === '--json') args.jsonOut = path.resolve(requireValue(argv[++i], arg));
  }
  return args;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseDurationSec(input: string): number {
  const m = input.match(/^(\d+)([mhd])$/);
  if (!m) throw new Error(`invalid duration '${input}', expected 30m/12h/30d`);
  const n = Number(m[1]);
  if (m[2] === 'm') return n * 60;
  if (m[2] === 'h') return n * 60 * 60;
  return n * 24 * 60 * 60;
}

function parsePositiveInt(input: string, flag: string): number {
  const n = Number(input);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const raw = await readFile(file, 'utf8');
    return raw.split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export async function loadKolPosteriorCoverageTargets(kolDbPath: string): Promise<KolPosteriorCoverageTarget[]> {
  return (await loadKolPosteriorCoverageTargetsWithStatus(kolDbPath)).targets;
}

export async function loadKolPosteriorCoverageTargetsWithStatus(kolDbPath: string): Promise<KolPosteriorCoverageTargetLoadResult> {
  try {
    const raw = JSON.parse(await readFile(kolDbPath, 'utf8')) as {
      kols?: Array<{
        id?: string;
        addresses?: string[];
        tier?: string;
        is_active?: boolean;
        lane_role?: string;
        trading_style?: string;
      }>;
    };
    const out: KolPosteriorCoverageTarget[] = [];
    for (const kol of Array.isArray(raw.kols) ? raw.kols : []) {
      if (kol.is_active === false) continue;
      for (const address of Array.isArray(kol.addresses) ? kol.addresses : []) {
        if (typeof address !== 'string' || address.length === 0) continue;
        out.push({
          kolId: kol.id ?? address.slice(0, 8),
          kolAddress: address,
          kolTier: kol.tier,
          laneRole: kol.lane_role,
          tradingStyle: kol.trading_style,
        });
      }
    }
    return { status: 'loaded', targets: out };
  } catch (error) {
    return {
      status: 'load_failed',
      targets: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isSolMint(mint: string): boolean {
  return mint === NATIVE_SOL_MINT || mint === WSOL_MINT;
}

function uiAmountToNumber(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function buildTradeCandidates(rows: KolTransferRow[]): TradeCandidate[] {
  const groups = new Map<string, KolTransferRow[]>();
  for (const row of dedupeTransferRows(rows)) {
    const sig = row.transfer?.signature;
    if (!sig || !row.kolId || !row.kolAddress) continue;
    const key = `${row.kolId}:${row.kolAddress}:${sig}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const out: TradeCandidate[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    const solIn = sumSol(group, 'in');
    const solOut = sumSol(group, 'out');
    const nonSolIn = group.filter((r) => r.walletDirection === 'in' && !isSolMint(r.transfer.mint));
    const nonSolOut = group.filter((r) => r.walletDirection === 'out' && !isSolMint(r.transfer.mint));
    const tokenMints = [...new Set([...nonSolIn, ...nonSolOut].map((r) => r.transfer.mint))];
    const side = classifyCandidateSide({ solIn, solOut, nonSolInCount: nonSolIn.length, nonSolOutCount: nonSolOut.length });
    out.push({
      kolId: first.kolId,
      kolAddress: first.kolAddress,
      signature: first.transfer.signature,
      blockTime: first.transfer.blockTime,
      side,
      tokenMints,
      solIn,
      solOut,
      nonSolInCount: nonSolIn.length,
      nonSolOutCount: nonSolOut.length,
      transferCount: group.length,
    });
  }
  return out.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
}

function dedupeTransferRows(rows: KolTransferRow[]): KolTransferRow[] {
  const seen = new Set<string>();
  const out: KolTransferRow[] = [];
  for (const row of rows) {
    const key = row.eventId || [
      row.kolId,
      row.kolAddress,
      row.walletDirection,
      row.transfer?.signature,
      row.transfer?.instructionIdx ?? 'ix',
      row.transfer?.innerInstructionIdx ?? 'inner',
      row.transfer?.mint,
      row.transfer?.amount,
    ].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function sumSol(group: KolTransferRow[], direction: WalletDirection): number {
  return group
    .filter((r) => r.walletDirection === direction && isSolMint(r.transfer.mint))
    .reduce((sum, r) => sum + uiAmountToNumber(r.transfer.uiAmount), 0);
}

function classifyCandidateSide(input: {
  solIn: number;
  solOut: number;
  nonSolInCount: number;
  nonSolOutCount: number;
}): CandidateSide {
  const buyLike = input.solOut > 0 && input.nonSolInCount > 0;
  const sellLike = input.solIn > 0 && input.nonSolOutCount > 0;
  if (buyLike && sellLike) return 'ambiguous';
  if (buyLike) return 'buy';
  if (sellLike) return 'sell';
  return 'transfer_only';
}

export function computeKolPosteriorMetrics(rows: KolTransferRow[], candidates: TradeCandidate[]): KolPosteriorMetrics[] {
  const byKol = new Map<string, TradeCandidate[]>();
  for (const c of candidates) {
    const key = `${c.kolId}:${c.kolAddress}`;
    const list = byKol.get(key) ?? [];
    list.push(c);
    byKol.set(key, list);
  }
  const metaByKey = new Map<string, KolTransferRow>();
  for (const row of rows) {
    metaByKey.set(`${row.kolId}:${row.kolAddress}`, row);
  }

  return Array.from(byKol.entries()).map(([key, list]) => {
    const [kolId, kolAddress] = key.split(':');
    const meta = metaByKey.get(key);
    const buys = list.filter((c) => c.side === 'buy');
    const sells = list.filter((c) => c.side === 'sell');
    const ambiguous = list.filter((c) => c.side === 'ambiguous');
    const buySol = buys.map((c) => c.solOut).filter((v) => v > 0).sort((a, b) => a - b);
    const buyMintCounts = countMints(buys);
    const sellMintCounts = countMints(sells);
    const uniqueBuyMints = buyMintCounts.size;
    const reentryMints = Array.from(buyMintCounts.values()).filter((n) => n >= 2).length;
    const multiSellMints = Array.from(sellMintCounts.values()).filter((n) => n >= 2).length;
    const holdSamples = computeHoldSamplesSec(buys, sells);
    const quickSells = holdSamples.filter((sec) => sec <= 300).length;
    const medianHoldSec = median(holdSamples);
    const quickSellRatio = holdSamples.length > 0 ? quickSells / holdSamples.length : null;
    const sameMintReentryRatio = uniqueBuyMints > 0 ? reentryMints / uniqueBuyMints : null;
    const sellToBuyRatio = buys.length > 0 ? sells.length / buys.length : null;
    const multiSellMintRatio = sellMintCounts.size > 0 ? multiSellMints / sellMintCounts.size : null;
    const medianBuySol = median(buySol);
    const avgBuySol = buySol.length > 0 ? buySol.reduce((s, x) => s + x, 0) / buySol.length : null;
    const netSolFlow = list.reduce((sum, c) => sum + c.solIn - c.solOut, 0);
    const metrics: KolPosteriorMetrics = {
      kolId,
      kolAddress,
      kolTier: meta?.kolTier,
      laneRole: meta?.laneRole,
      tradingStyle: meta?.tradingStyle,
      txGroups: list.length,
      buyCandidates: buys.length,
      sellCandidates: sells.length,
      ambiguousCandidates: ambiguous.length,
      uniqueBuyMints,
      sameMintReentryRatio,
      sellToBuyRatio,
      medianBuySol,
      avgBuySol,
      netSolFlow,
      matchedHoldSamples: holdSamples.length,
      medianHoldSec,
      quickSellRatio,
      multiSellMintRatio,
      rotationFitScore: scoreRotationFit({
        buyCandidates: buys.length,
        quickSellRatio,
        sameMintReentryRatio,
        medianBuySol,
        sellToBuyRatio,
      }),
      smartV3FitScore: scoreSmartV3Fit({
        buyCandidates: buys.length,
        quickSellRatio,
        medianHoldSec,
        medianBuySol,
        sellToBuyRatio,
      }),
    };
    return metrics;
  }).sort((a, b) => b.rotationFitScore - a.rotationFitScore || b.buyCandidates - a.buyCandidates);
}

function countMints(candidates: TradeCandidate[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of candidates) {
    for (const mint of c.tokenMints) out.set(mint, (out.get(mint) ?? 0) + 1);
  }
  return out;
}

function computeHoldSamplesSec(buys: TradeCandidate[], sells: TradeCandidate[]): number[] {
  const out: number[] = [];
  for (const buy of buys) {
    if (buy.blockTime == null) continue;
    const sell = sells.find((candidate) => {
      if (candidate.blockTime == null || candidate.blockTime <= buy.blockTime!) return false;
      return candidate.tokenMints.some((mint) => buy.tokenMints.includes(mint));
    });
    if (sell?.blockTime != null) out.push(sell.blockTime - buy.blockTime);
  }
  return out.sort((a, b) => a - b);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

function scoreRotationFit(input: {
  buyCandidates: number;
  quickSellRatio: number | null;
  sameMintReentryRatio: number | null;
  medianBuySol: number | null;
  sellToBuyRatio: number | null;
}): number {
  let score = 0;
  if (input.buyCandidates >= 10) score += 0.25;
  if ((input.quickSellRatio ?? 0) >= 0.5) score += 0.25;
  if ((input.sameMintReentryRatio ?? 0) >= 0.15) score += 0.2;
  if (input.medianBuySol != null && input.medianBuySol <= 3) score += 0.15;
  if (input.sellToBuyRatio != null && input.sellToBuyRatio >= 0.4 && input.sellToBuyRatio <= 1.5) score += 0.15;
  return round(score);
}

function scoreSmartV3Fit(input: {
  buyCandidates: number;
  quickSellRatio: number | null;
  medianHoldSec: number | null;
  medianBuySol: number | null;
  sellToBuyRatio: number | null;
}): number {
  let score = 0;
  if (input.buyCandidates >= 5) score += 0.2;
  if ((input.quickSellRatio ?? 1) <= 0.35) score += 0.25;
  if ((input.medianHoldSec ?? 0) >= 900) score += 0.25;
  if (input.medianBuySol != null && input.medianBuySol >= 1) score += 0.15;
  if (input.sellToBuyRatio != null && input.sellToBuyRatio <= 1.0) score += 0.15;
  return round(score);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function addressKey(address: string): string {
  return address.trim();
}

function isRotationCandidateTarget(target: KolPosteriorCoverageTarget): boolean {
  const tier = (target.kolTier ?? '').toUpperCase();
  const role = (target.laneRole ?? '').toLowerCase();
  const style = (target.tradingStyle ?? '').toLowerCase();
  return tier === 'S' ||
    tier === 'A' ||
    role.includes('rotation') ||
    role.includes('discovery_canary') ||
    role.includes('copy_core') ||
    style.includes('scalper') ||
    style.includes('rotator');
}

function isoFromSec(sec: number | undefined): string | undefined {
  return sec == null || sec <= 0 ? undefined : new Date(sec * 1000).toISOString();
}

function ageHoursFromSec(sec: number | undefined): number | null {
  if (sec == null || sec <= 0) return null;
  return Math.max(0, Math.round(((Date.now() / 1000 - sec) / 3600) * 10) / 10);
}

export function buildKolPosteriorCoverage(
  rows: KolTransferRow[],
  targets: KolPosteriorCoverageTarget[],
  sinceSec?: number,
): KolPosteriorCoverage[] {
  const deduped = dedupeTransferRows(rows);
  const rowsByAddress = new Map<string, KolTransferRow[]>();
  for (const row of deduped) {
    const key = addressKey(row.kolAddress);
    const list = rowsByAddress.get(key) ?? [];
    list.push(row);
    rowsByAddress.set(key, list);
  }

  return targets.map((target) => {
    const allRows = rowsByAddress.get(addressKey(target.kolAddress)) ?? [];
    const sinceRows = sinceSec == null
      ? allRows
      : allRows.filter((row) => (row.transfer.blockTime ?? 0) >= sinceSec);
    const allTimes = allRows.map((row) => row.transfer.blockTime ?? 0).filter((value) => value > 0).sort((a, b) => a - b);
    const sinceTimes = sinceRows.map((row) => row.transfer.blockTime ?? 0).filter((value) => value > 0).sort((a, b) => a - b);
    const candidatesSince = buildTradeCandidates(sinceRows).length;
    const status: KolPosteriorCoverageStatus = sinceRows.length > 0 ? 'ok' : allRows.length > 0 ? 'stale' : 'missing';
    return {
      ...target,
      rotationCandidate: isRotationCandidateTarget(target),
      status,
      rowsAll: allRows.length,
      rowsSince: sinceRows.length,
      candidatesSince,
      firstTransferAt: isoFromSec(allTimes[0]),
      lastTransferAt: isoFromSec(allTimes[allTimes.length - 1]),
      firstSinceAt: isoFromSec(sinceTimes[0]),
      lastSinceAt: isoFromSec(sinceTimes[sinceTimes.length - 1]),
      lastAgeHours: ageHoursFromSec(allTimes[allTimes.length - 1]),
    };
  }).sort((a, b) => {
    const statusRank: Record<KolPosteriorCoverageStatus, number> = { missing: 0, stale: 1, ok: 2 };
    return statusRank[a.status] - statusRank[b.status] ||
      Number(b.rotationCandidate) - Number(a.rotationCandidate) ||
      b.rowsAll - a.rowsAll ||
      a.kolId.localeCompare(b.kolId);
  });
}

function summarizeCoverage(rows: KolPosteriorCoverage[]): KolPosteriorCoverageSummary {
  const rotation = rows.filter((row) => row.rotationCandidate);
  return {
    targets: rows.length,
    ok: rows.filter((row) => row.status === 'ok').length,
    stale: rows.filter((row) => row.status === 'stale').length,
    missing: rows.filter((row) => row.status === 'missing').length,
    rotationTargets: rotation.length,
    rotationOk: rotation.filter((row) => row.status === 'ok').length,
    rotationStale: rotation.filter((row) => row.status === 'stale').length,
    rotationMissing: rotation.filter((row) => row.status === 'missing').length,
  };
}

export function buildKolTransferPosteriorReport(
  rows: KolTransferRow[],
  args: Pick<Args, 'input' | 'kolDbPath' | 'sinceSec'> & {
    coverageTargets?: KolPosteriorCoverageTarget[];
    coverageLoadStatus?: KolPosteriorCoverageLoadStatus;
    coverageLoadError?: string;
  },
): KolTransferPosteriorReport {
  const filtered = args.sinceSec == null
    ? rows
    : rows.filter((row) => (row.transfer.blockTime ?? 0) >= args.sinceSec!);
  const deduped = dedupeTransferRows(filtered);
  const candidates = buildTradeCandidates(deduped);
  const coverage = args.coverageTargets
    ? buildKolPosteriorCoverage(rows, args.coverageTargets, args.sinceSec)
    : undefined;
  return {
    generatedAt: new Date().toISOString(),
    input: args.input,
    kolDbPath: args.kolDbPath,
    coverageLoadStatus: args.coverageLoadStatus,
    coverageLoadError: args.coverageLoadError,
    since: args.sinceSec != null ? new Date(args.sinceSec * 1000).toISOString() : undefined,
    rows: deduped.length,
    candidates: candidates.length,
    metrics: computeKolPosteriorMetrics(deduped, candidates),
    coverageSummary: coverage ? summarizeCoverage(coverage) : undefined,
    coverage,
  };
}

export function renderKolTransferPosteriorMarkdown(report: KolTransferPosteriorReport): string {
  const lines: string[] = [];
  lines.push(`# KOL Transfer Posterior Report`);
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- input: ${report.input}`);
  if (report.kolDbPath) lines.push(`- kolDb: ${report.kolDbPath}`);
  if (report.since) lines.push(`- since: ${report.since}`);
  lines.push(`- transfer rows: ${report.rows}`);
  lines.push(`- signature candidates: ${report.candidates}`);
  lines.push('');
  lines.push(`> Diagnostic only. Transfer candidates are not precise swap PnL. Use gTFA drill-down before policy changes.`);
  lines.push('');
  if (report.coverageSummary || report.coverageLoadStatus === 'load_failed' || report.coverageLoadStatus === 'disabled') {
    lines.push(`## Coverage`);
    lines.push('');
    if (report.coverageLoadStatus) lines.push(`- status: ${report.coverageLoadStatus}`);
    if (report.coverageLoadError) lines.push(`- error: ${report.coverageLoadError}`);
    if (!report.coverageSummary) {
      lines.push('');
      lines.push(`_Coverage targets were not loaded; posterior fit remains diagnostic but coverage freshness is unknown._`);
      lines.push('');
    }
  }
  if (report.coverageSummary) {
    lines.push([
      `- active targets: ${report.coverageSummary.targets}`,
      `ok=${report.coverageSummary.ok}`,
      `stale=${report.coverageSummary.stale}`,
      `missing=${report.coverageSummary.missing}`,
    ].join(' · '));
    lines.push([
      `- rotation candidates: ${report.coverageSummary.rotationTargets}`,
      `ok=${report.coverageSummary.rotationOk}`,
      `stale=${report.coverageSummary.rotationStale}`,
      `missing=${report.coverageSummary.rotationMissing}`,
    ].join(' · '));
    lines.push('');
    lines.push('| KOL | tier | role | style | rotation? | status | rows all | rows since | candidates since | last transfer | age h |');
    lines.push('|---|---|---|---|---:|---|---:|---:|---:|---|---:|');
    const visibleCoverage = (report.coverage ?? [])
      .filter((row) => row.rotationCandidate || row.status !== 'ok')
      .slice(0, 40);
    for (const row of visibleCoverage) {
      lines.push([
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
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    if (visibleCoverage.length === 0) lines.push('| n/a | - | - | - | - | ok | 0 | 0 | 0 | - | - |');
    lines.push('');
  }
  lines.push(`## KOL Posterior`);
  lines.push('');
  lines.push('| KOL | tier | role | style | tx | buy | sell | unique mints | reentry | sell/buy | med buy SOL | med hold | quick sell | multi-sell | rotation | smart-v3 | net SOL flow |');
  lines.push('|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const m of report.metrics) {
    lines.push([
      m.kolId,
      m.kolTier ?? '-',
      m.laneRole ?? '-',
      m.tradingStyle ?? '-',
      String(m.txGroups),
      String(m.buyCandidates),
      String(m.sellCandidates),
      String(m.uniqueBuyMints),
      formatRatio(m.sameMintReentryRatio),
      formatRatio(m.sellToBuyRatio),
      formatSol(m.medianBuySol),
      formatSec(m.medianHoldSec),
      formatRatio(m.quickSellRatio),
      formatRatio(m.multiSellMintRatio),
      m.rotationFitScore.toFixed(2),
      m.smartV3FitScore.toFixed(2),
      formatSol(m.netSolFlow),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  if (report.metrics.length === 0) lines.push('| n/a | - | - | - | 0 | 0 | 0 | 0 | - | - | - | - | - | - | 0.00 | 0.00 | 0.0000 |');
  lines.push('');
  return lines.join('\n');
}

function formatRatio(value: number | null): string {
  return value == null ? '-' : `${(value * 100).toFixed(1)}%`;
}

function formatSol(value: number | null): string {
  return value == null ? '-' : value.toFixed(4);
}

function formatSec(value: number | null): string {
  if (value == null) return '-';
  if (value < 120) return `${Math.round(value)}s`;
  if (value < 7200) return `${Math.round(value / 60)}m`;
  return `${(value / 3600).toFixed(1)}h`;
}

async function writeOutput(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows = await readJsonl<KolTransferRow>(args.input);
  const coverageLoad: {
    status: KolPosteriorCoverageLoadStatus;
    targets: KolPosteriorCoverageTarget[];
    error?: string;
  } = args.kolDbPath
    ? await loadKolPosteriorCoverageTargetsWithStatus(args.kolDbPath)
    : { status: 'disabled' as const, targets: [] };
  const report = buildKolTransferPosteriorReport(rows, {
    ...args,
    coverageTargets: coverageLoad.status === 'loaded' ? coverageLoad.targets : undefined,
    coverageLoadStatus: coverageLoad.status,
    coverageLoadError: coverageLoad.error,
  });
  const markdown = renderKolTransferPosteriorMarkdown(report);
  if (args.jsonOut) await writeOutput(args.jsonOut, JSON.stringify(report, null, 2));
  if (args.mdOut) await writeOutput(args.mdOut, markdown);
  if (!args.jsonOut && !args.mdOut) process.stdout.write(markdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
