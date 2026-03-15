import { BreakoutScoreDetail, PoolInfo, Signal, TokenSafety } from '../utils/types';
import { buildTokenSafety } from './safetyGate';
import {
  buildGradeFilterReason,
  evaluateStrategyScore,
  FibPullbackGateConfig,
  GateThresholds,
  isGradeRejected,
} from './scoreGate';
import { getGradeSizeMultiplier } from './sizingGate';

export interface EvaluateGatesInput {
  signal: Signal;
  candles: import('../utils/types').Candle[];
  poolInfo: PoolInfo;
  previousTvl: number;
  fibConfig: FibPullbackGateConfig;
  thresholds?: GateThresholds;
}

export interface GateEvaluationResult {
  breakoutScore: BreakoutScoreDetail;
  tokenSafety?: TokenSafety;
  gradeSizeMultiplier: number;
  rejected: boolean;
  filterReason?: string;
}

export function evaluateGates(input: EvaluateGatesInput): GateEvaluationResult {
  const breakoutScore = evaluateStrategyScore({
    signal: input.signal,
    candles: input.candles,
    poolTvl: input.poolInfo.tvl,
    previousTvl: input.previousTvl,
    fibConfig: input.fibConfig,
    thresholds: input.thresholds,
  });
  const tokenSafety = buildTokenSafety(input.poolInfo);
  const filterReason = buildGradeFilterReason(breakoutScore, input.thresholds);

  return {
    breakoutScore,
    tokenSafety,
    gradeSizeMultiplier: getGradeSizeMultiplier(breakoutScore.grade),
    rejected: isGradeRejected(breakoutScore, input.thresholds),
    filterReason,
  };
}

export type { FibPullbackGateConfig } from './scoreGate';
export { buildTokenSafety } from './safetyGate';
export { getGradeSizeMultiplier } from './sizingGate';
