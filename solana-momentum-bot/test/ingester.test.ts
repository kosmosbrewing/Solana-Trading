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
});
