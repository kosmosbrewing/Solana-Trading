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

export class MomentumTrigger {
  private readonly config: MomentumTriggerConfig;
  private readonly lastSignalAt = new Map<string, number>();

  constructor(config: MomentumTriggerConfig) {
    this.config = config;
  }

  onCandle(candle: Candle, candleBuilder: MicroCandleBuilder): Signal | null {
    if (candle.intervalSec !== this.config.primaryIntervalSec) {
      return null;
    }

    const lookback = Math.max(this.config.volumeSurgeLookback, this.config.priceBreakoutLookback);
    const candles = candleBuilder.getRecentCandles(candle.pairAddress, candle.intervalSec, lookback + 1);
    if (candles.length < lookback + 1) {
      return null;
    }

    const current = candles[candles.length - 1];
    const previous = candles.slice(0, -1);
    const avgVolume = calcAvgVolume(previous, this.config.volumeSurgeLookback);
    const volumeRatio = avgVolume > 0 ? current.volume / avgVolume : 0;
    const highestHigh = calcHighestHigh(previous, this.config.priceBreakoutLookback);
    const breakout = current.close > highestHigh;
    const confirmation = this.checkConfirmation(candle.pairAddress, candleBuilder);
    const cooldownReady = this.isCooldownReady(candle.pairAddress, current.timestamp.getTime() / 1000);

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
    return Math.max(0, entryPrice - atr * config.slAtrMultiplier);
  }

  return candleLow;
}
