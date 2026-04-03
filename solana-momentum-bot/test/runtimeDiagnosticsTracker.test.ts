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

      const restored = new RuntimeDiagnosticsTracker(store, await store.load());
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
    tracker.recordTriggerStats('evals=100 signals=2 insuffCandles=30 volInsuf=50 noBreakout=10 confirmFail=5 cooldown=3');
    tracker.recordTriggerStats('evals=200 signals=5 insuffCandles=60 volInsuf=100 noBreakout=20 confirmFail=10 cooldown=5');

    const summary = tracker.buildSummary(24);

    expect(summary.triggerStatsCounts).toHaveLength(2);
    expect(summary.triggerStatsCounts[0].count).toBe(1);
    expect(summary.triggerStatsCounts[0].label).toContain('momentum_trigger');
    expect(summary.triggerStatsCounts[0].label).toContain('evals=');
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
});
