import { Candle } from '../utils/types';

/**
 * Momentum Exhaustion Exit — 모멘텀 소진 징후 감지
 *
 * 3개 지표 중 exhaustionThreshold(기본: 2)개 이상 충족 시 청산 신호
 *
 * 1. 봉 크기 축소: 직전 봉 대비 body 50% 이하
 * 2. 상위 꼬리 증가: 윗꼬리/body > 2.0
 * 3. 거래량 감소: 직전 봉 대비 60% 이하
 */
export function checkExhaustion(
  candles: Candle[],
  threshold: number = 2
): { exhausted: boolean; indicators: string[] } {
  if (candles.length < 2) {
    return { exhausted: false, indicators: [] };
  }

  const current = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const indicators: string[] = [];

  // 1. 봉 크기 축소
  const currentBody = Math.abs(current.close - current.open);
  const prevBody = Math.abs(previous.close - previous.open);
  if (prevBody > 0 && currentBody <= prevBody * 0.5) {
    indicators.push('body_shrink');
  }

  // 2. 상위 꼬리 증가
  const upperWick = current.high - Math.max(current.open, current.close);
  if (currentBody > 0 && upperWick / currentBody > 2.0) {
    indicators.push('upper_wick');
  }

  // 3. 거래량 감소
  if (previous.volume > 0 && current.volume <= previous.volume * 0.6) {
    indicators.push('volume_decline');
  }

  return {
    exhausted: indicators.length >= threshold,
    indicators,
  };
}
