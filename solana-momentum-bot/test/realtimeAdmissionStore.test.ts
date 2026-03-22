import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  RealtimeAdmissionStore,
  RealtimeAdmissionTracker,
} from '../src/realtime';

describe('RealtimeAdmissionStore', () => {
  it('persists and restores realtime admission snapshots', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'realtime-admission-'));
    const filePath = path.join(tempDir, 'snapshot.json');
    const store = new RealtimeAdmissionStore(filePath);
    const tracker = new RealtimeAdmissionTracker({
      minObservedNotifications: 50,
      minParseRatePct: 1,
      minSkippedRatePct: 90,
    });

    for (let index = 0; index < 50; index++) {
      tracker.recordParseMiss('pool-blocked');
      tracker.recordFallbackSkipped('pool-blocked');
    }
    await store.save(tracker.exportSnapshot());

    const restored = new RealtimeAdmissionTracker({
      minObservedNotifications: 50,
      minParseRatePct: 1,
      minSkippedRatePct: 90,
    });
    restored.importSnapshot(await store.load());

    expect(restored.isBlocked('pool-blocked')).toBe(true);
    expect(restored.getStats('pool-blocked')).toEqual({
      observedNotifications: 50,
      logParsed: 0,
      fallbackSkipped: 50,
      parseRatePct: 0,
      skippedRatePct: 100,
    });

    await rm(tempDir, { recursive: true, force: true });
  });
});
