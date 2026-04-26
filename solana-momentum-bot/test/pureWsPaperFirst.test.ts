/**
 * Block 3 QA fix (2026-04-18): paper-first enforcement test.
 * PUREWS_LIVE_CANARY_ENABLED=false 면 TRADING_MODE=live 여도 live buy 차단.
 * timeStopAt 단위 버그 (seconds * 60) 수정 회귀 방어.
 *
 * 2026-04-25 H1.3: Jupiter / network DNS leak 차단. 테스트가 entryDriftGuard / sellQuoteProbe 를
 * 거치며 axios 가 외부 호출 시도하는 것을 명시 mock 으로 차단.
 */
import { createBlockedAxiosMock } from './__helpers__/network';
jest.mock('axios', () => createBlockedAxiosMock());

import {
  handlePureWsSignal,
  resetPureWsLaneStateForTests,
  getActivePureWsPositions,
} from '../src/orchestration/pureWsBreakoutHandler';
import { resetAllEntryHaltsForTests } from '../src/orchestration/entryIntegrity';
import { resetWalletStopGuardForTests } from '../src/risk/walletStopGuard';
import { resetCanaryConcurrencyGuardForTests } from '../src/risk/canaryConcurrencyGuard';
import { resetAllCanaryStatesForTests } from '../src/risk/canaryAutoHalt';
import type { BotContext } from '../src/orchestration/types';
import type { MicroCandleBuilder } from '../src/realtime';
import { config } from '../src/utils/config';

function override(key: string, value: unknown): void {
  Object.defineProperty(config, key, { value, writable: true, configurable: true });
}

function makeBuilder(): MicroCandleBuilder {
  return {
    getCurrentPrice: () => null,
    getRecentCandles: () => [],
  } as unknown as MicroCandleBuilder;
}

function makeCtx(mode: 'live' | 'paper'): { ctx: BotContext; notifier: any; executor: { executeBuy: jest.Mock }; tradeStore: { insertTrade: jest.Mock } } {
  const executor = {
    executeBuy: jest.fn(async () => ({ txSignature: 'sig1', slippageBps: 10, actualInputUiAmount: 0.01, actualOutUiAmount: 100 })),
    getBalance: jest.fn(async () => 1.0),
    getTokenBalance: jest.fn(async () => 0n),
    executeSell: jest.fn(async () => ({ txSignature: 'sell1', slippageBps: 10 })),
  };
  const notifier = {
    sendCritical: jest.fn(async () => {}),
    sendTradeOpen: jest.fn(async () => {}),
    sendTradeClose: jest.fn(async () => {}),
    sendInfo: jest.fn(async () => {}),
  };
  const tradeStore = {
    insertTrade: jest.fn(async () => 'db-1'),
    closeTrade: jest.fn(async () => {}),
    getOpenTrades: jest.fn(async () => []),
  };
  const ctx = {
    tradingMode: mode,
    notifier,
    tradeStore,
    executor,
  } as unknown as BotContext;
  return { ctx, notifier, executor, tradeStore };
}

describe('Block 3 QA — paper-first enforcement', () => {
  beforeEach(() => {
    resetPureWsLaneStateForTests();
    resetAllEntryHaltsForTests();
    resetWalletStopGuardForTests();
    resetCanaryConcurrencyGuardForTests();
    resetAllCanaryStatesForTests();
    override('pureWsLaneEnabled', true);
    override('pureWsGateEnabled', false); // gate 건너뛰기 (MicroCandleBuilder mock 최소화)
    override('pureWsLaneWalletMode', 'main');
    // 2026-04-26 cleanup: 운영 .env 의 survival/probe/drift gate 가 jest 에 로드되어
    // ctx.onchainSecurityClient mock 부재 시 reject. 테스트는 명시 비활성화.
    override('pureWsSurvivalCheckEnabled', false);
    override('pureWsSurvivalAllowDataMissing', true);
    override('pureWsRunSellQuoteProbe', false);
    override('pureWsEntryDriftGuardEnabled', false);
    override('pureWsSellQuoteProbeEnabled', false);
  });

  it('live mode + PUREWS_LIVE_CANARY_ENABLED=false: live buy suppressed, no position opened', async () => {
    override('pureWsLiveCanaryEnabled', false);
    const { ctx, executor, tradeStore } = makeCtx('live');
    const builder = makeBuilder();

    await handlePureWsSignal(
      { pairAddress: 'PAIR1', strategy: 'bootstrap_10s', price: 1.0 } as any,
      builder,
      ctx
    );

    expect(executor.executeBuy).not.toHaveBeenCalled();
    expect(tradeStore.insertTrade).not.toHaveBeenCalled();
    expect(getActivePureWsPositions().size).toBe(0);
  });

  it('live mode + PUREWS_LIVE_CANARY_ENABLED=true: live buy proceeds', async () => {
    override('pureWsLiveCanaryEnabled', true);
    const { ctx, executor, tradeStore } = makeCtx('live');
    const builder = makeBuilder();

    await handlePureWsSignal(
      { pairAddress: 'PAIR2', strategy: 'bootstrap_10s', price: 1.0 } as any,
      builder,
      ctx
    );

    expect(executor.executeBuy).toHaveBeenCalledTimes(1);
    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1);
    expect(getActivePureWsPositions().size).toBe(1);
  });

  it('paper mode: PUREWS_LIVE_CANARY_ENABLED irrelevant, paper entry always allowed', async () => {
    override('pureWsLiveCanaryEnabled', false);
    const { ctx, executor, tradeStore } = makeCtx('paper');
    const builder = makeBuilder();

    await handlePureWsSignal(
      { pairAddress: 'PAIR3', strategy: 'bootstrap_10s', price: 1.0 } as any,
      builder,
      ctx
    );

    expect(executor.executeBuy).not.toHaveBeenCalled(); // paper — no live buy
    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1); // but DB insert happens (paper simulated)
    expect(getActivePureWsPositions().size).toBe(1);
  });

  it('timeStopAt persists probeWindowSec 기준 (seconds, not minutes)', async () => {
    override('pureWsLiveCanaryEnabled', true);
    const { ctx, tradeStore } = makeCtx('live');
    const builder = makeBuilder();

    await handlePureWsSignal(
      { pairAddress: 'PAIR4', strategy: 'bootstrap_10s', price: 1.0 } as any,
      builder,
      ctx
    );

    const insertCall = tradeStore.insertTrade.mock.calls[0][0];
    const createdAt = insertCall.createdAt as Date;
    const timeStopAt = insertCall.timeStopAt as Date;
    const diffSec = Math.round((timeStopAt.getTime() - createdAt.getTime()) / 1000);
    // pureWsProbeWindowSec default 30 — 이전 버그: 30 * 60 = 1800. 현재 fix: 30.
    expect(diffSec).toBeLessThanOrEqual(config.pureWsProbeWindowSec + 2);
    expect(diffSec).toBeGreaterThanOrEqual(config.pureWsProbeWindowSec - 2);
  });

  // 2026-04-26: pure_ws swing-v2 paper shadow.
  // 같은 V2 PASS / bootstrap signal 로 primary (현행) + shadow (long hold) 동시 paper 생성.
  // shadow 는 paper-only 강제: live executeBuy 호출 X, DB insertTrade X, isShadowArm=true.
  it('SWING_V2 enabled + live primary → primary live + swing-v2 shadow paper 동시 생성', async () => {
    override('pureWsLiveCanaryEnabled', true);
    override('pureWsSwingV2Enabled', true);
    const { ctx, executor, tradeStore } = makeCtx('live');
    const builder = makeBuilder();

    await handlePureWsSignal(
      { pairAddress: 'PAIR_SWING', strategy: 'bootstrap_10s', price: 1.0 } as any,
      builder,
      ctx
    );

    // primary 는 live → executeBuy 1회 + DB insertTrade 1회
    expect(executor.executeBuy).toHaveBeenCalledTimes(1);
    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1);

    // active position 은 primary + shadow 2건
    const positions = [...getActivePureWsPositions().values()];
    expect(positions).toHaveLength(2);

    const primary = positions.find((p) => p.isShadowArm !== true);
    const shadow = positions.find((p) => p.isShadowArm === true);

    expect(primary?.armName).toBe('pure_ws_breakout');
    expect(primary?.parameterVersion).toBe('pure-ws-v1.0.0');
    expect(primary?.isShadowArm).toBe(false);

    expect(shadow?.armName).toBe('pure_ws_swing_v2');
    expect(shadow?.parameterVersion).toBe(config.pureWsSwingV2ParameterVersion);
    expect(shadow?.parentPositionId).toBe(primary?.tradeId);
    // shadow override 적용 확인
    expect(shadow?.probeWindowSecOverride).toBe(config.pureWsSwingV2ProbeWindowSec);
    expect(shadow?.t1TrailPctOverride).toBe(config.pureWsSwingV2T1TrailPct);
    expect(shadow?.t1ProfitFloorMultOverride).toBe(config.pureWsSwingV2T1ProfitFloorMult);
    expect(shadow?.probeHardCutPctOverride).toBe(config.pureWsSwingV2ProbeHardCutPct);

    // cleanup
    override('pureWsSwingV2Enabled', false);
  });

  it('SWING_V2 disabled → primary 만 생성, shadow 없음', async () => {
    override('pureWsLiveCanaryEnabled', true);
    override('pureWsSwingV2Enabled', false);
    const { ctx, executor, tradeStore } = makeCtx('live');
    const builder = makeBuilder();

    await handlePureWsSignal(
      { pairAddress: 'PAIR_NOSWING', strategy: 'bootstrap_10s', price: 1.0 } as any,
      builder,
      ctx
    );

    expect(executor.executeBuy).toHaveBeenCalledTimes(1);
    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1);
    const positions = [...getActivePureWsPositions().values()];
    expect(positions).toHaveLength(1);
    expect(positions[0].isShadowArm).toBe(false);
  });

  // Phase 1 P0-1 (2026-04-25): in-flight mutex regression.
  // 6h 운영 로그에서 BZtgGZqx 가 09:28:53.097 + 09:28:53.191 (94ms) 두 번 PROBE_OPEN.
  // 같은 pair 의 두 동시 signal 이 첫 signal 의 async Jupiter 사이에 통과되면 안 됨.
  it('Phase 1 P0-1: in-flight mutex prevents same-pair double entry within ms', async () => {
    override('pureWsLiveCanaryEnabled', true);
    const { ctx, executor, tradeStore } = makeCtx('live');
    const builder = makeBuilder();

    const signal = { pairAddress: 'PAIR_DUP', strategy: 'bootstrap_10s', price: 1.0 } as any;
    // 두 signal 을 await 없이 동시 fire — race window 시뮬.
    const a = handlePureWsSignal(signal, builder, ctx);
    const b = handlePureWsSignal(signal, builder, ctx);
    await Promise.all([a, b]);

    // 한 번만 진입해야 함 — 두 번째 signal 은 INFLIGHT_DEDUP 으로 차단.
    expect(executor.executeBuy).toHaveBeenCalledTimes(1);
    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1);
    expect(getActivePureWsPositions().size).toBe(1);
  });
});
