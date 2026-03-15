import { Candle, BreakoutScoreComponent, BreakoutScoreDetail, BreakoutGrade } from '../utils/types';

export interface BreakoutScoreInput {
  /** 현재 봉 거래량 / N봉 평균 비율 */
  volumeRatio: number;
  /** 매수 비율 (buyVolume / totalVolume) */
  buyRatio: number;
  /** 멀티 타임프레임 정렬 수 (0~3) */
  multiTfAlignment: number;
  /** 웨일 활동 감지 여부 */
  whaleDetected: boolean;
  /** LP 안정성 (stable / unstable / dropping) */
  lpStability: 'stable' | 'unstable' | 'dropping';
  /** 최소 매수 비율 threshold */
  minBuyRatio?: number;
}

interface BreakoutScoreDetailInput {
  volumeScore: number;
  buyRatioScore: number;
  multiTfScore: number;
  whaleScore: number;
  lpScore: number;
  components?: BreakoutScoreComponent[];
}

/**
 * Breakout Score (0~100) — 5개 팩터 합산
 */
export function calcBreakoutScore(input: BreakoutScoreInput): BreakoutScoreDetail {
  const minBuyRatio = input.minBuyRatio ?? 0.65;
  const strongBuyRatio = Math.min(0.98, Math.max(0.80, minBuyRatio + 0.15));

  // Factor 1: 거래량 강도 (0~25)
  let volumeScore = 0;
  if (input.volumeRatio >= 5.0) volumeScore = 25;
  else if (input.volumeRatio >= 3.0) volumeScore = 15;

  // Factor 2: 매수 비율 (0~25)
  let buyRatioScore = 0;
  if (input.buyRatio >= strongBuyRatio) buyRatioScore = 25;
  else if (input.buyRatio >= minBuyRatio) buyRatioScore = 15;

  // Factor 3: 멀티 타임프레임 정렬 (0~20)
  let multiTfScore = 0;
  if (input.multiTfAlignment >= 3) multiTfScore = 20;
  else if (input.multiTfAlignment >= 2) multiTfScore = 10;

  // Factor 4: 웨일 활동 (0~15)
  const whaleScore = input.whaleDetected ? 15 : 0;

  // Factor 5: LP 안정성 (-10~15)
  let lpScore = 0;
  if (input.lpStability === 'stable') lpScore = 15;
  else if (input.lpStability === 'dropping') lpScore = -10;

  return buildBreakoutScoreDetail({
    volumeScore,
    buyRatioScore,
    multiTfScore,
    whaleScore,
    lpScore,
    components: [
      { key: 'volume_ratio', label: 'Volume Ratio', score: volumeScore, maxScore: 25, value: input.volumeRatio },
      { key: 'buy_ratio', label: 'Buy Ratio', score: buyRatioScore, maxScore: 25, value: input.buyRatio },
      { key: 'multi_tf_alignment', label: 'Multi TF Alignment', score: multiTfScore, maxScore: 20, value: input.multiTfAlignment },
      { key: 'whale_detected', label: 'Whale Activity', score: whaleScore, maxScore: 15, value: input.whaleDetected ? 1 : 0 },
      { key: 'lp_stability', label: 'LP Stability', score: lpScore, maxScore: 15, value: input.lpStability === 'stable' ? 1 : input.lpStability === 'dropping' ? -1 : 0 },
    ],
  });
}

/**
 * 캔들 데이터에서 매수 비율 계산
 */
export function calcBuyRatio(candle: Candle): number {
  const total = candle.buyVolume + candle.sellVolume;
  if (total <= 0) return 0.5; // 데이터 없을 때 중립
  return candle.buyVolume / total;
}

export function buildBreakoutScoreDetail(input: BreakoutScoreDetailInput): BreakoutScoreDetail {
  const totalScore = Math.max(0, Math.min(100,
    input.volumeScore + input.buyRatioScore + input.multiTfScore + input.whaleScore + input.lpScore
  ));

  return {
    volumeScore: input.volumeScore,
    buyRatioScore: input.buyRatioScore,
    multiTfScore: input.multiTfScore,
    whaleScore: input.whaleScore,
    lpScore: input.lpScore,
    totalScore,
    grade: resolveBreakoutGrade(totalScore),
    components: input.components,
  };
}

export function resolveBreakoutGrade(totalScore: number): BreakoutGrade {
  return totalScore >= 70 ? 'A' : totalScore >= 50 ? 'B' : 'C';
}
