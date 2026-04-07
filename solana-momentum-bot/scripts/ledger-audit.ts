import { Pool } from 'pg';
import path from 'path';
import dotenv from 'dotenv';
import { EdgeTracker } from '../src/reporting/edgeTracker';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface TradeRow {
  id: string;
  pair_address: string;
  strategy: string;
  token_symbol: string | null;
  status: string;
  created_at: Date;
  closed_at: Date | null;
  parent_trade_id: string | null;
  entry_price: string;
  planned_entry_price: string | null;
  decision_price: string | null;
  exit_price: string | null;
  quantity: string;
  pnl: string | null;
  stop_loss: string;
  exit_reason: string | null;
  entry_slippage_bps: number | null;
  exit_slippage_bps: number | null;
  round_trip_cost_pct: string | null;
  effective_rr: string | null;
}

interface Args {
  hours: number;
  start?: Date;
  end?: Date;
  pair?: string;
  limit: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const hours = Number(getArg(args, '--hours') ?? '12');
  const start = parseDateArg(getArg(args, '--start'), '--start');
  const end = parseDateArg(getArg(args, '--end'), '--end');
  const pair = getArg(args, '--pair');
  const limit = Number(getArg(args, '--limit') ?? '20');

  return {
    hours: Number.isFinite(hours) && hours > 0 ? hours : 12,
    start,
    end,
    pair,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
  };
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseDateArg(value: string | undefined, flag: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    console.error(`Invalid date for ${flag}: ${value}`);
    process.exit(1);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Ledger Audit
========================================================================
가격 원장 정합성 + edge blacklist 근거를 같이 점검한다.

Usage:
  npm run ops:check:ledger
  npm run ops:check:ledger -- --hours 12
  npm run ops:check:ledger -- --start 2026-04-06T14:31:03Z --end 2026-04-07T02:31:03Z
  npm run ops:check:ledger -- --pair Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump

Options:
  --hours <n>   Relative window in hours (default: 12)
  --start <ts>  Absolute UTC start timestamp
  --end <ts>    Absolute UTC end timestamp
  --pair <addr> Pair address filter
  --limit <n>   Max suspicious rows to print (default: 20)
`);
}

function fmtTs(value?: Date | null): string {
  if (!value) return '---';
  return value.toISOString().slice(0, 19);
}

function fmtNum(value: number | null | undefined, digits = 6): string {
  if (value == null || !Number.isFinite(value)) return '---';
  return value.toFixed(digits);
}

function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '---';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

function fmtBps(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---';
  return `${value}bps`;
}

function shortAddr(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 12)}...${value.slice(-6)}`;
}

function num(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function entryGapPct(row: TradeRow): number | null {
  const planned = num(row.planned_entry_price);
  const entry = num(row.entry_price);
  if (planned == null || planned === 0 || entry == null) return null;
  return ((entry - planned) / planned) * 100;
}

function exitGapPct(row: TradeRow): number | null {
  const decision = num(row.decision_price);
  const exit = num(row.exit_price);
  if (decision == null || decision === 0 || exit == null) return null;
  return ((exit - decision) / decision) * 100;
}

function anomalyScore(row: TradeRow): number {
  return Math.max(
    Math.abs(entryGapPct(row) ?? 0),
    Math.abs(exitGapPct(row) ?? 0),
  );
}

function anomalyReasons(row: TradeRow): string[] {
  const reasons: string[] = [];
  const entryGap = entryGapPct(row);
  const exitGap = exitGapPct(row);
  const pnl = num(row.pnl);

  if (entryGap != null && Math.abs(entryGap) >= 50) reasons.push('entry_gap>=50%');
  if (exitGap != null && Math.abs(exitGap) >= 50) reasons.push('exit_gap>=50%');
  if ((row.exit_reason === 'TAKE_PROFIT_1' || row.exit_reason === 'TAKE_PROFIT_2') && (pnl ?? 0) < 0) {
    reasons.push('tp_negative_pnl');
  }
  if (entryGap != null && Math.abs(entryGap) >= 50 && (row.entry_slippage_bps == null || Math.abs(row.entry_slippage_bps) <= 100)) {
    reasons.push('gap_vs_slippage_mismatch');
  }
  if (exitGap != null && Math.abs(exitGap) >= 50 && (row.exit_slippage_bps == null || Math.abs(row.exit_slippage_bps) <= 100)) {
    reasons.push('exitgap_vs_slippage_mismatch');
  }

  return reasons;
}

function buildWhereClause(args: Args, now: Date): { clause: string; params: Array<string | Date> } {
  const params: Array<string | Date> = [];
  const clauses: string[] = [];

  const start = args.start ?? new Date(now.getTime() - args.hours * 3_600_000);
  const end = args.end ?? now;

  params.push(start);
  clauses.push(`(created_at >= $${params.length} OR closed_at >= $${params.length})`);

  params.push(end);
  clauses.push(`created_at <= $${params.length}`);

  if (args.pair) {
    params.push(args.pair);
    clauses.push(`pair_address = $${params.length}`);
  }

  return {
    clause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function printSuspiciousRows(rows: TradeRow[], limit: number): void {
  const suspicious = rows
    .map((row) => ({ row, score: anomalyScore(row), reasons: anomalyReasons(row) }))
    .filter((item) => item.score >= 50 || item.reasons.length > 0)
    .sort((a, b) => b.score - a.score || a.row.created_at.getTime() - b.row.created_at.getTime());

  console.log('\nSuspicious Rows');
  console.log('------------------------------------------------------------------------');
  if (suspicious.length === 0) {
    console.log('(none)');
    return;
  }

  for (const { row, reasons } of suspicious.slice(0, limit)) {
    console.log(
      `${fmtTs(row.created_at)} | ${shortAddr(row.pair_address)} | ${row.token_symbol ?? '-'} | ${row.exit_reason ?? row.status}`
    );
    console.log(
      `  entry=${fmtNum(num(row.entry_price))} planned=${fmtNum(num(row.planned_entry_price))} gap=${fmtPct(entryGapPct(row))} slip=${fmtBps(row.entry_slippage_bps)}`
    );
    console.log(
      `  exit=${fmtNum(num(row.exit_price))} decision=${fmtNum(num(row.decision_price))} gap=${fmtPct(exitGapPct(row))} slip=${fmtBps(row.exit_slippage_bps)} pnl=${fmtNum(num(row.pnl))}`
    );
    console.log(`  reasons=${reasons.join(', ') || 'high_gap_only'}`);
  }
}

function printPairGapSummary(rows: TradeRow[]): void {
  const grouped = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const key = row.pair_address;
    const current = grouped.get(key);
    if (current) current.push(row);
    else grouped.set(key, [row]);
  }

  console.log('\nPair Gap Summary');
  console.log('------------------------------------------------------------------------');
  if (grouped.size === 0) {
    console.log('(none)');
    return;
  }

  const summaries = [...grouped.entries()].map(([pair, trades]) => {
    const entryGaps = trades.map(entryGapPct).filter((v): v is number => v != null);
    const exitGaps = trades.map(exitGapPct).filter((v): v is number => v != null);
    const pnl = trades.reduce((sum, trade) => sum + (num(trade.pnl) ?? 0), 0);
    return {
      pair,
      symbol: trades.find((trade) => trade.token_symbol)?.token_symbol ?? '-',
      rows: trades.length,
      avgEntryGap: average(entryGaps),
      maxAbsEntryGap: maxAbs(entryGaps),
      avgExitGap: average(exitGaps),
      maxAbsExitGap: maxAbs(exitGaps),
      avgEntrySlip: average(trades.map((trade) => trade.entry_slippage_bps).filter((v): v is number => v != null)),
      avgExitSlip: average(trades.map((trade) => trade.exit_slippage_bps).filter((v): v is number => v != null)),
      netPnl: pnl,
    };
  }).sort(
    (a, b) => (b.maxAbsEntryGap ?? -1) - (a.maxAbsEntryGap ?? -1) || a.netPnl - b.netPnl
  );

  for (const item of summaries) {
    console.log(
      `${shortAddr(item.pair)} | ${item.symbol} | rows=${item.rows} | avgEntryGap=${fmtPct(item.avgEntryGap)} | maxAbsEntryGap=${fmtPct(item.maxAbsEntryGap)} | avgExitGap=${fmtPct(item.avgExitGap)} | netPnl=${fmtNum(item.netPnl)}`
    );
  }
}

function printTpNegativeRows(rows: TradeRow[]): void {
  const tpNegative = rows.filter((row) =>
    (row.exit_reason === 'TAKE_PROFIT_1' || row.exit_reason === 'TAKE_PROFIT_2') &&
    (num(row.pnl) ?? 0) < 0
  );

  console.log('\nTP But Negative PnL');
  console.log('------------------------------------------------------------------------');
  if (tpNegative.length === 0) {
    console.log('(none)');
    return;
  }

  for (const row of tpNegative) {
    console.log(
      `${fmtTs(row.closed_at)} | ${shortAddr(row.pair_address)} | ${row.token_symbol ?? '-'} | ${row.exit_reason} | pnl=${fmtNum(num(row.pnl))}`
    );
    console.log(
      `  planned=${fmtNum(num(row.planned_entry_price))} entry=${fmtNum(num(row.entry_price))} decision=${fmtNum(num(row.decision_price))} exit=${fmtNum(num(row.exit_price))}`
    );
  }
}

function printLogicalTrades(rows: TradeRow[]): void {
  const grouped = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const key = row.parent_trade_id ?? row.id;
    const current = grouped.get(key);
    if (current) current.push(row);
    else grouped.set(key, [row]);
  }

  const multiRow = [...grouped.entries()]
    .map(([id, trades]) => ({
      id,
      trades: trades.sort((a, b) => a.created_at.getTime() - b.created_at.getTime()),
    }))
    .filter((item) => item.trades.length > 1)
    .sort((a, b) => b.trades.length - a.trades.length || a.trades[0].created_at.getTime() - b.trades[0].created_at.getTime());

  console.log('\nLogical Trades (multi-row)');
  console.log('------------------------------------------------------------------------');
  if (multiRow.length === 0) {
    console.log('(none)');
    return;
  }

  for (const item of multiRow.slice(0, 20)) {
    const first = item.trades[0];
    const lifecycle = item.trades.map((trade) => trade.exit_reason ?? trade.status).join(' -> ');
    const totalPnl = item.trades.reduce((sum, trade) => sum + (num(trade.pnl) ?? 0), 0);
    console.log(
      `${shortAddr(item.id)} | ${shortAddr(first.pair_address)} | ${first.token_symbol ?? '-'} | rows=${item.trades.length} | pnl=${fmtNum(totalPnl)}`
    );
    console.log(`  lifecycle=${lifecycle}`);
  }
}

function printEdgeBlacklist(rows: TradeRow[]): void {
  const closedRows = rows
    .filter((row) => row.status === 'CLOSED' && row.closed_at != null && num(row.pnl) != null)
    .sort((a, b) => (a.closed_at!.getTime() - b.closed_at!.getTime()));

  const tracker = new EdgeTracker(closedRows.map((row) => ({
    pairAddress: row.pair_address,
    strategy: row.strategy as never,
    entryPrice: num(row.entry_price) ?? 0,
    stopLoss: num(row.stop_loss) ?? 0,
    quantity: num(row.quantity) ?? 0,
    pnl: num(row.pnl) ?? 0,
  })));

  const pairAddresses = [...new Set(closedRows.map((row) => row.pair_address))];
  const summaries = pairAddresses.map((pairAddress) => {
    const stats = tracker.getPairStats(pairAddress);
    const recentClosed = closedRows.filter((row) => row.pair_address === pairAddress).slice(-10);
    return {
      pairAddress,
      symbol: closedRows.find((row) => row.pair_address === pairAddress)?.token_symbol ?? '-',
      stats,
      recentTrades: recentClosed.length,
      blacklisted: tracker.isPairBlacklisted(pairAddress),
    };
  }).sort((a, b) => Number(b.blacklisted) - Number(a.blacklisted) || b.stats.totalTrades - a.stats.totalTrades);

  console.log('\nEdge Blacklist Snapshot');
  console.log('------------------------------------------------------------------------');
  if (summaries.length === 0) {
    console.log('(none)');
    return;
  }

  for (const item of summaries) {
    console.log(
      `${shortAddr(item.pairAddress)} | ${item.symbol} | trades=${item.stats.totalTrades} recent10=${item.recentTrades} | WR=${(item.stats.winRate * 100).toFixed(1)}% | RR=${item.stats.rewardRisk.toFixed(2)} | Sharpe=${item.stats.sharpeRatio.toFixed(2)} | MaxL=${item.stats.maxConsecutiveLosses} | blacklisted=${item.blacklisted ? 'YES' : 'NO'}`
    );
  }
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxAbs(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.max(...values.map((value) => Math.abs(value)));
}

async function main(): Promise<void> {
  const args = parseArgs();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL 환경변수가 필요합니다.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: dbUrl,
    max: 3,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
  });

  try {
    const nowResult = await pool.query<{ db_now: Date }>('SELECT now() AS db_now');
    const dbNow = nowResult.rows[0].db_now;
    const { clause, params } = buildWhereClause(args, dbNow);
    const rows = (await pool.query<TradeRow>(
      `SELECT
         id,
         pair_address,
         strategy,
         token_symbol,
         status,
         created_at,
         closed_at,
         parent_trade_id,
         entry_price,
         planned_entry_price,
         decision_price,
         exit_price,
         quantity,
         pnl,
         stop_loss,
         exit_reason,
         entry_slippage_bps,
         exit_slippage_bps,
         round_trip_cost_pct,
         effective_rr
       FROM trades
       ${clause}
       ORDER BY coalesce(closed_at, created_at) ASC, created_at ASC`,
      params,
    )).rows;

    console.log('Ledger Audit');
    console.log('========================================================================');
    console.log(`DB now      : ${fmtTs(dbNow)}`);
    console.log(`Window start: ${fmtTs(args.start ?? new Date(dbNow.getTime() - args.hours * 3_600_000))}`);
    console.log(`Window end  : ${fmtTs(args.end ?? dbNow)}`);
    console.log(`Pair filter : ${args.pair ?? 'ALL'}`);
    console.log(`Rows loaded : ${rows.length}`);

    if (rows.length === 0) {
      console.log('\nNo trades in window.');
      return;
    }

    printSuspiciousRows(rows, args.limit);
    printPairGapSummary(rows);
    printTpNegativeRows(rows);
    printLogicalTrades(rows);
    printEdgeBlacklist(rows);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`ledger-audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
