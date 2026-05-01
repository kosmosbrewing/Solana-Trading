/**
 * Dev Wallet Registry 단위 테스트 (2026-05-01, Decu Phase B.5).
 */
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  initDevWalletRegistry,
  resetDevWalletRegistryState,
  lookupDevByAddress,
  resolveDevStatus,
  getDevWalletRegistryStats,
} from '../src/observability/devWalletRegistry';

describe('devWalletRegistry', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `devwallet-test-${Date.now()}-${Math.random()}`);
    await mkdir(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'wallets.json');
    resetDevWalletRegistryState();
  });

  afterEach(() => {
    resetDevWalletRegistryState();
  });

  it('파일 없으면 fail-open (빈 DB)', async () => {
    await initDevWalletRegistry({
      path: '/nonexistent/path.json',
      hotReloadIntervalMs: 0,
    });
    const stats = getDevWalletRegistryStats();
    expect(stats.totalEntries).toBe(0);
    expect(lookupDevByAddress('any')).toBeUndefined();
    expect(resolveDevStatus('any')).toBe('unknown');
  });

  it('정상 schema 로드 + addressIndex', async () => {
    await writeFile(dbPath, JSON.stringify({
      version: 'v1',
      last_updated: '2026-05-01',
      devs: [
        {
          id: 'good_dev',
          addresses: ['ADDR1', 'ADDR2'],
          status: 'allowlist',
          is_active: true,
        },
        {
          id: 'bad_dev',
          addresses: ['ADDR3'],
          status: 'blacklist',
          is_active: true,
        },
        {
          id: 'old_dev',
          addresses: ['ADDR4'],
          status: 'unknown',
          is_active: false,  // 제외
        },
      ],
    }), 'utf8');

    await initDevWalletRegistry({ path: dbPath, hotReloadIntervalMs: 0 });

    expect(lookupDevByAddress('ADDR1')?.status).toBe('allowlist');
    expect(lookupDevByAddress('ADDR2')?.id).toBe('good_dev');
    expect(lookupDevByAddress('ADDR3')?.status).toBe('blacklist');
    // is_active=false 인 dev 의 address 는 lookup 제외
    expect(lookupDevByAddress('ADDR4')).toBeUndefined();

    const stats = getDevWalletRegistryStats();
    expect(stats.totalEntries).toBe(3);
    expect(stats.activeEntries).toBe(2);
    expect(stats.byStatus.allowlist).toBe(1);
    expect(stats.byStatus.blacklist).toBe(1);
  });

  it('resolveDevStatus — known address → 정확 status, unknown → "unknown"', async () => {
    await writeFile(dbPath, JSON.stringify({
      version: 'v1', last_updated: '2026-05-01',
      devs: [{ id: 'd', addresses: ['ADDR_X'], status: 'watchlist', is_active: true }],
    }), 'utf8');
    await initDevWalletRegistry({ path: dbPath, hotReloadIntervalMs: 0 });
    expect(resolveDevStatus('ADDR_X')).toBe('watchlist');
    expect(resolveDevStatus('UNKNOWN_ADDR')).toBe('unknown');
    expect(resolveDevStatus(undefined)).toBe('unknown');
    expect(resolveDevStatus('')).toBe('unknown');
  });

  it('손상된 JSON → fail-open (빈 DB)', async () => {
    await writeFile(dbPath, '{ invalid json', 'utf8');
    await initDevWalletRegistry({ path: dbPath, hotReloadIntervalMs: 0 });
    expect(getDevWalletRegistryStats().totalEntries).toBe(0);
  });

  it('schema 누락 (devs[] 없음) → fail-open', async () => {
    await writeFile(dbPath, JSON.stringify({ version: 'v1' }), 'utf8');
    await initDevWalletRegistry({ path: dbPath, hotReloadIntervalMs: 0 });
    expect(getDevWalletRegistryStats().totalEntries).toBe(0);
  });
});
