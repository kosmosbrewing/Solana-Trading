import os from 'os';
import path from 'path';
import { mkdtemp } from 'fs/promises';
import { ReplayWarmSync, RealtimeReplayStore, warmReplayCandlesIntoStore } from '../src/realtime';

describe('warmReplayCandlesIntoStore', () => {
  it('imports replay micro-candles into CandleStore in batches', async () => {
    const datasetDir = await mkdtemp(path.join(os.tmpdir(), 'replay-warm-import-'));
    const store = new RealtimeReplayStore(datasetDir);

    await store.appendCandle({
      pairAddress: 'PAIR-1',
      timestamp: new Date('2026-03-22T00:00:00.000Z'),
      intervalSec: 5,
      open: 1,
      high: 1.02,
      low: 0.99,
      close: 1.01,
      volume: 10,
      buyVolume: 6,
      sellVolume: 4,
      tradeCount: 3,
      tokenMint: 'PAIR-1',
    });
    await store.appendCandle({
      pairAddress: 'PAIR-1',
      timestamp: new Date('2026-03-22T00:00:05.000Z'),
      intervalSec: 5,
      open: 1.01,
      high: 1.03,
      low: 1.0,
      close: 1.02,
      volume: 11,
      buyVolume: 7,
      sellVolume: 4,
      tradeCount: 4,
      tokenMint: 'PAIR-1',
    });

    const candleStore = {
      insertCandles: jest.fn().mockResolvedValue(undefined),
    };

    const result = await warmReplayCandlesIntoStore(store, candleStore as never, {
      batchSize: 1,
    });

    expect(result.inserted).toBe(2);
    expect(result.lastImportedAt?.toISOString()).toBe('2026-03-22T00:00:05.000Z');
    expect(candleStore.insertCandles).toHaveBeenCalledTimes(2);
    expect(candleStore.insertCandles).toHaveBeenNthCalledWith(1, [
      expect.objectContaining({
        pairAddress: 'PAIR-1',
        intervalSec: 5,
        close: 1.01,
      }),
    ]);
    expect(candleStore.insertCandles).toHaveBeenNthCalledWith(2, [
      expect.objectContaining({
        pairAddress: 'PAIR-1',
        intervalSec: 5,
        close: 1.02,
      }),
    ]);
  });

  it('syncs only newly appended replay candles after the first import', async () => {
    const datasetDir = await mkdtemp(path.join(os.tmpdir(), 'replay-warm-sync-'));
    const store = new RealtimeReplayStore(datasetDir);
    const candleStore = {
      insertCandles: jest.fn().mockResolvedValue(undefined),
    };

    await store.appendCandle({
      pairAddress: 'PAIR-1',
      timestamp: new Date('2026-03-22T00:00:00.000Z'),
      intervalSec: 5,
      open: 1,
      high: 1.02,
      low: 0.99,
      close: 1.01,
      volume: 10,
      buyVolume: 6,
      sellVolume: 4,
      tradeCount: 3,
    });

    const sync = new ReplayWarmSync(store, candleStore as never, 0);
    const first = await sync.syncOnce();
    expect(first.inserted).toBe(1);

    await store.appendCandle({
      pairAddress: 'PAIR-1',
      timestamp: new Date('2026-03-22T00:00:05.000Z'),
      intervalSec: 5,
      open: 1.01,
      high: 1.03,
      low: 1.0,
      close: 1.02,
      volume: 11,
      buyVolume: 7,
      sellVolume: 4,
      tradeCount: 4,
    });

    const second = await sync.syncOnce();
    expect(second.inserted).toBe(1);
    expect(candleStore.insertCandles).toHaveBeenCalledTimes(2);
    expect(candleStore.insertCandles).toHaveBeenLastCalledWith([
      expect.objectContaining({
        timestamp: new Date('2026-03-22T00:00:05.000Z'),
        close: 1.02,
      }),
    ]);
  });
});
