import { EdgeTracker } from '../src/reporting/edgeTracker';

describe('EdgeTracker', () => {
  it('computes strategy edge metrics and unlocks Kelly at Confirmed state', () => {
    const tracker = new EdgeTracker([
      ...Array.from({ length: 30 }, (_, index) => ({
        pairAddress: 'pair-volume-a',
        strategy: 'volume_spike' as const,
        entryPrice: 10,
        stopLoss: 9,
        quantity: 1,
        pnl: index % 5 < 3 ? 2 : -1,
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        pairAddress: 'pair-fib-a',
        strategy: 'fib_pullback' as const,
        entryPrice: 20,
        stopLoss: 19,
        quantity: 1,
        pnl: index < 4 ? 1.5 : -1,
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        pairAddress: 'pair-volume-b',
        strategy: 'volume_spike' as const,
        entryPrice: 12,
        stopLoss: 11,
        quantity: 1,
        pnl: index % 5 < 3 ? 1.5 : -1,
      })),
    ]);

    const volumeSpike = tracker.getStrategyStats('volume_spike');
    const fibPullback = tracker.getStrategyStats('fib_pullback');

    expect(volumeSpike.totalTrades).toBe(50);
    expect(volumeSpike.edgeState).toBe('Confirmed');
    expect(volumeSpike.winRate).toBeCloseTo(0.6, 6);
    expect(volumeSpike.rewardRisk).toBeCloseTo(1.8, 6);
    expect(volumeSpike.kellyEligible).toBe(true);
    expect(volumeSpike.kellyFraction).toBeGreaterThan(0);

    expect(fibPullback.totalTrades).toBe(10);
    expect(fibPullback.edgeState).toBe('Bootstrap');
    expect(fibPullback.kellyEligible).toBe(false);
    expect(fibPullback.maxConsecutiveLosses).toBe(6);
  });

  it('keeps Kelly locked when expectancy is negative', () => {
    const tracker = new EdgeTracker(
      Array.from({ length: 55 }, (_, index) => ({
        pairAddress: 'pair-fib-b',
        strategy: 'fib_pullback' as const,
        entryPrice: 10,
        stopLoss: 9,
        quantity: 1,
        pnl: index < 20 ? 0.5 : -1,
      }))
    );

    const stats = tracker.getStrategyStats('fib_pullback');

    expect(stats.edgeState).toBe('Calibration');
    expect(stats.rewardRisk).toBeCloseTo(0.5, 6);
    expect(stats.kellyFraction).toBe(0);
    expect(stats.kellyEligible).toBe(false);
  });

  it('blocks promotion when quality gates fail despite enough trades', () => {
    const tracker = new EdgeTracker(
      Array.from({ length: 100 }, (_, index) => ({
        pairAddress: 'pair-volume-c',
        strategy: 'volume_spike' as const,
        entryPrice: 10,
        stopLoss: 9,
        quantity: 1,
        pnl: index < 55 ? 1.5 : -1,
      }))
    );

    const stats = tracker.getStrategyStats('volume_spike');

    expect(stats.totalTrades).toBe(100);
    expect(stats.winRate).toBeCloseTo(0.55, 6);
    expect(stats.rewardRisk).toBeCloseTo(1.5, 6);
    expect(stats.edgeState).toBe('Calibration');
    expect(stats.kellyEligible).toBe(false);
  });

  it('tracks pair-level stats and blacklists persistently weak pairs', () => {
    const tracker = new EdgeTracker([
      ...Array.from({ length: 5 }, () => ({
        pairAddress: 'pair-weak',
        strategy: 'volume_spike' as const,
        entryPrice: 10,
        stopLoss: 9,
        quantity: 0.1,
        pnl: -0.05,
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        pairAddress: 'pair-healthy',
        strategy: 'fib_pullback' as const,
        entryPrice: 10,
        stopLoss: 9,
        quantity: 0.1,
        pnl: index < 3 ? 0.1 : -0.04,
      })),
    ]);

    const weakStats = tracker.getPairStats('pair-weak');
    const healthyStats = tracker.getPairStats('pair-healthy');
    const blacklistedPairs = tracker.getBlacklistedPairs();

    expect(weakStats.totalTrades).toBe(5);
    expect(weakStats.maxConsecutiveLosses).toBe(5);
    expect(healthyStats.winRate).toBeCloseTo(0.6, 6);
    expect(tracker.isPairBlacklisted('pair-weak')).toBe(true);
    expect(tracker.isPairBlacklisted('pair-healthy')).toBe(false);
    expect(blacklistedPairs.map(stat => stat.pairAddress)).toEqual(['pair-weak']);
  });

  it('re-enables a blacklisted pair when recent trades improve (decay window)', () => {
    // 초기 5개 트레이드: 전부 손실 → 블랙리스트 진입
    const earlyLosses = Array.from({ length: 5 }, () => ({
      pairAddress: 'pair-recoverable',
      strategy: 'volume_spike' as const,
      entryPrice: 10,
      stopLoss: 9,
      quantity: 1,
      pnl: -1,
    }));

    // 이후 10개 트레이드: 7승 3패 (WR 70%, RR > 1.0) → 개선
    const recentWins = Array.from({ length: 10 }, (_, index) => ({
      pairAddress: 'pair-recoverable',
      strategy: 'volume_spike' as const,
      entryPrice: 10,
      stopLoss: 9,
      quantity: 1,
      pnl: index < 7 ? 2 : -1,
    }));

    const tracker = new EdgeTracker([...earlyLosses, ...recentWins]);

    // decayWindowTrades=0 → 전체 히스토리 → 여전히 블랙리스트
    expect(tracker.isPairBlacklisted('pair-recoverable', { decayWindowTrades: 0 })).toBe(true);

    // decayWindowTrades=10 (기본값) → 최근 10개만 평가 → 재활성화
    expect(tracker.isPairBlacklisted('pair-recoverable')).toBe(false);

    // getBlacklistedPairs도 동일하게 decay 반영
    expect(tracker.getBlacklistedPairs().map(s => s.pairAddress)).not.toContain('pair-recoverable');
    expect(tracker.getBlacklistedPairs({ decayWindowTrades: 0 }).map(s => s.pairAddress)).toContain('pair-recoverable');
  });

  it('getMainPortfolioStats excludes sandbox strategies', () => {
    const tracker = new EdgeTracker([
      // 30 main lane trades (volume_spike): 60% WR
      ...Array.from({ length: 30 }, (_, i) => ({
        pairAddress: 'pair-main',
        strategy: 'volume_spike' as const,
        entryPrice: 10,
        stopLoss: 9,
        quantity: 1,
        pnl: i % 5 < 3 ? 2 : -1,
      })),
      // 10 sandbox trades (new_lp_sniper): 100% loss
      ...Array.from({ length: 10 }, () => ({
        pairAddress: 'pair-sandbox',
        strategy: 'new_lp_sniper' as const,
        entryPrice: 10,
        stopLoss: 9,
        quantity: 1,
        pnl: -1,
      })),
    ]);

    // getPortfolioStats includes all 40 trades
    const allStats = tracker.getPortfolioStats();
    expect(allStats.totalTrades).toBe(40);

    // getMainPortfolioStats excludes sandbox → only 30 trades
    const mainStats = tracker.getMainPortfolioStats();
    expect(mainStats.totalTrades).toBe(30);
    expect(mainStats.winRate).toBeCloseTo(0.6, 6);

    // sandbox strategy stats still accessible individually
    const sandboxStats = tracker.getStrategyStats('new_lp_sniper');
    expect(sandboxStats.totalTrades).toBe(10);
    expect(sandboxStats.winRate).toBe(0);
  });

  it('stays blacklisted when recent window is still bad', () => {
    // 15개 전부 손실 → 최근 10개도 전부 손실
    const tracker = new EdgeTracker(
      Array.from({ length: 15 }, () => ({
        pairAddress: 'pair-stuck',
        strategy: 'volume_spike' as const,
        entryPrice: 10,
        stopLoss: 9,
        quantity: 1,
        pnl: -1,
      }))
    );

    expect(tracker.isPairBlacklisted('pair-stuck')).toBe(true);
    expect(tracker.isPairBlacklisted('pair-stuck', { decayWindowTrades: 10 })).toBe(true);
    expect(tracker.isPairBlacklisted('pair-stuck', { decayWindowTrades: 0 })).toBe(true);
  });
});
