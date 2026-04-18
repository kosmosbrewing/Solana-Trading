import {
  processSignal,
  buildEntryExecutionSummary,
  resolveActualEntryMetrics,
} from '../src/orchestration/signalProcessor';
import type { BotContext } from '../src/orchestration/types';
import type { Candle, Order, Signal } from '../src/utils/types';

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

// Phase A2 — CRITICAL_LIVE 가격 단위 정합성 가드 검증
describe('buildEntryExecutionSummary (Phase A2 guard)', () => {
  const baseOrder: Order = {
    pairAddress: 'pair-test',
    strategy: 'volume_spike',
    side: 'BUY',
    price: 1.0,
    quantity: 10,
    stopLoss: 0.95,
    takeProfit1: 1.1,
    takeProfit2: 1.2,
    trailingStop: 0.05,
    timeStopMinutes: 30,
  };
  const baseExecution = { effectiveRR: 1.8, roundTripCost: 0.01 };

  it('uses actual values when both input and output are provided', () => {
    const summary = buildEntryExecutionSummary(baseOrder, baseExecution, {
      actualInputUiAmount: 10.5,
      actualOutUiAmount: 10,
      outputDecimals: 6,
      slippageBps: 50,
      expectedInAmount: 10n,
      expectedOutAmount: 10n,
      txSignature: 'TX_OK',
    } as any);

    expect(summary.entryPrice).toBeCloseTo(1.05, 8);
    expect(summary.quantity).toBe(10);
    expect(summary.actualEntryNotionalSol).toBe(10.5);
  });

  it('forces both sides to planned when only actualOutUiAmount is provided (partial fill guard)', () => {
    // P0-A case: actualIn 누락 → entryPrice 왜곡 방지 위해 둘 다 planned로 강제
    const summary = buildEntryExecutionSummary(baseOrder, baseExecution, {
      actualInputUiAmount: undefined,
      actualOutUiAmount: 9.5,
      outputDecimals: 6,
      slippageBps: 0,
      txSignature: 'TX_PARTIAL',
    } as any);

    expect(summary.entryPrice).toBeCloseTo(1.0, 8);
    expect(summary.quantity).toBe(10);
    expect(summary.actualEntryNotionalSol).toBe(10);
  });

  it('forces both sides to planned when only actualInputUiAmount is provided', () => {
    const summary = buildEntryExecutionSummary(baseOrder, baseExecution, {
      actualInputUiAmount: 10.2,
      actualOutUiAmount: undefined,
      slippageBps: 0,
      txSignature: 'TX_PARTIAL2',
    } as any);

    expect(summary.entryPrice).toBeCloseTo(1.0, 8);
    expect(summary.quantity).toBe(10);
  });

  it('falls back to planned entirely when buyResult is undefined (paper mode)', () => {
    const summary = buildEntryExecutionSummary(baseOrder, baseExecution, undefined);
    expect(summary.entryPrice).toBeCloseTo(1.0, 8);
    expect(summary.quantity).toBe(10);
    expect(summary.entrySlippageBps).toBe(0);
  });

  it('[2026-04-18 drift regression] cupsey pippin case — actualOut only must NOT keep signalPrice×actualOut as entry cost', () => {
    // Real VPS event: cupsey-Dfh5DzRg-1776511972 (pippin) at UTC 11:33:05.
    // order.price = 0.00302282 (pullback entry signal), order.quantity = 3.2915 (ticketSol/price).
    // buyResult.actualOutUiAmount = 30.12 (actual tokens received, 9.15x expected), actualInputUiAmount = undefined.
    // BEFORE fix: entryPrice stayed at 0.00302282, quantity became 30.12 → entryPrice×quantity = 0.0911 SOL
    //            recorded as BUY cost, but real spend = 0.00995 SOL → closeCupseyPosition calc loss 0.081 SOL
    //            → WALLET_DELTA_WARN drift=+0.0799 SOL every 5 min.
    // AFTER fix: resolveActualEntryMetrics detects partial metrics → both forced to planned.
    const pippinOrder: Order = {
      pairAddress: 'Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump',
      strategy: 'cupsey_flip_10s',
      side: 'BUY',
      price: 0.00302282,
      quantity: 3.2915,
      stopLoss: 0,
      takeProfit1: 0,
      takeProfit2: 0,
      timeStopMinutes: 5,
    };
    const m = resolveActualEntryMetrics(pippinOrder, {
      actualInputUiAmount: undefined,
      actualOutUiAmount: 30.12,
      outputDecimals: 6,
      slippageBps: 3,
      txSignature: 'TX_PIPPIN',
    } as any);
    expect(m.entryPrice).toBeCloseTo(0.00302282, 8);
    expect(m.quantity).toBeCloseTo(3.2915, 6);
    expect(m.actualEntryNotionalSol).toBeCloseTo(0.00302282 * 3.2915, 8);
    const recordedEntryCost = m.entryPrice * m.quantity;
    expect(recordedEntryCost).toBeCloseTo(m.actualEntryNotionalSol, 8);
  });

  it('forces planned when actualOut is 5x+ larger than expected (multi-account guard)', () => {
    // 2026-04-10 P1-D2: GRIFFAIN 사례 — actualOut 682 tokens vs expected 27 = 25x.
    // getTokenBalance 가 이전 잔여분을 합산하거나 RPC race 로 인한 over-report.
    // Output sanity guard 가 발동하여 planned 로 fallback.
    const summary = buildEntryExecutionSummary(baseOrder, baseExecution, {
      actualInputUiAmount: 10,
      actualOutUiAmount: 8_200_000, // 820_000x of expected (10/1=10) → 5x 초과 → guard 발동
      outputDecimals: 6,
      slippageBps: 0,
      txSignature: 'TX_BTW',
    } as any);

    // Guard 발동 → force-to-planned: entryPrice = order.price, quantity = order.quantity
    expect(summary.entryPrice).toBeCloseTo(1.0, 8);
    expect(summary.quantity).toBe(10);
  });
});
