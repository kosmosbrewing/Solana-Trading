import { TradeStore } from '../src/candle/tradeStore';
import { RiskManager } from '../src/risk';
import type { PortfolioState } from '../src/utils/types';
import { config } from '../src/utils/config';
import { createFakeClock } from '../src/utils/clock';

// 2026-04-25 H1.2: 시계 의존을 FakeClock 으로 격리.
// fixture 시간 (2026-04-16) 과 실 시계가 다르면 dailyPnl 집계가 0 으로 떨어져 false fail.
// 모든 RiskManager 인스턴스는 fixture 와 같은 날 (2026-04-16T12:00:00Z) 의 FakeClock 사용.
const FIXTURE_NOW = '2026-04-16T12:00:00Z';

describe('RiskManager unrealized drawdown', () => {
  it('excludes sandbox strategies from portfolio open trades and realized risk state', async () => {
    const tradeStore = {
      getOpenTrades: jest.fn().mockResolvedValue([
        {
          id: 'main-open',
          pairAddress: 'pair-main',
          strategy: 'volume_spike',
          side: 'BUY',
          entryPrice: 1,
          quantity: 1,
          status: 'OPEN',
          createdAt: new Date('2026-04-16T00:00:00.000Z'),
          stopLoss: 0.9,
          takeProfit1: 1.1,
          takeProfit2: 1.2,
          timeStopAt: new Date('2026-04-16T01:00:00.000Z'),
        },
        {
          id: 'sandbox-open',
          pairAddress: 'pair-cupsey',
          strategy: 'cupsey_flip_10s',
          side: 'BUY',
          entryPrice: 2,
          quantity: 1,
          status: 'OPEN',
          createdAt: new Date('2026-04-16T00:00:00.000Z'),
          stopLoss: 1.8,
          takeProfit1: 2.1,
          takeProfit2: 2.2,
          timeStopAt: new Date('2026-04-16T01:00:00.000Z'),
        },
      ]),
      getRecentClosedTrades: jest.fn().mockResolvedValue([
        {
          id: 'sandbox-loss',
          pairAddress: 'pair-cupsey',
          strategy: 'cupsey_flip_10s',
          side: 'BUY',
          entryPrice: 1,
          exitPrice: 0.8,
          quantity: 1,
          pnl: -0.2,
          status: 'CLOSED',
          createdAt: new Date('2026-04-16T00:10:00.000Z'),
          closedAt: new Date('2026-04-16T00:20:00.000Z'),
          stopLoss: 0.9,
          takeProfit1: 1.1,
          takeProfit2: 1.2,
          timeStopAt: new Date('2026-04-16T01:00:00.000Z'),
        },
        {
          id: 'main-win',
          pairAddress: 'pair-main',
          strategy: 'volume_spike',
          side: 'BUY',
          entryPrice: 1,
          exitPrice: 1.2,
          quantity: 1,
          pnl: 0.2,
          status: 'CLOSED',
          createdAt: new Date('2026-04-16T00:30:00.000Z'),
          closedAt: new Date('2026-04-16T00:40:00.000Z'),
          stopLoss: 0.9,
          takeProfit1: 1.1,
          takeProfit2: 1.2,
          timeStopAt: new Date('2026-04-16T01:00:00.000Z'),
        },
      ]),
      getClosedTradesChronological: jest.fn().mockResolvedValue([
        {
          id: 'sandbox-loss',
          pairAddress: 'pair-cupsey',
          strategy: 'cupsey_flip_10s',
          side: 'BUY',
          entryPrice: 1,
          exitPrice: 0.8,
          quantity: 1,
          pnl: -0.2,
          status: 'CLOSED',
          createdAt: new Date('2026-04-16T00:10:00.000Z'),
          closedAt: new Date('2026-04-16T00:20:00.000Z'),
          stopLoss: 0.9,
          takeProfit1: 1.1,
          takeProfit2: 1.2,
          timeStopAt: new Date('2026-04-16T01:00:00.000Z'),
        },
        {
          id: 'main-win',
          pairAddress: 'pair-main',
          strategy: 'volume_spike',
          side: 'BUY',
          entryPrice: 1,
          exitPrice: 1.2,
          quantity: 1,
          pnl: 0.2,
          status: 'CLOSED',
          createdAt: new Date('2026-04-16T00:30:00.000Z'),
          closedAt: new Date('2026-04-16T00:40:00.000Z'),
          stopLoss: 0.9,
          takeProfit1: 1.1,
          takeProfit2: 1.2,
          timeStopAt: new Date('2026-04-16T01:00:00.000Z'),
        },
      ]),
    } as unknown as TradeStore;

    const manager = new RiskManager({
      maxRiskPerTrade: 0.01,
      maxDailyLoss: 0.05,
      maxDrawdownPct: 0.30,
      recoveryPct: 0.85,
      maxConsecutiveLosses: 3,
      cooldownMinutes: 30,
      maxSlippage: 0.05,
      minPoolLiquidity: 50_000,
      minTokenAgeHours: 24,
      maxHolderConcentration: 0.8,
    }, tradeStore, createFakeClock(FIXTURE_NOW));

    const portfolio = await manager.getPortfolioState(5);

    expect(portfolio.openTrades).toHaveLength(1);
    expect(portfolio.openTrades[0].strategy).toBe('volume_spike');
    expect(portfolio.dailyPnl).toBeCloseTo(0.2, 8);
    expect(portfolio.consecutiveLosses).toBe(0);
  });

  it('does not treat open-trade raw quantity as SOL equity in portfolio state', async () => {
    const tradeStore = {
      getOpenTrades: jest.fn().mockResolvedValue([
        {
          id: 'open-1',
          pairAddress: 'pair-1',
          strategy: 'volume_spike',
          side: 'BUY',
          entryPrice: 0.01,
          quantity: 3.2,
          status: 'OPEN',
          createdAt: new Date('2026-03-21T00:00:00.000Z'),
          stopLoss: 0.009,
          takeProfit1: 0.011,
          takeProfit2: 0.012,
          timeStopAt: new Date('2026-03-21T01:00:00.000Z'),
        },
      ]),
      getTodayPnl: jest.fn().mockResolvedValue(0),
      getRecentClosedTrades: jest.fn().mockResolvedValue([]),
      getClosedTradesChronological: jest.fn().mockResolvedValue([]),
    } as unknown as TradeStore;

    const manager = new RiskManager({
      maxRiskPerTrade: 0.01,
      maxDailyLoss: 0.05,
      maxDrawdownPct: 0.30,
      recoveryPct: 0.85,
      maxConsecutiveLosses: 3,
      cooldownMinutes: 30,
      maxSlippage: 0.05,
      minPoolLiquidity: 50_000,
      minTokenAgeHours: 24,
      maxHolderConcentration: 0.8,
    }, tradeStore, createFakeClock(FIXTURE_NOW));

    const portfolio = await manager.getPortfolioState(1.0);

    expect(portfolio.balanceSol).toBeCloseTo(1.0, 8);
    expect(portfolio.equitySol).toBeCloseTo(1.0, 8);
    expect(portfolio.drawdownGuard.peakBalanceSol).toBeCloseTo(1.0, 8);
  });

  it('updates equity and drawdown guard using marked-to-market open positions', () => {
    const manager = new RiskManager({
      maxRiskPerTrade: 0.01,
      maxDailyLoss: 0.05,
      maxDrawdownPct: 0.30,
      recoveryPct: 0.85,
      maxConsecutiveLosses: 3,
      cooldownMinutes: 30,
      maxSlippage: 0.05,
      minPoolLiquidity: 50_000,
      minTokenAgeHours: 24,
      maxHolderConcentration: 0.8,
    }, {} as unknown as TradeStore, createFakeClock(FIXTURE_NOW));

    const portfolio: PortfolioState = {
      balanceSol: 2,
      equitySol: 12,
      openTrades: [],
      dailyPnl: 0,
      consecutiveLosses: 0,
      drawdownGuard: {
        peakBalanceSol: 12,
        currentBalanceSol: 12,
        drawdownPct: 0,
        recoveryBalanceSol: 10.2,
        halted: false,
      },
      riskTier: {
        edgeState: 'Bootstrap',
        maxRiskPerTrade: 0.01,
        maxDailyLoss: 0.05,
        maxDrawdownPct: 0.30,
        recoveryPct: 0.85,
        kellyFraction: 0,
        kellyApplied: false,
        kellyMode: 'fixed',
      },
    };

    const adjusted = manager.applyUnrealizedDrawdown(portfolio, [
      { quantity: 5, currentPrice: 1.3 },
    ]);

    expect(adjusted.equitySol).toBeCloseTo(8.5, 6);
    expect(adjusted.drawdownGuard.drawdownPct).toBeCloseTo((12 - 8.5) / 12, 6);
    expect(adjusted.drawdownGuard.halted).toBe(false);

    const breached = manager.applyUnrealizedDrawdown(portfolio, [
      { quantity: 5, currentPrice: 1.0 },
    ]);
    expect(breached.equitySol).toBeCloseTo(7, 6);
    expect(breached.drawdownGuard.halted).toBe(true);
  });

  it('rejects orders for blacklisted pairs based on closed-trade history', async () => {
    const tradeStore = {
      getClosedTradesChronological: jest.fn().mockResolvedValue(
        Array.from({ length: 5 }, (_, index) => ({
          id: `t-${index}`,
          pairAddress: 'pair-weak',
          strategy: 'volume_spike',
          side: 'BUY',
          entryPrice: 10,
          exitPrice: 9.5,
          quantity: 0.1,
          pnl: -0.05,
          status: 'CLOSED',
          createdAt: new Date(`2026-03-15T00:0${index}:00.000Z`),
          closedAt: new Date(`2026-03-15T00:1${index}:00.000Z`),
          stopLoss: 9,
          takeProfit1: 11,
          takeProfit2: 12,
          timeStopAt: new Date(`2026-03-15T01:0${index}:00.000Z`),
        }))
      ),
    } as unknown as TradeStore;
    const manager = new RiskManager({
      maxRiskPerTrade: 0.01,
      maxDailyLoss: 0.05,
      maxDrawdownPct: 0.30,
      recoveryPct: 0.85,
      maxConsecutiveLosses: 3,
      cooldownMinutes: 30,
      maxSlippage: 0.05,
      minPoolLiquidity: 50_000,
      minTokenAgeHours: 24,
      maxHolderConcentration: 0.8,
    }, tradeStore, createFakeClock(FIXTURE_NOW));
    const portfolio: PortfolioState = {
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
      riskTier: {
        edgeState: 'Bootstrap',
        maxRiskPerTrade: 0.01,
        maxDailyLoss: 0.05,
        maxDrawdownPct: 0.30,
        recoveryPct: 0.85,
        kellyFraction: 0,
        kellyApplied: false,
        kellyMode: 'fixed',
      },
    };

    const result = await manager.checkOrder({
      pairAddress: 'pair-weak',
      strategy: 'volume_spike',
      side: 'BUY',
      price: 10,
      stopLoss: 9,
    }, portfolio);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Pair blacklisted by edge tracker');
  });

  it('does not blacklist a pair when only corrupted closed trades exist', async () => {
    const tradeStore = {
      getClosedTradesChronological: jest.fn().mockResolvedValue(
        Array.from({ length: 5 }, (_, index) => ({
          id: `bad-${index}`,
          pairAddress: 'pair-corrupted',
          strategy: 'volume_spike',
          side: 'BUY',
          entryPrice: 10,
          exitPrice: 0,
          quantity: 0.1,
          pnl: -0.05,
          status: 'CLOSED',
          createdAt: new Date(`2026-03-15T00:0${index}:00.000Z`),
          closedAt: new Date(`2026-03-15T00:1${index}:00.000Z`),
          stopLoss: 0,
          takeProfit1: 11,
          takeProfit2: 12,
          timeStopAt: new Date(`2026-03-15T01:0${index}:00.000Z`),
        }))
      ),
    } as unknown as TradeStore;
    const manager = new RiskManager({
      maxRiskPerTrade: 0.01,
      maxDailyLoss: 0.05,
      maxDrawdownPct: 0.30,
      recoveryPct: 0.85,
      maxConsecutiveLosses: 3,
      cooldownMinutes: 30,
      maxSlippage: 0.05,
      minPoolLiquidity: 50_000,
      minTokenAgeHours: 24,
      maxHolderConcentration: 0.8,
    }, tradeStore, createFakeClock(FIXTURE_NOW));
    const portfolio: PortfolioState = {
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
      riskTier: {
        edgeState: 'Bootstrap',
        maxRiskPerTrade: 0.01,
        maxDailyLoss: 0.05,
        maxDrawdownPct: 0.30,
        recoveryPct: 0.85,
        kellyFraction: 0,
        kellyApplied: false,
        kellyMode: 'fixed',
      },
    };

    const result = await manager.checkOrder({
      pairAddress: 'pair-corrupted',
      strategy: 'volume_spike',
      side: 'BUY',
      price: 10,
      stopLoss: 9,
    }, portfolio);

    expect(result.approved).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  // Phase B2 — BOT_BYPASS_EDGE_BLACKLIST canary backdoor 동작 검증.
  // Why: 오염된 ledger 위에 학습된 blacklist가 canary 기간 동안만 해제되어야 하며,
  // bypass 사건은 반드시 audit log(appliedAdjustments)에 남아야 한다.
  describe('Phase B2 — bypass edge blacklist canary flag', () => {
    const blacklistedTrades = Array.from({ length: 5 }, (_, index) => ({
      id: `blk-${index}`,
      pairAddress: 'pair-weak',
      strategy: 'volume_spike',
      side: 'BUY',
      entryPrice: 10,
      exitPrice: 9.5,
      quantity: 0.1,
      pnl: -0.05,
      status: 'CLOSED',
      createdAt: new Date(`2026-03-15T00:0${index}:00.000Z`),
      closedAt: new Date(`2026-03-15T00:1${index}:00.000Z`),
      stopLoss: 9,
      takeProfit1: 11,
      takeProfit2: 12,
      timeStopAt: new Date(`2026-03-15T01:0${index}:00.000Z`),
    }));

    function buildManager(): RiskManager {
      const tradeStore = {
        getClosedTradesChronological: jest.fn().mockResolvedValue(blacklistedTrades),
      } as unknown as TradeStore;
      return new RiskManager({
        maxRiskPerTrade: 0.01,
        maxDailyLoss: 0.05,
        maxDrawdownPct: 0.30,
        recoveryPct: 0.85,
        maxConsecutiveLosses: 3,
        cooldownMinutes: 30,
        maxSlippage: 0.05,
        minPoolLiquidity: 50_000,
        minTokenAgeHours: 24,
        maxHolderConcentration: 0.8,
      }, tradeStore, createFakeClock(FIXTURE_NOW));
    }

    const portfolio: PortfolioState = {
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
      riskTier: {
        edgeState: 'Bootstrap',
        maxRiskPerTrade: 0.01,
        maxDailyLoss: 0.05,
        maxDrawdownPct: 0.30,
        recoveryPct: 0.85,
        kellyFraction: 0,
        kellyApplied: false,
        kellyMode: 'fixed',
      },
    };

    const order = {
      pairAddress: 'pair-weak',
      strategy: 'volume_spike' as const,
      side: 'BUY' as const,
      price: 10,
      stopLoss: 9,
    };

    let originalBypass: boolean;

    beforeEach(() => {
      originalBypass = config.bypassEdgeBlacklist;
    });

    afterEach(() => {
      // Why: 전역 config 오염 방지 — 다른 suite는 기본값을 전제로 한다.
      (config as { bypassEdgeBlacklist: boolean }).bypassEdgeBlacklist = originalBypass;
    });

    it('blocks blacklisted pair by default (bypass=false)', async () => {
      (config as { bypassEdgeBlacklist: boolean }).bypassEdgeBlacklist = false;
      const manager = buildManager();

      const result = await manager.checkOrder(order, portfolio);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Pair blacklisted by edge tracker');
      expect(result.appliedAdjustments ?? []).not.toContain('BYPASSED_EDGE_BLACKLIST');
    });

    it('allows blacklisted pair and records audit tag when bypass=true', async () => {
      (config as { bypassEdgeBlacklist: boolean }).bypassEdgeBlacklist = true;
      const manager = buildManager();

      const result = await manager.checkOrder(order, portfolio);

      expect(result.approved).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.appliedAdjustments ?? []).toContain('BYPASSED_EDGE_BLACKLIST');
    });
  });

  // 2026-04-29 (Option D): RISK_MAX_DAILY_LOSS_OVERRIDE — runtime tier override.
  // Why: -0.0943 SOL halt 사례. floor 0.7 + canary cap 0.2 가 catastrophic 방어 cover.
  describe('Daily loss limit env override (Option D)', () => {
    let originalOverride: number | null;

    beforeEach(() => {
      originalOverride = config.riskMaxDailyLossOverride;
    });

    afterEach(() => {
      (config as { riskMaxDailyLossOverride: number | null }).riskMaxDailyLossOverride = originalOverride;
    });

    function buildManager(): RiskManager {
      return new RiskManager({
        maxRiskPerTrade: 0.01,
        maxDailyLoss: 0.05,
        maxDrawdownPct: 0.30,
        recoveryPct: 0.85,
        maxConsecutiveLosses: 3,
        cooldownMinutes: 30,
        maxSlippage: 0.05,
        minPoolLiquidity: 50_000,
        minTokenAgeHours: 24,
        maxHolderConcentration: 0.8,
      }, {} as unknown as TradeStore, createFakeClock(FIXTURE_NOW));
    }

    function buildPortfolio(dailyPnlSol: number, equitySol: number, drawdownHalted = false): PortfolioState {
      return {
        balanceSol: equitySol,
        equitySol,
        dailyPnl: dailyPnlSol,
        consecutiveLosses: 0,
        openTrades: [],
        drawdownGuard: {
          halted: drawdownHalted,
          peakBalanceSol: drawdownHalted ? equitySol / 0.6 : equitySol,
          drawdownPct: drawdownHalted ? 0.4 : 0,
          resumeBalanceSol: drawdownHalted ? equitySol * 1.2 : undefined,
        } as unknown as PortfolioState['drawdownGuard'],
        riskTier: {
          edgeState: 'Calibration',
          maxRiskPerTrade: 0.01,
          maxDailyLoss: 0.05,
          maxDrawdownPct: 0.30,
          recoveryPct: 0.85,
          kellyFraction: 0,
          kellyApplied: false,
          kellyMode: 'fixed',
        },
      } as unknown as PortfolioState;
    }

    it('override null (default) → tier 정책 그대로 (Calibration 5% trip)', () => {
      (config as { riskMaxDailyLossOverride: number | null }).riskMaxDailyLossOverride = null;
      const manager = buildManager();
      // equity 1 SOL × 5% = 0.05 SOL → -0.06 trip
      const halt = manager.getActiveHalt(buildPortfolio(-0.06, 1.0));
      expect(halt?.kind).toBe('dailyLoss');
    });

    it('daily loss remains the hard halt when drawdown guard is also active', () => {
      (config as { riskMaxDailyLossOverride: number | null }).riskMaxDailyLossOverride = null;
      const manager = buildManager();
      const halt = manager.getActiveHalt(buildPortfolio(-0.06, 1.0, true));
      expect(halt?.kind).toBe('dailyLoss');
      expect(halt?.reason).toContain('Daily loss limit reached');
    });

    it('override 0.30 (30%) → -0.06 SOL 통과 (mission §3 측정 sprint)', () => {
      (config as { riskMaxDailyLossOverride: number | null }).riskMaxDailyLossOverride = 0.30;
      const manager = buildManager();
      const halt = manager.getActiveHalt(buildPortfolio(-0.06, 1.0));
      expect(halt).toBeUndefined();
    });

    it('override 0 → daily loss limit disable, wallet floor / canary cap 만 보호', () => {
      (config as { riskMaxDailyLossOverride: number | null }).riskMaxDailyLossOverride = 0;
      const manager = buildManager();
      const halt = manager.getActiveHalt(buildPortfolio(-0.50, 1.0));
      expect(halt).toBeUndefined();
    });
  });
});
