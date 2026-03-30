import { Candle, Order, Signal } from '../utils/types';
import { calcATR, calcAvgVolume, calcHighestHigh, calcLowestLow, calcPriceChangeRate } from './indicators';
import { MicroCandleBuilder } from '../realtime';

export interface MomentumTriggerConfig {
  primaryIntervalSec: number;
  confirmIntervalSec: number;
  volumeSurgeLookback: number;
  volumeSurgeMultiplier: number;
  priceBreakoutLookback: number;
  confirmMinBars: number;
  confirmMinPriceChangePct: number;
  cooldownSec: number;
}

export interface MomentumOrderParams {
  slMode: 'atr' | 'swing_low' | 'candle_low';
  slAtrMultiplier: number;
  slSwingLookback: number;
  timeStopMinutes: number;
  atrPeriod: number;
  tp1Multiplier: number;
  tp2Multiplier: number;
}

const DEFAULT_ORDER_PARAMS: MomentumOrderParams = {
  slMode: 'atr',
  slAtrMultiplier: 1.5,
  slSwingLookback: 5,
  timeStopMinutes: 15,
  atrPeriod: 14,
  tp1Multiplier: 1.5,
  tp2Multiplier: 3.5,
};

export interface TriggerRejectStats {
  /** 총 primary 봉 평가 횟수 */
  evaluations: number;
  /** 발화된 신호 수 */
  signals: number;
  /** 봉 히스토리 부족 (lookback 미달) */
  insufficientCandles: number;
  /** volumeRatio < volumeSurgeMultiplier */
  volumeInsufficient: number;
  /** close <= 20봉 최고가 — 신고가 돌파 실패 */
  noBreakout: number;
  /** confirm 봉 중 양봉 미충족 또는 가격변화 미달 */
  confirmFail: number;
  /** 쿨다운 미경과 */
  cooldown: number;
}

export class MomentumTrigger {
  private readonly config: MomentumTriggerConfig;
  private readonly lastSignalAt = new Map<string, number>();
  private readonly rejectStats: TriggerRejectStats = {
    evaluations: 0,
    signals: 0,
    insufficientCandles: 0,
    volumeInsufficient: 0,
    noBreakout: 0,
    confirmFail: 0,
    cooldown: 0,
  };

  constructor(config: MomentumTriggerConfig) {
    this.config = config;
  }

  getRejectStats(): Readonly<TriggerRejectStats> {
    return { ...this.rejectStats };
  }

  onCandle(candle: Candle, candleBuilder: MicroCandleBuilder): Signal | null {
    if (candle.intervalSec !== this.config.primaryIntervalSec) {
      return null;
    }

    const lookback = Math.max(this.config.volumeSurgeLookback, this.config.priceBreakoutLookback);
    const candles = candleBuilder.getRecentCandles(candle.pairAddress, candle.intervalSec, lookback + 1);
    if (candles.length < lookback + 1) {
      this.rejectStats.insufficientCandles++;
      return null;
    }

    this.rejectStats.evaluations++;

    const current = candles[candles.length - 1];
    const previous = candles.slice(0, -1);
    const avgVolume = calcAvgVolume(previous, this.config.volumeSurgeLookback);
    const volumeRatio = avgVolume > 0 ? current.volume / avgVolume : 0;
    const highestHigh = calcHighestHigh(previous, this.config.priceBreakoutLookback);
    const breakout = current.close > highestHigh;
    const confirmation = this.checkConfirmation(candle.pairAddress, candleBuilder);
    const cooldownReady = this.isCooldownReady(candle.pairAddress, current.timestamp.getTime() / 1000);

    // 독립적으로 카운팅 (복수 조건 동시 실패 가능)
    if (volumeRatio < this.config.volumeSurgeMultiplier) this.rejectStats.volumeInsufficient++;
    if (!breakout) this.rejectStats.noBreakout++;
    if (!confirmation.passed) this.rejectStats.confirmFail++;
    if (!cooldownReady) this.rejectStats.cooldown++;

    if (
      volumeRatio < this.config.volumeSurgeMultiplier ||
      !breakout ||
      !confirmation.passed ||
      !cooldownReady
    ) {
      return null;
    }

    const atr = calcATR(candles, Math.min(DEFAULT_ORDER_PARAMS.atrPeriod, candles.length - 1));
    const timestampSec = Math.floor(current.timestamp.getTime() / 1000);
    const closeTimestampSec = timestampSec + current.intervalSec;
    this.lastSignalAt.set(candle.pairAddress, timestampSec);
    this.rejectStats.signals++;

    return {
      action: 'BUY',
      strategy: 'volume_spike',
      pairAddress: candle.pairAddress,
      price: current.close,
      timestamp: new Date(closeTimestampSec * 1000),
      meta: {
        realtimeSignal: 1,
        primaryIntervalSec: this.config.primaryIntervalSec,
        confirmIntervalSec: this.config.confirmIntervalSec,
        primaryCandleStartSec: timestampSec,
        primaryCandleCloseSec: closeTimestampSec,
        volumeRatio,
        avgVolume,
        currentVolume: current.volume,
        highestHigh,
        confirmPriceChangePct: confirmation.priceChangePct,
        confirmBullishBars: confirmation.bullishBars,
        atr,
      },
    };
  }

  private checkConfirmation(
    pairAddress: string,
    candleBuilder: MicroCandleBuilder
  ): { passed: boolean; bullishBars: number; priceChangePct: number } {
    const candles = candleBuilder.getRecentCandles(
      pairAddress,
      this.config.confirmIntervalSec,
      this.config.confirmMinBars
    );
    if (candles.length < this.config.confirmMinBars) {
      return { passed: false, bullishBars: 0, priceChangePct: 0 };
    }

    const bullishBars = candles.filter((item) => item.close > item.open).length;
    const priceChangePct = calcPriceChangeRate(candles, this.config.confirmMinBars);
    const passed = bullishBars === candles.length && priceChangePct >= this.config.confirmMinPriceChangePct;

    return { passed, bullishBars, priceChangePct };
  }

  private isCooldownReady(pairAddress: string, timestampSec: number): boolean {
    const previousSignalAt = this.lastSignalAt.get(pairAddress);
    if (!previousSignalAt) return true;
    return timestampSec - previousSignalAt >= this.config.cooldownSec;
  }
}

export function buildMomentumTriggerOrder(
  signal: Signal,
  candles: Candle[],
  quantity: number,
  params: Partial<MomentumOrderParams> = {}
): Order {
  const config = { ...DEFAULT_ORDER_PARAMS, ...params };
  const current = candles[candles.length - 1];
  const atr = signal.meta.atr || calcATR(candles, Math.min(config.atrPeriod, candles.length - 1));
  const stopLoss = resolveStopLoss(signal.price, current.low, candles, atr, config);
  const trailingStop = atr > 0 ? atr : Math.max(signal.price - stopLoss, 0);

  return {
    pairAddress: signal.pairAddress,
    strategy: signal.strategy,
    side: 'BUY',
    price: signal.price,
    quantity,
    stopLoss,
    takeProfit1: signal.price + trailingStop * config.tp1Multiplier,
    takeProfit2: signal.price + trailingStop * config.tp2Multiplier,
    trailingStop,
    timeStopMinutes: config.timeStopMinutes,
  };
}

function resolveStopLoss(
  entryPrice: number,
  candleLow: number,
  candles: Candle[],
  atr: number,
  config: MomentumOrderParams
): number {
  if (config.slMode === 'candle_low') {
    return candleLow;
  }

  if (config.slMode === 'swing_low') {
    const lookback = Math.min(config.slSwingLookback, candles.length);
    return calcLowestLow(candles, lookback);
  }

  if (atr > 0) {
    const atrStop = entryPrice - atr * config.slAtrMultiplier;
    if (atrStop > 0 && atrStop < entryPrice) {
      return atrStop;
    }
  }
  // ATR 기반 stop이 비정상일 때 0으로 내려가지 않도록 유효한 최근 저점을 사용한다.
  const lookback = Math.min(config.slSwingLookback, candles.length);
  const swingLow = lookback > 0 ? calcLowestLow(candles, lookback) : candleLow;
  const fallbackStops = [candleLow, swingLow]
    .filter((value) => Number.isFinite(value) && value > 0 && value < entryPrice);
  if (fallbackStops.length > 0) {
    return Math.max(...fallbackStops);
  }
  return Math.max(entryPrice * 0.9, Number.EPSILON);
}
