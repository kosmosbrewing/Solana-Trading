import { Candle, BreakoutScoreDetail, Signal } from '../utils/types';
import {
  assessLpStability,
  calcBreakoutScore,
  calcBuyRatio,
  detectWhaleActivity,
} from '../strategy';
import { calcFibPullbackScore } from './fibPullbackScore';

export interface FibPullbackGateConfig {
  impulseMinPct: number;
  volumeClimaxMultiplier: number;
  minWickRatio: number;
}

export interface GateThresholds {
  minBuyRatio?: number;
  minBreakoutScore?: number;
}

export interface EvaluateStrategyScoreInput {
  signal: Signal;
  candles: Candle[];
  poolTvl: number;
  previousTvl: number;
  fibConfig: FibPullbackGateConfig;
  thresholds?: GateThresholds;
}

export function evaluateStrategyScore(input: EvaluateStrategyScoreInput): BreakoutScoreDetail {
  switch (input.signal.strategy) {
    case 'volume_spike':
      return evaluateVolumeSpikeScore(
        input.signal,
        input.candles,
        input.poolTvl,
        input.previousTvl,
        input.thresholds
      );
    case 'fib_pullback':
      return evaluateFibPullbackScore(
        input.signal,
        input.poolTvl,
        input.previousTvl,
        input.fibConfig
      );
    default:
      throw new Error(`Unsupported gate scoring strategy: ${input.signal.strategy}`);
  }
}

export function isGradeRejected(score: BreakoutScoreDetail, thresholds?: GateThresholds): boolean {
  return score.totalScore < (thresholds?.minBreakoutScore ?? 50);
}

export function buildGradeFilterReason(score: BreakoutScoreDetail, thresholds?: GateThresholds): string | undefined {
  if (!isGradeRejected(score, thresholds)) return undefined;
  const minBreakoutScore = thresholds?.minBreakoutScore ?? 50;
  return `Score ${score.totalScore} < minBreakoutScore ${minBreakoutScore}`;
}

function evaluateVolumeSpikeScore(
  signal: Signal,
  candles: Candle[],
  poolTvl: number,
  previousTvl: number,
  thresholds?: GateThresholds
): BreakoutScoreDetail {
  const lastCandle = candles[candles.length - 1];
  const volumeRatio = signal.meta.volumeRatio || 0;
  const buyRatio = calcBuyRatio(lastCandle);
  const whaleAlert = detectWhaleActivity(candles.slice(-5), poolTvl);
  const lpStability = assessLpStability(poolTvl, previousTvl);

  return calcBreakoutScore({
    volumeRatio,
    buyRatio,
    multiTfAlignment: 1,
    whaleDetected: !!whaleAlert,
    lpStability,
    minBuyRatio: thresholds?.minBuyRatio,
  });
}

function evaluateFibPullbackScore(
  signal: Signal,
  poolTvl: number,
  previousTvl: number,
  fibConfig: FibPullbackGateConfig
): BreakoutScoreDetail {
  const lpStability = assessLpStability(poolTvl, previousTvl);

  return calcFibPullbackScore({
    signal,
    lpStability,
    config: fibConfig,
  });
}
