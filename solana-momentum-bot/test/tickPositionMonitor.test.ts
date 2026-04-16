import { checkTickLevelExit, _resetCacheForTest } from '../src/orchestration/tickPositionMonitor';
import { BotContext } from '../src/orchestration/types';
import { Trade } from '../src/utils/types';

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'trade-001',
    pairAddress: 'PAIR_A',
    strategy: 'tick_momentum',
    side: 'BUY',
    entryPrice: 1.0,
    quantity: 100,
    status: 'OPEN',
    createdAt: new Date(),
    stopLoss: 0.9,
    takeProfit1: 1.3,
    takeProfit2: 1.8,
    timeStopAt: new Date(Date.now() + 3600_000),
    ...overrides,
  };
}

function makeCtx(openTrades: Trade[], overrides: Partial<BotContext> = {}): BotContext {
  return {
    tradeStore: {
      getOpenTrades: jest.fn().mockResolvedValue(openTrades),
      updateHighWaterMark: jest.fn().mockResolvedValue(undefined),
    },
    executionLock: {
      isLocked: jest.fn().mockReturnValue(false),
    },
    ...overrides,
  } as unknown as BotContext;
}

describe('checkTickLevelExit', () => {
  beforeEach(() => {
    // Why: 테스트 간 캐시 격리 — 이전 테스트의 캐시된 trades가 다음 테스트에 영향 방지
    _resetCacheForTest();
  });

  it('should skip when no matching trade', async () => {
    const ctx = makeCtx([]);
    await checkTickLevelExit('PAIR_B', 1.5, ctx);
    expect(ctx.tradeStore.getOpenTrades).toHaveBeenCalled();
  });

  it('should ignore sandbox strategies in the cached open-trade set', async () => {
    const sandboxTrade = makeTrade({
      strategy: 'cupsey_flip_10s',
      stopLoss: 1.5,
    });
    const ctx = makeCtx([sandboxTrade]);

    await checkTickLevelExit('PAIR_A', 1.0, ctx);

    expect(ctx.tradeStore.getOpenTrades).toHaveBeenCalledTimes(1);
    expect(ctx.tradeStore.updateHighWaterMark).not.toHaveBeenCalled();
  });

  it('should skip when execution lock is held', async () => {
    const trade = makeTrade();
    const ctx = makeCtx([trade]);
    (ctx.executionLock.isLocked as jest.Mock).mockReturnValue(true);

    await checkTickLevelExit('PAIR_A', 0.5, ctx);
    // Should not attempt exit — lock held
  });

  it('should update high water mark when price exceeds current', async () => {
    const trade = makeTrade({ highWaterMark: 1.2 });
    const ctx = makeCtx([trade]);

    // Price above HWM but below TP levels
    await checkTickLevelExit('PAIR_A', 1.25, ctx);
    expect(ctx.tradeStore.updateHighWaterMark).toHaveBeenCalledWith('trade-001', 1.25);
  });

  it('should not update HWM when price is below current HWM', async () => {
    const trade = makeTrade({ highWaterMark: 1.5 });
    const ctx = makeCtx([trade]);

    await checkTickLevelExit('PAIR_A', 1.2, ctx);
    expect(ctx.tradeStore.updateHighWaterMark).not.toHaveBeenCalled();
  });

  it('should use cached trades within TTL', async () => {
    const trade = makeTrade();
    const ctx = makeCtx([trade]);

    // First call — cache miss, fetches from DB
    await checkTickLevelExit('PAIR_A', 1.1, ctx);
    // Second call — cache hit within 1s TTL
    await checkTickLevelExit('PAIR_A', 1.1, ctx);

    // getOpenTrades should only be called once (cached)
    expect(ctx.tradeStore.getOpenTrades).toHaveBeenCalledTimes(1);
  });

  it('should not handle TP1/TP2 (delegated to polling for runner/partial logic)', async () => {
    const trade = makeTrade({ stopLoss: 0.5, takeProfit1: 1.3, takeProfit2: 1.8 });
    const ctx = makeCtx([trade]);

    // Price hits TP2 — tick monitor should NOT close (runner logic needed)
    await checkTickLevelExit('PAIR_A', 2.0, ctx);
    // Only HWM update should happen, no closeTrade
    expect(ctx.tradeStore.updateHighWaterMark).not.toHaveBeenCalled();
    // (no HWM set, so no update — but no close either)
  });
});
