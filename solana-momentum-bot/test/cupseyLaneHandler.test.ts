import { config } from '../src/utils/config';
import { getActiveCupseyPositions, handleCupseyLaneSignal, recoverCupseyOpenPositions, updateCupseyPositions } from '../src/orchestration/cupseyLaneHandler';
import type { BotContext } from '../src/orchestration/types';
import type { Signal, Trade } from '../src/utils/types';

describe('cupseyLaneHandler persistence', () => {
  const configPatch = {
    cupseyLaneEnabled: true,
    cupseyGateEnabled: false,
    cupseyLaneTicketSol: 0.01,
    cupseyStalkDropPct: 0.001,
    cupseyStalkMaxDropPct: 0.015,
    cupseyStalKWindowSec: 60,
    cupseyProbeHardCutPct: 0.008,
    cupseyProbeMfeThreshold: 0.02,
    cupseyProbeWindowSec: 45,
    cupseyWinnerMaxHoldSec: 720,
    cupseyWinnerTrailingPct: 0.04,
    cupseyWinnerBreakevenPct: 0.005,
    cupseyMaxConcurrent: 5,
  } as const;
  const originalConfig = new Map<string, unknown>();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-16T00:00:00.000Z'));
    for (const [key, value] of Object.entries(configPatch)) {
      originalConfig.set(key, (config as unknown as Record<string, unknown>)[key]);
      (config as unknown as Record<string, unknown>)[key] = value;
    }
    (getActiveCupseyPositions() as Map<string, unknown>).clear();
  });

  afterEach(() => {
    for (const [key, value] of originalConfig.entries()) {
      (config as unknown as Record<string, unknown>)[key] = value;
    }
    originalConfig.clear();
    (getActiveCupseyPositions() as Map<string, unknown>).clear();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function buildSignal(): Signal {
    return {
      action: 'BUY',
      strategy: 'bootstrap_10s',
      pairAddress: 'PAIR1234567890',
      tokenSymbol: 'CUP',
      price: 100,
      timestamp: new Date('2026-04-16T00:00:00.000Z'),
      meta: {},
      sourceLabel: 'bootstrap',
      discoverySource: 'gecko_trending',
    };
  }

  function buildContext() {
    const tradeStore = {
      insertTrade: jest.fn().mockResolvedValue('db-trade-1'),
      closeTrade: jest.fn().mockResolvedValue(undefined),
      getOpenTrades: jest.fn().mockResolvedValue([]),
      updateHighWaterMark: jest.fn().mockResolvedValue(undefined),
      updateTrailingStop: jest.fn().mockResolvedValue(undefined),
    };
    const notifier = {
      sendTradeOpen: jest.fn().mockResolvedValue(undefined),
      sendTradeClose: jest.fn().mockResolvedValue(undefined),
      sendCritical: jest.fn().mockResolvedValue(undefined),
      sendInfo: jest.fn().mockResolvedValue(undefined),
    };
    const executor = {
      executeBuy: jest.fn(),
      executeSell: jest.fn(),
      getTokenBalance: jest.fn(),
      getBalance: jest.fn(),
    };
    const sandboxExecutor = {
      executeBuy: jest.fn(),
      executeSell: jest.fn(),
      getTokenBalance: jest.fn(),
      getBalance: jest.fn(),
    };
    const ctx = {
      tradingMode: 'live',
      tradeStore,
      notifier,
      executor,
      sandboxExecutor,
    } as unknown as BotContext;

    return { ctx, tradeStore, notifier, executor, sandboxExecutor };
  }

  function buildOpenCupseyTrade(overrides: Partial<Trade> = {}): Trade {
    return {
      id: 'open-cupsey-1',
      pairAddress: 'PAIR1234567890',
      strategy: 'cupsey_flip_10s',
      side: 'BUY',
      tokenSymbol: 'CUP',
      entryPrice: 100,
      plannedEntryPrice: 99.8,
      quantity: 1,
      status: 'OPEN',
      txSignature: 'BUYTX',
      createdAt: new Date('2026-04-16T00:00:00.000Z'),
      stopLoss: 99,
      takeProfit1: 102,
      takeProfit2: 104,
      highWaterMark: 100,
      timeStopAt: new Date('2026-04-16T00:12:00.000Z'),
      ...overrides,
    };
  }

  it('persists OPEN trade immediately when cupsey entry executes', async () => {
    let currentPrice = 99.8;
    const candleBuilder = {
      getCurrentPrice: jest.fn(() => currentPrice),
      getRecentCandles: jest.fn(() => []),
    } as any;
    const { ctx, tradeStore, notifier, executor, sandboxExecutor } = buildContext();
    sandboxExecutor.executeBuy.mockResolvedValue({
      txSignature: 'BUYTX',
      expectedOutAmount: 1n,
      actualOutUiAmount: 1,
      actualInputUiAmount: 99.8,
      slippageBps: 12,
    });

    await handleCupseyLaneSignal(buildSignal(), candleBuilder, ctx);
    await updateCupseyPositions(ctx, candleBuilder);

    expect(sandboxExecutor.executeBuy).toHaveBeenCalledTimes(1);
    expect(executor.executeBuy).not.toHaveBeenCalled();
    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1);

    const [openedTrade] = tradeStore.insertTrade.mock.calls[0];
    expect(openedTrade.strategy).toBe('cupsey_flip_10s');
    expect(openedTrade.status).toBe('OPEN');
    expect(openedTrade.txSignature).toBe('BUYTX');
    expect(openedTrade.plannedEntryPrice).toBeCloseTo(99.8, 8);
    expect(openedTrade.entryPrice).toBeCloseTo(99.8, 8);
    expect(openedTrade.entrySlippageBps).toBe(12);
    expect(openedTrade.sourceLabel).toBe('bootstrap');
    expect(openedTrade.discoverySource).toBe('gecko_trending');

    expect(notifier.sendTradeOpen).toHaveBeenCalledTimes(1);
    const [openOrder, openTx] = notifier.sendTradeOpen.mock.calls[0];
    expect(openOrder.tradeId).toBe('db-trade-1');
    expect(openOrder.plannedEntryPrice).toBeCloseTo(99.8, 8);
    expect(openTx).toBe('BUYTX');
  });

  it('closes the persisted OPEN trade instead of inserting a second row on sell', async () => {
    let currentPrice = 99.8;
    const candleBuilder = {
      getCurrentPrice: jest.fn(() => currentPrice),
      getRecentCandles: jest.fn(() => []),
    } as any;
    const { ctx, tradeStore, notifier, executor, sandboxExecutor } = buildContext();
    sandboxExecutor.executeBuy.mockResolvedValue({
      txSignature: 'BUYTX',
      expectedOutAmount: 1n,
      actualOutUiAmount: 1,
      actualInputUiAmount: 99.8,
      slippageBps: 12,
    });
    sandboxExecutor.getTokenBalance.mockResolvedValue(100n);
    sandboxExecutor.getBalance
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(108.8);
    sandboxExecutor.executeSell.mockResolvedValue({
      txSignature: 'SELLTX',
      expectedOutAmount: 1n,
      slippageBps: 20,
    });

    await handleCupseyLaneSignal(buildSignal(), candleBuilder, ctx);
    await updateCupseyPositions(ctx, candleBuilder);

    currentPrice = 98.8;
    await updateCupseyPositions(ctx, candleBuilder);

    expect(sandboxExecutor.executeSell).toHaveBeenCalledTimes(1);
    expect(executor.executeSell).not.toHaveBeenCalled();
    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1);
    expect(tradeStore.closeTrade).toHaveBeenCalledTimes(1);

    const [closeArgs] = tradeStore.closeTrade.mock.calls[0];
    expect(closeArgs.id).toBe('db-trade-1');
    expect(closeArgs.exitReason).toBe('REJECT_HARD_CUT');
    expect(closeArgs.decisionPrice).toBeCloseTo(98.8, 8);
    expect(closeArgs.exitPrice).toBeCloseTo(98.8, 8);
    expect(closeArgs.exitSlippageBps).toBe(20);

    expect(notifier.sendTradeClose).toHaveBeenCalledTimes(1);
    const [closedTrade] = notifier.sendTradeClose.mock.calls[0];
    expect(closedTrade.id).toBe('db-trade-1');
    expect(closedTrade.txSignature).toBe('SELLTX');
    expect(closedTrade.exitReason).toBe('REJECT_HARD_CUT');
  });

  it('keeps the cupsey position OPEN and sends a critical alert when live sell fails', async () => {
    let currentPrice = 99.8;
    const candleBuilder = {
      getCurrentPrice: jest.fn(() => currentPrice),
      getRecentCandles: jest.fn(() => []),
    } as any;
    const { ctx, tradeStore, notifier, sandboxExecutor } = buildContext();
    sandboxExecutor.executeBuy.mockResolvedValue({
      txSignature: 'BUYTX',
      expectedOutAmount: 1n,
      actualOutUiAmount: 1,
      actualInputUiAmount: 99.8,
      slippageBps: 12,
    });
    sandboxExecutor.getTokenBalance.mockResolvedValue(100n);
    sandboxExecutor.executeSell.mockRejectedValue(new Error('sell failed'));

    await handleCupseyLaneSignal(buildSignal(), candleBuilder, ctx);
    await updateCupseyPositions(ctx, candleBuilder);

    currentPrice = 98.8;
    await updateCupseyPositions(ctx, candleBuilder);

    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1);
    expect(tradeStore.closeTrade).not.toHaveBeenCalled();
    expect(notifier.sendTradeClose).not.toHaveBeenCalled();
    expect(notifier.sendCritical).toHaveBeenCalledWith(
      'cupsey_close_failed',
      expect.stringContaining('sell failed')
    );

    const positions = getActiveCupseyPositions();
    expect(positions.size).toBe(1);
    const [position] = [...positions.values()];
    expect(position.state).toBe('PROBE');
    expect(position.dbTradeId).toBe('db-trade-1');
  });

  it('suppresses close notification and raises a critical alert when DB close persistence fails', async () => {
    let currentPrice = 99.8;
    const candleBuilder = {
      getCurrentPrice: jest.fn(() => currentPrice),
      getRecentCandles: jest.fn(() => []),
    } as any;
    const { ctx, tradeStore, notifier, sandboxExecutor } = buildContext();
    sandboxExecutor.executeBuy.mockResolvedValue({
      txSignature: 'BUYTX',
      expectedOutAmount: 1n,
      actualOutUiAmount: 1,
      actualInputUiAmount: 99.8,
      slippageBps: 12,
    });
    sandboxExecutor.getTokenBalance.mockResolvedValue(100n);
    sandboxExecutor.getBalance
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(108.8);
    sandboxExecutor.executeSell.mockResolvedValue({
      txSignature: 'SELLTX',
      expectedOutAmount: 1n,
      slippageBps: 20,
    });
    tradeStore.closeTrade.mockRejectedValue(new Error('db close failed'));

    await handleCupseyLaneSignal(buildSignal(), candleBuilder, ctx);
    await updateCupseyPositions(ctx, candleBuilder);

    currentPrice = 98.8;
    await updateCupseyPositions(ctx, candleBuilder);

    expect(tradeStore.closeTrade).toHaveBeenCalledTimes(1);
    expect(notifier.sendTradeClose).not.toHaveBeenCalled();
    expect(notifier.sendCritical).toHaveBeenCalledWith(
      'cupsey_close_persist',
      expect.stringContaining('sell ok but DB close failed')
    );
    expect(getActiveCupseyPositions().size).toBe(0);
  });

  it('recovers OPEN cupsey trades from the shared ledger with inferred state', async () => {
    const { ctx, tradeStore } = buildContext();
    tradeStore.getOpenTrades.mockResolvedValue([
      buildOpenCupseyTrade(),
      buildOpenCupseyTrade({
        id: 'open-cupsey-2',
        pairAddress: 'PAIRWINNER0001',
        highWaterMark: 103,
        trailingStop: 98.88,
      }),
      buildOpenCupseyTrade({
        id: 'main-open-1',
        pairAddress: 'PAIRMAIN000001',
        strategy: 'volume_spike',
      }),
    ]);

    const recovered = await recoverCupseyOpenPositions(ctx);

    expect(recovered).toBe(2);
    const positions = [...getActiveCupseyPositions().values()];
    expect(positions).toHaveLength(2);
    expect(positions.find((position) => position.dbTradeId === 'open-cupsey-1')?.state).toBe('PROBE');
    expect(positions.find((position) => position.dbTradeId === 'open-cupsey-2')?.state).toBe('WINNER');
  });

  it('persists cupsey high-water mark and trailing stop while the recovered winner is monitored', async () => {
    let currentPrice = 106;
    const candleBuilder = {
      getCurrentPrice: jest.fn(() => currentPrice),
      getRecentCandles: jest.fn(() => []),
    } as any;
    const { ctx, tradeStore } = buildContext();
    tradeStore.getOpenTrades.mockResolvedValue([
      buildOpenCupseyTrade({
        id: 'open-cupsey-winner',
        highWaterMark: 103,
        trailingStop: 98.88,
      }),
    ]);

    await recoverCupseyOpenPositions(ctx);
    await updateCupseyPositions(ctx, candleBuilder);

    expect(tradeStore.updateHighWaterMark).toHaveBeenCalledWith('open-cupsey-winner', 106);
    expect(tradeStore.updateTrailingStop).toHaveBeenCalledWith(
      'open-cupsey-winner',
      106 * (1 - config.cupseyWinnerTrailingPct)
    );
  });
});
