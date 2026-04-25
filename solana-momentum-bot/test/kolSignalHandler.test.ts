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
  stopKolHunter,
  kolHunterEvents,
} from '../src/orchestration/kolSignalHandler';
import type { KolTx } from '../src/kol/types';

// 최소 Stub PaperPriceFeed — subscribe/unsubscribe + getLastPrice + on/off 지원
class StubPaperPriceFeed extends EventEmitter {
  public prices = new Map<string, number>();
  subscribe(mint: string) { /* noop */ void mint; }
  unsubscribe(mint: string) { this.prices.delete(mint); }
  getLastPrice(mint: string): { price: number; timestamp: number } | null {
    const p = this.prices.get(mint);
    return p != null ? { price: p, timestamp: Date.now() } : null;
  }
  getActiveSubscriptionCount() { return this.prices.size; }
  stopAll() { this.prices.clear(); }
  setInitialPrice(mint: string, price: number) { this.prices.set(mint, price); }
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
    // 2026-04-25 MISSION_CONTROL §KOL Control survival 통합. Unit tests 는 securityClient 미주입 + allowDataMissing=true 로 진입 허용.
    kolHunterSurvivalAllowDataMissing: true,
    kolHunterSurvivalMinExitLiquidityUsd: 5000,
    kolHunterSurvivalMaxTop10HolderPct: 0.80,
    kolHunterRunSellQuoteProbe: false,
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

describe('kolSignalHandler — state machine', () => {
  let stubFeed: StubPaperPriceFeed;

  beforeEach(() => {
    stopKolHunter();
    jest.clearAllMocks();
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
});
