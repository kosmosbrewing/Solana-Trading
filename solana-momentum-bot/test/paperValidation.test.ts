import { buildPaperValidationReport } from '../src/reporting/paperValidation';

describe('paperValidation', () => {
  it('computes SOL-27 readiness and observed gate filters', () => {
    const report = buildPaperValidationReport(
      [
        {
          strategy: 'volume_spike',
          pairAddress: 'PAIR',
          entryPrice: 10,
          stopLoss: 9,
          quantity: 1,
          pnl: 2,
          exitReason: 'TAKE_PROFIT_2',
          closedAt: new Date('2026-03-15T00:00:00Z'),
        },
        {
          strategy: 'volume_spike',
          pairAddress: 'PAIR',
          entryPrice: 12,
          stopLoss: 11,
          quantity: 1,
          pnl: -1,
          exitReason: 'STOP_LOSS',
          closedAt: new Date('2026-03-15T01:00:00Z'),
        },
        {
          strategy: 'fib_pullback',
          pairAddress: 'PAIR',
          entryPrice: 20,
          stopLoss: 19,
          quantity: 1,
          pnl: 3,
          exitReason: 'TAKE_PROFIT_2',
          closedAt: new Date('2026-03-15T02:00:00Z'),
        },
      ],
      [
        { strategy: 'volume_spike', action: 'EXECUTED' },
        { strategy: 'volume_spike', action: 'FILTERED', filterReason: 'not_trending' },
        { strategy: 'fib_pullback', action: 'FILTERED', filterReason: 'Drawdown guard active: 31.00% below HWM 12.0000 SOL; resume at 10.2000 SOL' },
      ],
      {
        initialBalance: 10,
        minTrades: 3,
        minWinRate: 0.4,
        minRewardRisk: 2,
        maxDrawdownPct: 0.3,
        recoveryPct: 0.85,
      }
    );

    expect(report.totalTrades).toBe(3);
    expect(report.winRate).toBeCloseTo(2 / 3, 6);
    expect(report.rewardRisk).toBeCloseTo(2.5, 6);
    expect(report.criteria.phase2Ready).toBe(true);
    expect(report.criteria.attentionGateObserved).toBe(true);
    expect(report.criteria.drawdownGuardObserved).toBe(true);
  });

  it('fails readiness when trade count and reward-risk are insufficient', () => {
    const report = buildPaperValidationReport(
      [
        {
          strategy: 'fib_pullback',
          pairAddress: 'PAIR',
          entryPrice: 10,
          stopLoss: 9,
          quantity: 1,
          pnl: 0.5,
          exitReason: 'TIME_STOP',
          closedAt: new Date('2026-03-15T00:00:00Z'),
        },
        {
          strategy: 'fib_pullback',
          pairAddress: 'PAIR',
          entryPrice: 11,
          stopLoss: 10,
          quantity: 1,
          pnl: -1,
          exitReason: 'STOP_LOSS',
          closedAt: new Date('2026-03-15T01:00:00Z'),
        },
      ],
      [],
      {
        minTrades: 3,
        minWinRate: 0.4,
        minRewardRisk: 2,
      }
    );

    expect(report.criteria.minTradesMet).toBe(false);
    expect(report.criteria.rewardRiskMet).toBe(false);
    expect(report.criteria.phase2Ready).toBe(false);
  });
});
