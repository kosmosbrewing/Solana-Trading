import { replayRealtimeCandles, replayRealtimeCandlesStream, replayRealtimeDataset } from '../src/backtest/microReplayEngine';
import { StoredRealtimeSwap } from '../src/realtime/replayStore';
import { Candle } from '../src/utils/types';

function makeSwap(timestamp: number, priceNative: number, amountQuote: number, signature: string): StoredRealtimeSwap {
  return {
    pairAddress: 'pool-1',
    poolAddress: 'pool-1',
    pool: 'pool-1',
    signature,
    timestamp,
    side: 'buy',
    priceNative,
    amountBase: 10,
    amountQuote,
    slot: timestamp,
    source: 'logs',
    tokenMint: 'pool-1',
  };
}

function makeCandle(
  intervalSec: number,
  timestampSec: number,
  open: number,
  close: number,
  volume: number
): Candle {
  return {
    pairAddress: 'pool-1',
    timestamp: new Date(timestampSec * 1000),
    intervalSec,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume,
    buyVolume: volume * 0.7,
    sellVolume: volume * 0.3,
    tradeCount: 10,
  };
}

describe('microReplayEngine', () => {
  it('replays raw swaps into realtime signals and summary metrics', async () => {
    const swaps: StoredRealtimeSwap[] = [
      makeSwap(1, 1.00, 5, 'a1'),
      makeSwap(4, 1.05, 12, 'a2'),
      makeSwap(6, 1.06, 6, 'b1'),
      makeSwap(9, 1.12, 20, 'b2'),
      makeSwap(11, 1.13, 7, 'c1'),
      makeSwap(14, 1.20, 22, 'c2'),
      makeSwap(41, 1.28, 10, 'd1'),
      makeSwap(71, 1.35, 10, 'e1'),
    ];

    const result = await replayRealtimeDataset(swaps, {
      triggerConfig: {
        primaryIntervalSec: 5,
        confirmIntervalSec: 5,
        volumeSurgeLookback: 1,
        volumeSurgeMultiplier: 1,
        priceBreakoutLookback: 1,
        confirmMinBars: 1,
        confirmMinPriceChangePct: 0,
        cooldownSec: 300,
      },
      horizonsSec: [30, 60],
      gateMode: 'off',
    });

    expect(result.dataset.swapCount).toBe(8);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].horizons.map((item) => item.horizonSec)).toEqual([30, 60]);
    expect(result.summary.totalSignals).toBe(1);
    expect(result.summary.avgReturnPct).toBeGreaterThan(0);
  });

  it('drops absurd swap-price outliers before replaying', async () => {
    const swaps: StoredRealtimeSwap[] = [
      makeSwap(1, 1.00, 5, 'a1'),
      makeSwap(4, 1.05, 12, 'a2'),
      makeSwap(6, 1.06, 6, 'b1'),
      makeSwap(9, 1.12, 20, 'b2'),
      makeSwap(11, 1.13, 7, 'c1'),
      makeSwap(12, 1e9, 50, 'outlier'),
      makeSwap(14, 1.20, 22, 'c2'),
      makeSwap(41, 1.28, 10, 'd1'),
      makeSwap(71, 1.35, 10, 'e1'),
    ];

    const result = await replayRealtimeDataset(swaps, {
      triggerConfig: {
        primaryIntervalSec: 5,
        confirmIntervalSec: 5,
        volumeSurgeLookback: 1,
        volumeSurgeMultiplier: 1,
        priceBreakoutLookback: 1,
        confirmMinBars: 1,
        confirmMinPriceChangePct: 0,
        cooldownSec: 300,
      },
      horizonsSec: [30, 60],
      gateMode: 'off',
    });

    expect(result.dataset.swapCount).toBe(9);
    expect(result.dataset.droppedSwapCount).toBe(1);
    expect(result.dataset.keptSwapCount).toBe(8);
    expect(result.records).toHaveLength(1);
    expect(result.summary.avgAdjustedReturnPct).toBeLessThan(1);
  });

  it('replays stored micro-candles when raw swaps are not available', async () => {
    const candles: Candle[] = [
      makeCandle(60, 60, 1.0, 1.03, 30),
      makeCandle(60, 120, 1.03, 1.07, 30),
      makeCandle(60, 180, 1.07, 1.12, 30),
      ...Array.from({ length: 20 }, (_, index) =>
        makeCandle(15, 15 * (index + 1), 1 + index * 0.01, 1.01 + index * 0.01, 10)
      ),
      makeCandle(15, 15 * 21, 1.25, 1.35, 50),
      makeCandle(5, 330, 1.35, 1.36, 5),
      makeCandle(5, 360, 1.36, 1.39, 6),
      makeCandle(5, 390, 1.39, 1.42, 7),
    ];

    const result = await replayRealtimeCandles(candles, {
      triggerConfig: {
        primaryIntervalSec: 15,
        confirmIntervalSec: 60,
        volumeSurgeLookback: 20,
        volumeSurgeMultiplier: 3,
        priceBreakoutLookback: 20,
        confirmMinBars: 3,
        confirmMinPriceChangePct: 0.02,
        cooldownSec: 300,
      },
      horizonsSec: [30, 60],
      gateMode: 'off',
    });

    expect(result.dataset.inputMode).toBe('candles');
    expect(result.dataset.candleCount).toBe(candles.length);
    expect(result.records).toHaveLength(1);
    expect(result.summary.totalSignals).toBe(1);
    expect(result.summary.avgReturnPct).toBeGreaterThanOrEqual(0);
  });

  it('drops absurd candle outliers before replaying outcomes', async () => {
    const candles: Candle[] = [
      makeCandle(60, 60, 1.0, 1.03, 30),
      makeCandle(60, 120, 1.03, 1.07, 30),
      makeCandle(60, 180, 1.07, 1.12, 30),
      ...Array.from({ length: 20 }, (_, index) =>
        makeCandle(15, 15 * (index + 1), 1 + index * 0.01, 1.01 + index * 0.01, 10)
      ),
      makeCandle(15, 15 * 21, 1.25, 1.35, 50),
      makeCandle(5, 330, 1.35, 1.36, 5),
      {
        ...makeCandle(5, 345, 1.36, 1.37, 6),
        high: 1000,
      },
      makeCandle(5, 360, 1.36, 1.39, 6),
      makeCandle(5, 390, 1.39, 1.42, 7),
    ];

    const result = await replayRealtimeCandles(candles, {
      triggerConfig: {
        primaryIntervalSec: 15,
        confirmIntervalSec: 60,
        volumeSurgeLookback: 20,
        volumeSurgeMultiplier: 3,
        priceBreakoutLookback: 20,
        confirmMinBars: 3,
        confirmMinPriceChangePct: 0.02,
        cooldownSec: 300,
      },
      horizonsSec: [30, 60],
      gateMode: 'off',
    });

    expect(result.dataset.droppedCandleCount).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.summary.avgMfePct).toBeLessThan(0.1);
  });

  it('replays candle streams without loading the full dataset first', async () => {
    const candles: Candle[] = [
      makeCandle(60, 60, 1.0, 1.03, 30),
      makeCandle(60, 120, 1.03, 1.07, 30),
      makeCandle(60, 180, 1.07, 1.12, 30),
      ...Array.from({ length: 20 }, (_, index) =>
        makeCandle(15, 15 * (index + 1), 1 + index * 0.01, 1.01 + index * 0.01, 10)
      ),
      makeCandle(15, 15 * 21, 1.25, 1.35, 50),
      makeCandle(5, 330, 1.35, 1.36, 5),
      makeCandle(5, 360, 1.36, 1.39, 6),
      makeCandle(5, 390, 1.39, 1.42, 7),
    ];
    const orderedCandles = [...candles].sort((left, right) =>
      left.timestamp.getTime() - right.timestamp.getTime()
      || left.intervalSec - right.intervalSec
      || left.pairAddress.localeCompare(right.pairAddress)
    );

    async function* streamCandles(): AsyncGenerator<Candle> {
      for (const candle of orderedCandles) {
        yield candle;
      }
    }

    const result = await replayRealtimeCandlesStream(streamCandles(), {
      triggerConfig: {
        primaryIntervalSec: 15,
        confirmIntervalSec: 60,
        volumeSurgeLookback: 20,
        volumeSurgeMultiplier: 3,
        priceBreakoutLookback: 20,
        confirmMinBars: 3,
        confirmMinPriceChangePct: 0.02,
        cooldownSec: 300,
      },
      horizonsSec: [30, 60],
      gateMode: 'off',
    });

    expect(result.dataset.inputMode).toBe('candles');
    expect(result.dataset.candleCount).toBe(candles.length);
    expect(result.records).toHaveLength(1);
    expect(result.summary.totalSignals).toBe(1);
  });

  it('does not look ahead to larger-interval candles with the same timestamp', async () => {
    const candles: Candle[] = [
      makeCandle(60, 60, 1.00, 1.03, 30),
      makeCandle(60, 120, 1.03, 1.07, 30),
      makeCandle(60, 300, 1.07, 1.12, 30),
      ...Array.from({ length: 20 }, (_, index) =>
        makeCandle(15, 15 * (index + 1), 1 + index * 0.01, 1.01 + index * 0.01, 10)
      ),
      makeCandle(15, 300, 1.25, 1.35, 50),
      makeCandle(5, 360, 1.35, 1.36, 5),
      makeCandle(5, 390, 1.36, 1.39, 6),
    ];

    const result = await replayRealtimeCandles(candles, {
      triggerConfig: {
        primaryIntervalSec: 15,
        confirmIntervalSec: 60,
        volumeSurgeLookback: 20,
        volumeSurgeMultiplier: 3,
        priceBreakoutLookback: 20,
        confirmMinBars: 3,
        confirmMinPriceChangePct: 0.02,
        cooldownSec: 300,
      },
      horizonsSec: [30, 60],
      gateMode: 'off',
    });

    expect(result.records).toHaveLength(0);
    expect(result.triggerType).toBe('momentum');
    if (!('confirmFail' in result.rejectStats)) {
      throw new Error('Expected momentum reject stats');
    }
    expect(result.rejectStats.confirmFail).toBeGreaterThan(0);
  });
});
