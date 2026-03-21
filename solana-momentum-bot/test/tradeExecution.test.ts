import { closeTrade } from '../src/orchestration/tradeExecution';
import type { BotContext } from '../src/orchestration/types';
import type { Trade } from '../src/utils/types';

describe('tradeExecution paper balance', () => {
  it('credits paperBalance with exit proceeds when a paper trade closes', async () => {
    const tradeStore = {
      closeTrade: jest.fn().mockResolvedValue(undefined),
      failTrade: jest.fn().mockResolvedValue(undefined),
    };
    const notifier = {
      sendTradeClose: jest.fn().mockResolvedValue(undefined),
      sendError: jest.fn().mockResolvedValue(undefined),
    };
    const positionStore = {
      getOpenPositions: jest.fn().mockResolvedValue([]),
      updateState: jest.fn().mockResolvedValue(undefined),
    };
    const healthMonitor = {
      updateTradeTime: jest.fn(),
    };

    const ctx = {
      tradingMode: 'paper',
      tradeStore,
      notifier,
      positionStore,
      healthMonitor,
      paperBalance: 0.0,
    } as unknown as BotContext;

    const trade: Trade = {
      id: 'trade-1',
      pairAddress: 'pair-1',
      strategy: 'volume_spike',
      side: 'BUY',
      entryPrice: 1.0,
      quantity: 1.0,
      status: 'OPEN',
      createdAt: new Date('2026-03-21T00:00:00Z'),
      stopLoss: 0.9,
      takeProfit1: 1.1,
      takeProfit2: 1.2,
      timeStopAt: new Date('2026-03-21T01:00:00Z'),
    };

    await closeTrade(trade, 'TAKE_PROFIT_2', ctx, 1.2);

    expect(ctx.paperBalance).toBeCloseTo(1.2, 8);
    expect(tradeStore.closeTrade).toHaveBeenCalledTimes(1);
    const [tradeId, exitPrice, pnl, slippage, reason] = tradeStore.closeTrade.mock.calls[0];
    expect(tradeId).toBe('trade-1');
    expect(exitPrice).toBeCloseTo(1.2, 8);
    expect(pnl).toBeCloseTo(0.2, 8);
    expect(slippage).toBe(0);
    expect(reason).toBe('TAKE_PROFIT_2');
  });
});
