import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { RuntimeDiagnosticsStore, RuntimeDiagnosticsTracker } from '../src/reporting';

describe('RuntimeDiagnosticsTracker', () => {
  it('summarizes unique-token readiness and rejection counts', () => {
    const tracker = new RuntimeDiagnosticsTracker();
    tracker.recordPreWatchlistReject({
      tokenMint: 'token-a',
      reason: 'unsupported_dex',
      source: 'dex_boost',
      dexId: 'meteora',
    });
    tracker.recordPreWatchlistReject({
      tokenMint: 'token-a',
      reason: 'unsupported_dex',
      source: 'dex_boost',
      dexId: 'meteora',
    });
    tracker.recordRealtimeCandidateSeen({ tokenMint: 'token-b', source: 'gecko_trending' });
    tracker.recordAdmissionSkip({
      tokenMint: 'token-b',
      reason: 'no_pairs',
      detail: 'all_pairs_blocked',
      source: 'gecko_trending',
      dexId: 'raydium',
    });
    tracker.recordRealtimeCandidateSeen({ tokenMint: 'token-c', source: 'dex_boost' });
    tracker.recordCapacity({
      source: 'helius_pool_discovery',
      reason: 'queue_overflow',
      detail: 'limit=250 inFlight=2 queued=250',
    });

    const summary = tracker.buildSummary(24);

    expect(summary.realtimeCandidateReadiness).toEqual({
      totalCandidates: 3,
      prefiltered: 1,
      admissionSkipped: 1,
      ready: 1,
      readinessRate: 1 / 3,
    });
    expect(summary.preWatchlistRejectCounts).toEqual([{ reason: 'unsupported_dex', count: 1 }]);
    expect(summary.admissionSkipCounts).toEqual([{ reason: 'no_pairs', count: 1 }]);
    expect(summary.admissionSkipDetailCounts).toEqual([
      { label: 'no_pairs detail=all_pairs_blocked source=gecko_trending dex=raydium', count: 1 },
    ]);
    expect(summary.capacityCounts).toEqual([
      { label: 'helius_pool_discovery reason=queue_overflow detail=limit=250 inFlight=2 queued=250', count: 1 },
    ]);
  });

  it('persists events across restarts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'runtime-diag-'));
    const store = new RuntimeDiagnosticsStore(path.join(tempDir, 'runtime-diagnostics.json'));

    try {
      const tracker = new RuntimeDiagnosticsTracker(store);
      tracker.recordRealtimeCandidateSeen({ tokenMint: 'token-live', source: 'dex_boost' });
      tracker.recordAdmissionSkip({
        tokenMint: 'token-live',
        reason: 'no_pairs',
        detail: 'resolver_miss',
        source: 'dex_boost',
        dexId: 'raydium',
      });
      tracker.recordRateLimit('gecko_ingester');
      tracker.recordCapacity({
        source: 'helius_pool_discovery',
        reason: 'queue_overflow',
        detail: 'limit=250 inFlight=1 queued=249',
      });
      await tracker.flush();

      const loaded = await store.load();
      const restored = new RuntimeDiagnosticsTracker(store, loaded.events, loaded.capSuppress);
      const summary = restored.buildSummary(24);

      expect(summary.realtimeCandidateReadiness.totalCandidates).toBe(1);
      expect(summary.realtimeCandidateReadiness.admissionSkipped).toBe(1);
      expect(summary.rateLimitCounts).toEqual([{ source: 'gecko_ingester', count: 1 }]);
      expect(summary.capacityCounts).toEqual([
        { label: 'helius_pool_discovery reason=queue_overflow detail=limit=250 inFlight=1 queued=249', count: 1 },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('records trigger_stats and includes them in summary', () => {
    const tracker = new RuntimeDiagnosticsTracker();
    tracker.recordTriggerStats(
      'evals=100 signals=2(boosted=1) insuffCandles=30 volInsuf=50 noBreakout=10 confirmFail=5 cooldown=3',
      'bootstrap_trigger'
    );
    tracker.recordTriggerStats('evals=200 signals=5 insuffCandles=60 volInsuf=100 noBreakout=20 confirmFail=10 cooldown=5');

    const summary = tracker.buildSummary(24);

    expect(summary.triggerStatsCounts).toHaveLength(2);
    expect(summary.triggerStatsCounts[0].count).toBe(1);
    expect(summary.triggerStatsCounts[0].label).toContain('bootstrap_trigger');
    expect(summary.triggerStatsCounts[0].label).toContain('evals=');
    expect(summary.bootstrapBoostedSignalCount).toBe(1);
  });

  it('prunes trigger_stats events beyond 500 limit', () => {
    const tracker = new RuntimeDiagnosticsTracker();
    for (let i = 0; i < 600; i++) {
      tracker.recordTriggerStats(`evals=${i}`);
    }

    const summary = tracker.buildSummary(24);
    const totalTriggerEvents = summary.triggerStatsCounts.reduce((sum, item) => sum + item.count, 0);
    expect(totalTriggerEvents).toBeLessThanOrEqual(500);
  });

  it('summarizes watchlist lifecycle and missed tokens', () => {
    const tracker = new RuntimeDiagnosticsTracker();

    tracker.recordCandidateEvicted('token-a');
    tracker.recordCandidateReadded('token-a', 'within_grace');
    tracker.recordSignalNotInWatchlist('token-a', 'recently_evicted');
    tracker.recordSignalNotInWatchlist('token-a');

    tracker.recordCandidateEvicted('token-b');
    tracker.recordSignalNotInWatchlist('token-b');
    tracker.recordSignalNotInWatchlist('token-b');

    tracker.recordSignalNotInWatchlist('token-c');

    for (let i = 0; i < 3; i++) {
      tracker.recordSignalNotInWatchlist(`token-extra-${i}`);
    }

    const summary = tracker.buildSummary(24);

    expect(summary.candidateEvictedCount).toBe(2);
    expect(summary.candidateReaddedWithinGraceCount).toBe(1);
    expect(summary.signalNotInWatchlistCount).toBe(8);
    expect(summary.signalNotInWatchlistRecentlyEvictedCount).toBe(1);
    expect(summary.missedTokens).toEqual([
      { tokenMint: 'token-a', evicted: 1, readded: 1, notInWatchlist: 2, recentlyEvicted: 1, admissionBlocked: 0 },
      { tokenMint: 'token-b', evicted: 1, readded: 0, notInWatchlist: 2, recentlyEvicted: 0, admissionBlocked: 0 },
      { tokenMint: 'token-c', evicted: 0, readded: 0, notInWatchlist: 1, recentlyEvicted: 0, admissionBlocked: 0 },
      { tokenMint: 'token-extra-0', evicted: 0, readded: 0, notInWatchlist: 1, recentlyEvicted: 0, admissionBlocked: 0 },
      { tokenMint: 'token-extra-1', evicted: 0, readded: 0, notInWatchlist: 1, recentlyEvicted: 0, admissionBlocked: 0 },
    ]);
  });

  it('records cap_suppressed with accurate pair and candle counts', () => {
    const tracker = new RuntimeDiagnosticsTracker();
    tracker.recordCapSuppressed('pair-a');
    tracker.recordCapSuppressed('pair-a');
    tracker.recordCapSuppressed('pair-b');
    tracker.recordCapSuppressed('pair-a');
    tracker.recordCapSuppressed('pair-b');

    const todayUtcOps = tracker.buildTodayUtcOperationalSummary();
    expect(todayUtcOps.capSuppressedPairs).toBe(2);
    expect(todayUtcOps.capSuppressedCandles).toBe(5);
  });

  it('cap_suppressed is not affected by event prune', () => {
    const tracker = new RuntimeDiagnosticsTracker();
    for (let i = 0; i < 10_000; i++) {
      tracker.recordCapSuppressed('pair-heavy');
    }

    const todayUtcOps = tracker.buildTodayUtcOperationalSummary();
    expect(todayUtcOps.capSuppressedCandles).toBe(10_000);
    expect(todayUtcOps.capSuppressedPairs).toBe(1);
  });

  it('cap_suppressed persists across restart within same UTC day', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cap-suppress-'));
    const store = new RuntimeDiagnosticsStore(path.join(tempDir, 'diag.json'));

    try {
      const tracker1 = new RuntimeDiagnosticsTracker(store);
      tracker1.recordCapSuppressed('pair-a');
      tracker1.recordCapSuppressed('pair-a');
      tracker1.recordCapSuppressed('pair-b');
      await tracker1.flush();

      // simulate restart: load from store
      const loaded = await store.load();
      const tracker2 = new RuntimeDiagnosticsTracker(store, loaded.events, loaded.capSuppress);
      tracker2.recordCapSuppressed('pair-a'); // 1 more for pair-a

      const todayUtcOps = tracker2.buildTodayUtcOperationalSummary();
      expect(todayUtcOps.capSuppressedPairs).toBe(2);
      expect(todayUtcOps.capSuppressedCandles).toBe(4); // 2+1+1
      await tracker2.flush();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('clears stale cap_suppressed counts when UTC day rolls over before next record', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-04-03T23:59:50.000Z'));
      const tracker = new RuntimeDiagnosticsTracker();
      tracker.recordCapSuppressed('pair-a');
      tracker.recordCapSuppressed('pair-b');

      jest.setSystemTime(new Date('2026-04-04T00:00:05.000Z'));

      const todayUtcOps = tracker.buildTodayUtcOperationalSummary();
      expect(todayUtcOps.capSuppressedPairs).toBe(0);
      expect(todayUtcOps.capSuppressedCandles).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('includes admission_skip:all_pairs_blocked tokens in missedTokens', () => {
    const tracker = new RuntimeDiagnosticsTracker();

    // Why: admission_skip으로만 차단된 토큰도 missedTokens에 포함되어야 함
    tracker.recordAdmissionSkip({
      tokenMint: 'token-blocked',
      reason: 'no_pairs',
      detail: 'all_pairs_blocked',
      source: 'gecko_trending',
    });
    tracker.recordAdmissionSkip({
      tokenMint: 'token-blocked',
      reason: 'no_pairs',
      detail: 'all_pairs_blocked',
      source: 'gecko_trending',
    });

    // 일반 admission_skip (all_pairs_blocked 아님) — missedTokens에 미포함
    tracker.recordAdmissionSkip({
      tokenMint: 'token-normal-skip',
      reason: 'no_pairs',
      detail: 'resolver_miss',
      source: 'gecko_trending',
    });

    // signal_not_in_watchlist + admission_skip 혼합 토큰
    tracker.recordSignalNotInWatchlist('token-mixed');
    tracker.recordAdmissionSkip({
      tokenMint: 'token-mixed',
      reason: 'no_pairs',
      detail: 'all_pairs_blocked',
      source: 'gecko_trending',
    });

    const summary = tracker.buildSummary(24);

    expect(summary.missedTokens).toEqual([
      { tokenMint: 'token-blocked', evicted: 0, readded: 0, notInWatchlist: 0, recentlyEvicted: 0, admissionBlocked: 2 },
      { tokenMint: 'token-mixed', evicted: 0, readded: 0, notInWatchlist: 1, recentlyEvicted: 0, admissionBlocked: 1 },
    ]);
  });
});
