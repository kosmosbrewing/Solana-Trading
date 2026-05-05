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

export interface KolTransferPosteriorReport {
  generatedAt: string;
  input: string;
  since?: string;
  rows: number;
  candidates: number;
  metrics: KolPosteriorMetrics[];
}

export function parseArgs(argv: string[], nowSec = Math.floor(Date.now() / 1000)): Args {
  const args: Args = {
    input: path.resolve(process.cwd(), 'data/research', DEFAULT_INPUT),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') args.input = path.resolve(requireValue(argv[++i], arg));
    else if (arg === '--research-dir') args.input = path.resolve(requireValue(argv[++i], arg), DEFAULT_INPUT);
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

export function buildKolTransferPosteriorReport(rows: KolTransferRow[], args: Pick<Args, 'input' | 'sinceSec'>): KolTransferPosteriorReport {
  const filtered = args.sinceSec == null
    ? rows
    : rows.filter((row) => (row.transfer.blockTime ?? 0) >= args.sinceSec!);
  const deduped = dedupeTransferRows(filtered);
  const candidates = buildTradeCandidates(deduped);
  return {
    generatedAt: new Date().toISOString(),
    input: args.input,
    since: args.sinceSec != null ? new Date(args.sinceSec * 1000).toISOString() : undefined,
    rows: deduped.length,
    candidates: candidates.length,
    metrics: computeKolPosteriorMetrics(deduped, candidates),
  };
}

export function renderKolTransferPosteriorMarkdown(report: KolTransferPosteriorReport): string {
  const lines: string[] = [];
  lines.push(`# KOL Transfer Posterior Report`);
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- input: ${report.input}`);
  if (report.since) lines.push(`- since: ${report.since}`);
  lines.push(`- transfer rows: ${report.rows}`);
  lines.push(`- signature candidates: ${report.candidates}`);
  lines.push('');
  lines.push(`> Diagnostic only. Transfer candidates are not precise swap PnL. Use gTFA drill-down before policy changes.`);
  lines.push('');
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
  const report = buildKolTransferPosteriorReport(rows, args);
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
