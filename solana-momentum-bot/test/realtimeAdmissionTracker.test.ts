import { RealtimeAdmissionTracker } from '../src/realtime';

describe('RealtimeAdmissionTracker', () => {
  it('blocks pools with persistently near-zero parse rate and high skipped ratio', () => {
    const tracker = new RealtimeAdmissionTracker({
      minObservedNotifications: 50,
      minParseRatePct: 1,
      minSkippedRatePct: 90,
    });

    let blockedPool: string | null = null;
    tracker.on('blocked', ({ pool }: { pool: string }) => {
      blockedPool = pool;
    });

    for (let index = 0; index < 50; index++) {
      tracker.recordParseMiss('pool-noisy');
      tracker.recordFallbackSkipped('pool-noisy');
    }

    expect(blockedPool).toBe('pool-noisy');
    expect(tracker.isBlocked('pool-noisy')).toBe(true);
    expect(tracker.getStats('pool-noisy')).toEqual({
      observedNotifications: 50,
      logParsed: 0,
      fallbackParsed: 0,
      fallbackSkipped: 50,
      parseRatePct: 0,
      skippedRatePct: 100,
    });
  });

  it('keeps parseable pools admitted even if many notifications are skipped', () => {
    const tracker = new RealtimeAdmissionTracker({
      minObservedNotifications: 50,
      minParseRatePct: 1,
      minSkippedRatePct: 90,
    });

    for (let index = 0; index < 48; index++) {
      tracker.recordParseMiss('pool-good');
      tracker.recordFallbackSkipped('pool-good');
    }
    tracker.recordLogParsed('pool-good');
    tracker.recordFallbackParsed('pool-good');

    expect(tracker.isBlocked('pool-good')).toBe(false);
    expect(tracker.getStats('pool-good')).toEqual({
      observedNotifications: 50,
      logParsed: 1,
      fallbackParsed: 1,
      fallbackSkipped: 48,
      parseRatePct: 4,
      skippedRatePct: 96,
    });
  });

  it('does not block before enough observations are collected', () => {
    const tracker = new RealtimeAdmissionTracker({
      minObservedNotifications: 50,
      minParseRatePct: 1,
      minSkippedRatePct: 90,
    });

    for (let index = 0; index < 49; index++) {
      tracker.recordParseMiss('pool-warming');
      tracker.recordFallbackSkipped('pool-warming');
    }

    expect(tracker.isBlocked('pool-warming')).toBe(false);
  });
});
