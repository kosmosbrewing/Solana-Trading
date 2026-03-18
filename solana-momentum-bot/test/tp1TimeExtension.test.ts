/**
 * v3: TP1 Time Stop Extension 테스트
 * TP1 50% 청산 후 잔여 trade의 timeStopAt이 now + tp1TimeExtensionMinutes인지 확인
 */

// config mock을 최상위에서 정의 — jest.mock 호이스팅
const mockConfig = {
  tp1TimeExtensionMinutes: 30,
  degradedExitEnabled: false,
  runnerEnabled: false,
  runnerGradeBEnabled: false,
};

jest.mock('../src/utils/config', () => ({
  config: mockConfig,
}));

jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// handleTakeProfit1Partial은 private이므로 checkOpenPositions를 통해 간접 테스트
// 또는 모듈 내부를 직접 테스트하기 위해 import 후 mock context 사용
import { Trade } from '../src/utils/types';
import { BotContext } from '../src/orchestration/types';

// tradeExecution 모듈 전체를 가져옴 — checkOpenPositions 내부에서 TP1 분기를 탐
// 대신 insertTrade 호출 시 전달되는 trade를 캡처하여 timeStopAt 검증

describe('TP1 Time Stop Extension', () => {
  const now = Date.now();

  function makeTrade(overrides: Partial<Trade> = {}): Trade {
    return {
      id: 'trade-tp1-test',
      pairAddress: 'TOKEN-PAIR',
      strategy: 'volume_spike',
      side: 'BUY',
      entryPrice: 1.0,
      quantity: 10,
      stopLoss: 0.9,
      takeProfit1: 1.3,
      takeProfit2: 1.6,
      trailingStop: 1.1,
      highWaterMark: 1.0,
      timeStopAt: new Date(now + 1800_000), // 원본: 30분 후
      status: 'OPEN',
      createdAt: new Date(now - 1500_000), // 25분 전 생성
      breakoutGrade: 'A',
      ...overrides,
    };
  }

  it('잔여 trade의 timeStopAt이 now + 30분(기본값)으로 설정됨', async () => {
    const capturedTrades: Omit<Trade, 'id'>[] = [];

    const mockCtx = {
      tradingMode: 'paper',
      executor: {
        getTokenBalance: jest.fn().mockResolvedValue(0n),
        getBalance: jest.fn().mockResolvedValue(1.0),
      },
      tradeStore: {
        closeTrade: jest.fn().mockResolvedValue(undefined),
        insertTrade: jest.fn().mockImplementation((trade: Omit<Trade, 'id'>) => {
          capturedTrades.push(trade);
          return Promise.resolve('new-trade-id');
        }),
      },
      notifier: {
        sendTradeClose: jest.fn().mockResolvedValue(undefined),
        sendTradeAlert: jest.fn().mockResolvedValue(undefined),
      },
      positionStore: {
        getOpenPositions: jest.fn().mockResolvedValue([]),
        updateState: jest.fn().mockResolvedValue(undefined),
      },
      healthMonitor: {
        updateTradeTime: jest.fn(),
      },
    } as unknown as BotContext;

    // 직접 handleTakeProfit1Partial 호출 불가(private)이므로 모듈 내부를 require
    // checkOpenPositions → TP1 분기 → handleTakeProfit1Partial
    // 대안: 모듈에서 export된 checkOpenPositions를 사용하되, candle mock 필요
    // 여기서는 tradeExecution 내부 함수를 테스트 편의상 dynamic import

    // handleTakeProfit1Partial는 export 안 됨 → checkOpenPositions 경유
    const { checkOpenPositions } = require('../src/orchestration/tradeExecution');

    const trade = makeTrade();
    const currentPrice = 1.35; // TP1(1.3) 이상, TP2(1.6) 미만

    // checkOpenPositions에 필요한 mock 확장
    const fullCtx = {
      ...mockCtx,
      tradingMode: 'paper',
      tradingHaltedReason: undefined,
      riskManager: {
        getPortfolioState: jest.fn().mockResolvedValue({
          balanceSol: 10,
          equitySol: 10,
          openTrades: [trade],
          dailyPnl: 0,
          consecutiveLosses: 0,
          drawdownGuard: { halted: false, peakBalanceSol: 10, currentBalanceSol: 10, drawdownPct: 0, recoveryBalanceSol: 8.5 },
        }),
        getActiveHalt: jest.fn().mockReturnValue(undefined),
        applyUnrealizedDrawdown: jest.fn().mockImplementation((p: unknown) => p),
      },
      candleStore: {
        getRecentCandles: jest.fn().mockResolvedValue([
          { open: 1.3, high: 1.4, low: 1.28, close: currentPrice, volume: 100, buyVolume: 60, sellVolume: 40, tradeCount: 10, timestamp: new Date(), pairAddress: 'TOKEN-PAIR', intervalSec: 300 },
        ]),
      },
      paperMetrics: {
        updateExcursion: jest.fn(),
      },
      healthMonitor: {
        ...mockCtx.healthMonitor,
        updatePositions: jest.fn(),
        updateDailyPnl: jest.fn(),
      },
    } as unknown as BotContext;

    const beforeCall = Date.now();
    await checkOpenPositions(fullCtx);
    const afterCall = Date.now();

    // insertTrade가 호출되었는지 확인 (잔여 trade 생성)
    expect(capturedTrades.length).toBe(1);

    const remainingTrade = capturedTrades[0];
    const expectedMinTime = beforeCall + 30 * 60_000;
    const expectedMaxTime = afterCall + 30 * 60_000;

    // timeStopAt이 now + 30분 범위 내인지 확인
    expect(remainingTrade.timeStopAt.getTime()).toBeGreaterThanOrEqual(expectedMinTime - 1000);
    expect(remainingTrade.timeStopAt.getTime()).toBeLessThanOrEqual(expectedMaxTime + 1000);

    // 원본의 timeStopAt(5분 남음)이 아닌 새 값이어야 함
    expect(remainingTrade.timeStopAt.getTime()).toBeGreaterThan(trade.timeStopAt.getTime());
  });

  it('커스텀 값(45분) 동작 확인', async () => {
    mockConfig.tp1TimeExtensionMinutes = 45;

    const capturedTrades: Omit<Trade, 'id'>[] = [];
    const trade = makeTrade();
    const currentPrice = 1.35;

    const fullCtx = {
      tradingMode: 'paper',
      tradingHaltedReason: undefined,
      executor: {
        getTokenBalance: jest.fn().mockResolvedValue(0n),
        getBalance: jest.fn().mockResolvedValue(1.0),
      },
      tradeStore: {
        closeTrade: jest.fn().mockResolvedValue(undefined),
        insertTrade: jest.fn().mockImplementation((t: Omit<Trade, 'id'>) => {
          capturedTrades.push(t);
          return Promise.resolve('new-trade-id');
        }),
      },
      notifier: {
        sendTradeClose: jest.fn().mockResolvedValue(undefined),
        sendTradeAlert: jest.fn().mockResolvedValue(undefined),
      },
      positionStore: {
        getOpenPositions: jest.fn().mockResolvedValue([]),
        updateState: jest.fn().mockResolvedValue(undefined),
      },
      healthMonitor: {
        updateTradeTime: jest.fn(),
        updatePositions: jest.fn(),
        updateDailyPnl: jest.fn(),
      },
      riskManager: {
        getPortfolioState: jest.fn().mockResolvedValue({
          balanceSol: 10,
          equitySol: 10,
          openTrades: [trade],
          dailyPnl: 0,
          consecutiveLosses: 0,
          drawdownGuard: { halted: false, peakBalanceSol: 10, currentBalanceSol: 10, drawdownPct: 0, recoveryBalanceSol: 8.5 },
        }),
        getActiveHalt: jest.fn().mockReturnValue(undefined),
        applyUnrealizedDrawdown: jest.fn().mockImplementation((p: unknown) => p),
      },
      candleStore: {
        getRecentCandles: jest.fn().mockResolvedValue([
          { open: 1.3, high: 1.4, low: 1.28, close: currentPrice, volume: 100, buyVolume: 60, sellVolume: 40, tradeCount: 10, timestamp: new Date(), pairAddress: 'TOKEN-PAIR', intervalSec: 300 },
        ]),
      },
      paperMetrics: { updateExcursion: jest.fn() },
    } as unknown as BotContext;

    const beforeCall = Date.now();
    const { checkOpenPositions } = require('../src/orchestration/tradeExecution');
    await checkOpenPositions(fullCtx);
    const afterCall = Date.now();

    expect(capturedTrades.length).toBe(1);

    const remainingTrade = capturedTrades[0];
    const expectedMinTime = beforeCall + 45 * 60_000;
    const expectedMaxTime = afterCall + 45 * 60_000;

    expect(remainingTrade.timeStopAt.getTime()).toBeGreaterThanOrEqual(expectedMinTime - 1000);
    expect(remainingTrade.timeStopAt.getTime()).toBeLessThanOrEqual(expectedMaxTime + 1000);

    // cleanup
    mockConfig.tp1TimeExtensionMinutes = 30;
  });
});
