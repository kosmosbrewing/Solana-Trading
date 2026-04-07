import { processSignal, buildEntryExecutionSummary } from '../src/orchestration/signalProcessor';
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

  it('still builds a summary even when actual/planned ratio is way off (warn only in A2)', () => {
    // BTW 케이스: ratio 1.5e-6 (A2는 log warn만, 차단은 A3에서)
    const summary = buildEntryExecutionSummary(baseOrder, baseExecution, {
      actualInputUiAmount: 10,
      actualOutUiAmount: 8_200_000, // 1 token = 0.00000122 SOL
      outputDecimals: 6,
      slippageBps: 0,
      txSignature: 'TX_BTW',
    } as any);

    // summary는 만들어지지만 A3의 assertEntryAlignmentSafe가 recordOpenedTrade에서 차단한다
    expect(summary.entryPrice).toBeCloseTo(10 / 8_200_000, 10);
    expect(summary.quantity).toBe(8_200_000);
  });
});
