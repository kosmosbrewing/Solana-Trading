import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  runWalletDeltaCheckOnceForTests,
  resetWalletDeltaComparatorForTests,
  getWalletDeltaComparatorState,
} from '../src/risk/walletDeltaComparator';
import { resetAllEntryHaltsForTests, isEntryHaltActive } from '../src/orchestration/entryIntegrity';

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

function makeNotifier() {
  return { sendCritical: jest.fn(async () => {}) };
}

async function prepareLedgerDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wallet-delta-test-'));
  return dir;
}

async function writeBuy(dir: string, entryPrice: number, quantity: number, tx = 'buy-tx'): Promise<void> {
  const line = JSON.stringify({ txSignature: tx, actualEntryPrice: entryPrice, actualQuantity: quantity });
  await writeFile(path.join(dir, 'executed-buys.jsonl'), line + '\n', { flag: 'a' });
}

async function writeSell(dir: string, receivedSol: number, tx = 'sell-tx'): Promise<void> {
  const line = JSON.stringify({ txSignature: tx, receivedSol });
  await writeFile(path.join(dir, 'executed-sells.jsonl'), line + '\n', { flag: 'a' });
}

describe('walletDeltaComparator', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await prepareLedgerDir();
    resetWalletDeltaComparatorForTests();
    resetAllEntryHaltsForTests();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const baseCfg = (overrides: Partial<Parameters<typeof runWalletDeltaCheckOnceForTests>[2]> = {}) => ({
    enabled: true,
    pollIntervalMs: 60_000,
    driftWarnSol: 0.05,
    driftHaltSol: 0.20,
    minSamplesBeforeAlert: 1,
    walletName: 'main',
    realtimeDataDir: dir,
    ...overrides,
  });

  it('no drift when observed matches expected (buy then sell loop)', async () => {
    // baseline=1.0, buy 0.5 SOL, sell returns 0.5 SOL → observed=0, expected=0
    await writeBuy(dir, 1.0, 0.5); // solSpent ≈ 0.5
    await writeSell(dir, 0.5); // received 0.5

    // baseline captured at balance=1.0, after buy+sell still 1.0 (neutral trade)
    const walletManager = makeWalletManager([1.0, 1.0]);
    const notifier = makeNotifier();
    const result = await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, baseCfg());

    // baseline은 첫 호출 시 캡처 → observedDelta=0
    // baseline ledger offsets 는 기록된 1/1 이므로 expected=0
    expect(result.lastObservedDelta).toBeCloseTo(0, 6);
    expect(result.lastExpectedDelta).toBeCloseTo(0, 6);
    expect(Math.abs(result.lastDrift)).toBeLessThan(0.05);
    expect(notifier.sendCritical).not.toHaveBeenCalled();
  });

  it('warns when drift exceeds warn threshold but below halt', async () => {
    // baseline balance=1.0. sell 0.1 SOL 기록 (expected +0.1). 실제 wallet 은 0.94 (observed -0.06).
    // drift = observed(-0.06) - expected(+0.1) = -0.16. warn(0.05) <= |0.16| < halt(0.20)
    // baseline 캡처 직후 ledger 에 sell 추가 → expected 계산 시 포함됨.
    const walletManager = makeWalletManager([1.0, 0.94]);
    const notifier = makeNotifier();

    // baseline 캡처 먼저
    await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, baseCfg());
    // ledger에 sell 추가 후 재 check
    await writeSell(dir, 0.1);
    const result = await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, baseCfg());

    expect(result.lastObservedDelta).toBeCloseTo(-0.06, 5);
    expect(result.lastExpectedDelta).toBeCloseTo(0.1, 5);
    expect(Math.abs(result.lastDrift)).toBeGreaterThan(0.05);
    expect(Math.abs(result.lastDrift)).toBeLessThan(0.20);
    expect(notifier.sendCritical).toHaveBeenCalledWith('wallet_delta_warn', expect.any(String));
    // halt 는 아직 발동 안함
    for (const lane of ['cupsey', 'migration', 'main', 'strategy_d', 'pure_ws_breakout'] as const) {
      expect(isEntryHaltActive(lane)).toBe(false);
    }
  });

  it('halts all lanes when drift exceeds halt threshold', async () => {
    // 큰 drift 시뮬: baseline 1.0 → 실제 0.7 (observed -0.3), expected +0.0 → drift -0.3
    const walletManager = makeWalletManager([1.0, 0.7]);
    const notifier = makeNotifier();

    await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, baseCfg());
    const result = await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, baseCfg());

    expect(Math.abs(result.lastDrift)).toBeGreaterThanOrEqual(0.20);
    expect(result.haltTriggered).toBe(true);
    expect(notifier.sendCritical).toHaveBeenCalledWith('wallet_delta_halt', expect.any(String));
    for (const lane of ['cupsey', 'migration', 'main', 'strategy_d', 'pure_ws_breakout'] as const) {
      expect(isEntryHaltActive(lane)).toBe(true);
    }
  });

  it('respects minSamplesBeforeAlert (suppresses single-sample drift)', async () => {
    // makeWalletManager: 1st call baseline fetch, 2nd call currentBalance (첫 check),
    // 3rd call 두 번째 check. balances 3개 필요.
    // baseline=1.0, 1st check=1.0 (no drift), 2nd check=0.94 (drift after sell).
    const walletManager = makeWalletManager([1.0, 1.0, 0.94]);
    const notifier = makeNotifier();
    const cfg = baseCfg({ minSamplesBeforeAlert: 2 });

    // baseline + first check (no drift)
    await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);
    // sell 추가 → drift 0.16 지만 breaches=1 < min=2 → suppressed
    await writeSell(dir, 0.1);
    const result = await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);

    expect(result.consecutiveDriftBreaches).toBe(1);
    expect(notifier.sendCritical).not.toHaveBeenCalled();
  });

  it('baseline ledger offsets exclude pre-existing entries', async () => {
    // 시작 전에 이미 1 buy 있음 (과거 trade). baseline 은 이걸 skip 해야 함.
    await writeBuy(dir, 1.0, 0.5, 'pre-buy');

    const walletManager = makeWalletManager([1.0, 1.0]);
    const notifier = makeNotifier();
    const result = await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, baseCfg());

    // pre-existing buy 는 baseline offset 에 포함되어 expected 계산에서 제외
    expect(result.lastExpectedDelta).toBeCloseTo(0, 6);
    expect(Math.abs(result.lastDrift)).toBeLessThan(0.05);
  });

  it('getWalletDeltaComparatorState exposes read-only snapshot', () => {
    const snapshot = getWalletDeltaComparatorState();
    expect(snapshot).toHaveProperty('baselineBalanceSol');
    expect(snapshot).toHaveProperty('lastDrift');
    expect(snapshot).toHaveProperty('haltTriggered');
  });
});
