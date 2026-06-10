import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { KolCandleCoverageTelemetry } from '../src/realtime/kolCandleCoverageTelemetry';

describe('KolCandleCoverageTelemetry', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kol-candle-telemetry-'));
    filePath = path.join(tmpDir, 'kol-candle-coverage-telemetry.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function readLines(): Array<Record<string, unknown>> {
    if (!existsSync(filePath)) return [];
    return readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  it('accumulates funnel counters per day', () => {
    const telemetry = new KolCandleCoverageTelemetry({
      filePath,
      now: () => Date.parse('2026-06-10T01:00:00Z'),
      flushIntervalMs: 0,
    });
    telemetry.recordRequested();
    telemetry.recordRequested();
    telemetry.recordResolveMiss('no_pairs');
    telemetry.recordResolveMiss('no_pairs');
    telemetry.recordResolveMiss('unsupported_pool_program');
    telemetry.recordSubscribed(false);
    telemetry.recordSubscribed(true);
    telemetry.recordSeedSwaps(5);
    telemetry.recordRemoved('capacity_evict');
    telemetry.recordRemoved('ttl_expire');
    telemetry.recordRemoved('replaced');

    const snapshot = telemetry.getSnapshot();
    expect(snapshot).toMatchObject({
      day: '2026-06-10',
      requested: 2,
      resolveMiss: { no_pairs: 2, unsupported_pool_program: 1 },
      subscribedNew: 1,
      refreshed: 1,
      seedSwaps: 5,
      capacityEvicted: 1,
      ttlExpired: 1,
      replaced: 1,
    });
    telemetry.stop();
  });

  it('finalizes the previous day to JSONL on UTC day rollover and resets counters', async () => {
    let nowMs = Date.parse('2026-06-10T23:59:00Z');
    const telemetry = new KolCandleCoverageTelemetry({
      filePath,
      now: () => nowMs,
      flushIntervalMs: 0,
    });
    telemetry.recordRequested();
    telemetry.recordSubscribed(false);

    nowMs = Date.parse('2026-06-11T00:01:00Z');
    telemetry.recordRequested(); // rollover trigger

    // append 는 fire-and-forget — microtask flush 대기
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: 'day_final',
      day: '2026-06-10',
      requested: 1,
      subscribedNew: 1,
    });
    expect(telemetry.getSnapshot()).toMatchObject({ day: '2026-06-11', requested: 1, subscribedNew: 0 });
    telemetry.stop();
  });

  it('flush(interval) writes a partial snapshot and skips idle days', async () => {
    const telemetry = new KolCandleCoverageTelemetry({
      filePath,
      now: () => Date.parse('2026-06-10T05:00:00Z'),
      flushIntervalMs: 0,
    });
    await telemetry.flush('interval');
    expect(readLines()).toHaveLength(0); // requested=0 → idle skip

    telemetry.recordRequested();
    await telemetry.flush('interval');
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'interval', day: '2026-06-10', requested: 1 });
    telemetry.stop();
  });

  it('is fail-open when the telemetry path is not writable', async () => {
    // 기존 파일을 디렉토리 경로처럼 사용 → mkdir/append 모두 ENOTDIR
    writeFileSync(filePath, 'occupied', 'utf8');
    const telemetry = new KolCandleCoverageTelemetry({
      filePath: path.join(filePath, 'nested', 'x.jsonl'),
      now: () => Date.parse('2026-06-10T05:00:00Z'),
      flushIntervalMs: 0,
    });
    telemetry.recordRequested();
    await expect(telemetry.flush('interval')).resolves.toBeUndefined();
    telemetry.stop();
  });
});
