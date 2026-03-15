import { Candle, Signal, Order } from '../utils/types';
import { calcATR, calcAvgVolume } from './indicators';

export interface FibPullbackParams {
  impulseWindowBars: number;    // 임펄스 탐지 윈도우 (default: 18 = 90분/5분봉)
  impulseMinPct: number;        // 최소 임펄스 상승률 (default: 0.15 = 15%)
  fibEntryLow: number;          // Fib 진입 하한 (default: 0.5)
  fibEntryHigh: number;         // Fib 진입 상한 (default: 0.618)
  fibInvalidation: number;      // Fib 무효화 레벨 (default: 0.786)
  volumeClimaxMultiplier: number; // 하락 봉 거래량 배수 (default: 2.5)
  minWickRatio: number;         // 최소 아래꼬리 비율 (default: 0.4)
  atrPeriod: number;            // ATR 기간 (default: 14)
  tp1Multiplier: number;        // TP1 = 임펄스 고점 × 90%
  tp2Multiplier: number;        // TP2 = 임펄스 고점 100%
  timeStopMinutes: number;      // 시간 정지 (default: 60)
}

const DEFAULT_PARAMS: FibPullbackParams = {
  impulseWindowBars: 18,
  impulseMinPct: 0.15,
  fibEntryLow: 0.5,
  fibEntryHigh: 0.618,
  fibInvalidation: 0.786,
  volumeClimaxMultiplier: 2.5,
  minWickRatio: 0.4,
  atrPeriod: 14,
  tp1Multiplier: 0.90,
  tp2Multiplier: 1.0,
  timeStopMinutes: 60,
};

/**
 * 임펄스 탐지 결과
 */
interface ImpulseResult {
  found: boolean;
  swingLow: number;       // 임펄스 시작점 (최저가)
  swingHigh: number;      // 임펄스 정점 (최고가)
  swingLowIdx: number;
  swingHighIdx: number;
  impulsePct: number;     // 상승률
}

/**
 * Fib 레벨 계산
 */
interface FibLevels {
  fib50: number;
  fib618: number;
  fib786: number;
  swingLow: number;
  swingHigh: number;
}

/**
 * Pullback 상태 추적
 */
interface PullbackState {
  enteredFibZone: boolean;    // 가격이 fib 0.5~0.618 구간에 진입했는지
  volumeClimaxSeen: boolean;  // 하락 봉 거래량 급증 확인
  reclaimSeen: boolean;       // reclaim 봉 확인 (종가가 fib 위로 회복)
  reclaimBarIdx: number;      // reclaim 봉 인덱스
}

/**
 * Strategy C: Fib Pullback — 임펄스 후 되돌림 매수
 *
 * 1. 최근 N봉 내 +15% 이상 상승 임펄스 탐지
 * 2. Fib 0.5 / 0.618 / 0.786 계산
 * 3. 가격이 0.5~0.618 구간 진입 확인
 * 4. 하락 봉 거래량 평균 대비 2.5배 이상 (volume climax)
 * 5. Reclaim 봉: 종가가 Fib 0.5 위로 회복
 * 6. 아래꼬리 비율 확인
 * 7. 다음 봉 확인 후 진입 시그널
 */
export function evaluateFibPullback(
  candles: Candle[],
  params: Partial<FibPullbackParams> = {}
): Signal {
  const p = { ...DEFAULT_PARAMS, ...params };
  const pairAddress = candles[0]?.pairAddress || '';
  const holdSignal: Signal = {
    action: 'HOLD',
    strategy: 'fib_pullback',
    pairAddress,
    price: candles[candles.length - 1]?.close || 0,
    timestamp: new Date(),
    meta: {},
  };

  // 최소 캔들 수: 임펄스 윈도우 + 되돌림 여유 + 확인 봉
  const minCandles = p.impulseWindowBars + 5;
  if (candles.length < minCandles) {
    return holdSignal;
  }

  // Step 1: 임펄스 탐지
  const impulse = findImpulse(candles, p.impulseWindowBars, p.impulseMinPct);
  if (!impulse.found) {
    return holdSignal;
  }

  // Step 2: Fib 레벨 계산
  const fibs = calcFibLevels(impulse.swingLow, impulse.swingHigh);

  // Step 3~6: 되돌림 구간에서 조건 확인
  const pullbackCandles = candles.slice(impulse.swingHighIdx);
  if (pullbackCandles.length < 2) {
    return holdSignal;
  }

  const avgVol = calcAvgVolume(candles.slice(0, impulse.swingHighIdx), Math.min(p.impulseWindowBars, impulse.swingHighIdx));
  const pullback = analyzePullback(pullbackCandles, fibs, p, avgVol);

  if (!pullback.enteredFibZone || !pullback.volumeClimaxSeen || !pullback.reclaimSeen) {
    return { ...holdSignal, meta: buildMeta(impulse, fibs, pullback) };
  }

  // Step 7: reclaim 봉 다음 봉이 현재 봉인지 확인 (확인 봉 대기)
  const currentIdx = pullbackCandles.length - 1;
  if (currentIdx <= pullback.reclaimBarIdx) {
    return { ...holdSignal, meta: buildMeta(impulse, fibs, pullback) };
  }

  const currentCandle = candles[candles.length - 1];

  // 현재 가격이 fib 0.786 아래면 무효화
  if (currentCandle.close < fibs.fib786) {
    return { ...holdSignal, meta: { ...buildMeta(impulse, fibs, pullback), invalidated: 1 } };
  }

  // 아래꼬리 비율 확인 (reclaim 봉)
  const reclaimCandle = pullbackCandles[pullback.reclaimBarIdx];
  const wickRatio = calcLowerWickRatio(reclaimCandle);
  if (wickRatio < p.minWickRatio) {
    return { ...holdSignal, meta: { ...buildMeta(impulse, fibs, pullback), wickRatio } };
  }

  // 모든 조건 충족 → BUY 시그널
  const atr = calcATR(candles, p.atrPeriod);

  return {
    action: 'BUY',
    strategy: 'fib_pullback',
    pairAddress,
    price: currentCandle.close,
    timestamp: new Date(),
    meta: {
      ...buildMeta(impulse, fibs, pullback),
      wickRatio,
      atr,
      confirmBar: 1,
    },
  };
}

/**
 * Fib Pullback 시그널에서 주문 파라미터 생성
 */
export function buildFibPullbackOrder(
  signal: Signal,
  candles: Candle[],
  quantity: number,
  params: Partial<FibPullbackParams> = {}
): Order {
  const p = { ...DEFAULT_PARAMS, ...params };
  const atr = signal.meta.atr || calcATR(candles, p.atrPeriod);
  const swingHigh = signal.meta.swingHigh || signal.price * 1.1;
  const swingLow = signal.meta.swingLow || signal.price * 0.9;

  // SL: Fib 0.786 아래 (또는 swing low)
  const fib786 = swingHigh - (swingHigh - swingLow) * p.fibInvalidation;
  const stopLoss = Math.max(fib786 - atr * 0.3, swingLow);

  // TP1: 임펄스 고점의 90%, TP2: 임펄스 고점 100%
  const tp1 = signal.price + (swingHigh - signal.price) * p.tp1Multiplier;
  const tp2 = signal.price + (swingHigh - signal.price) * p.tp2Multiplier;

  return {
    pairAddress: signal.pairAddress,
    strategy: 'fib_pullback',
    side: 'BUY',
    price: signal.price,
    quantity,
    stopLoss,
    takeProfit1: tp1,
    takeProfit2: tp2,
    trailingStop: atr * 1.5,
    timeStopMinutes: p.timeStopMinutes,
  };
}

// ─── Internal Helpers ─────────────────────────────────────

/**
 * 최근 N봉 내에서 최대 상승 임펄스 탐지
 * swing low → swing high 순서로, 상승률이 minPct 이상인 구간
 */
function findImpulse(
  candles: Candle[],
  windowBars: number,
  minPct: number
): ImpulseResult {
  const empty: ImpulseResult = {
    found: false, swingLow: 0, swingHigh: 0,
    swingLowIdx: 0, swingHighIdx: 0, impulsePct: 0,
  };

  const startIdx = Math.max(0, candles.length - windowBars - 5);
  const endIdx = candles.length - 2; // 현재 봉 제외 (되돌림 여유)

  let bestImpulse = empty;

  // swing low를 찾고, 그 이후 swing high를 찾음
  for (let i = startIdx; i < endIdx; i++) {
    const low = candles[i].low;

    for (let j = i + 1; j <= endIdx; j++) {
      const high = candles[j].high;
      const pct = (high - low) / low;

      if (pct >= minPct && pct > bestImpulse.impulsePct) {
        // swing low 이후에 swing high가 있는지 확인
        // (low가 구간 내 최저이고, high가 low 이후 최고여야 함)
        const isValidLow = candles.slice(i, j + 1).every(c => c.low >= low);
        const isValidHigh = candles.slice(i, j + 1).every(c => c.high <= high);

        if (isValidLow && isValidHigh) {
          bestImpulse = {
            found: true,
            swingLow: low,
            swingHigh: high,
            swingLowIdx: i,
            swingHighIdx: j,
            impulsePct: pct,
          };
        }
      }
    }
  }

  return bestImpulse;
}

/**
 * Fibonacci retracement 레벨 계산
 */
function calcFibLevels(swingLow: number, swingHigh: number): FibLevels {
  const range = swingHigh - swingLow;
  return {
    fib50: swingHigh - range * 0.5,
    fib618: swingHigh - range * 0.618,
    fib786: swingHigh - range * 0.786,
    swingLow,
    swingHigh,
  };
}

/**
 * 되돌림 구간 분석 — fib zone 진입, volume climax, reclaim 확인
 */
function analyzePullback(
  pullbackCandles: Candle[],
  fibs: FibLevels,
  params: FibPullbackParams,
  avgVolume: number
): PullbackState {
  const state: PullbackState = {
    enteredFibZone: false,
    volumeClimaxSeen: false,
    reclaimSeen: false,
    reclaimBarIdx: -1,
  };

  const fibEntryUpper = fibs.swingHigh - (fibs.swingHigh - fibs.swingLow) * params.fibEntryLow;   // fib 0.5 가격
  const fibEntryLower = fibs.swingHigh - (fibs.swingHigh - fibs.swingLow) * params.fibEntryHigh;   // fib 0.618 가격

  for (let i = 0; i < pullbackCandles.length; i++) {
    const c = pullbackCandles[i];

    // Fib 0.786 이하로 하락 → 임펄스 무효화
    if (c.close < fibs.fib786) {
      state.enteredFibZone = false;
      state.volumeClimaxSeen = false;
      state.reclaimSeen = false;
      continue;
    }

    // Step 3: 가격이 fib 0.5~0.618 구간에 진입
    if (c.low <= fibEntryUpper && c.low >= fibEntryLower) {
      state.enteredFibZone = true;
    }

    // Step 4: 하락 봉 + 거래량 급증 (volume climax)
    if (state.enteredFibZone && !state.volumeClimaxSeen) {
      const isBearish = c.close < c.open;
      const volRatio = avgVolume > 0 ? c.volume / avgVolume : 0;
      if (isBearish && volRatio >= params.volumeClimaxMultiplier) {
        state.volumeClimaxSeen = true;
      }
    }

    // Step 5: Reclaim 봉 — 종가가 fib 0.5 위로 회복
    if (state.enteredFibZone && state.volumeClimaxSeen && !state.reclaimSeen) {
      if (c.close > fibEntryUpper) {
        state.reclaimSeen = true;
        state.reclaimBarIdx = i;
      }
    }
  }

  return state;
}

/**
 * 아래꼬리 비율 계산
 * wickRatio = (close - low) / (high - low)  (양봉 기준)
 * 음봉이면: (open - low) / (high - low)
 */
function calcLowerWickRatio(candle: Candle): number {
  const range = candle.high - candle.low;
  if (range <= 0) return 0;
  const body = Math.abs(candle.close - candle.open);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  return lowerWick / range;
}

function buildMeta(
  impulse: ImpulseResult,
  fibs: FibLevels,
  pullback: PullbackState
): Record<string, number> {
  return {
    impulsePct: impulse.impulsePct,
    swingLow: impulse.swingLow,
    swingHigh: impulse.swingHigh,
    fib50: fibs.fib50,
    fib618: fibs.fib618,
    fib786: fibs.fib786,
    fibZoneEntered: pullback.enteredFibZone ? 1 : 0,
    volumeClimax: pullback.volumeClimaxSeen ? 1 : 0,
    reclaimed: pullback.reclaimSeen ? 1 : 0,
  };
}
