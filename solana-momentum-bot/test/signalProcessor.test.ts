import { processSignal } from '../src/orchestration/signalProcessor';
import type { BotContext } from '../src/orchestration/types';
import type { Candle, Signal } from '../src/utils/types';

describe('signalProcessor notifications', () => {
  it('does not send a BUY signal alert when the order is rejected by risk', async () => {
    const signal: Signal = {
      action: 'BUY',
      strategy: 'volume_spike',
      pairAddress: 'pair-risk-reject',
      price: 1.25,
      timestamp: new Date(),
      meta: {},
    };
    const candles: Candle[] = [{
      pairAddress: signal.pairAddress,
      timestamp: new Date(),
      intervalSec: 300,
      open: 1.2,
      high: 1.3,
      low: 1.1,
      close: 1.25,
      volume: 1000,
      buyVolume: 600,
      sellVolume: 400,
      tradeCount: 10,
    }];
    const notifier = {
      sendSignal: jest.fn().mockResolvedValue(undefined),
      sendInfo: jest.fn().mockResolvedValue(undefined),
      sendCritical: jest.fn().mockResolvedValue(undefined),
    };
    const executionLock = {
      acquire: jest.fn().mockReturnValue(true),
      release: jest.fn(),
    };
    const ctx = {
      tradingMode: 'paper',
      paperBalance: 10,
      executor: { getBalance: jest.fn().mockResolvedValue(10) },
      riskManager: {
        getPortfolioState: jest.fn().mockResolvedValue({ openTrades: [], dailyPnl: 0 }),
        getActiveHalt: jest.fn().mockReturnValue(null),
        checkOrder: jest.fn().mockResolvedValue({
          approved: false,
          reason: 'Max concurrent position limit reached (1)',
        }),
      },
      notifier,
      executionLock,
      auditLogger: { logSignal: jest.fn().mockResolvedValue(undefined) },
      tradingHaltedReason: undefined,
    } as unknown as BotContext;

    const result = await processSignal(signal, candles, ctx, {
      rejected: false,
      breakoutScore: { totalScore: 100, grade: 'A' },
      executionViability: { rejected: false, effectiveRR: 2, roundTripCost: 0, sizeMultiplier: 1 },
      gradeSizeMultiplier: 1,
      tokenSafety: undefined,
    } as any);

    expect(result.status).toBe('risk_rejected');
    expect(notifier.sendSignal).not.toHaveBeenCalled();
    expect(executionLock.release).toHaveBeenCalled();
  });
});
