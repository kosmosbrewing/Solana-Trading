#!/usr/bin/env ts-node
/**
 * 다중 토큰 교차 검증 파라미터 스윕
 *
 * 개별 토큰 walk-forward는 트레이드 수 부족으로 무의미.
 * 대신: 전체 토큰에 대해 그리드 서치 → 토큰 간 일관성 기반 최적 파라미터 도출.
 *
 * 방법:
 *   1. 각 토큰별 그리드 서치 (walk-forward 없음)
 *   2. 파라미터 조합별 "다중 토큰 평균 성과" 계산
 *   3. "양수 토큰 비율 ≥ 60%" 필터 → 과적합 방지
 *   4. 평균 Sharpe 순 정렬
 */

import fs from 'fs';
import path from 'path';
import { Candle, StrategyName } from '../src/utils/types';
import { BacktestEngine } from '../src/backtest/engine';
import { BacktestConfig, DEFAULT_BACKTEST_CONFIG } from '../src/backtest/types';
import {
  ParamRange,
  ObjectiveMetric,
  SweepMetrics,
  generateGrid,
} from '../src/backtest/paramSweep';
import {
  assessBacktestStage,
  BacktestStageDecision,
  EdgeGateStatus,
  EdgeScoreBreakdown,
} from '../src/reporting/measurement';

// ─── CSV Loader ───

function loadCandles(filePath: string): Candle[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const header = lines[0].split(',');

  return lines.slice(1).map(line => {
    const cols = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h.trim()] = cols[i]?.trim() || ''; });

    const rawTs = row.timestamp || row.time || row.date;
    const tsNum = Number(rawTs);
    const ts = !isNaN(tsNum) && tsNum > 1_000_000_000 && tsNum < 2_000_000_000_000
      ? new Date(tsNum < 1e12 ? tsNum * 1000 : tsNum)
      : new Date(rawTs);

    return {
      pairAddress: path.basename(filePath, '.csv'),
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

// ─── Config Mapping ───

function applyParams(
  base: BacktestConfig,
  params: Record<string, number>,
  strategy: StrategyName | 'combined'
): BacktestConfig {
  const config = JSON.parse(JSON.stringify(base)) as BacktestConfig;
  for (const [key, value] of Object.entries(params)) {
    switch (key) {
      case 'maxRiskPerTrade': config.maxRiskPerTrade = value; break;
      case 'minBreakoutScore': config.minBreakoutScore = value; break;
      case 'minBuyRatio': config.minBuyRatio = value; break;
      case 'volumeMultiplier': config.volumeSpikeParams.volumeMultiplier = value; break;
      case 'tp1MultiplierA': config.volumeSpikeParams.tp1Multiplier = value; break;
      case 'tp2MultiplierA': config.volumeSpikeParams.tp2Multiplier = value; break;
      case 'impulseMinPct': config.fibPullbackParams.impulseMinPct = value; break;
      case 'tp1MultiplierC': config.fibPullbackParams.tp1Multiplier = value; break;
      default:
        if (key in config) (config as any)[key] = value;
    }
  }
  return config;
}

function extractMetrics(result: any): SweepMetrics {
  return {
    netPnlPct: result.netPnlPct,
    winRate: result.winRate,
    sharpeRatio: result.sharpeRatio,
    profitFactor: result.profitFactor,
    maxDrawdownPct: result.maxDrawdownPct,
    totalTrades: result.totalTrades,
    expectancyR: calcExpectancyR(result),
  };
}

// ─── Default Param Ranges ───

function getDefaultParams(strategy: StrategyName | 'combined'): Record<string, ParamRange> {
  const common: Record<string, ParamRange> = {
    maxRiskPerTrade: { min: 0.005, max: 0.025, step: 0.005 },
    minBreakoutScore: { min: 40, max: 70, step: 10 },
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

// ─── Multi-Token Sweep Result ───

interface MultiTokenResult {
  rank: number;
  params: Record<string, number>;
  avgSharpe: number;
  avgPnlPct: number;
  avgWinRate: number;
  avgPF: number;
  avgMaxDD: number;
  avgExpectancyR: number;
  edgeScore: number;
  stageScore: number;
  stageDecision: BacktestStageDecision;
  edgeGateStatus: EdgeGateStatus;
  edgeGateReasons: string[];
  edgeScoreBreakdown: EdgeScoreBreakdown;
  totalTrades: number;
  positiveTokens: number;
  totalTokens: number;
  positiveRatio: number;
  perToken: { name: string; metrics: SweepMetrics }[];
}

// ─── Args ───

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
  };
  return {
    strategy: get('--strategy', 'volume_spike') as StrategyName | 'combined',
    objective: get('--objective', 'sharpeRatio') as ObjectiveMetric,
    top: parseInt(get('--top', '15'), 10),
    minTotalTrades: parseInt(get('--min-total-trades', '10'), 10),
    minPositiveRatio: parseFloat(get('--min-positive-ratio', '0.5')),
  };
}

// ─── Main ───

async function main() {
  const args = parseArgs();

  // 모든 CSV 파일 로드
  const dataDir = path.resolve(__dirname, '../data');
  const csvFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv')).sort();

  console.log(`Loading ${csvFiles.length} token data files...`);
  const tokenData: { name: string; candles: Candle[] }[] = [];
  for (const file of csvFiles) {
    const candles = loadCandles(path.join(dataDir, file));
    const name = file.replace('_300.csv', '').slice(0, 8);
    tokenData.push({ name, candles });
    console.log(`  ${name}: ${candles.length} candles`);
  }

  const params = getDefaultParams(args.strategy);
  const grid = generateGrid(params);
  const runStrategy = args.strategy === 'combined' ? 'volume_spike' as StrategyName : args.strategy;

  console.log(`\nGrid: ${grid.length} combinations × ${tokenData.length} tokens = ${grid.length * tokenData.length} runs`);
  console.log(`Strategy: ${args.strategy} | Objective: ${args.objective}`);
  console.log(`Filters: minTotalTrades=${args.minTotalTrades}, minPositiveRatio=${args.minPositiveRatio}\n`);

  const startTime = Date.now();
  const results: MultiTokenResult[] = [];

  for (let g = 0; g < grid.length; g++) {
    const paramCombo = grid[g];
    const config = applyParams({ ...DEFAULT_BACKTEST_CONFIG }, paramCombo, args.strategy);

    const perToken: { name: string; metrics: SweepMetrics }[] = [];
    let totalTrades = 0;
    let positiveTokens = 0;

    for (const { name, candles } of tokenData) {
      try {
        const engine = new BacktestEngine(config);
        const result = engine.run(candles, runStrategy, name);
        const metrics = extractMetrics(result);
        perToken.push({ name, metrics });
        totalTrades += metrics.totalTrades;
        if (metrics.netPnlPct > 0) positiveTokens++;
      } catch {
        perToken.push({
          name,
          metrics: {
            netPnlPct: 0,
            winRate: 0,
            sharpeRatio: 0,
            profitFactor: 0,
            maxDrawdownPct: 0,
            totalTrades: 0,
            expectancyR: 0,
          },
        });
      }
    }

    const activeTokens = perToken.filter(t => t.metrics.totalTrades > 0);
    const totalTokens = activeTokens.length;
    const positiveRatio = totalTokens > 0 ? positiveTokens / totalTokens : 0;

    // Constraint filter
    if (totalTrades < args.minTotalTrades) continue;
    if (positiveRatio < args.minPositiveRatio) continue;

    const avgSharpe = totalTokens > 0
      ? activeTokens.reduce((s, t) => s + t.metrics.sharpeRatio, 0) / totalTokens : 0;
    const avgPnlPct = totalTokens > 0
      ? activeTokens.reduce((s, t) => s + t.metrics.netPnlPct, 0) / totalTokens : 0;
    const avgWinRate = totalTokens > 0
      ? activeTokens.reduce((s, t) => s + t.metrics.winRate, 0) / totalTokens : 0;
    const avgPF = totalTokens > 0
      ? activeTokens.reduce((s, t) => s + (isFinite(t.metrics.profitFactor) ? t.metrics.profitFactor : 5), 0) / totalTokens : 0;
    const avgMaxDD = totalTokens > 0
      ? Math.max(...activeTokens.map(t => t.metrics.maxDrawdownPct)) : 0;
    const avgExpectancyR = totalTokens > 0
      ? activeTokens.reduce((s, t) => s + t.metrics.expectancyR, 0) / totalTokens : 0;
    const stageAssessment = assessBacktestStage({
      netPnlPct: avgPnlPct,
      expectancyR: avgExpectancyR,
      profitFactor: avgPF,
      sharpeRatio: avgSharpe,
      maxDrawdownPct: avgMaxDD,
      totalTrades,
      positiveTokenRatio: positiveRatio,
    });

    results.push({
      rank: 0,
      params: paramCombo,
      avgSharpe,
      avgPnlPct,
      avgWinRate,
      avgPF,
      avgMaxDD,
      avgExpectancyR,
      edgeScore: stageAssessment.edgeScore,
      stageScore: stageAssessment.stageScore,
      stageDecision: stageAssessment.decision,
      edgeGateStatus: stageAssessment.gateStatus,
      edgeGateReasons: stageAssessment.gateReasons,
      edgeScoreBreakdown: stageAssessment.breakdown,
      totalTrades,
      positiveTokens,
      totalTokens,
      positiveRatio,
      perToken,
    });

    // Progress
    if ((g + 1) % 500 === 0) {
      process.stdout.write(`  ${g + 1}/${grid.length} combos tested...\r`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Sort by objective
  results.sort((a, b) => {
    if (args.objective === 'sharpeRatio') return b.avgSharpe - a.avgSharpe;
    if (args.objective === 'netPnlPct') return b.avgPnlPct - a.avgPnlPct;
    if (args.objective === 'profitFactor') return b.avgPF - a.avgPF;
    if (args.objective === 'expectancyR') return b.avgExpectancyR - a.avgExpectancyR;
    return b.avgSharpe - a.avgSharpe;
  });

  const topN = results.slice(0, args.top);
  topN.forEach((r, i) => { r.rank = i + 1; });

  console.log(`\nSweep completed in ${elapsed}s | ${results.length} combos passed filters\n`);

  // ─── Report ───
  const paramKeys = Object.keys(topN[0]?.params || {});
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  MULTI-TOKEN PARAMETER SWEEP — ${args.strategy.toUpperCase()}`);
  console.log(`  ${tokenData.length} tokens × ${grid.length} combos | Objective: ${args.objective}`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // Header
  const hdr = ['#', ...paramKeys.map(k => k.length > 10 ? k.slice(0, 10) : k),
    'AvgSharpe', 'AvgExpR', 'AvgPnL%', 'AvgWR', 'AvgPF', 'MaxDD%', 'Trades', '+Tokens', 'Edge', 'Decision'];
  console.log(hdr.map(h => h.padStart(11)).join(' '));
  console.log('─'.repeat(hdr.length * 12));

  for (const r of topN) {
    const row = [
      String(r.rank),
      ...paramKeys.map(k => r.params[k].toFixed(3)),
      r.avgSharpe.toFixed(2),
      r.avgExpectancyR.toFixed(2),
      `${(r.avgPnlPct * 100).toFixed(2)}%`,
      `${(r.avgWinRate * 100).toFixed(1)}%`,
      r.avgPF.toFixed(2),
      `${(r.avgMaxDD * 100).toFixed(2)}%`,
      String(r.totalTrades),
      `${r.positiveTokens}/${r.totalTokens}`,
      r.edgeScore.toFixed(1),
      r.stageDecision,
    ];
    console.log(row.map(v => v.padStart(11)).join(' '));
  }

  // Per-token breakdown for #1
  if (topN.length > 0) {
    console.log('\n─── Rank #1 Per-Token Breakdown ───');
    for (const t of topN[0].perToken) {
      if (t.metrics.totalTrades === 0) continue;
      const pnl = (t.metrics.netPnlPct * 100).toFixed(2);
      const wr = (t.metrics.winRate * 100).toFixed(1);
      const sharpe = t.metrics.sharpeRatio.toFixed(2);
      const expectancy = t.metrics.expectancyR.toFixed(2);
      const pf = isFinite(t.metrics.profitFactor) ? t.metrics.profitFactor.toFixed(2) : 'Inf';
      console.log(`  ${t.name}: ${t.metrics.totalTrades} trades | PnL ${pnl}% | WR ${wr}% | ExpR ${expectancy} | Sharpe ${sharpe} | PF ${pf}`);
    }
  }

  // Consistency analysis: which parameters are stable across top results?
  if (topN.length >= 3) {
    console.log('\n─── Parameter Stability (Top results range) ───');
    for (const key of paramKeys) {
      const values = topN.map(r => r.params[key]);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const mode = getModeValue(values);
      console.log(`  ${key.padEnd(20)} range: [${min.toFixed(3)} ~ ${max.toFixed(3)}] | mode: ${mode.toFixed(3)}`);
    }
  }

  // Save JSON
  const resultsDir = path.resolve(__dirname, '../results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(resultsDir, `multi-sweep-${args.strategy}-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    strategy: args.strategy,
    objective: args.objective,
    gridSize: grid.length,
    tokenCount: tokenData.length,
    elapsedSec: parseFloat(elapsed),
    passedCombos: results.length,
    topResults: topN.map(r => ({
      rank: r.rank,
      params: r.params,
      avgSharpe: r.avgSharpe,
      avgPnlPct: r.avgPnlPct,
      avgWinRate: r.avgWinRate,
      avgPF: r.avgPF,
      avgMaxDD: r.avgMaxDD,
      avgExpectancyR: r.avgExpectancyR,
      edgeScore: r.edgeScore,
      stageScore: r.stageScore,
      stageDecision: r.stageDecision,
      edgeGateStatus: r.edgeGateStatus,
      edgeGateReasons: r.edgeGateReasons,
      edgeScoreBreakdown: r.edgeScoreBreakdown,
      totalTrades: r.totalTrades,
      positiveTokens: r.positiveTokens,
      totalTokens: r.totalTokens,
      positiveRatio: r.positiveRatio,
    })),
  }, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

function getModeValue(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) {
    const rounded = Math.round(v * 1000) / 1000;
    counts.set(rounded, (counts.get(rounded) || 0) + 1);
  }
  let maxCount = 0;
  let mode = values[0];
  for (const [v, c] of counts) {
    if (c > maxCount) { maxCount = c; mode = v; }
  }
  return mode;
}

function calcExpectancyR(result: any): number {
  const trades = Array.isArray(result?.trades) ? result.trades : [];
  if (trades.length === 0) return 0;

  const rMultiples = trades
    .map((trade: any) => {
      const plannedRisk = Math.abs(Number(trade.entryPrice) - Number(trade.stopLoss)) * Number(trade.quantity);
      if (!Number.isFinite(plannedRisk) || plannedRisk <= 0) return Number.NaN;
      return Number(trade.pnlSol) / plannedRisk;
    })
    .filter((value: number) => Number.isFinite(value));

  if (rMultiples.length === 0) return 0;
  return rMultiples.reduce((sum: number, value: number) => sum + value, 0) / rMultiples.length;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
