import { checkOpenPositions, closeTrade, recordOpenedTrade } from '../src/orchestration/tradeExecution';
import type { BotContext } from '../src/orchestration/types';
import type { Trade } from '../src/utils/types';

describe('tradeExecution paper balance', () => {
  it('credits paperBalance with exit proceeds when a paper trade closes', async () => {
    const tradeStore = {
      closeTrade: jest.fn().mockResolvedValue(undefined),
      failTrade: jest.fn().mockResolvedValue(undefined),
      updateHighWaterMark: jest.fn().mockResolvedValue(undefined),
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

  it('prefers realtime current price over DB candle close for open-position monitoring', async () => {
    const trade: Trade = {
      id: 'trade-rt',
      pairAddress: 'pair-rt',
      strategy: 'volume_spike',
      side: 'BUY',
      entryPrice: 1.0,
      quantity: 1.0,
      status: 'OPEN',
      createdAt: new Date('2026-03-21T00:00:00Z'),
      stopLoss: 0.9,
      takeProfit1: 1.1,
      takeProfit2: 1.2,
      highWaterMark: 1.0,
      timeStopAt: new Date('2026-03-23T00:00:00Z'),
    };

    const candleStore = {
      getRecentCandles: jest.fn().mockResolvedValue([{
        pairAddress: 'pair-rt',
        timestamp: new Date('2026-03-22T00:00:00Z'),
        intervalSec: 300,
        open: 1.0,
        high: 1.02,
        low: 0.98,
        close: 1.01,
        volume: 100,
        buyVolume: 60,
        sellVolume: 40,
        tradeCount: 10,
      }]),
    };
    const tradeStore = {
      closeTrade: jest.fn().mockResolvedValue(undefined),
      failTrade: jest.fn().mockResolvedValue(undefined),
      updateHighWaterMark: jest.fn().mockResolvedValue(undefined),
    };
    const notifier = {
      sendTradeClose: jest.fn().mockResolvedValue(undefined),
      sendError: jest.fn().mockResolvedValue(undefined),
      sendCritical: jest.fn().mockResolvedValue(undefined),
      sendInfo: jest.fn().mockResolvedValue(undefined),
      sendTradeAlert: jest.fn().mockResolvedValue(undefined),
    };
    const positionStore = {
      getOpenPositions: jest.fn().mockResolvedValue([]),
      updateState: jest.fn().mockResolvedValue(undefined),
    };
    const healthMonitor = {
      updateTradeTime: jest.fn(),
      updatePositions: jest.fn(),
      updateDailyPnl: jest.fn(),
    };
    const riskManager = {
      getPortfolioState: jest.fn().mockResolvedValue({
        openTrades: [trade],
        dailyPnl: 0,
      }),
      applyUnrealizedDrawdown: jest.fn().mockImplementation((portfolio) => portfolio),
      getActiveHalt: jest.fn().mockReturnValue(null),
    };
    const realtimeCandleBuilder = {
      getCurrentPrice: jest.fn().mockReturnValue(1.21),
    };
    const ctx = {
      tradingMode: 'paper',
      paperBalance: 10,
      candleStore,
      tradeStore,
      notifier,
      positionStore,
      healthMonitor,
      riskManager,
      executor: { getBalance: jest.fn() },
      realtimeCandleBuilder,
    } as unknown as BotContext;

    await checkOpenPositions(ctx);

    expect(realtimeCandleBuilder.getCurrentPrice).toHaveBeenCalledWith('pair-rt');
    expect(tradeStore.closeTrade).toHaveBeenCalledTimes(1);
    const [, exitPrice] = tradeStore.closeTrade.mock.calls[0];
    expect(exitPrice).toBeCloseTo(1.21, 8);
  });

  it('uses the sell transaction signature in the close notification for live exits', async () => {
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
    const executor = {
      getTokenBalance: jest.fn().mockResolvedValue(5n),
      getBalance: jest.fn()
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(10.5),
      executeSell: jest.fn().mockResolvedValue({
        txSignature: 'SELLTX123',
        slippageBps: 100,
      }),
    };
    const ctx = {
      tradingMode: 'live',
      tradeStore,
      notifier,
      positionStore,
      healthMonitor,
      executor,
    } as unknown as BotContext;

    const trade: Trade = {
      id: 'trade-live',
      pairAddress: 'pair-live',
      strategy: 'volume_spike',
      side: 'BUY',
      txSignature: 'ENTRYTX999',
      entryPrice: 1.0,
      quantity: 5,
      status: 'OPEN',
      createdAt: new Date('2026-03-21T00:00:00Z'),
      stopLoss: 0.9,
      takeProfit1: 1.1,
      takeProfit2: 1.2,
      timeStopAt: new Date('2026-03-21T01:00:00Z'),
    };

    await closeTrade(trade, 'TRAILING_STOP', ctx);

    expect(executor.executeSell).toHaveBeenCalledWith('pair-live', 5n);
    expect(notifier.sendTradeClose).toHaveBeenCalledWith(expect.objectContaining({
      txSignature: 'SELLTX123',
      exitReason: 'TRAILING_STOP',
    }));
  });

  it('triggers TP1 partial when a post-entry candle high touches the target', async () => {
    const trade: Trade = {
      id: 'trade-tp1',
      pairAddress: 'pair-tp1',
      strategy: 'volume_spike',
      side: 'BUY',
      entryPrice: 1.0,
      quantity: 1.0,
      status: 'OPEN',
      createdAt: new Date('2026-03-21T00:00:00Z'),
      stopLoss: 0.9,
      takeProfit1: 1.1,
      takeProfit2: 1.3,
      highWaterMark: 1.0,
      trailingStop: 0.05,
      timeStopAt: new Date(Date.now() + 3600_000),
    };
    const candleStore = {
      getRecentCandles: jest.fn().mockResolvedValue([
        {
          pairAddress: 'pair-tp1',
          timestamp: new Date('2026-03-20T23:55:00Z'),
          intervalSec: 300,
          open: 0.98,
          high: 1.25,
          low: 0.97,
          close: 1.0,
          volume: 100,
          buyVolume: 60,
          sellVolume: 40,
          tradeCount: 10,
        },
        {
          pairAddress: 'pair-tp1',
          timestamp: new Date('2026-03-21T00:10:00Z'),
          intervalSec: 300,
          open: 1.02,
          high: 1.11,
          low: 1.01,
          close: 1.05,
          volume: 100,
          buyVolume: 55,
          sellVolume: 45,
          tradeCount: 11,
        },
      ]),
    };
    const tradeStore = {
      closeTrade: jest.fn().mockResolvedValue(undefined),
      failTrade: jest.fn().mockResolvedValue(undefined),
      insertTrade: jest.fn().mockResolvedValue('remaining-trade'),
      updateHighWaterMark: jest.fn().mockResolvedValue(undefined),
    };
    const notifier = {
      sendTradeClose: jest.fn().mockResolvedValue(undefined),
      sendError: jest.fn().mockResolvedValue(undefined),
      sendCritical: jest.fn().mockResolvedValue(undefined),
      sendInfo: jest.fn().mockResolvedValue(undefined),
      sendTradeAlert: jest.fn().mockResolvedValue(undefined),
    };
    const positionStore = {
      getOpenPositions: jest.fn().mockResolvedValue([]),
      updateState: jest.fn().mockResolvedValue(undefined),
    };
    const healthMonitor = {
      updateTradeTime: jest.fn(),
      updatePositions: jest.fn(),
      updateDailyPnl: jest.fn(),
    };
    const riskManager = {
      getPortfolioState: jest.fn().mockResolvedValue({
        openTrades: [trade],
        dailyPnl: 0,
      }),
      applyUnrealizedDrawdown: jest.fn().mockImplementation((portfolio) => portfolio),
      getActiveHalt: jest.fn().mockReturnValue(null),
    };
    const ctx = {
      tradingMode: 'paper',
      paperBalance: 10,
      candleStore,
      tradeStore,
      notifier,
      positionStore,
      healthMonitor,
      riskManager,
      executor: { getBalance: jest.fn() },
      realtimeCandleBuilder: { getCurrentPrice: jest.fn().mockReturnValue(1.05) },
    } as unknown as BotContext;

    await checkOpenPositions(ctx);

    expect(tradeStore.closeTrade).toHaveBeenCalledWith(
      'trade-tp1',
      1.1,
      expect.any(Number),
      0,
      'TAKE_PROFIT_1',
      0.3
    );
    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1);
  });

  it('does not treat pre-entry candle highs as post-entry peak data', async () => {
    const trade: Trade = {
      id: 'trade-pre-entry',
      pairAddress: 'pair-pre-entry',
      strategy: 'volume_spike',
      side: 'BUY',
      entryPrice: 1.0,
      quantity: 1.0,
      status: 'OPEN',
      createdAt: new Date('2026-03-21T00:00:00Z'),
      stopLoss: 0.9,
      takeProfit1: 1.1,
      takeProfit2: 1.3,
      highWaterMark: 1.0,
      trailingStop: 0.05,
      timeStopAt: new Date(Date.now() + 3600_000),
    };
    const candles = Array.from({ length: 8 }, (_, index) => ({
      pairAddress: 'pair-pre-entry',
      timestamp: new Date(`2026-03-20T23:${String(20 + index * 5).padStart(2, '0')}:00Z`),
      intervalSec: 300,
      open: 0.98,
      high: index === 7 ? 1.25 : 1.02,
      low: 0.97,
      close: 1.01,
      volume: 100,
      buyVolume: 60,
      sellVolume: 40,
      tradeCount: 10,
    }));
    const candleStore = {
      getRecentCandles: jest.fn().mockResolvedValue(candles),
    };
    const tradeStore = {
      closeTrade: jest.fn().mockResolvedValue(undefined),
      failTrade: jest.fn().mockResolvedValue(undefined),
      updateHighWaterMark: jest.fn().mockResolvedValue(undefined),
    };
    const notifier = {
      sendTradeClose: jest.fn().mockResolvedValue(undefined),
      sendError: jest.fn().mockResolvedValue(undefined),
      sendCritical: jest.fn().mockResolvedValue(undefined),
      sendInfo: jest.fn().mockResolvedValue(undefined),
      sendTradeAlert: jest.fn().mockResolvedValue(undefined),
    };
    const positionStore = {
      getOpenPositions: jest.fn().mockResolvedValue([]),
      updateState: jest.fn().mockResolvedValue(undefined),
    };
    const healthMonitor = {
      updateTradeTime: jest.fn(),
      updatePositions: jest.fn(),
      updateDailyPnl: jest.fn(),
    };
    const riskManager = {
      getPortfolioState: jest.fn().mockResolvedValue({
        openTrades: [trade],
        dailyPnl: 0,
      }),
      applyUnrealizedDrawdown: jest.fn().mockImplementation((portfolio) => portfolio),
      getActiveHalt: jest.fn().mockReturnValue(null),
    };
    const ctx = {
      tradingMode: 'paper',
      paperBalance: 10,
      candleStore,
      tradeStore,
      notifier,
      positionStore,
      healthMonitor,
      riskManager,
      executor: { getBalance: jest.fn() },
      realtimeCandleBuilder: { getCurrentPrice: jest.fn().mockReturnValue(1.01) },
    } as unknown as BotContext;

    await checkOpenPositions(ctx);

    expect(tradeStore.closeTrade).not.toHaveBeenCalled();
    expect(tradeStore.updateHighWaterMark).toHaveBeenCalledWith('trade-pre-entry', 1.01);
  });

  it('records actual entry telemetry when a trade opens', async () => {
    const positionStore = {
      updateState: jest.fn().mockResolvedValue(undefined),
    };
    const tradeStore = {
      insertTrade: jest.fn().mockResolvedValue('trade-opened'),
    };
    const notifier = {
      sendTradeOpen: jest.fn().mockResolvedValue(undefined),
    };
    const auditLogger = {
      logSignal: jest.fn().mockResolvedValue(undefined),
    };
    const healthMonitor = {
      updateTradeTime: jest.fn(),
    };
    const ctx = {
      positionStore,
      tradeStore,
      notifier,
      auditLogger,
      healthMonitor,
    } as unknown as BotContext;
    const signal = {
      pairAddress: 'pair-open',
      strategy: 'volume_spike',
      price: 1.0,
      meta: {},
      timestamp: new Date(),
      action: 'BUY',
      breakoutScore: {
        volumeScore: 20,
        buyRatioScore: 20,
        multiTfScore: 20,
        whaleScore: 10,
        lpScore: 10,
        totalScore: 80,
        grade: 'A' as const,
      },
    };
    const lastCandle = {
      pairAddress: 'pair-open',
      timestamp: new Date(),
      intervalSec: 300,
      open: 1,
      high: 1.02,
      low: 0.99,
      close: 1.0,
      volume: 100,
      buyVolume: 60,
      sellVolume: 40,
      tradeCount: 12,
    };
    const order = {
      pairAddress: 'pair-open',
      strategy: 'volume_spike' as const,
      side: 'BUY' as const,
      price: 1.0,
      quantity: 10,
      stopLoss: 0.95,
      takeProfit1: 1.1,
      takeProfit2: 1.2,
      trailingStop: 0.05,
      timeStopMinutes: 30,
      breakoutGrade: 'A' as const,
    };

    await recordOpenedTrade(
      ctx,
      'position-1',
      signal as any,
      lastCandle as any,
      {
        attentionScore: undefined,
        executionViability: { rejected: false, effectiveRR: 1.9, roundTripCost: 0.01, sizeMultiplier: 1 },
      } as any,
      order,
      80,
      'LIQUIDITY',
      'TX123',
      {
        entryPrice: 1.05,
        quantity: 9.5,
        plannedEntryPrice: 1.0,
        plannedQuantity: 10,
        entrySlippageBps: 50,
        entrySlippagePct: 0.05,
        expectedOutAmount: '1000000',
        actualOutAmount: '950000',
        outputDecimals: 5,
        effectiveRR: 1.7,
        roundTripCost: 0.012,
      }
    );

    expect(positionStore.updateState).toHaveBeenNthCalledWith(
      1,
      'position-1',
      'ENTRY_CONFIRMED',
      expect.objectContaining({
        entryPrice: 1.05,
        quantity: 9.5,
        signalData: {
          execution: expect.objectContaining({
            plannedEntryPrice: 1.0,
            plannedQuantity: 10,
            entryPrice: 1.05,
            quantity: 9.5,
            effectiveRR: 1.7,
          }),
        },
      })
    );
    expect(tradeStore.insertTrade).toHaveBeenCalledWith(expect.objectContaining({
      entryPrice: 1.05,
      quantity: 9.5,
      highWaterMark: 1.05,
    }));
    expect(notifier.sendTradeOpen).toHaveBeenCalledWith(expect.objectContaining({
      price: 1.05,
      quantity: 9.5,
    }), 'TX123');
    expect(auditLogger.logSignal).toHaveBeenCalledWith(expect.objectContaining({
      action: 'EXECUTED',
      positionSize: 9.5,
      effectiveRR: 1.7,
      roundTripCost: 0.012,
    }));
  });
});
