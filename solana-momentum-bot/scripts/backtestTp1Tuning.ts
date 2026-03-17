/**
 * TP1 Tuning Backtest (M-1)
 *
 * ATR 배수별 TP1 성과 비교:
 *   - 1.5x ATR (현재)
 *   - 2.0x ATR (후보)
 *   - 2.5x ATR (후보)
 *
 * 사용법:
 *   npx ts-node scripts/backtestTp1Tuning.ts <pair_address> [--source db|csv] [--csv-dir ./data]
 */
import { Pool } from 'pg';
import path from 'path';
import dotenv from 'dotenv';
import {
  BacktestEngine,
  BacktestResult,
  CsvLoader,
  DbLoader,
  DEFAULT_BACKTEST_CONFIG,
} from '../src/backtest';
import type { Candle } from '../src/utils/types';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface Tp1Scenario {
  label: string;
  tp1Multiplier: number;
  tp2Multiplier: number;
}

const SCENARIOS: Tp1Scenario[] = [
  { label: '1.5x ATR (current)', tp1Multiplier: 1.5, tp2Multiplier: 2.5 },
  { label: '2.0x ATR (wider)',   tp1Multiplier: 2.0, tp2Multiplier: 2.5 },
  { label: '2.0x / 3.0x ATR',   tp1Multiplier: 2.0, tp2Multiplier: 3.0 },
  { label: '2.5x / 3.5x ATR',   tp1Multiplier: 2.5, tp2Multiplier: 3.5 },
];

async function main() {
  const args = process.argv.slice(2);
  const pairAddress = args.find(a => !a.startsWith('--'));

  if (!pairAddress) {
    console.error('Usage: npx ts-node scripts/backtestTp1Tuning.ts <pair_address> [options]');
    process.exit(1);
  }

  const source = args.includes('--source') ? args[args.indexOf('--source') + 1] : 'db';

  // Load candles
  let candles5m: Candle[] = [];

  if (source === 'csv') {
    const csvDir = args.includes('--csv-dir') ? args[args.indexOf('--csv-dir') + 1] : path.resolve(__dirname, '../data');
    const loader = new CsvLoader(csvDir);
    candles5m = await loader.load(pairAddress, 300);
  } else {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.error('DATABASE_URL not set');
      process.exit(1);
    }
    const pool = new Pool({ connectionString: databaseUrl });
    const loader = new DbLoader(pool);
    candles5m = await loader.load(pairAddress, 300);
    await pool.end();
  }

  if (candles5m.length === 0) {
    console.error('No candle data found');
    process.exit(1);
  }

  console.log(`\n═══ TP1 Tuning Backtest: ${pairAddress.slice(0, 12)}... ═══`);
  console.log(`Candles: ${candles5m.length} (5m)\n`);

  // Run each scenario
  const results: { scenario: Tp1Scenario; result: BacktestResult }[] = [];

  for (const scenario of SCENARIOS) {
    const engine = new BacktestEngine({
      ...DEFAULT_BACKTEST_CONFIG,
      volumeSpikeParams: {
        tp1Multiplier: scenario.tp1Multiplier,
        tp2Multiplier: scenario.tp2Multiplier,
      },
      fibPullbackParams: {},
    });

    const result = engine.run(candles5m, 'volume_spike', pairAddress);
    results.push({ scenario, result });
  }

  // Print comparison table
  console.log('┌───────────────────────┬────────┬────────┬────────┬─────────┬─────────┬────────┬──────────┐');
  console.log('│ Scenario              │ Trades │ WinR%  │ Avg W  │ Avg L   │ R:R     │ PnL    │ Sharpe   │');
  console.log('├───────────────────────┼────────┼────────┼────────┼─────────┼─────────┼────────┼──────────┤');

  for (const { scenario, result } of results) {
    const wr = (result.winRate * 100).toFixed(1);
    const avgW = result.avgWinPct.toFixed(2);
    const avgL = result.avgLossPct.toFixed(2);
    const rr = result.losses > 0
      ? (Math.abs(result.avgWinPct) / Math.abs(result.avgLossPct)).toFixed(2)
      : '∞';
    const pnl = result.netPnl.toFixed(4);
    const sharpe = result.sharpeRatio.toFixed(2);

    console.log(
      `│ ${scenario.label.padEnd(21)} │ ${String(result.totalTrades).padStart(6)} │ ${wr.padStart(6)} │ ${avgW.padStart(6)} │ ${avgL.padStart(7)} │ ${rr.padStart(7)} │ ${pnl.padStart(6)} │ ${sharpe.padStart(8)} │`
    );
  }
  console.log('└───────────────────────┴────────┴────────┴────────┴─────────┴─────────┴────────┴──────────┘');

  // TP1 hit rate analysis
  console.log('\n─── TP1 Hit Rate Analysis ───\n');

  for (const { scenario, result } of results) {
    const tp1Exits = result.trades.filter(t => t.exitReason === 'TAKE_PROFIT_1');
    const tp2Exits = result.trades.filter(t => t.exitReason === 'TAKE_PROFIT_2');
    const slExits = result.trades.filter(t => t.exitReason === 'STOP_LOSS');
    const timeExits = result.trades.filter(t => t.exitReason === 'TIME_STOP');
    const total = result.totalTrades || 1;

    console.log(`${scenario.label}:`);
    console.log(`  TP1: ${tp1Exits.length} (${((tp1Exits.length / total) * 100).toFixed(1)}%)  ` +
      `TP2: ${tp2Exits.length} (${((tp2Exits.length / total) * 100).toFixed(1)}%)  ` +
      `SL: ${slExits.length} (${((slExits.length / total) * 100).toFixed(1)}%)  ` +
      `Time: ${timeExits.length} (${((timeExits.length / total) * 100).toFixed(1)}%)`);

    // Average remaining move after TP1 (for trades that hit TP1 then continued)
    const tp1Trades = result.trades.filter(t =>
      t.peakPrice > 0 && t.entryPrice > 0
    );
    if (tp1Trades.length > 0) {
      const avgPeakFromEntry = tp1Trades.reduce((sum, t) =>
        sum + ((t.peakPrice - t.entryPrice) / t.entryPrice), 0) / tp1Trades.length;
      console.log(`  Avg peak move from entry: ${(avgPeakFromEntry * 100).toFixed(2)}%`);
    }
    console.log();
  }

  // Recommendation
  const best = results.reduce((a, b) =>
    a.result.netPnl > b.result.netPnl ? a : b
  );
  console.log(`═══ Recommendation: ${best.scenario.label} (best PnL: ${best.result.netPnl.toFixed(4)} SOL) ═══\n`);
}

main().catch(console.error);
