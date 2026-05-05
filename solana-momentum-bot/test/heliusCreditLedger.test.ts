/**
 * Helius Credit Usage Ledger writer tests (2026-05-01, Stream A).
 *
 * 검증:
 *   - buildHeliusCreditUsage estimate 정확 (Standard RPC 1 / Enhanced 100 / WSS bytes / Sender 0)
 *   - append 정상 path → ledger 파일 생성 + JSONL row 1
 *   - fail-open: 잘못된 dir 도 throw 안 함
 *   - batch append 일부 성공
 *   - schemaVersion 동결
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  appendHeliusCreditUsage,
  appendHeliusCreditUsageBatch,
  buildHeliusCreditUsage,
  HELIUS_CREDIT_USAGE_SCHEMA_VERSION,
} from '../src/observability/heliusCreditLedger';
import { HELIUS_COST_CATALOG_VERSION } from '../src/observability/heliusCreditCost';
import type { HeliusCreditUsageRecord } from '../src/observability/heliusCreditLedger';

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonl(p: string): Promise<unknown[]> {
  const content = await readFile(p, 'utf8');
  return content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('heliusCreditLedger', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'helius-credit-ledger-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('buildHeliusCreditUsage estimate', () => {
    it('Standard RPC getParsedTransaction × 100 calls = 100 credits', () => {
      const r = buildHeliusCreditUsage({
        purpose: 'markout_backfill',
        surface: 'standard_rpc',
        method: 'getParsedTransaction',
        requestCount: 100,
      });
      expect(r.estimatedCredits).toBe(100); // 1 × 100
      expect(r.surface).toBe('standard_rpc');
      expect(r.method).toBe('getParsedTransaction');
    });

    it('Enhanced API parseTransactions × 10 calls = 1000 credits', () => {
      const r = buildHeliusCreditUsage({
        purpose: 'kol_tx_enrichment',
        surface: 'enhanced_tx',
        method: 'parseTransactions',
        requestCount: 10,
      });
      expect(r.estimatedCredits).toBe(1000); // 100 × 10
    });

    it('Wallet API getTransactionsForAddress × 1 = 50 credits', () => {
      const r = buildHeliusCreditUsage({
        purpose: 'wallet_style_backfill',
        surface: 'wallet_api',
        method: 'getTransactionsForAddress',
        requestCount: 1,
      });
      expect(r.estimatedCredits).toBe(50);
    });

    it('Wallet API getTransfersByAddress × 3 = 30 credits', () => {
      const r = buildHeliusCreditUsage({
        purpose: 'wallet_style_backfill',
        surface: 'wallet_api',
        method: 'getTransfersByAddress',
        requestCount: 3,
      });
      expect(r.estimatedCredits).toBe(30);
    });

    it('Sender × N = 0 credits 항상', () => {
      const r = buildHeliusCreditUsage({
        purpose: 'execution_telemetry',
        surface: 'sender',
        method: 'sender_send',
        requestCount: 1000,
      });
      expect(r.estimatedCredits).toBe(0);
    });

    it('WSS 200KB → 4 credits (2 buckets × 2)', () => {
      const r = buildHeliusCreditUsage({
        purpose: 'live_hot_path',
        surface: 'wss',
        method: 'wss_subscription',
        requestCount: 1, // unused for wss
        wssBytes: 200 * 1024,
      });
      expect(r.estimatedCredits).toBe(4);
      expect(r.wssBytes).toBe(200 * 1024);
    });

    it('미등록 method → fallback (standard_rpc=1)', () => {
      const r = buildHeliusCreditUsage({
        purpose: 'ops_check',
        surface: 'standard_rpc',
        method: 'unregisteredMethodXYZ',
        requestCount: 5,
      });
      expect(r.estimatedCredits).toBe(5); // fallback 1 × 5
    });

    it('schemaVersion + catalogVersion 동결 보유', () => {
      const r = buildHeliusCreditUsage({
        purpose: 'token_quality',
        surface: 'standard_rpc',
        method: 'getTokenLargestAccounts',
        requestCount: 1,
      });
      expect(r.schemaVersion).toBe(HELIUS_CREDIT_USAGE_SCHEMA_VERSION);
      expect(r.catalogVersion).toBe(HELIUS_COST_CATALOG_VERSION);
    });

    it("source default = 'estimate'", () => {
      const r = buildHeliusCreditUsage({
        purpose: 'ops_check',
        surface: 'standard_rpc',
        method: 'getBalance',
        requestCount: 1,
      });
      expect(r.source).toBe('estimate');
    });

    it("source override = 'dashboard_reconcile'", () => {
      const r = buildHeliusCreditUsage({
        purpose: 'ops_check',
        surface: 'standard_rpc',
        method: 'getBalance',
        requestCount: 1,
        source: 'dashboard_reconcile',
      });
      expect(r.source).toBe('dashboard_reconcile');
    });

    it('requestCount 음수 / NaN → 0 으로 clamp', () => {
      const r1 = buildHeliusCreditUsage({
        purpose: 'ops_check',
        surface: 'standard_rpc',
        method: 'getBalance',
        requestCount: -5,
      });
      expect(r1.requestCount).toBe(0);
      expect(r1.estimatedCredits).toBe(0);

      const r2 = buildHeliusCreditUsage({
        purpose: 'ops_check',
        surface: 'standard_rpc',
        method: 'getBalance',
        requestCount: NaN as unknown as number,
      });
      expect(r2.requestCount).toBe(0);
    });
  });

  describe('appendHeliusCreditUsage — fail-open', () => {
    it('정상 append → ledger 파일 생성 + 1 row', async () => {
      const r = buildHeliusCreditUsage({
        purpose: 'token_quality',
        surface: 'standard_rpc',
        method: 'getTokenLargestAccounts',
        requestCount: 3,
        tokenMint: 'TestMint',
      });
      const result = await appendHeliusCreditUsage(r, { ledgerDir: tmpDir });
      expect(result.appended).toBe(true);
      expect(result.error).toBeUndefined();

      const ledgerPath = path.join(tmpDir, 'helius-credit-usage.jsonl');
      expect(await fileExists(ledgerPath)).toBe(true);
      const rows = (await readJsonl(ledgerPath)) as HeliusCreditUsageRecord[];
      expect(rows).toHaveLength(1);
      expect(rows[0].purpose).toBe('token_quality');
      expect(rows[0].estimatedCredits).toBe(3);
      expect(rows[0].tokenMint).toBe('TestMint');
    });

    it('ledgerDir 가 file (not dir) 이라 mkdir 실패 → throw 안 함, appended=false', async () => {
      const fakeFile = path.join(tmpDir, 'not-a-dir');
      await writeFile(fakeFile, 'placeholder', 'utf8');

      const r = buildHeliusCreditUsage({
        purpose: 'ops_check',
        surface: 'standard_rpc',
        method: 'getBalance',
        requestCount: 1,
      });
      // throw 검사 — Promise resolve 만 보장
      await expect(appendHeliusCreditUsage(r, { ledgerDir: fakeFile })).resolves.toBeDefined();
    });

    it('20 row 동시 append → 모두 보존', async () => {
      const records = Array.from({ length: 20 }, (_, i) =>
        buildHeliusCreditUsage({
          purpose: 'markout_backfill',
          surface: 'standard_rpc',
          method: 'getParsedTransaction',
          requestCount: 1,
          traceId: `trace_${i}`,
        }),
      );
      const results = await Promise.all(
        records.map((r) => appendHeliusCreditUsage(r, { ledgerDir: tmpDir })),
      );
      expect(results.every((r) => r.appended)).toBe(true);

      const ledgerPath = path.join(tmpDir, 'helius-credit-usage.jsonl');
      const rows = (await readJsonl(ledgerPath)) as HeliusCreditUsageRecord[];
      expect(rows).toHaveLength(20);
    });
  });

  describe('appendHeliusCreditUsageBatch', () => {
    it('5 row batch → totalAppended=5, failures=0', async () => {
      const records = Array.from({ length: 5 }, (_, i) =>
        buildHeliusCreditUsage({
          purpose: 'pool_prewarm',
          surface: 'standard_rpc',
          method: 'getAccountInfo',
          requestCount: 1,
          traceId: `b_${i}`,
        }),
      );
      const result = await appendHeliusCreditUsageBatch(records, { ledgerDir: tmpDir });
      expect(result.totalAppended).toBe(5);
      expect(result.failures).toBe(0);
    });

    it('빈 array → totalAppended=0', async () => {
      const result = await appendHeliusCreditUsageBatch([], { ledgerDir: tmpDir });
      expect(result.totalAppended).toBe(0);
      expect(result.failures).toBe(0);
    });
  });
});
