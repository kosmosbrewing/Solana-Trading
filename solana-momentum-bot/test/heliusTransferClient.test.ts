import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  classifyTransferDirection,
  getTransfersByAddress,
  parseGetTransfersByAddressResult,
} from '../src/ingester/heliusTransferClient';

const SAMPLE_TRANSFER = {
  signature: 'sig1',
  slot: 123,
  blockTime: 1770000000,
  type: 'transfer',
  fromUserAccount: 'wallet-a',
  toUserAccount: 'wallet-b',
  mint: 'mint1',
  amount: '1000',
  decimals: 6,
  uiAmount: '0.001',
  confirmationStatus: 'finalized',
  instructionIdx: 1,
  innerInstructionIdx: 0,
};

describe('heliusTransferClient', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'helius-transfer-client-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses valid getTransfersByAddress result', () => {
    const parsed = parseGetTransfersByAddressResult({
      data: [SAMPLE_TRANSFER, { bad: true }],
      paginationToken: 'cursor1',
    });
    expect(parsed?.data).toHaveLength(1);
    expect(parsed?.paginationToken).toBe('cursor1');
    expect(parsed?.data[0]?.signature).toBe('sig1');
  });

  it('classifies wallet-relative direction', () => {
    expect(classifyTransferDirection(SAMPLE_TRANSFER, 'wallet-a')).toBe('out');
    expect(classifyTransferDirection(SAMPLE_TRANSFER, 'wallet-b')).toBe('in');
    expect(classifyTransferDirection({
      fromUserAccount: 'wallet-a',
      toUserAccount: 'wallet-a',
    }, 'wallet-a')).toBe('self');
  });

  it('requests Helius RPC and records 10-credit usage', async () => {
    const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.method).toBe('getTransfersByAddress');
      expect(body.params[0]).toBe('wallet-a');
      expect(body.params[1].limit).toBe(100);
      return {
        ok: true,
        json: async () => ({ result: { data: [SAMPLE_TRANSFER], paginationToken: null } }),
      } as Response;
    });

    const result = await getTransfersByAddress('https://mainnet.helius-rpc.com/?api-key=test', {
      address: 'wallet-a',
      config: { limit: 500 },
    }, {
      creditLedgerDir: tmpDir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      traceId: 'trace-1',
    });

    expect(result?.data).toHaveLength(1);
    const ledger = await readFile(path.join(tmpDir, 'helius-credit-usage.jsonl'), 'utf8');
    const row = JSON.parse(ledger.trim());
    expect(row.method).toBe('getTransfersByAddress');
    expect(row.estimatedCredits).toBe(10);
    expect(row.walletAddress).toBe('wallet-a');
  });
});
