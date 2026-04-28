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

  // 2026-04-28 Sprint A1 — wallet_delta_warn dedup/cooldown.
  // 운영 incident — 6h 동안 동일 drift 0.04~0.05 SOL spam 108회 (5분 polling × 발동)
  // → 운영자 critical alert 무딘화 위험. 동일 drift 값은 cooldown 안에 sendCritical skip.
  //
  // Setup pattern: 동일 drift 를 보장하려면 baseline 캡처 시점에 ledger 에 이미 sell 이 있어야
  // 한다. baseline ledger offset 에 그 sell 이 포함되어 expected delta 계산에서 제외 → 이후
  // 같은 balance 를 반환하면 observed=expected 가 되어 drift=0. 따라서 다른 패턴 사용:
  // wallet manager 가 매 check 마다 다른 balance 를 반환하지만 ledger 도 그에 맞춰 같이
  // 변화하면 drift 값이 일정.
  describe('Sprint A1 — warn alert dedup/cooldown', () => {
    it('동일 drift 값이 cooldown 내 재발동 시 sendCritical skip', async () => {
      // baseline 1.0 → 0.94 (warn 임계 -0.06 SOL drift). 같은 wallet 반환 → 같은 drift 유지.
      const walletManager = makeWalletManager([1.0, 0.94, 0.94, 0.94, 0.94, 0.94]);
      const notifier = makeNotifier();
      const cfg = baseCfg({
        warnAlertCooldownMs: 1_800_000,
        warnDriftDeltaToleranceSol: 0.005,
      });

      // baseline 캡처
      await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);
      // 1st warn check — drift -0.06, alert 발동
      await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);
      expect(notifier.sendCritical).toHaveBeenCalledTimes(1);
      const firstDrift = getWalletDeltaComparatorState().lastDrift;

      // 2회 더 check — 같은 balance, ledger 변화 없음 → drift 동일 → cooldown 으로 skip
      await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);
      await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);
      expect(notifier.sendCritical).toHaveBeenCalledTimes(1);
      expect(getWalletDeltaComparatorState().lastDrift).toBeCloseTo(firstDrift, 6);
    });

    it('새 drift 값 (변화 ≥ tolerance) 은 cooldown 무시하고 재발동', async () => {
      // baseline 1.0 → balance 0.94 (drift1=-0.06, alert 1) → balance 0.88 (drift2=-0.12, 새 drift)
      // makeWalletManager 의 mock 은 매 호출마다 i++ — 첫 run 은 getBalance 2번 (baseline+current).
      const walletManager = makeWalletManager([1.0, 0.94, 0.88, 0.88]);
      const notifier = makeNotifier();
      const cfg = baseCfg({
        warnAlertCooldownMs: 1_800_000,
        warnDriftDeltaToleranceSol: 0.005,
      });

      // 1st run: baseline 1.0 + current 0.94 → drift -0.06 → alert (count=1)
      await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);
      expect(notifier.sendCritical).toHaveBeenCalledTimes(1);

      // 2nd run: current 0.88 → drift -0.12, 변화 0.06 > tolerance 0.005 → 새 drift, alert (count=2)
      await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);
      expect(notifier.sendCritical).toHaveBeenCalledTimes(2);

      // 3rd run: current 0.88 (unchanged) → drift -0.12 동일, cooldown 안 → skip
      await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);
      expect(notifier.sendCritical).toHaveBeenCalledTimes(2);
    });

    // 2026-04-28 QA Q9: drift 회복 후 재발생 시 dedup state 가 stale 하면 운영자 미수신.
    // 회복 시점에 lastWarnAlertAtMs/Drift 도 reset 되어야 다음 breach 즉시 alert.
    it('drift 회복 후 동일 값으로 재발생 시 알림 재발동 (Q9)', async () => {
      // baseline 1.0 → 0.94 (warn) → 0.99 (recover, < 0.05 drift) → 0.94 (재발생)
      const walletManager = makeWalletManager([1.0, 0.94, 0.99, 0.94]);
      const notifier = makeNotifier();
      const cfg = baseCfg({
        warnAlertCooldownMs: 1_800_000,
        warnDriftDeltaToleranceSol: 0.005,
      });

      // 1st run: baseline + drift -0.06 → alert 1
      await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);
      expect(notifier.sendCritical).toHaveBeenCalledTimes(1);

      // 2nd run: drift -0.01 < warn → recover, dedup state reset 되어야 함
      await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);
      expect(notifier.sendCritical).toHaveBeenCalledTimes(1);  // 회복은 alert 안 함

      // 3rd run: drift -0.06 (재발생, 이전 값과 동일하지만 회복 후라 새 incident)
      await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);
      // dedup state 가 reset 됐으면 alert 재발동 (count=2)
      expect(notifier.sendCritical).toHaveBeenCalledTimes(2);
    });

    it('cooldown 경과 후 동일 drift 는 재발동 (운영자 reminder)', async () => {
      const walletManager = makeWalletManager([1.0, 0.94, 0.94, 0.94]);
      const notifier = makeNotifier();
      const cfg = baseCfg({
        warnAlertCooldownMs: 100,
        warnDriftDeltaToleranceSol: 0.005,
      });

      await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);
      await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);
      expect(notifier.sendCritical).toHaveBeenCalledTimes(1);

      // cooldown 안 → skip
      await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);
      expect(notifier.sendCritical).toHaveBeenCalledTimes(1);

      // cooldown 경과 → 재발동
      await new Promise((resolve) => setTimeout(resolve, 150));
      await runWalletDeltaCheckOnceForTests(walletManager as any, notifier as any, cfg);
      expect(notifier.sendCritical).toHaveBeenCalledTimes(2);
    });
  });
});
