/**
 * Pure WS Breakout Handler tests (Block 3, 2026-04-18).
 * 설계: docs/design-docs/pure-ws-breakout-lane-2026-04-18.md
 */
import {
  updatePureWsPositions,
  getActivePureWsPositions,
  addPureWsPositionForTests,
  resetPureWsLaneStateForTests,
  getPureWsFunnelStats,
  resolvePureWsWalletLabel,
} from '../src/orchestration/pureWsBreakoutHandler';
import { resetAllEntryHaltsForTests, triggerEntryHalt } from '../src/orchestration/entryIntegrity';
import { resetWalletStopGuardForTests, setWalletStopGuardStateForTests } from '../src/risk/walletStopGuard';
import type { BotContext } from '../src/orchestration/types';
import type { MicroCandleBuilder } from '../src/realtime';
import { config } from '../src/utils/config';

// config.pureWsLaneEnabled override via Object.defineProperty (readonly fields via `as const`)
function enableLane(): void {
  Object.defineProperty(config, 'pureWsLaneEnabled', { value: true, writable: true, configurable: true });
}
function disableLane(): void {
  Object.defineProperty(config, 'pureWsLaneEnabled', { value: false, writable: true, configurable: true });
}

function makeBuilder(priceByPair: Map<string, number>): MicroCandleBuilder {
  return {
    getCurrentPrice: (pair: string) => priceByPair.get(pair) ?? null,
    getRecentCandles: () => [],
  } as unknown as MicroCandleBuilder;
}

function makeCtx(): { ctx: BotContext; notifier: { sendCritical: jest.Mock; sendTradeClose: jest.Mock; sendInfo: jest.Mock }; tradeStore: { insertTrade: jest.Mock; closeTrade: jest.Mock; getOpenTrades: jest.Mock } } {
  const notifier = {
    sendCritical: jest.fn(async () => {}),
    sendTradeClose: jest.fn(async () => {}),
    sendInfo: jest.fn(async () => {}),
  };
  const tradeStore = {
    insertTrade: jest.fn(async () => 'db-trade-id'),
    closeTrade: jest.fn(async () => {}),
    getOpenTrades: jest.fn(async () => []),
  };
  const ctx = {
    tradingMode: 'paper',
    notifier,
    tradeStore,
    executor: { name: 'main-exec' },
  } as unknown as BotContext;
  return { ctx, notifier, tradeStore };
}

function seedProbePosition(pair: string, entryPrice: number, entryTimeSec: number, state: 'PROBE' | 'RUNNER_T1' | 'RUNNER_T2' | 'RUNNER_T3' = 'PROBE'): void {
  addPureWsPositionForTests({
    tradeId: `purews-${pair.slice(0, 8)}-${entryTimeSec}`,
    dbTradeId: 'db-1',
    pairAddress: pair,
    entryPrice,
    entryTimeSec,
    quantity: 100,
    state,
    peakPrice: entryPrice,
    troughPrice: entryPrice,
  });
}

const nowSec = () => Math.floor(Date.now() / 1000);

describe('pureWsBreakoutHandler — tiered runner', () => {
  beforeEach(() => {
    enableLane();
    resetPureWsLaneStateForTests();
    resetAllEntryHaltsForTests();
    resetWalletStopGuardForTests();
  });

  afterEach(() => {
    disableLane();
  });

  it('PROBE hardcut closes when MAE ≤ -3%', async () => {
    const pair = 'PAIR1';
    seedProbePosition(pair, 1.0, nowSec());
    const builder = makeBuilder(new Map([[pair, 0.96]])); // -4% → hardcut
    const { ctx, tradeStore } = makeCtx();

    await updatePureWsPositions(ctx, builder);

    expect(tradeStore.closeTrade).toHaveBeenCalled();
    const state = [...getActivePureWsPositions().values()][0];
    expect(state.state).toBe('CLOSED');
    expect(getPureWsFunnelStats().closedTrades).toBe(1);
  });

  it('PROBE timeout closes when flat after window expires', async () => {
    const pair = 'PAIR2';
    const oldTime = nowSec() - (config.pureWsProbeWindowSec + 5);
    seedProbePosition(pair, 1.0, oldTime);
    const builder = makeBuilder(new Map([[pair, 1.01]])); // +1% flat
    const { ctx, tradeStore } = makeCtx();

    await updatePureWsPositions(ctx, builder);

    expect(tradeStore.closeTrade).toHaveBeenCalled();
    const state = [...getActivePureWsPositions().values()][0];
    expect(state.state).toBe('CLOSED');
  });

  it('PROBE → RUNNER_T1 when MFE ≥ +100%', async () => {
    const pair = 'PAIR3';
    seedProbePosition(pair, 1.0, nowSec());
    const builder = makeBuilder(new Map([[pair, 2.0]])); // +100% → T1
    const { ctx } = makeCtx();

    await updatePureWsPositions(ctx, builder);

    const state = [...getActivePureWsPositions().values()][0];
    expect(state.state).toBe('RUNNER_T1');
    expect(getPureWsFunnelStats().winnersT1).toBe(1);
  });

  it('RUNNER_T1 → RUNNER_T2 when MFE ≥ +400% + sets breakeven lock', async () => {
    const pair = 'PAIR4';
    seedProbePosition(pair, 1.0, nowSec(), 'RUNNER_T1');
    const builder = makeBuilder(new Map([[pair, 5.0]])); // +400% → T2
    const { ctx } = makeCtx();

    await updatePureWsPositions(ctx, builder);

    const state = [...getActivePureWsPositions().values()][0];
    expect(state.state).toBe('RUNNER_T2');
    expect(state.t2BreakevenLockPrice).toBeCloseTo(1.0 * config.pureWsT2BreakevenLockMultiplier, 6);
    expect(getPureWsFunnelStats().winnersT2).toBe(1);
  });

  it('RUNNER_T2 → RUNNER_T3 when MFE ≥ +900%', async () => {
    const pair = 'PAIR5';
    seedProbePosition(pair, 1.0, nowSec(), 'RUNNER_T2');
    // seed peak already at T2, simulate climb
    const positions = getActivePureWsPositions();
    const pos = [...positions.values()][0];
    pos.peakPrice = 5.0;
    pos.t2BreakevenLockPrice = 3.0;

    const builder = makeBuilder(new Map([[pair, 10.0]])); // +900% → T3
    const { ctx } = makeCtx();

    await updatePureWsPositions(ctx, builder);

    const state = [...getActivePureWsPositions().values()][0];
    expect(state.state).toBe('RUNNER_T3');
    expect(getPureWsFunnelStats().winnersT3).toBe(1);
  });

  it('T2 breakeven lock floors close price above entry × 3', async () => {
    const pair = 'PAIR6';
    seedProbePosition(pair, 1.0, nowSec(), 'RUNNER_T2');
    // peak = 5.0, lock = 3.0. 만약 trail 15% 만 썼으면 stop = 4.25. lock 이 둘 중 더 타이트하면 그 값 사용.
    const positions = getActivePureWsPositions();
    const pos = [...positions.values()][0];
    pos.peakPrice = 5.0;
    pos.t2BreakevenLockPrice = 3.0;

    // trail15 stop = 5.0 × 0.85 = 4.25. lock = 3.0. max(4.25, 3.0) = 4.25.
    // currentPrice 4.3 → 여전히 trail 위, close 안함.
    let builder = makeBuilder(new Map([[pair, 4.3]]));
    const { ctx, tradeStore } = makeCtx();
    await updatePureWsPositions(ctx, builder);
    expect([...getActivePureWsPositions().values()][0].state).toBe('RUNNER_T2');

    // currentPrice 4.2 → below trail(4.25) and above lock(3.0). max(4.25, 3.0)=4.25 breach → close.
    builder = makeBuilder(new Map([[pair, 4.2]]));
    await updatePureWsPositions(ctx, builder);
    expect(tradeStore.closeTrade).toHaveBeenCalled();
  });

  it('T2 lock prevents close below entry × 3 (never 3x loser)', async () => {
    const pair = 'PAIR7';
    seedProbePosition(pair, 1.0, nowSec(), 'RUNNER_T2');
    const positions = getActivePureWsPositions();
    const pos = [...positions.values()][0];
    // peak = 3.5, trail 15% = 2.975. lock = 3.0. max(2.975, 3.0) = 3.0.
    pos.peakPrice = 3.5;
    pos.t2BreakevenLockPrice = 3.0;

    // currentPrice 3.05 → above lock(3.0), trail bruise(2.975). Should NOT close.
    const builder = makeBuilder(new Map([[pair, 3.05]]));
    const { ctx, tradeStore } = makeCtx();
    await updatePureWsPositions(ctx, builder);

    expect([...getActivePureWsPositions().values()][0].state).toBe('RUNNER_T2');
    expect(tradeStore.closeTrade).not.toHaveBeenCalled();
  });

  it('HWM peak sanity caps spurious spikes', async () => {
    const pair = 'PAIR8';
    seedProbePosition(pair, 1.0, nowSec());
    const positions = getActivePureWsPositions();
    const pos = [...positions.values()][0];
    const priorPeak = pos.peakPrice;

    // spurious spike: 1.0 × 20 (> pureWsMaxPeakMultiplier=15)
    const builder = makeBuilder(new Map([[pair, 20.0]]));
    const { ctx } = makeCtx();
    await updatePureWsPositions(ctx, builder);

    // peak should not update (stays at priorPeak OR at 15x cap)
    const state = [...getActivePureWsPositions().values()][0];
    expect(state.peakPrice).toBeLessThanOrEqual(1.0 * config.pureWsMaxPeakMultiplier);
    expect(state.peakPrice).toBe(priorPeak); // implementation: skip update entirely when exceeds
  });

  it('entry halt blocks update path exits gracefully (already-closed skip)', async () => {
    const pair = 'PAIR9';
    seedProbePosition(pair, 1.0, nowSec());
    triggerEntryHalt('pure_ws_breakout', 'test halt');
    const builder = makeBuilder(new Map([[pair, 0.96]])); // hardcut condition
    const { ctx, tradeStore } = makeCtx();

    // update는 halt와 무관 — 기존 포지션 exit은 계속 작동 (wallet 보호, 기존 포지션 정상 close)
    await updatePureWsPositions(ctx, builder);

    // hardcut 정상 작동 확인 (halt 는 entry 만 차단, exit 는 영향 없음)
    expect(tradeStore.closeTrade).toHaveBeenCalled();
  });

  it('lane disabled skips update', async () => {
    disableLane();
    const pair = 'PAIR10';
    seedProbePosition(pair, 1.0, nowSec());
    const builder = makeBuilder(new Map([[pair, 0.5]])); // would hardcut if enabled
    const { ctx, tradeStore } = makeCtx();

    await updatePureWsPositions(ctx, builder);
    expect(tradeStore.closeTrade).not.toHaveBeenCalled();
  });
});

describe('pureWsBreakoutHandler — wallet mode resolution', () => {
  it('auto: prefers sandbox when available', () => {
    const ctx = { executor: { name: 'main' }, sandboxExecutor: { name: 'sandbox' } } as unknown as BotContext;
    Object.defineProperty(config, 'pureWsLaneWalletMode', { value: 'auto', writable: true, configurable: true });
    expect(resolvePureWsWalletLabel(ctx)).toBe('sandbox');
  });

  it('auto: falls back to main without sandbox', () => {
    const ctx = { executor: { name: 'main' } } as unknown as BotContext;
    Object.defineProperty(config, 'pureWsLaneWalletMode', { value: 'auto', writable: true, configurable: true });
    expect(resolvePureWsWalletLabel(ctx)).toBe('main');
  });

  it('main: forces main even with sandbox', () => {
    const ctx = { executor: { name: 'main' }, sandboxExecutor: { name: 'sandbox' } } as unknown as BotContext;
    Object.defineProperty(config, 'pureWsLaneWalletMode', { value: 'main', writable: true, configurable: true });
    expect(resolvePureWsWalletLabel(ctx)).toBe('main');
  });

  it('sandbox: forces sandbox when available', () => {
    const ctx = { executor: { name: 'main' }, sandboxExecutor: { name: 'sandbox' } } as unknown as BotContext;
    Object.defineProperty(config, 'pureWsLaneWalletMode', { value: 'sandbox', writable: true, configurable: true });
    expect(resolvePureWsWalletLabel(ctx)).toBe('sandbox');
  });
});
