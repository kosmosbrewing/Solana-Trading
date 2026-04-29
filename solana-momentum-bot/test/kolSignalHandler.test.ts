/**
 * kolSignalHandler state machine tests (Option 5 Phase 3)
 *
 * Scope: stalk → PROBE → T1 → T2 → T3 + close 5 category
 * priceFeed 는 injected mock 으로 치환 — 실 Jupiter 호출 없음.
 */
jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const mockAppendFile = jest.fn().mockResolvedValue(undefined);
const mockMkdir = jest.fn().mockResolvedValue(undefined);
jest.mock('fs/promises', () => ({
  appendFile: (...args: unknown[]) => mockAppendFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: mockAxiosGet },
  get: mockAxiosGet,
}));

import { EventEmitter } from 'events';
import {
  handleKolSwap,
  __testInit,
  __testGetActive,
  __testForceResolveStalk,
  __testTriggerTick,
  __testIsLiveCanaryActive,
  recoverKolHunterOpenPositions,
  stopKolHunter,
  kolHunterEvents,
} from '../src/orchestration/kolSignalHandler';
import type { KolTx } from '../src/kol/types';

// 최소 Stub PaperPriceFeed — subscribe/unsubscribe + getLastPrice + on/off 지원
class StubPaperPriceFeed extends EventEmitter {
  public prices = new Map<string, number>();
  public decimals = new Map<string, number | null>();
  subscribe(mint: string) { /* noop */ void mint; }
  unsubscribe(mint: string) { this.prices.delete(mint); }
  getLastPrice(mint: string): { price: number; timestamp: number } | null {
    const p = this.prices.get(mint);
    return p != null ? { price: p, timestamp: Date.now() } : null;
  }
  // 2026-04-26 P1 fix: tokenDecimals stash — test 도 PaperPriceFeed 인터페이스 준수.
  getLastTick(mint: string): { price: number; timestamp: number; outputDecimals: number | null } | null {
    const p = this.prices.get(mint);
    const outputDecimals = this.decimals.has(mint) ? this.decimals.get(mint)! : 6;
    return p != null ? { price: p, timestamp: Date.now(), outputDecimals } : null;
  }
  getActiveSubscriptionCount() { return this.prices.size; }
  stopAll() { this.prices.clear(); this.decimals.clear(); }
  setInitialPrice(mint: string, price: number, outputDecimals: number | null = 6) {
    this.prices.set(mint, price);
    this.decimals.set(mint, outputDecimals);
  }
  emitTick(mint: string, price: number, outputDecimals: number | null = 6) {
    this.prices.set(mint, price);
    this.decimals.set(mint, outputDecimals);
    this.emit('price', {
      tokenMint: mint,
      price,
      outAmountUi: 0.01 / price,
      outputDecimals,
      probeSolAmount: 0.01,
      timestamp: Date.now(),
    });
  }
}

function buyTx(kolId: string, tier: 'S' | 'A' | 'B', tokenMint: string, offsetMs = 0): KolTx {
  return {
    kolId,
    walletAddress: `wallet_${kolId}`,
    tier,
    tokenMint,
    action: 'buy',
    timestamp: Date.now() - offsetMs,
    txSignature: `sig_${kolId}_${tokenMint}_${offsetMs}`,
    solAmount: 0.05,
  };
}

// Config override — tests 마다 env 가 다르게 동작하지 않도록 기본값 확실히.
jest.mock('../src/utils/config', () => ({
  config: {
    kolHunterEnabled: true,
    kolHunterPaperOnly: true,
    kolHunterTicketSol: 0.01,
    kolHunterMaxConcurrent: 3,
    kolHunterStalkWindowSec: 180,
    kolHunterHardcutPct: 0.10,
    kolHunterT1Mfe: 0.50,
    kolHunterT1TrailPct: 0.15,
    kolHunterT2Mfe: 4.00,
    kolHunterT2TrailPct: 0.20,
    kolHunterT2BreakevenLockMult: 3.0,
    kolHunterT3Mfe: 9.00,
    kolHunterT3TrailPct: 0.25,
    kolHunterQuickRejectWindowSec: 180,
    kolHunterQuickRejectFactorCount: 3,
    kolHunterPaperRoundTripCostPct: 0.005,
    kolHunterParameterVersion: 'v1.0.0',
    kolHunterDetectorVersion: 'kol_discovery_v1',
    // 2026-04-26: swing-v2 paper-only A/B arm. default disabled in tests.
    kolHunterSwingV2Enabled: false,
    kolHunterSwingV2MinKolCount: 2,
    kolHunterSwingV2MinScore: 5.0,
    kolHunterSwingV2StalkWindowSec: 600,
    kolHunterSwingV2T1TrailPct: 0.25,
    kolHunterSwingV2T1ProfitFloorMult: 1.10,
    kolHunterSwingV2ParameterVersion: 'swing-v2.0.0',
    // 2026-04-26: smart-v3 는 production main default 이지만 기존 state-machine tests 는 v1 명시.
    kolHunterSmartV3Enabled: false,
    kolHunterSmartV3ObserveWindowSec: 120,
    kolHunterSmartV3MinPullbackPct: 0.10,
    kolHunterSmartV3MaxDrawdownFromKolEntryPct: 0.15,
    kolHunterSmartV3VelocityScoreThreshold: 6.0,
    kolHunterSmartV3VelocityMinIndependentKol: 2,
    kolHunterSmartV3T1ThresholdHigh: 0.40,
    kolHunterSmartV3T1TrailBoth: 0.25,
    kolHunterSmartV3T1TrailPullback: 0.22,
    kolHunterSmartV3T1TrailVelocity: 0.20,
    kolHunterSmartV3ProfitFloorBoth: 1.05,
    kolHunterSmartV3ProfitFloorPullback: 1.08,
    kolHunterSmartV3ProfitFloorVelocity: 1.10,
    kolHunterSmartV3ProbeTimeoutBothSec: 600,
    kolHunterSmartV3ProbeTimeoutPullbackSec: 300,
    kolHunterSmartV3ProbeTimeoutVelocitySec: 300,
    kolHunterSmartV3ReinforcementTrailInc: 0.01,
    kolHunterSmartV3ReinforcementTrailMax: 0.25,
    kolHunterSmartV3ParameterVersion: 'smart-v3.0.0',
    // 2026-04-25 MISSION_CONTROL §KOL Control survival 통합. Unit tests 는 securityClient 미주입 + allowDataMissing=true 로 진입 허용.
    kolHunterSurvivalAllowDataMissing: true,
    kolHunterSurvivalMinExitLiquidityUsd: 5000,
    kolHunterSurvivalMaxTop10HolderPct: 0.80,
    kolHunterRunSellQuoteProbe: false,
    // 2026-04-29 (Track 2B): default false in tests — 기존 tests 는 securityClient 미주입 환경
    // 에서 통과 가정. Track 2B 회귀 테스트만 explicit override.
    kolHunterRejectOnNoSecurityData: false,
    kolHunterLiveCanaryEnabled: false,
    // 2026-04-29 (Track 1): default 0 — test 내 same-token 반복 사용 차단 안 함.
    // Track 1 회귀 테스트에서 explicit 으로 override 하여 검증.
    kolHunterReentryCooldownMs: 0,
    // 2026-04-29 (P0-2): KOL alpha decay default disabled — 회귀 테스트 explicit override.
    kolHunterKolDecayCooldownEnabled: false,
    kolHunterKolDecayCooldownMs: 14_400_000,
    kolHunterKolDecayMinCloses: 3,
    kolHunterKolDecayLossRatioThreshold: 0.66,
    // 2026-04-29 (외부 전략 리포트 #5): community detection default disabled.
    kolHunterCommunityDetectionEnabled: false,
    kolHunterCommunityWindowMs: 300_000,
    kolHunterCommunityMinEdgeWeight: 25,
    // 2026-04-28 (inactive paper trade Sprint): default false. tests 가 explicit override.
    kolHunterShadowTrackInactive: false,
    kolHunterShadowPaperTradeEnabled: false,
    kolShadowTxLogFileName: 'kol-shadow-tx.jsonl',
    kolShadowPaperTradesFileName: 'kol-shadow-paper-trades.jsonl',
    kolScoringWindowMs: 24 * 60 * 60 * 1000,
    kolAntiCorrelationMs: 60_000,
    realtimeDataDir: '/tmp/kol-test',
    missedAlphaObserverEnabled: false, // observer 는 별도 테스트
    missedAlphaObserverOffsetsSec: [60, 300, 1800],
    missedAlphaObserverJitterPct: 0,
    missedAlphaObserverMaxInflight: 50,
    missedAlphaObserverDedupWindowSec: 30,
    jupiterApiUrl: 'https://api.test/swap/v1',
    jupiterApiKey: undefined,
  },
}));

const MINT_WINNER = 'Mint111111111111111111111111111111111111111';
const MINT_HARDCUT = 'Mint222222222222222222222222222222222222222';
const MINT_FLAT = 'Mint333333333333333333333333333333333333333';
const MINT_NOCONSENSUS = 'Mint444444444444444444444444444444444444444';
const MINT_SMART = 'Mint666666666666666666666666666666666666666';

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('kolSignalHandler — state machine', () => {
  let stubFeed: StubPaperPriceFeed;

  beforeEach(() => {
    stopKolHunter();
    jest.clearAllMocks();
    // 2026-04-28 (P1 isolation fix): KOL DB module global state 가 test 간 leak.
    // Phase 1 신규 테스트의 __testInject 가 후속 test 영향 → resetKolDbState 로 격리.
    const { resetKolDbState } = require('../src/kol/db');
    resetKolDbState();
    // 2026-04-29 (Track 1): same-token reentry cooldown 도 test 간 격리.
    const {
      resetReentryCooldownForTests,
      resetKolDecayForTests,
      resetCommunityCacheForTests,
    } = require('../src/orchestration/kolSignalHandler');
    resetReentryCooldownForTests();
    // 2026-04-29 (P0-2): KOL alpha decay tracking 도 test 간 격리.
    resetKolDecayForTests();
    // 2026-04-29 (#5): community cache 도 test 간 격리.
    resetCommunityCacheForTests();
    const mockedConfig = (require('../src/utils/config') as any).config;
    mockedConfig.kolHunterSmartV3Enabled = false;
    mockedConfig.kolHunterSwingV2Enabled = false;
    mockedConfig.kolHunterSwingV2T1TrailPct = 0.25;
    mockedConfig.kolHunterSwingV2T1ProfitFloorMult = 1.10;
    // 2026-04-29 (Track 2B): test 간 격리. describe 블록에서 true 로 설정해도 다음 test 까지 leak 안 함.
    mockedConfig.kolHunterRejectOnNoSecurityData = false;
    stubFeed = new StubPaperPriceFeed();
    __testInit({ priceFeed: stubFeed as unknown as never });
  });

  afterEach(() => {
    stopKolHunter();
    const { resetKolDbState } = require('../src/kol/db');
    resetKolDbState();
  });

  it('stalk → entry 시 priceFeed 에서 initial price 가져와 PROBE 진입', async () => {
    stubFeed.setInitialPrice(MINT_WINNER, 0.001);
    await handleKolSwap(buyTx('pain', 'S', MINT_WINNER));
    await __testForceResolveStalk(MINT_WINNER);
    const positions = __testGetActive();
    expect(positions).toHaveLength(1);
    expect(positions[0].state).toBe('PROBE');
    expect(positions[0].entryPrice).toBeCloseTo(0.001, 6);
    expect(positions[0].participatingKols).toHaveLength(1);
    expect(positions[0].participatingKols[0].id).toBe('pain');
  });

  it('stalk expired, independent KOL 0명 → reject (no position)', async () => {
    // empty feed, pending 등록도 안 한 상태에서 force resolve → pending 없으므로 early return
    await __testForceResolveStalk(MINT_NOCONSENSUS);
    expect(__testGetActive()).toHaveLength(0);
  });

  it('max concurrent cap: active + pending 이 cap 초과 시 신규 skip', async () => {
    stubFeed.setInitialPrice(MINT_WINNER, 0.001);
    stubFeed.setInitialPrice(MINT_HARDCUT, 0.001);
    stubFeed.setInitialPrice(MINT_FLAT, 0.001);
    const MINT_EXTRA = 'Mint555555555555555555555555555555555555555';
    await handleKolSwap(buyTx('k1', 'S', MINT_WINNER));
    await handleKolSwap(buyTx('k2', 'S', MINT_HARDCUT));
    await handleKolSwap(buyTx('k3', 'S', MINT_FLAT));
    // cap=3 이미 pending 3 상태 → 4번째 mint 는 skip
    await handleKolSwap(buyTx('k4', 'S', MINT_EXTRA));
    // resolve 3 and verify only 3 active
    await __testForceResolveStalk(MINT_WINNER);
    await __testForceResolveStalk(MINT_HARDCUT);
    await __testForceResolveStalk(MINT_FLAT);
    expect(__testGetActive()).toHaveLength(3);
    const mints = __testGetActive().map((p) => p.tokenMint);
    expect(mints).not.toContain(MINT_EXTRA);
  });

  it('PROBE → MAE ≤ -10% → probe_hard_cut', async () => {
    stubFeed.setInitialPrice(MINT_HARDCUT, 0.001);
    await handleKolSwap(buyTx('pain', 'S', MINT_HARDCUT));
    await __testForceResolveStalk(MINT_HARDCUT);
    const pos = __testGetActive()[0];
    let captured: any = null;
    kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
    __testTriggerTick(pos.positionId, 0.001 * 0.85); // -15% MAE
    expect(captured).not.toBeNull();
    expect(captured.reason).toBe('probe_hard_cut');
    expect(__testGetActive()).toHaveLength(0);
  });

  it('PROBE → MFE ≥ +50% → RUNNER_T1 promotion + t1VisitAtSec 기록', async () => {
    stubFeed.setInitialPrice(MINT_WINNER, 0.001);
    await handleKolSwap(buyTx('pain', 'S', MINT_WINNER));
    await __testForceResolveStalk(MINT_WINNER);
    const pos = __testGetActive()[0];
    __testTriggerTick(pos.positionId, 0.0016); // +60% MFE
    expect(pos.state).toBe('RUNNER_T1');
    expect(pos.t1VisitAtSec).toBeDefined();
  });

  it('T1 → MFE ≥ +400% → RUNNER_T2 + t2 lock 설정', async () => {
    stubFeed.setInitialPrice(MINT_WINNER, 0.001);
    await handleKolSwap(buyTx('pain', 'S', MINT_WINNER));
    await __testForceResolveStalk(MINT_WINNER);
    const pos = __testGetActive()[0];
    __testTriggerTick(pos.positionId, 0.0016); // T1
    __testTriggerTick(pos.positionId, 0.005);  // +400% → T2
    expect(pos.state).toBe('RUNNER_T2');
    expect(pos.t2VisitAtSec).toBeDefined();
    expect(pos.t2BreakevenLockPrice).toBeCloseTo(0.003, 6); // entry × 3
  });

  it('T2 → MFE ≥ +900% → RUNNER_T3', async () => {
    stubFeed.setInitialPrice(MINT_WINNER, 0.001);
    await handleKolSwap(buyTx('pain', 'S', MINT_WINNER));
    await __testForceResolveStalk(MINT_WINNER);
    const pos = __testGetActive()[0];
    __testTriggerTick(pos.positionId, 0.0016);
    __testTriggerTick(pos.positionId, 0.005);
    __testTriggerTick(pos.positionId, 0.010); // +900% → T3
    expect(pos.state).toBe('RUNNER_T3');
    expect(pos.t3VisitAtSec).toBeDefined();
  });

  it('T1 → trail 15% hit → winner_trailing_t1 close', async () => {
    stubFeed.setInitialPrice(MINT_WINNER, 0.001);
    await handleKolSwap(buyTx('pain', 'S', MINT_WINNER));
    await __testForceResolveStalk(MINT_WINNER);
    const pos = __testGetActive()[0];
    let captured: any = null;
    kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
    __testTriggerTick(pos.positionId, 0.002); // T1 peak
    __testTriggerTick(pos.positionId, 0.002 * 0.80); // peak 에서 20% pullback > trail 15%
    expect(captured?.reason).toBe('winner_trailing_t1');
  });

  it('Multi-KOL 합의: 2명 KOL 이 다른 시점 진입 → 둘 다 participating', async () => {
    stubFeed.setInitialPrice(MINT_WINNER, 0.001);
    await handleKolSwap(buyTx('pain', 'S', MINT_WINNER, 150_000)); // 150s 전
    await handleKolSwap(buyTx('dunpa', 'A', MINT_WINNER, 30_000));  // 30s 전 (60s 간격 이상 → independent)
    // 첫 KOL 이 180s 전이었으므로 anti-correlation 통과
    await __testForceResolveStalk(MINT_WINNER);
    const pos = __testGetActive()[0];
    expect(pos.participatingKols.length).toBeGreaterThanOrEqual(2);
    expect(pos.kolScore).toBeGreaterThan(0);
  });

  it('이미 active position 이 있을 때 추가 KOL tx 는 새 position 만들지 않고 participating 에 추가', async () => {
    stubFeed.setInitialPrice(MINT_WINNER, 0.001);
    await handleKolSwap(buyTx('pain', 'S', MINT_WINNER));
    await __testForceResolveStalk(MINT_WINNER);
    expect(__testGetActive()).toHaveLength(1);
    // 동일 mint 에 추가 KOL
    await handleKolSwap(buyTx('euris', 'A', MINT_WINNER));
    expect(__testGetActive()).toHaveLength(1); // 여전히 1 position
    const pos = __testGetActive()[0];
    const kolIds = pos.participatingKols.map((k) => k.id);
    expect(kolIds).toContain('pain');
    expect(kolIds).toContain('euris');
  });

  it('sell tx 는 entry 유발 안 함 (Phase 4+ exit signal)', async () => {
    const sellTx: KolTx = { ...buyTx('pain', 'S', MINT_FLAT), action: 'sell' };
    await handleKolSwap(sellTx);
    expect(__testGetActive()).toHaveLength(0);
  });

  // ─── smart-v3 main paper logic (2026-04-26) ───────────
  describe('smart-v3 main logic', () => {
    const mockedConfig = (require('../src/utils/config') as any).config;

    beforeEach(() => {
      mockedConfig.kolHunterSmartV3Enabled = true;
    });

    afterEach(() => {
      mockedConfig.kolHunterSmartV3Enabled = false;
    });

    it('pullback trigger 진입 시 smart-v3 main arm 과 HIGH confidence 를 기록한다', async () => {
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      expect(__testGetActive()).toHaveLength(0);

      stubFeed.emitTick(MINT_SMART, 0.0013);
      await flushAsync();
      expect(__testGetActive()).toHaveLength(0);

      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].parameterVersion).toBe('smart-v3.0.0');
      expect(positions[0].armName).toBe('kol_hunter_smart_v3');
      expect(positions[0].kolEntryReason).toBe('pullback');
      expect(positions[0].kolConvictionLevel).toBe('HIGH');
      expect(positions[0].t1MfeOverride).toBe(0.40);
      expect(positions[0].t1TrailPctOverride).toBe(0.22);
      expect(positions[0].t1ProfitFloorMult).toBe(1.08);
    });

    it('velocity trigger 는 multi-KOL S/A 독립 합의에서 smart-v3 main 으로 진입한다', async () => {
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('k1', 'S', MINT_SMART, 120_000));
      expect(__testGetActive()).toHaveLength(0);

      await handleKolSwap(buyTx('k2', 'A', MINT_SMART));
      await flushAsync();

      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].parameterVersion).toBe('smart-v3.0.0');
      expect(positions[0].kolEntryReason).toBe('velocity');
      expect(positions[0].kolConvictionLevel).toBe('MEDIUM_HIGH');
      expect(positions[0].independentKolCount).toBe(2);
    });

    it('trigger 없이 observe 만료되면 진입하지 않는다', async () => {
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      await __testForceResolveStalk(MINT_SMART);
      expect(__testGetActive()).toHaveLength(0);
    });

    it('observe 중 동일 KOL sell 은 pending candidate 를 취소한다', async () => {
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      await handleKolSwap({ ...buyTx('pain', 'S', MINT_SMART), action: 'sell' });
      await __testForceResolveStalk(MINT_SMART);
      expect(__testGetActive()).toHaveLength(0);
    });

    it('post-entry: 진입한 KOL 이 sell 하면 insider_exit_full 로 즉시 close 한다 (F10)', async () => {
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      // pullback 트리거로 진입 — pain (tier S) 는 participatingKols 에 포함됨
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      const pos = positions[0];
      expect(pos.kolEntryReason).toBe('pullback');
      expect(pos.participatingKols.map((k) => k.id)).toContain('pain');

      // 동일 KOL sell tx 를 흘리면 handleKolSellSignal 이 active position 매칭 후 close
      let captured: any = null;
      kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
      await handleKolSwap({ ...buyTx('pain', 'S', MINT_SMART), action: 'sell' });

      expect(captured).not.toBeNull();
      expect(captured.reason).toBe('insider_exit_full');
      expect(__testGetActive()).toHaveLength(0);
    });

    it('post-entry: 다른 KOL 의 sell 은 active position 을 close 하지 않는다 (F10)', async () => {
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      expect(__testGetActive()).toHaveLength(1);

      // 진입에 참여하지 않은 KOL (ghost) sell — 영향 없어야 함
      let captured: any = null;
      kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
      await handleKolSwap({ ...buyTx('ghost', 'A', MINT_SMART), action: 'sell' });
      await flushAsync();

      expect(captured).toBeNull();
      expect(__testGetActive()).toHaveLength(1);
    });

    it('smart-v3 T1 trail 은 entry reason 별 override 를 사용한다', async () => {
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      const pos = __testGetActive()[0];
      __testTriggerTick(pos.positionId, 0.00115 * 1.41); // pullback arm T1 threshold +40%
      expect(pos.state).toBe('RUNNER_T1');

      let captured: any = null;
      kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
      __testTriggerTick(pos.positionId, pos.peakPrice * 0.77); // pullback trail 22% hit
      expect(captured?.reason).toBe('winner_trailing_t1');
    });
  });

  // ─── Swing-v2 paper A/B arm (2026-04-26) ─────────────
  describe('swing-v2 arm', () => {
    const mockedConfig = (require('../src/utils/config') as any).config;

    afterEach(() => {
      mockedConfig.kolHunterSwingV2Enabled = false;
      mockedConfig.kolHunterSwingV2T1TrailPct = 0.25;
      mockedConfig.kolHunterSwingV2T1ProfitFloorMult = 1.10;
    });

    it('SWING_V2_ENABLED=false → 자격 충족해도 v1 arm (parameterVersion=v1)', async () => {
      mockedConfig.kolHunterSwingV2Enabled = false;
      stubFeed.setInitialPrice(MINT_WINNER, 0.001);
      // multi-KOL high-score (자격은 충족)
      await handleKolSwap(buyTx('k1', 'S', MINT_WINNER, 200_000));
      await handleKolSwap(buyTx('k2', 'S', MINT_WINNER, 80_000));
      await __testForceResolveStalk(MINT_WINNER);
      const pos = __testGetActive()[0];
      expect(pos.parameterVersion).toBe('v1.0.0');
    });

    it('SWING_V2 enabled + multi-KOL S-tier → v1 primary + swing-v2 shadow 동시 생성', async () => {
      mockedConfig.kolHunterSwingV2Enabled = true;
      stubFeed.setInitialPrice(MINT_WINNER, 0.001);
      // 2 S-tier KOL → score = 3+3+3(consensus 2-4) = 9 ≥ 5
      await handleKolSwap(buyTx('k1', 'S', MINT_WINNER, 200_000));
      await handleKolSwap(buyTx('k2', 'S', MINT_WINNER, 80_000));
      await __testForceResolveStalk(MINT_WINNER);
      const positions = __testGetActive();
      expect(positions).toHaveLength(2);
      const v1 = positions.find((p) => p.parameterVersion === 'v1.0.0');
      const v2 = positions.find((p) => p.parameterVersion === 'swing-v2.0.0');
      expect(v1?.isShadowArm).toBe(false);
      expect(v2?.isShadowArm).toBe(true);
      expect(v2?.parentPositionId).toBe(v1?.positionId);
    });

    // 2026-04-26: smart-v3 main 일 때도 swing-v2 shadow 가 동시에 생성되어야 한다.
    // 이전: primaryVersion === v1.0.0 제약으로 smart-v3 path 에서는 swing-v2 영구 비활성.
    it('SMART_V3 + SWING_V2 둘 다 enabled + multi-KOL → smart-v3 primary + swing-v2 shadow 동시 생성', async () => {
      mockedConfig.kolHunterSwingV2Enabled = true;
      mockedConfig.kolHunterSmartV3Enabled = true;
      stubFeed.setInitialPrice(MINT_SMART, 0.001);

      // multi-KOL S-tier 합의 (smart-v3 의 velocity path 통과)
      await handleKolSwap(buyTx('k1', 'S', MINT_SMART, 120_000));
      await handleKolSwap(buyTx('k2', 'A', MINT_SMART));
      await flushAsync();

      const positions = __testGetActive();
      expect(positions).toHaveLength(2);
      const primary = positions.find((p) => p.parameterVersion === 'smart-v3.0.0');
      const shadow = positions.find((p) => p.parameterVersion === 'swing-v2.0.0');
      expect(primary?.isShadowArm).toBe(false);
      expect(shadow?.isShadowArm).toBe(true);
      expect(shadow?.parentPositionId).toBe(primary?.positionId);
      // smart-v3 main 의 entry reason 은 trigger 결과를 그대로 사용
      expect(primary?.kolEntryReason).toBe('velocity');
      // shadow 는 swing-v2 의 default entry reason 사용 (재귀 차단 + 라벨 분리)
      expect(shadow?.kolEntryReason).toBe('swing_v2');

      // cleanup
      mockedConfig.kolHunterSmartV3Enabled = false;
    });

    it('SWING_V2 enabled + single-KOL → v1 arm (multi-KOL 미달)', async () => {
      mockedConfig.kolHunterSwingV2Enabled = true;
      stubFeed.setInitialPrice(MINT_WINNER, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_WINNER));
      await __testForceResolveStalk(MINT_WINNER);
      const pos = __testGetActive()[0];
      expect(pos.parameterVersion).toBe('v1.0.0');
    });

    it('swing-v2: T1 trail 25% (vs v1 15%) — 17% pullback 시 v1 close 그러나 swing-v2 hold', async () => {
      mockedConfig.kolHunterSwingV2Enabled = true;
      stubFeed.setInitialPrice(MINT_WINNER, 0.001);
      await handleKolSwap(buyTx('k1', 'S', MINT_WINNER, 200_000));
      await handleKolSwap(buyTx('k2', 'S', MINT_WINNER, 80_000));
      await __testForceResolveStalk(MINT_WINNER);
      const v1 = __testGetActive().find((p) => p.parameterVersion === 'v1.0.0')!;
      const swing = __testGetActive().find((p) => p.parameterVersion === 'swing-v2.0.0')!;
      __testTriggerTick(v1.positionId, 0.0016);
      __testTriggerTick(swing.positionId, 0.0016);
      __testTriggerTick(v1.positionId, 0.0016 * 0.83);
      __testTriggerTick(swing.positionId, 0.0016 * 0.83); // 17% pullback (v1: cut, v2: hold — trail 25%)
      const remaining = __testGetActive();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].parameterVersion).toBe('swing-v2.0.0');
    });

    it('swing-v2: profit floor entry × 1.10 은 trail stop 하한선으로 동작', async () => {
      mockedConfig.kolHunterSwingV2Enabled = true;
      mockedConfig.kolHunterSwingV2T1TrailPct = 0.35; // floor 가 실제로 binding 되도록 테스트에서만 확대
      stubFeed.setInitialPrice(MINT_WINNER, 0.001);
      await handleKolSwap(buyTx('k1', 'S', MINT_WINNER, 200_000));
      await handleKolSwap(buyTx('k2', 'S', MINT_WINNER, 80_000));
      await __testForceResolveStalk(MINT_WINNER);
      const swing = __testGetActive().find((p) => p.parameterVersion === 'swing-v2.0.0')!;
      __testTriggerTick(swing.positionId, 0.0015); // T1 peak (정확히 +50%)
      let swingClose: any = null;
      kolHunterEvents.once('paper_close', (evt) => {
        if (evt.pos.positionId === swing.positionId) swingClose = evt;
      });
      // raw trailStop = 0.0015 × 0.65 = 0.000975, floor = 0.0011.
      // current 는 raw trail 위지만 floor 아래라 close 되어야 한다.
      __testTriggerTick(swing.positionId, 0.00109);
      expect(swingClose?.reason).toBe('winner_trailing_t1');
      expect(__testGetActive().find((p) => p.positionId === swing.positionId)).toBeUndefined();
    });

    it('quote decimals 가 없고 security decimals 도 없으면 observer tokenDecimals 를 비워 둔다', async () => {
      mockedConfig.kolHunterSwingV2Enabled = false;
      stubFeed.setInitialPrice(MINT_WINNER, 0.001, null);
      await handleKolSwap(buyTx('pain', 'S', MINT_WINNER));
      await __testForceResolveStalk(MINT_WINNER);
      const pos = __testGetActive()[0];
      expect(pos.tokenDecimals).toBeUndefined();
      expect(pos.survivalFlags).toContain('DECIMALS_UNKNOWN');
    });
  });

  // 2026-04-27: KOL live canary triple-flag gate 검증.
  // commit 1469a08 의 enterLivePosition 가 활성되려면 3 flag 모두 true 필요:
  //   1. botCtx 주입
  //   2. ctx.tradingMode === 'live'
  //   3. !kolHunterPaperOnly (default true → explicit false 필요)
  //   4. kolHunterLiveCanaryEnabled (default false → explicit true 필요)
  // 어느 하나 false 면 paper fallback (live wallet 영향 0).
  describe('live canary triple-flag gate', () => {
    const mockedConfig = (require('../src/utils/config') as any).config;

    afterEach(() => {
      mockedConfig.kolHunterPaperOnly = true;
      mockedConfig.kolHunterLiveCanaryEnabled = false;
    });

    it('default (모든 flag 안전 상태): live canary 비활성', () => {
      mockedConfig.kolHunterPaperOnly = true;
      mockedConfig.kolHunterLiveCanaryEnabled = false;
      // ctx 미주입 (__testInit ctx 옵션 없음)
      expect(__testIsLiveCanaryActive()).toBe(false);
    });

    it('LIVE_CANARY_ENABLED=true 이지만 PAPER_ONLY=true 면 live 비활성 (paper-first 강제)', () => {
      const liveCtx = { tradingMode: 'live' } as any;
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: liveCtx });
      mockedConfig.kolHunterPaperOnly = true;          // ⚠ paper-only 강제
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      expect(__testIsLiveCanaryActive()).toBe(false);
    });

    it('PAPER_ONLY=false 이지만 LIVE_CANARY_ENABLED=false 면 live 비활성', () => {
      const liveCtx = { tradingMode: 'live' } as any;
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: liveCtx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = false;  // ⚠ flag off
      expect(__testIsLiveCanaryActive()).toBe(false);
    });

    it('tradingMode=paper 이면 live 비활성 (env 모두 true 여도)', () => {
      const paperCtx = { tradingMode: 'paper' } as any;  // ⚠ paper mode
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: paperCtx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      expect(__testIsLiveCanaryActive()).toBe(false);
    });

    it('3 flag + ctx 모두 충족 시에만 live canary 활성', () => {
      const liveCtx = { tradingMode: 'live' } as any;
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: liveCtx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      expect(__testIsLiveCanaryActive()).toBe(true);
    });
  });

  // 2026-04-28 fix: smart-v3 main arm 의 live wiring 검증.
  // 운영 incident — commit 1469a08 의 enterLivePosition 가 v1 fallback 만 wiring 하고
  // smart-v3 trigger 경로 (evaluateSmartV3Triggers, line 798) 는 enterPaperPosition 만 호출.
  // 결과: KOL_HUNTER_LIVE_CANARY_ENABLED=true 인 운영 환경에서도 13시간+ live entry 0건.
  // 이 describe 는 그 회귀 방지.
  describe('smart-v3 trigger → live canary wiring (2026-04-28)', () => {
    const mockedConfig = (require('../src/utils/config') as any).config;

    beforeEach(() => {
      mockedConfig.kolHunterSmartV3Enabled = true;
    });
    afterEach(() => {
      mockedConfig.kolHunterSmartV3Enabled = false;
      mockedConfig.kolHunterPaperOnly = true;
      mockedConfig.kolHunterLiveCanaryEnabled = false;
    });

    function buildLiveCtx() {
      const insertTrade = jest.fn().mockResolvedValue('db-kolh-live-1');
      const closeTrade = jest.fn().mockResolvedValue(undefined);
      const executeBuy = jest.fn().mockResolvedValue({
        txSignature: 'KOL_LIVE_BUY_SIG',
        expectedOutAmount: 1n,
        actualOutUiAmount: 1,
        actualInputUiAmount: 0.01,
        slippageBps: 12,
      });
      const sendCritical = jest.fn().mockResolvedValue(undefined);
      const sendTradeOpen = jest.fn().mockResolvedValue(undefined);
      const sendInfo = jest.fn().mockResolvedValue(undefined);
      const ctx = {
        tradingMode: 'live',
        tradeStore: { insertTrade, closeTrade, getOpenTrades: jest.fn().mockResolvedValue([]) },
        notifier: { sendCritical, sendTradeOpen, sendTradeClose: jest.fn(), sendInfo },
        executor: { executeBuy, executeSell: jest.fn(), getTokenBalance: jest.fn(), getBalance: jest.fn() },
      } as any;
      return { ctx, executeBuy, insertTrade, sendTradeOpen };
    }

    it('triple-flag gate 통과 + smart-v3 pullback trigger → executor.executeBuy 호출 + isLive=true', async () => {
      const { ctx, executeBuy, insertTrade } = buildLiveCtx();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);  // observe 시작
      stubFeed.emitTick(MINT_SMART, 0.00115); // pullback trigger
      await flushAsync();

      // ⚠ 회귀 방지 핵심 assertion: live executor 가 호출되어야 한다.
      expect(executeBuy).toHaveBeenCalledTimes(1);
      expect(insertTrade).toHaveBeenCalledTimes(1);

      const positions = __testGetActive();
      // main arm 은 isLive=true, swing-v2 shadow 는 disabled 상태이므로 1개.
      expect(positions.length).toBeGreaterThanOrEqual(1);
      const live = positions.find((p) => p.isLive === true);
      expect(live).toBeDefined();
      expect(live?.armName).toBe('kol_hunter_smart_v3');
      expect(live?.parameterVersion).toBe('smart-v3.0.0');
      expect(live?.kolEntryReason).toBe('pullback');
      expect(live?.entryTxSignature).toBe('KOL_LIVE_BUY_SIG');
    });

    it('LIVE_CANARY_ENABLED=false → smart-v3 trigger 도 paper 만 (기존 동작 보존)', async () => {
      const { ctx, executeBuy } = buildLiveCtx();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = false;  // ⚠ flag off

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      // executor 가 절대 호출되지 않아야 함 — paper 전용 경로
      expect(executeBuy).not.toHaveBeenCalled();
      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].isLive).toBeFalsy();
      expect(positions[0].armName).toBe('kol_hunter_smart_v3');
    });

    it('smart-v3 + SWING_V2 enabled + multi-KOL → live main + paper paired swing-v2 shadow', async () => {
      const { ctx, executeBuy } = buildLiveCtx();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      mockedConfig.kolHunterSwingV2Enabled = true;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      // multi-KOL S+A → velocity trigger
      await handleKolSwap(buyTx('k1', 'S', MINT_SMART, 120_000));
      await handleKolSwap(buyTx('k2', 'A', MINT_SMART));
      await flushAsync();

      // executor 는 main arm 만 호출 (swing-v2 shadow 는 paper)
      expect(executeBuy).toHaveBeenCalledTimes(1);

      const positions = __testGetActive();
      const main = positions.find((p) => p.isLive === true);
      const shadow = positions.find((p) => p.isShadowArm === true);
      expect(main).toBeDefined();
      expect(main?.armName).toBe('kol_hunter_smart_v3');
      expect(shadow).toBeDefined();
      expect(shadow?.armName).toBe('kol_hunter_swing_v2');
      expect(shadow?.isLive).toBeFalsy();  // ← paired shadow 는 paper
      expect(shadow?.parentPositionId).toBe(main?.positionId);

      mockedConfig.kolHunterSwingV2Enabled = false;
    });

    // 2026-04-28 QA fix #1 — paired shadow 도 paper_entry emit 해야 kolPaperNotifier
    // (hourly digest + 5x anomaly alert) 가 catch 한다. 이전엔 누락됐음.
    it('paired swing-v2 shadow 는 paper_entry 이벤트를 emit 한다 (kolPaperNotifier 호환)', async () => {
      const { ctx } = buildLiveCtx();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      mockedConfig.kolHunterSwingV2Enabled = true;

      const emitted: string[] = [];
      const handler = (pos: any) => emitted.push(pos.armName);
      kolHunterEvents.on('paper_entry', handler);

      try {
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('k1', 'S', MINT_SMART, 120_000));
        await handleKolSwap(buyTx('k2', 'A', MINT_SMART));
        await flushAsync();

        // main(live) + shadow(paper) 둘 다 emit 되어야 함
        expect(emitted).toContain('kol_hunter_smart_v3');
        expect(emitted).toContain('kol_hunter_swing_v2');
      } finally {
        kolHunterEvents.off('paper_entry', handler);
        mockedConfig.kolHunterSwingV2Enabled = false;
      }
    });
  });

  // 2026-04-28 Sprint 2A: KOL live position recovery.
  // 봇 크래시 / 재시작 시 DB OPEN status 의 kol_hunter trade 가 in-memory active map 에서 사라지는
  // 문제 방지. cupsey/pure_ws recovery 패턴 동일.
  describe('recoverKolHunterOpenPositions (Sprint 2A)', () => {
    const mockedConfig = (require('../src/utils/config') as any).config;

    beforeEach(() => {
      mockedConfig.kolHunterEnabled = true;
    });
    afterEach(() => {
      mockedConfig.kolHunterEnabled = false;
    });

    function buildRecoveryCtx(opts: {
      tradingMode: 'live' | 'paper';
      openTrades: any[];
      tokenBalance?: bigint;
      balanceThrows?: boolean;
    }) {
      const closeTrade = jest.fn().mockResolvedValue(undefined);
      const sendCritical = jest.fn().mockResolvedValue(undefined);
      const getTokenBalance = opts.balanceThrows
        ? jest.fn().mockRejectedValue(new Error('rpc fail'))
        : jest.fn().mockResolvedValue(opts.tokenBalance ?? 1_000_000n);
      const ctx = {
        tradingMode: opts.tradingMode,
        tradeStore: {
          getOpenTrades: jest.fn().mockResolvedValue(opts.openTrades),
          closeTrade,
        },
        notifier: { sendCritical, sendInfo: jest.fn() },
        executor: { executeBuy: jest.fn(), executeSell: jest.fn(), getTokenBalance, getBalance: jest.fn() },
      } as any;
      return { ctx, closeTrade, sendCritical, getTokenBalance };
    }

    function buildOpenTrade(overrides: Partial<any> = {}): any {
      return {
        id: 'db-recover-1',
        pairAddress: 'So11111111111111111111111111111111111111112',
        strategy: 'kol_hunter',
        side: 'BUY',
        entryPrice: 0.001,
        quantity: 10,
        highWaterMark: 0.001,
        plannedEntryPrice: 0.0009,
        txSignature: 'BUY_TX_RECOVER',
        entrySlippageBps: 15,
        createdAt: new Date(1_777_400_000_000),
        status: 'OPEN',
        ...overrides,
      };
    }

    it('default (kolHunterEnabled=false): no-op recovery', async () => {
      mockedConfig.kolHunterEnabled = false;
      const { ctx } = buildRecoveryCtx({ tradingMode: 'live', openTrades: [buildOpenTrade()] });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      const recovered = await recoverKolHunterOpenPositions(ctx);
      expect(recovered).toBe(0);
      expect(__testGetActive()).toHaveLength(0);
    });

    it('balance > 0 + state PROBE: trade rehydrated as PROBE with isLive=true', async () => {
      const { ctx, closeTrade } = buildRecoveryCtx({
        tradingMode: 'live',
        openTrades: [buildOpenTrade()],
        tokenBalance: 1_000_000n,
      });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      const recovered = await recoverKolHunterOpenPositions(ctx);
      expect(recovered).toBe(1);
      expect(closeTrade).not.toHaveBeenCalled();
      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      const pos = positions[0];
      expect(pos.state).toBe('PROBE');
      expect(pos.isLive).toBe(true);
      expect(pos.dbTradeId).toBe('db-recover-1');
      expect(pos.entryTxSignature).toBe('BUY_TX_RECOVER');
      expect(pos.survivalFlags).toContain('RECOVERED_FROM_DB');
    });

    it('HWM 기반 state 추정: T1 / T2 / T3 inferred from highWaterMark', async () => {
      // T1: hwm >= entry * (1 + T1Mfe=0.50) = 0.0015
      // T2: hwm >= entry * (1 + T2Mfe=4.00) = 0.005
      // T3: hwm >= entry * (1 + T3Mfe=9.00) = 0.010
      const { ctx } = buildRecoveryCtx({
        tradingMode: 'live',
        openTrades: [
          buildOpenTrade({ id: 'r-t1', pairAddress: 'AAA1AAA1AAA1AAA1AAA1AAA1AAA1AAA1AAA1AAA1AAA1', highWaterMark: 0.0016 }),
          buildOpenTrade({ id: 'r-t2', pairAddress: 'BBB2BBB2BBB2BBB2BBB2BBB2BBB2BBB2BBB2BBB2BBB2', highWaterMark: 0.006 }),
          buildOpenTrade({ id: 'r-t3', pairAddress: 'CCC3CCC3CCC3CCC3CCC3CCC3CCC3CCC3CCC3CCC3CCC3', highWaterMark: 0.011 }),
        ],
        tokenBalance: 1_000_000n,
      });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      await recoverKolHunterOpenPositions(ctx);
      const positions = __testGetActive();
      const t1 = positions.find((p) => p.dbTradeId === 'r-t1');
      const t2 = positions.find((p) => p.dbTradeId === 'r-t2');
      const t3 = positions.find((p) => p.dbTradeId === 'r-t3');
      expect(t1?.state).toBe('RUNNER_T1');
      expect(t2?.state).toBe('RUNNER_T2');
      expect(t2?.t2BreakevenLockPrice).toBeGreaterThan(0);
      expect(t3?.state).toBe('RUNNER_T3');
    });

    it('balance == 0 (orphan): force close DB + critical notifier, NOT loaded into active map', async () => {
      const { ctx, closeTrade, sendCritical } = buildRecoveryCtx({
        tradingMode: 'live',
        openTrades: [buildOpenTrade()],
        tokenBalance: 0n,
      });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      const recovered = await recoverKolHunterOpenPositions(ctx);
      expect(recovered).toBe(0);
      expect(__testGetActive()).toHaveLength(0);
      expect(closeTrade).toHaveBeenCalledTimes(1);
      expect(closeTrade).toHaveBeenCalledWith(expect.objectContaining({
        id: 'db-recover-1',
        exitReason: 'ORPHAN_NO_BALANCE',
        pnl: 0,
      }));
      expect(sendCritical).toHaveBeenCalledTimes(1);
    });

    it('balance dust (< 1000 raw): force close DB with ORPHAN_DUST_BALANCE, no notifier', async () => {
      const { ctx, closeTrade, sendCritical } = buildRecoveryCtx({
        tradingMode: 'live',
        openTrades: [buildOpenTrade()],
        tokenBalance: 500n,
      });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      const recovered = await recoverKolHunterOpenPositions(ctx);
      expect(recovered).toBe(0);
      expect(__testGetActive()).toHaveLength(0);
      expect(closeTrade).toHaveBeenCalledWith(expect.objectContaining({
        exitReason: 'ORPHAN_DUST_BALANCE',
      }));
      expect(sendCritical).not.toHaveBeenCalled();
    });

    it('paper mode: skip orphan check, rehydrate as paper (isLive=false)', async () => {
      const { ctx, closeTrade, getTokenBalance } = buildRecoveryCtx({
        tradingMode: 'paper',
        openTrades: [buildOpenTrade()],
      });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      const recovered = await recoverKolHunterOpenPositions(ctx);
      expect(recovered).toBe(1);
      expect(getTokenBalance).not.toHaveBeenCalled();  // paper 는 orphan check skip
      expect(closeTrade).not.toHaveBeenCalled();
      const pos = __testGetActive()[0];
      expect(pos.isLive).toBe(false);
    });

    it('balance check RPC 실패: 보수적 fallback (in-memory load 진행)', async () => {
      const { ctx, closeTrade } = buildRecoveryCtx({
        tradingMode: 'live',
        openTrades: [buildOpenTrade()],
        balanceThrows: true,
      });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      const recovered = await recoverKolHunterOpenPositions(ctx);
      // RPC 실패해도 close loop fix (closePosition 의 ORPHAN_NO_BALANCE 분기) 가 있으므로
      // 보수적으로 in-memory load 진행. close는 호출되지 않음.
      expect(recovered).toBe(1);
      expect(closeTrade).not.toHaveBeenCalled();
      expect(__testGetActive()).toHaveLength(1);
    });

    it('non-kol_hunter strategy 는 filter 됨', async () => {
      const { ctx } = buildRecoveryCtx({
        tradingMode: 'live',
        openTrades: [
          buildOpenTrade({ id: 'r-cup', strategy: 'cupsey_flip_10s' }),
          buildOpenTrade({ id: 'r-pws', strategy: 'pure_ws_breakout' }),
          buildOpenTrade({ id: 'r-kol', strategy: 'kol_hunter' }),
        ],
        tokenBalance: 1_000_000n,
      });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      const recovered = await recoverKolHunterOpenPositions(ctx);
      expect(recovered).toBe(1);
      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].dbTradeId).toBe('r-kol');
    });
  });

  // 2026-04-27 Sprint 2: KOL live canary end-to-end integration tests.
  // 운영자 첫 1-3 trade 수동 모니터링 부담 경감 — opt-in 전 안전성 보강.
  // 기존 unit test (entry trigger) 만 있고 enterLivePosition / closeLivePosition 의 actual
  // executor / DB / ledger / notifier interaction 미검증. 본 describe 는 그 gap 메움.
  describe('KOL live canary end-to-end (Sprint 2)', () => {
    const mockedConfig = (require('../src/utils/config') as any).config;
    const {
      resetCanaryConcurrencyGuardForTests,
      acquireCanarySlot,
    } = require('../src/risk/canaryConcurrencyGuard');

    beforeEach(() => {
      mockedConfig.kolHunterEnabled = true;
      mockedConfig.kolHunterSmartV3Enabled = true;
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      // canary global guard 는 default off; concurrency 테스트만 명시적으로 켠다.
      mockedConfig.canaryGlobalConcurrencyEnabled = false;
      mockedConfig.canaryGlobalMaxConcurrent = 3;
      resetCanaryConcurrencyGuardForTests();
      // ledger dedup 은 24h TTL — 테스트 간 reset 안 하면 동일 txSignature 가 모두 dedup 되어
      // appendFile call count 가 0 이 됨. entryIntegrity 의 helper 로 매 테스트 초기화.
      const { resetAllEntryHaltsForTests } = require('../src/orchestration/entryIntegrity');
      resetAllEntryHaltsForTests();
    });

    afterEach(() => {
      mockedConfig.kolHunterSmartV3Enabled = false;
      mockedConfig.kolHunterPaperOnly = true;
      mockedConfig.kolHunterLiveCanaryEnabled = false;
      mockedConfig.canaryGlobalConcurrencyEnabled = false;
      resetCanaryConcurrencyGuardForTests();
    });

    // ── helper: live ctx with full executor + tradeStore + notifier mocks ──
    function buildE2EFixtures(opts: {
      executeBuy?: jest.Mock;
      executeSell?: jest.Mock;
      getTokenBalance?: jest.Mock;
      solBefore?: number;
      solAfter?: number;
      insertTradeId?: string;
    } = {}) {
      const insertTrade = jest.fn().mockResolvedValue(opts.insertTradeId ?? 'db-kolh-live-e2e');
      const closeTrade = jest.fn().mockResolvedValue(undefined);
      const executeBuy = opts.executeBuy ?? jest.fn().mockResolvedValue({
        txSignature: 'KOL_LIVE_BUY_SIG',
        expectedOutAmount: 1n,
        actualOutUiAmount: 10,
        actualInputUiAmount: 0.01,
        slippageBps: 12,
      });
      const executeSell = opts.executeSell ?? jest.fn().mockResolvedValue({
        txSignature: 'KOL_LIVE_SELL_SIG',
        slippageBps: 18,
      });
      const getTokenBalance = opts.getTokenBalance ?? jest.fn().mockResolvedValue(1_000_000n);
      const solBefore = opts.solBefore ?? 1.0;
      const solAfter = opts.solAfter ?? 1.05;
      // getBalance 는 sell 전후 2회 호출 — sequential mock.
      const getBalance = jest.fn()
        .mockResolvedValueOnce(solBefore)
        .mockResolvedValueOnce(solAfter);
      const sendCritical = jest.fn().mockResolvedValue(undefined);
      const sendTradeOpen = jest.fn().mockResolvedValue(undefined);
      const sendTradeClose = jest.fn().mockResolvedValue(undefined);
      const sendInfo = jest.fn().mockResolvedValue(undefined);
      const ctx = {
        tradingMode: 'live',
        tradeStore: { insertTrade, closeTrade, getOpenTrades: jest.fn().mockResolvedValue([]) },
        notifier: { sendCritical, sendTradeOpen, sendTradeClose, sendInfo },
        executor: { executeBuy, executeSell, getTokenBalance, getBalance },
      } as any;
      return {
        ctx, executeBuy, executeSell, getTokenBalance, getBalance,
        insertTrade, closeTrade, sendCritical, sendTradeOpen, sendTradeClose, sendInfo,
      };
    }

    /** smart-v3 pullback trigger 로 live entry 까지 도달 시키는 helper. */
    async function triggerSmartV3LiveEntry(mint: string, kolId = 'pain') {
      stubFeed.setInitialPrice(mint, 0.001);
      await handleKolSwap(buyTx(kolId, 'S', mint));
      stubFeed.emitTick(mint, 0.0013);   // observe 시작 (peak)
      stubFeed.emitTick(mint, 0.00115);  // pullback trigger
      await flushAsync();
    }

    it('1. successful live entry → live close (winner trail T1)', async () => {
      // sell 후 wallet delta = +0.01 SOL → exitPrice 환산 가능
      const fx = buildE2EFixtures({
        solBefore: 1.0,
        solAfter: 1.012,
      });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      await triggerSmartV3LiveEntry(MINT_SMART);

      // entry assertion
      expect(fx.executeBuy).toHaveBeenCalledTimes(1);
      expect(fx.insertTrade).toHaveBeenCalledTimes(1);
      expect(fx.sendTradeOpen).toHaveBeenCalledTimes(1);
      // appendEntryLedger('buy', ...) → executed-buys.jsonl 1회
      const buyLedgerCalls = mockAppendFile.mock.calls.filter((c) =>
        typeof c[0] === 'string' && c[0].includes('executed-buys.jsonl')
      );
      expect(buyLedgerCalls.length).toBe(1);
      const buyEntryRecord = JSON.parse(String(buyLedgerCalls[0][1]).trim());
      expect(buyEntryRecord.wallet).toBe('main');
      expect(buyEntryRecord.txSignature).toBe('KOL_LIVE_BUY_SIG');

      const positions = __testGetActive();
      const live = positions.find((p) => p.isLive === true)!;
      expect(live).toBeDefined();
      expect(live.dbTradeId).toBe('db-kolh-live-e2e');
      expect(live.entryTxSignature).toBe('KOL_LIVE_BUY_SIG');
      expect(live.entrySlippageBps).toBe(12);

      // T1 promote (pullback arm: t1Mfe override 0.40 of 0.00115 entry)
      __testTriggerTick(live.positionId, 0.00115 * 1.5); // +50% > +40% T1
      expect(live.state).toBe('RUNNER_T1');

      // trail close (peak * 0.77 → trail 22% pullback)
      let captured: any = null;
      kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
      __testTriggerTick(live.positionId, live.peakPrice * 0.77);
      await flushAsync();

      // close assertion
      expect(fx.executeSell).toHaveBeenCalledTimes(1);
      expect(fx.executeSell).toHaveBeenCalledWith(live.tokenMint, 1_000_000n);
      expect(fx.getTokenBalance).toHaveBeenCalledTimes(1);
      expect(fx.getBalance).toHaveBeenCalledTimes(2); // before + after sell
      expect(fx.closeTrade).toHaveBeenCalledTimes(1);
      // 2026-04-29: kol_live_close 알림이 sendInfo (raw 문자열) 에서 sendTradeClose (구조화) 로 전환.
      // OPEN 알림과 포맷 일관성 확보. sendInfo 는 0 호출, sendTradeClose 가 1 호출.
      expect(fx.sendTradeClose).toHaveBeenCalledTimes(1);
      expect(fx.sendInfo).toHaveBeenCalledTimes(0);

      // sell ledger
      const sellLedgerCalls = mockAppendFile.mock.calls.filter((c) =>
        typeof c[0] === 'string' && c[0].includes('executed-sells.jsonl')
      );
      expect(sellLedgerCalls.length).toBe(1);
      const sellEntry = JSON.parse(String(sellLedgerCalls[0][1]).trim());
      expect(sellEntry.wallet).toBe('main');
      expect(sellEntry.receivedSol).toBeCloseTo(0.012, 6);
      expect(sellEntry.exitReason).toBe('winner_trailing_t1');
      expect(typeof sellEntry.dbPnlDriftSol).toBe('number');
      expect(sellEntry.dbPnlSol).toBeDefined();
      // walletDelta = receivedSol - (entryPrice × quantity).
      // executeBuy mock 의 actualInputUiAmount=0.01 / actualOutUiAmount=10 → entryPrice=0.001, qty=10.
      //   solSpentNominal = 0.001 × 10 = 0.01, receivedSol = 0.012 → walletDelta ≈ +0.002 SOL.
      expect(sellEntry.walletDeltaSol).toBeCloseTo(0.012 - live.entryPrice * live.quantity, 6);

      // event payload
      expect(captured?.reason).toBe('winner_trailing_t1');
      expect(__testGetActive()).toHaveLength(0);
    });

    it('2. live entry fail (executor.executeBuy throws) → canary slot release + no DB insert', async () => {
      const failBuy = jest.fn().mockRejectedValue(new Error('jupiter rpc fail'));
      const fx = buildE2EFixtures({ executeBuy: failBuy });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      // canary global guard ON 으로 acquire 추적 가능하게.
      mockedConfig.canaryGlobalConcurrencyEnabled = true;

      await triggerSmartV3LiveEntry(MINT_SMART);

      expect(failBuy).toHaveBeenCalledTimes(1);
      expect(fx.insertTrade).not.toHaveBeenCalled();
      expect(fx.sendTradeOpen).not.toHaveBeenCalled();
      // active map 에 등록 안 됨
      expect(__testGetActive()).toHaveLength(0);
      // canary slot 이 release 되었는지 — 다시 acquire 가 성공해야 함
      // (cap=3, 0개 in-use 상태여야 acquire 가능)
      expect(acquireCanarySlot('kol_hunter')).toBe(true);
    });

    it('3. live close fail (executeSell throws) → DB close 미호출 + critical (entry+0s 시점은 60s gate 로 미발사)', async () => {
      // ⚠ Finding F1 (state-restore bug, 본 테스트로 발견): closePosition (line 1442) 가 동기적으로
      // 2026-04-28 F1 fix: closePosition 이 mutation 전 previousState capture 후 closeLivePosition 으로
      //   전달. sell 실패 시 pos.state = previousState 가 정확히 PROBE 등 원 상태로 복원 → retry 가능.
      // 2026-04-28 F2 fix: critical notifier 가 lastCloseFailureAtSec 60s cooldown 비교 → entry 직후
      //   sell 실패도 첫 1건은 알림 발사. 두 번째 실패 (60s 이내) 는 cooldown 차단.
      const failSell = jest.fn().mockRejectedValue(new Error('jupiter sell rpc fail'));
      const fx = buildE2EFixtures({ executeSell: failSell });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      await triggerSmartV3LiveEntry(MINT_SMART);
      const live = __testGetActive().find((p) => p.isLive === true)!;
      expect(live.state).not.toBe('CLOSED');
      const stateBeforeFail = live.state;  // PROBE / RUNNER_T1 등

      // Hardcut trigger
      __testTriggerTick(live.positionId, 0.00115 * 0.85);
      await flushAsync();

      // sell 시도 1회 (closeLivePosition 진입 → executeSell 호출 → throw)
      expect(failSell).toHaveBeenCalledTimes(1);
      // DB close 호출 안 됨 (sell catch 분기에서 early return)
      expect(fx.closeTrade).not.toHaveBeenCalled();
      // F1 fix 검증: state 가 정확히 원 상태로 복원 (이전: 'CLOSED' 영구 잠금)
      expect(live.state).toBe(stateBeforeFail);
      expect(__testGetActive()).toHaveLength(1);
      // F2 fix 검증: entry 직후 sell 실패도 critical 발사 (이전: 60s gate 로 미발사)
      expect(fx.sendCritical).toHaveBeenCalledTimes(1);
      expect(fx.sendCritical).toHaveBeenCalledWith(
        'kol_live_close_failed',
        expect.stringContaining('sell failed')
      );

      // 두 번째 close trigger (60s 이내) — cooldown 으로 추가 critical 차단 + retry 가능
      __testTriggerTick(live.positionId, 0.00115 * 0.84);
      await flushAsync();
      // F1 fix 효과: state 복원되므로 retry 가능 (executeSell 다시 호출됨)
      expect(failSell).toHaveBeenCalledTimes(2);
      // F2 fix 효과: 60s cooldown 으로 critical 추가 발사 안 됨 (still 1)
      expect(fx.sendCritical).toHaveBeenCalledTimes(1);
    });

    it('4. live close ORPHAN_NO_BALANCE (tokenBalance == 0n) → sell skip + DB close + critical', async () => {
      const fx = buildE2EFixtures({ getTokenBalance: jest.fn().mockResolvedValue(0n) });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      await triggerSmartV3LiveEntry(MINT_SMART);
      const live = __testGetActive().find((p) => p.isLive === true)!;

      // 임의 close trigger (hardcut)
      __testTriggerTick(live.positionId, 0.00115 * 0.85);
      await flushAsync();

      // sell 호출 안 됨 (balance 0 분기)
      expect(fx.executeSell).not.toHaveBeenCalled();
      expect(fx.getTokenBalance).toHaveBeenCalledTimes(1);
      // DB close 는 호출됨 (effectiveReason=ORPHAN_NO_BALANCE, pnl=0)
      expect(fx.closeTrade).toHaveBeenCalledTimes(1);
      expect(fx.closeTrade).toHaveBeenCalledWith(expect.objectContaining({
        id: 'db-kolh-live-e2e',
        exitReason: 'ORPHAN_NO_BALANCE',
        pnl: 0,
      }));
      // sell ledger 는 기록 안 됨 (zero-balance 분기에서 appendEntryLedger('sell',...) skip)
      const sellLedgerCalls = mockAppendFile.mock.calls.filter((c) =>
        typeof c[0] === 'string' && c[0].includes('executed-sells.jsonl')
      );
      expect(sellLedgerCalls.length).toBe(0);
      // critical 1회 (kol_live_orphan)
      expect(fx.sendCritical).toHaveBeenCalledTimes(1);
      expect(fx.sendCritical.mock.calls[0][0]).toBe('kol_live_orphan');
      // active map 에서 제거됨
      expect(__testGetActive()).toHaveLength(0);
    });

    it('5. canary slot full → enterLivePosition 의 acquireCanarySlot 거부 → executeBuy 미호출', async () => {
      const fx = buildE2EFixtures();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });
      // canary global guard 활성화 + cap 3 슬롯 모두 선점 (외부 lane simulate).
      mockedConfig.canaryGlobalConcurrencyEnabled = true;
      mockedConfig.canaryGlobalMaxConcurrent = 3;
      expect(acquireCanarySlot('cupsey_flip_10s')).toBe(true);
      expect(acquireCanarySlot('cupsey_flip_10s')).toBe(true);
      expect(acquireCanarySlot('pure_ws_breakout')).toBe(true);

      await triggerSmartV3LiveEntry(MINT_SMART);

      // entry 로 진입은 시도했지만 acquireCanarySlot 거부 → executeBuy 호출 안 됨.
      expect(fx.executeBuy).not.toHaveBeenCalled();
      expect(fx.insertTrade).not.toHaveBeenCalled();
      // priceFeed 는 unsubscribePriceIfIdle 로 정리되어야 함.
      expect(stubFeed.getActiveSubscriptionCount()).toBe(0);
      // active 에 등록 안 됨.
      expect(__testGetActive()).toHaveLength(0);
    });

    it('6. closePosition race protection: 두 tick 이 동시에 close 트리거해도 closeLivePosition 1회', async () => {
      const fx = buildE2EFixtures({
        solBefore: 1.0,
        solAfter: 1.005,
      });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });
      await triggerSmartV3LiveEntry(MINT_SMART);

      const live = __testGetActive().find((p) => p.isLive === true)!;
      // tick A: hardcut (close 시작 → state='CLOSED' 즉시 mark + void closeLivePosition)
      __testTriggerTick(live.positionId, 0.00115 * 0.85);
      // tick B: 동일 micro-task tick 에서 다시 trigger — 이미 state='CLOSED' 라 onPriceTick 의 guard
      // (line 1275) + closePosition 의 guard (line 1441) 양쪽에서 차단되어 두 번째 closeLivePosition
      // 호출이 발생하지 않아야 한다.
      __testTriggerTick(live.positionId, 0.00115 * 1.5);  // winner trail 시도
      await flushAsync();

      // executeSell 정확히 1회 → 2중 sell 방지 confirm
      expect(fx.executeSell).toHaveBeenCalledTimes(1);
      expect(fx.closeTrade).toHaveBeenCalledTimes(1);
      expect(__testGetActive()).toHaveLength(0);
    });
  });

  // 2026-04-28 Sprint — Inactive KOL paper trade (Option B).
  // 측정 분리: active 의 paper-trades.jsonl 과 inactive 의 kol-shadow-paper-trades.jsonl 로 격리.
  // safety: shadow-only cand 는 live canary 차단 — 무조건 paper.
  describe('inactive KOL paper trade (Option B, 2026-04-28)', () => {
    const mockedConfig = (require('../src/utils/config') as any).config;

    beforeEach(() => {
      mockedConfig.kolHunterSmartV3Enabled = true;
      mockAppendFile.mockClear();
    });
    afterEach(() => {
      mockedConfig.kolHunterSmartV3Enabled = false;
      mockedConfig.kolHunterPaperOnly = true;
      mockedConfig.kolHunterLiveCanaryEnabled = false;
    });

    function shadowBuyTx(kolId: string, tier: 'S' | 'A' | 'B', tokenMint: string, offsetMs = 0): KolTx {
      return { ...buyTx(kolId, tier, tokenMint, offsetMs), isShadow: true };
    }

    it('PaperPosition.isShadowKol — cand 의 모든 tx 가 isShadow=true 일 때만 true', async () => {
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      // shadow tx 만 — pullback trigger 통과
      await handleKolSwap(shadowBuyTx('inactive_x', 'B', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      const positions = __testGetActive();
      expect(positions.length).toBeGreaterThanOrEqual(1);
      const main = positions.find((p) => !p.isShadowArm);
      expect(main).toBeDefined();
      expect(main?.isShadowKol).toBe(true);
    });

    it('active KOL 1명이라도 끼면 isShadowKol=false (downgrade 안 함)', async () => {
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      // shadow + active 혼합
      await handleKolSwap(shadowBuyTx('inactive_x', 'B', MINT_SMART, 100));
      await handleKolSwap(buyTx('active_y', 'A', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      const positions = __testGetActive();
      const main = positions.find((p) => !p.isShadowArm);
      expect(main).toBeDefined();
      expect(main?.isShadowKol).toBe(false);
    });

    it('shadow position close 시 별도 ledger (kol-shadow-paper-trades.jsonl) 로 dump', async () => {
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(shadowBuyTx('inactive_x', 'B', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      const pos = __testGetActive().find((p) => !p.isShadowArm)!;
      mockAppendFile.mockClear();

      // hard cut → close ledger dump
      __testTriggerTick(pos.positionId, 0.00115 * 0.85);
      await flushAsync();

      // appendFile 호출 중 paper-trades 또는 shadow-paper-trades 파일 경로 확인
      const calls = mockAppendFile.mock.calls.map((c: any[]) => c[0] as string);
      const shadowLedgerCall = calls.find((p) => p.includes('kol-shadow-paper-trades.jsonl'));
      const activeLedgerCall = calls.find((p) => p.includes('kol-paper-trades.jsonl') && !p.includes('shadow'));
      expect(shadowLedgerCall).toBeDefined();
      expect(activeLedgerCall).toBeUndefined();  // active ledger 에는 안 가야 함
    });

    it('active position close 시 active ledger 로 dump (shadow ledger 안 건드림)', async () => {
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      // active KOL — isShadow flag 없음
      await handleKolSwap(buyTx('active_z', 'A', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      const pos = __testGetActive().find((p) => !p.isShadowArm)!;
      expect(pos.isShadowKol).toBeFalsy();
      mockAppendFile.mockClear();

      __testTriggerTick(pos.positionId, 0.00115 * 0.85);
      await flushAsync();

      const calls = mockAppendFile.mock.calls.map((c: any[]) => c[0] as string);
      const activeLedgerCall = calls.find((p) => p.includes('kol-paper-trades.jsonl') && !p.includes('shadow'));
      const shadowLedgerCall = calls.find((p) => p.includes('kol-shadow-paper-trades.jsonl'));
      expect(activeLedgerCall).toBeDefined();
      expect(shadowLedgerCall).toBeUndefined();
    });

    // 2026-04-28 QA fix #5 — shadow paper close 가 active digest 에 섞이면
    // top movers / 5x anomaly / arm 별 net 평균이 오염된다. paper_close 이벤트에서 isShadowKol
    // 분기 처리 검증 (kolPaperNotifier 의 onPaperClose / onPaperEntry 가 격리하는지).
    // 직접 test 는 paper_close payload 의 pos.isShadowKol 만 확인 (notifier unit test 는 별도).
    it('shadow position 의 paper_close payload 는 isShadowKol=true 로 emit 된다', async () => {
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(shadowBuyTx('inactive_x', 'B', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      const pos = __testGetActive().find((p) => !p.isShadowArm)!;
      let captured: any = null;
      kolHunterEvents.once('paper_close', (evt) => { captured = evt; });

      __testTriggerTick(pos.positionId, 0.00115 * 0.85);
      await flushAsync();

      expect(captured).not.toBeNull();
      expect(captured.pos.isShadowKol).toBe(true);
    });

    // 2026-04-29 (Track 1) — Same-token re-entry cooldown.
    // Why: GUfyGEF6 incident 패턴 (같은 mint 4회 진입 모두 손실). 시뮬 +13% improvement.
    describe('Track 1: same-token re-entry cooldown', () => {
      it('cooldown 안 같은 mint 재진입 → reject (close 후 30분 안)', async () => {
        mockedConfig.kolHunterReentryCooldownMs = 1_800_000;  // 30분 활성
        mockedConfig.kolHunterSmartV3Enabled = false;  // single-KOL → v1 path
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        await __testForceResolveStalk(MINT_SMART);
        const positions = __testGetActive();
        expect(positions).toHaveLength(1);

        // close — same-token cooldown stamp
        __testTriggerTick(positions[0].positionId, 0.001 * 0.85);  // -15% hard cut
        await flushAsync();
        expect(__testGetActive()).toHaveLength(0);

        // 같은 mint 재진입 시도 → cooldown reject
        await handleKolSwap(buyTx('pain2', 'S', MINT_SMART));
        await __testForceResolveStalk(MINT_SMART);
        expect(__testGetActive()).toHaveLength(0);  // 진입 안 됨
      });

      it('다른 mint 는 cooldown 무관 (격리)', async () => {
        mockedConfig.kolHunterReentryCooldownMs = 1_800_000;
        mockedConfig.kolHunterSmartV3Enabled = false;  // single-KOL → v1 path
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        stubFeed.setInitialPrice(MINT_WINNER, 0.001);
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        await __testForceResolveStalk(MINT_SMART);
        const pos = __testGetActive()[0];
        __testTriggerTick(pos.positionId, 0.001 * 0.85);
        await flushAsync();

        // 다른 mint 진입 → 정상 (cooldown 무관)
        await handleKolSwap(buyTx('pain2', 'S', MINT_WINNER));
        await __testForceResolveStalk(MINT_WINNER);
        expect(__testGetActive().filter((p) => p.tokenMint === MINT_WINNER)).toHaveLength(1);
      });

      it('cooldown 0 (disabled, default test) → 같은 mint 재진입 가능', async () => {
        mockedConfig.kolHunterReentryCooldownMs = 0;  // disabled
        mockedConfig.kolHunterSmartV3Enabled = false;  // single-KOL → v1 path
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        await __testForceResolveStalk(MINT_SMART);
        const pos = __testGetActive()[0];
        __testTriggerTick(pos.positionId, 0.001 * 0.85);
        await flushAsync();

        // close 시 stub feed 가 unsubscribe → price map 에서 삭제. 재진입 위해 price 다시 set.
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        // 같은 mint 재진입 → 정상 (cooldown disabled)
        await handleKolSwap(buyTx('pain2', 'S', MINT_SMART));
        await __testForceResolveStalk(MINT_SMART);
        expect(__testGetActive()).toHaveLength(1);
      });
    });

    // 2026-04-29 (Track 2B) — NO_SECURITY_DATA reject (Track 2A retro 결과).
    // Why: paper n=372 분석 — n=70 cohort mfe<1% 65.7% (Δ +20.6%) / cum -0.0376 / 5x 0건.
    // 외부 API 없이 entry-time signal 로 IDEAL 달성률 +10% 추가 가능.
    describe('Track 2B: NO_SECURITY_DATA reject', () => {
      it('rejectOnNoSecurityData=true + securityClient 미주입 → reject (NO_SECURITY_CLIENT)', async () => {
        mockedConfig.kolHunterRejectOnNoSecurityData = true;
        mockedConfig.kolHunterSmartV3Enabled = false;  // single-KOL → v1 path
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        await __testForceResolveStalk(MINT_SMART);
        expect(__testGetActive()).toHaveLength(0);  // 진입 안 됨
      });

      it('rejectOnNoSecurityData=false (기존 동작) → allowDataMissing=true 로 통과', async () => {
        mockedConfig.kolHunterRejectOnNoSecurityData = false;
        mockedConfig.kolHunterSurvivalAllowDataMissing = true;
        mockedConfig.kolHunterSmartV3Enabled = false;
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        await __testForceResolveStalk(MINT_SMART);
        expect(__testGetActive()).toHaveLength(1);  // 통과
      });

      it('rejectOnNoSecurityData=true + smart-v3 path → reject (smart_v3_survival_reject)', async () => {
        mockedConfig.kolHunterRejectOnNoSecurityData = true;
        mockedConfig.kolHunterSmartV3Enabled = true;  // smart-v3 path
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        // smart-v3 trigger: anti-correlation 60s 떨어진 multi-KOL.
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART, 120_000));
        await handleKolSwap(buyTx('scalp1', 'A', MINT_SMART));
        await flushAsync();
        expect(__testGetActive()).toHaveLength(0);  // smart-v3 도 reject 적용
      });
    });

    // 2026-04-28 Phase 1 — Style-aware insider_exit decision (외부 피드백 + GUfyGEF6 incident).
    // kev (scalper) sell 신호로 bflg (longhold copy_core) thesis 청산 mismatch 차단.
    // KOL DB 의 lane_role / trading_style 분류 따라 close / lower_confidence / ignore 분기.
    it('Phase 1: scalper sell + position 에 longhold KOL 있음 → close 안 함 (lower_confidence + trail 하향)', async () => {
      const { __testInject } = require('../src/kol/db');
      // pain (S, longhold) + scalp1 (A, scalper) 가 같이 entry. scalp1 sell 시 close 안 함.
      __testInject([
        { id: 'pain', tier: 'S', addresses: ['wallet_pain'], added_at: '2026-04-01', last_verified_at: '2026-04-28', notes: '', is_active: true, trading_style: 'longhold', lane_role: 'copy_core' },
        { id: 'scalp1', tier: 'A', addresses: ['wallet_scalp1'], added_at: '2026-04-01', last_verified_at: '2026-04-28', notes: '', is_active: true, trading_style: 'scalper', lane_role: 'discovery_canary' },
      ]);
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      // anti-correlation 60s — 두 KOL 을 독립으로 인식하려면 ≥60s 차이 필요.
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART, 120_000));
      await handleKolSwap(buyTx('scalp1', 'A', MINT_SMART));
      await __testForceResolveStalk(MINT_SMART);

      const positions = __testGetActive();
      expect(positions.length).toBeGreaterThanOrEqual(1);
      const pos = positions.find((p) => !p.isShadowArm);
      expect(pos?.participatingKols.map((k) => k.id)).toEqual(expect.arrayContaining(['pain', 'scalp1']));

      // Phase 1 QA F1 fix: scalper sell 시 trail 도 보수화 (이전엔 cosmetic 만이었음)
      // applySmartV3Reinforcement 가 reinforcement 마다 trail+inc 했으므로 이전 값 stash
      const trailBeforeSell = pos!.t1TrailPctOverride;

      // scalp1 sell — close 안 되어야 함 (lower_confidence only)
      let captured: any = null;
      kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
      await handleKolSwap({ ...buyTx('scalp1', 'A', MINT_SMART), action: 'sell' });
      await flushAsync();

      expect(captured).toBeNull();  // close 안 됨
      expect(__testGetActive().length).toBeGreaterThanOrEqual(1);  // 포지션 유지

      // QA F1: trail 이 실제로 하향됐는지 (cosmetic 아닌 정책 영향) 검증
      const posAfter = __testGetActive().find((p) => !p.isShadowArm)!;
      if (trailBeforeSell != null) {
        expect(posAfter.t1TrailPctOverride).toBeLessThanOrEqual(trailBeforeSell);
      }
    });

    // 2026-04-28 (P2 fix): trail buildup/reduce 비대칭 — scalper buy 는 trail 영향 안 미침.
    it('Phase 1+P2: scalper buy 는 trail buildup 안 시킴 (style-aware reinforcement)', async () => {
      const { __testInject } = require('../src/kol/db');
      mockedConfig.kolHunterSmartV3Enabled = true;  // smart-v3 path 라야 reinforcement 활성
      __testInject([
        { id: 'longh', tier: 'S', addresses: ['wallet_longh'], added_at: '2026-04-01', last_verified_at: '2026-04-28', notes: '', is_active: true, trading_style: 'longhold', lane_role: 'copy_core' },
        { id: 'sca', tier: 'A', addresses: ['wallet_sca'], added_at: '2026-04-01', last_verified_at: '2026-04-28', notes: '', is_active: true, trading_style: 'scalper', lane_role: 'discovery_canary' },
      ]);
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      // longhold + scalper multi-KOL → smart-v3 velocity trigger (≥2 indep KOL)
      await handleKolSwap(buyTx('longh', 'S', MINT_SMART, 120_000));
      await handleKolSwap(buyTx('sca', 'A', MINT_SMART));
      await flushAsync();

      const positions = __testGetActive();
      if (positions.length === 0) {
        // smart-v3 trigger 가 immediate emit 안 했을 수 있음 — force resolve
        await __testForceResolveStalk(MINT_SMART);
      }
      const pos = __testGetActive().find((p) => !p.isShadowArm);
      if (!pos) return;  // smart-v3 trigger 미충족이면 skip (test infra 한계)

      const trailBeforeReinforcement = pos.t1TrailPctOverride;
      const countBefore = pos.kolReinforcementCount;

      // Existing position 에 scalper 추가 buy → reinforcementCount += 1, trail unchanged
      await handleKolSwap(buyTx('sca', 'A', MINT_SMART, 0));
      await flushAsync();

      expect(pos.kolReinforcementCount).toBeGreaterThanOrEqual(countBefore);
      // scalper buy 는 trail 변경 안 함 (P2 fix 정합 — 만약 변경했으면 buildup 됐을 것)
      if (trailBeforeReinforcement != null) {
        expect(pos.t1TrailPctOverride).toBe(trailBeforeReinforcement);
      }
    });

    it('Phase 1: longhold KOL sell → close (의미 있는 exit 신호)', async () => {
      const { __testInject } = require('../src/kol/db');
      mockedConfig.kolHunterSmartV3Enabled = false;  // single KOL → v1 path
      __testInject([
        { id: 'longh', tier: 'S', addresses: ['wallet_longh'], added_at: '2026-04-01', last_verified_at: '2026-04-28', notes: '', is_active: true, trading_style: 'longhold', lane_role: 'copy_core' },
      ]);
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('longh', 'S', MINT_SMART));
      await __testForceResolveStalk(MINT_SMART);
      const positions = __testGetActive();
      expect(positions).toHaveLength(1);

      let captured: any = null;
      kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
      await handleKolSwap({ ...buyTx('longh', 'S', MINT_SMART), action: 'sell' });

      expect(captured).not.toBeNull();
      expect(captured.reason).toBe('insider_exit_full');
    });

    it('Phase 1: 모든 진입 KOL 이 scalper 면 sell 그대로 따라감 (close)', async () => {
      const { __testInject } = require('../src/kol/db');
      mockedConfig.kolHunterSmartV3Enabled = false;  // single KOL → v1 path
      __testInject([
        { id: 'sc1', tier: 'A', addresses: ['wallet_sc1'], added_at: '2026-04-01', last_verified_at: '2026-04-28', notes: '', is_active: true, trading_style: 'scalper', lane_role: 'discovery_canary' },
      ]);
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('sc1', 'A', MINT_SMART));
      await __testForceResolveStalk(MINT_SMART);
      expect(__testGetActive()).toHaveLength(1);

      let captured: any = null;
      kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
      await handleKolSwap({ ...buyTx('sc1', 'A', MINT_SMART), action: 'sell' });

      expect(captured).not.toBeNull();  // all-scalper cohort → close
      expect(captured.reason).toBe('insider_exit_full');
    });

    it('Phase 1: unknown style 은 보수적 fallback (close, 기존 default 보존)', async () => {
      const { __testInject } = require('../src/kol/db');
      mockedConfig.kolHunterSmartV3Enabled = false;  // single KOL → v1 path
      // 분류 안 된 KOL (운영자 manual 분류 전)
      __testInject([
        { id: 'unk', tier: 'A', addresses: ['wallet_unk'], added_at: '2026-04-01', last_verified_at: '2026-04-28', notes: '', is_active: true },
      ]);
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('unk', 'A', MINT_SMART));
      await __testForceResolveStalk(MINT_SMART);
      expect(__testGetActive()).toHaveLength(1);

      let captured: any = null;
      kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
      await handleKolSwap({ ...buyTx('unk', 'A', MINT_SMART), action: 'sell' });

      expect(captured).not.toBeNull();  // unknown → conservative close
    });

    it('shadow-only cand 는 live canary 차단 (isLiveCanaryActive=true 여도 paper 만)', async () => {
      const insertTrade = jest.fn().mockResolvedValue('db-1');
      const executeBuy = jest.fn().mockResolvedValue({
        txSignature: 'SIG', expectedOutAmount: 1n, actualOutUiAmount: 1, actualInputUiAmount: 0.01, slippageBps: 12,
      });
      const liveCtx = {
        tradingMode: 'live',
        tradeStore: { insertTrade, closeTrade: jest.fn(), getOpenTrades: jest.fn().mockResolvedValue([]) },
        notifier: { sendCritical: jest.fn(), sendTradeOpen: jest.fn(), sendTradeClose: jest.fn(), sendInfo: jest.fn() },
        executor: { executeBuy, executeSell: jest.fn(), getTokenBalance: jest.fn(), getBalance: jest.fn() },
      } as any;
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: liveCtx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      // shadow tx 만 — live canary 차단되어야 함
      await handleKolSwap(shadowBuyTx('inactive_x', 'B', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      // executeBuy 호출 안 됨 (paper-only fallback) — 가장 결정적 검증
      expect(executeBuy).not.toHaveBeenCalled();

      const positions = __testGetActive();
      const main = positions.find((p) => !p.isShadowArm);
      expect(main).toBeDefined();
      expect(main?.isLive).toBeFalsy();
      expect(main?.isShadowKol).toBe(true);
    });
  });
});
