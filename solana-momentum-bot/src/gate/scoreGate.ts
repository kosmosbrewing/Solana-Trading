import { Candle, BreakoutGrade, BreakoutScoreDetail, Signal } from '../utils/types';
import {
  assessLpStability,
  calcBreakoutScore,
  calcBuyRatio,
  detectWhaleActivity,
} from '../strategy';

export interface FibPullbackGateConfig {
  impulseMinPct: number;
  volumeClimaxMultiplier: number;
  minWickRatio: number;
}

export interface EvaluateStrategyScoreInput {
  signal: Signal;
  candles: Candle[];
  poolTvl: number;
  previousTvl: number;
  fibConfig: FibPullbackGateConfig;
}

export function evaluateStrategyScore(input: EvaluateStrategyScoreInput): BreakoutScoreDetail {
  if (input.signal.strategy === 'volume_spike') {
    return evaluateVolumeSpikeScore(input.signal, input.candles, input.poolTvl, input.previousTvl);
  }

  if (input.signal.strategy === 'fib_pullback') {
    return evaluateFibPullbackScore(input.signal, input.candles, input.poolTvl, input.previousTvl, input.fibConfig);
  }

  throw new Error(`Unsupported gate scoring strategy: ${input.signal.strategy}`);
}

export function isGradeRejected(grade: BreakoutGrade): boolean {
  return grade === 'C';
}

export function buildGradeFilterReason(score: BreakoutScoreDetail): string | undefined {
  if (!isGradeRejected(score.grade)) return undefined;
  return `Grade C (score ${score.totalScore})`;
}

function evaluateVolumeSpikeScore(
  signal: Signal,
  candles: Candle[],
  poolTvl: number,
  previousTvl: number
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
  });
}

function evaluateFibPullbackScore(
  signal: Signal,
  candles: Candle[],
  poolTvl: number,
  previousTvl: number,
  fibConfig: FibPullbackGateConfig
): BreakoutScoreDetail {
  const impulsePct = signal.meta.impulsePct || 0;
  const wickRatio = signal.meta.wickRatio || 0;
  const lastCandle = candles[candles.length - 1];

  const derivedVolumeRatio = Math.max(
    (impulsePct / Math.max(fibConfig.impulseMinPct, 0.0001)) * 3,
    signal.meta.volumeClimax ? fibConfig.volumeClimaxMultiplier : 0
  );
  const derivedBuyRatio = Math.max(
    calcBuyRatio(lastCandle),
    Math.min(0.95, 0.5 + wickRatio * 0.5)
  );
  const multiTfAlignment =
    impulsePct >= fibConfig.impulseMinPct * 1.25 &&
    wickRatio >= Math.max(fibConfig.minWickRatio, 0.5)
      ? 2
      : 1;
  const whaleAlert = detectWhaleActivity(candles.slice(-5), poolTvl);
  const lpStability = assessLpStability(poolTvl, previousTvl);

  return calcBreakoutScore({
    volumeRatio: derivedVolumeRatio,
    buyRatio: derivedBuyRatio,
    multiTfAlignment,
    whaleDetected: !!whaleAlert,
    lpStability,
  });
}
