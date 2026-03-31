import { Ingester } from '../src/ingester/ingester';
import { Candle } from '../src/utils/types';

describe('Ingester', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('retries poll after a retryable 429 error before emitting failure', async () => {
    const candle: Candle = {
      pairAddress: 'mint-1',
      timestamp: new Date('2026-03-24T00:00:00Z'),
      intervalSec: 60,
      open: 1,
      high: 1.1,
      low: 0.9,
      close: 1.05,
      volume: 100,
      buyVolume: 0,
      sellVolume: 0,
      tradeCount: 0,
    };
    const geckoClient = {
      getOHLCV: jest.fn()
        .mockRejectedValueOnce(new Error('Request failed with status code 429'))
        .mockResolvedValueOnce([candle]),
    };
    const candleStore = {
      getRecentCandles: jest.fn().mockResolvedValue([]),
      insertCandles: jest.fn().mockResolvedValue(undefined),
    };
    const ingester = new Ingester(geckoClient as never, candleStore as never, []);
    const errors: unknown[] = [];

    ingester.on('error', ({ error }) => errors.push(error));
    (ingester as any).running = true;

    const pollPromise = (ingester as any).poll({
      pairAddress: 'mint-1',
      poolAddress: 'pool-1',
      intervalType: '1m',
      pollIntervalMs: 60_000,
    });

    await jest.advanceTimersByTimeAsync(4_000);
    await pollPromise;

    expect(geckoClient.getOHLCV).toHaveBeenCalledTimes(2);
    expect(candleStore.insertCandles).toHaveBeenCalledWith([expect.objectContaining({
      pairAddress: 'mint-1',
      close: 1.05,
    })]);
    expect(errors).toHaveLength(0);
  });

  it('skips Gecko backfill when recent internal candles already exist', async () => {
    const recentCandle: Candle = {
      pairAddress: 'mint-1',
      timestamp: new Date(Date.now() - 30_000),
      intervalSec: 60,
      open: 1,
      high: 1.1,
      low: 0.9,
      close: 1.05,
      volume: 100,
      buyVolume: 0,
      sellVolume: 0,
      tradeCount: 0,
    };
    const geckoClient = {
      getOHLCV: jest.fn(),
    };
    const candleStore = {
      getRecentCandles: jest.fn().mockResolvedValue([recentCandle]),
      insertCandles: jest.fn().mockResolvedValue(undefined),
    };
    const ingester = new Ingester(geckoClient as never, candleStore as never, []);
    const emitted: Candle[][] = [];

    ingester.on('candles', (candles) => emitted.push(candles));
    (ingester as any).running = true;
    await (ingester as any).backfill({
      pairAddress: 'mint-1',
      poolAddress: 'pool-1',
      intervalType: '1m',
      pollIntervalMs: 60_000,
    });

    expect(candleStore.getRecentCandles).toHaveBeenCalledWith('mint-1', 60, 1);
    expect(candleStore.getRecentCandles).toHaveBeenCalledWith('mint-1', 60, 30);
    expect(geckoClient.getOHLCV).not.toHaveBeenCalled();
    expect(candleStore.insertCandles).not.toHaveBeenCalled();
    expect(emitted).toEqual([[recentCandle]]);
  });

  it('skips poll when the latest closed bucket is already stored internally', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const currentBucketStartSec = Math.floor(nowSec / 60) * 60;
    const latestClosedBucketStartSec = currentBucketStartSec - 60;
    const recentClosedCandle: Candle = {
      pairAddress: 'mint-1',
      timestamp: new Date(latestClosedBucketStartSec * 1000),
      intervalSec: 60,
      open: 1,
      high: 1.1,
      low: 0.9,
      close: 1.05,
      volume: 100,
      buyVolume: 0,
      sellVolume: 0,
      tradeCount: 0,
    };
    const geckoClient = {
      getOHLCV: jest.fn(),
    };
    const candleStore = {
      getRecentCandles: jest.fn().mockResolvedValue([recentClosedCandle]),
      insertCandles: jest.fn().mockResolvedValue(undefined),
    };
    const ingester = new Ingester(geckoClient as never, candleStore as never, []);

    (ingester as any).running = true;
    await (ingester as any).poll({
      pairAddress: 'mint-1',
      poolAddress: 'pool-1',
      intervalType: '1m',
      pollIntervalMs: 60_000,
    });

    expect(candleStore.getRecentCandles).toHaveBeenCalledWith('mint-1', 60, 1);
    expect(geckoClient.getOHLCV).not.toHaveBeenCalled();
    expect(candleStore.insertCandles).not.toHaveBeenCalled();
  });

  it('fetches only the missing range after the latest stored candle', async () => {
    const latestStoredSec = Math.floor(Date.now() / 1000) - 15 * 60;
    const storedCandle: Candle = {
      pairAddress: 'mint-1',
      timestamp: new Date(latestStoredSec * 1000),
      intervalSec: 300,
      open: 1,
      high: 1.1,
      low: 0.9,
      close: 1.05,
      volume: 100,
      buyVolume: 0,
      sellVolume: 0,
      tradeCount: 0,
    };
    const nextCandle: Candle = {
      ...storedCandle,
      timestamp: new Date((latestStoredSec + 300) * 1000),
    };
    const geckoClient = {
      getOHLCV: jest.fn().mockResolvedValue([nextCandle]),
    };
    const candleStore = {
      getRecentCandles: jest.fn().mockResolvedValue([storedCandle]),
      insertCandles: jest.fn().mockResolvedValue(undefined),
    };
    const ingester = new Ingester(geckoClient as never, candleStore as never, []);

    (ingester as any).running = true;
    await (ingester as any).poll({
      pairAddress: 'mint-1',
      poolAddress: 'pool-1',
      intervalType: '5m',
      pollIntervalMs: 300_000,
    });

    expect(geckoClient.getOHLCV).toHaveBeenCalledTimes(1);
    const [, , timeFrom] = geckoClient.getOHLCV.mock.calls[0];
    expect(timeFrom).toBe(latestStoredSec + 300);
  });
});
