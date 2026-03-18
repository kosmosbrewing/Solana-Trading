import { EdgeTracker } from '../src/reporting/edgeTracker';
import { replayPortfolioDrawdownGuard, resolveRiskTierProfile } from '../src/risk';
import { StrategyName } from '../src/utils/types';

describe('RiskTier', () => {
  it('switches tiers at the expected trade-count boundaries', () => {
    const nineteen = resolveProfile(makeTrades(19));
    const twenty = resolveProfile(makeTrades(20));
    const fifty = resolveProfile(makeTrades(50));
    const hundred = resolveProfile(makeTrades(100));

    expect(nineteen.edgeState).toBe('Bootstrap');
    expect(nineteen.maxRiskPerTrade).toBeCloseTo(0.01, 6);

    expect(twenty.edgeState).toBe('Calibration');
    expect(twenty.maxRiskPerTrade).toBeCloseTo(0.01, 6); // STRATEGY.md: Bootstrap/Calibration 모두 1%

    expect(fifty.edgeState).toBe('Confirmed');
    expect(fifty.kellyApplied).toBe(true);
    expect(fifty.maxRiskPerTrade).toBeCloseTo(0.03, 6); // v2: kellyCap 3%

    expect(hundred.edgeState).toBe('Proven');
    expect(hundred.kellyApplied).toBe(true);
    expect(hundred.maxRiskPerTrade).toBeCloseTo(0.05, 6); // v2: kellyCap 5%
  });

  it('keeps fixed-percent sizing when Kelly is still locked', () => {
    const locked = resolveProfile(
      makeTrades(55, 'fib_pullback', index => (index < 20 ? 0.5 : -1))
    );

    expect(locked.edgeState).toBe('Calibration');
    expect(locked.kellyApplied).toBe(false);
    expect(locked.maxRiskPerTrade).toBeCloseTo(0.01, 6); // Calibration = 1% 고정
  });

  it('uses the looser Confirmed drawdown limit once the 50th trade closes', () => {
    const trades = [
      ...Array.from({ length: 49 }, (_, index) => makeTrade(index % 5 < 3 ? 7 : -1)),
      makeTrade(-70),
    ];
    const guard = replayPortfolioDrawdownGuard(139, trades, 0.85);

    expect(guard.drawdownPct).toBeGreaterThan(0.33);
    expect(guard.halted).toBe(false);
  });
});

function resolveProfile(
  trades: ReturnType<typeof makeTrades>
) {
  const stats = new EdgeTracker(trades).getPortfolioStats();
  return resolveRiskTierProfile(stats, 0.85);
}

function makeTrades(
  count: number,
  strategy: StrategyName = 'volume_spike',
  pnlForIndex: (index: number) => number = index => (index % 5 === 0 ? -1 : 2)
) {
  return Array.from({ length: count }, (_, index) => makeTrade(pnlForIndex(index), strategy));
}

function makeTrade(pnl: number, strategy: StrategyName = 'volume_spike') {
  return {
    pairAddress: `${strategy}-pair`,
    strategy,
    entryPrice: 10,
    stopLoss: 9,
    quantity: 1,
    pnl,
  };
}
