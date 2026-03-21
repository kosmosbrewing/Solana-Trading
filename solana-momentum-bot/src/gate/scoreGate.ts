import { AttentionScore } from '../event/types';
import { Candle, BreakoutScoreDetail, Signal } from '../utils/types';
import {
  assessLpStability,
  calcBreakoutScore,
  calcBuyRatio,
  calcVolumeMcapRatio,
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
  marketCap?: number;
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
        input.marketCap,
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

export function applyAttentionScoreComponent(
  score: BreakoutScoreDetail,
  attentionScore?: AttentionScore
): BreakoutScoreDetail {
  const attentionComponentScore = scoreAttentionContext(attentionScore);
  if (!attentionScore) {
    return score;
  }

  const totalScore = Math.min(100, score.totalScore + attentionComponentScore);
  return {
    ...score,
    totalScore,
    grade: resolveBreakoutGrade(totalScore),
    components: [
      ...(score.components ?? []),
      {
        key: 'attention_score',
        label: 'Attention Score',
        score: attentionComponentScore,
        maxScore: 20,
        value: attentionScore.attentionScore,
      },
    ],
  };
}

/** @deprecated use applyAttentionScoreComponent */
export const applyEventScoreComponent = applyAttentionScoreComponent;

export function buildStrategyHardRejectReason(
  signal: Signal,
  candles: Candle[],
  thresholds?: GateThresholds
): string | undefined {
  if (signal.strategy !== 'volume_spike' || !thresholds?.minBuyRatio || candles.length === 0) {
    return undefined;
  }

  const lastCandle = candles[candles.length - 1];
  // Why: directional volume 없으면 buyRatio 판단 불가 → 스킵 (backtest engine 동일 패턴)
  if (lastCandle.buyVolume + lastCandle.sellVolume <= 0) return undefined;

  const buyRatio = calcBuyRatio(lastCandle);
  if (buyRatio >= thresholds.minBuyRatio) return undefined;
  return `buy_ratio ${buyRatio.toFixed(2)} < minBuyRatio ${thresholds.minBuyRatio.toFixed(2)}`;
}

function evaluateVolumeSpikeScore(
  signal: Signal,
  candles: Candle[],
  poolTvl: number,
  marketCap: number | undefined,
  previousTvl: number,
  thresholds?: GateThresholds
): BreakoutScoreDetail {
  const lastCandle = candles[candles.length - 1];
  const volumeRatio = signal.meta.volumeRatio || 0;
  const buyRatio = calcBuyRatio(lastCandle);
  const volumeMcapRatio = calcVolumeMcapRatio(signal.meta.currentVolume24hUsd, marketCap);
  const whaleAlert = detectWhaleActivity(candles.slice(-5), poolTvl);
  const lpStability = assessLpStability(poolTvl, previousTvl);
  const multiTfAlignment = calcMultiPeriodAlignment(candles);

  // Why: directional volume 없으면 minBuyRatio=0 → buyRatioScore 중립 15/25
  // backtest engine.ts:101-103 동일 패턴
  const hasDirectionalData = lastCandle.buyVolume + lastCandle.sellVolume > 0;
  const effectiveMinBuyRatio = hasDirectionalData ? thresholds?.minBuyRatio : 0;

  return calcBreakoutScore({
    volumeRatio,
    volumeMcapRatio,
    buyRatio,
    multiTfAlignment,
    whaleDetected: !!whaleAlert,
    lpStability,
    minBuyRatio: effectiveMinBuyRatio,
  });
}

/** 단기(5봉)/중기(10봉)/장기(20봉) 트렌드 정렬 수 (0~3) */
function calcMultiPeriodAlignment(candles: Candle[]): number {
  if (candles.length < 20) return 0;

  let alignment = 0;
  // 단기: 최근 5봉 상승
  if (candles[candles.length - 1].close > candles[candles.length - 5].open) alignment++;
  // 중기: 최근 10봉 상승
  if (candles[candles.length - 1].close > candles[candles.length - 10].open) alignment++;
  // 장기: 최근 20봉 상승
  if (candles[candles.length - 1].close > candles[candles.length - 20].open) alignment++;

  return alignment;
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

function scoreAttentionContext(attentionScore?: AttentionScore): number {
  if (!attentionScore) return 0;
  return Math.max(0, Math.min(20, Math.round(attentionScore.attentionScore / 5)));
}

function resolveBreakoutGrade(totalScore: number): 'A' | 'B' | 'C' {
  return totalScore >= 70 ? 'A' : totalScore >= 50 ? 'B' : 'C';
}
