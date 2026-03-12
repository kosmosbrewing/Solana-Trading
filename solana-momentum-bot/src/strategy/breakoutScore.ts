import { Candle, BreakoutScoreDetail, BreakoutGrade } from '../utils/types';
import { calcAvgVolume } from './indicators';

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
}

/**
 * Breakout Score (0~100) — 5개 팩터 합산
 */
export function calcBreakoutScore(input: BreakoutScoreInput): BreakoutScoreDetail {
  // Factor 1: 거래량 강도 (0~25)
  let volumeScore = 0;
  if (input.volumeRatio >= 5.0) volumeScore = 25;
  else if (input.volumeRatio >= 3.0) volumeScore = 15;

  // Factor 2: 매수 비율 (0~25)
  let buyRatioScore = 0;
  if (input.buyRatio >= 0.80) buyRatioScore = 25;
  else if (input.buyRatio >= 0.65) buyRatioScore = 15;

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

  const totalScore = Math.max(0, Math.min(100,
    volumeScore + buyRatioScore + multiTfScore + whaleScore + lpScore
  ));

  const grade: BreakoutGrade = totalScore >= 70 ? 'A' : totalScore >= 50 ? 'B' : 'C';

  return {
    volumeScore,
    buyRatioScore,
    multiTfScore,
    whaleScore,
    lpScore,
    totalScore,
    grade,
  };
}

/**
 * 캔들 데이터에서 매수 비율 계산
 */
export function calcBuyRatio(candle: Candle): number {
  const total = candle.buyVolume + candle.sellVolume;
  if (total <= 0) return 0.5; // 데이터 없을 때 중립
  return candle.buyVolume / total;
}
