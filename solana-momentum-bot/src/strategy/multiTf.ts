import { Candle } from '../utils/types';

/**
 * 멀티 타임프레임 정렬 확인
 *
 * 각 타임프레임에서 "상승 추세"인지 판정:
 *  - 종가 > 시가 (양봉)
 *  - 최근 3봉 기준 종가 상승
 *
 * @returns 정렬된 TF 수 (0~3)
 */
export function checkMultiTfAlignment(
  candles1m: Candle[],
  candles5m: Candle[],
  candles15m: Candle[]
): number {
  let aligned = 0;

  if (isBullishTf(candles1m)) aligned++;
  if (isBullishTf(candles5m)) aligned++;
  if (isBullishTf(candles15m)) aligned++;

  return aligned;
}

function isBullishTf(candles: Candle[]): boolean {
  if (candles.length < 3) return false;

  const recent = candles.slice(-3);

  // 최근 봉이 양봉
  const lastCandle = recent[recent.length - 1];
  if (lastCandle.close <= lastCandle.open) return false;

  // 3봉 전 대비 종가 상승
  if (lastCandle.close <= recent[0].close) return false;

  return true;
}
