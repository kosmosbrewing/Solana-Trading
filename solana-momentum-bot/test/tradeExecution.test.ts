import { checkOpenPositions, closeTrade, recordOpenedTrade, PriceAnomalyError } from '../src/orchestration/tradeExecution';
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
    const [tradeId, exitPrice, pnl, slippage, reason, , , , , decisionPrice] = tradeStore.closeTrade.mock.calls[0];
    expect(tradeId).toBe('trade-1');
    expect(exitPrice).toBeCloseTo(1.2, 8);
    expect(pnl).toBeCloseTo(0.2, 8);
    expect(slippage).toBe(0);
    expect(reason).toBe('TAKE_PROFIT_2');
    expect(decisionPrice).toBe(1.2);
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
      timeStopAt: new Date(Date.now() + 3600_000),
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

  it('uses internal aggregated candles for open-position monitoring when available', async () => {
    const trade: Trade = {
      id: 'trade-int',
      pairAddress: 'pair-int',
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
      timeStopAt: new Date(Date.now() + 3600_000),
    };

    const candleStore = {
      getRecentCandles: jest.fn().mockResolvedValue([]),
    };
    const internalCandleSource = {
      getRecentCandles: jest.fn().mockResolvedValue([{
        pairAddress: 'pair-int',
        timestamp: new Date('2026-03-22T00:00:00Z'),
        intervalSec: 300,
        open: 1.0,
        high: 1.22,
        low: 0.99,
        close: 1.02,
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
    const ctx = {
      tradingMode: 'paper',
      paperBalance: 10,
      candleStore,
      internalCandleSource,
      tradeStore,
      notifier,
      positionStore,
      healthMonitor,
      riskManager,
      executor: { getBalance: jest.fn() },
      realtimeCandleBuilder: { getCurrentPrice: jest.fn().mockReturnValue(null) },
    } as unknown as BotContext;

    await checkOpenPositions(ctx);

    expect(internalCandleSource.getRecentCandles).toHaveBeenCalledWith('pair-int', 300, 10);
    expect(candleStore.getRecentCandles).not.toHaveBeenCalled();
    expect(tradeStore.closeTrade).toHaveBeenCalledTimes(1);
    const [, exitPrice] = tradeStore.closeTrade.mock.calls[0];
    expect(exitPrice).toBeCloseTo(1.2, 8);
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
      0.3,
      undefined,
      undefined, undefined,
      1.1 // decisionPrice = TP1 trigger price
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
        actualEntryNotionalSol: 9.975,
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
    const entryConfirmedPayload = (positionStore.updateState as jest.Mock).mock.calls[0][2];
    expect(entryConfirmedPayload.stopLoss).toBeCloseTo(0.9975, 10);
    expect(entryConfirmedPayload.takeProfit1).toBeCloseTo(1.155, 10);
    expect(entryConfirmedPayload.takeProfit2).toBeCloseTo(1.26, 10);

    const insertedTrade = (tradeStore.insertTrade as jest.Mock).mock.calls[0][0];
    expect(insertedTrade.entryPrice).toBe(1.05);
    expect(insertedTrade.plannedEntryPrice).toBe(1.0);
    expect(insertedTrade.quantity).toBe(9.5);
    expect(insertedTrade.stopLoss).toBeCloseTo(0.9975, 10);
    expect(insertedTrade.takeProfit1).toBeCloseTo(1.155, 10);
    expect(insertedTrade.takeProfit2).toBeCloseTo(1.26, 10);
    expect(insertedTrade.highWaterMark).toBe(1.05);

    const openAlertOrder = (notifier.sendTradeOpen as jest.Mock).mock.calls[0][0];
    expect(openAlertOrder.tradeId).toBe('trade-opened');
    expect(openAlertOrder.price).toBe(1.05);
    expect(openAlertOrder.plannedEntryPrice).toBe(1.0);
    expect(openAlertOrder.quantity).toBe(9.5);
    expect(openAlertOrder.stopLoss).toBeCloseTo(0.9975, 10);
    expect(openAlertOrder.takeProfit1).toBeCloseTo(1.155, 10);
    expect(openAlertOrder.takeProfit2).toBeCloseTo(1.26, 10);
    expect((notifier.sendTradeOpen as jest.Mock).mock.calls[0][1]).toBe('TX123');
    expect(auditLogger.logSignal).toHaveBeenCalledWith(expect.objectContaining({
      action: 'EXECUTED',
      positionSize: 9.5,
      effectiveRR: 1.7,
      roundTripCost: 0.012,
    }));
  });

  // Phase A3 — CRITICAL_LIVE 가격 정합성 clamp 테스트
  describe('Phase A3 — alignment ratio clamp', () => {
    function buildMinimalCtx(overrides?: Partial<BotContext>): {
      ctx: BotContext;
      positionStore: { updateState: jest.Mock };
      tradeStore: { insertTrade: jest.Mock };
      notifier: { sendTradeOpen: jest.Mock; sendCritical: jest.Mock };
      executor: { executeSell: jest.Mock };
      auditLogger: { logSignal: jest.Mock };
    } {
      const positionStore = { updateState: jest.fn().mockResolvedValue(undefined) };
      const tradeStore = { insertTrade: jest.fn().mockResolvedValue('trade-opened') };
      const notifier = {
        sendTradeOpen: jest.fn().mockResolvedValue(undefined),
        sendCritical: jest.fn().mockResolvedValue(undefined),
      };
      const executor = {
        executeSell: jest.fn().mockResolvedValue({ txSignature: 'DUMP_SIG' }),
      };
      const auditLogger = { logSignal: jest.fn().mockResolvedValue(undefined) };
      const healthMonitor = { updateTradeTime: jest.fn() };

      const ctx = {
        positionStore,
        tradeStore,
        notifier,
        executor,
        auditLogger,
        healthMonitor,
        tradingMode: 'live',
        ...overrides,
      } as unknown as BotContext;

      return { ctx, positionStore, tradeStore, notifier, executor, auditLogger };
    }

    const baseSignal = {
      pairAddress: 'pair-BTW',
      strategy: 'volume_spike',
      price: 0.81549236,
      meta: {},
      timestamp: new Date(),
      action: 'BUY',
      breakoutScore: {
        volumeScore: 20, buyRatioScore: 20, multiTfScore: 20, whaleScore: 10, lpScore: 10,
        totalScore: 80, grade: 'A' as const,
      },
    };
    const baseCandle = {
      pairAddress: 'pair-BTW', timestamp: new Date(), intervalSec: 300,
      open: 0.8, high: 0.82, low: 0.79, close: 0.81, volume: 100, buyVolume: 60, sellVolume: 40, tradeCount: 12,
    };
    const baseOrder = {
      pairAddress: 'pair-BTW',
      strategy: 'volume_spike' as const,
      side: 'BUY' as const,
      price: 0.81549236,
      quantity: 1,
      stopLoss: 0.77,
      takeProfit1: 0.89,
      takeProfit2: 0.98,
      trailingStop: 0.05,
      timeStopMinutes: 30,
      breakoutGrade: 'A' as const,
    };

    it('throws PriceAnomalyError and dumps tokens when actual/planned ratio is outside band', async () => {
      const { ctx, tradeStore, notifier, executor, positionStore } = buildMinimalCtx();

      // BTW 케이스 재현: planned=0.815, actual=0.00000122 (-100% gap)
      const executionSummary = {
        entryPrice: 0.00000122,
        quantity: 668_436,
        plannedEntryPrice: 0.81549236,
        plannedQuantity: 1,
        actualEntryNotionalSol: 0.815,
        entrySlippageBps: 0,
        entrySlippagePct: -1,
        actualOutAmount: '668436000000', // raw
        outputDecimals: 6,
        effectiveRR: 1.7,
        roundTripCost: 0.012,
      };

      await expect(
        recordOpenedTrade(
          ctx,
          'pos-btw',
          baseSignal as any,
          baseCandle as any,
          { attentionScore: undefined, executionViability: { rejected: false, effectiveRR: 1.9, roundTripCost: 0.01, sizeMultiplier: 1 } } as any,
          baseOrder,
          80,
          'RISK',
          'TX_BTW',
          executionSummary as any
        )
      ).rejects.toBeInstanceOf(PriceAnomalyError);

      // DB 기록은 절대 일어나면 안 됨
      expect(tradeStore.insertTrade).not.toHaveBeenCalled();
      expect(positionStore.updateState).not.toHaveBeenCalledWith(
        expect.any(String),
        'ENTRY_CONFIRMED',
        expect.anything()
      );
      // Critical alert + emergency dump 모두 호출됨
      expect(notifier.sendCritical).toHaveBeenCalledWith('price_anomaly', expect.stringContaining('PRICE_ANOMALY_BLOCK'));
      expect(executor.executeSell).toHaveBeenCalledWith('pair-BTW', 668_436_000_000n);
    });

    it('allows normal fills inside [0.7, 1.3] ratio band', async () => {
      const { ctx, tradeStore, executor } = buildMinimalCtx();

      // 정상: 5% slippage — ratio 1.05
      const executionSummary = {
        entryPrice: 1.05,
        quantity: 9.5,
        plannedEntryPrice: 1.0,
        plannedQuantity: 10,
        actualEntryNotionalSol: 9.975,
        entrySlippageBps: 50,
        entrySlippagePct: 0.05,
        actualOutAmount: '950000',
        outputDecimals: 5,
        effectiveRR: 1.7,
        roundTripCost: 0.012,
      };

      await expect(
        recordOpenedTrade(
          ctx,
          'pos-normal',
          { ...baseSignal, price: 1.0 } as any,
          baseCandle as any,
          { attentionScore: undefined, executionViability: { rejected: false, effectiveRR: 1.9, roundTripCost: 0.01, sizeMultiplier: 1 } } as any,
          { ...baseOrder, price: 1.0, stopLoss: 0.95, takeProfit1: 1.1, takeProfit2: 1.2 },
          80,
          'RISK',
          'TX_OK',
          executionSummary as any
        )
      ).resolves.toBeUndefined();

      expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1);
      expect(executor.executeSell).not.toHaveBeenCalled();
    });

    it('skips emergency dump in paper mode but still throws', async () => {
      const { ctx, executor, notifier } = buildMinimalCtx({ tradingMode: 'paper' } as any);
      const executionSummary = {
        entryPrice: 0.00000122,
        quantity: 668_436,
        plannedEntryPrice: 0.81549236,
        plannedQuantity: 1,
        actualEntryNotionalSol: 0.815,
        entrySlippageBps: 0,
        entrySlippagePct: -1,
        actualOutAmount: '668436000000',
        outputDecimals: 6,
        effectiveRR: 1.7,
        roundTripCost: 0.012,
      };

      await expect(
        recordOpenedTrade(
          ctx,
          'pos-paper',
          baseSignal as any,
          baseCandle as any,
          { attentionScore: undefined, executionViability: { rejected: false, effectiveRR: 1.9, roundTripCost: 0.01, sizeMultiplier: 1 } } as any,
          baseOrder,
          80,
          'RISK',
          'TX_PAPER',
          executionSummary as any
        )
      ).rejects.toBeInstanceOf(PriceAnomalyError);

      expect(executor.executeSell).not.toHaveBeenCalled();
      expect(notifier.sendCritical).toHaveBeenCalled();
    });
  });

  // Phase A4 — closeTrade exit anomaly 검증
  describe('Phase A4 — closeTrade exit anomaly alert', () => {
    it('sends critical alert when exit/entry ratio falls below -95%', async () => {
      const tradeStore = {
        closeTrade: jest.fn().mockResolvedValue(undefined),
        failTrade: jest.fn().mockResolvedValue(undefined),
        updateHighWaterMark: jest.fn().mockResolvedValue(undefined),
      };
      const notifier = {
        sendTradeClose: jest.fn().mockResolvedValue(undefined),
        sendError: jest.fn().mockResolvedValue(undefined),
        sendCritical: jest.fn().mockResolvedValue(undefined),
      };
      const positionStore = {
        getOpenPositions: jest.fn().mockResolvedValue([]),
        updateState: jest.fn().mockResolvedValue(undefined),
      };
      const healthMonitor = { updateTradeTime: jest.fn() };
      const ctx = {
        tradingMode: 'paper',
        tradeStore,
        notifier,
        positionStore,
        healthMonitor,
        paperBalance: 0.0,
      } as unknown as BotContext;

      const trade: Trade = {
        id: 'trade-anomaly',
        pairAddress: 'pair-stonks',
        strategy: 'volume_spike',
        side: 'BUY',
        entryPrice: 0.00008227,
        quantity: 1000,
        status: 'OPEN',
        createdAt: new Date('2026-03-21T00:00:00Z'),
        stopLoss: 0.00007,
        takeProfit1: 0.00009,
        takeProfit2: 0.00010,
        timeStopAt: new Date('2026-03-21T01:00:00Z'),
      };

      // BTW/stonks 패턴 재현: entry=0.00008227, fill=0.00000358 → ratio=-95.6% < -95%
      await closeTrade(trade, 'TAKE_PROFIT_2', ctx, 0.00000358);

      expect(notifier.sendCritical).toHaveBeenCalledWith(
        'exit_anomaly',
        expect.stringContaining('EXIT_ANOMALY')
      );
    });

    it('does not send critical alert for healthy exits within band', async () => {
      const tradeStore = {
        closeTrade: jest.fn().mockResolvedValue(undefined),
        failTrade: jest.fn().mockResolvedValue(undefined),
        updateHighWaterMark: jest.fn().mockResolvedValue(undefined),
      };
      const notifier = {
        sendTradeClose: jest.fn().mockResolvedValue(undefined),
        sendError: jest.fn().mockResolvedValue(undefined),
        sendCritical: jest.fn().mockResolvedValue(undefined),
      };
      const positionStore = {
        getOpenPositions: jest.fn().mockResolvedValue([]),
        updateState: jest.fn().mockResolvedValue(undefined),
      };
      const healthMonitor = { updateTradeTime: jest.fn() };
      const ctx = {
        tradingMode: 'paper',
        tradeStore,
        notifier,
        positionStore,
        healthMonitor,
        paperBalance: 0.0,
      } as unknown as BotContext;

      const trade: Trade = {
        id: 'trade-ok',
        pairAddress: 'pair-ok',
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

      expect(notifier.sendCritical).not.toHaveBeenCalled();
    });
  });
});
