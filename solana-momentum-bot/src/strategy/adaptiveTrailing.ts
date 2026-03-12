import { Candle } from '../utils/types';

/**
 * RSI(7) 계산 — 순수 함수
 */
export function calcRSI(candles: Candle[], period: number = 7): number {
  if (candles.length < period + 1) return 50; // 데이터 부족 시 중립

  let avgGain = 0;
  let avgLoss = 0;
  const start = candles.length - period - 1;

  // 초기 평균
  for (let i = start + 1; i <= start + period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Adaptive Trailing Stop — 모멘텀 강도에 따라 trailing 폭 조절
 *
 * RSI > 80  → ATR × 3.0 (극강 모멘텀 → 넓게)
 * 60~80     → ATR × 2.0 (보통)
 * < 60      → ATR × 1.0 (약한 → 타이트하게)
 *
 * 최소값: 항상 진입가 이상 (본전 보장)
 */
export function calcAdaptiveTrailingStop(
  candles: Candle[],
  atr: number,
  entryPrice: number,
  peakPrice: number
): number {
  const rsi = calcRSI(candles, 7);

  let multiplier: number;
  if (rsi > 80) multiplier = 3.0;
  else if (rsi >= 60) multiplier = 2.0;
  else multiplier = 1.0;

  const trailingDistance = atr * multiplier;
  const trailingStop = peakPrice - trailingDistance;

  // 본전 보장
  return Math.max(trailingStop, entryPrice);
}
