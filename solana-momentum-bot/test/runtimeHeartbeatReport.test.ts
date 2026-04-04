import {
  computePaperCashBalance,
  parseLatestRegimeState,
  summarizeClosedTrades,
} from '../src/ops/runtimeHeartbeatReport';
import { Trade } from '../src/utils/types';

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'trade-1',
    pairAddress: 'PAIR-1',
    strategy: 'volume_spike',
    side: 'BUY',
    entryPrice: 1,
    quantity: 1,
    stopLoss: 0.9,
    takeProfit1: 1.1,
    takeProfit2: 1.2,
    timeStopAt: new Date('2026-04-04T00:10:00.000Z'),
    status: 'CLOSED',
    createdAt: new Date('2026-04-04T00:00:00.000Z'),
    closedAt: new Date('2026-04-04T00:05:00.000Z'),
    pnl: 0.1,
    ...overrides,
  };
}

describe('runtimeHeartbeatReport helpers', () => {
  it('reconstructs paper cash balance from open and closed trades', () => {
    const balance = computePaperCashBalance(
      1,
      [makeTrade({ id: 'open-1', status: 'OPEN', entryPrice: 0.2, quantity: 2, pnl: undefined, closedAt: undefined })],
      [makeTrade({ id: 'closed-1', pnl: 0.15 })]
    );

    expect(balance).toBeCloseTo(0.75, 8);
  });

  it('extracts the latest regime state from bot logs', () => {
    const state = parseLatestRegimeState([
      '2026-04-04 12:00:00 INFO [Main] Regime: neutral (size=0.7x) SOL=bull breadth=40% follow=30%',
      '2026-04-04 14:00:00 INFO [Main] Regime: risk_on (size=1x) SOL=bear breadth=50% follow=50%',
    ].join('\n'));

    expect(state).toMatchObject({
      regime: 'risk_on',
      sizeMultiplier: 1,
      solTrendBullish: false,
      breadthPct: 0.5,
      followThroughPct: 0.5,
    });
  });

  it('summarizes closed trades into heartbeat performance metrics', () => {
    const summary = summarizeClosedTrades([
      makeTrade({ id: 'win-1', pnl: 0.2, exitReason: 'TAKE_PROFIT_1' }),
      makeTrade({ id: 'loss-1', pnl: -0.1, exitReason: 'STOP_LOSS' }),
    ]);

    expect(summary.totalTrades).toBe(2);
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(1);
    expect(summary.falsePositiveRate).toBeCloseTo(0.5, 8);
    expect(summary.tp1HitRate).toBeCloseTo(0.5, 8);
  });
});
