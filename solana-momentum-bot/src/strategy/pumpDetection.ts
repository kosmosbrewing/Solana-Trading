import { Candle, Signal, Order } from '../utils/types';
import { countConsecutiveBullish, calcPriceChangeRate } from './indicators';

export interface PumpDetectParams {
  consecutiveCandles: number;  // N연속 양봉 (default: 3)
  minPriceMove: number;        // 최소 가격 변동률 (default: 0.05 = 5%)
  tp1Pct: number;              // TP1 진입가 +10%
  tp2Pct: number;              // TP2 진입가 +20%
  timeStopMinutes: number;     // 15분
}

const DEFAULT_PARAMS: PumpDetectParams = {
  consecutiveCandles: 3,
  minPriceMove: 0.05,
  tp1Pct: 0.10,
  tp2Pct: 0.20,
  timeStopMinutes: 15,
};

/**
 * Strategy B: Pump Detection — 순수 함수
 *
 * 조건:
 * 1. N연속 양봉 (종가 > 시가)
 * 2. 3봉 누적 가격 변동률 > 5%
 *
 * 모든 입력은 캔들 배열, 출력은 Signal — 상태 없음
 */
export function evaluatePumpDetection(
  candles: Candle[],
  params: Partial<PumpDetectParams> = {}
): Signal {
  const p = { ...DEFAULT_PARAMS, ...params };
  const pairAddress = candles[0]?.pairAddress || '';
  const holdSignal: Signal = {
    action: 'HOLD',
    strategy: 'pump_detect',
    pairAddress,
    price: candles[candles.length - 1]?.close || 0,
    timestamp: new Date(),
    meta: {},
  };

  if (candles.length < p.consecutiveCandles) {
    return holdSignal;
  }

  // 1. 연속 양봉 체크
  const bullishCount = countConsecutiveBullish(candles);
  const consecutiveCheck = bullishCount >= p.consecutiveCandles;

  // 2. 누적 가격 변동률 체크
  const priceChange = calcPriceChangeRate(candles, p.consecutiveCandles);
  const priceCheck = priceChange >= p.minPriceMove;

  const meta = {
    bullishCount,
    priceChange,
    priceChangePct: priceChange * 100,
  };

  if (consecutiveCheck && priceCheck) {
    return {
      action: 'BUY',
      strategy: 'pump_detect',
      pairAddress,
      price: candles[candles.length - 1].close,
      timestamp: new Date(),
      meta,
    };
  }

  return { ...holdSignal, meta };
}

/**
 * Pump Detection 시그널에서 주문 파라미터 생성
 */
export function buildPumpOrder(
  signal: Signal,
  candles: Candle[],
  quantity: number,
  params: Partial<PumpDetectParams> = {}
): Order {
  const p = { ...DEFAULT_PARAMS, ...params };

  // 1번째 양봉의 시가 = Stop Loss
  const firstBullishIdx = candles.length - p.consecutiveCandles;
  const firstBullishOpen = candles[firstBullishIdx]?.open || signal.price * 0.95;

  return {
    pairAddress: signal.pairAddress,
    strategy: 'pump_detect',
    side: 'BUY',
    price: signal.price,
    quantity,
    stopLoss: firstBullishOpen,
    takeProfit1: signal.price * (1 + p.tp1Pct),
    takeProfit2: signal.price * (1 + p.tp2Pct),
    timeStopMinutes: p.timeStopMinutes,
  };
}
