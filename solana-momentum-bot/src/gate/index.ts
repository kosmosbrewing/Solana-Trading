import { BreakoutScoreDetail, PoolInfo, Signal, TokenSafety } from '../utils/types';
import { AttentionScore } from '../event/types';
import { buildTokenSafety } from './safetyGate';
import { evaluateExecutionViability, ExecutionViabilityResult } from './executionViability';
import { evaluateSecurityGate, SecurityGateResult } from './securityGate';
import { evaluateQuoteGate, QuoteGateResult } from './quoteGate';
import { TokenSecurityData, ExitLiquidityData } from '../ingester/birdeyeClient';
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

  // ─── Phase 1A: Security + Quote Gate ───
  /** Token security data from Birdeye (null = skip security gate) */
  tokenSecurityData?: TokenSecurityData | null;
  /** Exit liquidity data from Birdeye (null = skip) */
  exitLiquidityData?: ExitLiquidityData | null;
  /** Jupiter API config for quote gate */
  quoteGateConfig?: { jupiterApiUrl: string; jupiterApiKey?: string; maxPriceImpact?: number };
  /** Set to false to skip security gate (e.g., backtest mode) */
  enableSecurityGate?: boolean;
  /** Set to false to skip quote gate (e.g., backtest mode) */
  enableQuoteGate?: boolean;

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
  /** Phase 1A: Security Gate result */
  securityGate?: SecurityGateResult;
  /** Phase 1A: Quote Gate result */
  quoteGate?: QuoteGateResult;

  /** @deprecated use attentionScore */
  eventScore?: AttentionScore;
}

/**
 * Synchronous gate evaluation (backward-compatible, no security/quote gate).
 * For backtest or contexts where async is not available.
 */
export function evaluateGates(input: EvaluateGatesInput): GateEvaluationResult {
  return evaluateGatesSync(input);
}

/**
 * Async gate evaluation — includes Security Gate (Gate 0) and Quote Gate.
 * Use this in live/paper mode.
 */
export async function evaluateGatesAsync(input: EvaluateGatesInput): Promise<GateEvaluationResult> {
  const emptyResult = (): GateEvaluationResult => ({
    breakoutScore: {
      volumeScore: 0, buyRatioScore: 0, multiTfScore: 0,
      whaleScore: 0, lpScore: 0, mcapVolumeScore: 0, totalScore: 0, grade: 'C' as const,
    },
    gradeSizeMultiplier: 0,
    rejected: true,
    filterReason: '',
    attentionScore: undefined,
    eventScore: undefined,
    executionViability: { effectiveRR: 0, roundTripCost: 0, sizeMultiplier: 0, rejected: true },
  });

  // ─── Gate 0: Security Gate (최우선) ───
  if (input.enableSecurityGate !== false && input.tokenSecurityData !== undefined) {
    const secResult = evaluateSecurityGate(
      input.tokenSecurityData ?? null,
      input.exitLiquidityData ?? null,
    );
    if (!secResult.approved) {
      const r = emptyResult();
      r.filterReason = `security_rejected: ${secResult.reason}`;
      r.securityGate = secResult;
      return r;
    }
    // Security gate passed — carry sizeMultiplier forward
    // (will be incorporated after sync gates run)
    const syncResult = evaluateGatesSync(input);
    syncResult.securityGate = secResult;
    syncResult.gradeSizeMultiplier *= secResult.sizeMultiplier;

    // ─── Quote Gate (진입 전 실제 price impact) ───
    if (input.enableQuoteGate !== false && input.quoteGateConfig && input.estimatedPositionSol) {
      const qResult = await evaluateQuoteGate(
        input.poolInfo.tokenMint,
        input.estimatedPositionSol,
        input.quoteGateConfig,
      );
      syncResult.quoteGate = qResult;
      if (!qResult.approved) {
        syncResult.rejected = true;
        syncResult.filterReason = `quote_rejected: ${qResult.reason}`;
        syncResult.gradeSizeMultiplier = 0;
      } else {
        syncResult.gradeSizeMultiplier *= qResult.sizeMultiplier;
      }
    }

    return syncResult;
  }

  // Security gate disabled — fall through to sync evaluation
  const syncResult = evaluateGatesSync(input);

  // Still run Quote Gate if enabled
  if (input.enableQuoteGate !== false && input.quoteGateConfig && input.estimatedPositionSol && !syncResult.rejected) {
    const qResult = await evaluateQuoteGate(
      input.poolInfo.tokenMint,
      input.estimatedPositionSol,
      input.quoteGateConfig,
    );
    syncResult.quoteGate = qResult;
    if (!qResult.approved) {
      syncResult.rejected = true;
      syncResult.filterReason = `quote_rejected: ${qResult.reason}`;
      syncResult.gradeSizeMultiplier = 0;
    } else {
      syncResult.gradeSizeMultiplier *= qResult.sizeMultiplier;
    }
  }

  return syncResult;
}

function evaluateGatesSync(input: EvaluateGatesInput): GateEvaluationResult {
  // resolve deprecated aliases
  const score = input.attentionScore ?? input.eventScore;
  const requireScore = input.requireAttentionScore ?? input.requireEventScore ?? false;

  // Gate 1: AttentionScore 확인 — 트렌딩 화이트리스트 필터
  if (requireScore && !score) {
    return {
      breakoutScore: {
        volumeScore: 0, buyRatioScore: 0, multiTfScore: 0,
        whaleScore: 0, lpScore: 0, mcapVolumeScore: 0, totalScore: 0, grade: 'C' as const,
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
    marketCap: input.poolInfo.marketCap,
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
export { evaluateSecurityGate } from './securityGate';
export type { SecurityGateResult, SecurityGateConfig } from './securityGate';
export { evaluateQuoteGate } from './quoteGate';
export type { QuoteGateResult, QuoteGateConfig } from './quoteGate';
