/**
 * v3: Runner Concurrent 테스트
 * Runner 포지션이 있을 때 +1 concurrent 허용 로직 검증
 */

// config mock 불필요 — RiskConfig interface로 직접 전달

jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// EdgeTracker 및 riskTier mock
jest.mock('../src/reporting', () => ({
  EdgeTracker: jest.fn().mockImplementation(() => ({
    getPairStats: jest.fn().mockReturnValue({
      winRate: 0.5,
      rewardRisk: 2.0,
      sharpeRatio: 1.0,
      maxConsecutiveLosses: 1,
    }),
    isPairBlacklisted: jest.fn().mockReturnValue(false),
  })),
}));

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

import { RiskManager, RiskConfig, RiskOrderInput } from '../src/risk/riskManager';
import { PortfolioState, Trade } from '../src/utils/types';

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'runner-trade-1',
    pairAddress: 'RUNNER-PAIR',
    strategy: 'volume_spike',
    side: 'BUY',
    entryPrice: 1.0,
    quantity: 5,
    stopLoss: 0.9,
    takeProfit1: 1.3,
    takeProfit2: 1.6,
    timeStopAt: new Date(Date.now() + 3600_000),
    status: 'OPEN',
    createdAt: new Date(),
    breakoutGrade: 'A',
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

function makeOrder(): RiskOrderInput {
  return {
    pairAddress: 'NEW-PAIR',
    strategy: 'volume_spike',
    side: 'BUY',
    price: 0.001,
    stopLoss: 0.0009,
    breakoutGrade: 'B',
    poolTvl: 100_000,
  };
}

describe('Runner Concurrent', () => {
  const baseRiskConfig: RiskConfig = {
    maxRiskPerTrade: 0.01,
    maxDailyLoss: 0.05,
    maxDrawdownPct: 0.30,
    recoveryPct: 0.85,
    maxConsecutiveLosses: 3,
    cooldownMinutes: 30,
    maxSlippage: 0.01,
    minPoolLiquidity: 50000,
    minTokenAgeHours: 24,
    maxHolderConcentration: 0.80,
    runnerConcurrentEnabled: false,
    maxConcurrentPositions: 1,
    // v4: equity tier 비활성화 (기존 runner 로직만 테스트)
    concurrentTier1Sol: 999,
    concurrentTier2Sol: 999,
  };

  const mockTradeStore = {
    getOpenTrades: jest.fn().mockResolvedValue([]),
    getTodayPnl: jest.fn().mockResolvedValue(0),
    getRecentClosedTrades: jest.fn().mockResolvedValue([]),
    getClosedTradesChronological: jest.fn().mockResolvedValue([]),
  };

  function makeRiskManager(overrides: Partial<RiskConfig> = {}): RiskManager {
    return new RiskManager({ ...baseRiskConfig, ...overrides }, mockTradeStore as any);
  }

  it('flag off + open 1 → reject (기존 동작)', async () => {
    const rm = makeRiskManager({ runnerConcurrentEnabled: false });

    const runnerTrade = makeTrade();
    const portfolio = makePortfolio({
      openTrades: [runnerTrade],
      runnerTradeIds: new Set(['runner-trade-1']),
    });

    const result = await rm.checkOrder(makeOrder(), portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Max concurrent');
  });

  it('flag on + open 1 runner → approve', async () => {
    const rm = makeRiskManager({ runnerConcurrentEnabled: true });

    const runnerTrade = makeTrade();
    const portfolio = makePortfolio({
      openTrades: [runnerTrade],
      runnerTradeIds: new Set(['runner-trade-1']),
    });

    const result = await rm.checkOrder(makeOrder(), portfolio);
    expect(result.approved).toBe(true);
    expect(result.appliedAdjustments).toContain('RUNNER_CONCURRENT_BYPASS');
  });

  it('flag on + open 1 non-runner → reject', async () => {
    const rm = makeRiskManager({ runnerConcurrentEnabled: true });

    const normalTrade = makeTrade({ id: 'normal-trade-1' });
    const portfolio = makePortfolio({
      openTrades: [normalTrade],
      runnerTradeIds: new Set(), // runner 아님
    });

    const result = await rm.checkOrder(makeOrder(), portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Max concurrent');
  });

  it('flag on + open at ABSOLUTE_MAX → reject (절대 상한)', async () => {
    const rm = makeRiskManager({
      runnerConcurrentEnabled: true,
      maxConcurrentPositions: 2,
      maxConcurrentAbsolute: 3,
    });

    const trades = [
      makeTrade({ id: 'r-1' }),
      makeTrade({ id: 'r-2', pairAddress: 'P-2' }),
      makeTrade({ id: 'r-3', pairAddress: 'P-3' }),
    ];
    const portfolio = makePortfolio({
      equitySol: 25,
      openTrades: trades,
      runnerTradeIds: new Set(['r-1', 'r-2', 'r-3']),
    });

    const result = await rm.checkOrder(makeOrder(), portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Max concurrent');
  });
});

describe('Equity-Scaled Concurrent (v4 Step 3)', () => {
  const baseRiskConfig: RiskConfig = {
    maxRiskPerTrade: 0.01,
    maxDailyLoss: 0.05,
    maxDrawdownPct: 0.30,
    recoveryPct: 0.85,
    maxConsecutiveLosses: 3,
    cooldownMinutes: 30,
    maxSlippage: 0.01,
    minPoolLiquidity: 50000,
    minTokenAgeHours: 24,
    maxHolderConcentration: 0.80,
    maxConcurrentPositions: 1,
    maxConcurrentAbsolute: 4,
    concurrentTier1Sol: 5,
    concurrentTier2Sol: 20,
  };

  const mockTradeStore = {
    getOpenTrades: jest.fn().mockResolvedValue([]),
    getTodayPnl: jest.fn().mockResolvedValue(0),
    getRecentClosedTrades: jest.fn().mockResolvedValue([]),
    getClosedTradesChronological: jest.fn().mockResolvedValue([]),
  };

  function makeRiskManager(overrides: Partial<RiskConfig> = {}): RiskManager {
    return new RiskManager({ ...baseRiskConfig, ...overrides }, mockTradeStore as any);
  }

  it('equitySol=3 → max 1 (기본)', async () => {
    const rm = makeRiskManager();
    const t1 = makeTrade({ id: 't-1' });
    const portfolio = makePortfolio({
      equitySol: 3,
      openTrades: [t1],
    });

    const result = await rm.checkOrder(makeOrder(), portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Max concurrent');
  });

  it('equitySol=8 → max 2 (tier 1)', async () => {
    const rm = makeRiskManager();
    const t1 = makeTrade({ id: 't-1' });
    const portfolio = makePortfolio({
      equitySol: 8,
      balanceSol: 8,
      openTrades: [t1],
    });

    const result = await rm.checkOrder(makeOrder(), portfolio);
    expect(result.approved).toBe(true);
  });

  it('equitySol=25 → max 3 (tier 2)', async () => {
    const rm = makeRiskManager();
    const t1 = makeTrade({ id: 't-1' });
    const t2 = makeTrade({ id: 't-2', pairAddress: 'P-2' });
    const portfolio = makePortfolio({
      equitySol: 25,
      balanceSol: 25,
      openTrades: [t1, t2],
    });

    const result = await rm.checkOrder(makeOrder(), portfolio);
    expect(result.approved).toBe(true);
  });

  it('equitySol=25 + runner → max 4 (ABSOLUTE_MAX 이내)', async () => {
    const rm = makeRiskManager({ runnerConcurrentEnabled: true });
    const trades = [
      makeTrade({ id: 't-1' }),
      makeTrade({ id: 't-2', pairAddress: 'P-2' }),
      makeTrade({ id: 't-3', pairAddress: 'P-3' }),
    ];
    const portfolio = makePortfolio({
      equitySol: 25,
      balanceSol: 25,
      openTrades: trades,
      runnerTradeIds: new Set(['t-1']),
    });

    const result = await rm.checkOrder(makeOrder(), portfolio);
    expect(result.approved).toBe(true);
    expect(result.appliedAdjustments).toContain('RUNNER_CONCURRENT_BYPASS');
  });
});
