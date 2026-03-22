/**
 * v4 Step 6: 파라미터 스윕 엔진
 * Grid search + walk-forward + cross-validation + stability filter
 */

import { BacktestEngine } from './engine';
import { BacktestConfig, BacktestResult, DEFAULT_BACKTEST_CONFIG } from './types';
import { Candle, StrategyName } from '../utils/types';

// ─── Interfaces ───

export interface ParamRange {
  min: number;
  max: number;
  step: number;
}

export type ObjectiveMetric = 'sharpeRatio' | 'netPnlPct' | 'profitFactor' | 'expectancyR' | 'custom';

export interface SweepConfig {
  params: Record<string, ParamRange>;
  objective: ObjectiveMetric;
  constraints?: {
    minTrades?: number;
    minWinRate?: number;
    maxDrawdownPct?: number;
  };
  topN: number;
  /** Walk-forward split ratio (0~1). 0 = disabled */
  walkForwardRatio?: number;
  /** Time-series cross-validation folds (0 = disabled) */
  crossValidateFolds?: number;
  /** Base config to override */
  baseConfig?: Partial<BacktestConfig>;
}

export interface SweepMetrics {
  netPnlPct: number;
  winRate: number;
  sharpeRatio: number;
  profitFactor: number;
  maxDrawdownPct: number;
  totalTrades: number;
  expectancyR: number;
}

export interface SweepResult {
  rank: number;
  params: Record<string, number>;
  metrics: SweepMetrics;
  /** Walk-forward: out-of-sample 결과 */
  oosMetrics?: SweepMetrics;
  /** Cross-validation: fold별 메트릭 */
  foldMetrics?: SweepMetrics[];
}

// ─── Grid Generation ───

/** 파라미터 범위에서 단계별 값 배열 생성 */
function generateValues(range: ParamRange): number[] {
  const values: number[] = [];
  // Why: 부동소수점 오차 방지를 위해 step count 기반 반복
  const steps = Math.round((range.max - range.min) / range.step);
  for (let i = 0; i <= steps; i++) {
    values.push(range.min + i * range.step);
  }
  return values;
}

/** 모든 파라미터 조합 생성 (cartesian product) */
function generateGrid(params: Record<string, ParamRange>): Record<string, number>[] {
  const keys = Object.keys(params);
  const valueSets = keys.map(k => generateValues(params[k]));

  const combos: Record<string, number>[] = [];
  const indices = new Array(keys.length).fill(0);

  while (true) {
    const combo: Record<string, number> = {};
    for (let i = 0; i < keys.length; i++) {
      combo[keys[i]] = valueSets[i][indices[i]];
    }
    combos.push(combo);

    // Increment
    let carry = true;
    for (let i = keys.length - 1; i >= 0 && carry; i--) {
      indices[i]++;
      if (indices[i] < valueSets[i].length) {
        carry = false;
      } else {
        indices[i] = 0;
      }
    }
    if (carry) break;
  }

  return combos;
}

// ─── Config Mapping ───

/** 스윕 파라미터 이름 → BacktestConfig 경로 매핑 */
function applyParamsToConfig(
  base: BacktestConfig,
  params: Record<string, number>,
  strategy: StrategyName | 'combined'
): BacktestConfig {
  const config = JSON.parse(JSON.stringify(base)) as BacktestConfig;

  for (const [key, value] of Object.entries(params)) {
    switch (key) {
      // Risk
      case 'maxRiskPerTrade': config.maxRiskPerTrade = value; break;
      // Gate
      case 'minBreakoutScore': config.minBreakoutScore = value; break;
      case 'minBuyRatio': config.minBuyRatio = value; break;
      // Strategy A
      case 'volumeMultiplier': config.volumeSpikeParams.volumeMultiplier = value; break;
      case 'tp1Multiplier':
        if (strategy === 'fib_pullback') {
          config.fibPullbackParams.tp1Multiplier = value;
        } else {
          config.volumeSpikeParams.tp1Multiplier = value;
        }
        break;
      case 'tp2Multiplier':
        if (strategy === 'fib_pullback') {
          config.fibPullbackParams.tp2Multiplier = value;
        } else {
          config.volumeSpikeParams.tp2Multiplier = value;
        }
        break;
      case 'tp1MultiplierA': config.volumeSpikeParams.tp1Multiplier = value; break;
      case 'tp2MultiplierA': config.volumeSpikeParams.tp2Multiplier = value; break;
      // Strategy C
      case 'impulseMinPct': config.fibPullbackParams.impulseMinPct = value; break;
      case 'tp1MultiplierC': config.fibPullbackParams.tp1Multiplier = value; break;
      default:
        // 직접 config 최상위에 매핑 시도
        if (key in config) {
          (config as any)[key] = value;
        }
    }
  }

  return config;
}

// ─── Metrics Extraction ───

function extractMetrics(result: BacktestResult): SweepMetrics {
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

function getObjectiveValue(metrics: SweepMetrics, objective: ObjectiveMetric): number {
  switch (objective) {
    case 'sharpeRatio': return metrics.sharpeRatio;
    case 'netPnlPct': return metrics.netPnlPct;
    case 'profitFactor': return metrics.profitFactor;
    case 'expectancyR': return metrics.expectancyR;
    case 'custom': return metrics.sharpeRatio; // fallback
  }
}

// ─── Constraint Filter ───

function passesConstraints(
  metrics: SweepMetrics,
  constraints: SweepConfig['constraints']
): boolean {
  if (!constraints) return true;
  if (constraints.minTrades && metrics.totalTrades < constraints.minTrades) return false;
  if (constraints.minWinRate && metrics.winRate < constraints.minWinRate) return false;
  if (constraints.maxDrawdownPct && metrics.maxDrawdownPct > constraints.maxDrawdownPct) return false;
  return true;
}

// ─── Data Splitting ───

function splitCandles(candles: Candle[], ratio: number): [Candle[], Candle[]] {
  const splitIdx = Math.floor(candles.length * ratio);
  return [candles.slice(0, splitIdx), candles.slice(splitIdx)];
}

function timeSeriesFolds(candles: Candle[], folds: number): [Candle[], Candle[]][] {
  const result: [Candle[], Candle[]][] = [];
  const foldSize = Math.floor(candles.length / (folds + 1));

  for (let i = 0; i < folds; i++) {
    const trainEnd = foldSize * (i + 1);
    const testEnd = Math.min(trainEnd + foldSize, candles.length);
    result.push([candles.slice(0, trainEnd), candles.slice(trainEnd, testEnd)]);
  }

  return result;
}

// ─── Stability Filter (6B) ───

/** top 결과 중 인접 파라미터 조합과 성능 차이 > 50%인 것 제외 */
function applyStabilityFilter(
  results: SweepResult[],
  objective: ObjectiveMetric
): SweepResult[] {
  if (results.length <= 1) return results;

  return results.filter((result, idx) => {
    const myScore = getObjectiveValue(result.metrics, objective);
    if (myScore <= 0) return false;

    // 인접 순위와 비교
    const neighbors = results.filter((_, i) => i !== idx && Math.abs(i - idx) <= 2);
    if (neighbors.length === 0) return true;

    const avgNeighborScore = neighbors.reduce(
      (sum, n) => sum + getObjectiveValue(n.metrics, objective), 0
    ) / neighbors.length;

    // 차이가 50% 초과면 과적합 의심
    return Math.abs(myScore - avgNeighborScore) / avgNeighborScore <= 0.5;
  });
}

// ─── Main Sweep Function ───

export function runParameterSweep(
  candles: Candle[],
  strategy: StrategyName | 'combined',
  sweepConfig: SweepConfig
): SweepResult[] {
  const grid = generateGrid(sweepConfig.params);
  const baseConfig: BacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...sweepConfig.baseConfig,
  };

  // TODO: combined 모드에서 다중 전략 순차 실행 지원 (현재는 volume_spike만)
  const runStrategy = strategy === 'combined' ? 'volume_spike' : strategy;
  const pairAddress = 'SWEEP';

  let allResults: SweepResult[] = [];

  for (const paramCombo of grid) {
    const config = applyParamsToConfig(baseConfig, paramCombo, strategy);

    if (sweepConfig.walkForwardRatio && sweepConfig.walkForwardRatio > 0) {
      // Walk-forward 검증
      const [train, test] = splitCandles(candles, sweepConfig.walkForwardRatio);
      if (train.length < 50 || test.length < 20) continue;

      const trainEngine = new BacktestEngine(config);
      const trainResult = trainEngine.run(train, runStrategy, pairAddress);
      const trainMetrics = extractMetrics(trainResult);

      if (!passesConstraints(trainMetrics, sweepConfig.constraints)) continue;

      const testEngine = new BacktestEngine(config);
      const testResult = testEngine.run(test, runStrategy, pairAddress);
      const oosMetrics = extractMetrics(testResult);

      allResults.push({
        rank: 0,
        params: paramCombo,
        metrics: trainMetrics,
        oosMetrics,
      });
    } else if (sweepConfig.crossValidateFolds && sweepConfig.crossValidateFolds > 0) {
      // Cross-validation
      const folds = timeSeriesFolds(candles, sweepConfig.crossValidateFolds);
      const foldMetrics: SweepMetrics[] = [];

      for (const [train, test] of folds) {
        if (test.length < 10) continue;
        const engine = new BacktestEngine(config);
        const result = engine.run(test, runStrategy, pairAddress);
        foldMetrics.push(extractMetrics(result));
      }

      if (foldMetrics.length === 0) continue;

      // 평균 메트릭
      const avgMetrics: SweepMetrics = {
        netPnlPct: foldMetrics.reduce((s, m) => s + m.netPnlPct, 0) / foldMetrics.length,
        winRate: foldMetrics.reduce((s, m) => s + m.winRate, 0) / foldMetrics.length,
        sharpeRatio: foldMetrics.reduce((s, m) => s + m.sharpeRatio, 0) / foldMetrics.length,
        profitFactor: foldMetrics.reduce((s, m) => s + m.profitFactor, 0) / foldMetrics.length,
        maxDrawdownPct: Math.max(...foldMetrics.map(m => m.maxDrawdownPct)),
        totalTrades: foldMetrics.reduce((s, m) => s + m.totalTrades, 0),
        expectancyR: foldMetrics.reduce((s, m) => s + m.expectancyR, 0) / foldMetrics.length,
      };

      if (!passesConstraints(avgMetrics, sweepConfig.constraints)) continue;

      allResults.push({
        rank: 0,
        params: paramCombo,
        metrics: avgMetrics,
        foldMetrics,
      });
    } else {
      // 단순 그리드 서치
      const engine = new BacktestEngine(config);
      const result = engine.run(candles, runStrategy, pairAddress);
      const metrics = extractMetrics(result);

      if (!passesConstraints(metrics, sweepConfig.constraints)) continue;

      allResults.push({
        rank: 0,
        params: paramCombo,
        metrics,
      });
    }
  }

  // 정렬 (objective 내림차순)
  allResults.sort((a, b) =>
    getObjectiveValue(b.metrics, sweepConfig.objective) -
    getObjectiveValue(a.metrics, sweepConfig.objective)
  );

  // Stability filter
  allResults = applyStabilityFilter(allResults, sweepConfig.objective);

  // Top N + rank 부여
  const topN = allResults.slice(0, sweepConfig.topN);
  topN.forEach((r, i) => { r.rank = i + 1; });

  return topN;
}

// ─── Reporter (6D) ───

export function formatSweepReport(
  results: SweepResult[],
  objective: ObjectiveMetric,
  baselineMetrics?: SweepMetrics
): string {
  if (results.length === 0) return 'No results passed constraints.';

  const paramKeys = Object.keys(results[0].params);

  // Header
  const header = ['Rank', ...paramKeys, 'WR', 'Sharpe', 'PF', 'PnL%', 'MaxDD%', 'Trades'];
  header.splice(header.length - 1, 0, 'ExpR');
  if (results[0].oosMetrics) {
    header.push('OOS_Sharpe', 'OOS_PnL%');
  }

  const rows: string[][] = [];

  for (const r of results) {
    const row = [
      String(r.rank),
      ...paramKeys.map(k => r.params[k].toFixed(3)),
      `${(r.metrics.winRate * 100).toFixed(1)}%`,
      r.metrics.sharpeRatio.toFixed(2),
      r.metrics.profitFactor.toFixed(2),
      r.metrics.expectancyR.toFixed(2),
      `${(r.metrics.netPnlPct * 100).toFixed(1)}%`,
      `${(r.metrics.maxDrawdownPct * 100).toFixed(1)}%`,
      String(r.metrics.totalTrades),
    ];

    if (r.oosMetrics) {
      row.push(
        r.oosMetrics.sharpeRatio.toFixed(2),
        `${(r.oosMetrics.netPnlPct * 100).toFixed(1)}%`
      );
    }

    rows.push(row);
  }

  // 기본값 대비 개선률
  let improvementLine = '';
  if (baselineMetrics && results.length > 0) {
    const best = results[0].metrics;
    const sharpeImprove = baselineMetrics.sharpeRatio > 0
      ? ((best.sharpeRatio - baselineMetrics.sharpeRatio) / baselineMetrics.sharpeRatio * 100).toFixed(1)
      : 'N/A';
    const pnlImprove = baselineMetrics.netPnlPct !== 0
      ? ((best.netPnlPct - baselineMetrics.netPnlPct) / Math.abs(baselineMetrics.netPnlPct) * 100).toFixed(1)
      : 'N/A';
    improvementLine = `\nBaseline improvement: Sharpe ${sharpeImprove}% | PnL ${pnlImprove}%`;
  }

  // 테이블 포맷
  const colWidths = header.map((h, i) => {
    const maxData = Math.max(...rows.map(r => (r[i] || '').length));
    return Math.max(h.length, maxData) + 2;
  });

  const formatRow = (cols: string[]) =>
    '│' + cols.map((c, i) => c.padStart(colWidths[i])).join(' │') + ' │';

  const separator = '├' + colWidths.map(w => '─'.repeat(w + 1)).join('─┤') + '─┤';
  const topBorder = '┌' + colWidths.map(w => '─'.repeat(w + 1)).join('─┬') + '─┐';
  const bottomBorder = '└' + colWidths.map(w => '─'.repeat(w + 1)).join('─┴') + '─┘';

  const lines = [
    topBorder,
    formatRow(header),
    separator,
    ...rows.map(formatRow),
    bottomBorder,
    improvementLine,
  ].filter(Boolean);

  return lines.join('\n');
}

function calcExpectancyR(result: BacktestResult): number {
  if (result.trades.length === 0) return 0;

  const rMultiples = result.trades
    .map(trade => {
      const plannedRisk = Math.abs(trade.entryPrice - trade.stopLoss) * trade.quantity;
      if (plannedRisk <= 0) return Number.NaN;
      return trade.pnlSol / plannedRisk;
    })
    .filter(Number.isFinite);

  if (rMultiples.length === 0) return 0;
  return rMultiples.reduce((sum, value) => sum + value, 0) / rMultiples.length;
}

// Re-export for CLI
export { generateGrid, generateValues };
