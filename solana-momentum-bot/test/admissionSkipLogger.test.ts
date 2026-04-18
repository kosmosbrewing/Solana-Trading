/**
 * Block 2 (2026-04-18): admission skip DEX telemetry.
 * Layer 3 병목 (`unsupported_dex=77.8%`) 의 empirical 근거를 남기는 logger 동작 검증.
 */
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  logAdmissionSkipDex,
  resetAdmissionSkipLoggerForTests,
} from '../src/realtime/admissionSkipLogger';

jest.mock('../src/utils/config', () => {
  const realDataDir = process.env.__TEST_REALTIME_DATA_DIR ?? '/tmp';
  return { config: { realtimeDataDir: realDataDir } };
});

async function readJsonl(dir: string, file: string): Promise<any[]> {
  try {
    const text = await readFile(path.join(dir, file), 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('admissionSkipLogger', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'adm-skip-test-'));
    process.env.__TEST_REALTIME_DATA_DIR = dir;
    jest.resetModules();
    // Re-import after env var change
    // @ts-ignore
    const mod = require('../src/realtime/admissionSkipLogger');
    mod.resetAdmissionSkipLoggerForTests();
    (global as any).__log = mod.logAdmissionSkipDex;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.__TEST_REALTIME_DATA_DIR;
    resetAdmissionSkipLoggerForTests();
  });

  it('persists unsupported_dex skip with dexId + samplePair', async () => {
    const log = (global as any).__log as typeof logAdmissionSkipDex;
    await log({
      reason: 'unsupported_dex',
      detail: 'unsupported_dex_after_lookup',
      tokenMint: 'TKN-1',
      dexId: 'phoenix',
      samplePair: 'PAIR-1',
      resolvedPairsCount: 1,
    });

    const rows = await readJsonl(dir, 'admission-skips-dex.jsonl');
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('unsupported_dex');
    expect(rows[0].dexId).toBe('phoenix');
    expect(rows[0].samplePair).toBe('PAIR-1');
    expect(rows[0]).toHaveProperty('recordedAt');
  });

  it('persists no_pairs skip', async () => {
    const log = (global as any).__log as typeof logAdmissionSkipDex;
    await log({
      reason: 'no_pairs',
      detail: 'resolver_miss',
      tokenMint: 'TKN-2',
      resolvedPairsCount: 0,
    });

    const rows = await readJsonl(dir, 'admission-skips-dex.jsonl');
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('no_pairs');
  });

  it('dedupes same dex+mint within TTL', async () => {
    const log = (global as any).__log as typeof logAdmissionSkipDex;
    await log({ reason: 'unsupported_dex', tokenMint: 'TKN-3', dexId: 'phoenix' });
    await log({ reason: 'unsupported_dex', tokenMint: 'TKN-3', dexId: 'phoenix' });
    await log({ reason: 'unsupported_dex', tokenMint: 'TKN-3', dexId: 'phoenix' });

    const rows = await readJsonl(dir, 'admission-skips-dex.jsonl');
    expect(rows).toHaveLength(1);
  });

  it('does not dedupe across different mints', async () => {
    const log = (global as any).__log as typeof logAdmissionSkipDex;
    await log({ reason: 'unsupported_dex', tokenMint: 'TKN-A', dexId: 'phoenix' });
    await log({ reason: 'unsupported_dex', tokenMint: 'TKN-B', dexId: 'phoenix' });

    const rows = await readJsonl(dir, 'admission-skips-dex.jsonl');
    expect(rows).toHaveLength(2);
  });

  it('ignores unrelated skip reasons (not DEX-related)', async () => {
    const log = (global as any).__log as typeof logAdmissionSkipDex;
    await log({ reason: 'security_rejected', tokenMint: 'TKN-X', dexId: 'raydium' } as any);
    await log({ reason: 'non_sol_quote', tokenMint: 'TKN-Y', dexId: 'raydium' } as any);

    const rows = await readJsonl(dir, 'admission-skips-dex.jsonl');
    expect(rows).toHaveLength(0);
  });
});
