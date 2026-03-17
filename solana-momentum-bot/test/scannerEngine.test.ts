import { ScannerEngine } from '../src/scanner/scannerEngine';
import { SocialMentionTracker } from '../src/scanner/socialMentionTracker';

describe('ScannerEngine social tracker wiring', () => {
  it('registers manual watchlist entries with the social mention tracker', () => {
    const socialMentionTracker = new SocialMentionTracker();
    const scanner = new ScannerEngine({
      birdeyeClient: {} as never,
      birdeyeWS: null,
      dexScreenerClient: null,
      maxWatchlistSize: 10,
      minWatchlistScore: 0,
      trendingPollIntervalMs: 60_000,
      dexEnrichIntervalMs: 60_000,
      laneAMinAgeSec: 3600,
      laneBMaxAgeSec: 1200,
      minLiquidityUsd: 1000,
      socialMentionTracker,
    });

    scanner.addManualEntry('mint-1', 'pair-1', 'TEST');

    expect(socialMentionTracker.getTrackedTokenCount()).toBe(1);
  });
});
