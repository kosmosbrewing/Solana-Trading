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
    kolHunterLiveCanaryEnabled: false,
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
    const mockedConfig = (require('../src/utils/config') as any).config;
    mockedConfig.kolHunterSmartV3Enabled = false;
    mockedConfig.kolHunterSwingV2Enabled = false;
    mockedConfig.kolHunterSwingV2T1TrailPct = 0.25;
    mockedConfig.kolHunterSwingV2T1ProfitFloorMult = 1.10;
    stubFeed = new StubPaperPriceFeed();
    __testInit({ priceFeed: stubFeed as unknown as never });
  });

  afterEach(() => {
    stopKolHunter();
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
});
