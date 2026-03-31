import { handleNewCandle } from '../src/orchestration/candleHandler';
import type { BotContext } from '../src/orchestration/types';
import type { Candle } from '../src/utils/types';

describe('candleHandler internal candle source', () => {
  it('uses internal candle source before candleStore', async () => {
    const candle: Candle = {
      pairAddress: 'pair-1',
      timestamp: new Date(),
      intervalSec: 300,
      open: 1,
      high: 1.1,
      low: 0.9,
      close: 1.05,
      volume: 100,
      buyVolume: 50,
      sellVolume: 50,
      tradeCount: 10,
    };
    const internalCandleSource = {
      getRecentCandles: jest.fn().mockResolvedValue([]),
    };
    const candleStore = {
      getRecentCandles: jest.fn().mockResolvedValue([candle]),
    };

    await handleNewCandle(candle, {
      candleStore,
      internalCandleSource,
    } as unknown as BotContext);

    expect(internalCandleSource.getRecentCandles).toHaveBeenCalledWith('pair-1', 300, 30);
    expect(candleStore.getRecentCandles).not.toHaveBeenCalled();
  });
});
