import { summarizeTradeObservation } from '../src/orchestration/tradeMonitoring';
import type { Candle, Trade } from '../src/utils/types';

describe('tradeMonitoring', () => {
  it('ignores candle highs from before the trade was opened', () => {
    const trade = {
      createdAt: new Date('2026-03-30T00:05:00Z'),
      entryPrice: 1,
      highWaterMark: 1,
    } as Pick<Trade, 'createdAt' | 'entryPrice' | 'highWaterMark'>;
    const candles: Candle[] = [
      {
        pairAddress: 'pair-1',
        timestamp: new Date('2026-03-30T00:00:00Z'),
        intervalSec: 300,
        open: 0.95,
        high: 1.4,
        low: 0.94,
        close: 1.02,
        volume: 100,
        buyVolume: 60,
        sellVolume: 40,
        tradeCount: 10,
      },
      {
        pairAddress: 'pair-1',
        timestamp: new Date('2026-03-30T00:10:00Z'),
        intervalSec: 300,
        open: 1.01,
        high: 1.08,
        low: 1.0,
        close: 1.04,
        volume: 120,
        buyVolume: 70,
        sellVolume: 50,
        tradeCount: 12,
      },
    ];

    const observation = summarizeTradeObservation(trade, candles, 1.03);

    expect(observation.observedHigh).toBeCloseTo(1.08, 8);
    expect(observation.observedLow).toBeCloseTo(1.0, 8);
    expect(observation.peakPrice).toBeCloseTo(1.08, 8);
  });
});
