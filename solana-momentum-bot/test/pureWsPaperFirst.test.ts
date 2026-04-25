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
});
