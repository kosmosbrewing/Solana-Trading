#!/usr/bin/env ts-node
/**
 * KOL Live Canary Attribution Report
 *
 * Wallet-truth 우선순위:
 *   1. sell.walletDeltaSol
 *   2. sell.dbPnlSol
 *   3. sell.receivedSol - sell.solSpentNominal
 *   4. sell.receivedSol - (buy.actualEntryPrice * buy.actualQuantity)
 *
 * 실행:
 *   npm run kol:live-canary-report -- --ledger-dir data/realtime --md reports/kol-live-canary.md
 */
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

interface CliArgs {
  ledgerDir: string;
  since?: Date;
  md?: string;
  json?: string;
}

interface KolLiveBuyLedger {
  positionId?: string;
  txSignature?: string;
  strategy?: string;
  wallet?: string;
  pairAddress?: string;
  tokenSymbol?: string;
  plannedEntryPrice?: number;
  actualEntryPrice?: number;
  actualQuantity?: number;
  slippageBps?: number;
  signalTimeSec?: number;
  recordedAt?: string;
  kolScore?: number;
  independentKolCount?: number;
}

interface KolLiveSellLedger {
  positionId?: string;
  dbTradeId?: string;
  txSignature?: string;
  entryTxSignature?: string;
  strategy?: string;
  wallet?: string;
  pairAddress?: string;
  tokenSymbol?: string;
  exitReason?: string;
  receivedSol?: number;
  actualExitPrice?: number;
  slippageBps?: number;
  entryPrice?: number;
  holdSec?: number;
  recordedAt?: string;
  mfePctPeak?: number;
  peakPrice?: number;
  troughPrice?: number;
  marketReferencePrice?: number;
  t1VisitAtSec?: number | null;
  t2VisitAtSec?: number | null;
  t3VisitAtSec?: number | null;
  closeState?: string;
  dbPnlSol?: number;
  walletDeltaSol?: number;
  dbPnlDriftSol?: number;
  solSpentNominal?: number;
  kolScore?: number;
  independentKolCount?: number;
  armName?: string;
  parameterVersion?: string;
  kolEntryReason?: string;
  kolConvictionLevel?: string;
}

interface PairedKolLiveTrade {
  positionId: string;
  tokenMint?: string;
  entryTxSignature?: string;
  exitTxSignature?: string;
  exitReason: string;
  armName: string;
  parameterVersion: string;
  netSol: number;
  walletTruthSource: 'walletDeltaSol' | 'dbPnlSol' | 'solSpentNominal' | 'buyFillEstimate' | 'unknown';
  win: boolean;
  mfePctPeak: number;
  holdSec?: number;
  t1Visited: boolean;
  t2Visited: boolean;
  t3Visited: boolean;
  entrySlippageBps?: number;
  exitSlippageBps?: number;
  independentKolCount?: number;
  kolScore?: number;
  recordedAtMs: number;
  orphanSell: boolean;
}

interface BucketSummary {
  bucket: string;
  trades: number;
  netSol: number;
  winRate: number;
  avgNetSol: number;
  avgMfePct: number;
  t1Visits: number;
  t2Visits: number;
  t3Visits: number;
  fiveXVisits: number;
  hardcuts: number;
}

interface KolLiveCanaryReport {
  generatedAt: string;
  since?: string;
  closedTrades: number;
  openBuys: number;
  orphanSells: number;
  netSol: number;
  winRate: number;
  avgNetSol: number;
  avgMfePct: number;
  maxDrawdownSol: number;
  t1Visits: number;
  t2Visits: number;
  t3Visits: number;
  fiveXVisits: number;
  hardcuts: number;
  walletTruthSources: Record<string, number>;
  byExitReason: BucketSummary[];
  byIndependentKolCount: BucketSummary[];
  bySlippageBucket: BucketSummary[];
  byArm: BucketSummary[];
  worstTrades: PairedKolLiveTrade[];
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const today = new Date().toISOString().slice(0, 10);
  const since = get('--since');
  return {
    ledgerDir: get('--ledger-dir') ?? path.resolve(process.cwd(), 'data/realtime'),
    since: since ? new Date(since) : undefined,
    md: get('--md') ?? path.resolve(process.cwd(), `reports/kol-live-canary-${today}.md`),
    json: get('--json') ?? path.resolve(process.cwd(), `reports/kol-live-canary-${today}.json`),
  };
}

function within(since: Date | undefined, recordedAt?: string): boolean {
  if (!since || !recordedAt) return true;
  const t = new Date(recordedAt).getTime();
  return Number.isFinite(t) && t >= since.getTime();
}

function isKolLivePositionId(positionId?: string): boolean {
  return typeof positionId === 'string' && positionId.startsWith('kolh-live-');
}

function isKolLiveBuy(row: KolLiveBuyLedger): boolean {
  return row.strategy === 'kol_hunter' &&
    (row.wallet === 'main' || isKolLivePositionId(row.positionId));
}

function isKolLiveSell(row: KolLiveSellLedger, liveEntryTx: Set<string>): boolean {
  return row.strategy === 'kol_hunter' &&
    (row.wallet === 'main' || isKolLivePositionId(row.positionId) ||
      (typeof row.entryTxSignature === 'string' && liveEntryTx.has(row.entryTxSignature)));
}

function parseJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((row): row is T => row !== null);
}

async function readJsonlMaybe<T>(file: string): Promise<T[]> {
  try {
    return parseJsonl<T>(await readFile(file, 'utf8'));
  } catch {
    return [];
  }
}

function resolveNetSol(
  buy: KolLiveBuyLedger | undefined,
  sell: KolLiveSellLedger
): { netSol: number; source: PairedKolLiveTrade['walletTruthSource'] } {
  if (typeof sell.walletDeltaSol === 'number') return { netSol: sell.walletDeltaSol, source: 'walletDeltaSol' };
  if (typeof sell.dbPnlSol === 'number') return { netSol: sell.dbPnlSol, source: 'dbPnlSol' };
  if (typeof sell.receivedSol === 'number' && typeof sell.solSpentNominal === 'number') {
    return { netSol: sell.receivedSol - sell.solSpentNominal, source: 'solSpentNominal' };
  }
  if (
    buy &&
    typeof sell.receivedSol === 'number' &&
    typeof buy.actualEntryPrice === 'number' &&
    typeof buy.actualQuantity === 'number'
  ) {
    return {
      netSol: sell.receivedSol - buy.actualEntryPrice * buy.actualQuantity,
      source: 'buyFillEstimate',
    };
  }
  return { netSol: 0, source: 'unknown' };
}

function recordedAtMs(row: { recordedAt?: string; signalTimeSec?: number }): number {
  if (row.recordedAt) {
    const t = new Date(row.recordedAt).getTime();
    if (Number.isFinite(t)) return t;
  }
  if (typeof row.signalTimeSec === 'number') return row.signalTimeSec * 1000;
  return 0;
}

function pairKolLiveTrades(
  buys: KolLiveBuyLedger[],
  sells: KolLiveSellLedger[],
  since?: Date
): { trades: PairedKolLiveTrade[]; openBuys: number; orphanSells: number } {
  const liveBuys = buys.filter((b) => isKolLiveBuy(b) && within(since, b.recordedAt));
  const liveEntryTx = new Set(liveBuys.map((b) => b.txSignature).filter((tx): tx is string => !!tx));
  const liveSells = sells.filter((s) => isKolLiveSell(s, liveEntryTx) && within(since, s.recordedAt));

  const buysByTx = new Map<string, KolLiveBuyLedger>();
  const buysByPositionId = new Map<string, KolLiveBuyLedger>();
  for (const buy of liveBuys) {
    if (buy.txSignature) buysByTx.set(buy.txSignature, buy);
    if (buy.positionId) buysByPositionId.set(buy.positionId, buy);
  }

  const consumedBuys = new Set<string>();
  let orphanSells = 0;
  const trades: PairedKolLiveTrade[] = [];
  for (const sell of liveSells) {
    const buy = (sell.entryTxSignature ? buysByTx.get(sell.entryTxSignature) : undefined) ??
      (sell.positionId ? buysByPositionId.get(sell.positionId) : undefined);
    if (buy?.txSignature) consumedBuys.add(buy.txSignature);
    if (!buy) orphanSells += 1;

    const net = resolveNetSol(buy, sell);
    const mfePctPeak = sell.mfePctPeak ?? 0;
    trades.push({
      positionId: sell.positionId ?? buy?.positionId ?? 'unknown',
      tokenMint: sell.pairAddress ?? buy?.pairAddress,
      entryTxSignature: sell.entryTxSignature ?? buy?.txSignature,
      exitTxSignature: sell.txSignature,
      exitReason: sell.exitReason ?? 'unknown',
      armName: sell.armName ?? 'unknown',
      parameterVersion: sell.parameterVersion ?? 'unknown',
      netSol: net.netSol,
      walletTruthSource: net.source,
      win: net.netSol > 0,
      mfePctPeak,
      holdSec: sell.holdSec,
      t1Visited: sell.t1VisitAtSec != null || mfePctPeak >= 0.5,
      t2Visited: sell.t2VisitAtSec != null || mfePctPeak >= 4,
      t3Visited: sell.t3VisitAtSec != null || mfePctPeak >= 9,
      entrySlippageBps: buy?.slippageBps,
      exitSlippageBps: sell.slippageBps,
      independentKolCount: sell.independentKolCount ?? buy?.independentKolCount,
      kolScore: sell.kolScore ?? buy?.kolScore,
      recordedAtMs: recordedAtMs(sell),
      orphanSell: !buy,
    });
  }

  let openBuys = 0;
  for (const buy of liveBuys) {
    if (buy.txSignature && !consumedBuys.has(buy.txSignature)) openBuys += 1;
  }

  return { trades, openBuys, orphanSells };
}

function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function maxDrawdownSol(trades: PairedKolLiveTrade[]): number {
  const ordered = [...trades].sort((a, b) => a.recordedAtMs - b.recordedAtMs);
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of ordered) {
    cumulative += trade.netSol;
    if (cumulative > peak) peak = cumulative;
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return maxDrawdown;
}

function summarizeBucket(bucket: string, trades: PairedKolLiveTrade[]): BucketSummary {
  const netSols = trades.map((trade) => trade.netSol);
  return {
    bucket,
    trades: trades.length,
    netSol: netSols.reduce((a, b) => a + b, 0),
    winRate: trades.length > 0 ? trades.filter((trade) => trade.win).length / trades.length : 0,
    avgNetSol: mean(netSols),
    avgMfePct: mean(trades.map((trade) => trade.mfePctPeak)),
    t1Visits: trades.filter((trade) => trade.t1Visited).length,
    t2Visits: trades.filter((trade) => trade.t2Visited).length,
    t3Visits: trades.filter((trade) => trade.t3Visited).length,
    fiveXVisits: trades.filter((trade) => trade.mfePctPeak >= 4).length,
    hardcuts: trades.filter((trade) => trade.exitReason === 'probe_hard_cut').length,
  };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const arr = map.get(key) ?? [];
    arr.push(item);
    map.set(key, arr);
  }
  return map;
}

function summariesBy(trades: PairedKolLiveTrade[], keyOf: (item: PairedKolLiveTrade) => string): BucketSummary[] {
  return [...groupBy(trades, keyOf).entries()]
    .map(([bucket, rows]) => summarizeBucket(bucket, rows))
    .sort((a, b) => b.netSol - a.netSol || b.trades - a.trades || a.bucket.localeCompare(b.bucket));
}

function independentKolBucket(trade: PairedKolLiveTrade): string {
  if (typeof trade.independentKolCount !== 'number') return 'unknown';
  if (trade.independentKolCount >= 3) return '3+';
  return String(trade.independentKolCount);
}

function slippageBucket(trade: PairedKolLiveTrade): string {
  const bps = Math.max(
    Math.abs(trade.entrySlippageBps ?? 0),
    Math.abs(trade.exitSlippageBps ?? 0)
  );
  if (trade.entrySlippageBps == null && trade.exitSlippageBps == null) return 'unknown';
  if (bps < 100) return '<100bps';
  if (bps < 1000) return '100-999bps';
  return '>=1000bps';
}

function armBucket(trade: PairedKolLiveTrade): string {
  return `${trade.armName}/${trade.parameterVersion}`;
}

function buildKolLiveCanaryReport(
  buys: KolLiveBuyLedger[],
  sells: KolLiveSellLedger[],
  since?: Date
): KolLiveCanaryReport {
  const { trades, openBuys, orphanSells } = pairKolLiveTrades(buys, sells, since);
  const walletTruthSources: Record<string, number> = {};
  for (const trade of trades) {
    walletTruthSources[trade.walletTruthSource] = (walletTruthSources[trade.walletTruthSource] ?? 0) + 1;
  }
  const netSols = trades.map((trade) => trade.netSol);
  return {
    generatedAt: new Date().toISOString(),
    since: since?.toISOString(),
    closedTrades: trades.length,
    openBuys,
    orphanSells,
    netSol: netSols.reduce((a, b) => a + b, 0),
    winRate: trades.length > 0 ? trades.filter((trade) => trade.win).length / trades.length : 0,
    avgNetSol: mean(netSols),
    avgMfePct: mean(trades.map((trade) => trade.mfePctPeak)),
    maxDrawdownSol: maxDrawdownSol(trades),
    t1Visits: trades.filter((trade) => trade.t1Visited).length,
    t2Visits: trades.filter((trade) => trade.t2Visited).length,
    t3Visits: trades.filter((trade) => trade.t3Visited).length,
    fiveXVisits: trades.filter((trade) => trade.mfePctPeak >= 4).length,
    hardcuts: trades.filter((trade) => trade.exitReason === 'probe_hard_cut').length,
    walletTruthSources,
    byExitReason: summariesBy(trades, (trade) => trade.exitReason),
    byIndependentKolCount: summariesBy(trades, independentKolBucket),
    bySlippageBucket: summariesBy(trades, slippageBucket),
    byArm: summariesBy(trades, armBucket),
    worstTrades: [...trades].sort((a, b) => a.netSol - b.netSol).slice(0, 5),
  };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function sol(v: number): string {
  return v.toFixed(6);
}

function formatBucketTable(summaries: BucketSummary[]): string {
  const lines = [
    '| Bucket | Trades | Net SOL | Win Rate | Avg Net | Avg MFE | T1 | T2 | T3 | 5x Visit | Hardcuts |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const s of summaries) {
    lines.push(
      `| ${s.bucket} | ${s.trades} | ${sol(s.netSol)} | ${pct(s.winRate)} | ${sol(s.avgNetSol)} | ` +
      `${pct(s.avgMfePct)} | ${s.t1Visits} | ${s.t2Visits} | ${s.t3Visits} | ${s.fiveXVisits} | ${s.hardcuts} |`
    );
  }
  return lines.join('\n');
}

function formatKolLiveCanaryMarkdown(report: KolLiveCanaryReport): string {
  const walletTruth = Object.entries(report.walletTruthSources)
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => `${source}=${count}`)
    .join(', ') || 'none';
  const worst = report.worstTrades.length > 0
    ? report.worstTrades
        .map((trade) =>
          `- ${trade.positionId} ${trade.exitReason} net=${sol(trade.netSol)} ` +
          `mfe=${pct(trade.mfePctPeak)} kols=${trade.independentKolCount ?? 'unknown'} ` +
          `source=${trade.walletTruthSource}`
        )
        .join('\n')
    : '_none_';

  return [
    `# KOL Live Canary Report - ${new Date().toISOString().slice(0, 10)}`,
    '',
    '> Live canary only. Paper and shadow outcomes are intentionally excluded.',
    '',
    '## Summary',
    '',
    `- Since: ${report.since ?? 'all time'}`,
    `- Closed trades: ${report.closedTrades}`,
    `- Open buys: ${report.openBuys}`,
    `- Orphan sells: ${report.orphanSells}`,
    `- Net SOL: ${sol(report.netSol)}`,
    `- Avg net SOL: ${sol(report.avgNetSol)}`,
    `- Win rate: ${pct(report.winRate)}`,
    `- Avg MFE: ${pct(report.avgMfePct)}`,
    `- Max drawdown SOL: ${sol(report.maxDrawdownSol)}`,
    `- T1/T2/T3 visits: ${report.t1Visits}/${report.t2Visits}/${report.t3Visits}`,
    `- 5x visits: ${report.fiveXVisits}`,
    `- Hardcuts: ${report.hardcuts}`,
    `- Wallet-truth sources: ${walletTruth}`,
    '',
    '## By Exit Reason',
    '',
    formatBucketTable(report.byExitReason),
    '',
    '## By Independent KOL Count',
    '',
    formatBucketTable(report.byIndependentKolCount),
    '',
    '## By Slippage Bucket',
    '',
    formatBucketTable(report.bySlippageBucket),
    '',
    '## By Arm',
    '',
    formatBucketTable(report.byArm),
    '',
    '## Worst Trades',
    '',
    worst,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs();
  const buys = await readJsonlMaybe<KolLiveBuyLedger>(path.join(args.ledgerDir, 'executed-buys.jsonl'));
  const sells = await readJsonlMaybe<KolLiveSellLedger>(path.join(args.ledgerDir, 'executed-sells.jsonl'));
  const report = buildKolLiveCanaryReport(buys, sells, args.since);

  if (args.md) {
    await mkdir(path.dirname(args.md), { recursive: true });
    await writeFile(args.md, formatKolLiveCanaryMarkdown(report), 'utf8');
  }
  if (args.json) {
    await mkdir(path.dirname(args.json), { recursive: true });
    await writeFile(args.json, JSON.stringify(report, null, 2), 'utf8');
  }

  console.log(
    `[kol-live-canary-report] closed=${report.closedTrades} open=${report.openBuys} ` +
    `orphan=${report.orphanSells} net=${sol(report.netSol)}SOL 5xVisits=${report.fiveXVisits}`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[kol-live-canary-report] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export {
  parseJsonl,
  pairKolLiveTrades,
  buildKolLiveCanaryReport,
  formatKolLiveCanaryMarkdown,
  type KolLiveBuyLedger,
  type KolLiveSellLedger,
  type KolLiveCanaryReport,
  type PairedKolLiveTrade,
};
