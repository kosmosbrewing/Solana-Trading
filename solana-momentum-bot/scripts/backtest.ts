/**
 * 백테스트 CLI
 *
 * 사용법:
 *   npx ts-node scripts/backtest.ts <pair_address> [options]
 *
 * 옵션:
 *   --source db|csv           데이터 소스 (default: db)
 *   --csv-dir ./data          CSV 디렉토리 (source=csv 시)
 *   --strategy a|b|both       전략 선택 (default: both)
 *   --balance 10              초기 잔고 SOL (default: 10)
 *   --slippage 0.30           슬리피지 차감률 (default: 0.30)
 *   --risk 0.01               트레이드당 최대 리스크 (default: 0.01)
 *   --daily-loss 0.05         일일 최대 손실률 (default: 0.05)
 *   --max-losses 3            연속 손실 제한 (default: 3)
 *   --cooldown 30             쿨다운 분 (default: 30)
 *   --start 2024-01-01        시작 날짜
 *   --end 2024-12-31          종료 날짜
 *   --trades                  트레이드 로그 출력
 *   --trades-limit 50         트레이드 로그 제한 (default: all)
 *   --equity                  equity curve 출력
 *   --export-csv ./out        트레이드+equity CSV 내보내기
 *   --vol-mult 3.0            Volume Spike 배수
 *   --vol-lookback 20         Volume Spike 룩백
 *   --pump-candles 3          Pump 연속 양봉 수
 *   --pump-move 0.05          Pump 최소 변동률
 */
import { Pool } from 'pg';
import * as fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { BacktestEngine, BacktestReporter, CsvLoader, DbLoader, BacktestConfig, DEFAULT_BACKTEST_CONFIG } from '../src/backtest';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const args = process.argv.slice(2);
  const pairAddress = args.find(a => !a.startsWith('--'));

  if (!pairAddress) {
    console.error('Usage: npx ts-node scripts/backtest.ts <pair_address> [options]');
    console.error('Run with --help for all options');
    process.exit(1);
  }

  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  // Parse config from CLI args
  const config: Partial<BacktestConfig> = {
    initialBalance: numArg(args, '--balance', DEFAULT_BACKTEST_CONFIG.initialBalance),
    slippageDeduction: numArg(args, '--slippage', DEFAULT_BACKTEST_CONFIG.slippageDeduction),
    maxRiskPerTrade: numArg(args, '--risk', DEFAULT_BACKTEST_CONFIG.maxRiskPerTrade),
    maxDailyLoss: numArg(args, '--daily-loss', DEFAULT_BACKTEST_CONFIG.maxDailyLoss),
    maxConsecutiveLosses: numArg(args, '--max-losses', DEFAULT_BACKTEST_CONFIG.maxConsecutiveLosses),
    cooldownMinutes: numArg(args, '--cooldown', DEFAULT_BACKTEST_CONFIG.cooldownMinutes),
    volumeSpikeParams: {
      volumeMultiplier: numArg(args, '--vol-mult', undefined),
      lookback: numArg(args, '--vol-lookback', undefined),
    },
    pumpDetectParams: {
      consecutiveCandles: numArg(args, '--pump-candles', undefined),
      minPriceMove: numArg(args, '--pump-move', undefined),
    },
  };

  // Remove undefined params to keep defaults
  cleanUndefined(config.volumeSpikeParams!);
  cleanUndefined(config.pumpDetectParams!);

  // Date range
  const startStr = getArg(args, '--start');
  const endStr = getArg(args, '--end');
  if (startStr) config.startDate = new Date(startStr);
  if (endStr) config.endDate = new Date(endStr);

  // Data source
  const source = getArg(args, '--source') || 'db';
  const strategy = getArg(args, '--strategy') || 'both';
  const showTrades = args.includes('--trades');
  const tradesLimit = numArg(args, '--trades-limit', undefined);
  const showEquity = args.includes('--equity');
  const exportDir = getArg(args, '--export-csv');

  // Load data
  let candles5m: any[] = [];
  let candles1m: any[] = [];

  if (source === 'csv') {
    const csvDir = getArg(args, '--csv-dir') || path.resolve(__dirname, '../data');
    const loader = new CsvLoader(csvDir);

    if (strategy === 'a' || strategy === 'both') {
      try { candles5m = await loader.load(pairAddress, 300); } catch (e) {
        console.warn(`No 5m CSV data: ${e}`);
      }
    }
    if (strategy === 'b' || strategy === 'both') {
      try { candles1m = await loader.load(pairAddress, 60); } catch (e) {
        console.warn(`No 1m CSV data: ${e}`);
      }
    }
  } else {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.error('DATABASE_URL not set. Use --source csv for DB-free mode.');
      process.exit(1);
    }
    const pool = new Pool({ connectionString: databaseUrl });
    const loader = new DbLoader(pool);

    if (strategy === 'a' || strategy === 'both') {
      candles5m = await loader.load(pairAddress, 300);
    }
    if (strategy === 'b' || strategy === 'both') {
      candles1m = await loader.load(pairAddress, 60);
    }

    await pool.end();
  }

  // Run backtest
  const engine = new BacktestEngine(config);
  const reporter = new BacktestReporter();

  if (strategy === 'both') {
    if (candles5m.length === 0 && candles1m.length === 0) {
      console.error('No candle data found for either timeframe.');
      process.exit(1);
    }

    const { strategyA, strategyB, combined } = engine.runCombined(
      candles5m, candles1m, pairAddress
    );

    if (candles5m.length > 0) {
      reporter.printSummary(strategyA);
      if (showTrades) reporter.printTradeLog(strategyA.trades, tradesLimit);
      if (showEquity) reporter.printEquityCurve(strategyA);
    } else {
      console.log('\nNo 5m candles — Strategy A skipped');
    }

    if (candles1m.length > 0) {
      reporter.printSummary(strategyB);
      if (showTrades) reporter.printTradeLog(strategyB.trades, tradesLimit);
      if (showEquity) reporter.printEquityCurve(strategyB);
    } else {
      console.log('\nNo 1m candles — Strategy B skipped');
    }

    if (strategyA.totalTrades + strategyB.totalTrades > 0) {
      reporter.printSummary(combined);
      if (showEquity) reporter.printEquityCurve(combined);
    }

    if (exportDir) {
      exportResults(reporter, exportDir, strategyA, strategyB, combined);
    }
  } else {
    const candles = strategy === 'a' ? candles5m : candles1m;
    const stratName = strategy === 'a' ? 'volume_spike' as const : 'pump_detect' as const;

    if (candles.length === 0) {
      console.error(`No candle data for strategy ${strategy.toUpperCase()}.`);
      process.exit(1);
    }

    const result = engine.run(candles, stratName, pairAddress);
    reporter.printSummary(result);
    if (showTrades) reporter.printTradeLog(result.trades, tradesLimit);
    if (showEquity) reporter.printEquityCurve(result);

    if (exportDir) {
      if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
      fs.writeFileSync(
        path.join(exportDir, `trades_${stratName}.csv`),
        reporter.exportTradesCsv(result.trades)
      );
      fs.writeFileSync(
        path.join(exportDir, `equity_${stratName}.csv`),
        reporter.exportEquityCsv(result)
      );
      console.log(`\nCSV exported to ${exportDir}`);
    }
  }
}

function exportResults(
  reporter: BacktestReporter,
  dir: string,
  a: any, b: any, combined: any
) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (a.totalTrades > 0) {
    fs.writeFileSync(path.join(dir, 'trades_volume_spike.csv'), reporter.exportTradesCsv(a.trades));
    fs.writeFileSync(path.join(dir, 'equity_volume_spike.csv'), reporter.exportEquityCsv(a));
  }
  if (b.totalTrades > 0) {
    fs.writeFileSync(path.join(dir, 'trades_pump_detect.csv'), reporter.exportTradesCsv(b.trades));
    fs.writeFileSync(path.join(dir, 'equity_pump_detect.csv'), reporter.exportEquityCsv(b));
  }
  if (combined.totalTrades > 0) {
    fs.writeFileSync(path.join(dir, 'trades_combined.csv'), reporter.exportTradesCsv(combined.trades));
    fs.writeFileSync(path.join(dir, 'equity_combined.csv'), reporter.exportEquityCsv(combined));
  }
  console.log(`\nCSV exported to ${dir}`);
}

// ─── Arg Helpers ───

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function numArg(args: string[], flag: string, fallback: number | undefined): any {
  const raw = getArg(args, flag);
  if (raw === undefined) return fallback;
  const num = Number(raw);
  if (Number.isNaN(num)) {
    console.error(`Invalid number for ${flag}: "${raw}"`);
    process.exit(1);
  }
  return num;
}

function cleanUndefined(obj: Record<string, any>) {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
}

function printHelp() {
  console.log(`
Solana Momentum Bot — Backtest CLI

Usage:
  npx ts-node scripts/backtest.ts <pair_address> [options]

Data Source:
  --source db|csv           Data source (default: db)
  --csv-dir ./data          CSV directory (when source=csv)

Strategy:
  --strategy a|b|both       Strategy selection (default: both)
                            a = Volume Spike Breakout (5m)
                            b = Pump Detection (1m)

Risk Parameters:
  --balance 10              Initial balance in SOL (default: 10)
  --slippage 0.30           Slippage deduction ratio (default: 0.30)
  --risk 0.01               Max risk per trade (default: 0.01)
  --daily-loss 0.05         Max daily loss ratio (default: 0.05)
  --max-losses 3            Consecutive loss limit (default: 3)
  --cooldown 30             Cooldown minutes (default: 30)

Strategy Parameters:
  --vol-mult 3.0            Volume spike multiplier
  --vol-lookback 20         Volume spike lookback
  --pump-candles 3          Pump consecutive candles
  --pump-move 0.05          Pump min price move

Date Range:
  --start 2024-01-01        Start date (ISO)
  --end 2024-12-31          End date (ISO)

Output:
  --trades                  Show trade log
  --trades-limit 50         Limit trade log entries
  --equity                  Show equity curve (ASCII)
  --export-csv ./out        Export trades + equity to CSV
  `);
}

main().catch(error => {
  console.error('Backtest failed:', error);
  process.exit(1);
});
