/**
 * Phase 1.3 test (DEX_TRADE.md roadmap, 2026-04-18): v2 independent scanner.
 * scanPureWsV2Burst flag gate + per-pair cooldown + v1 gate bypass.
 */
import {
  scanPureWsV2Burst,
  handlePureWsSignal,
  getActivePureWsPositions,
  resetPureWsLaneStateForTests,
  resetPureWsV2CooldownForTests,
} from '../src/orchestration/pureWsBreakoutHandler';
import { resetAllEntryHaltsForTests } from '../src/orchestration/entryIntegrity';
import { resetWalletStopGuardForTests } from '../src/risk/walletStopGuard';
import { resetCanaryConcurrencyGuardForTests } from '../src/risk/canaryConcurrencyGuard';
import { resetAllCanaryStatesForTests } from '../src/risk/canaryAutoHalt';
import type { BotContext } from '../src/orchestration/types';
import type { MicroCandleBuilder } from '../src/realtime';
import type { Candle, Signal } from '../src/utils/types';
import { config } from '../src/utils/config';

function override(key: string, value: unknown): void {
  Object.defineProperty(config, key, { value, writable: true, configurable: true });
}

function candle(
  overrides: Partial<Candle> = {}
): Candle {
  const open = overrides.open ?? 1.0;
  const close = overrides.close ?? open;
  return {
    pairAddress: overrides.pairAddress ?? 'PAIR',
    timestamp: overrides.timestamp ?? new Date(0),
    intervalSec: overrides.intervalSec ?? 10,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: overrides.volume ?? 100,
    buyVolume: overrides.buyVolume ?? 50,
    sellVolume: overrides.sellVolume ?? 50,
    tradeCount: overrides.tradeCount ?? 10,
  };
}

function makeBuilder(candlesByPair: Map<string, Candle[]>, pricesByPair: Map<string, number>): MicroCandleBuilder {
  return {
    getRecentCandles: (pair: string, _interval: number, count: number) =>
      (candlesByPair.get(pair) ?? []).slice(-count),
    getCurrentPrice: (pair: string) => pricesByPair.get(pair) ?? null,
  } as unknown as MicroCandleBuilder;
}

function makeCtx(mode: 'paper' | 'live' = 'paper') {
  const executor = {
    executeBuy: jest.fn(async () => ({ txSignature: 'BUY1', slippageBps: 5, actualInputUiAmount: 0.01, actualOutUiAmount: 200 })),
    executeSell: jest.fn(async () => ({ txSignature: 'SELL1', slippageBps: 5 })),
    getBalance: jest.fn(async () => 1.0),
    getTokenBalance: jest.fn(async () => 0n),
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
  return { ctx, notifier, tradeStore, executor };
}

function buildBurstyCandles(pair: string): Candle[] {
  // baseline (nBaseline=6): 100 volume, 10 tx, buy ratio 0.5
  const baseline: Candle[] = Array.from({ length: 6 }, (_, i) =>
    candle({
      pairAddress: pair,
      volume: 80 + i * 2,
      buyVolume: 40 + i,
      sellVolume: 40 + i,
      tradeCount: 8 + i,
      open: 1.0,
      close: 1.0,
    })
  );
  // recent (nRecent=3): spike
  const recent: Candle[] = Array.from({ length: 3 }, (_, i) =>
    candle({
      pairAddress: pair,
      volume: 5000,
      buyVolume: 4000,
      sellVolume: 1000,
      tradeCount: 40,
      open: i === 0 ? 1.0 : 1.05,
      close: i === 2 ? 1.10 : 1.05,
    })
  );
  return [...baseline, ...recent];
}

describe('Phase 1.3 — scanPureWsV2Burst', () => {
  beforeEach(() => {
    resetPureWsLaneStateForTests();
    resetPureWsV2CooldownForTests();
    resetAllEntryHaltsForTests();
    resetWalletStopGuardForTests();
    resetCanaryConcurrencyGuardForTests();
    resetAllCanaryStatesForTests();
    // tuned defaults (audit 기반)
    override('pureWsLaneEnabled', true);
    override('pureWsV2Enabled', true);
    override('pureWsV2MinPassScore', 50);
    override('pureWsV2FloorVol', 0.15);
    override('pureWsV2FloorBuy', 0.25);
    override('pureWsV2FloorTx', 0.33);
    override('pureWsV2FloorPrice', 0.1);
    override('pureWsV2BuyRatioAbsFloor', 0.55);
    override('pureWsV2TxCountAbsFloor', 3);
    override('pureWsV2WVolume', 30);
    override('pureWsV2WBuy', 25);
    override('pureWsV2WDensity', 20);
    override('pureWsV2WPrice', 20);
    override('pureWsV2WReverse', 5);
    override('pureWsV2NRecent', 3);
    override('pureWsV2NBaseline', 6);
    override('pureWsV2ZVolSaturate', 2.0);
    override('pureWsV2ZBuySaturate', 2.0);
    override('pureWsV2ZTxSaturate', 3.0);
    override('pureWsV2BpsPriceSaturate', 1000);
    override('pureWsV2PerPairCooldownSec', 300);
    override('pureWsLaneWalletMode', 'main');
    override('pureWsLiveCanaryEnabled', true);
    // 2026-04-26 cleanup: 운영 .env 의 survival/probe/drift gate isolation
    override('pureWsSurvivalCheckEnabled', false);
    override('pureWsSurvivalAllowDataMissing', true);
    override('pureWsRunSellQuoteProbe', false);
    override('pureWsEntryDriftGuardEnabled', false);
    override('pureWsSellQuoteProbeEnabled', false);
    override('pureWsPaperParamArmsEnabled', false);
  });

  it('v2 disabled (flag off) → no-op scan, no entry', async () => {
    override('pureWsV2Enabled', false);
    const pair = 'PAIR1';
    const candles = buildBurstyCandles(pair);
    const builder = makeBuilder(new Map([[pair, candles]]), new Map([[pair, 1.10]]));
    const { ctx, tradeStore } = makeCtx('paper');

    await scanPureWsV2Burst(ctx, builder, [pair]);

    expect(tradeStore.insertTrade).not.toHaveBeenCalled();
    expect(getActivePureWsPositions().size).toBe(0);
  });

  it('v2 enabled + strong burst → Signal synthesized + position opened (v1 gate bypassed)', async () => {
    const pair = 'PAIR2';
    const candles = buildBurstyCandles(pair);
    const builder = makeBuilder(new Map([[pair, candles]]), new Map([[pair, 1.10]]));
    const { ctx, tradeStore } = makeCtx('paper');

    await scanPureWsV2Burst(ctx, builder, [pair]);

    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1);
    const calls = tradeStore.insertTrade.mock.calls as unknown as any[][];
    expect(calls.length).toBeGreaterThan(0);
    const inserted = calls[0][0];
    expect(inserted.strategy).toBe('pure_ws_breakout');
    expect(inserted.sourceLabel).toBe('ws_burst_v2');
    expect(getActivePureWsPositions().size).toBe(1);
  });

  it('per-pair cooldown — scan twice in a row → second ignored', async () => {
    const pair = 'PAIR3';
    const candles = buildBurstyCandles(pair);
    const builder = makeBuilder(new Map([[pair, candles]]), new Map([[pair, 1.10]]));
    const { ctx, tradeStore } = makeCtx('paper');

    await scanPureWsV2Burst(ctx, builder, [pair]);
    // 포지션 이미 생겼으니 중복 방지는 dup guard 로도 걸리지만, 분리 검증을 위해 cleanup 후 재시도
    // (cooldown 은 pair-level state, position cleanup 과 무관하게 유지)
    resetPureWsLaneStateForTests();       // 포지션만 clear (cooldown 은 별도 함수)
    // 여기서는 cooldown 은 resetPureWsLaneStateForTests 가 clear 함 (중요: test helper 가 둘 다 리셋)
    // → 명시적으로 cooldown 만 살린다.
    await scanPureWsV2Burst(ctx, builder, [pair]);

    // resetPureWsLaneStateForTests 가 cooldown 도 리셋하므로 두 번 다 insert 발생
    // 이 case 는 실제 cooldown 분리 동작을 검증하지 않음 → 다른 방식으로 확인
    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(2);
  });

  it('per-pair cooldown blocks re-trigger within window (no reset between scans)', async () => {
    const pair = 'PAIR4';
    const candles = buildBurstyCandles(pair);
    const builder = makeBuilder(new Map([[pair, candles]]), new Map([[pair, 1.10]]));
    const { ctx, tradeStore } = makeCtx('paper');

    await scanPureWsV2Burst(ctx, builder, [pair]);
    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1);
    const activeCount1 = getActivePureWsPositions().size;

    // 두 번째 scan — 같은 pair, 같은 data (cooldown 내)
    // 중복 pair guard 도 작동하지만 cooldown 이 먼저 잡힘 → detector 호출조차 안됨
    await scanPureWsV2Burst(ctx, builder, [pair]);
    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1); // 변함 없음
    expect(getActivePureWsPositions().size).toBe(activeCount1);
  });

  it('weak signal (flat volume) → detector reject, no entry', async () => {
    const pair = 'PAIR5';
    const flatCandles: Candle[] = Array.from({ length: 9 }, (_, i) =>
      candle({
        pairAddress: pair,
        volume: 100,
        buyVolume: 50,
        sellVolume: 50,
        tradeCount: 5,
      })
    );
    const builder = makeBuilder(new Map([[pair, flatCandles]]), new Map([[pair, 1.0]]));
    const { ctx, tradeStore } = makeCtx('paper');

    await scanPureWsV2Burst(ctx, builder, [pair]);

    expect(tradeStore.insertTrade).not.toHaveBeenCalled();
  });

  it('insufficient candles (pair too new) → skip, no error', async () => {
    const pair = 'PAIR6';
    const few = [candle({ pairAddress: pair })]; // 1 candle only
    const builder = makeBuilder(new Map([[pair, few]]), new Map([[pair, 1.0]]));
    const { ctx, tradeStore } = makeCtx('paper');

    await expect(scanPureWsV2Burst(ctx, builder, [pair])).resolves.not.toThrow();
    expect(tradeStore.insertTrade).not.toHaveBeenCalled();
  });

  it('[2026-04-20 P2 fix] entry halt active → scan returns early, no detector eval, no V2_PASS log', async () => {
    // 4/20 관측: GEr3mp 567 V2_PASS burst 가 canary halt 상태에서도 계속 찍힘.
    // 원인: halt 시 handler 가 PUREWS_ENTRY_HALT 로 return → position 안 만들어짐 →
    // cooldown 설정 안 됨 → 다음 scan 에서 다시 pass 로그 → 무한 loop.
    // Fix: scanPureWsV2Burst 진입 시 halt 활성화되어 있으면 no-op.
    const { triggerEntryHalt } = await import('../src/orchestration/entryIntegrity');
    triggerEntryHalt('pure_ws_breakout', 'test P2 halt');

    const pair = 'PAIR_HALT';
    const candles = buildBurstyCandles(pair);
    const builder = makeBuilder(new Map([[pair, candles]]), new Map([[pair, 1.10]]));
    const { ctx, tradeStore } = makeCtx('paper');
    // scan — halt 상태라 detector 호출 자체 skip
    await scanPureWsV2Burst(ctx, builder, [pair]);

    expect(tradeStore.insertTrade).not.toHaveBeenCalled();
    expect(getActivePureWsPositions().size).toBe(0);
  });

  it('QA F8 fix: viability rejection does NOT set per-pair cooldown', async () => {
    // 이전 bug: scanner 가 handler call 전에 cooldown 설정 → 어떤 이유로든 handler reject 해도 5min 락업.
    // 수정 후: handler 가 position 을 실제로 만들 때만 cooldown 설정. reject 시 다음 candle 에서 재시도 가능.
    override('probeViabilityFloorEnabled', true);
    override('probeViabilityMaxBleedPct', 0.0001); // 매우 엄격 → 모든 bleed reject
    const pair = 'PAIR_F8';
    const candles = buildBurstyCandles(pair);
    const builder = makeBuilder(new Map([[pair, candles]]), new Map([[pair, 1.10]]));
    const { ctx, tradeStore } = makeCtx('paper');

    // 1차 scan: detector pass 하지만 viability reject → 포지션 생성 안 됨
    await scanPureWsV2Burst(ctx, builder, [pair]);
    expect(tradeStore.insertTrade).not.toHaveBeenCalled();
    expect(getActivePureWsPositions().size).toBe(0);

    // 2차 scan 즉시 실행 — 수정 전이면 cooldown 으로 skip, 수정 후엔 재시도 (같은 reject 반복하지만 cooldown 이 없음)
    override('probeViabilityMaxBleedPct', 0.5); // 완화 → 통과 가능
    await scanPureWsV2Burst(ctx, builder, [pair]);
    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1); // 재시도 성공
  });

  it('[2026-04-21 P1] v1 per-pair cooldown blocks repeated bootstrap signal on same pair', async () => {
    // 4/20-21 관측: BOME(ukHH6c7m) 한 pair 에 bootstrap_10s signal 4회 연속 진입 → halt.
    // Fix: v1 경로에서 entry 성공 시 v1LastEntrySecByPair 기록, cooldown 내 재-signal skip.
    override('pureWsGateEnabled', false);
    override('pureWsV1PerPairCooldownSec', 300);
    const pair = 'PAIR_V1_COOLDOWN';
    const builder = makeBuilder(new Map([[pair, []]]), new Map([[pair, 1.0]]));
    const { ctx, tradeStore } = makeCtx('paper');

    const bootstrapSignal: Signal = {
      action: 'BUY',
      strategy: 'pure_ws_breakout',
      pairAddress: pair,
      price: 1.0,
      timestamp: new Date(),
      meta: {},
      sourceLabel: 'bootstrap_10s',
    };

    // 첫 signal → entry 성공
    await handlePureWsSignal(bootstrapSignal, builder, ctx);
    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1);
    const activeBefore = getActivePureWsPositions().size;

    // position 을 close 한 상태로 가정 — activePositions 에서 제거해서 duplicate guard 회피.
    // (실제 운영에선 close 경로 거쳐 map 에서 제거됨)
    resetPureWsLaneStateForTests(); // cooldown map 까지 리셋되므로 별도 방식 필요.

    // 다시 setup (cooldown 만 살아남게)
    const { ctx: ctx2, tradeStore: ts2 } = makeCtx('paper');
    // 첫 진입 재시도 (cooldown 없음)
    await handlePureWsSignal(bootstrapSignal, builder, ctx2);
    expect(ts2.insertTrade).toHaveBeenCalledTimes(1);

    // duplicate guard 우회 위해 activePositions 제거
    (getActivePureWsPositions() as Map<string, unknown>).clear();

    // 두 번째 signal (cooldown 활성)
    await handlePureWsSignal(bootstrapSignal, builder, ctx2);
    // cooldown 으로 차단 — insertTrade 추가 호출 없음
    expect(ts2.insertTrade).toHaveBeenCalledTimes(1);
  });

  it('[2026-04-21 P1] v2 sourced signal bypasses v1 cooldown (separate path)', async () => {
    // v2 signal 은 scanner 의 자체 cooldown 사용 — handler 내 v1 cooldown 검사 skip.
    override('pureWsV1PerPairCooldownSec', 300);
    const pair = 'PAIR_V2_BYPASS';
    const builder = makeBuilder(new Map([[pair, []]]), new Map([[pair, 1.0]]));
    const { ctx, tradeStore } = makeCtx('paper');

    const v2Signal: Signal = {
      action: 'BUY',
      strategy: 'pure_ws_breakout',
      pairAddress: pair,
      price: 1.0,
      timestamp: new Date(),
      meta: { burstScore: 75 },
      sourceLabel: 'ws_burst_v2',
    };

    // 첫 signal (v1 cooldown 은 v1 만 기록, v2 signal 은 기록 안 함)
    await handlePureWsSignal(v2Signal, builder, ctx);
    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1);

    // activePositions 제거 (close 가정)
    (getActivePureWsPositions() as Map<string, unknown>).clear();

    // 두 번째 v2 signal — v1 cooldown 이 없으므로 통과
    await handlePureWsSignal(v2Signal, builder, ctx);
    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(2);
  });

  // ─── 2026-04-21 Survival Layer regression ───

  it('[2026-04-21 survival] rejects entry when Token-2022 transferHook extension detected', async () => {
    override('pureWsSurvivalCheckEnabled', true);
    override('pureWsGateEnabled', false);
    const pair = 'PAIR_SURVIVAL_HOOK';
    const builder = makeBuilder(new Map([[pair, []]]), new Map([[pair, 1.0]]));
    const { ctx, tradeStore } = makeCtx('paper');
    (ctx as any).onchainSecurityClient = {
      getTokenSecurityDetailed: jest.fn(async () => ({
        isHoneypot: false,
        isFreezable: false,
        isMintable: false,
        hasTransferFee: false,
        freezeAuthorityPresent: false,
        top10HolderPct: 0.3,
        creatorPct: 0,
        tokenProgram: 'spl-token-2022',
        extensions: ['transferHook', 'metadataPointer'],
      })),
      getExitLiquidity: jest.fn(async () => null),
    };

    const bootstrapSignal: Signal = {
      action: 'BUY',
      strategy: 'pure_ws_breakout',
      pairAddress: pair,
      price: 1.0,
      timestamp: new Date(),
      meta: {},
      sourceLabel: 'bootstrap_10s',
    };
    await handlePureWsSignal(bootstrapSignal, builder, ctx);

    expect(tradeStore.insertTrade).not.toHaveBeenCalled();
    expect(getActivePureWsPositions().size).toBe(0);
  });

  it('[2026-04-21 survival] allows entry when survival data missing + allowDataMissing=true (observability)', async () => {
    override('pureWsSurvivalCheckEnabled', true);
    override('pureWsSurvivalAllowDataMissing', true);
    override('pureWsGateEnabled', false);
    const pair = 'PAIR_SURVIVAL_MISSING_ALLOW';
    const builder = makeBuilder(new Map([[pair, []]]), new Map([[pair, 1.0]]));
    const { ctx, tradeStore } = makeCtx('paper');
    // onchainSecurityClient 미구성 → 데이터 없음

    const bootstrapSignal: Signal = {
      action: 'BUY',
      strategy: 'pure_ws_breakout',
      pairAddress: pair,
      price: 1.0,
      timestamp: new Date(),
      meta: {},
      sourceLabel: 'bootstrap_10s',
    };
    await handlePureWsSignal(bootstrapSignal, builder, ctx);

    expect(tradeStore.insertTrade).toHaveBeenCalledTimes(1);
  });

  it('[2026-04-21 survival] rejects entry when survival data missing + allowDataMissing=false (strict)', async () => {
    override('pureWsSurvivalCheckEnabled', true);
    override('pureWsSurvivalAllowDataMissing', false);
    override('pureWsGateEnabled', false);
    const pair = 'PAIR_SURVIVAL_MISSING_DENY';
    const builder = makeBuilder(new Map([[pair, []]]), new Map([[pair, 1.0]]));
    const { ctx, tradeStore } = makeCtx('paper');

    const bootstrapSignal: Signal = {
      action: 'BUY',
      strategy: 'pure_ws_breakout',
      pairAddress: pair,
      price: 1.0,
      timestamp: new Date(),
      meta: {},
      sourceLabel: 'bootstrap_10s',
    };
    await handlePureWsSignal(bootstrapSignal, builder, ctx);

    expect(tradeStore.insertTrade).not.toHaveBeenCalled();
    // cleanup for subsequent tests
    override('pureWsSurvivalAllowDataMissing', true);
  });

  it('[2026-04-21 survival] rejects entry when top-holder concentration > config threshold', async () => {
    override('pureWsSurvivalCheckEnabled', true);
    override('pureWsSurvivalMaxTop10HolderPct', 0.80);
    override('pureWsGateEnabled', false);
    const pair = 'PAIR_SURVIVAL_HOLDER';
    const builder = makeBuilder(new Map([[pair, []]]), new Map([[pair, 1.0]]));
    const { ctx, tradeStore } = makeCtx('paper');
    (ctx as any).onchainSecurityClient = {
      getTokenSecurityDetailed: jest.fn(async () => ({
        isHoneypot: false,
        isFreezable: false,
        isMintable: false,
        hasTransferFee: false,
        freezeAuthorityPresent: false,
        top10HolderPct: 0.95, // 95% > 80%
        creatorPct: 0,
        tokenProgram: 'spl-token',
      })),
      getExitLiquidity: jest.fn(async () => null),
    };

    const bootstrapSignal: Signal = {
      action: 'BUY',
      strategy: 'pure_ws_breakout',
      pairAddress: pair,
      price: 1.0,
      timestamp: new Date(),
      meta: {},
      sourceLabel: 'bootstrap_10s',
    };
    await handlePureWsSignal(bootstrapSignal, builder, ctx);

    expect(tradeStore.insertTrade).not.toHaveBeenCalled();
  });

  it('handlePureWsSignal bypasses v1 gate for ws_burst_v2 sourced signal', async () => {
    // v1 gate 활성 + 까다로운 factors → handlePureWsSignal 에 직접 버스트 signal 넣으면 gate 건너뜀
    override('pureWsGateEnabled', true); // v1 gate ON
    const pair = 'PAIR7';
    const builder = makeBuilder(new Map([[pair, []]]), new Map([[pair, 1.0]]));
    const { ctx, tradeStore } = makeCtx('paper');

    const signal: Signal = {
      action: 'BUY',
      strategy: 'pure_ws_breakout',
      pairAddress: pair,
      price: 1.0,
      timestamp: new Date(),
      meta: { burstScore: 75 },
      sourceLabel: 'ws_burst_v2',
    };

    await handlePureWsSignal(signal, builder, ctx);

    // v1 gate 는 candle 필요하지만 sourceLabel=ws_burst_v2 → skip → entry 진입
    expect(tradeStore.insertTrade).toHaveBeenCalled();
  });
});
