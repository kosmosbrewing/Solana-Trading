import { BreakoutScoreDetail, PoolInfo, Signal, TokenSafety } from '../utils/types';
import { EventScore } from '../event/types';
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
  /** EventScore — undefined이면 이벤트 컨텍스트 없음 */
  eventScore?: EventScore;
  /** true이면 EventScore 없을 때 reject (라이브 모드). 기본값 false (백테스트 호환) */
  requireEventScore?: boolean;
}

export interface GateEvaluationResult {
  breakoutScore: BreakoutScoreDetail;
  tokenSafety?: TokenSafety;
  gradeSizeMultiplier: number;
  rejected: boolean;
  filterReason?: string;
  /** Gate에 전달된 EventScore (감사 추적용) */
  eventScore?: EventScore;
}

export function evaluateGates(input: EvaluateGatesInput): GateEvaluationResult {
  // Gate 2: EventScore 확인 — 설명불가 펌프 차단
  if (input.requireEventScore && !input.eventScore) {
    return {
      breakoutScore: {
        volumeScore: 0, buyRatioScore: 0, multiTfScore: 0,
        whaleScore: 0, lpScore: 0, totalScore: 0, grade: 'C' as const,
      },
      gradeSizeMultiplier: 0,
      rejected: true,
      filterReason: 'no_event_context',
    };
  }

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

  // EventScore confidence에 따른 sizing 보너스 (없으면 기본 1.0)
  const eventSizeBonus = !input.eventScore ? 1.0
    : input.eventScore.confidence === 'high' ? 1.2
    : input.eventScore.confidence === 'medium' ? 1.0
    : 0.8;

  return {
    breakoutScore,
    tokenSafety,
    gradeSizeMultiplier: getGradeSizeMultiplier(breakoutScore.grade) * eventSizeBonus,
    rejected: isGradeRejected(breakoutScore, input.thresholds),
    filterReason,
    eventScore: input.eventScore,
  };
}

export type { FibPullbackGateConfig } from './scoreGate';
export { buildTokenSafety } from './safetyGate';
export { getGradeSizeMultiplier } from './sizingGate';
