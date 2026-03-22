import { Pool } from 'pg';
import path from 'path';
import dotenv from 'dotenv';
import {
  buildPaperValidationReport,
  PaperValidationSignal,
  PaperValidationTrade,
  summarizeRealtimeSignals,
} from '../src/reporting';
import { RealtimeReplayStore } from '../src/realtime';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const pairAddress = getArg(args, '--pair');
  const start = getDateArg(args, '--start');
  const end = getDateArg(args, '--end');
  const minTrades = numArg(args, '--min-trades', 50);
  const minWinRate = numArg(args, '--min-win-rate', 0.4);
  const minRewardRisk = numArg(args, '--min-rr', 2);
  const initialBalance = numArg(args, '--initial-balance', 10);
  const maxDrawdownPct = numArg(args, '--max-drawdown', 0.3);
  const recoveryPct = numArg(args, '--recovery-pct', 0.85);
  const realtimeDir = getArg(args, '--realtime-dir') || process.env.REALTIME_DATA_DIR;
  const realtimeHorizon = numArg(args, '--realtime-horizon', 180);
  const skipDb = args.includes('--skip-db');
  const asJson = args.includes('--json');

  const databaseUrl = skipDb ? '' : process.env.DATABASE_URL;
  let report: ReturnType<typeof buildPaperValidationReport> | null = null;
  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const trades = await loadPaperTrades(pool, pairAddress, start, end);
      const signals = await loadSignals(pool, pairAddress, start, end);
      report = buildPaperValidationReport(trades, signals, {
        initialBalance,
        minTrades,
        minWinRate,
        minRewardRisk,
        maxDrawdownPct,
        recoveryPct,
      });
    } finally {
      await pool.end();
    }
  }

  const realtimeSummary = realtimeDir
    ? await loadRealtimeSummary(realtimeDir, realtimeHorizon)
    : null;

  if (!report && !realtimeSummary) {
    console.error('No paper DB report or realtime dataset available. Set DATABASE_URL and/or --realtime-dir.');
    process.exit(1);
  }

  if (asJson) {
    if (report && !realtimeSummary) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(JSON.stringify({
      paper: report,
      realtime: realtimeSummary,
    }, null, 2));
    return;
  }

  if (report) {
    printReport(report, { pairAddress, start, end, minTrades, minWinRate, minRewardRisk });
  }
  if (realtimeSummary && realtimeDir) {
    printRealtimeSummary(realtimeSummary, realtimeHorizon, realtimeDir);
  }
}

async function loadPaperTrades(pool: Pool, pairAddress?: string, start?: Date, end?: Date): Promise<PaperValidationTrade[]> {
  const { clause, params } = buildWindowClause(pairAddress, start, end, 'closed_at');
  const result = await pool.query(
    `
      SELECT strategy, pair_address, entry_price, stop_loss, quantity, pnl, exit_reason, closed_at
      FROM trades
      WHERE status = 'CLOSED' AND tx_signature = 'PAPER_TRADE' ${clause}
      ORDER BY closed_at ASC
    `,
    params
  );
  return result.rows.map(row => ({
    strategy: row.strategy,
    pairAddress: row.pair_address,
    entryPrice: Number(row.entry_price),
    stopLoss: Number(row.stop_loss),
    quantity: Number(row.quantity),
    pnl: Number(row.pnl),
    exitReason: row.exit_reason ?? undefined,
    closedAt: new Date(row.closed_at),
  }));
}

async function loadSignals(pool: Pool, pairAddress?: string, start?: Date, end?: Date): Promise<PaperValidationSignal[]> {
  const { clause, params } = buildWindowClause(pairAddress, start, end, 'timestamp');
  const result = await pool.query(
    `
      SELECT strategy, action, filter_reason
      FROM signal_audit_log
      WHERE 1 = 1 ${clause}
      ORDER BY timestamp ASC
    `,
    params
  );
  return result.rows.map(row => ({
    strategy: row.strategy,
    action: row.action,
    filterReason: row.filter_reason ?? null,
  }));
}

function buildWindowClause(pairAddress: string | undefined, start: Date | undefined, end: Date | undefined, field: string) {
  const clauses: string[] = [];
  const params: Array<string | Date> = [];

  if (pairAddress) {
    params.push(pairAddress);
    clauses.push(`AND pair_address = $${params.length}`);
  }
  if (start) {
    params.push(start);
    clauses.push(`AND ${field} >= $${params.length}`);
  }
  if (end) {
    params.push(end);
    clauses.push(`AND ${field} <= $${params.length}`);
  }

  return { clause: clauses.length > 0 ? ` ${clauses.join(' ')}` : '', params };
}

function printReport(
  report: ReturnType<typeof buildPaperValidationReport>,
  context: { pairAddress?: string; start?: Date; end?: Date; minTrades: number; minWinRate: number; minRewardRisk: number }
) {
  console.log('\nPaper Validation Report');
  console.log('='.repeat(72));
  console.log(`Pair: ${context.pairAddress ?? 'ALL'}`);
  console.log(`Window: ${fmtDate(context.start)} -> ${fmtDate(context.end)}`);
  console.log(`Trades: ${report.totalTrades}/${context.minTrades} | Wins: ${report.wins} | Losses: ${report.losses}`);
  console.log(`Win Rate: ${(report.winRate * 100).toFixed(2)}% (target ${(context.minWinRate * 100).toFixed(0)}%)`);
  console.log(`Reward/Risk: ${fmtNumber(report.rewardRisk)} (target ${context.minRewardRisk.toFixed(2)})`);
  console.log(`Net PnL: ${report.netPnl.toFixed(6)} SOL`);
  console.log(`Net PnL %: ${(report.netPnlPct * 100).toFixed(2)}%`);
  console.log(`Profit Factor: ${fmtNumber(report.profitFactor)} | Sharpe: ${fmtNumber(report.sharpeRatio)} | ExpR: ${fmtNumber(report.expectancyR)}`);
  console.log(`Edge Score: ${report.edgeScore.toFixed(1)} | Decision: ${report.edgeDecision} | Gate: ${report.edgeGateStatus}`);
  console.log(`Signals: executed=${report.executedSignals} filtered=${report.filteredSignals}`);
  console.log(`Trend/Event filters: ${report.notTrendingFiltered}`);
  console.log(`Drawdown guard filters: ${report.drawdownGuardFiltered}`);
  console.log(`Max realized drawdown: ${(report.maxRealizedDrawdownPct * 100).toFixed(2)}%`);
  console.log(`Phase 2 ready: ${report.criteria.phase2Ready ? 'YES' : 'NO'}`);
  if (report.edgeGateReasons.length > 0) {
    console.log(`Edge gate reasons: ${report.edgeGateReasons.join(', ')}`);
  }
  console.log('-'.repeat(72));
  for (const stat of report.strategyStats) {
    console.log(
      `${stat.strategy}: trades=${stat.totalTrades}, winRate=${(stat.winRate * 100).toFixed(2)}%, ` +
      `R:R=${fmtNumber(stat.rewardRisk)}, PF=${fmtNumber(stat.profitFactor)}, ExpR=${fmtNumber(stat.expectancyR)}, netPnl=${stat.netPnl.toFixed(6)} SOL`
    );
  }
  console.log('-'.repeat(72));
  console.log(`Observed Attention gate: ${report.criteria.attentionGateObserved ? 'YES' : 'NO'}`);
  console.log(`Observed DrawdownGuard halt: ${report.criteria.drawdownGuardObserved ? 'YES' : 'NO'}`);
}

async function loadRealtimeSummary(realtimeDir: string, horizonSec: number) {
  const store = new RealtimeReplayStore(path.resolve(realtimeDir));
  const records = await store.loadSignals();
  if (records.length === 0) return null;
  return summarizeRealtimeSignals(records, horizonSec);
}

function printRealtimeSummary(
  summary: ReturnType<typeof summarizeRealtimeSignals>,
  horizonSec: number,
  realtimeDir: string
) {
  console.log('\nRealtime Shadow Summary');
  console.log('='.repeat(72));
  console.log(`Dir: ${path.resolve(realtimeDir)}`);
  console.log(`Signals: total=${summary.totalSignals} executed=${summary.executedSignals} gateRejected=${summary.gateRejectedSignals}`);
  console.log(`Horizon: ${horizonSec}s | Avg Return: ${(summary.avgReturnPct * 100).toFixed(2)}% | Avg Adj Return: ${(summary.avgAdjustedReturnPct * 100).toFixed(2)}%`);
  console.log(`Avg MFE: ${(summary.avgMfePct * 100).toFixed(2)}% | Avg MAE: ${(summary.avgMaePct * 100).toFixed(2)}%`);
  console.log(`Gate latency avg=${summary.avgGateLatencyMs.toFixed(1)}ms p50=${summary.p50GateLatencyMs.toFixed(1)}ms p95=${summary.p95GateLatencyMs.toFixed(1)}ms`);
  console.log(`Signal->fill avg=${summary.avgSignalToFillLatencyMs.toFixed(1)}ms p50=${summary.p50SignalToFillLatencyMs.toFixed(1)}ms p95=${summary.p95SignalToFillLatencyMs.toFixed(1)}ms`);
  console.log(`Edge Score: ${summary.assessment.edgeScore.toFixed(1)} | Decision: ${summary.assessment.decision} | Gate: ${summary.assessment.gateStatus}`);
  if (summary.assessment.gateReasons.length > 0) {
    console.log(`Edge gate reasons: ${summary.assessment.gateReasons.join(', ')}`);
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function getDateArg(args: string[], flag: string): Date | undefined {
  const raw = getArg(args, flag);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    console.error(`Invalid date for ${flag}: "${raw}"`);
    process.exit(1);
  }
  return parsed;
}

function numArg(args: string[], flag: string, fallback: number): number {
  const raw = getArg(args, flag);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    console.error(`Invalid number for ${flag}: "${raw}"`);
    process.exit(1);
  }
  return parsed;
}

function fmtNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'INF';
}

function fmtDate(value?: Date): string {
  return value ? value.toISOString() : 'unbounded';
}

function printHelp() {
  console.log(`
Usage:
  npx ts-node scripts/paper-report.ts [options]

Options:
  --pair <address>          Filter by pair_address
  --start <ISO>             Inclusive start timestamp
  --end <ISO>               Inclusive end timestamp
  --min-trades <n>          Success threshold (default: 50)
  --min-win-rate <ratio>    Success threshold (default: 0.4)
  --min-rr <n>              Success threshold (default: 2)
  --initial-balance <sol>   Starting balance for drawdown replay (default: 10)
  --max-drawdown <ratio>    DrawdownGuard threshold (default: 0.3)
  --recovery-pct <ratio>    DrawdownGuard recovery ratio (default: 0.85)
  --realtime-dir <path>     Optional realtime shadow dataset directory
  --realtime-horizon <sec>  Realtime summary horizon in seconds (default: 180)
  --skip-db                 Ignore DATABASE_URL and print realtime-only report if available
  --json                    Print machine-readable report

Notes:
  - Trades are filtered to status='CLOSED' and tx_signature='PAPER_TRADE'.
  - signal_audit_log has no mode column, so run this against a paper-only DB or a clean time window.
  - If DATABASE_URL is missing, realtime-only summary can still be printed with --realtime-dir.
`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
