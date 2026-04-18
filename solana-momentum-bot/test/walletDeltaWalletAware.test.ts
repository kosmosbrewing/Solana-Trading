/**
 * Block 1 QA fix (2026-04-18): wallet-aware comparator.
 * ledger entry 의 `wallet` 필드 로 다른 wallet 의 기록을 expected delta 계산에서 제외하는지 검증.
 */
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  runWalletDeltaCheckOnceForTests,
  resetWalletDeltaComparatorForTests,
} from '../src/risk/walletDeltaComparator';
import { resetAllEntryHaltsForTests } from '../src/orchestration/entryIntegrity';

function makeWalletManager(balances: number[]): { getBalance: jest.Mock } {
  let i = 0;
  return {
    getBalance: jest.fn(async () => {
      const v = balances[Math.min(i, balances.length - 1)];
      i++;
      return v;
    }),
  };
}

const baseCfg = (dir: string, walletName: string) => ({
  enabled: true,
  pollIntervalMs: 60_000,
  driftWarnSol: 0.05,
  driftHaltSol: 0.20,
  minSamplesBeforeAlert: 1,
  walletName,
  realtimeDataDir: dir,
});

describe('walletDeltaComparator — wallet-aware filter (Block 1 QA)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'wallet-aware-test-'));
    resetWalletDeltaComparatorForTests();
    resetAllEntryHaltsForTests();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('filters ledger entries by wallet label (ignores other wallet)', async () => {
    // main wallet baseline=1.0, no change (observed=0).
    // ledger 에 sandbox wallet 의 0.1 SOL sell 이 기록됨.
    // wallet-aware filter 면 expected=0 (sandbox 제외), drift=0 → no alert.
    await writeFile(
      path.join(dir, 'executed-sells.jsonl'),
      JSON.stringify({ txSignature: 's1', receivedSol: 0.1, wallet: 'sandbox' }) + '\n',
      { flag: 'a' }
    );

    const walletManager = makeWalletManager([1.0, 1.0]);
    const notifier = { sendCritical: jest.fn(async () => {}) };

    await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, baseCfg(dir, 'main'));
    const result = await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, baseCfg(dir, 'main'));

    expect(result.lastExpectedDelta).toBeCloseTo(0, 6);
    expect(Math.abs(result.lastDrift)).toBeLessThan(0.05);
    expect(notifier.sendCritical).not.toHaveBeenCalled();
  });

  it('counts matching wallet ledger entries (main sell with wallet=main)', async () => {
    const walletManager = makeWalletManager([1.0, 1.0, 1.0]);
    const notifier = { sendCritical: jest.fn(async () => {}) };

    await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, baseCfg(dir, 'main'));
    // baseline 이후 main sell +0.1 추가
    await writeFile(
      path.join(dir, 'executed-sells.jsonl'),
      JSON.stringify({ txSignature: 's2', receivedSol: 0.1, wallet: 'main' }) + '\n',
      { flag: 'a' }
    );
    const result = await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, baseCfg(dir, 'main'));

    expect(result.lastExpectedDelta).toBeCloseTo(0.1, 6);
    // observed=0, expected=0.1 → drift=-0.1 (warn 0.05 이상)
    expect(Math.abs(result.lastDrift)).toBeGreaterThanOrEqual(0.05);
    expect(notifier.sendCritical).toHaveBeenCalledWith('wallet_delta_warn', expect.any(String));
  });

  it('backward-compat: unlabeled entries counted as main (no `wallet` field)', async () => {
    const walletManager = makeWalletManager([1.0, 1.0, 1.0]);
    const notifier = { sendCritical: jest.fn(async () => {}) };

    await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, baseCfg(dir, 'main'));
    // baseline 이후 unlabeled sell → main 으로 간주
    await writeFile(
      path.join(dir, 'executed-sells.jsonl'),
      JSON.stringify({ txSignature: 's3', receivedSol: 0.1 }) + '\n',
      { flag: 'a' }
    );
    const result = await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, baseCfg(dir, 'main'));

    expect(result.lastExpectedDelta).toBeCloseTo(0.1, 6);
  });

  it('sandbox wallet poller only sees sandbox ledger entries', async () => {
    const walletManager = makeWalletManager([0.5, 0.5, 0.5]);
    const notifier = { sendCritical: jest.fn(async () => {}) };
    await writeFile(
      path.join(dir, 'executed-sells.jsonl'),
      JSON.stringify({ txSignature: 'm1', receivedSol: 0.1, wallet: 'main' }) + '\n' +
      JSON.stringify({ txSignature: 's1', receivedSol: 0.05, wallet: 'sandbox' }) + '\n',
      { flag: 'a' }
    );

    await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, baseCfg(dir, 'sandbox'));
    const result = await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, baseCfg(dir, 'sandbox'));
    // sandbox wallet 에서 본 expected 는 sandbox 기록만 (0.05)
    // baseline 캡처 후 추가된 것이 없으므로 0
    expect(result.lastExpectedDelta).toBeCloseTo(0, 6);
  });
});
