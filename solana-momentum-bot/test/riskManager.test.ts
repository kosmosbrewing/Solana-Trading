import { TradeStore } from '../src/candle/tradeStore';
import { RiskManager } from '../src/risk';
import type { PortfolioState } from '../src/utils/types';

describe('RiskManager unrealized drawdown', () => {
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
    }, {} as unknown as TradeStore);

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
    }, tradeStore);
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
});
