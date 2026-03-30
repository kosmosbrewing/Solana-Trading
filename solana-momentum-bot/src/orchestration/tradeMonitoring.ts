import { Candle, Trade } from '../utils/types';

export interface TradeObservation {
  currentPrice: number;
  observedHigh: number;
  observedLow: number;
  peakPrice: number;
}

export function summarizeTradeObservation(
  trade: Pick<Trade, 'createdAt' | 'entryPrice' | 'highWaterMark'>,
  recentCandles: Candle[],
  currentPrice: number
): TradeObservation {
  const postEntryCandles = recentCandles.filter((candle) => candle.timestamp.getTime() > trade.createdAt.getTime());
  const observedHigh = Math.max(
    currentPrice,
    trade.highWaterMark ?? trade.entryPrice,
    ...postEntryCandles.map((candle) => candle.high)
  );
  const observedLow = Math.min(
    currentPrice,
    ...postEntryCandles.map((candle) => candle.low)
  );

  return {
    currentPrice,
    observedHigh,
    observedLow,
    peakPrice: observedHigh,
  };
}
