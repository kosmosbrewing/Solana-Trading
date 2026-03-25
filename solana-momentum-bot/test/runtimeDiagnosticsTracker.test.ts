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
      reason: 'unsupported_pool_program',
      source: 'gecko_trending',
      dexId: 'raydium',
    });
    tracker.recordRealtimeCandidateSeen({ tokenMint: 'token-c', source: 'dex_boost' });

    const summary = tracker.buildSummary(24);

    expect(summary.realtimeCandidateReadiness).toEqual({
      totalCandidates: 3,
      prefiltered: 1,
      admissionSkipped: 1,
      ready: 1,
      readinessRate: 1 / 3,
    });
    expect(summary.preWatchlistRejectCounts).toEqual([{ reason: 'unsupported_dex', count: 1 }]);
    expect(summary.admissionSkipCounts).toEqual([{ reason: 'unsupported_pool_program', count: 1 }]);
  });

  it('persists events across restarts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'runtime-diag-'));
    const store = new RuntimeDiagnosticsStore(path.join(tempDir, 'runtime-diagnostics.json'));

    try {
      const tracker = new RuntimeDiagnosticsTracker(store);
      tracker.recordRealtimeCandidateSeen({ tokenMint: 'token-live', source: 'dex_boost' });
      tracker.recordAdmissionSkip({
        tokenMint: 'token-live',
        reason: 'unsupported_pool_program',
        source: 'dex_boost',
        dexId: 'raydium',
      });
      tracker.recordRateLimit('gecko_ingester');
      await tracker.flush();

      const restored = new RuntimeDiagnosticsTracker(store, await store.load());
      const summary = restored.buildSummary(24);

      expect(summary.realtimeCandidateReadiness.totalCandidates).toBe(1);
      expect(summary.realtimeCandidateReadiness.admissionSkipped).toBe(1);
      expect(summary.rateLimitCounts).toEqual([{ source: 'gecko_ingester', count: 1 }]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
