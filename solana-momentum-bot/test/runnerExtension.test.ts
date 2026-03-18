import {
  shouldActivateRunner,
  runnerStateMap,
  degradedStateMap,
  RunnerActivation,
} from '../src/orchestration/tradeExecution';
import { Trade } from '../src/utils/types';
import { BotContext } from '../src/orchestration/types';

jest.mock('../src/utils/config', () => ({
  config: {
    runnerEnabled: true,
    runnerGradeBEnabled: false,
    degradedExitEnabled: false,
    tp1TimeExtensionMinutes: 30,
  },
}));

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'test-trade-1',
    pairAddress: 'SOL-PAIR',
    strategy: 'volume_spike',
    side: 'BUY',
    entryPrice: 1.0,
    quantity: 10,
    stopLoss: 0.9,
    takeProfit1: 1.3,
    takeProfit2: 1.6,
    trailingStop: 1.1,
    highWaterMark: 1.0,
    timeStopAt: new Date(Date.now() + 3600_000),
    status: 'OPEN',
    createdAt: new Date(),
    breakoutGrade: 'A',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<BotContext> = {}): BotContext {
  return {
    tradingHaltedReason: undefined,
    ...overrides,
  } as unknown as BotContext;
}

describe('Runner Extension', () => {
  beforeEach(() => {
    runnerStateMap.clear();
    degradedStateMap.clear();
  });

  it('activates runner for Grade A trade in risk-on regime', () => {
    const trade = makeTrade({ breakoutGrade: 'A' });
    const ctx = makeCtx();
    const result = shouldActivateRunner(trade, ctx);
    expect(result.activate).toBe(true);
    expect(result.sizeMultiplier).toBe(1.0);
  });

  it('does not activate for Grade C trades', () => {
    const tradeC = makeTrade({ breakoutGrade: 'C' });
    const ctx = makeCtx();
    const result = shouldActivateRunner(tradeC, ctx);
    expect(result.activate).toBe(false);
    expect(result.sizeMultiplier).toBe(0);
  });

  it('does not activate in risk-off regime (halted)', () => {
    const trade = makeTrade({ breakoutGrade: 'A' });
    const ctx = makeCtx({ tradingHaltedReason: 'Drawdown limit hit' });
    const result = shouldActivateRunner(trade, ctx);
    expect(result.activate).toBe(false);
  });

  it('does not activate for degraded trades', () => {
    const trade = makeTrade({ breakoutGrade: 'A' });
    const ctx = makeCtx();
    degradedStateMap.set(trade.id, { partialSoldAt: new Date(), pairAddress: trade.pairAddress });
    const result = shouldActivateRunner(trade, ctx);
    expect(result.activate).toBe(false);
  });

  it('does not activate when runnerEnabled=false', () => {
    const { config } = require('../src/utils/config');
    const original = config.runnerEnabled;
    (config as Record<string, unknown>).runnerEnabled = false;

    const trade = makeTrade({ breakoutGrade: 'A' });
    const ctx = makeCtx();
    const result = shouldActivateRunner(trade, ctx);
    expect(result.activate).toBe(false);

    (config as Record<string, unknown>).runnerEnabled = original;
  });

  // ─── v3: Grade B Runner Tests ───

  it('Grade B + flag off → does not activate', () => {
    const { config } = require('../src/utils/config');
    (config as Record<string, unknown>).runnerGradeBEnabled = false;

    const trade = makeTrade({ breakoutGrade: 'B' });
    const ctx = makeCtx();
    const result = shouldActivateRunner(trade, ctx);
    expect(result.activate).toBe(false);
    expect(result.sizeMultiplier).toBe(0);
  });

  it('Grade B + flag on → activates with 0.5x sizeMultiplier', () => {
    const { config } = require('../src/utils/config');
    (config as Record<string, unknown>).runnerGradeBEnabled = true;

    const trade = makeTrade({ breakoutGrade: 'B' });
    const ctx = makeCtx();
    const result = shouldActivateRunner(trade, ctx);
    expect(result.activate).toBe(true);
    expect(result.sizeMultiplier).toBe(0.5);

    // cleanup
    (config as Record<string, unknown>).runnerGradeBEnabled = false;
  });

  it('Grade A → full size regardless of Grade B flag', () => {
    const { config } = require('../src/utils/config');
    (config as Record<string, unknown>).runnerGradeBEnabled = true;

    const trade = makeTrade({ breakoutGrade: 'A' });
    const ctx = makeCtx();
    const result = shouldActivateRunner(trade, ctx);
    expect(result.activate).toBe(true);
    expect(result.sizeMultiplier).toBe(1.0);

    // cleanup
    (config as Record<string, unknown>).runnerGradeBEnabled = false;
  });
});
