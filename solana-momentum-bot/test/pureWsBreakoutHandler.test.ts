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
  // 2026-04-19 (QA Q2): peak warmup 회피 — seed 는 "warmup 이미 지난 상태" 로 간주.
  // caller 가 `nowSec()` 넘기면 warmup 초 만큼 더 과거로 보정. Timeout 케이스에서 과거를
  // 명시한 경우에도 일관되게 적용 — warmup 영향 없는 순수한 state machine 테스트 지원.
  const warmupAdjusted = entryTimeSec - (config.pureWsPeakWarmupSec + 1);
  addPureWsPositionForTests({
    tradeId: `purews-${pair.slice(0, 8)}-${entryTimeSec}`,
    dbTradeId: 'db-1',
    pairAddress: pair,
    entryPrice,
    // 2026-04-19: 기본 seed 는 signal=entry 동등 (legacy 동작). market reference 분리 테스트
    // 는 별도 케이스에서 명시적으로 override.
    marketReferencePrice: entryPrice,
    entryTimeSec: warmupAdjusted,
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

  it('[2026-04-19 dual price tracker] PROBE does NOT hardcut when market ref flat but entry gap 27%', async () => {
    // Regression: VPS 2026-04-18 16:10:33 pippin 재현.
    // signal=0.0000876, Jupiter fill entryPrice=0.0001117 (+27.5% drift), market tick=signal
    // Before fix: MAE=(tick-entry)/entry = -21.6% → hardcut 즉시 발동
    // After fix: MAE=(tick-marketRef)/marketRef = 0% → flat, hardcut 안 걸림
    const pair = 'PAIR_DRIFT';
    const signalPrice = 0.0000876;
    const entryPriceWithDrift = 0.0001117;
    addPureWsPositionForTests({
      tradeId: `purews-${pair.slice(0, 8)}-${nowSec()}`,
      dbTradeId: 'db-drift',
      pairAddress: pair,
      entryPrice: entryPriceWithDrift,
      marketReferencePrice: signalPrice,
      entryTimeSec: nowSec(),
      quantity: 89.51,
      state: 'PROBE',
      peakPrice: signalPrice,
      troughPrice: signalPrice,
    });
    // 시장 가격은 signal 수준 유지 (실제로 시장은 움직이지 않음)
    const builder = makeBuilder(new Map([[pair, signalPrice]]));
    const { ctx, tradeStore } = makeCtx();

    await updatePureWsPositions(ctx, builder);

    // hardcut 발동 안 함 — market reference 기준으로는 flat
    expect(tradeStore.closeTrade).not.toHaveBeenCalled();
    const state = [...getActivePureWsPositions().values()][0];
    expect(state.state).toBe('PROBE');
  });

  it('[2026-04-19 QA Q2] peak warmup — bot\'s own BUY impact does NOT update peak during warmup', async () => {
    // 봇 BUY 가 low-liquidity pool price 를 일시 띄운 시나리오.
    // currentPrice = marketRef × 1.3 (warmupMaxDeviation 0.05 초과)
    // elapsed=0s < pureWsPeakWarmupSec → peak update 억제
    const pair = 'PAIR_WARMUP';
    const signalPrice = 0.0001;
    addPureWsPositionForTests({
      tradeId: `purews-${pair.slice(0, 8)}-${nowSec()}`,
      dbTradeId: 'db-warmup',
      pairAddress: pair,
      entryPrice: 0.00013, // +30% fill drift
      marketReferencePrice: signalPrice,
      entryTimeSec: nowSec(), // 지금 막 진입
      quantity: 100,
      state: 'PROBE',
      peakPrice: signalPrice,
      troughPrice: signalPrice,
    });
    // 첫 tick 이 fill level 로 튀는 시나리오
    const builder = makeBuilder(new Map([[pair, 0.00013]]));
    const { ctx } = makeCtx();

    await updatePureWsPositions(ctx, builder);

    const state = [...getActivePureWsPositions().values()][0];
    // peak 는 signalPrice × (1+deviation) 이내만 인정 — 0.00013 은 +30% 이므로 거부
    expect(state.peakPrice).toBeLessThanOrEqual(signalPrice * (1 + config.pureWsPeakWarmupMaxDeviationPct) + 1e-12);
    expect(state.state).toBe('PROBE'); // hardcut 도 안 걸림 (currentPct 양수)
  });

  it('[2026-04-19 dual price tracker] market ref MAE still triggers hardcut when real drop occurs', async () => {
    // 실제 시장이 market ref 대비 -4% 이상 떨어지면 hardcut 은 여전히 작동해야 함.
    const pair = 'PAIR_REAL_DROP';
    const signalPrice = 0.0001;
    const entryPriceWithDrift = 0.00013; // +30% fill drift
    addPureWsPositionForTests({
      tradeId: `purews-${pair.slice(0, 8)}-${nowSec()}`,
      dbTradeId: 'db-real-drop',
      pairAddress: pair,
      entryPrice: entryPriceWithDrift,
      marketReferencePrice: signalPrice,
      entryTimeSec: nowSec(),
      quantity: 100,
      state: 'PROBE',
      peakPrice: signalPrice,
      troughPrice: signalPrice,
    });
    // 시장 가격이 signal 대비 -5% 하락 (실제 시장 이동)
    const marketDrop = signalPrice * 0.95;
    const builder = makeBuilder(new Map([[pair, marketDrop]]));
    const { ctx, tradeStore } = makeCtx();

    await updatePureWsPositions(ctx, builder);

    // hardcut 발동 — market reference 기준 -5%
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

  it('[2026-04-20 P0 fix] orphan close — tokenBalance==0 in live mode force-closes instead of infinite retry', async () => {
    // Regression anchor: VPS 4/20 08:19 BOME(ukHH6c7m) 관측 — tokenBalance=0 이지만 position
    // DB OPEN → close 시 throw → previousState 복원 → 매 tick 재시도 → 3,982 spam.
    // Fix: live 경로에서 tokenBalance=0 감지 시 orphan close 로 처리 (pnl=0, reason=ORPHAN_NO_BALANCE).
    const pair = 'PAIR_ORPHAN';
    const entryPrice = 1.0;
    addPureWsPositionForTests({
      tradeId: `purews-${pair.slice(0, 8)}-${nowSec()}`,
      dbTradeId: 'db-orphan',
      pairAddress: pair,
      entryPrice,
      marketReferencePrice: entryPrice,
      entryTimeSec: nowSec() - 60, // warmup 이후
      quantity: 100,
      state: 'PROBE',
      peakPrice: entryPrice,
      troughPrice: entryPrice * 0.9, // MAE -10% → hardcut 트리거
    });

    const executor = {
      getBalance: jest.fn(async () => 1.0),
      getTokenBalance: jest.fn(async () => 0n), // 지갑에 토큰 없음 — orphan
      executeSell: jest.fn(),
    };
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
      tradingMode: 'live', // live 모드에서만 sell 시도 경로 활성화
      notifier,
      tradeStore,
      executor,
    } as unknown as BotContext;

    const builder = makeBuilder(new Map([[pair, 0.9]])); // hardcut 트리거 가격
    await updatePureWsPositions(ctx, builder);

    // Fix 검증:
    // 1. executeSell 호출되지 않음 (tokenBalance=0 이므로 실제 sell skip)
    expect(executor.executeSell).not.toHaveBeenCalled();
    // 2. DB close 수행됨 (orphan 정리)
    expect(tradeStore.closeTrade).toHaveBeenCalledTimes(1);
    const closeCalls = tradeStore.closeTrade.mock.calls as unknown as any[][];
    const closeCall = closeCalls[0][0];
    expect(closeCall.exitReason).toBe('ORPHAN_NO_BALANCE');
    expect(closeCall.pnl).toBe(0);
    // 3. position 이 CLOSED 상태로 전환 → 다음 tick 재시도 없음
    const state = [...getActivePureWsPositions().values()][0];
    expect(state.state).toBe('CLOSED');
    // 4. notifier 1회 (spam 방지)
    expect(notifier.sendCritical).toHaveBeenCalledTimes(1);
    const notifierCalls = notifier.sendCritical.mock.calls as unknown as any[][];
    expect(notifierCalls[0][0]).toBe('purews_orphan_close');
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
