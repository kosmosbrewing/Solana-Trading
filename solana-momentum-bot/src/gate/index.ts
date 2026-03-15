import { BreakoutScoreDetail, PoolInfo, Signal, TokenSafety } from '../utils/types';
import { AttentionScore } from '../event/types';
import { buildTokenSafety } from './safetyGate';
import { evaluateExecutionViability, ExecutionViabilityResult } from './executionViability';
import {
  applyAttentionScoreComponent,
  buildStrategyHardRejectReason,
  buildGradeFilterReason,
  evaluateStrategyScore,
  FibPullbackGateConfig,
  GateThresholds,
  isGradeRejected,
} from './scoreGate';

export interface EvaluateGatesInput {
  signal: Signal;
  candles: import('../utils/types').Candle[];
  poolInfo: PoolInfo;
  previousTvl: number;
  fibConfig: FibPullbackGateConfig;
  thresholds?: GateThresholds;
  /** AttentionScore — undefined이면 트렌딩 컨텍스트 없음 */
  attentionScore?: AttentionScore;
  /** true이면 AttentionScore 없을 때 reject (라이브 모드). 기본값 false (백테스트 호환) */
  requireAttentionScore?: boolean;
  /** Early probe용 예상 포지션 사이즈(SOL). 미지정 시 1 SOL probe 사용. */
  estimatedPositionSol?: number;

  // deprecated aliases
  /** @deprecated use attentionScore */
  eventScore?: AttentionScore;
  /** @deprecated use requireAttentionScore */
  requireEventScore?: boolean;
}

export interface GateEvaluationResult {
  breakoutScore: BreakoutScoreDetail;
  tokenSafety?: TokenSafety;
  gradeSizeMultiplier: number;
  rejected: boolean;
  filterReason?: string;
  /** Gate에 전달된 AttentionScore (감사 추적용) */
  attentionScore?: AttentionScore;
  executionViability: ExecutionViabilityResult;

  /** @deprecated use attentionScore */
  eventScore?: AttentionScore;
}

export function evaluateGates(input: EvaluateGatesInput): GateEvaluationResult {
  // resolve deprecated aliases
  const score = input.attentionScore ?? input.eventScore;
  const requireScore = input.requireAttentionScore ?? input.requireEventScore ?? false;

  // Gate 0: AttentionScore 확인 — 트렌딩 화이트리스트 필터
  if (requireScore && !score) {
    return {
      breakoutScore: {
        volumeScore: 0, buyRatioScore: 0, multiTfScore: 0,
        whaleScore: 0, lpScore: 0, totalScore: 0, grade: 'C' as const,
      },
      gradeSizeMultiplier: 0,
      rejected: true,
      filterReason: 'not_trending',
      attentionScore: undefined,
      eventScore: undefined,
      executionViability: {
        effectiveRR: 0,
        roundTripCost: 0,
        sizeMultiplier: 0,
        rejected: true,
      },
    };
  }

  const breakoutScore = applyAttentionScoreComponent(evaluateStrategyScore({
    signal: input.signal,
    candles: input.candles,
    poolTvl: input.poolInfo.tvl,
    previousTvl: input.previousTvl,
    fibConfig: input.fibConfig,
    thresholds: input.thresholds,
  }), score);
  const tokenSafety = buildTokenSafety(input.poolInfo);
  const hardRejectReason = buildStrategyHardRejectReason(input.signal, input.candles, input.thresholds);
  if (hardRejectReason) {
    return {
      breakoutScore,
      tokenSafety,
      gradeSizeMultiplier: 0,
      rejected: true,
      filterReason: hardRejectReason,
      attentionScore: score,
      eventScore: score,
      executionViability: {
        effectiveRR: 0,
        roundTripCost: 0,
        sizeMultiplier: 0,
        rejected: true,
      },
    };
  }
  const executionViability = evaluateExecutionViability(
    input.signal, input.candles, input.poolInfo, input.estimatedPositionSol
  );
  const filterReason = executionViability.rejected
    ? executionViability.filterReason
    : buildGradeFilterReason(breakoutScore, input.thresholds);

  // AttentionScore confidence에 따른 sizing 보너스 (없으면 기본 1.0)
  const attentionSizeBonus = !score ? 1.0
    : score.confidence === 'high' ? 1.2
    : score.confidence === 'medium' ? 1.0
    : 0.8;

  return {
    breakoutScore,
    tokenSafety,
    gradeSizeMultiplier: attentionSizeBonus * executionViability.sizeMultiplier,
    rejected: executionViability.rejected || isGradeRejected(breakoutScore, input.thresholds),
    filterReason,
    attentionScore: score,
    eventScore: score,
    executionViability,
  };
}

export type { FibPullbackGateConfig } from './scoreGate';
export { buildTokenSafety } from './safetyGate';
export { getGradeSizeMultiplier } from './sizingGate';
export { evaluateExecutionViabilityForOrder } from './executionViability';
export type { ExecutionViabilityResult } from './executionViability';
