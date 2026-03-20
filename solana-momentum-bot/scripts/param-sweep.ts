#!/usr/bin/env ts-node
/**
 * v4 Step 6C: 파라미터 스윕 CLI
 *
 * Usage:
 *   npx ts-node scripts/param-sweep.ts \
 *     --strategy volume_spike \
 *     --candles data/BONK-5m.csv \
 *     --objective sharpeRatio \
 *     --min-trades 20 \
 *     --top 10
 *
 *   npx ts-node scripts/param-sweep.ts \
 *     --strategy fib_pullback \
 *     --candles data/WIF-5m.csv \
 *     --walk-forward 0.7 \
 *     --top 5
 */

import fs from 'fs';
import path from 'path';
import { Candle, StrategyName } from '../src/utils/types';
import {
  runParameterSweep,
  formatSweepReport,
  SweepConfig,
  ParamRange,
  ObjectiveMetric,
} from '../src/backtest/paramSweep';

// ─── Arg Parsing ───

function parseArgs(): {
  strategy: StrategyName | 'combined';
  candlePath: string;
  objective: ObjectiveMetric;
  minTrades: number;
  top: number;
  walkForward: number;
  crossValidate: number;
} {
  const args = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
  };

  return {
    strategy: get('--strategy', 'volume_spike') as StrategyName | 'combined',
    candlePath: get('--candles', ''),
    objective: get('--objective', 'sharpeRatio') as ObjectiveMetric,
    minTrades: parseInt(get('--min-trades', '20'), 10),
    top: parseInt(get('--top', '10'), 10),
    walkForward: parseFloat(get('--walk-forward', '0')),
    crossValidate: parseInt(get('--cross-validate', '0'), 10),
  };
}

// ─── CSV Loader ───

function loadCandles(filePath: string): Candle[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const header = lines[0].split(',');

  return lines.slice(1).map(line => {
    const cols = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h.trim()] = cols[i]?.trim() || ''; });

    // Why: CSV timestamp가 unix epoch (초)인 경우 변환
    const rawTs = row.timestamp || row.time || row.date;
    const tsNum = Number(rawTs);
    const ts = !isNaN(tsNum) && tsNum > 1_000_000_000 && tsNum < 2_000_000_000_000
      ? new Date(tsNum < 1e12 ? tsNum * 1000 : tsNum)
      : new Date(rawTs);

    return {
      pairAddress: 'SWEEP',
      timestamp: ts,
      intervalSec: 300,
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume),
      buyVolume: parseFloat(row.buyVolume || row.buy_volume || '0'),
      sellVolume: parseFloat(row.sellVolume || row.sell_volume || '0'),
      tradeCount: parseInt(row.tradeCount || row.trade_count || '0', 10),
    };
  }).filter(c => !isNaN(c.close) && !isNaN(c.volume));
}

// ─── Default Sweep Params ───

function getDefaultParams(strategy: StrategyName | 'combined'): Record<string, ParamRange> {
  const common: Record<string, ParamRange> = {
    maxRiskPerTrade: { min: 0.005, max: 0.025, step: 0.005 },
    minBreakoutScore: { min: 40, max: 70, step: 10 },
    minBuyRatio: { min: 0.55, max: 0.75, step: 0.05 },
  };

  if (strategy === 'volume_spike' || strategy === 'combined') {
    return {
      ...common,
      volumeMultiplier: { min: 2.0, max: 4.0, step: 0.5 },
      tp1MultiplierA: { min: 1.0, max: 2.0, step: 0.25 },
      tp2MultiplierA: { min: 2.0, max: 3.5, step: 0.5 },
    };
  }

  if (strategy === 'fib_pullback') {
    return {
      ...common,
      impulseMinPct: { min: 0.10, max: 0.20, step: 0.025 },
      tp1MultiplierC: { min: 0.80, max: 0.95, step: 0.05 },
    };
  }

  return common;
}

// ─── Main ───

async function main() {
  const args = parseArgs();

  if (!args.candlePath) {
    console.error('Error: --candles <path> required');
    process.exit(1);
  }

  console.log(`Loading candles from ${args.candlePath}...`);
  const candles = loadCandles(args.candlePath);
  console.log(`Loaded ${candles.length} candles`);

  const params = getDefaultParams(args.strategy);
  const totalCombos = Object.values(params).reduce((prod, p) => {
    return prod * (Math.round((p.max - p.min) / p.step) + 1);
  }, 1);
  console.log(`Grid: ${totalCombos} combinations | Strategy: ${args.strategy} | Objective: ${args.objective}`);

  const sweepConfig: SweepConfig = {
    params,
    objective: args.objective,
    constraints: {
      minTrades: args.minTrades,
    },
    topN: args.top,
    walkForwardRatio: args.walkForward || undefined,
    crossValidateFolds: args.crossValidate || undefined,
  };

  const startTime = Date.now();
  const results = runParameterSweep(candles, args.strategy, sweepConfig);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\nSweep completed in ${elapsed}s | ${results.length} results passed constraints\n`);
  console.log(formatSweepReport(results, args.objective));

  // JSON 저장
  const resultsDir = path.resolve(__dirname, '../results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(resultsDir, `sweep-${args.strategy}-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ config: sweepConfig, results }, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
