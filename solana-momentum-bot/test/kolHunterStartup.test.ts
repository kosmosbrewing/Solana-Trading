import { startKolTrackerWithPreparedHunter, type KolTrackerStartupLike } from '../src/init/kolHunterStartup';
import type { KolTx } from '../src/kol/types';
import type { BotContext } from '../src/orchestration/types';

function makeCtx(tradingMode: 'paper' | 'live' = 'live'): BotContext {
  return {
    tradingMode,
    onchainSecurityClient: {} as never,
    gateCache: {} as never,
  } as unknown as BotContext;
}

function makeLogger(calls: string[]) {
  return {
    info: jest.fn((_message: string) => calls.push('log_info')),
    warn: jest.fn((_message: string) => calls.push('log_warn')),
  };
}

describe('startKolTrackerWithPreparedHunter', () => {
  it('prepares live cooldown and listener before tracker start', async () => {
    const calls: string[] = [];
    let listener: ((tx: KolTx) => void) | null = null;
    const tracker: KolTrackerStartupLike = {
      on: jest.fn((_event: 'kol_swap', cb: (tx: KolTx) => void) => {
        calls.push('listener');
        listener = cb;
        return tracker;
      }),
      start: jest.fn(async () => {
        calls.push('start');
      }),
    };
    const handleKolSwap = jest.fn(async () => {
      calls.push('handle');
    });

    await startKolTrackerWithPreparedHunter({
      tracker,
      ctx: makeCtx('live'),
      notifier: {} as never,
      log: makeLogger(calls),
      activeKols: 16,
      kolHunterEnabled: true,
      kolHunterLiveCanaryEnabled: true,
      kolHunterPaperOnly: false,
      runtime: {
        initKolHunter: jest.fn(() => calls.push('init')),
        hydrateLiveExecutionQualityCooldownsFromLedger: jest.fn(async () => {
          calls.push('hydrate');
          return { loaded: 1, hydrated: 1, skippedExpired: 0 };
        }),
        handleKolSwap,
        initKolPaperNotifier: jest.fn(() => calls.push('notifier')),
      },
    });

    expect(calls.slice(0, 5)).toEqual(['init', 'hydrate', 'log_info', 'listener', 'notifier']);
    expect(calls).toContain('start');
    expect(calls.indexOf('listener')).toBeLessThan(calls.indexOf('start'));
    expect(calls.indexOf('hydrate')).toBeLessThan(calls.indexOf('start'));

    expect(listener).not.toBeNull();
    const registeredListener = listener as unknown as (tx: KolTx) => void;
    const tx = { tokenMint: 'mint-1' } as unknown as KolTx;
    registeredListener(tx);
    await Promise.resolve();
    expect(handleKolSwap).toHaveBeenCalledWith(tx);
  });

  it('starts tracker without hunter wiring when kol hunter is disabled', async () => {
    const calls: string[] = [];
    const tracker: KolTrackerStartupLike = {
      on: jest.fn(() => {
        calls.push('listener');
      }),
      start: jest.fn(async () => {
        calls.push('start');
      }),
    };
    const initKolHunter = jest.fn(() => calls.push('init'));
    const hydrateLiveExecutionQualityCooldownsFromLedger = jest.fn(async () => {
      calls.push('hydrate');
      return { loaded: 1, hydrated: 1, skippedExpired: 0 };
    });

    await startKolTrackerWithPreparedHunter({
      tracker,
      ctx: makeCtx('live'),
      notifier: {} as never,
      log: makeLogger(calls),
      activeKols: 16,
      kolHunterEnabled: false,
      kolHunterLiveCanaryEnabled: true,
      kolHunterPaperOnly: false,
      runtime: {
        initKolHunter,
        hydrateLiveExecutionQualityCooldownsFromLedger,
        handleKolSwap: jest.fn(async () => {}),
        initKolPaperNotifier: jest.fn(() => calls.push('notifier')),
      },
    });

    expect(initKolHunter).not.toHaveBeenCalled();
    expect(hydrateLiveExecutionQualityCooldownsFromLedger).not.toHaveBeenCalled();
    expect(tracker.on).not.toHaveBeenCalled();
    expect(calls).toEqual(['start', 'log_info']);
  });
});
