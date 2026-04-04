jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('../src/reporting', () => {
  const actual = jest.requireActual('../src/reporting');
  return {
    ...actual,
    EdgeTracker: jest.fn().mockImplementation(() => ({
      getPairStats: jest.fn().mockReturnValue({
        winRate: 0.5,
        rewardRisk: 2.0,
        sharpeRatio: 1.0,
        maxConsecutiveLosses: 1,
      }),
      isPairBlacklisted: jest.fn().mockReturnValue(false),
    })),
  };
});

jest.mock('../src/risk/riskTier', () => ({
  resolvePortfolioRiskTier: jest.fn().mockReturnValue({
    edgeState: 'Bootstrap',
    maxRiskPerTrade: 0.01,
    maxDailyLoss: 0.05,
    maxDrawdownPct: 0.30,
    recoveryPct: 0.85,
    kellyFraction: 0,
    kellyApplied: false,
    kellyMode: 'fixed',
  }),
  resolveStrategyRiskTier: jest.fn().mockReturnValue({
    edgeState: 'Bootstrap',
    maxRiskPerTrade: 0.01,
    maxDailyLoss: 0.05,
    maxDrawdownPct: 0.30,
    recoveryPct: 0.85,
    kellyFraction: 0,
    kellyApplied: false,
    kellyMode: 'fixed',
  }),
  resolveRiskTierWithDemotion: jest.fn().mockReturnValue({
    profile: {
      edgeState: 'Bootstrap',
      maxRiskPerTrade: 0.01,
      maxDailyLoss: 0.05,
      maxDrawdownPct: 0.30,
      recoveryPct: 0.85,
      kellyFraction: 0,
      kellyApplied: false,
      kellyMode: 'fixed',
    },
    demoted: false,
    demotionReason: undefined,
  }),
  replayPortfolioDrawdownGuard: jest.fn().mockReturnValue({
    peakBalanceSol: 10,
    currentBalanceSol: 10,
    drawdownPct: 0,
    recoveryBalanceSol: 8.5,
    halted: false,
  }),
}));

jest.mock('../src/gate/safetyGate', () => ({
  checkTokenSafety: jest.fn().mockReturnValue({
    approved: true,
    sizeMultiplier: 1.0,
    appliedAdjustments: [],
  }),
}));

jest.mock('../src/gate/sizingGate', () => ({
  getGradeSizeMultiplier: jest.fn().mockReturnValue(1.0),
}));

import { RiskConfig, RiskManager, RiskOrderInput } from '../src/risk/riskManager';
import { PortfolioState, Trade } from '../src/utils/types';

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'trade-1',
    pairAddress: 'PAIR-1',
    strategy: 'volume_spike',
    side: 'BUY',
    entryPrice: 1,
    quantity: 1,
    pnl: 0.1,
    stopLoss: 0.9,
    takeProfit1: 1.1,
    takeProfit2: 1.3,
    timeStopAt: new Date(Date.now() + 3_600_000),
    status: 'CLOSED',
    createdAt: new Date(),
    closedAt: new Date(),
    ...overrides,
  };
}

function makePortfolio(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    balanceSol: 10,
    equitySol: 10,
    openTrades: [],
    dailyPnl: 0,
    consecutiveLosses: 0,
    drawdownGuard: {
      peakBalanceSol: 10,
      currentBalanceSol: 10,
      drawdownPct: 0,
      recoveryBalanceSol: 8.5,
      halted: false,
    },
    ...overrides,
  };
}

function makeOrder(pairAddress = 'PAIR-1'): RiskOrderInput {
  return {
    pairAddress,
    strategy: 'volume_spike',
    side: 'BUY',
    price: 1,
    stopLoss: 0.9,
    breakoutGrade: 'A',
    poolTvl: 100_000,
  };
}

describe('RiskManager token protections', () => {
  const baseRiskConfig: RiskConfig = {
    maxRiskPerTrade: 0.01,
    maxDailyLoss: 0.05,
    maxDrawdownPct: 0.30,
    recoveryPct: 0.85,
    maxConsecutiveLosses: 3,
    cooldownMinutes: 30,
    samePairOpenPositionBlock: true,
    perTokenLossCooldownLosses: 2,
    perTokenLossCooldownMinutes: 240,
    perTokenDailyTradeCap: 0,
    maxSlippage: 0.01,
    minPoolLiquidity: 50_000,
    minTokenAgeHours: 24,
    maxHolderConcentration: 0.80,
    maxConcurrentPositions: 3,
    concurrentTier1Sol: 999,
    concurrentTier2Sol: 999,
  };

  function makeRiskManager(trades: {
    closedTrades?: Trade[];
    todayTrades?: Trade[];
  }, overrides: Partial<RiskConfig> = {}): RiskManager {
    const tradeStore = {
      getOpenTrades: jest.fn().mockResolvedValue([]),
      getTodayPnl: jest.fn().mockResolvedValue(0),
      getRecentClosedTrades: jest.fn().mockResolvedValue([]),
      getClosedTradesChronological: jest.fn().mockResolvedValue(trades.closedTrades ?? []),
      getTodayTrades: jest.fn().mockResolvedValue(trades.todayTrades ?? []),
    };

    return new RiskManager({ ...baseRiskConfig, ...overrides }, tradeStore as any);
  }

  it('rejects a new order when the same pair is already open', async () => {
    const manager = makeRiskManager({});
    const portfolio = makePortfolio({ openTrades: [makeTrade({ status: 'OPEN' })] });

    const result = await manager.checkOrder(makeOrder(), portfolio);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Same-pair position already open');
  });

  it('rejects a pair after consecutive recent losses within cooldown window', async () => {
    const now = Date.now();
    const manager = makeRiskManager({
      closedTrades: [
        makeTrade({ id: 'loss-1', pnl: -0.2, closedAt: new Date(now - 30 * 60 * 1000) }),
        makeTrade({ id: 'loss-2', pnl: -0.1, closedAt: new Date(now - 10 * 60 * 1000) }),
      ],
    });

    const result = await manager.checkOrder(makeOrder(), makePortfolio());

    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Per-token cooldown active');
    expect(manager.isCapSuppressed('PAIR-1')).toBe(true);
  });

  it('resets the pair loss cooldown after a winning close', async () => {
    const now = Date.now();
    const manager = makeRiskManager({
      closedTrades: [
        makeTrade({ id: 'old-loss', pnl: -0.2, closedAt: new Date(now - 45 * 60 * 1000) }),
        makeTrade({ id: 'recent-win', pnl: 0.2, closedAt: new Date(now - 5 * 60 * 1000) }),
      ],
    });

    const result = await manager.checkOrder(makeOrder(), makePortfolio());

    expect(result.approved).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('rejects a pair after reaching the per-token daily trade cap', async () => {
    const manager = makeRiskManager({
      todayTrades: [
        makeTrade({ id: 'today-1' }),
        makeTrade({ id: 'today-2' }),
        makeTrade({ id: 'today-3', status: 'OPEN', closedAt: undefined }),
      ],
    }, { perTokenDailyTradeCap: 3 });

    const result = await manager.checkOrder(makeOrder(), makePortfolio());

    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Per-token daily trade cap reached');
    expect(manager.isCapSuppressed('PAIR-1')).toBe(true);
  });

  it('clears cooldown suppress after the cooldown end passes', async () => {
    jest.useFakeTimers();
    try {
      const now = new Date('2026-04-04T00:00:00.000Z');
      jest.setSystemTime(now);
      const manager = makeRiskManager({
        closedTrades: [
          makeTrade({ id: 'loss-1', pnl: -0.2, closedAt: new Date(now.getTime() - 30 * 60 * 1000) }),
          makeTrade({ id: 'loss-2', pnl: -0.1, closedAt: new Date(now.getTime() - 10 * 60 * 1000) }),
        ],
      });

      const result = await manager.checkOrder(makeOrder(), makePortfolio());
      expect(result.approved).toBe(false);
      expect(manager.isCapSuppressed('PAIR-1')).toBe(true);

      jest.setSystemTime(new Date('2026-04-04T04:01:00.000Z'));
      expect(manager.isCapSuppressed('PAIR-1')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
