#!/usr/bin/env ts-node

import path from 'path';
import dotenv from 'dotenv';
import { BacktestEngine, DEFAULT_BACKTEST_CONFIG } from '../src/backtest';
import { RealtimeReplayStore } from '../src/realtime';
import { aggregateSessionCandlesToTarget } from '../src/backtest/sessionCandleAggregator';
import type { BacktestConfig, BacktestResult } from '../src/backtest';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

type StrategySelection = 'volume_spike' | 'fib_pullback' | 'both';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const datasetRoot = getArg(args, '--dataset') || './data/realtime';
  const strategy = (getArg(args, '--strategy') || 'both') as StrategySelection;
  if (!['volume_spike', 'fib_pullback', 'both'].includes(strategy)) {
    throw new Error(`Invalid --strategy: ${strategy}`);
  }

  const pairFilter = getArg(args, '--pair');
  const top = numArg(args, '--top', 10);
  const targetIntervalSec = numArg(args, '--target-interval', 300);
  const baseIntervalSec = optionalNumArg(args, '--base-interval');

  const config: Partial<BacktestConfig> = {
    initialBalance: numArg(args, '--balance', DEFAULT_BACKTEST_CONFIG.initialBalance),
    maxRiskPerTrade: numArg(args, '--risk', DEFAULT_BACKTEST_CONFIG.maxRiskPerTrade),
    maxDailyLoss: numArg(args, '--daily-loss', DEFAULT_BACKTEST_CONFIG.maxDailyLoss),
    maxDrawdownPct: numArg(args, '--max-drawdown', DEFAULT_BACKTEST_CONFIG.maxDrawdownPct),
    recoveryPct: numArg(args, '--recovery-pct', DEFAULT_BACKTEST_CONFIG.recoveryPct),
    maxConsecutiveLosses: numArg(args, '--max-losses', DEFAULT_BACKTEST_CONFIG.maxConsecutiveLosses),
    cooldownMinutes: numArg(args, '--cooldown', DEFAULT_BACKTEST_CONFIG.cooldownMinutes),
    minBuyRatio: numArg(args, '--min-buy-ratio', DEFAULT_BACKTEST_CONFIG.minBuyRatio),
    minBreakoutScore: numArg(args, '--min-score', DEFAULT_BACKTEST_CONFIG.minBreakoutScore),
    volumeSpikeParams: {
      volumeMultiplier: optionalNumArg(args, '--vol-mult'),
      lookback: optionalNumArg(args, '--vol-lookback'),
      tp1Multiplier: optionalNumArg(args, '--vol-tp1'),
      tp2Multiplier: optionalNumArg(args, '--vol-tp2'),
      slAtrMultiplier: optionalNumArg(args, '--vol-sl-atr'),
      timeStopMinutes: optionalNumArg(args, '--vol-time-stop'),
    },
    fibPullbackParams: {
      impulseWindowBars: optionalNumArg(args, '--fib-impulse-bars'),
      impulseMinPct: optionalNumArg(args, '--fib-impulse-min-pct'),
      tp1Multiplier: optionalNumArg(args, '--fib-tp1'),
      tp2Multiplier: optionalNumArg(args, '--fib-tp2'),
      timeStopMinutes: optionalNumArg(args, '--fib-time-stop'),
    },
  };
  cleanUndefined(config.volumeSpikeParams!);
  cleanUndefined(config.fibPullbackParams!);

  const store = new RealtimeReplayStore(path.resolve(datasetRoot));
  const microCandles = await store.loadCandles();
  const aggregation = aggregateSessionCandlesToTarget(microCandles, {
    targetIntervalSec,
    baseIntervalSec,
  });

  const selectedPairs = [...aggregation.byPair.keys()]
    .filter((pairAddress) => !pairFilter || pairAddress === pairFilter)
    .sort();
  if (selectedPairs.length === 0) {
    throw new Error(pairFilter
      ? `Pair not found in session candles: ${pairFilter}`
      : 'No pairs found in session candles');
  }

  const engine = new BacktestEngine(config);
  const summaries = selectedPairs.flatMap((pairAddress) => {
    const candles = aggregation.byPair.get(pairAddress) ?? [];
    if (candles.length === 0) return [];

    if (strategy === 'both') {
      const combined = engine.runCombined(candles, pairAddress);
      return [
        buildSummary(combined.strategyA),
        buildSummary(combined.strategyC),
        buildSummary(combined.combined),
      ];
    }

    return [buildSummary(engine.run(candles, strategy, pairAddress))];
  });

  summaries.sort((left, right) =>
    right.netPnlPct - left.netPnlPct
    || right.totalTrades - left.totalTrades
    || left.pairAddress.localeCompare(right.pairAddress)
  );

  const output = {
    datasetRoot: path.resolve(datasetRoot),
    datasetDir: store.datasetDir,
    replayMode: 'price_replay_only',
    caveats: [
      'session-backtest replays price action from session micro-candles only',
      'runtime gate/risk/execution metadata is not reconstructed unless separately supplied',
      'results are useful for Strategy A/C price-response screening, not live-equivalent expectancy',
    ],
    targetIntervalSec,
    baseIntervalSec: aggregation.baseIntervalSec,
    pairCount: selectedPairs.length,
    strategy,
    summaries,
  };

  if (args.includes('--json')) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log('\nSession Strategy Price Replay');
  console.log('='.repeat(72));
  console.log(`Dataset : ${output.datasetDir}`);
  console.log(`Pairs   : ${selectedPairs.length}`);
  console.log(`Candles : ${targetIntervalSec}s (base ${aggregation.baseIntervalSec}s)`);
  console.log(`Mode    : ${strategy}`);
  console.log('Scope   : price replay only (not runtime-equivalent gate/execution)');
  console.log('='.repeat(72));
  console.log(
    `${pad('Rank', 5)}${pad('Strategy', 18)}${pad('Pair', 16)}${pad('Trades', 8)}${pad('Win%', 8)}${pad('Net%', 10)}${pad('PF', 8)}${pad('DD%', 8)}`
  );
  console.log('-'.repeat(72));

  for (const [index, item] of summaries.slice(0, top).entries()) {
    console.log(
      `${pad(String(index + 1), 5)}`
      + `${pad(item.strategy, 18)}`
      + `${pad(short(item.pairAddress), 16)}`
      + `${pad(String(item.totalTrades), 8)}`
      + `${pad((item.winRate * 100).toFixed(1), 8)}`
      + `${pad(formatPct(item.netPnlPct), 10)}`
      + `${pad(Number.isFinite(item.profitFactor) ? item.profitFactor.toFixed(2) : 'inf', 8)}`
      + `${pad((item.maxDrawdownPct * 100).toFixed(1), 8)}`
    );
  }
}

function buildSummary(result: BacktestResult) {
  return {
    pairAddress: result.pairAddress,
    strategy: result.strategy,
    candleCount: result.candleCount,
    totalTrades: result.totalTrades,
    wins: result.wins,
    losses: result.losses,
    winRate: result.winRate,
    netPnl: result.netPnl,
    netPnlPct: result.netPnlPct,
    finalEquity: result.finalEquity,
    profitFactor: result.profitFactor,
    maxDrawdownPct: result.maxDrawdownPct,
    avgWinPct: result.avgWinPct,
    avgLossPct: result.avgLossPct,
  };
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function numArg(args: string[], flag: string, fallback: number): number {
  const raw = getArg(args, flag);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number for ${flag}: ${raw}`);
  }
  return value;
}

function optionalNumArg(args: string[], flag: string): number | undefined {
  const raw = getArg(args, flag);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number for ${flag}: ${raw}`);
  }
  return value;
}

function cleanUndefined(record: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) {
      delete record[key];
    }
  }
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function short(pairAddress: string): string {
  return pairAddress.length <= 14 ? pairAddress : `${pairAddress.slice(0, 6)}…${pairAddress.slice(-7)}`;
}

function formatPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}`;
}

function printHelp() {
  console.log(`
Usage:
  npx ts-node scripts/session-backtest.ts --dataset <PATH> [options]

Purpose:
  Replay session micro-candles into 300s candles and run Strategy A/C price replay.
  This is not a live-equivalent runtime backtest.

Options:
  --dataset <path>              Session dataset dir or realtime root (default: ./data/realtime)
  --strategy <name>             volume_spike | fib_pullback | both (default: both)
  --pair <address>              Restrict to a single pair
  --target-interval <sec>       Aggregated candle interval (default: 300)
  --base-interval <sec>         Source micro-candle interval override (default: smallest divisor)
  --top <n>                     Number of rows to print (default: 10)
  --json                        Print JSON output

Risk/backtest overrides:
  --balance <sol>               Initial balance
  --risk <pct>                  Max risk per trade
  --daily-loss <pct>            Max daily loss
  --max-drawdown <pct>          Max drawdown
  --max-losses <n>              Max consecutive losses
  --cooldown <min>              Cooldown minutes
  --min-buy-ratio <n>           Gate min buy ratio
  --min-score <n>               Gate min breakout score
  --vol-mult <n>                Volume Spike multiplier override
  --vol-lookback <n>            Volume Spike lookback override
  --vol-tp1 <n>                 Volume Spike TP1 ATR multiplier override
  --vol-tp2 <n>                 Volume Spike TP2 ATR multiplier override
  --vol-sl-atr <n>              Volume Spike SL ATR multiplier override
  --vol-time-stop <min>         Volume Spike time stop override
  --fib-impulse-bars <n>        Fib impulse window bars override
  --fib-impulse-min-pct <n>     Fib minimum impulse pct override
  --fib-tp1 <n>                 Fib TP1 multiplier override
  --fib-tp2 <n>                 Fib TP2 multiplier override
  --fib-time-stop <min>         Fib time stop override

Examples:
  npx ts-node scripts/session-backtest.ts --dataset ./data/realtime/sessions/2026-04-05T05-24-58-037Z-live --strategy both
  npx ts-node scripts/session-backtest.ts --dataset ./data/realtime --strategy volume_spike --pair <pair> --json
`);
}

main().catch((error) => {
  console.error(`Session strategy backtest failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
