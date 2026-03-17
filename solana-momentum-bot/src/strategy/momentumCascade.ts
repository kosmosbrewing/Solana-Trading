import { Candle, Signal, Order } from '../utils/types';
import { calcATR, calcAvgVolume, calcHighestHigh } from './indicators';
import { evaluateVolumeSpikeBreakout, VolumeSpikeParams } from './volumeSpikeBreakout';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('StrategyE');

export interface CascadeLeg {
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  entryIdx: number;
  entryTime: Date;
}

export interface CascadeState {
  /** Original first entry */
  legs: CascadeLeg[];
  /** Combined cost basis */
  costBasis: number;
  /** Total quantity across all legs */
  totalQuantity: number;
  /** Original 1R risk in SOL */
  originalRiskSol: number;
  /** Combined stop loss (recalculated per add-on) */
  combinedStopLoss: number;
  /** Original TP2 (applies to entire position) */
  takeProfit2: number;
  /** Peak price for trailing */
  peakPrice: number;
  /** Has TP1 been hit on first leg? */
  tp1Hit: boolean;
  /** Number of add-on entries (max 2 total: 1 original + 1 add-on) */
  addOnCount: number;
}

export interface MomentumCascadeParams {
  /** Minimum R-multiple the first leg must reach before add-on (default: 1.0) */
  minProfitR: number;
  /** Volume spike multiplier for re-acceleration detection (default: 2.5) */
  reaccelerationVolMult: number;
  /** Max add-on entries (default: 1, so 2 legs total) */
  maxAddOns: number;
  /** Lookback for re-compression detection (default: 10 bars) */
  recompressionLookback: number;
  /** Re-compression: price must pull back at least this fraction of ATR from peak (default: 0.4) */
  recompressionMinPullbackAtr: number;
  /** Re-compression: range must narrow to this fraction of recent range (default: 0.6) */
  recompressionRangeRatio: number;
}

export const DEFAULT_CASCADE_PARAMS: MomentumCascadeParams = {
  minProfitR: 1.0,
  reaccelerationVolMult: 2.5,
  maxAddOns: 1,
  recompressionLookback: 10,
  recompressionMinPullbackAtr: 0.4,
  recompressionRangeRatio: 0.6,
};

/**
 * Strategy E: Momentum Cascade — Strategy A 확장.
 *
 * 별도 메인 전략이 아니라 A의 add-on 기능:
 *   1. A의 첫 진입이 +1R 이상 진행
 *   2. TP1 도달 후 50% 익절 완료
 *   3. 가격 재압축 감지 (range narrowing + pullback)
 *   4. 재가속 감지 (volume spike + new breakout)
 *   5. 추가 진입, 총 리스크 1R 이내
 *   6. Combined SL 전체 포지션 기준 재산정
 *
 * 활성화 조건:
 *   - Strategy A 라이브 expectancy > 0 (최소 50 트레이드)
 *   - EdgeState ∈ {Confirmed, Proven}
 */

/**
 * H-06: Backtest-compatible signal evaluator for Strategy E.
 * Uses volume spike breakout detection but tags as momentum_cascade.
 */
export function evaluateMomentumCascadeEntry(
  candles: Candle[],
  params: Partial<MomentumCascadeParams & VolumeSpikeParams> = {}
): Signal {
  const signal = evaluateVolumeSpikeBreakout(candles, params);
  return {
    ...signal,
    strategy: 'momentum_cascade',
  };
}

/**
 * H-06: Backtest-compatible order builder for Strategy E.
 * 캐스케이드 첫 진입은 volume_spike와 동일한 SL/TP, 단 시간 제한 연장.
 */
export function buildMomentumCascadeOrder(
  signal: Signal,
  candles: Candle[],
  quantity: number,
  params: Partial<MomentumCascadeParams & VolumeSpikeParams> = {}
): Order {
  const p = { ...DEFAULT_CASCADE_PARAMS, ...params };
  const currentCandle = candles[candles.length - 1];
  const atr = signal.meta.atr || calcATR(candles, params.atrPeriod ?? 20);

  return {
    pairAddress: signal.pairAddress,
    strategy: 'momentum_cascade',
    side: 'BUY',
    price: signal.price,
    quantity,
    stopLoss: currentCandle.low,
    takeProfit1: signal.price + atr * (params.tp1Multiplier ?? 1.5),
    takeProfit2: signal.price + atr * (params.tp2Multiplier ?? 2.5),
    trailingStop: atr,
    timeStopMinutes: 120, // 캐스케이드는 add-on 감지를 위해 2시간 확보
  };
}

/**
 * Check if first leg qualifies for add-on entry.
 * Must be +minProfitR in profit AND TP1 must have been hit.
 */
export function isFirstLegQualified(
  leg: CascadeLeg,
  currentPrice: number,
  originalRiskSol: number,
  tp1Hit: boolean,
  params: Partial<MomentumCascadeParams> = {}
): boolean {
  const p = { ...DEFAULT_CASCADE_PARAMS, ...params };

  if (!tp1Hit) return false;

  // Current unrealized P&L in R
  const unrealizedPnl = (currentPrice - leg.entryPrice) * leg.quantity;
  const currentR = originalRiskSol > 0 ? unrealizedPnl / originalRiskSol : 0;

  return currentR >= p.minProfitR;
}

/**
 * Detect re-compression: price pulls back from peak, range narrows.
 */
export function detectRecompression(
  candles: Candle[],
  peakPrice: number,
  params: Partial<MomentumCascadeParams> = {}
): boolean {
  const p = { ...DEFAULT_CASCADE_PARAMS, ...params };
  const n = Math.min(p.recompressionLookback, candles.length);
  if (n < 5) return false;

  const recent = candles.slice(-n);
  const atr = calcATR(candles, Math.min(14, candles.length - 1));
  if (atr <= 0) return false;

  // Price has pulled back from peak by at least minPullbackAtr × ATR
  const currentPrice = recent[recent.length - 1].close;
  const pullback = peakPrice - currentPrice;
  if (pullback < p.recompressionMinPullbackAtr * atr) return false;

  // Range is narrowing: last 5 bars range vs first 5 bars range
  const firstHalf = recent.slice(0, Math.floor(n / 2));
  const secondHalf = recent.slice(Math.floor(n / 2));

  const firstRange = Math.max(...firstHalf.map(c => c.high)) - Math.min(...firstHalf.map(c => c.low));
  const secondRange = Math.max(...secondHalf.map(c => c.high)) - Math.min(...secondHalf.map(c => c.low));

  if (firstRange <= 0) return false;
  return (secondRange / firstRange) <= p.recompressionRangeRatio;
}

/**
 * Detect re-acceleration: volume spike + price breakout from compression range.
 * H-10: price confirmation 추가 — compression range 상단 돌파 필수
 */
export function detectReacceleration(
  candles: Candle[],
  spikeParams: Partial<VolumeSpikeParams> = {},
  cascadeParams: Partial<MomentumCascadeParams> = {}
): Signal {
  const p = { ...DEFAULT_CASCADE_PARAMS, ...cascadeParams };

  // Use volume spike evaluator with lower threshold for re-acceleration
  const signal = evaluateVolumeSpikeBreakout(candles, {
    ...spikeParams,
    volumeMultiplier: p.reaccelerationVolMult,
  });

  // Price confirmation: 최근 compression range 상단을 돌파해야 유효
  if (signal.action === 'BUY' && candles.length >= p.recompressionLookback) {
    const compressionWindow = candles.slice(-p.recompressionLookback, -1);
    const rangeHigh = Math.max(...compressionWindow.map(c => c.high));
    const currentClose = candles[candles.length - 1].close;

    if (currentClose <= rangeHigh) {
      return { ...signal, action: 'HOLD', meta: { ...signal.meta, priceConfirmation: 0 } };
    }
  }

  return signal;
}

/**
 * Calculate combined stop loss after add-on entry.
 * Ensures total risk across all legs stays within originalRiskSol.
 */
export function calculateCombinedStopLoss(
  legs: CascadeLeg[],
  originalRiskSol: number
): number {
  if (legs.length === 0) return 0;

  const totalQuantity = legs.reduce((sum, leg) => sum + leg.quantity, 0);
  if (totalQuantity <= 0) return 0;

  const costBasis = legs.reduce((sum, leg) => sum + leg.entryPrice * leg.quantity, 0) / totalQuantity;

  // SL = costBasis - (originalRiskSol / totalQuantity)
  // This ensures: totalQuantity × (costBasis - SL) = originalRiskSol
  const newSL = costBasis - (originalRiskSol / totalQuantity);

  // Never move SL below the lowest individual leg SL (safety floor)
  const lowestLegSL = Math.min(...legs.map(l => l.stopLoss));

  const flooredSL = Math.max(newSL, lowestLegSL);

  // 상한 제약: SL이 cost basis 이상이면 진입 즉시 손실 확정 → cost basis의 99% 이하로 제한
  return Math.min(flooredSL, costBasis * 0.99);
}

/**
 * Calculate add-on quantity that keeps total risk within 1R.
 *
 * Given existing legs + new entry price + combined SL target,
 * find max quantity for new leg such that total risk ≤ originalRiskSol.
 */
export function calculateAddOnQuantity(
  existingLegs: CascadeLeg[],
  addOnPrice: number,
  originalRiskSol: number,
  maxBalanceFraction: number = 0.2,
  balance: number = 0
): number {
  // H-31: price=0 방어
  if (addOnPrice <= 0) return 0;

  const existingRisk = existingLegs.reduce((sum, leg) => {
    return sum + Math.abs(leg.entryPrice - leg.stopLoss) * leg.quantity;
  }, 0);

  const remainingRisk = Math.max(0, originalRiskSol - existingRisk);
  if (remainingRisk <= 0) return 0;

  // For the add-on, estimate SL = breakeven of first leg (conservative)
  const firstLeg = existingLegs[0];
  if (!firstLeg) return 0;

  // Add-on SL will be close to the first leg's entry (breakeven after TP1)
  const addOnSL = firstLeg.entryPrice;
  const riskPerUnit = Math.abs(addOnPrice - addOnSL);
  if (riskPerUnit <= 0) return 0;

  let quantity = remainingRisk / riskPerUnit;

  // Cap at balance fraction (NaN 방어: balance undefined/NaN 시 무시)
  if (balance != null && Number.isFinite(balance) && balance > 0) {
    const maxFromBalance = (balance * maxBalanceFraction) / addOnPrice;
    quantity = Math.min(quantity, maxFromBalance);
  }

  return Math.max(0, quantity);
}

/**
 * Initialize cascade state from first leg.
 */
export function initCascadeState(
  leg: CascadeLeg,
  takeProfit2: number
): CascadeState {
  const riskPerUnit = Math.abs(leg.entryPrice - leg.stopLoss);
  const originalRiskSol = riskPerUnit * leg.quantity;

  return {
    legs: [leg],
    costBasis: leg.entryPrice,
    totalQuantity: leg.quantity,
    originalRiskSol,
    combinedStopLoss: leg.stopLoss,
    takeProfit2,
    peakPrice: leg.entryPrice,
    tp1Hit: false,
    addOnCount: 0,
  };
}

/**
 * Add a new leg to the cascade, recalculating combined parameters.
 */
export function addCascadeLeg(
  state: CascadeState,
  newLeg: CascadeLeg
): CascadeState {
  const legs = [...state.legs, newLeg];
  const totalQuantity = legs.reduce((sum, l) => sum + l.quantity, 0);
  const costBasis = legs.reduce((sum, l) => sum + l.entryPrice * l.quantity, 0) / totalQuantity;
  const combinedStopLoss = calculateCombinedStopLoss(legs, state.originalRiskSol);

  log.info(
    `Cascade add-on: leg ${legs.length}, price=${newLeg.entryPrice.toFixed(6)}, ` +
    `qty=${newLeg.quantity.toFixed(4)}, combinedSL=${combinedStopLoss.toFixed(6)}, ` +
    `totalQty=${totalQuantity.toFixed(4)}, costBasis=${costBasis.toFixed(6)}`
  );

  return {
    ...state,
    legs,
    totalQuantity,
    costBasis,
    combinedStopLoss,
    addOnCount: state.addOnCount + 1,
  };
}

/**
 * Cascade state 업데이트: peak price 갱신 + TP1 도달 감지.
 * Position monitor 루프에서 매 캔들/틱마다 호출.
 */
export function updateCascadeState(
  state: CascadeState,
  currentPrice: number,
  tp1Price: number
): CascadeState {
  const peakPrice = Math.max(state.peakPrice, currentPrice);
  const tp1Hit = state.tp1Hit || currentPrice >= tp1Price;

  if (tp1Hit && !state.tp1Hit) {
    log.info(`Cascade TP1 hit at ${currentPrice.toFixed(6)} (target: ${tp1Price.toFixed(6)})`);
  }

  return { ...state, peakPrice, tp1Hit };
}
