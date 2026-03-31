import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { prepareRealtimePersistenceLayout } from '../src/realtime/persistenceLayout';
import { RealtimeReplayStore } from '../src/realtime';

describe('realtime persistence layout', () => {
  it('migrates legacy root dataset into a dated session and starts a new session', async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'realtime-layout-'));
    const realtimeRoot = path.join(tempRoot, 'data', 'realtime');
    const startedAt = new Date('2026-03-31T13:00:00.000Z');

    mkdirSync(realtimeRoot, { recursive: true });
    writeFileSync(path.join(realtimeRoot, 'raw-swaps.jsonl'), '{"legacy":true}\n', { encoding: 'utf8', flag: 'wx' });
    writeFileSync(path.join(realtimeRoot, 'micro-candles.jsonl'), '{"legacy":true}\n', { encoding: 'utf8', flag: 'wx' });

    try {
      const layout = await prepareRealtimePersistenceLayout(realtimeRoot, {
        tradingMode: 'live',
        startedAt,
      });

      expect(layout.datasetDir).toContain(path.join('sessions', '2026-03-31T13-00-00-000Z-live'));

      const pointer = JSON.parse(readFileSync(layout.currentSessionPath, 'utf8')) as { datasetDir: string };
      expect(pointer.datasetDir).toBe(layout.datasetDir);

      const legacyDir = path.join(layout.sessionsDir, 'legacy-2026-03-31T13-00-00-000Z');
      const store = new RealtimeReplayStore(realtimeRoot);
      expect(store.datasetDir).toBe(layout.datasetDir);
      expect(readFileSync(path.join(legacyDir, 'raw-swaps.jsonl'), 'utf8')).toContain('"legacy":true');
      expect(readFileSync(path.join(legacyDir, 'micro-candles.jsonl'), 'utf8')).toContain('"legacy":true');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('prefers the latest non-legacy session when current-session pointer is unavailable', async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'realtime-layout-'));
    const realtimeRoot = path.join(tempRoot, 'data', 'realtime');
    const startedAt = new Date('2026-03-31T13:00:00.000Z');

    mkdirSync(realtimeRoot, { recursive: true });

    try {
      const layout = await prepareRealtimePersistenceLayout(realtimeRoot, {
        tradingMode: 'live',
        startedAt,
      });
      writeFileSync(path.join(layout.datasetDir, 'micro-candles.jsonl'), '{"active":true}\n', 'utf8');

      const legacyDir = path.join(layout.sessionsDir, 'legacy-2026-03-31T13-05-00-000Z');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(path.join(legacyDir, 'micro-candles.jsonl'), '{"legacy":true}\n', 'utf8');

      unlinkSync(layout.currentSessionPath);

      const store = new RealtimeReplayStore(realtimeRoot);
      expect(store.datasetDir).toBe(layout.datasetDir);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
