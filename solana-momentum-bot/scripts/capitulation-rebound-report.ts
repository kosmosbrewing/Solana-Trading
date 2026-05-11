#!/usr/bin/env ts-node
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

const CAPITULATION_PAPER_TRADES_FILE = 'capitulation-rebound-paper-trades.jsonl';
const TRADE_MARKOUTS_FILE = 'trade-markouts.jsonl';
const MISSED_ALPHA_FILE = 'missed-alpha.jsonl';
const DEFAULT_HORIZONS_SEC = [15, 30, 60, 180, 300, 1800];
const CAPITULATION_ARMS = new Set([
  'kol_hunter_capitulation_rebound_v1',
  'kol_hunter_capitulation_rebound_rr_v1',
]);

interface Args {
  realtimeDir: string;
  sinceMs: number;
  horizonsSec: number[];
  roundTripCostPct: number;
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
  positivePostCostRows: number;
  medianDeltaPct: number | null;
  medianPostCostDeltaPct: number | null;
  p25PostCostDeltaPct: number | null;
}

interface TradeStats {
  rows: number;
  wins: number;
  losses: number;
  netSol: number;
  netSolTokenOnly: number;
  medianMfePct: number | null;
  medianMaePct: number | null;
  medianHoldSec: number | null;
  topExitReasons: Array<{ reason: string; count: number }>;
}

interface CapitulationReboundReport {
  generatedAt: string;
  since: string;
  roundTripCostPct: number;
  paperTrades: TradeStats;
  tradeMarkouts: {
    afterBuy: HorizonStats[];
    afterSell: HorizonStats[];
  };
  noTrade: {
    rows: number;
    byHorizon: HorizonStats[];
    topReasons: Array<{ reason: string; count: number }>;
  };
  verdict: {
    status: 'COLLECT' | 'WATCH' | 'PAUSE_REVIEW';
    reasons: string[];
  };
}

function parseArgs(argv = process.argv.slice(2)): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const realtimeDir = get('--realtime-dir') ?? process.env.REALTIME_DATA_DIR ?? path.join(process.cwd(), 'data/realtime');
  const hours = Number(get('--hours') ?? '72');
  const since = get('--since');
  const horizonsRaw = get('--horizons') ?? DEFAULT_HORIZONS_SEC.join(',');
  const horizonsSec = horizonsRaw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  const sinceMs = resolveSinceMs(since, hours);
  return {
    realtimeDir,
    sinceMs,
    horizonsSec: horizonsSec.length > 0 ? horizonsSec : DEFAULT_HORIZONS_SEC,
    roundTripCostPct: Number(get('--round-trip-cost-pct') ?? '0.005'),
    mdOut: get('--md-out'),
    jsonOut: get('--json-out'),
  };
}

export function resolveSinceMs(value: string | undefined, fallbackHours: number, nowMs = Date.now()): number {
  if (value) {
    const relative = value.trim().match(/^(\d+(?:\.\d+)?)(m|h|d)$/i);
    if (relative) {
      const amount = Number(relative[1]);
      const unit = relative[2].toLowerCase();
      const unitMs = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
      return nowMs - Math.max(0, amount) * unitMs;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return nowMs - Math.max(1, fallbackHours) * 60 * 60 * 1000;
}

async function readJsonl(filePath: string): Promise<JsonRow[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JsonRow);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function extras(row: JsonRow): JsonRow {
  const value = row.extras;
  return value && typeof value === 'object' ? value as JsonRow : {};
}

function probe(row: JsonRow): JsonRow {
  const value = row.probe;
  return value && typeof value === 'object' ? value as JsonRow : {};
}

function rowTimeMs(row: JsonRow): number {
  const candidates = [
    row.recordedAt,
    row.closedAt,
    row.openedAt,
    row.rejectedAt,
    probe(row).firedAt,
  ];
  for (const candidate of candidates) {
    const text = str(candidate);
    if (!text) continue;
    const ms = Date.parse(text);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function topCounts(values: string[], limit = 5): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, limit);
}

function rowHorizon(row: JsonRow): number | null {
  return num(row.horizonSec) ?? num(probe(row).offsetSec);
}

function rowDelta(row: JsonRow): number | null {
  return num(row.deltaPct) ?? num(probe(row).deltaPct);
}

function quoteOk(row: JsonRow): boolean {
  const status = str(row.quoteStatus) ?? str(probe(row).quoteStatus);
  return status === 'ok';
}

function isCapitulationSource(row: JsonRow): boolean {
  const source = str(row.signalSource);
  const extra = extras(row);
  return (source != null && CAPITULATION_ARMS.has(source)) ||
    CAPITULATION_ARMS.has(str(extra.armName) ?? '') ||
    CAPITULATION_ARMS.has(str(row.armName) ?? '');
}

function summarizeHorizons(rows: JsonRow[], horizonsSec: number[], roundTripCostPct: number): HorizonStats[] {
  return horizonsSec.map((horizonSec) => {
    const scoped = rows.filter((row) => rowHorizon(row) === horizonSec);
    const okRows = scoped.filter(quoteOk);
    const deltas = okRows
      .map(rowDelta)
      .filter((value): value is number => value != null && Number.isFinite(value));
    const postCostDeltas = deltas.map((value) => value - roundTripCostPct);
    return {
      horizonSec,
      rows: scoped.length,
      okRows: okRows.length,
      positiveRows: deltas.filter((value) => value > 0).length,
      positivePostCostRows: postCostDeltas.filter((value) => value > 0).length,
      medianDeltaPct: percentile(deltas, 0.5),
      medianPostCostDeltaPct: percentile(postCostDeltas, 0.5),
      p25PostCostDeltaPct: percentile(postCostDeltas, 0.25),
    };
  });
}

function summarizeTrades(rows: JsonRow[]): TradeStats {
  const netSolValues = rows.map((row) => num(row.netSol) ?? 0);
  const netSolTokenOnlyValues = rows.map((row) => num(row.netSolTokenOnly) ?? num(row.netSol) ?? 0);
  const mfeValues = rows.map((row) => num(row.mfePct) ?? num(row.mfePctPeak)).filter((value): value is number => value != null);
  const maeValues = rows.map((row) => num(row.maePct) ?? num(row.maePctTokenOnly)).filter((value): value is number => value != null);
  const holdValues = rows.map((row) => num(row.holdSec)).filter((value): value is number => value != null);
  return {
    rows: rows.length,
    wins: netSolValues.filter((value) => value > 0).length,
    losses: netSolValues.filter((value) => value <= 0).length,
    netSol: netSolValues.reduce((sum, value) => sum + value, 0),
    netSolTokenOnly: netSolTokenOnlyValues.reduce((sum, value) => sum + value, 0),
    medianMfePct: percentile(mfeValues, 0.5),
    medianMaePct: percentile(maeValues, 0.5),
    medianHoldSec: percentile(holdValues, 0.5),
    topExitReasons: topCounts(rows.map((row) => str(row.exitReason) ?? 'unknown')),
  };
}

function buildVerdict(report: Omit<CapitulationReboundReport, 'verdict'>): CapitulationReboundReport['verdict'] {
  const reasons: string[] = [];
  const closeRows = report.paperTrades.rows;
  const buy15 = report.tradeMarkouts.afterBuy.find((row) => row.horizonSec === 15);
  const buy30 = report.tradeMarkouts.afterBuy.find((row) => row.horizonSec === 30);

  if (closeRows < 100) reasons.push(`paper closes ${closeRows} < 100`);
  if (!buy15 || buy15.okRows < Math.max(10, Math.floor(buy15.rows * 0.8))) {
    reasons.push('T+15 ok coverage insufficient');
  }
  if (!buy30 || buy30.okRows < Math.max(10, Math.floor(buy30.rows * 0.8))) {
    reasons.push('T+30 ok coverage insufficient');
  }
  if ((buy15?.medianPostCostDeltaPct ?? -1) <= 0) {
    reasons.push('T+15 median postCost <= 0');
  }
  if ((buy30?.medianPostCostDeltaPct ?? -1) <= 0) {
    reasons.push('T+30 median postCost <= 0');
  }
  if (closeRows >= 100 && report.paperTrades.netSol < 0 && (buy15?.medianPostCostDeltaPct ?? 0) <= 0) {
    return { status: 'PAUSE_REVIEW', reasons };
  }
  if (reasons.length === 0) return { status: 'WATCH', reasons: ['paper evidence positive, still paper-only until DSR/PBO'] };
  return { status: 'COLLECT', reasons };
}

export async function buildCapitulationReboundReport(args: Args): Promise<CapitulationReboundReport> {
  const paperTrades = (await readJsonl(path.join(args.realtimeDir, CAPITULATION_PAPER_TRADES_FILE)))
    .filter((row) => rowTimeMs(row) >= args.sinceMs);
  const markouts = (await readJsonl(path.join(args.realtimeDir, TRADE_MARKOUTS_FILE)))
    .filter((row) => rowTimeMs(row) >= args.sinceMs)
    .filter(isCapitulationSource);
  const noTradeRows = (await readJsonl(path.join(args.realtimeDir, MISSED_ALPHA_FILE)))
    .filter((row) => rowTimeMs(row) >= args.sinceMs)
    .filter((row) => extras(row).eventType === 'capitulation_rebound_no_trade');

  const base = {
    generatedAt: new Date().toISOString(),
    since: new Date(args.sinceMs).toISOString(),
    roundTripCostPct: args.roundTripCostPct,
    paperTrades: summarizeTrades(paperTrades),
    tradeMarkouts: {
      afterBuy: summarizeHorizons(markouts.filter((row) => row.anchorType === 'buy'), args.horizonsSec, args.roundTripCostPct),
      afterSell: summarizeHorizons(markouts.filter((row) => row.anchorType === 'sell'), args.horizonsSec, args.roundTripCostPct),
    },
    noTrade: {
      rows: noTradeRows.length,
      byHorizon: summarizeHorizons(noTradeRows, args.horizonsSec, args.roundTripCostPct),
      topReasons: topCounts(noTradeRows.map((row) => str(extras(row).noTradeReason) ?? str(row.rejectReason) ?? 'unknown')),
    },
  };
  return {
    ...base,
    verdict: buildVerdict(base),
  };
}

function fmtPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function fmtNum(value: number | null): string {
  return value == null ? 'n/a' : value.toFixed(4);
}

function renderHorizonRows(rows: HorizonStats[]): string {
  if (rows.length === 0) return '_no rows_';
  return [
    '| horizon | rows | ok | positive | postCost+ | median | median postCost | p25 postCost |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| T+${row.horizonSec}s | ${row.rows} | ${row.okRows} | ${row.positiveRows} | ` +
      `${row.positivePostCostRows} | ${fmtPct(row.medianDeltaPct)} | ` +
      `${fmtPct(row.medianPostCostDeltaPct)} | ${fmtPct(row.p25PostCostDeltaPct)} |`
    ),
  ].join('\n');
}

export function renderCapitulationReboundReportMarkdown(report: CapitulationReboundReport): string {
  const t = report.paperTrades;
  return [
    '# Capitulation Rebound V1 Paper Report',
    '',
    `- generatedAt: ${report.generatedAt}`,
    `- since: ${report.since}`,
    `- verdict: ${report.verdict.status} (${report.verdict.reasons.join('; ') || 'no blocking reason'})`,
    `- round-trip cost assumption: ${fmtPct(report.roundTripCostPct)}`,
    '',
    '## Paper Trades',
    '',
    `rows=${t.rows} W/L=${t.wins}/${t.losses} netSol=${t.netSol.toFixed(6)} tokenOnly=${t.netSolTokenOnly.toFixed(6)} ` +
      `medianMFE=${fmtPct(t.medianMfePct)} medianMAE=${fmtPct(t.medianMaePct)} medianHold=${fmtNum(t.medianHoldSec)}s`,
    '',
    `top exits: ${t.topExitReasons.map((row) => `${row.reason}=${row.count}`).join(', ') || 'none'}`,
    '',
    '## T+ After Buy',
    '',
    renderHorizonRows(report.tradeMarkouts.afterBuy),
    '',
    '## T+ After Sell',
    '',
    renderHorizonRows(report.tradeMarkouts.afterSell),
    '',
    '## No-Trade Counterfactuals',
    '',
    `rows=${report.noTrade.rows} topReasons=${report.noTrade.topReasons.map((row) => `${row.reason}=${row.count}`).join(', ') || 'none'}`,
    '',
    renderHorizonRows(report.noTrade.byHorizon),
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs();
  const report = await buildCapitulationReboundReport(args);
  const markdown = renderCapitulationReboundReportMarkdown(report);
  if (args.jsonOut) {
    await mkdir(path.dirname(args.jsonOut), { recursive: true });
    await writeFile(args.jsonOut, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  if (args.mdOut) {
    await mkdir(path.dirname(args.mdOut), { recursive: true });
    await writeFile(args.mdOut, markdown, 'utf8');
  }
  if (!args.jsonOut && !args.mdOut) {
    console.log(markdown);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
