import { EdgeTracker } from '../src/reporting/edgeTracker';
import { replayPortfolioDrawdownGuard, resolveRiskTierProfile } from '../src/risk';
import { StrategyName } from '../src/utils/types';

describe('RiskTier', () => {
  it('switches tiers at the expected trade-count boundaries', () => {
    const nineteen = resolveProfile(makeTrades(19));
    const twenty = resolveProfile(makeTrades(20));
    // v4: trade 50은 보간 구간(40~60)이므로 60으로 테스트
    const sixty = resolveProfile(makeTrades(60));
    // v4: trade 100은 보간 구간 종료(≥115)이므로 115로 테스트
    const oneOneFive = resolveProfile(makeTrades(115));

    expect(nineteen.edgeState).toBe('Bootstrap');
    expect(nineteen.maxRiskPerTrade).toBeCloseTo(0.01, 6);

    expect(twenty.edgeState).toBe('Calibration');
    expect(twenty.maxRiskPerTrade).toBeCloseTo(0.01, 6);

    expect(sixty.edgeState).toBe('Confirmed');
    expect(sixty.kellyApplied).toBe(true);
    expect(sixty.maxRiskPerTrade).toBeCloseTo(0.03, 6); // v2: kellyCap 3% (보간 완료)

    expect(oneOneFive.edgeState).toBe('Proven');
    expect(oneOneFive.kellyApplied).toBe(true);
    expect(oneOneFive.maxRiskPerTrade).toBeCloseTo(0.05, 6); // v2: kellyCap 5% (보간 완료)
  });

  it('keeps fixed-percent sizing when Kelly is still locked', () => {
    const locked = resolveProfile(
      makeTrades(55, 'fib_pullback', index => (index < 20 ? 0.5 : -1))
    );

    expect(locked.edgeState).toBe('Calibration');
    expect(locked.kellyApplied).toBe(false);
    expect(locked.maxRiskPerTrade).toBeCloseTo(0.01, 6); // Calibration = 1% 고정
  });

  // 2026-04-29 (Option A): Calibration tier maxDailyLoss 0.05 → 0.15.
  // Why: floor 0.7 + canary cap 0.2 가 catastrophic 방어 cover. mission §3 측정 단계
  //   에서 5% % equity 가 misalignment (-0.0943 SOL 에서 halt 사례).
  it('Calibration tier maxDailyLoss = 0.15 (Confirmed/Proven 와 정합)', () => {
    const calibration = resolveProfile(makeTrades(20));
    expect(calibration.edgeState).toBe('Calibration');
    expect(calibration.maxDailyLoss).toBeCloseTo(0.15, 6);
  });

  it('v4: interpolates risk at Confirmed entry (trade 50, interpolation mid-zone)', () => {
    const profile = resolveProfile(makeTrades(50));
    expect(profile.edgeState).toBe('Confirmed');
    expect(profile.kellyApplied).toBe(true);
    // trade 50: progress = (50-40)/20 = 0.5 → lerp(0.01, 0.03, 0.5) = 0.02
    expect(profile.maxRiskPerTrade).toBeGreaterThan(0.01);
    expect(profile.maxRiskPerTrade).toBeLessThan(0.03);
  });

  it('v4: full Confirmed Kelly at trade 60 (interpolation done)', () => {
    const profile = resolveProfile(makeTrades(60));
    expect(profile.edgeState).toBe('Confirmed');
    expect(profile.maxRiskPerTrade).toBeCloseTo(0.03, 6);
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
