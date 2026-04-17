import {
  isWalletStopActive,
  getWalletStopGuardState,
  startWalletStopGuard,
  stopWalletStopGuardPoller,
  resetWalletStopGuard,
  resetWalletStopGuardForTests,
  setWalletStopGuardStateForTests,
} from '../src/risk/walletStopGuard';

function makeMockWalletManager(balances: number[]): { getBalance: jest.Mock } {
  let idx = 0;
  const getBalance = jest.fn(async (_name: string): Promise<number> => {
    const v = balances[Math.min(idx, balances.length - 1)];
    idx++;
    return v;
  });
  return { getBalance };
}

function makeMockNotifier(): { sendCritical: jest.Mock } {
  return {
    sendCritical: jest.fn(async (_k: string, _m: string): Promise<void> => {}),
  };
}

describe('walletStopGuard', () => {
  beforeEach(() => {
    resetWalletStopGuardForTests();
  });

  afterEach(() => {
    stopWalletStopGuardPoller();
    resetWalletStopGuardForTests();
  });

  it('is inactive by default', () => {
    expect(isWalletStopActive()).toBe(false);
  });

  it('setWalletStopGuardStateForTests activates/deactivates', () => {
    setWalletStopGuardStateForTests(true, 'test-trigger');
    expect(isWalletStopActive()).toBe(true);
    expect(getWalletStopGuardState().triggerReason).toBe('test-trigger');
    setWalletStopGuardStateForTests(false);
    expect(isWalletStopActive()).toBe(false);
  });

  it('activates when balance drops below threshold', async () => {
    const wm = makeMockWalletManager([0.5]);
    const notifier = makeMockNotifier();
    startWalletStopGuard(
      wm as unknown as Parameters<typeof startWalletStopGuard>[0],
      notifier as unknown as Parameters<typeof startWalletStopGuard>[1],
      { minWalletSol: 0.8, pollIntervalMs: 60_000, walletName: 'main' }
    );
    // 초기 즉시 체크는 async 이므로 microtask flush
    await new Promise((r) => setImmediate(r));
    // 한번 더 yield
    await new Promise((r) => setImmediate(r));
    expect(isWalletStopActive()).toBe(true);
    expect(notifier.sendCritical).toHaveBeenCalledTimes(1);
  });

  it('does not trigger when balance is healthy', async () => {
    const wm = makeMockWalletManager([1.2]);
    const notifier = makeMockNotifier();
    startWalletStopGuard(
      wm as unknown as Parameters<typeof startWalletStopGuard>[0],
      notifier as unknown as Parameters<typeof startWalletStopGuard>[1],
      { minWalletSol: 0.8, pollIntervalMs: 60_000, walletName: 'main' }
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(isWalletStopActive()).toBe(false);
    expect(notifier.sendCritical).not.toHaveBeenCalled();
  });

  it('only triggers notifier once even if balance stays low', async () => {
    jest.useFakeTimers();
    try {
      const wm = makeMockWalletManager([0.3, 0.3, 0.3]);
      const notifier = makeMockNotifier();
      startWalletStopGuard(
        wm as unknown as Parameters<typeof startWalletStopGuard>[0],
        notifier as unknown as Parameters<typeof startWalletStopGuard>[1],
        { minWalletSol: 0.8, pollIntervalMs: 1000, walletName: 'main' }
      );
      // flush initial microtask
      await Promise.resolve();
      await Promise.resolve();
      // Advance interval twice
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(isWalletStopActive()).toBe(true);
      expect(notifier.sendCritical).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      stopWalletStopGuardPoller();
    }
  });

  it('resetWalletStopGuard clears active state', () => {
    setWalletStopGuardStateForTests(true, 'fake');
    expect(isWalletStopActive()).toBe(true);
    resetWalletStopGuard('manual-test');
    expect(isWalletStopActive()).toBe(false);
    expect(getWalletStopGuardState().triggerReason).toBeNull();
  });

  it('resetWalletStopGuard on inactive state is noop', () => {
    expect(isWalletStopActive()).toBe(false);
    resetWalletStopGuard('noop-test');
    expect(isWalletStopActive()).toBe(false);
  });

  it('triggers fail-safe halt after consecutive RPC failures', async () => {
    jest.useFakeTimers();
    try {
      const wm = { getBalance: jest.fn(async () => { throw new Error('RPC 429'); }) };
      const notifier = makeMockNotifier();
      startWalletStopGuard(
        wm as unknown as Parameters<typeof startWalletStopGuard>[0],
        notifier as unknown as Parameters<typeof startWalletStopGuard>[1],
        { minWalletSol: 0.8, pollIntervalMs: 1000, walletName: 'main', rpcFailSafeThreshold: 3 }
      );
      // initial check (microtask flush)
      await Promise.resolve();
      await Promise.resolve();
      expect(isWalletStopActive()).toBe(false); // 1 failure, below threshold
      // 2nd failure
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
      expect(isWalletStopActive()).toBe(false);
      // 3rd failure → fail-safe trigger
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
      expect(isWalletStopActive()).toBe(true);
      expect(getWalletStopGuardState().triggerReason).toContain('RPC failure');
      expect(notifier.sendCritical).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      stopWalletStopGuardPoller();
    }
  });

  it('resets consecutive failure counter on successful balance check', async () => {
    jest.useFakeTimers();
    try {
      let attempt = 0;
      const wm = {
        getBalance: jest.fn(async () => {
          attempt++;
          if (attempt < 2) throw new Error('RPC timeout');
          return 1.5; // 2번째 시도부터 성공
        }),
      };
      const notifier = makeMockNotifier();
      startWalletStopGuard(
        wm as unknown as Parameters<typeof startWalletStopGuard>[0],
        notifier as unknown as Parameters<typeof startWalletStopGuard>[1],
        { minWalletSol: 0.8, pollIntervalMs: 1000, walletName: 'main', rpcFailSafeThreshold: 3 }
      );
      await Promise.resolve();
      await Promise.resolve();
      // 1회 실패 후 2회차 성공 → counter 리셋
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
      expect(getWalletStopGuardState().consecutiveRpcFailures).toBe(0);
      expect(isWalletStopActive()).toBe(false);
    } finally {
      jest.useRealTimers();
      stopWalletStopGuardPoller();
    }
  });
});
