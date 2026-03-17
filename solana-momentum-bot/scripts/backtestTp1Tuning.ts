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
 *     [--bootstrap-resamples 10000] [--permutations 10000]
 */
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  BacktestEngine,
  BacktestResult,
  CsvLoader,
  DbLoader,
  DEFAULT_BACKTEST_CONFIG,
  bootstrapMeanCI,
  permutationTestPValue,
} from '../src/backtest';
import type { Candle } from '../src/utils/types';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

export interface Tp1Scenario {
  label: string;
  tp1Multiplier: number;
  tp2Multiplier: number;
}

// M-16: 기본 시나리오 — CLI에서 --scenarios <json_path>로 override 가능
const DEFAULT_SCENARIOS: Tp1Scenario[] = [
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
  const bootstrapResamples = args.includes('--bootstrap-resamples')
    ? Number(args[args.indexOf('--bootstrap-resamples') + 1])
    : 10_000;
  const permutationCount = args.includes('--permutations')
    ? Number(args[args.indexOf('--permutations') + 1])
    : 10_000;

  // M-16: 외부 시나리오 파일 로드
  let scenarios = DEFAULT_SCENARIOS;
  if (args.includes('--scenarios')) {
    const scenarioPath = args[args.indexOf('--scenarios') + 1];
    scenarios = JSON.parse(fs.readFileSync(scenarioPath, 'utf-8')) as Tp1Scenario[];
    console.log(`Loaded ${scenarios.length} scenarios from ${scenarioPath}`);
  }

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
    try {
      const loader = new DbLoader(pool);
      candles5m = await loader.load(pairAddress, 300);
    } finally {
      await pool.end();
    }
  }

  if (candles5m.length === 0) {
    console.error('No candle data found');
    process.exit(1);
  }

  console.log(`\n═══ TP1 Tuning Backtest: ${pairAddress.slice(0, 12)}... ═══`);
  console.log(`Candles: ${candles5m.length} (5m)\n`);

  // Run each scenario
  const results: { scenario: Tp1Scenario; result: BacktestResult }[] = [];

  for (const scenario of scenarios) {
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

  // H-15: 통계적 유의성 검정
  console.log('─── Statistical Significance ───\n');

  const baseline = results[0]; // 첫 번째 시나리오를 baseline으로
  const baselineReturns = baseline.result.trades.map(t => t.pnlPct);
  const baselinePnlSeries = baseline.result.trades.map(t => t.pnlSol);
  const baselinePnlCI = bootstrapMeanCI(baselinePnlSeries, {
    nResamples: bootstrapResamples,
  });

  console.log(`Baseline: ${baseline.scenario.label}`);
  console.log(`  PnL 95% CI: [${baselinePnlCI.lower.toFixed(4)}, ${baselinePnlCI.upper.toFixed(4)}]`);
  console.log(`  Win Rate 95% CI: ${(() => {
    const wins = baselineReturns.map(r => r > 0 ? 1 : 0);
    const ci = bootstrapMeanCI(wins, { nResamples: bootstrapResamples });
    return `[${(ci.lower * 100).toFixed(1)}%, ${(ci.upper * 100).toFixed(1)}%]`;
  })()}`);
  console.log();

  for (let i = 1; i < results.length; i++) {
    const alt = results[i];
    const altReturns = alt.result.trades.map(t => t.pnlPct);
    const altPnlCI = bootstrapMeanCI(alt.result.trades.map(t => t.pnlSol), {
      nResamples: bootstrapResamples,
    });

    // Permutation test: alt가 baseline과 다른지
    const pValue = permutationTestPValue(altReturns, baselineReturns, {
      nPermutations: permutationCount,
      alternative: 'two-sided',
    });
    const significance = pValue < 0.01 ? '***' : pValue < 0.05 ? '**' : pValue < 0.10 ? '*' : 'n.s.';

    console.log(`${alt.scenario.label} vs Baseline:`);
    console.log(`  PnL 95% CI: [${altPnlCI.lower.toFixed(4)}, ${altPnlCI.upper.toFixed(4)}]`);
    console.log(`  p-value: ${pValue.toFixed(4)} ${significance}`);
    console.log(`  ${pValue < 0.05 ? '→ 통계적으로 유의한 차이 있음' : '→ 유의한 차이 없음 (α=0.05)'}`);
    console.log();
  }

  console.log('  *** p<0.01  ** p<0.05  * p<0.10  n.s. = not significant\n');

  // Recommendation
  const best = results.reduce((a, b) =>
    a.result.netPnl > b.result.netPnl ? a : b
  );
  const bestReturns = best.result.trades.map(t => t.pnlPct);
  const bestPValue = best === baseline ? NaN : permutationTestPValue(bestReturns, baselineReturns, {
    nPermutations: permutationCount,
    alternative: 'two-sided',
  });
  const statNote = isNaN(bestPValue) ? '(baseline)' :
    bestPValue < 0.05 ? `(p=${bestPValue.toFixed(4)}, 유의)` : `(p=${bestPValue.toFixed(4)}, 유의하지 않음 — 주의 필요)`;
  console.log(`═══ Recommendation: ${best.scenario.label} (best PnL: ${best.result.netPnl.toFixed(4)} SOL) ${statNote} ═══\n`);
}

main().catch(console.error);
