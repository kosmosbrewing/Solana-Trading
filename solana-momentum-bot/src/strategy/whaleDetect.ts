import { Candle } from '../utils/types';

export interface WhaleAlert {
  type: 'WHALE_ALERT' | 'ACCUMULATION_ALERT';
  detail: string;
}

/**
 * 온체인 대형 거래 감지 (캔들 기반 근사)
 *
 * 조건:
 * 1. 단일 대형 매수: 풀 유동성의 2% 이상 (volume 기준 근사)
 * 2. 연속 동일 방향: 1분 내 같은 방향 3건+
 */
export function detectWhaleActivity(
  candles: Candle[],
  poolTvl: number,
  thresholdPct: number = 0.02
): WhaleAlert | null {
  if (candles.length === 0 || poolTvl <= 0) return null;

  const current = candles[candles.length - 1];

  // 단일 대형 매수 감지
  if (current.buyVolume > poolTvl * thresholdPct) {
    return {
      type: 'WHALE_ALERT',
      detail: `Single buy volume $${current.buyVolume.toFixed(0)} > ${(thresholdPct * 100)}% of TVL $${poolTvl.toFixed(0)}`,
    };
  }

  // 연속 매수 누적 감지 (최근 3봉)
  if (candles.length >= 3) {
    const recent3 = candles.slice(-3);
    const allBuyDominant = recent3.every(c => c.buyVolume > c.sellVolume);
    if (allBuyDominant) {
      const totalBuy = recent3.reduce((s, c) => s + c.buyVolume, 0);
      if (totalBuy > poolTvl * thresholdPct) {
        return {
          type: 'ACCUMULATION_ALERT',
          detail: `3-candle accumulation: total buy $${totalBuy.toFixed(0)}`,
        };
      }
    }
  }

  return null;
}
