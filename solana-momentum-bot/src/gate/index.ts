import { BreakoutScoreDetail, PoolInfo, Signal, TokenSafety } from '../utils/types';
import { buildTokenSafety } from './safetyGate';
import { buildGradeFilterReason, evaluateStrategyScore, FibPullbackGateConfig, isGradeRejected } from './scoreGate';
import { getGradeSizeMultiplier } from './sizingGate';

export interface EvaluateGatesInput {
  signal: Signal;
  candles: import('../utils/types').Candle[];
  poolInfo: PoolInfo;
  previousTvl: number;
  fibConfig: FibPullbackGateConfig;
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
  });
  const tokenSafety = buildTokenSafety(input.poolInfo);
  const filterReason = buildGradeFilterReason(breakoutScore);

  return {
    breakoutScore,
    tokenSafety,
    gradeSizeMultiplier: getGradeSizeMultiplier(breakoutScore.grade),
    rejected: isGradeRejected(breakoutScore.grade),
    filterReason,
  };
}

export type { FibPullbackGateConfig } from './scoreGate';
export { buildTokenSafety } from './safetyGate';
export { getGradeSizeMultiplier } from './sizingGate';
