import {
  isEntryHaltActive,
  triggerEntryHalt,
  resetEntryHalt,
  resetAllEntryHaltsForTests,
  getAllLaneIntegrityState,
  persistOpenTradeWithIntegrity,
} from '../src/orchestration/entryIntegrity';
import type { BotContext } from '../src/orchestration/types';
import type { Trade } from '../src/utils/types';

function makeCtx(insertImpl: (t: Omit<Trade, 'id'>) => Promise<string>, mode: 'live' | 'paper' = 'live'): { ctx: BotContext; notifier: { sendCritical: jest.Mock } } {
  const notifier = { sendCritical: jest.fn(async () => {}) };
  const tradeStore = { insertTrade: jest.fn(insertImpl) };
  const ctx = { tradingMode: mode, tradeStore, notifier } as unknown as BotContext;
  return { ctx, notifier };
}

function makeTradeData(): Omit<Trade, 'id'> {
  return {
    pairAddress: 'PAIR',
    strategy: 'volume_spike',
    side: 'BUY',
    tokenSymbol: 'TST',
    entryPrice: 1.0,
    quantity: 10,
    stopLoss: 0.99,
    takeProfit1: 1.01,
    takeProfit2: 1.05,
    highWaterMark: 1.0,
    timeStopAt: new Date(),
    status: 'OPEN',
    txSignature: 'BUYTX',
    createdAt: new Date(),
  };
}

describe('entryIntegrity', () => {
  beforeEach(() => {
    resetAllEntryHaltsForTests();
  });

  describe('halt API', () => {
    it('is inactive by default for all lanes', () => {
      for (const lane of ['cupsey', 'migration', 'main', 'strategy_d'] as const) {
        expect(isEntryHaltActive(lane)).toBe(false);
      }
    });

    it('triggerEntryHalt activates only the targeted lane', () => {
      triggerEntryHalt('main', 'test-reason');
      expect(isEntryHaltActive('main')).toBe(true);
      expect(isEntryHaltActive('migration')).toBe(false);
      expect(isEntryHaltActive('cupsey')).toBe(false);
      expect(isEntryHaltActive('strategy_d')).toBe(false);
    });

    it('second triggerEntryHalt on same lane is noop (idempotent)', () => {
      triggerEntryHalt('main', 'reason-1');
      const first = getAllLaneIntegrityState().main;
      triggerEntryHalt('main', 'reason-2');
      const second = getAllLaneIntegrityState().main;
      expect(second.triggerReason).toBe(first.triggerReason); // 덮어쓰지 않음
    });

    it('resetEntryHalt clears active lane', () => {
      triggerEntryHalt('migration', 'x');
      expect(isEntryHaltActive('migration')).toBe(true);
      resetEntryHalt('migration', 'manual-test');
      expect(isEntryHaltActive('migration')).toBe(false);
    });

    it('resetEntryHalt on inactive lane is noop', () => {
      resetEntryHalt('main', 'noop-test');
      expect(isEntryHaltActive('main')).toBe(false);
    });
  });

  describe('persistOpenTradeWithIntegrity', () => {
    it('returns dbTradeId on success', async () => {
      const { ctx } = makeCtx(async () => 'db-id-1');
      const result = await persistOpenTradeWithIntegrity({
        ctx,
        lane: 'main',
        tradeData: makeTradeData(),
        ledgerEntry: { txSignature: 'BUYTX', strategy: 'volume_spike' },
        notifierKey: 'test',
        buildNotifierMessage: () => 'test message',
      });
      expect(result.dbTradeId).toBe('db-id-1');
      expect(result.halted).toBe(false);
      expect(isEntryHaltActive('main')).toBe(false);
    });

    it('triggers halt on insertTrade failure (live mode)', async () => {
      const { ctx, notifier } = makeCtx(async () => { throw new Error('db down'); }, 'live');
      const result = await persistOpenTradeWithIntegrity({
        ctx,
        lane: 'main',
        tradeData: makeTradeData(),
        ledgerEntry: { txSignature: 'BUYTX-fail-1' },
        notifierKey: 'main_open_persist',
        buildNotifierMessage: (err) => `DB fail: ${err}`,
      });
      expect(result.dbTradeId).toBeNull();
      expect(result.halted).toBe(true);
      expect(isEntryHaltActive('main')).toBe(true);
      expect(notifier.sendCritical).toHaveBeenCalledTimes(1);
      expect(notifier.sendCritical).toHaveBeenCalledWith(
        'main_open_persist',
        expect.stringContaining('DB fail')
      );
    });

    it('does NOT trigger halt in paper mode (halt-on-failure default true but paper override)', async () => {
      const { ctx, notifier } = makeCtx(async () => { throw new Error('db down'); }, 'paper');
      const result = await persistOpenTradeWithIntegrity({
        ctx,
        lane: 'main',
        tradeData: makeTradeData(),
        ledgerEntry: { txSignature: 'BUYTX-paper' },
        notifierKey: 'main_open_persist',
        buildNotifierMessage: () => 'paper fail',
      });
      expect(result.halted).toBe(false);
      expect(isEntryHaltActive('main')).toBe(false);
      // Notifier는 여전히 호출 (paper 모드여도 알람은 유효)
      expect(notifier.sendCritical).toHaveBeenCalledTimes(1);
    });

    it('haltOnFailure=false disables halt even in live mode', async () => {
      const { ctx } = makeCtx(async () => { throw new Error('db down'); }, 'live');
      const result = await persistOpenTradeWithIntegrity({
        ctx,
        lane: 'migration',
        tradeData: makeTradeData(),
        ledgerEntry: { txSignature: 'BUYTX-noH' },
        notifierKey: 'migration_open_persist',
        buildNotifierMessage: () => 'no halt',
        haltOnFailure: false,
      });
      expect(result.halted).toBe(false);
      expect(isEntryHaltActive('migration')).toBe(false);
    });

    it('isolates halt per-lane — main halt does not block migration', async () => {
      triggerEntryHalt('main', 'isolated-test');
      expect(isEntryHaltActive('main')).toBe(true);
      expect(isEntryHaltActive('migration')).toBe(false);

      const { ctx } = makeCtx(async () => 'mig-id');
      const result = await persistOpenTradeWithIntegrity({
        ctx,
        lane: 'migration',
        tradeData: makeTradeData(),
        ledgerEntry: { txSignature: 'MIGTX' },
        notifierKey: 'migration_open_persist',
        buildNotifierMessage: () => 'fail',
      });
      expect(result.dbTradeId).toBe('mig-id'); // migration은 정상
      expect(isEntryHaltActive('migration')).toBe(false);
    });
  });
});
