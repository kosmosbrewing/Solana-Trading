import type { AttentionScore } from '../event/types';
import type { MomentumOrderParams } from '../strategy';
import type { Candle, PoolInfo, Signal } from '../utils/types';
import type { EvaluateGatesInput } from './index';
import type { FibPullbackGateConfig, GateThresholds } from './scoreGate';

interface BuildLiveGateInputParams {
  signal: Signal;
  candles: Candle[];
  poolInfo: PoolInfo;
  previousTvl: number;
  attentionScore?: AttentionScore;
  fibConfig: FibPullbackGateConfig;
  thresholds?: GateThresholds;
  estimatedPositionSol?: number;
  executionRrReject?: number;
  executionRrPass?: number;
  executionRrBasis?: 'tp1' | 'tp2';
  realtimeOrderParams?: Partial<MomentumOrderParams>;
}

export function buildLiveGateInput(params: BuildLiveGateInputParams): EvaluateGatesInput {
  return {
    signal: params.signal,
    candles: params.candles,
    poolInfo: params.poolInfo,
    previousTvl: params.previousTvl,
    attentionScore: params.attentionScore,
    requireAttentionScore: true,
    fibConfig: params.fibConfig,
    thresholds: params.thresholds,
    estimatedPositionSol: params.estimatedPositionSol,
    executionRrReject: params.executionRrReject,
    executionRrPass: params.executionRrPass,
    executionRrBasis: params.executionRrBasis,
    realtimeOrderParams: params.realtimeOrderParams,
  };
}
