import { mkdtemp, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  KOL_TRANSFER_SCHEMA_VERSION,
  buildBackfillRecord,
  loadKolTargets,
  parseArgs,
} from '../scripts/kol-transfer-backfill';
import type { HeliusTransferRecord } from '../src/ingester/heliusTransferClient';

describe('kol-transfer-backfill helpers', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kol-transfer-backfill-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads active KOL addresses only by default', async () => {
    const dbPath = path.join(tmpDir, 'wallets.json');
    await writeFile(dbPath, JSON.stringify({
      kols: [
        { id: 'active', addresses: ['a1', 'a2'], tier: 'A', is_active: true },
        { id: 'inactive', addresses: ['i1'], tier: 'B', is_active: false },
      ],
    }), 'utf8');

    await expect(loadKolTargets(dbPath, true)).resolves.toMatchObject([
      { kolId: 'active', address: 'a1', tier: 'A' },
      { kolId: 'active', address: 'a2', tier: 'A' },
    ]);
    await expect(loadKolTargets(dbPath, false)).resolves.toHaveLength(3);
  });

  it('builds deterministic transfer ledger rows', () => {
    const transfer: HeliusTransferRecord = {
      signature: 'sig1',
      slot: 1,
      type: 'transfer',
      fromUserAccount: 'wallet-a',
      toUserAccount: 'other',
      mint: 'mint1',
      amount: '42',
      decimals: 0,
      uiAmount: '42',
      instructionIdx: 2,
      innerInstructionIdx: 0,
    };

    const row = buildBackfillRecord({
      kolId: 'kol-a',
      address: 'wallet-a',
      tier: 'S',
      laneRole: 'copy_core',
      tradingStyle: 'scalper',
    }, transfer);

    expect(row.schemaVersion).toBe(KOL_TRANSFER_SCHEMA_VERSION);
    expect(row.walletDirection).toBe('out');
    expect(row.eventId).toBe('wallet-a:sig1:2:0:mint1:42');
    expect(row.laneRole).toBe('copy_core');
  });

  it('parses defaults toward transfers-first backfill', () => {
    const parsed = parseArgs(['--api-key', 'key', '--since', '7d', '--overwrite'], 1_800_000_000);
    expect(parsed.rpcUrl).toContain('api-key=key');
    expect(parsed.solMode).toBe('separate');
    expect(parsed.sortOrder).toBe('asc');
    expect(parsed.overwrite).toBe(true);
    expect(parsed.sinceSec).toBe(1_800_000_000 - 7 * 24 * 60 * 60);
  });
});
