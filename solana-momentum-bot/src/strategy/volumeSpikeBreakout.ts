import { Candle, Signal, Order } from '../utils/types';
import { calcATR, calcAvgVolume, calcHighestHigh } from './indicators';

export interface VolumeSpikeParams {
  lookback: number;         // N봉 평균 기준 (default: 20)
  volumeMultiplier: number; // M배 (default: 3.0)
  spreadFilterK: number;    // 스프레드 필터 배수 (default: 2.0)
  atrPeriod: number;        // ATR 기간 (default: 20)
  tp1Multiplier: number;    // TP1 = ATR × N
  tp2Multiplier: number;    // TP2 = ATR × N
  timeStopMinutes: number;
  /** SL = entry - ATR × N. undefined이면 candle.low (기존 동작) */
  slAtrMultiplier?: number;
}

export function calcVolumeMcapRatio(volume24hUsd?: number, marketCap?: number): number {
  if (!volume24hUsd || !marketCap || volume24hUsd <= 0 || marketCap <= 0) {
    return 0;
  }
  return volume24hUsd / marketCap;
}

const DEFAULT_PARAMS: VolumeSpikeParams = {
  lookback: 20,
  volumeMultiplier: 2.5,   // v4 sweep: 3.0→2.5 (시그널 수 ~30% 증가)
  spreadFilterK: 2.0,
  atrPeriod: 20,
  tp1Multiplier: 1.0,      // v5: 1.5→1.0 (더 자주 TP1 도달, runner 비중 확대)
  tp2Multiplier: 10.0,     // v5: 3.5→10.0 (실질적 cap 제거, fat-tail 탑승)
  timeStopMinutes: 20,     // v5: 30→20 (빠른 판정)
  slAtrMultiplier: 1.0,    // v5: candle.low→ATR×1.0 (일정한 risk 단위)
};

/**
 * Strategy A: Volume Spike Breakout — 순수 함수
 *
 * 조건:
 * 1. 현재 봉 거래량 > N봉 평균 × M배
 * 2. 종가 > 직전 N봉 고점 (Long)
 *
 * 모든 입력은 캔들 배열, 출력은 Signal — 상태 없음
 */
export function evaluateVolumeSpikeBreakout(
  candles: Candle[],
  params: Partial<VolumeSpikeParams> = {}
): Signal {
  const p = { ...DEFAULT_PARAMS, ...params };
  const pairAddress = candles[0]?.pairAddress || '';
  const holdSignal: Signal = {
    action: 'HOLD',
    strategy: 'volume_spike',
    pairAddress,
    price: candles[candles.length - 1]?.close || 0,
    timestamp: new Date(),
    meta: {},
  };

  // 최소 캔들 수 확인
  if (candles.length < p.lookback + 1) {
    return holdSignal;
  }

  const currentCandle = candles[candles.length - 1];
  const previousCandles = candles.slice(0, -1); // 현재 봉 제외

  // 1. Volume Spike 체크
  const avgVolume = calcAvgVolume(previousCandles, p.lookback);
  const volumeRatio = avgVolume > 0 ? currentCandle.volume / avgVolume : 0;
  const volumeSpike = volumeRatio >= p.volumeMultiplier;

  // 2. Price Breakout 체크 (종가 > 직전 N봉 고점)
  const highestHigh = calcHighestHigh(previousCandles, p.lookback);
  const priceBreakout = currentCandle.close > highestHigh;

  // ATR 계산 (주문 파라미터용)
  const atr = calcATR(candles, p.atrPeriod);

  const meta = {
    volumeRatio,
    avgVolume,
    currentVolume: currentCandle.volume,
    highestHigh,
    atr,
  };

  if (volumeSpike && priceBreakout) {
    return {
      action: 'BUY',
      strategy: 'volume_spike',
      pairAddress,
      price: currentCandle.close,
      timestamp: new Date(),
      sourceLabel: 'strategy_volume_spike',
      meta,
    };
  }

  return { ...holdSignal, meta };
}

/**
 * Volume Spike 시그널에서 주문 파라미터 생성
 */
export function buildVolumeSpikeOrder(
  signal: Signal,
  candles: Candle[],
  quantity: number,
  params: Partial<VolumeSpikeParams> = {}
): Order {
  const p = { ...DEFAULT_PARAMS, ...params };
  const currentCandle = candles[candles.length - 1];
  const atr = signal.meta.atr || calcATR(candles, p.atrPeriod);

  // v5: ATR 기반 SL (일정한 risk 단위). 미설정 시 candle.low (기존 동작)
  const stopLoss = p.slAtrMultiplier != null
    ? signal.price - atr * p.slAtrMultiplier
    : currentCandle.low;

  return {
    pairAddress: signal.pairAddress,
    strategy: 'volume_spike',
    side: 'BUY',
    price: signal.price,
    quantity,
    stopLoss,
    takeProfit1: signal.price + atr * p.tp1Multiplier,
    takeProfit2: signal.price + atr * p.tp2Multiplier,
    trailingStop: atr,
    timeStopMinutes: p.timeStopMinutes,
  };
}
