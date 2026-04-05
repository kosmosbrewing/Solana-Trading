import { Candle } from '../utils/types';

/**
 * Average True Range (ATR) 계산 — 순수 함수
 * TR = max(high - low, |high - prevClose|, |low - prevClose|)
 */
export function calcATR(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 0;

  const trValues: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trValues.push(tr);
  }

  // 최근 period 개의 TR 평균
  const recent = trValues.slice(-period);
  return recent.reduce((sum, v) => sum + v, 0) / recent.length;
}

/**
 * 평균 거래량 계산
 */
export function calcAvgVolume(candles: Candle[], period: number): number {
  if (candles.length < period) return 0;
  const recent = candles.slice(-period);
  return recent.reduce((sum, c) => sum + c.volume, 0) / recent.length;
}

/**
 * Sparse DEX용 평균 거래량 — volume > 0 인 candle만 평균.
 * Why: 10s 봉에서 DEX swap 빈도가 낮으면 대부분 candle이 volume=0 →
 *   단순 평균이 항상 0이 되어 spike 감지 불가.
 *   non-zero candle만 평균하면 "이 pair의 평소 거래 강도" 추정 가능.
 */
export function calcSparseAvgVolume(candles: Candle[], minActive: number): number {
  const nonZero = candles.filter(c => c.volume > 0);
  if (nonZero.length < minActive) return 0;
  return nonZero.reduce((sum, c) => sum + c.volume, 0) / nonZero.length;
}

/**
 * N봉 최고가
 */
export function calcHighestHigh(candles: Candle[], period: number): number {
  const recent = candles.slice(-period);
  return Math.max(...recent.map((c) => c.high));
}

/**
 * N봉 최저가
 */
export function calcLowestLow(candles: Candle[], period: number): number {
  const recent = candles.slice(-period);
  return Math.min(...recent.map((c) => c.low));
}

/**
 * 연속 양봉 수 (끝에서부터 카운트)
 */
export function countConsecutiveBullish(candles: Candle[]): number {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * N봉 누적 가격 변동률
 */
export function calcPriceChangeRate(candles: Candle[], n: number): number {
  if (candles.length < n) return 0;
  const start = candles[candles.length - n];
  const end = candles[candles.length - 1];
  return (end.close - start.open) / start.open;
}
