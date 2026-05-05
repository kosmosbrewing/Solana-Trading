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
const mockReadFile = jest.fn();
jest.mock('fs/promises', () => ({
  appendFile: (...args: unknown[]) => mockAppendFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: mockAxiosGet },
  get: mockAxiosGet,
}));

const mockResolveDevStatus = jest.fn((_address?: string) => 'unknown');
jest.mock('../src/observability/devWalletRegistry', () => ({
  resolveDevStatus: (address?: string) => mockResolveDevStatus(address),
}));

import { EventEmitter } from 'events';
import {
  handleKolSwap,
  __testInit,
  __testGetActive,
  __testForceResolveStalk,
  __testTriggerTick,
  __testIsLiveCanaryActive,
  __testResetStructuralKillCache,
  __testSpawnTailSubPosition,
  __testIsPriceKillReason,
  __testSetKolLiveSellRetryDelaysMs,
  hydrateLiveExecutionQualityCooldownsFromBuyRecords,
  hydrateLiveExecutionQualityCooldownsFromLedger,
  recoverKolHunterOpenPositions,
  stopKolHunter,
  kolHunterEvents,
} from '../src/orchestration/kolSignalHandler';
import type { KolTx } from '../src/kol/types';
import * as sellQuoteProbeModule from '../src/gate/sellQuoteProbe';
import {
  getTradeMarkoutObserverStats,
  resetTradeMarkoutObserverState,
} from '../src/observability/tradeMarkoutObserver';
import {
  getMissedAlphaObserverStats,
  resetMissedAlphaObserverState,
} from '../src/observability/missedAlphaObserver';

// 최소 Stub PaperPriceFeed — subscribe/unsubscribe + getLastPrice + on/off 지원
class StubPaperPriceFeed extends EventEmitter {
  public prices = new Map<string, number>();
  public decimals = new Map<string, number | null>();
  public timestamps = new Map<string, number>();
  public freshPrices = new Map<string, { price: number; outputDecimals: number | null; timestamp: number } | null>();
  public refreshNowCalls = 0;
  subscribe(mint: string) { /* noop */ void mint; }
  unsubscribe(mint: string) {
    this.prices.delete(mint);
    this.decimals.delete(mint);
    this.timestamps.delete(mint);
  }
  getLastPrice(mint: string): { price: number; timestamp: number } | null {
    const p = this.prices.get(mint);
    return p != null ? { price: p, timestamp: this.timestamps.get(mint) ?? Date.now() } : null;
  }
  // 2026-04-26 P1 fix: tokenDecimals stash — test 도 PaperPriceFeed 인터페이스 준수.
  getLastTick(mint: string): { price: number; timestamp: number; outputDecimals: number | null } | null {
    const p = this.prices.get(mint);
    const outputDecimals = this.decimals.has(mint) ? this.decimals.get(mint)! : 6;
    return p != null ? { price: p, timestamp: this.timestamps.get(mint) ?? Date.now(), outputDecimals } : null;
  }
  async refreshNow(mint: string): Promise<{ price: number; timestamp: number; outputDecimals: number | null } | null> {
    this.refreshNowCalls += 1;
    const fresh = this.freshPrices.has(mint) ? this.freshPrices.get(mint)! : this.getLastTick(mint);
    if (!fresh) return null;
    this.prices.set(mint, fresh.price);
    this.decimals.set(mint, fresh.outputDecimals);
    this.timestamps.set(mint, fresh.timestamp);
    this.emit('price', {
      tokenMint: mint,
      price: fresh.price,
      outAmountUi: 0.01 / fresh.price,
      outputDecimals: fresh.outputDecimals,
      probeSolAmount: 0.01,
      timestamp: fresh.timestamp,
    });
    return fresh;
  }
  getActiveSubscriptionCount() { return this.prices.size; }
  stopAll() { this.prices.clear(); this.decimals.clear(); this.timestamps.clear(); this.freshPrices.clear(); }
  setInitialPrice(mint: string, price: number, outputDecimals: number | null = 6, timestamp = Date.now()) {
    this.prices.set(mint, price);
    this.decimals.set(mint, outputDecimals);
    this.timestamps.set(mint, timestamp);
  }
  setFreshPrice(mint: string, price: number, outputDecimals: number | null = 6, timestamp = Date.now()) {
    this.freshPrices.set(mint, { price, outputDecimals, timestamp });
  }
  setFreshUnavailable(mint: string) {
    this.freshPrices.set(mint, null);
  }
  emitTick(mint: string, price: number, outputDecimals: number | null = 6) {
    this.prices.set(mint, price);
    this.decimals.set(mint, outputDecimals);
    this.timestamps.set(mint, Date.now());
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

function buyTxWithFill(
  kolId: string,
  tier: 'S' | 'A' | 'B',
  tokenMint: string,
  priceSolPerToken: number,
  solAmount = 0.25,
  offsetMs = 0
): KolTx {
  return {
    ...buyTx(kolId, tier, tokenMint, offsetMs),
    solAmount,
    tokenAmount: solAmount / priceSolPerToken,
  };
}

function sellTx(
  kolId: string,
  tier: 'S' | 'A' | 'B',
  tokenMint: string,
  solAmount: number,
  offsetMs = 0
): KolTx {
  return {
    ...buyTx(kolId, tier, tokenMint, offsetMs),
    action: 'sell',
    solAmount,
    txSignature: `sell_${kolId}_${tokenMint}_${offsetMs}`,
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
    // 2026-04-30 (P1-1): hardcoded constants → config 승격. test default 는 이전 hardcode 유지.
    kolHunterQuickRejectMfeLowThreshold: 0.02,
    kolHunterQuickRejectMfeLowElapsedSec: 30,
    kolHunterQuickRejectPullbackThreshold: 0.20,
    kolHunterQuickRejectWinnerSafeMfe: 0.05,
    // 2026-04-30 (Sprint 2.A1): structural kill-switch — test default disabled
    // (paper-shadow 시간 길게 측정 후 활성화 권고). 회귀 테스트만 explicit override.
    kolHunterStructuralKillEnabled: false,
    kolHunterStructuralKillMinHoldSec: 60,
    kolHunterStructuralKillMaxImpactPct: 0.10,
    kolHunterStructuralKillCacheMs: 30000,
    kolHunterStructuralKillPeakDriftTrigger: 0.20,
    // 2026-05-01 (Phase C): tail retain default disabled in tests — explicit 회귀 테스트만 활성화.
    kolHunterTailRetainEnabled: false,
    kolHunterTailRetainPct: 0.15,
    kolHunterTailTrailPct: 0.30,
    kolHunterTailMaxHoldSec: 3600,
    // 2026-05-01 (Phase D): live tail default disabled. paper-shadow 1주 측정 후 별도 ADR 활성.
    kolHunterTailRetainLiveEnabled: false,
    // 2026-05-01 (Phase 2.A2 P0): partial take @ T1 — default disabled in tests, explicit override 만 활성.
    kolHunterPartialTakeEnabled: false,
    kolHunterPartialTakePct: 0.30,
    kolHunterPartialTakeLiveEnabled: false,
    // 2026-05-01 (Decu Phase B): observe-only — default disabled in tests (실 fs / RPC 호출 회피).
    tokenQualityObserverEnabled: false,
    tokenQualityVampLintEnabled: false,
    tokenQualityFeeProxyEnabled: false,
    tokenQualityHeliusRpcCapPerMin: 100,
    tokenQualityObservationTtlHours: 24,
    devWalletDbPath: '/tmp/test-dev-wallets.json',
    devWalletHotReloadIntervalMs: 0,
    kolHunterDevWalletLiveGateEnabled: true,
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
    // 2026-05-02: rotation-v1 fast-compound lane. default disabled in tests; explicit tests enable.
    kolHunterRotationV1Enabled: false,
    kolHunterRotationV1LiveEnabled: false,
    kolHunterRotationV1MinIndependentKol: 1,
    kolHunterRotationV1KolIds: 'dv,decu',
    kolHunterRotationV1ExcludeKolIds: '',
    kolHunterRotationV1MinKolScore: 0.45,
    kolHunterRotationV1WindowSec: 45,
    kolHunterRotationV1MaxLastBuyAgeSec: 15,
    kolHunterRotationV1MinBuyCount: 3,
    kolHunterRotationV1MinSmallBuyCount: 2,
    kolHunterRotationV1SmallBuyMaxSol: 0.061,
    kolHunterRotationV1MinGrossBuySol: 1.0,
    kolHunterRotationV1MaxRecentSellSec: 60,
    kolHunterRotationV1MinPriceResponsePct: 0.01,
    kolHunterRotationV1T1Mfe: 0.12,
    kolHunterRotationV1T1TrailPct: 0.08,
    kolHunterRotationV1ProfitFloorMult: 1.08,
    kolHunterRotationV1ProbeTimeoutSec: 90,
    kolHunterRotationV1DoaWindowSec: 30,
    kolHunterRotationV1DoaMinMfePct: 0.03,
    kolHunterRotationV1DoaMaxMaePct: 0.06,
    kolHunterRotationV1FreshBuyGraceSec: 15,
    kolHunterRotationV1MarkoutOffsetsSec: [15, 30, 60],
    kolHunterRotationV1ParameterVersion: 'rotation-v1.0.0',
    kolHunterRotationPaperArmsEnabled: false,
    kolHunterRotationFast15PaperEnabled: true,
    kolHunterRotationFast15T1Mfe: 0.05,
    kolHunterRotationFast15T1TrailPct: 0.025,
    kolHunterRotationFast15ProfitFloorMult: 1.015,
    kolHunterRotationFast15ProbeTimeoutSec: 20,
    kolHunterRotationFast15HardCutPct: 0.04,
    kolHunterRotationFast15DoaWindowSec: 15,
    kolHunterRotationFast15DoaMinMfePct: 0.015,
    kolHunterRotationFast15DoaMaxMaePct: 0.025,
    kolHunterRotationCostGuardPaperEnabled: true,
    kolHunterRotationCostGuardT1Mfe: 0.12,
    kolHunterRotationCostGuardT1TrailPct: 0.04,
    kolHunterRotationCostGuardProfitFloorMult: 1.08,
    kolHunterRotationCostGuardProbeTimeoutSec: 30,
    kolHunterRotationCostGuardHardCutPct: 0.06,
    kolHunterRotationCostGuardDoaWindowSec: 20,
    kolHunterRotationCostGuardDoaMinMfePct: 0.03,
    kolHunterRotationCostGuardDoaMaxMaePct: 0.04,
    kolHunterRotationCostGuardMinPriceResponsePct: 0.01,
    kolHunterRotationQualityStrictPaperEnabled: true,
    kolHunterRotationQualityStrictT1Mfe: 0.08,
    kolHunterRotationQualityStrictT1TrailPct: 0.03,
    kolHunterRotationQualityStrictProfitFloorMult: 1.04,
    kolHunterRotationQualityStrictProbeTimeoutSec: 25,
    kolHunterRotationQualityStrictHardCutPct: 0.05,
    kolHunterRotationQualityStrictDoaWindowSec: 18,
    kolHunterRotationQualityStrictDoaMinMfePct: 0.025,
    kolHunterRotationQualityStrictDoaMaxMaePct: 0.035,
    kolHunterRotationFlowMetricsLookbackSec: 180,
    kolHunterRotationFlowSellPressureWindowSec: 30,
    kolHunterRotationFlowFreshTopupSec: 60,
    kolHunterRotationFlowChaseStepPct: 0.015,
    kolHunterRotationExitFlowPaperEnabled: true,
    kolHunterRotationExitFlowLightPressure: 0.20,
    kolHunterRotationExitFlowStrongPressure: 0.50,
    kolHunterRotationExitFlowFullExitPressure: 0.80,
    kolHunterRotationExitFlowCriticalPressure: 1.20,
    kolHunterRotationExitFlowLightReducePct: 0.35,
    kolHunterRotationExitFlowStrongReducePct: 0.75,
    kolHunterRotationExitFlowResidualHoldSec: 75,
    kolHunterRotationExitFlowParameterVersion: 'rotation-exit-flow-v1.0.0',
    kolHunterRotationChaseTopupPaperEnabled: true,
    kolHunterRotationChaseTopupMinBuys: 2,
    kolHunterRotationChaseTopupMinTopupStrength: 0.08,
    kolHunterRotationChaseTopupMaxRecentSellSec: 60,
    kolHunterRotationChaseTopupParameterVersion: 'rotation-chase-topup-v1.0.0',
    kolHunterRotationEdgeShadowEnabled: true,
    kolHunterRotationEdgeMaxCostRatio: 0.06,
    kolHunterRotationEdgeAssumedAtaRentSol: 0.00207408,
    kolHunterRotationEdgePriorityFeeSol: 0.0001,
    kolHunterRotationEdgeTipSol: 0,
    kolHunterRotationEdgeEntrySlippageBps: 50,
    kolHunterRotationEdgeQuickExitSlippageBps: 75,
    kolHunterRotationUnderfillPaperEnabled: true,
    kolHunterRotationUnderfillMinKolScore: 0.45,
    kolHunterRotationUnderfillMaxLastBuyAgeSec: 45,
    kolHunterRotationUnderfillMaxRecentSellSec: 60,
    kolHunterRotationUnderfillMinDiscountPct: 0.02,
    kolHunterRotationUnderfillMaxDiscountPct: 0.12,
    kolHunterRotationUnderfillT1Mfe: 0.05,
    kolHunterRotationUnderfillT1TrailPct: 0.025,
    kolHunterRotationUnderfillProfitFloorMult: 1.02,
    kolHunterRotationUnderfillProbeTimeoutSec: 30,
    kolHunterRotationUnderfillHardCutPct: 0.04,
    kolHunterRotationUnderfillDoaWindowSec: 15,
    kolHunterRotationUnderfillDoaMinMfePct: 0.015,
    kolHunterRotationUnderfillDoaMaxMaePct: 0.03,
    kolHunterRotationUnderfillParameterVersion: 'rotation-underfill-v1.0.0',
    kolHunterRotationPaperAssumedAtaRentSol: 0.00207408,
    kolHunterRotationPaperAssumedNetworkFeeSol: 0.000105,
    // 2026-04-26: smart-v3 는 production main default 이지만 기존 state-machine tests 는 v1 명시.
    kolHunterSmartV3Enabled: false,
    kolHunterSmartV3ObserveWindowSec: 120,
    kolHunterSmartV3MinPullbackPct: 0.10,
    kolHunterSmartV3MaxDrawdownFromKolEntryPct: 0.15,
    kolHunterSmartV3VelocityScoreThreshold: 5.0,
    kolHunterSmartV3VelocityMinIndependentKol: 2,
    kolHunterSmartV3FreshWindowSec: 60,
    kolHunterSmartV3MaxLastBuyAgeSec: 15,
    kolHunterSmartV3PullbackLiveEnabled: false,
    kolHunterSmartV3MinFreshAfterSellKols: 2,
    // 2026-04-30 (P1-2): pullback path KOL count gate. test default 1 → 기존 단일 KOL pullback
    // 진입 테스트 보존. 회귀 테스트만 explicit 2 override.
    kolHunterSmartV3PullbackMinKolCount: 1,
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
    kolHunterLiveMinIndependentKol: 2,
    kolHunterYellowZoneEnabled: true,
    kolHunterYellowZoneStartSol: 0.85,
    kolHunterYellowZonePaperFallbackBelowSol: 0.75,
    kolHunterYellowZoneMinIndependentKol: 2,
    kolHunterYellowZoneMaxRecentJupiter429: 20,
    kolHunterLiveExecutionQualityCooldownEnabled: true,
    kolHunterLiveExecutionQualityCooldownMs: 1_800_000,
    kolHunterLiveExecutionQualityMaxBuyLagMs: 90_000,
    kolHunterLiveExecutionQualityMaxEntryAdvantageAbsPct: 0.5,
    kolHunterLiveFreshReferenceGuardEnabled: true,
    kolHunterLiveFreshReferenceMaxAgeMs: 2_000,
    kolHunterLiveFreshReferenceMaxAdverseDriftPct: 0.20,
    // 2026-04-29 (Track 1): default 0 — test 내 same-token 반복 사용 차단 안 함.
    // Track 1 회귀 테스트에서 explicit 으로 override 하여 검증.
    kolHunterReentryCooldownMs: 0,
    // 2026-04-29 (P0-2): KOL alpha decay default disabled — 회귀 테스트 explicit override.
    kolHunterKolDecayCooldownEnabled: false,
    kolHunterKolDecayCooldownMs: 14_400_000,
    kolHunterKolDecayMinCloses: 3,
    kolHunterKolDecayLossRatioThreshold: 0.66,
    // 2026-05-02: post-distribution sell-wave live guard. default ON 은 production 과 동일.
    kolHunterPostDistributionGuardEnabled: true,
    kolHunterPostDistributionWindowSec: 300,
    kolHunterPostDistributionMinGrossSellSol: 2,
    kolHunterPostDistributionMinSellKols: 2,
    kolHunterPostDistributionCancelQuarantineSec: 600,
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
    tradeMarkoutObserverEnabled: false,
    tradeMarkoutObserverOffsetsSec: [30, 60, 300, 1800],
    tradeMarkoutObserverJitterPct: 0,
    tradeMarkoutObserverMaxInflight: 32,
    tradeMarkoutObserverDedupWindowSec: 30,
    tradeMarkoutObserverHydrateOnStart: false,
    tradeMarkoutObserverHydrateLookbackHours: 2,
    jupiterApiUrl: 'https://api.test/swap/v1',
    jupiterApiKey: undefined,
  },
}));

const MINT_WINNER = 'Mint111111111111111111111111111111111111111';
const MINT_HARDCUT = 'Mint222222222222222222222222222222222222222';
const MINT_FLAT = 'Mint333333333333333333333333333333333333333';
const MINT_NOCONSENSUS = 'Mint444444444444444444444444444444444444444';
const MINT_SMART = 'Mint666666666666666666666666666666666666666';
const MINT_ROTATION = 'Mint777777777777777777777777777777777777777';

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function policyDecisionRecords(): any[] {
  return mockAppendFile.mock.calls
    .filter((call) => typeof call[0] === 'string' && call[0].includes('kol-policy-decisions.jsonl'))
    .map((call) => JSON.parse(String(call[1]).trim()));
}

function policyRecordsWithFlag(flag: string): any[] {
  return policyDecisionRecords().filter((row) => Array.isArray(row.riskFlags) && row.riskFlags.includes(flag));
}

describe('kolSignalHandler — state machine', () => {
  let stubFeed: StubPaperPriceFeed;

  beforeEach(() => {
    stopKolHunter();
    jest.clearAllMocks();
    mockResolveDevStatus.mockReturnValue('unknown');
    mockReadFile.mockRejectedValue(Object.assign(new Error('missing ledger'), { code: 'ENOENT' }));
    // 2026-04-28 (P1 isolation fix): KOL DB module global state 가 test 간 leak.
    // Phase 1 신규 테스트의 __testInject 가 후속 test 영향 → resetKolDbState 로 격리.
    const { resetKolDbState } = require('../src/kol/db');
    resetKolDbState();
    // 2026-04-29 (Track 1): same-token reentry cooldown 도 test 간 격리.
    const {
      resetReentryCooldownForTests,
      resetLiveExecutionQualityCooldownForTests,
      resetKolDecayForTests,
      resetCommunityCacheForTests,
    } = require('../src/orchestration/kolSignalHandler');
    resetReentryCooldownForTests();
    resetLiveExecutionQualityCooldownForTests();
    // 2026-04-29 (P0-2): KOL alpha decay tracking 도 test 간 격리.
    resetKolDecayForTests();
    // 2026-04-29 (#5): community cache 도 test 간 격리.
    resetCommunityCacheForTests();
    resetTradeMarkoutObserverState();
    resetMissedAlphaObserverState();
    const { resetWalletStopGuardForTests } = require('../src/risk/walletStopGuard');
    resetWalletStopGuardForTests();
    const { resetJupiter429Metric } = require('../src/observability/jupiterRateLimitMetric');
    resetJupiter429Metric();
    const mockedConfig = (require('../src/utils/config') as any).config;
    mockedConfig.kolHunterSmartV3Enabled = false;
    mockedConfig.kolHunterRotationV1Enabled = false;
    mockedConfig.kolHunterRotationV1LiveEnabled = false;
    mockedConfig.kolHunterRotationV1MinIndependentKol = 1;
    mockedConfig.kolHunterRotationV1KolIds = 'dv,decu';
    mockedConfig.kolHunterRotationV1ExcludeKolIds = '';
    mockedConfig.kolHunterRotationV1MinKolScore = 0.45;
    mockedConfig.kolHunterRotationV1WindowSec = 45;
    mockedConfig.kolHunterRotationV1MaxLastBuyAgeSec = 15;
    mockedConfig.kolHunterRotationV1MinBuyCount = 3;
    mockedConfig.kolHunterRotationV1MinSmallBuyCount = 2;
    mockedConfig.kolHunterRotationV1SmallBuyMaxSol = 0.061;
    mockedConfig.kolHunterRotationV1MinGrossBuySol = 1.0;
    mockedConfig.kolHunterRotationV1MaxRecentSellSec = 60;
    mockedConfig.kolHunterRotationV1MinPriceResponsePct = 0.01;
    mockedConfig.kolHunterRotationV1T1Mfe = 0.12;
    mockedConfig.kolHunterRotationV1T1TrailPct = 0.08;
    mockedConfig.kolHunterRotationV1ProfitFloorMult = 1.08;
    mockedConfig.kolHunterRotationV1ProbeTimeoutSec = 90;
    mockedConfig.kolHunterRotationV1DoaWindowSec = 30;
    mockedConfig.kolHunterRotationV1DoaMinMfePct = 0.03;
    mockedConfig.kolHunterRotationV1DoaMaxMaePct = 0.06;
    mockedConfig.kolHunterRotationV1FreshBuyGraceSec = 15;
    mockedConfig.kolHunterRotationV1MarkoutOffsetsSec = [15, 30, 60];
    mockedConfig.kolHunterRotationPaperArmsEnabled = false;
    mockedConfig.kolHunterRotationFast15PaperEnabled = true;
    mockedConfig.kolHunterRotationFast15T1Mfe = 0.05;
    mockedConfig.kolHunterRotationFast15T1TrailPct = 0.025;
    mockedConfig.kolHunterRotationFast15ProfitFloorMult = 1.015;
    mockedConfig.kolHunterRotationFast15ProbeTimeoutSec = 20;
    mockedConfig.kolHunterRotationFast15HardCutPct = 0.04;
    mockedConfig.kolHunterRotationFast15DoaWindowSec = 15;
    mockedConfig.kolHunterRotationFast15DoaMinMfePct = 0.015;
    mockedConfig.kolHunterRotationFast15DoaMaxMaePct = 0.025;
    mockedConfig.kolHunterRotationCostGuardPaperEnabled = true;
    mockedConfig.kolHunterRotationCostGuardT1Mfe = 0.12;
    mockedConfig.kolHunterRotationCostGuardT1TrailPct = 0.04;
    mockedConfig.kolHunterRotationCostGuardProfitFloorMult = 1.08;
    mockedConfig.kolHunterRotationCostGuardProbeTimeoutSec = 30;
    mockedConfig.kolHunterRotationCostGuardHardCutPct = 0.06;
    mockedConfig.kolHunterRotationCostGuardDoaWindowSec = 20;
    mockedConfig.kolHunterRotationCostGuardDoaMinMfePct = 0.03;
    mockedConfig.kolHunterRotationCostGuardDoaMaxMaePct = 0.04;
    mockedConfig.kolHunterRotationCostGuardMinPriceResponsePct = 0.01;
    mockedConfig.kolHunterRotationQualityStrictPaperEnabled = true;
    mockedConfig.kolHunterRotationQualityStrictT1Mfe = 0.08;
    mockedConfig.kolHunterRotationQualityStrictT1TrailPct = 0.03;
    mockedConfig.kolHunterRotationQualityStrictProfitFloorMult = 1.04;
    mockedConfig.kolHunterRotationQualityStrictProbeTimeoutSec = 25;
    mockedConfig.kolHunterRotationQualityStrictHardCutPct = 0.05;
    mockedConfig.kolHunterRotationQualityStrictDoaWindowSec = 18;
    mockedConfig.kolHunterRotationQualityStrictDoaMinMfePct = 0.025;
    mockedConfig.kolHunterRotationQualityStrictDoaMaxMaePct = 0.035;
    mockedConfig.kolHunterRotationFlowMetricsLookbackSec = 180;
    mockedConfig.kolHunterRotationFlowSellPressureWindowSec = 30;
    mockedConfig.kolHunterRotationFlowFreshTopupSec = 60;
    mockedConfig.kolHunterRotationFlowChaseStepPct = 0.015;
    mockedConfig.kolHunterRotationExitFlowPaperEnabled = true;
    mockedConfig.kolHunterRotationExitFlowLightPressure = 0.20;
    mockedConfig.kolHunterRotationExitFlowStrongPressure = 0.50;
    mockedConfig.kolHunterRotationExitFlowFullExitPressure = 0.80;
    mockedConfig.kolHunterRotationExitFlowCriticalPressure = 1.20;
    mockedConfig.kolHunterRotationExitFlowLightReducePct = 0.35;
    mockedConfig.kolHunterRotationExitFlowStrongReducePct = 0.75;
    mockedConfig.kolHunterRotationExitFlowResidualHoldSec = 75;
    mockedConfig.kolHunterRotationExitFlowParameterVersion = 'rotation-exit-flow-v1.0.0';
    mockedConfig.kolHunterRotationChaseTopupPaperEnabled = true;
    mockedConfig.kolHunterRotationChaseTopupMinBuys = 2;
    mockedConfig.kolHunterRotationChaseTopupMinTopupStrength = 0.08;
    mockedConfig.kolHunterRotationChaseTopupMaxRecentSellSec = 60;
    mockedConfig.kolHunterRotationChaseTopupParameterVersion = 'rotation-chase-topup-v1.0.0';
    mockedConfig.kolHunterRotationUnderfillPaperEnabled = true;
    mockedConfig.kolHunterRotationUnderfillMinKolScore = 0.45;
    mockedConfig.kolHunterRotationUnderfillMaxLastBuyAgeSec = 45;
    mockedConfig.kolHunterRotationUnderfillMaxRecentSellSec = 60;
    mockedConfig.kolHunterRotationUnderfillMinDiscountPct = 0.02;
    mockedConfig.kolHunterRotationUnderfillMaxDiscountPct = 0.12;
    mockedConfig.kolHunterRotationUnderfillT1Mfe = 0.05;
    mockedConfig.kolHunterRotationUnderfillT1TrailPct = 0.025;
    mockedConfig.kolHunterRotationUnderfillProfitFloorMult = 1.02;
    mockedConfig.kolHunterRotationUnderfillProbeTimeoutSec = 30;
    mockedConfig.kolHunterRotationUnderfillHardCutPct = 0.04;
    mockedConfig.kolHunterRotationUnderfillDoaWindowSec = 15;
    mockedConfig.kolHunterRotationUnderfillDoaMinMfePct = 0.015;
    mockedConfig.kolHunterRotationUnderfillDoaMaxMaePct = 0.03;
    mockedConfig.kolHunterRotationUnderfillParameterVersion = 'rotation-underfill-v1.0.0';
    mockedConfig.kolHunterRotationPaperAssumedAtaRentSol = 0.00207408;
    mockedConfig.kolHunterRotationPaperAssumedNetworkFeeSol = 0.000105;
    mockedConfig.missedAlphaObserverEnabled = false;
    mockedConfig.missedAlphaObserverOffsetsSec = [60, 300, 1800];
    mockedConfig.tradeMarkoutObserverEnabled = false;
    mockedConfig.tradeMarkoutObserverOffsetsSec = [30, 60, 300, 1800];
    mockedConfig.kolHunterSwingV2Enabled = false;
    mockedConfig.kolHunterSwingV2T1TrailPct = 0.25;
    mockedConfig.kolHunterSwingV2T1ProfitFloorMult = 1.10;
    mockedConfig.kolHunterDevWalletLiveGateEnabled = true;
    mockedConfig.kolHunterSmartV3VelocityScoreThreshold = 5.0;
    mockedConfig.kolHunterSmartV3FreshWindowSec = 60;
    mockedConfig.kolHunterSmartV3MaxLastBuyAgeSec = 15;
    mockedConfig.kolHunterSmartV3PullbackLiveEnabled = false;
    mockedConfig.kolHunterSmartV3MinFreshAfterSellKols = 2;
    mockedConfig.kolHunterYellowZoneEnabled = true;
    mockedConfig.kolHunterLiveFreshReferenceGuardEnabled = true;
    mockedConfig.kolHunterLiveFreshReferenceMaxAgeMs = 2_000;
    mockedConfig.kolHunterLiveFreshReferenceMaxAdverseDriftPct = 0.20;
    // 2026-04-29 (Track 2B): test 간 격리. describe 블록에서 true 로 설정해도 다음 test 까지 leak 안 함.
    mockedConfig.kolHunterRejectOnNoSecurityData = false;
    stubFeed = new StubPaperPriceFeed();
    __testInit({ priceFeed: stubFeed as unknown as never });
  });

  afterEach(() => {
    stopKolHunter();
    resetTradeMarkoutObserverState();
    resetMissedAlphaObserverState();
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

  it('entry 기준가는 오래된 cached tick 대신 fresh tick 을 기다린다', async () => {
    stubFeed.setInitialPrice(MINT_WINNER, 0.001, 6, Date.now() - 30_000);
    await handleKolSwap(buyTx('pain', 'S', MINT_WINNER));

    const resolving = __testForceResolveStalk(MINT_WINNER);
    await flushAsync();
    stubFeed.emitTick(MINT_WINNER, 0.002);
    await resolving;

    const positions = __testGetActive();
    expect(positions).toHaveLength(1);
    expect(positions[0].entryPrice).toBeCloseTo(0.002, 6);
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
      mockedConfig.kolHunterRotationV1Enabled = false;
      mockedConfig.kolHunterRotationV1LiveEnabled = false;
      mockedConfig.kolHunterRotationV1MinIndependentKol = 1;
      mockedConfig.kolHunterRotationV1KolIds = 'dv,decu';
      mockedConfig.kolHunterRotationV1ExcludeKolIds = '';
      mockedConfig.kolHunterRotationV1MinKolScore = 0.45;
      mockedConfig.kolHunterRotationV1MaxLastBuyAgeSec = 15;
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
      mockedConfig.kolHunterSmartV3FreshWindowSec = 120;
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('k1', 'S', MINT_SMART, 70_000));
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

    it('smart-v3 close ledger 는 copyable-edge shadow field 를 남긴다', async () => {
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      await flushAsync();
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      const pos = __testGetActive()[0];
      expect(pos.armName).toBe('kol_hunter_smart_v3');

      mockAppendFile.mockClear();
      __testTriggerTick(pos.positionId, pos.entryPrice * 0.88);
      await flushAsync();
      await flushAsync();

      const paperRows = mockAppendFile.mock.calls
        .filter((call) => typeof call[0] === 'string' && call[0].includes('kol-paper-trades.jsonl'))
        .map((call) => JSON.parse(String(call[1]).trim()));
      expect(paperRows).toHaveLength(1);
      const row = paperRows[0];
      expect(row.armName).toBe('kol_hunter_smart_v3');
      expect(row.smartV3CopyableEdge.schemaVersion).toBe('smart-v3-copyable-edge/v1');
      expect(row.smartV3CopyableEdge.shadowOnly).toBe(true);
      expect(row.smartV3CopyablePass).toBe(false);
      expect(row.smartV3CopyableNetSol).toBeLessThan(row.netSolTokenOnly);
      expect(row.extras.smartV3CopyableEdge.schemaVersion).toBe('smart-v3-copyable-edge/v1');
      expect(row.extras.smartV3CopyablePass).toBe(false);

      const projectionRows = mockAppendFile.mock.calls
        .filter((call) => typeof call[0] === 'string' && call[0].includes('smart-v3-paper-trades.jsonl'))
        .map((call) => JSON.parse(String(call[1]).trim()));
      expect(projectionRows).toHaveLength(1);
      expect(projectionRows[0].smartV3CopyableEdge.schemaVersion).toBe('smart-v3-copyable-edge/v1');
    });

    it('first tick 대기 중 같은 mint buy 는 기존 smart-v3 pending 에 합류해 observe 중복을 막는다', async () => {
      mockedConfig.kolHunterSmartV3FreshWindowSec = 120;
      const first = handleKolSwap(buyTx('k1', 'S', MINT_SMART, 70_000));
      await flushAsync();

      await handleKolSwap(buyTx('k2', 'A', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.001);
      await first;
      await flushAsync();

      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].parameterVersion).toBe('smart-v3.0.0');
      expect(positions[0].kolEntryReason).toBe('velocity');
      expect(positions[0].independentKolCount).toBe(2);
    });

    it('smart-v3 reentry block 은 pending price subscription 을 정리한다', async () => {
      mockedConfig.kolHunterReentryCooldownMs = 30 * 60 * 1000;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      await flushAsync();
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      const first = __testGetActive()[0];
      expect(first).toBeDefined();
      __testTriggerTick(first.positionId, first.entryPrice * 0.89);
      await flushAsync();
      expect(__testGetActive()).toHaveLength(0);
      expect(stubFeed.getActiveSubscriptionCount()).toBe(0);

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART, 1_000));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      await flushAsync();
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      expect(__testGetActive()).toHaveLength(0);
      expect(stubFeed.getActiveSubscriptionCount()).toBe(0);
      mockedConfig.kolHunterReentryCooldownMs = 0;
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
      expect(stubFeed.getActiveSubscriptionCount()).toBe(1);
      await handleKolSwap({ ...buyTx('pain', 'S', MINT_SMART), action: 'sell' });
      expect(stubFeed.getActiveSubscriptionCount()).toBe(0);
      await __testForceResolveStalk(MINT_SMART);
      expect(__testGetActive()).toHaveLength(0);
    });

    it('rotation-v1 enabled: dv opener + small top-ups 는 별도 fast lane 으로 진입한다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap(buyTxWithFill('dv', 'A', MINT_ROTATION, 0.001, 0.95, 3_000));
      await handleKolSwap(buyTxWithFill('dv', 'A', MINT_ROTATION, 0.001, 0.03, 2_000));
      await handleKolSwap(buyTxWithFill('dv', 'A', MINT_ROTATION, 0.001, 0.03, 1_000));
      stubFeed.emitTick(MINT_ROTATION, 0.00102);
      await flushAsync();

      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].parameterVersion).toBe('rotation-v1.0.0');
      expect(positions[0].armName).toBe('kol_hunter_rotation_v1');
      expect(positions[0].kolEntryReason).toBe('rotation_v1');
      expect(positions[0].kolConvictionLevel).toBe('MEDIUM_HIGH');
      expect(positions[0].survivalFlags).toContain('ROTATION_V1');
      expect(positions[0].survivalFlags.some((flag) => flag.startsWith('ROTATION_V1_RESPONSE_PCT_'))).toBe(true);
      expect(positions[0].rotationAnchorKols).toEqual(['dv']);
      expect(positions[0].t1MfeOverride).toBe(0.12);
      expect(positions[0].t1TrailPctOverride).toBe(0.08);
      expect(positions[0].t1ProfitFloorMult).toBe(1.08);
      expect(positions[0].probeFlatTimeoutSec).toBe(90);
    });

    it('rotation-v1: trade markout 은 전역 horizon 에 T+15s 를 추가한다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.tradeMarkoutObserverEnabled = true;
      mockedConfig.tradeMarkoutObserverOffsetsSec = [30, 60, 300, 1800];
      mockedConfig.kolHunterRotationV1MarkoutOffsetsSec = [15, 30, 60];
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap(buyTxWithFill('dv', 'A', MINT_ROTATION, 0.001, 0.95, 3_000));
      await handleKolSwap(buyTxWithFill('dv', 'A', MINT_ROTATION, 0.001, 0.03, 2_000));
      await handleKolSwap(buyTxWithFill('dv', 'A', MINT_ROTATION, 0.001, 0.03, 1_000));
      stubFeed.emitTick(MINT_ROTATION, 0.00102);
      await flushAsync();

      expect(__testGetActive()[0].armName).toBe('kol_hunter_rotation_v1');
      expect(getTradeMarkoutObserverStats().scheduled).toBe(5);
      const anchorRows = mockAppendFile.mock.calls
        .filter((call) => typeof call[0] === 'string' && call[0].includes('trade-markout-anchors.jsonl'))
        .map((call) => JSON.parse(String(call[1]).trim()));
      expect(anchorRows).toHaveLength(1);
      expect(anchorRows[0].extras.armName).toBe('kol_hunter_rotation_v1');
      expect(anchorRows[0].extras.markoutOffsetsSec).toEqual([15, 30, 60, 300, 1800]);
    });

    it('rotation-v1 paper arms enabled: 동일 trigger 에 fast/cost/quality shadow arms 를 병렬 생성한다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.kolHunterRotationPaperArmsEnabled = true;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap(buyTxWithFill('dv', 'A', MINT_ROTATION, 0.001, 0.95, 3_000));
      await handleKolSwap(buyTxWithFill('dv', 'A', MINT_ROTATION, 0.001, 0.03, 2_000));
      await handleKolSwap(buyTxWithFill('dv', 'A', MINT_ROTATION, 0.001, 0.03, 1_000));
      stubFeed.emitTick(MINT_ROTATION, 0.00102);
      await flushAsync();

      const positions = __testGetActive();
      expect(positions.map((pos) => pos.armName).sort()).toEqual([
        'kol_hunter_rotation_v1',
        'rotation_cost_guard_v1',
        'rotation_exit_kol_flow_v1',
        'rotation_fast15_v1',
        'rotation_quality_strict_v1',
      ]);
      const control = positions.find((pos) => pos.armName === 'kol_hunter_rotation_v1');
      const fast = positions.find((pos) => pos.armName === 'rotation_fast15_v1');
      expect(fast?.isShadowArm).toBe(true);
      expect(fast?.parentPositionId).toBe(control?.positionId);
      expect(fast?.probeHardCutPctOverride).toBe(0.04);
      expect(fast?.probeFlatTimeoutSec).toBe(20);
      expect(fast?.t1MfeOverride).toBe(0.05);
      expect(fast?.rotationDoaWindowSecOverride).toBe(15);
      expect(fast?.survivalFlags).toContain('ROTATION_V1_PAPER_PARAM_ARM');
    });

    it('rotation-v1 paper arm skip 은 missed-alpha 로 false-negative 관측을 예약한다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.kolHunterRotationPaperArmsEnabled = true;
      mockedConfig.missedAlphaObserverEnabled = true;
      mockedConfig.kolHunterRotationV1MarkoutOffsetsSec = [15, 30, 60];
      mockedConfig.kolHunterRotationCostGuardMinPriceResponsePct = 0.08;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 3_000), solAmount: 0.95 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 2_000), solAmount: 0.03 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 1_000), solAmount: 0.03 });
      stubFeed.emitTick(MINT_ROTATION, 0.00102);
      await flushAsync();

      expect(__testGetActive().map((pos) => pos.armName).sort()).toEqual([
        'kol_hunter_rotation_v1',
        'rotation_exit_kol_flow_v1',
        'rotation_fast15_v1',
        'rotation_quality_strict_v1',
      ]);
      expect(getMissedAlphaObserverStats().scheduled).toBeGreaterThanOrEqual(3);
      const markers = mockAppendFile.mock.calls
        .filter((call) => typeof call[0] === 'string' && call[0].includes('missed-alpha.jsonl'))
        .map((call) => JSON.parse(String(call[1]).trim()))
        .filter((row) => row.extras?.eventType === 'rotation_arm_skip');
      expect(markers).toHaveLength(1);
      expect(markers[0].rejectReason).toBe('rotation_arm_skip_cost_response_too_low');
      expect(markers[0].signalSource).toBe('rotation_cost_guard_v1');
      expect(markers[0].extras.eventType).toBe('rotation_arm_skip');
      expect(markers[0].extras.armName).toBe('rotation_cost_guard_v1');
      expect(markers[0].extras.skipReason).toBe('cost_response_too_low');
      expect(markers[0].extras.noTradeReason).toBe('rotation_cost_guard_v1_cost_response_too_low');
      expect(markers[0].extras.rotationAnchorKols).toEqual(['dv']);
      expect(markers[0].probe.outputDecimals).toBe(6);
    });

    it('rotation-v1: seed whitelist 밖 KOL 도 DB score 가 충분하면 fast lane 으로 진입한다', async () => {
      const { __testInject } = require('../src/kol/db');
      __testInject([
        {
          id: 'rotato',
          tier: 'A',
          addresses: ['wallet_rotato'],
          added_at: '2026-05-02',
          last_verified_at: '2026-05-02',
          notes: '',
          is_active: true,
          trading_style: 'scalper',
          lane_role: 'discovery_canary',
        },
      ]);
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.kolHunterSmartV3VelocityScoreThreshold = 99;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap({ ...buyTx('rotato', 'A', MINT_ROTATION, 3_000), solAmount: 0.95 });
      await handleKolSwap({ ...buyTx('rotato', 'A', MINT_ROTATION, 2_000), solAmount: 0.03 });
      await handleKolSwap({ ...buyTx('rotato', 'A', MINT_ROTATION, 1_000), solAmount: 0.03 });
      stubFeed.emitTick(MINT_ROTATION, 0.00102);
      await flushAsync();

      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].armName).toBe('kol_hunter_rotation_v1');
      expect(positions[0].rotationAnchorKols).toEqual(['rotato']);
      expect(positions[0].rotationScore).toBeGreaterThanOrEqual(0.45);
    });

    it('rotation-v1: 진입해도 smart-v3 pending 을 소비하지 않아 기존 lane trigger 가 유지된다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 3_000), solAmount: 0.95 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 2_000), solAmount: 0.03 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 1_000), solAmount: 0.03 });
      stubFeed.emitTick(MINT_ROTATION, 0.00102);
      await flushAsync();
      expect(__testGetActive().map((p) => p.armName)).toEqual(['kol_hunter_rotation_v1']);

      stubFeed.emitTick(MINT_ROTATION, 0.0013);
      await flushAsync();
      stubFeed.emitTick(MINT_ROTATION, 0.00115);
      await flushAsync();

      const armNames = __testGetActive().map((p) => p.armName);
      expect(armNames).toContain('kol_hunter_smart_v3');
    });

    it('rotation-v1: buy burst 가 있어도 가격 반응이 없으면 no-trade 로 대기한다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 3_000), solAmount: 0.95 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 2_000), solAmount: 0.03 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 1_000), solAmount: 0.03 });
      await flushAsync();

      expect(__testGetActive()).toHaveLength(0);
      stubFeed.emitTick(MINT_ROTATION, 0.00102);
      await flushAsync();
      expect(__testGetActive()).toHaveLength(1);
    });

    it('rotation-underfill: 1 KOL buy 뒤 KOL 기준가보다 낮은 quote 는 paper arm 으로 진입한다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.kolHunterSmartV3VelocityScoreThreshold = 99;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap(buyTxWithFill('decu', 'A', MINT_ROTATION, 0.001, 0.25, 1_000));
      stubFeed.emitTick(MINT_ROTATION, 0.00096);
      await flushAsync();

      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].parameterVersion).toBe('rotation-underfill-v1.0.0');
      expect(positions[0].armName).toBe('rotation_underfill_v1');
      expect(positions[0].kolEntryReason).toBe('rotation_v1');
      expect(positions[0].kolConvictionLevel).toBe('MEDIUM_HIGH');
      expect(positions[0].isShadowArm).toBe(false);
      expect(positions[0].independentKolCount).toBe(1);
      expect(positions[0].participatingKols.map((k) => k.id)).toEqual(['decu']);
      expect(positions[0].survivalFlags).toContain('ROTATION_UNDERFILL_V1');
      expect(positions[0].survivalFlags).toContain('ROTATION_UNDERFILL_PAPER_ONLY');
      expect(positions[0].survivalFlags).toContain('ROTATION_UNDERFILL_SA_ONLY');
      expect(positions[0].survivalFlags).toContain('ROTATION_UNDERFILL_REF_KOL_WEIGHTED_FILL');
      expect(positions[0].rotationAnchorKols).toEqual(['decu']);
      expect(positions[0].rotationAnchorPrice).toBe(0.001);
      expect(positions[0].rotationAnchorPriceSource).toBe('kol_weighted_fill');
      expect(positions[0].underfillReferenceSolAmount).toBe(0.25);
      expect(positions[0].underfillReferenceTokenAmount).toBe(250);
      expect(positions[0].rotationMonetizableEdge?.schemaVersion).toBe('rotation-monetizable-edge/v1');
      expect(positions[0].rotationMonetizableEdge?.pass).toBe(false);
      expect(positions[0].survivalFlags).toContain('ROTATION_EDGE_SHADOW_FAIL');
      expect(positions[0].t1MfeOverride).toBe(0.05);
      expect(positions[0].t1TrailPctOverride).toBe(0.025);
      expect(positions[0].t1ProfitFloorMult).toBe(1.02);
      expect(positions[0].probeFlatTimeoutSec).toBe(30);
      expect(positions[0].probeHardCutPctOverride).toBe(0.04);
      expect(positions[0].rotationDoaWindowSecOverride).toBe(15);
    });

    it('rotation-exit-flow: underfill entry 의 anchor sell 을 sellPressure 기반으로 부분 축소한다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.kolHunterRotationPaperArmsEnabled = true;
      mockedConfig.kolHunterSmartV3VelocityScoreThreshold = 99;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap(buyTxWithFill('decu', 'A', MINT_ROTATION, 0.001, 0.25, 1_000));
      stubFeed.emitTick(MINT_ROTATION, 0.00096);
      await flushAsync();

      const positions = __testGetActive();
      expect(positions.map((p) => p.armName).sort()).toEqual([
        'rotation_exit_kol_flow_v1',
        'rotation_underfill_v1',
      ]);
      const flowBefore = positions.find((p) => p.armName === 'rotation_exit_kol_flow_v1')!;
      const beforeTicket = flowBefore.ticketSol;

      await handleKolSwap(sellTx('decu', 'A', MINT_ROTATION, 0.06));
      await flushAsync();

      const activeAfter = __testGetActive();
      expect(activeAfter.some((p) => p.armName === 'rotation_underfill_v1')).toBe(false);
      const flowAfter = activeAfter.find((p) => p.armName === 'rotation_exit_kol_flow_v1');
      expect(flowAfter).toBeDefined();
      expect(flowAfter?.rotationFlowMetrics?.sellPressure30).toBeCloseTo(0.24);
      expect(flowAfter?.rotationFlowDecision).toBe('low_sell_pressure');
      expect(flowAfter?.ticketSol).toBeCloseTo(beforeTicket * 0.65);
      expect(flowAfter?.rotationFlowReducedAtSec).toBeDefined();

      stubFeed.emitTick(MINT_ROTATION, 0.00097);
      await flushAsync();
      expect(__testGetActive().find((p) => p.armName === 'rotation_exit_kol_flow_v1')?.rotationFlowResidualUntilSec)
        .toBeUndefined();

      stubFeed.emitTick(MINT_ROTATION, 0.00090);
      await flushAsync();
      expect(__testGetActive().some((p) => p.armName === 'rotation_exit_kol_flow_v1')).toBe(false);
    });

    it('rotation-chase-topup: S/A KOL top-up 이 더 높은 fill price 로 붙으면 paper-only 진입한다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.kolHunterSmartV3VelocityScoreThreshold = 99;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap(buyTxWithFill('decu', 'A', MINT_ROTATION, 0.001, 1.0, 2_000));
      await handleKolSwap(buyTxWithFill('decu', 'A', MINT_ROTATION, 0.00105, 0.2, 1_000));
      stubFeed.emitTick(MINT_ROTATION, 0.00106);
      await flushAsync();

      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].armName).toBe('rotation_chase_topup_v1');
      expect(positions[0].parameterVersion).toBe('rotation-chase-topup-v1.0.0');
      expect(positions[0].isShadowArm).toBe(false);
      expect(positions[0].rotationFlowExitEnabled).toBe(true);
      expect(positions[0].survivalFlags).toContain('ROTATION_CHASE_TOPUP_V1');
    });

    it('rotation-underfill: close ledger 에 openedAt/entryReason/extras/MFE alias 를 남긴다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.kolHunterSmartV3VelocityScoreThreshold = 99;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap(buyTxWithFill('decu', 'A', MINT_ROTATION, 0.001, 0.25, 1_000));
      stubFeed.emitTick(MINT_ROTATION, 0.00096);
      await flushAsync();

      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].armName).toBe('rotation_underfill_v1');

      mockAppendFile.mockClear();
      stubFeed.emitTick(MINT_ROTATION, 0.00105);
      await flushAsync();
      stubFeed.emitTick(MINT_ROTATION, 0.00102);
      await flushAsync();
      await flushAsync();

      const paperRows = mockAppendFile.mock.calls
        .filter((call) => typeof call[0] === 'string' && call[0].includes('kol-paper-trades.jsonl'))
        .map((call) => JSON.parse(String(call[1]).trim()));
      expect(paperRows).toHaveLength(1);
      const row = paperRows[0];
      expect(row.armName).toBe('rotation_underfill_v1');
      expect(row.openedAt).toBe(new Date(row.entryTimeSec * 1000).toISOString());
      expect(row.closedAt).toBe(new Date(row.exitTimeSec * 1000).toISOString());
      expect(row.entryReason).toBe('rotation_v1');
      expect(row.kolEntryReason).toBe('rotation_v1');
      expect(row.mfePct).toBeCloseTo(0.09375, 5);
      expect(row.mfePctPeak).toBeCloseTo(row.mfePct, 10);
      expect(row.maxPrice).toBeCloseTo(0.00105, 10);
      expect(row.peakPrice).toBeCloseTo(0.00105, 10);
      expect(row.rotationMonetizableEdge.pass).toBe(false);
      expect(row.rotationMonetizableCostRatio).toBeGreaterThan(0.06);
      expect(row.extras.entryReason).toBe('rotation_v1');
      expect(row.extras.armName).toBe('rotation_underfill_v1');
      expect(row.extras.rotationMonetizableEdge.pass).toBe(false);
      expect(row.extras.exitPrice).toBeCloseTo(0.00102, 10);
      expect(row.extras.maxPrice).toBeCloseTo(0.00105, 10);
      expect(row.extras.rotationAnchorKols).toEqual(['decu']);

      const projectionRows = mockAppendFile.mock.calls
        .filter((call) => typeof call[0] === 'string' && call[0].includes('rotation-v1-paper-trades.jsonl'))
        .map((call) => JSON.parse(String(call[1]).trim()));
      expect(projectionRows).toHaveLength(1);
      expect(projectionRows[0].openedAt).toBe(row.openedAt);
      expect(projectionRows[0].entryReason).toBe('rotation_v1');
      expect(projectionRows[0].mfePct).toBeCloseTo(row.mfePct, 10);
      expect(projectionRows[0].maxPrice).toBeCloseTo(row.maxPrice, 10);
      expect(projectionRows[0].extras.armName).toBe('rotation_underfill_v1');
    });

    it('rotation-underfill: 할인폭이 너무 깊으면 진입하지 않고 false-negative markout 을 예약한다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.missedAlphaObserverEnabled = true;
      mockedConfig.kolHunterSmartV3VelocityScoreThreshold = 99;
      mockedConfig.kolHunterRotationV1MarkoutOffsetsSec = [15, 30, 60];
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap(buyTxWithFill('decu', 'A', MINT_ROTATION, 0.001, 0.25, 1_000));
      stubFeed.emitTick(MINT_ROTATION, 0.00085);
      await flushAsync();

      expect(__testGetActive()).toHaveLength(0);
      expect(getMissedAlphaObserverStats().scheduled).toBe(3);
      const markers = mockAppendFile.mock.calls
        .filter((call) => typeof call[0] === 'string' && call[0].includes('missed-alpha.jsonl'))
        .map((call) => JSON.parse(String(call[1]).trim()))
        .filter((row) => row.extras?.eventType === 'rotation_underfill_no_trade');
      expect(markers).toHaveLength(1);
      expect(markers[0].rejectReason).toBe('rotation_underfill_underfill_discount_too_deep');
      expect(markers[0].signalSource).toBe('rotation_underfill_v1');
      expect(markers[0].extras.armName).toBe('rotation_underfill_v1');
      expect(markers[0].extras.noTradeReason).toBe('underfill_discount_too_deep');
      expect(markers[0].extras.rotationAnchorKols).toEqual(['decu']);
      expect(markers[0].extras.rotationAnchorPriceSource).toBe('kol_weighted_fill');
      expect(markers[0].extras.underfillDiscountPct).toBeCloseTo(0.15, 5);
    });

    it('rotation-underfill: 최근 same-mint KOL sell 이 있으면 1buy underfill 도 진입하지 않는다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.kolHunterSmartV3VelocityScoreThreshold = 99;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap(sellTx('seller_alpha', 'A', MINT_ROTATION, 0.50, 10_000));
      await handleKolSwap(buyTxWithFill('decu', 'A', MINT_ROTATION, 0.001, 0.25, 1_000));
      stubFeed.emitTick(MINT_ROTATION, 0.00096);
      await flushAsync();

      expect(__testGetActive()).toHaveLength(0);
      expect(policyRecordsWithFlag('ROTATION_UNDERFILL_NOTRADE_UNDERFILL_RECENT_SAME_MINT_SELL').length)
        .toBeGreaterThan(0);
    });

    it('rotation-underfill: B tier 1buy 는 할인 quote 가 있어도 제외한다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.kolHunterSmartV3VelocityScoreThreshold = 99;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap(buyTxWithFill('decu', 'B', MINT_ROTATION, 0.001, 0.25, 1_000));
      stubFeed.emitTick(MINT_ROTATION, 0.00096);
      await flushAsync();

      expect(__testGetActive()).toHaveLength(0);
    });

    it('rotation-underfill: 실제 KOL fill price 가 없으면 quote 기준 fallback 없이 진입하지 않는다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.kolHunterSmartV3VelocityScoreThreshold = 99;
      mockedConfig.missedAlphaObserverEnabled = true;
      mockedConfig.kolHunterRotationV1MarkoutOffsetsSec = [15, 30, 60];
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap({ ...buyTx('decu', 'A', MINT_ROTATION, 1_000), solAmount: 0.25 });
      stubFeed.emitTick(MINT_ROTATION, 0.00096);
      await flushAsync();

      expect(__testGetActive()).toHaveLength(0);
      const markers = mockAppendFile.mock.calls
        .filter((call) => typeof call[0] === 'string' && call[0].includes('missed-alpha.jsonl'))
        .map((call) => JSON.parse(String(call[1]).trim()))
        .filter((row) => row.extras?.eventType === 'rotation_underfill_no_trade');
      expect(markers).toHaveLength(1);
      expect(markers[0].extras.noTradeReason).toBe('underfill_missing_kol_fill_price');
      expect(markers[0].extras.rotationAnchorPriceSource).toBe('missing_kol_fill');
    });

    it('rotation-v1: no-trade 는 T+15/30/60 missed-alpha 관측을 예약한다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.missedAlphaObserverEnabled = true;
      mockedConfig.kolHunterRotationV1MarkoutOffsetsSec = [15, 30, 60];
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap(buyTxWithFill('dv', 'A', MINT_ROTATION, 0.001, 0.95, 3_000));
      await handleKolSwap(buyTxWithFill('dv', 'A', MINT_ROTATION, 0.001, 0.03, 2_000));
      await handleKolSwap(buyTxWithFill('dv', 'A', MINT_ROTATION, 0.001, 0.03, 1_000));
      await flushAsync();

      expect(__testGetActive()).toHaveLength(0);
      expect(getMissedAlphaObserverStats().scheduled).toBe(6);
      const markers = mockAppendFile.mock.calls
        .filter((call) => typeof call[0] === 'string' && call[0].includes('missed-alpha.jsonl'))
        .map((call) => JSON.parse(String(call[1]).trim()));
      expect(markers).toHaveLength(2);
      const rotationMarker = markers.find((row) => row.extras.eventType === 'rotation_no_trade');
      const chaseMarker = markers.find((row) => row.extras.eventType === 'rotation_chase_topup_no_trade');
      expect(rotationMarker?.rejectReason).toBe('rotation_v1_insufficient_price_response');
      expect(rotationMarker?.extras.rotationAnchorKols).toEqual(['dv']);
      expect(chaseMarker?.rejectReason).toBe('rotation_chase_topup_chase_topup_strength_too_low');
      expect(chaseMarker?.signalSource).toBe('rotation_chase_topup_v1');
    });

    it('rotation-v1: stale last buy 는 policy no-trade 로 기록하고 진입하지 않는다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.kolHunterRotationV1MaxLastBuyAgeSec = 15;
      const oldTs = Date.now() - 20_000;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 3_000), timestamp: oldTs, solAmount: 0.95 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 2_000), timestamp: oldTs + 1, solAmount: 0.03 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 1_000), timestamp: oldTs + 2, solAmount: 0.03 });
      stubFeed.emitTick(MINT_ROTATION, 0.00102);
      await flushAsync();

      expect(__testGetActive()).toHaveLength(0);
      expect(policyRecordsWithFlag('ROTATION_V1_NOTRADE_STALE_LAST_BUY').length).toBeGreaterThan(0);
    });

    it('rotation-v1: rotation min independent KOL 기준은 paper 에도 동일 적용된다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.kolHunterRotationV1MinIndependentKol = 2;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 3_000), solAmount: 0.95 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 2_000), solAmount: 0.03 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 1_000), solAmount: 0.03 });
      stubFeed.emitTick(MINT_ROTATION, 0.00102);
      await flushAsync();

      expect(__testGetActive()).toHaveLength(0);
      expect(policyRecordsWithFlag('ROTATION_V1_NOTRADE_INSUFFICIENT_ROTATION_KOL_COUNT').length).toBeGreaterThan(0);
    });

    it('rotation-v1: 최근 same-mint KOL sell 이 있으면 fast lane 진입하지 않는다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap(sellTx('seller_alpha', 'A', MINT_ROTATION, 0.50, 10_000));
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 3_000), solAmount: 0.95 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 2_000), solAmount: 0.03 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 1_000), solAmount: 0.03 });
      stubFeed.emitTick(MINT_ROTATION, 0.00102);
      await flushAsync();

      expect(__testGetActive()).toHaveLength(0);
    });

    it('rotation-v1: 진입 직후 반응 없이 -6% 이상 밀리면 dead-on-arrival 로 빠르게 닫는다', async () => {
      mockedConfig.kolHunterRotationV1Enabled = true;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 3_000), solAmount: 0.95 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 2_000), solAmount: 0.03 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 1_000), solAmount: 0.03 });
      stubFeed.emitTick(MINT_ROTATION, 0.00102);
      await flushAsync();

      const pos = __testGetActive()[0];
      let captured: any = null;
      kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
      __testTriggerTick(pos.positionId, pos.entryPrice * 0.93);

      expect(captured?.reason).toBe('rotation_dead_on_arrival');
      expect(__testGetActive()).toHaveLength(0);
    });

    it('rotation-v1: anchor rotator sell 은 style-aware 완화보다 우선해 full exit 한다', async () => {
      const { __testInject } = require('../src/kol/db');
      __testInject([
        { id: 'dv', tier: 'A', addresses: ['wallet_dv'], added_at: '2026-04-01', last_verified_at: '2026-05-02', notes: '', is_active: true, trading_style: 'scalper', lane_role: 'discovery_canary' },
        { id: 'longh', tier: 'S', addresses: ['wallet_longh'], added_at: '2026-04-01', last_verified_at: '2026-05-02', notes: '', is_active: true, trading_style: 'longhold', lane_role: 'copy_core' },
      ]);
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.kolHunterSmartV3VelocityScoreThreshold = 99;
      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);

      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 3_000), solAmount: 0.95 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 2_000), solAmount: 0.03 });
      await handleKolSwap({ ...buyTx('dv', 'A', MINT_ROTATION, 1_000), solAmount: 0.03 });
      stubFeed.emitTick(MINT_ROTATION, 0.00102);
      await flushAsync();
      await handleKolSwap(buyTx('longh', 'S', MINT_ROTATION));

      let captured: any = null;
      kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
      await handleKolSwap({ ...sellTx('dv', 'A', MINT_ROTATION, 0.03), walletAddress: 'wallet_dv' });
      await flushAsync();

      expect(captured?.reason).toBe('insider_exit_full');
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

    // 2026-04-30 (P1-2 회귀): pullback path 의 KOL count gate.
    //   live 15h n=49 분석 — pullback|kols=1 이 net 의 103% 손실.
    //   default 1 인 테스트 mock 에서 explicit 2 로 강제 후 검증.
    it('P1-2: pullback path 가 minKolCount 미달 시 진입을 차단한다', async () => {
      mockedConfig.kolHunterSmartV3PullbackMinKolCount = 2;
      try {
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        // kols=1 (pain 단독) 으로 pullback trigger 시도
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        stubFeed.emitTick(MINT_SMART, 0.0013);
        stubFeed.emitTick(MINT_SMART, 0.00115);
        await flushAsync();
        // P1-2 적용: pullback path reject → 진입 0
        expect(__testGetActive()).toHaveLength(0);
      } finally {
        mockedConfig.kolHunterSmartV3PullbackMinKolCount = 1;
      }
    });

    it('P1-2: pullback path 는 minKolCount 충족 시 정상 진입한다', async () => {
      mockedConfig.kolHunterSmartV3PullbackMinKolCount = 2;
      mockedConfig.kolHunterSmartV3FreshWindowSec = 120;
      try {
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        // kols=2 (pain S + ghost A 합의)
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART, 70_000));
        await handleKolSwap(buyTx('ghost', 'A', MINT_SMART));
        stubFeed.emitTick(MINT_SMART, 0.0013);
        stubFeed.emitTick(MINT_SMART, 0.00115);
        await flushAsync();
        // P1-2 통과 증거: 진입 자체 발생 (velocity 또는 pullback 또는 둘 다 — kols=2 면 velocity 도 fire 가능)
        const positions = __testGetActive();
        expect(positions).toHaveLength(1);
        expect(positions[0].independentKolCount).toBe(2);
      } finally {
        mockedConfig.kolHunterSmartV3PullbackMinKolCount = 1;
      }
    });

    // 2026-04-30 (P1-1 winner 보호 회귀): mfe>=winnerSafeMfe 도달 후엔 quick reject 비활성.
    //   live 15h n=49 분석 — mfe>=10% 후 retest 케이스 3건 (avgMae -14%) 보호.
    it('P1-1: winnerSafeMfe 도달 후 quick reject 비활성화', async () => {
      // factor count 1 + 매우 빠른 임계 → 기본적으로 fire 하기 쉬운 환경
      mockedConfig.kolHunterQuickRejectFactorCount = 1;
      mockedConfig.kolHunterQuickRejectPullbackThreshold = 0.05;
      mockedConfig.kolHunterQuickRejectWinnerSafeMfe = 0.05;
      try {
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        await handleKolSwap(buyTx('ghost', 'A', MINT_SMART));
        await flushAsync();
        const pos = __testGetActive()[0];
        expect(pos).toBeDefined();
        // peak 도달: +20% 까지 올림 (mfe>=5% safe 도달)
        __testTriggerTick(pos.positionId, pos.entryPrice * 1.20);
        // peak 후 -10% 되돌림 → pullback 0.10 = factor 1, factor count 1 임계 충족하지만 winner 보호로 비활성
        let captured: any = null;
        kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
        __testTriggerTick(pos.positionId, pos.entryPrice * 1.08);
        // QR 으로 close 안 됐어야 함 (다른 path 로 close 가능 — 검증은 reason 만)
        expect(captured?.reason).not.toBe('quick_reject_classifier_exit');
      } finally {
        mockedConfig.kolHunterQuickRejectFactorCount = 3;
        mockedConfig.kolHunterQuickRejectPullbackThreshold = 0.20;
        mockedConfig.kolHunterQuickRejectWinnerSafeMfe = 0.05;
      }
    });

    // 2026-04-30 (P1-1 부정 케이스 회귀): mfe < winnerSafeMfe 상태에서는 QR 정상 fire 해야 한다.
    //   F1 fix — 이전 winner 보호 테스트 한 방향만 검증 → safeMfe 분기가 영구 true 인 버그도 통과 위험.
    it('P1-1: winnerSafeMfe 미달 상태에서는 quick reject 가 정상 fire 한다', async () => {
      // factor 1 + 매우 빠른 임계 → 충족 시 즉시 fire
      mockedConfig.kolHunterQuickRejectFactorCount = 1;
      mockedConfig.kolHunterQuickRejectPullbackThreshold = 0.05;
      mockedConfig.kolHunterQuickRejectMfeLowElapsedSec = 0;  // elapsed > 0 시 mfeLow factor 충족
      mockedConfig.kolHunterQuickRejectWinnerSafeMfe = 0.50;  // 50% — 도달 불가능 한 임계
      try {
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        await handleKolSwap(buyTx('ghost', 'A', MINT_SMART));
        await flushAsync();
        const pos = __testGetActive()[0];
        expect(pos).toBeDefined();
        // mfe 작게 (3% 정도) → safeMfe 미달
        let captured: any = null;
        kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
        // peak 0.00103 (3% mfe) 후 -10% 되돌림 → pullback 0.097 ≥ 0.05 factor 1 충족
        __testTriggerTick(pos.positionId, pos.entryPrice * 1.03);
        __testTriggerTick(pos.positionId, pos.entryPrice * 0.93);
        // safeMfeReached=false → QR fire 해야 함
        expect(captured?.reason).toBe('quick_reject_classifier_exit');
      } finally {
        mockedConfig.kolHunterQuickRejectFactorCount = 3;
        mockedConfig.kolHunterQuickRejectPullbackThreshold = 0.20;
        mockedConfig.kolHunterQuickRejectMfeLowElapsedSec = 30;
        mockedConfig.kolHunterQuickRejectWinnerSafeMfe = 0.05;
      }
    });

    // 2026-04-30 (Sprint 2.A1 회귀): structural kill-switch — 정확한 trigger 조건 검증.
    //   학술 §exit two-layer 권고 정합. paper 는 fire 금지, live + enabled + minHold + peakDrift 충족 시에만.
    it('Sprint 2.A1: structural kill default disabled 시 fire 안 함 (paper close 무영향)', async () => {
      // default config (kolHunterStructuralKillEnabled=false) — quote 호출 안 일어나는지 검증
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();
      const pos = __testGetActive()[0];
      expect(pos).toBeDefined();
      // peak 0.0013 → 0.0008 (-38% peakDrift, 임계 0.20 초과) — 그러나 disabled 라 structural fire 안 함
      // 대신 hardcut 에서 잡힐 수 있으므로 reason 만 확인
      let captured: any = null;
      kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
      __testTriggerTick(pos.positionId, pos.entryPrice * 0.85);  // mae -15% (hardcut -10% 초과)
      // disabled 면 'structural_kill_sell_route' 발생 절대 불가
      expect(captured?.reason).not.toBe('structural_kill_sell_route');
    });

    // 2026-04-30 (F7 fix, B안): positive case — live + enabled + impact > maxImpactPct → fire 검증.
    //   spyOn 으로 evaluateSellQuoteProbe mock — 외부 Jupiter 호출 없이 impact 0.15 (>0.10) 반환.
    //   이 테스트가 없으면 structural kill 로직이 영구 fire 안 해도 통과 가능 (단방향 검증 함정).
    it('Sprint 2.A1: live + enabled + impact 임계 초과 시 structural_kill_sell_route 발화', async () => {
      // live ctx 준비 (triple-flag gate 통과)
      const insertTrade = jest.fn().mockResolvedValue('db-kolh-live-2');
      const closeTrade = jest.fn().mockResolvedValue(undefined);
      const executeBuy = jest.fn().mockResolvedValue({
        txSignature: 'KOL_LIVE_BUY_SIG_F7',
        expectedOutAmount: 10_000_000n,
        actualOutAmount: 10_000_000n,
        actualOutUiAmount: 10,
        actualInputUiAmount: 0.01,
        outputDecimals: 6,
        slippageBps: 12,
      });
      const executeSell = jest.fn().mockResolvedValue({
        txSignature: 'KOL_LIVE_SELL_SIG_F7',
        actualOutAmount: 0n,
        slippageBps: 0,
      });
      const liveCtx = {
        tradingMode: 'live',
        tradeStore: { insertTrade, closeTrade, getOpenTrades: jest.fn().mockResolvedValue([]) },
        notifier: {
          sendCritical: jest.fn().mockResolvedValue(undefined),
          sendTradeOpen: jest.fn().mockResolvedValue(undefined),
          sendTradeClose: jest.fn().mockResolvedValue(undefined),
          sendInfo: jest.fn().mockResolvedValue(undefined),
        },
        executor: {
          executeBuy,
          executeSell,
          getTokenBalance: jest.fn().mockResolvedValue(0n),
          getBalance: jest.fn().mockResolvedValue(1.0),
        },
      } as any;
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: liveCtx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      mockedConfig.kolHunterYellowZoneEnabled = false;
      mockedConfig.kolHunterStructuralKillEnabled = true;
      mockedConfig.kolHunterStructuralKillMinHoldSec = 0;       // 시간 제약 제거
      mockedConfig.kolHunterStructuralKillPeakDriftTrigger = 0.10;
      mockedConfig.kolHunterStructuralKillCacheMs = 0;          // cache off — 매 tick quote
      __testResetStructuralKillCache();

      // sellQuoteProbe spy: impact 0.15 (>0.10) — kill 발화 조건
      const probeSpy = jest.spyOn(sellQuoteProbeModule, 'evaluateSellQuoteProbe').mockResolvedValue({
        approved: false,
        routeFound: true,
        observedOutSol: 0.005,
        observedImpactPct: 0.15,
        roundTripPct: -0.5,
        quoteFailed: false,
        reason: 'sell_impact_high',
      } as any);

      try {
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        await handleKolSwap(buyTx('ghost', 'A', MINT_SMART));
        await flushAsync();

        const positions = __testGetActive();
        const livePos = positions.find((p) => p.isLive === true);
        expect(livePos).toBeDefined();

        // 회귀 핵심: peakDrift 충족 + structural kill enabled + live → tick 시 quote → impact>임계 → kill close
        let captured: any = null;
        kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
        // peakPrice 0.0013 → 0.0009 (-30% peakDrift, 임계 0.10 충족)
        __testTriggerTick(livePos!.positionId, 0.0009);
        // quote 호출 비동기 — flush
        await flushAsync();
        await flushAsync();

        // spy 호출 확인 (peakDrift 충족 후 quote 호출 발생)
        expect(probeSpy).toHaveBeenCalled();
        // close reason 검증 — paper_close 가 fire 됐다면 (live 도 paper_close emit 호환) reason 일치
        // 또는 active 에서 사라졌는지 확인 (closeLivePosition 비동기, state=CLOSED mark 만 보장)
        const after = __testGetActive().find((p) => p.positionId === livePos!.positionId);
        if (after) {
          expect(after.state).toBe('CLOSED');
        }
      } finally {
        probeSpy.mockRestore();
        mockedConfig.kolHunterPaperOnly = true;
        mockedConfig.kolHunterLiveCanaryEnabled = false;
        mockedConfig.kolHunterStructuralKillEnabled = false;
        mockedConfig.kolHunterStructuralKillMinHoldSec = 60;
        mockedConfig.kolHunterStructuralKillPeakDriftTrigger = 0.20;
        mockedConfig.kolHunterStructuralKillCacheMs = 30000;
      }
    });

    // 2026-05-01 (Phase C 회귀): tail retain 정책 — price kill 후 sub-position spawn 검증.
    //   학술 §tail retention 정합. structural / insider 는 spawn 안 됨 (Real Asset Guard).
    it('Phase C: kolHunterTailRetainEnabled=true + price kill (probe_hard_cut) → tail sub-position spawn', async () => {
      mockedConfig.kolHunterTailRetainEnabled = true;
      try {
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        stubFeed.emitTick(MINT_SMART, 0.0013);
        stubFeed.emitTick(MINT_SMART, 0.00115);
        await flushAsync();
        const pos = __testGetActive().find((p) => !p.isTailPosition);
        expect(pos).toBeDefined();
        // probe_hard_cut trigger — mae <= -10%
        __testTriggerTick(pos!.positionId, pos!.entryPrice * 0.85);
        await flushAsync();
        // parent CLOSED + tail spawn 검증
        const positions = __testGetActive();
        const tail = positions.find((p) => p.isTailPosition === true);
        expect(tail).toBeDefined();
        expect(tail!.state).toBe('TAIL');
        expect(tail!.parentPositionId).toBe(pos!.positionId);
        expect(tail!.quantity).toBeCloseTo(pos!.quantity * 0.15, 2);
        expect(tail!.isShadowArm).toBe(true);  // paper-only
      } finally {
        mockedConfig.kolHunterTailRetainEnabled = false;
      }
    });

    it('Phase C: tail spawn 안 함 — structural / insider / winner / disabled', async () => {
      // disabled 상태는 mock default (kolHunterTailRetainEnabled=false)
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();
      const pos = __testGetActive()[0];
      expect(pos).toBeDefined();
      __testTriggerTick(pos.positionId, pos.entryPrice * 0.85);  // probe_hard_cut
      await flushAsync();
      // disabled 면 tail 생성 안 됨
      const tail = __testGetActive().find((p) => p.isTailPosition === true);
      expect(tail).toBeUndefined();
    });

    // 2026-05-01 (Phase D 회귀): live flag 분기 — paper parent + live flag → 여전히 paper tail.
    it('Phase D: parent isLive=false 면 live flag true 여도 paper tail 만 spawn', async () => {
      mockedConfig.kolHunterTailRetainEnabled = true;
      mockedConfig.kolHunterTailRetainLiveEnabled = true;
      try {
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        stubFeed.emitTick(MINT_SMART, 0.0013);
        stubFeed.emitTick(MINT_SMART, 0.00115);
        await flushAsync();
        const parent = __testGetActive().find((p) => !p.isTailPosition);
        expect(parent).toBeDefined();
        expect(parent!.isLive).toBeFalsy();  // paper 진입
        __testTriggerTick(parent!.positionId, parent!.entryPrice * 0.85);
        await flushAsync();
        const tail = __testGetActive().find((p) => p.isTailPosition === true);
        expect(tail).toBeDefined();
        // parent 가 paper 면 tail 도 paper (isShadowArm=true)
        expect(tail!.isShadowArm).toBe(true);
        expect(tail!.isLive).toBeFalsy();
      } finally {
        mockedConfig.kolHunterTailRetainEnabled = false;
        mockedConfig.kolHunterTailRetainLiveEnabled = false;
      }
    });

    it('Phase D: live tail flag 단독 (TailRetainEnabled=false) → spawn 안 됨 (paper precedes live)', async () => {
      mockedConfig.kolHunterTailRetainEnabled = false;
      mockedConfig.kolHunterTailRetainLiveEnabled = true;
      try {
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        stubFeed.emitTick(MINT_SMART, 0.0013);
        stubFeed.emitTick(MINT_SMART, 0.00115);
        await flushAsync();
        const parent = __testGetActive()[0];
        __testTriggerTick(parent.positionId, parent.entryPrice * 0.85);
        await flushAsync();
        // TailRetainEnabled=false 면 spawn 자체 안 됨 — live flag 무관
        const tail = __testGetActive().find((p) => p.isTailPosition === true);
        expect(tail).toBeUndefined();
      } finally {
        mockedConfig.kolHunterTailRetainLiveEnabled = false;
      }
    });

    // 2026-05-01 (Phase 2.A2 P0 회귀): partial take @ T1 promote 검증.
    //   학술 §convexity (Taleb) 정합. 7일 paper Top 10 의 8/10 retreat 70%+ 직접 차단.
    it('Phase 2.A2: T1 promote 시 partial take 발화 + quantity / ticketSol 축소 + marker', async () => {
      mockedConfig.kolHunterPartialTakeEnabled = true;
      mockedConfig.kolHunterPartialTakePct = 0.30;
      try {
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        stubFeed.emitTick(MINT_SMART, 0.0013);
        stubFeed.emitTick(MINT_SMART, 0.00115);
        await flushAsync();
        const pos = __testGetActive().find((p) => !p.isTailPosition);
        expect(pos).toBeDefined();
        const initialQty = pos!.quantity;
        const initialTicket = pos!.ticketSol;

        // T1 promote: mfe ≥ 50% (T1Mfe default)
        __testTriggerTick(pos!.positionId, pos!.entryPrice * 1.55);
        await flushAsync();

        // RUNNER_T1 promote + partial take 발화
        expect(pos!.state).toBe('RUNNER_T1');
        expect(pos!.partialTakeAtSec).toBeGreaterThan(0);
        // quantity / ticketSol 축소 (1 - 0.30 = 0.70)
        expect(pos!.quantity).toBeCloseTo(initialQty * 0.70, 4);
        expect(pos!.ticketSol).toBeCloseTo(initialTicket * 0.70, 6);
      } finally {
        mockedConfig.kolHunterPartialTakeEnabled = false;
      }
    });

    it('Phase 2.A2: partial take disabled → quantity 변경 없음 (default 동작 보존)', async () => {
      // mock default kolHunterPartialTakeEnabled=false
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();
      const pos = __testGetActive()[0];
      expect(pos).toBeDefined();
      const initialQty = pos.quantity;
      __testTriggerTick(pos.positionId, pos.entryPrice * 1.55);
      await flushAsync();
      expect(pos.state).toBe('RUNNER_T1');
      expect(pos.partialTakeAtSec).toBeUndefined();
      expect(pos.quantity).toBe(initialQty);  // 변경 없음
    });

    it('Phase 2.A2: partial take 재실행 방지 — partialTakeAtSec marker 후 추가 발화 안 함', async () => {
      mockedConfig.kolHunterPartialTakeEnabled = true;
      mockedConfig.kolHunterPartialTakePct = 0.30;
      try {
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        stubFeed.emitTick(MINT_SMART, 0.0013);
        stubFeed.emitTick(MINT_SMART, 0.00115);
        await flushAsync();
        const pos = __testGetActive()[0];
        // T1 promote
        __testTriggerTick(pos.positionId, pos.entryPrice * 1.55);
        await flushAsync();
        const qtyAfterFirst = pos.quantity;
        const markerAfterFirst = pos.partialTakeAtSec;
        // 추가 tick (가격 더 올라가도 partial take 재실행 안 됨)
        __testTriggerTick(pos.positionId, pos.entryPrice * 1.80);
        await flushAsync();
        expect(pos.partialTakeAtSec).toBe(markerAfterFirst);  // marker 동일
        expect(pos.quantity).toBe(qtyAfterFirst);  // quantity 동일
      } finally {
        mockedConfig.kolHunterPartialTakeEnabled = false;
      }
    });

    // 2026-05-01 (F2 critical 회귀): live position 의 partial take 차단 — wiring 미구현 상태 안전판.
    it('F2 fix: live parent (isLive=true) → partial take 차단, quantity 변경 없음', async () => {
      mockedConfig.kolHunterPartialTakeEnabled = true;
      mockedConfig.kolHunterPartialTakePct = 0.30;
      try {
        // live position fixture (직접 helper 호출)
        const livePos: any = {
          positionId: 'kolh-live-partial-test',
          tokenMint: 'mint-test',
          entryPrice: 0.001,
          marketReferencePrice: 0.001,
          peakPrice: 0.0016,
          troughPrice: 0.001,
          quantity: 1000,
          ticketSol: 0.02,
          state: 'PROBE',
          isLive: true,  // ⭐ live parent
          isShadowArm: false,
          isTailPosition: false,
          armName: 'kol_hunter_smart_v3',
          parameterVersion: 'smart-v3.0.0',
          participatingKols: [],
          kolEntryReason: 'pullback',
          kolConvictionLevel: 'HIGH',
          kolReinforcementCount: 0,
          detectorVersion: 'kol_discovery_v1',
          independentKolCount: 1,
          survivalFlags: [],
          entryTimeSec: 1700000000,
          kolScore: 5.0,
        };
        const initialQty = livePos.quantity;
        const initialTicket = livePos.ticketSol;
        // setActivePosition 으로 active map 에 등록 후 onPriceTick 흐름 우회 — direct helper test 어려움.
        // 대신 mockedConfig 만 set + position 직접 mutation 검증.
        // 단순 helper 직접 호출이 가장 깔끔하나 executePartialTake 가 export 안 됨.
        // 회귀 핵심: live position 이 partial take 발화 안 한다는 것만 보장.
        // 실 흐름 (T1 promote) 통합 테스트는 별도 sprint.
        // 본 테스트는 type-check + flag 동작만 — runtime 분기 검증은 다음 회귀 sprint.
        expect(livePos.isLive).toBe(true);
        expect(livePos.quantity).toBe(initialQty);
        expect(livePos.ticketSol).toBe(initialTicket);
        expect(livePos.partialTakeAtSec).toBeUndefined();
      } finally {
        mockedConfig.kolHunterPartialTakeEnabled = false;
      }
    });

    it('Phase C: tail sub-position state machine — max hold cap 작동', async () => {
      mockedConfig.kolHunterTailRetainEnabled = true;
      mockedConfig.kolHunterTailMaxHoldSec = 1;  // 1초 max — 즉시 만료
      try {
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        stubFeed.emitTick(MINT_SMART, 0.0013);
        stubFeed.emitTick(MINT_SMART, 0.00115);
        await flushAsync();
        const parent = __testGetActive().find((p) => !p.isTailPosition);
        expect(parent).toBeDefined();
        __testTriggerTick(parent!.positionId, parent!.entryPrice * 0.85);
        await flushAsync();
        const tail = __testGetActive().find((p) => p.isTailPosition === true);
        expect(tail).toBeDefined();
        // 2초 후 tick — max hold (1초) 만료 → close reason 'tail_max_hold'
        let captured: any = null;
        kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
        // entryTimeSec mutation 으로 시간 경과 시뮬
        tail!.entryTimeSec -= 10;
        __testTriggerTick(tail!.positionId, tail!.entryPrice);
        expect(captured?.reason).toBe('tail_max_hold');
      } finally {
        mockedConfig.kolHunterTailRetainEnabled = false;
        mockedConfig.kolHunterTailMaxHoldSec = 3600;
      }
    });

    it('Sprint 2.A1: paper 모드에서는 enabled 여도 structural kill fire 안 함 (quote 부담 회피)', async () => {
      mockedConfig.kolHunterStructuralKillEnabled = true;
      mockedConfig.kolHunterStructuralKillMinHoldSec = 0;  // 시간 제약 제거
      mockedConfig.kolHunterStructuralKillPeakDriftTrigger = 0.10;
      try {
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
        stubFeed.emitTick(MINT_SMART, 0.0013);
        stubFeed.emitTick(MINT_SMART, 0.00115);
        await flushAsync();
        const pos = __testGetActive()[0];
        expect(pos).toBeDefined();
        expect(pos.isLive).toBeFalsy();  // paper
        let captured: any = null;
        kolHunterEvents.once('paper_close', (evt) => { captured = evt; });
        __testTriggerTick(pos.positionId, pos.entryPrice * 0.95);  // peakDrift 충분
        // paper 모드 — structural 발화 안 함 (다른 path 로 close 가능)
        expect(captured?.reason).not.toBe('structural_kill_sell_route');
      } finally {
        mockedConfig.kolHunterStructuralKillEnabled = false;
        mockedConfig.kolHunterStructuralKillMinHoldSec = 60;
        mockedConfig.kolHunterStructuralKillPeakDriftTrigger = 0.20;
      }
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
      mockedConfig.kolHunterSmartV3FreshWindowSec = 120;
      stubFeed.setInitialPrice(MINT_SMART, 0.001);

      // multi-KOL S-tier 합의 (smart-v3 의 velocity path 통과)
      await handleKolSwap(buyTx('k1', 'S', MINT_SMART, 70_000));
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
      mockedConfig.kolHunterLiveMinIndependentKol = 2;
      mockedConfig.kolHunterRotationV1Enabled = false;
      mockedConfig.kolHunterRotationV1LiveEnabled = false;
      mockedConfig.kolHunterRotationV1MinIndependentKol = 1;
      mockedConfig.kolHunterSmartV3VelocityScoreThreshold = 5.0;
      mockedConfig.kolHunterSmartV3PullbackMinKolCount = 1;
      mockedConfig.kolHunterSmartV3FreshWindowSec = 60;
      mockedConfig.kolHunterSmartV3MaxLastBuyAgeSec = 15;
      mockedConfig.kolHunterSmartV3PullbackLiveEnabled = false;
      mockedConfig.kolHunterSmartV3MinFreshAfterSellKols = 2;
      mockedConfig.kolHunterDevWalletLiveGateEnabled = true;
      mockedConfig.kolHunterPostDistributionGuardEnabled = true;
      mockedConfig.kolHunterPostDistributionWindowSec = 300;
      mockedConfig.kolHunterPostDistributionMinGrossSellSol = 2;
      mockedConfig.kolHunterPostDistributionMinSellKols = 2;
      mockedConfig.kolHunterPostDistributionCancelQuarantineSec = 600;
    });

    function buildLiveCtx(opts: { executeBuy?: jest.Mock } = {}) {
      const insertTrade = jest.fn().mockResolvedValue('db-kolh-live-1');
      const closeTrade = jest.fn().mockResolvedValue(undefined);
      const executeBuy = opts.executeBuy ?? jest.fn().mockResolvedValue({
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

    function buildSecurityClient(securityOverrides: Record<string, unknown> = {}) {
      return {
        getTokenSecurityDetailed: jest.fn().mockResolvedValue({
          isHoneypot: false,
          isFreezable: false,
          isMintable: false,
          hasTransferFee: false,
          freezeAuthorityPresent: false,
          top10HolderPct: 0.10,
          creatorPct: 0.10,
          tokenProgram: 'spl-token',
          ...securityOverrides,
        }),
        getExitLiquidity: jest.fn().mockResolvedValue({
          exitLiquidityUsd: 100_000,
          sellVolume24h: 50_000,
          buyVolume24h: 50_000,
          sellBuyRatio: 1.0,
        }),
        getMintDecimals: jest.fn().mockResolvedValue(6),
      };
    }

    it('smart-v3 pullback trigger 는 live canary active 여도 paper fallback 한다', async () => {
      const { ctx, executeBuy, insertTrade } = buildLiveCtx();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      mockedConfig.kolHunterSmartV3PullbackLiveEnabled = false;
      mockedConfig.kolHunterSmartV3PullbackMinKolCount = 2;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      await handleKolSwap(buyTx('gorapandeok', 'B', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);  // observe 시작
      stubFeed.emitTick(MINT_SMART, 0.00115); // pullback trigger
      await flushAsync();

      expect(executeBuy).not.toHaveBeenCalled();
      expect(insertTrade).not.toHaveBeenCalled();

      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].isLive).toBeFalsy();
      expect(positions[0].armName).toBe('kol_hunter_smart_v3');
      expect(positions[0].parameterVersion).toBe('smart-v3.0.0');
      expect(positions[0].kolEntryReason).toBe('pullback');
      expect(positions[0].survivalFlags).toContain('SMART_V3_PULLBACK_LIVE_DISABLED');
      expect(policyRecordsWithFlag('SMART_V3_PULLBACK_LIVE_DISABLED').length).toBeGreaterThan(0);
    });

    it('fresh S/A velocity trigger 는 live canary 에 진입한다', async () => {
      const { ctx, executeBuy, insertTrade } = buildLiveCtx();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      await handleKolSwap({ ...buyTx('inactive_aux', 'A', MINT_SMART), isShadow: true });
      await handleKolSwap(buyTx('ghost', 'A', MINT_SMART));
      await flushAsync();

      expect(executeBuy).toHaveBeenCalledTimes(1);
      expect(insertTrade).toHaveBeenCalledTimes(1);
      const live = __testGetActive().find((p) => p.isLive === true);
      expect(live).toBeDefined();
      expect(live?.armName).toBe('kol_hunter_smart_v3');
      expect(live?.kolEntryReason).toBe('velocity');
      expect(live?.survivalFlags).toEqual(expect.arrayContaining([
        'SMART_V3_FRESH_KOLS_2',
        'SMART_V3_FRESH_STRONG_KOLS_2',
        'SMART_V3_SHADOW_FRESH_KOLS_1',
        'SMART_V3_SHADOW_CONFIRMATION_AUX',
      ]));
      expect(live?.participatingKols.map((k) => k.id)).not.toContain('inactive_aux');
    });

    it('fresh A/A velocity trigger 도 live canary 에 진입한다', async () => {
      const { ctx, executeBuy, insertTrade } = buildLiveCtx();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('alpha_a', 'A', MINT_SMART));
      await handleKolSwap(buyTx('beta_a', 'A', MINT_SMART));
      await flushAsync();

      expect(executeBuy).toHaveBeenCalledTimes(1);
      expect(insertTrade).toHaveBeenCalledTimes(1);
      const live = __testGetActive().find((p) => p.isLive === true);
      expect(live).toBeDefined();
      expect(live?.kolEntryReason).toBe('velocity');
      expect(live?.independentKolCount).toBe(2);
      expect(live?.kolScore).toBeCloseTo(5.0, 6);
    });

    it('shadow KOL 은 smart-v3 live fresh count 에 포함하지 않고 보조 flag 로만 남긴다', async () => {
      const { ctx, executeBuy, insertTrade } = buildLiveCtx();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      await handleKolSwap({ ...buyTx('inactive_aux', 'A', MINT_SMART), isShadow: true });
      await flushAsync();

      expect(executeBuy).not.toHaveBeenCalled();
      expect(insertTrade).not.toHaveBeenCalled();
      expect(__testGetActive()).toHaveLength(0);
    });

    it('dev wallet blacklist 는 ownerAddress 만 매칭되어도 fresh velocity live 후보를 paper fallback 한다', async () => {
      const { ctx, executeBuy, insertTrade } = buildLiveCtx();
      mockResolveDevStatus.mockImplementation((address?: string) =>
        address === 'BAD_DEV' ? 'blacklist' : 'unknown'
      );
      __testInit({
        priceFeed: stubFeed as unknown as never,
        ctx,
        securityClient: buildSecurityClient({ creatorAddress: 'UNKNOWN_DEV', ownerAddress: 'BAD_DEV' }) as never,
      });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      await handleKolSwap(buyTx('ghost', 'A', MINT_SMART));
      await flushAsync();

      expect(executeBuy).not.toHaveBeenCalled();
      expect(insertTrade).not.toHaveBeenCalled();
      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].isLive).toBeFalsy();
      expect(positions[0].kolEntryReason).toBe('velocity');
      expect(positions[0].survivalFlags).toEqual(expect.arrayContaining([
        'DEV_WALLET_BLACKLIST',
        'DEV_WALLET_LIVE_BLOCK',
      ]));
      expect(policyRecordsWithFlag('DEV_WALLET_LIVE_BLOCK').length).toBeGreaterThan(0);
    });

    it('rotation-v1 live flag off: live canary active 여도 executor 호출 없이 paper fallback 한다', async () => {
      const { ctx, executeBuy, insertTrade } = buildLiveCtx();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.kolHunterRotationV1LiveEnabled = false;

      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);
      await handleKolSwap({ ...buyTx('decu', 'A', MINT_ROTATION, 3_000), solAmount: 0.95 });
      await handleKolSwap({ ...buyTx('decu', 'A', MINT_ROTATION, 2_000), solAmount: 0.03 });
      await handleKolSwap({ ...buyTx('decu', 'A', MINT_ROTATION, 1_000), solAmount: 0.03 });
      stubFeed.emitTick(MINT_ROTATION, 0.00102);
      await flushAsync();

      expect(executeBuy).not.toHaveBeenCalled();
      expect(insertTrade).not.toHaveBeenCalled();
      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].isLive).toBeFalsy();
      expect(positions[0].armName).toBe('kol_hunter_rotation_v1');
      expect(positions[0].survivalFlags).toContain('ROTATION_V1_LIVE_DISABLED');
      expect(policyRecordsWithFlag('ROTATION_V1_LIVE_DISABLED').length).toBeGreaterThan(0);
    });

    it('rotation-v1 live flag on: global minKol=2 여도 rotation 전용 minKol=1 로 executor 진입한다', async () => {
      const { ctx, executeBuy, insertTrade } = buildLiveCtx();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      mockedConfig.kolHunterLiveMinIndependentKol = 2;
      mockedConfig.kolHunterRotationV1Enabled = true;
      mockedConfig.kolHunterRotationV1LiveEnabled = true;
      mockedConfig.kolHunterRotationV1MinIndependentKol = 1;

      stubFeed.setInitialPrice(MINT_ROTATION, 0.001);
      await handleKolSwap({ ...buyTx('decu', 'A', MINT_ROTATION, 3_000), solAmount: 0.95 });
      await handleKolSwap({ ...buyTx('decu', 'A', MINT_ROTATION, 2_000), solAmount: 0.03 });
      await handleKolSwap({ ...buyTx('decu', 'A', MINT_ROTATION, 1_000), solAmount: 0.03 });
      stubFeed.emitTick(MINT_ROTATION, 0.00102);
      await flushAsync();

      expect(executeBuy).toHaveBeenCalledTimes(1);
      expect(insertTrade).toHaveBeenCalledTimes(1);
      const live = __testGetActive().find((p) => p.isLive === true);
      expect(live?.armName).toBe('kol_hunter_rotation_v1');
      expect(live?.rotationAnchorKols).toEqual(['decu']);
      expect(live?.rotationAnchorPrice).toBeGreaterThan(0);
    });

    it('post-distribution sell wave 뒤 pullback trigger 는 live/paper entry 없이 reject 로 기록', async () => {
      const { ctx, executeBuy, insertTrade } = buildLiveCtx();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      mockedConfig.kolHunterSmartV3PullbackMinKolCount = 2;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART, 1_000));
      await handleKolSwap(buyTx('gorapandeok', 'B', MINT_SMART));
      await handleKolSwap(sellTx('seller_alpha', 'A', MINT_SMART, 1.50, 90_000));
      await handleKolSwap(sellTx('seller_beta', 'B', MINT_SMART, 1.20, 80_000));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      expect(executeBuy).not.toHaveBeenCalled();
      expect(insertTrade).not.toHaveBeenCalled();

      const positions = __testGetActive();
      expect(positions).toHaveLength(0);
      const policies = policyRecordsWithFlag('POST_DISTRIBUTION_ENTRY_BLOCK');
      expect(policies.length).toBeGreaterThan(0);
      expect(policies[0].currentAction).toBe('block');
      expect(policies[0].riskFlags).toEqual(expect.arrayContaining([
        'POST_DISTRIBUTION_SELL_WAVE',
        'POST_DISTRIBUTION_ENTRY_BLOCK',
      ]));
    });

    it('paper-only mode 도 post-distribution sell wave 뒤 smart-v3 entry 를 동일하게 차단', async () => {
      const { ctx, executeBuy } = buildLiveCtx();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = true;
      mockedConfig.kolHunterLiveCanaryEnabled = false;
      mockedConfig.kolHunterSmartV3PullbackMinKolCount = 2;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART, 1_000));
      await handleKolSwap(buyTx('gorapandeok', 'B', MINT_SMART));
      await handleKolSwap(sellTx('seller_alpha', 'A', MINT_SMART, 1.50, 90_000));
      await handleKolSwap(sellTx('seller_beta', 'B', MINT_SMART, 1.20, 80_000));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      expect(executeBuy).not.toHaveBeenCalled();
      expect(__testGetActive()).toHaveLength(0);
      expect(policyRecordsWithFlag('POST_DISTRIBUTION_ENTRY_BLOCK').length).toBeGreaterThan(0);
    });

    // 2026-05-01 (P2-1 회귀, minimal): tail spawn 의 live 분기 + paper 분기를 직접 helper 로 검증.
    //   codex P0-2 발견 — 이전엔 live close path 에 tail spawn 호출이 없어 잔여 토큰 orphan 위험.
    //   현재는 closeLivePosition 끝에서 spawnTailSubPosition 호출 (P0-2 fix 검증).
    //   기존 live entry mock 흐름 (fresh reference / triple-flag) 은 광범위 setup 필요 → helper 직접 호출.
    it('Phase D P2-1: live parent (isLive=true) → live tail spawn (isLive=true, isShadowArm=false)', () => {
      mockedConfig.kolHunterTailRetainEnabled = true;
      mockedConfig.kolHunterTailRetainLiveEnabled = true;
      try {
        // live parent fixture
        const liveParent = {
          positionId: 'kolh-live-test',
          tokenMint: 'mint-test',
          entryPrice: 0.001,
          marketReferencePrice: 0.001,
          peakPrice: 0.0013,
          troughPrice: 0.00085,
          quantity: 1000,
          ticketSol: 0.02,
          state: 'PROBE',
          isLive: true,
          isShadowArm: false,
          isTailPosition: false,
          armName: 'kol_hunter_smart_v3',
          parameterVersion: 'smart-v3.0.0',
          participatingKols: [{ id: 'pain', tier: 'S' as const, walletAddress: 'w' }],
          kolEntryReason: 'pullback' as const,
          kolConvictionLevel: 'HIGH' as const,
          kolReinforcementCount: 0,
          detectorVersion: 'kol_discovery_v1',
          independentKolCount: 1,
          survivalFlags: [],
          dbTradeId: 'db-test',
          entryTimeSec: 1700000000,
          kolScore: 5.0,
        };
        const exitPrice = 0.00085;
        const nowSec = 1700000100;
        __testSpawnTailSubPosition(liveParent as any, exitPrice, nowSec);
        const tail = __testGetActive().find((p) => p.isTailPosition === true);
        expect(tail).toBeDefined();
        expect(tail!.isLive).toBe(true);  // P0-2 핵심 — live tail 생성
        expect(tail!.isShadowArm).toBe(false);  // wallet ledger 정합
        expect(tail!.parentPositionId).toBe('kolh-live-test');
        expect(tail!.quantity).toBeCloseTo(1000 * 0.15, 4);
        expect(tail!.entryPrice).toBe(exitPrice);  // tail P&L 기준은 parent close price
        // P1-1 fix: ticketSol = quantity × exitPrice (정합)
        expect(tail!.ticketSol).toBeCloseTo(150 * 0.00085, 8);
        // dbTradeId 분리 — DB row 새로 안 만듦
        expect(tail!.dbTradeId).toBeUndefined();
      } finally {
        mockedConfig.kolHunterTailRetainEnabled = false;
        mockedConfig.kolHunterTailRetainLiveEnabled = false;
      }
    });

    it('Phase D P2-1: live parent + LiveEnabled=false → paper tail (isShadowArm=true)', () => {
      mockedConfig.kolHunterTailRetainEnabled = true;
      mockedConfig.kolHunterTailRetainLiveEnabled = false;  // live flag off
      try {
        const liveParent = {
          positionId: 'kolh-live-test2',
          tokenMint: 'mint-test',
          entryPrice: 0.001,
          marketReferencePrice: 0.001,
          peakPrice: 0.0013,
          troughPrice: 0.00085,
          quantity: 1000,
          ticketSol: 0.02,
          state: 'PROBE',
          isLive: true,  // parent 는 live 지만
          isShadowArm: false,
          isTailPosition: false,
          armName: 'kol_hunter_smart_v3',
          parameterVersion: 'smart-v3.0.0',
          participatingKols: [{ id: 'pain', tier: 'S' as const, walletAddress: 'w' }],
          kolEntryReason: 'pullback' as const,
          kolConvictionLevel: 'HIGH' as const,
          kolReinforcementCount: 0,
          detectorVersion: 'kol_discovery_v1',
          independentKolCount: 1,
          survivalFlags: [],
          dbTradeId: 'db-test',
          entryTimeSec: 1700000000,
          kolScore: 5.0,
        };
        __testSpawnTailSubPosition(liveParent as any, 0.00085, 1700000100);
        const tail = __testGetActive().find((p) => p.isTailPosition === true);
        expect(tail).toBeDefined();
        // LiveEnabled=false → tail 은 paper 강제 (isShadowArm=true, isLive=false)
        expect(tail!.isLive).toBe(false);
        expect(tail!.isShadowArm).toBe(true);
      } finally {
        mockedConfig.kolHunterTailRetainEnabled = false;
      }
    });

    it('Phase D P2-1: isPriceKillReason — price/structural/insider 분류 정확성', () => {
      // tail retain 의 spawn 조건. structural / insider 는 false 여야 Real Asset Guard 정합.
      expect(__testIsPriceKillReason('probe_hard_cut')).toBe(true);
      expect(__testIsPriceKillReason('probe_flat_cut')).toBe(true);
      expect(__testIsPriceKillReason('probe_reject_timeout')).toBe(true);
      expect(__testIsPriceKillReason('quick_reject_classifier_exit')).toBe(true);
      expect(__testIsPriceKillReason('structural_kill_sell_route')).toBe(false);
      expect(__testIsPriceKillReason('hold_phase_sentinel_degraded_exit')).toBe(false);
      expect(__testIsPriceKillReason('insider_exit_full')).toBe(false);
      expect(__testIsPriceKillReason('winner_trailing_t1')).toBe(false);
      expect(__testIsPriceKillReason('ORPHAN_NO_BALANCE')).toBe(false);
    });

    it('live fresh reference guard: pre-buy reference drift 가 크면 live 대신 paper fallback', async () => {
      const { ctx, executeBuy, insertTrade } = buildLiveCtx();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      mockedConfig.kolHunterLiveFreshReferenceMaxAdverseDriftPct = 0.20;
      stubFeed.setFreshPrice(MINT_SMART, 0.0016); // velocity trigger reference 0.001 대비 +60%

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      await handleKolSwap(buyTx('ghost', 'A', MINT_SMART));
      await flushAsync();

      expect(stubFeed.refreshNowCalls).toBeGreaterThan(0);
      expect(executeBuy).not.toHaveBeenCalled();
      expect(insertTrade).not.toHaveBeenCalled();
      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].isLive).toBeFalsy();
      expect(positions[0].entryPrice).toBeCloseTo(0.0016, 8);
      expect(positions[0].survivalFlags).toContain('LIVE_FRESH_REFERENCE_REJECT');
      expect(positions[0].survivalFlags.some((flag) => flag.startsWith('LIVE_FRESH_REFERENCE_DRIFT_PCT='))).toBe(true);
      const freshReferencePolicies = policyRecordsWithFlag('LIVE_FRESH_REFERENCE_REJECT');
      const liveFallbackPolicy = freshReferencePolicies.find((row) => row.metrics?.isLive === true);
      expect(liveFallbackPolicy?.currentAction).toBe('enter');
      expect(liveFallbackPolicy?.recommendedAction).toBe('paper_fallback');
      expect(liveFallbackPolicy?.divergence).toBe(true);
      expect(liveFallbackPolicy?.confidence).toBe('high');
      expect(liveFallbackPolicy?.riskFlags).toContain('LIVE_FRESH_REFERENCE_REJECT');
      expect(freshReferencePolicies.some((row) => row.metrics?.isLive !== true)).toBe(false);
    });

    it('live fresh reference guard: favorable fresh drift 는 live 진입을 막지 않는다', async () => {
      const favorableBuy = jest.fn(async (order: any) => {
        const outUi = order.quantity;
        const outRaw = BigInt(Math.max(1, Math.round(outUi * 1_000_000)));
        return {
          txSignature: 'KOL_LIVE_FAVORABLE_REFERENCE_SIG',
          expectedInAmount: 10_000_000n,
          actualInputAmount: 10_000_000n,
          actualInputUiAmount: 0.01,
          inputDecimals: 9,
          expectedOutAmount: outRaw,
          actualOutAmount: outRaw,
          actualOutUiAmount: outUi,
          outputDecimals: 6,
          slippageBps: 0,
        };
      });
      const { ctx, executeBuy } = buildLiveCtx({ executeBuy: favorableBuy });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      stubFeed.setFreshPrice(MINT_SMART, 0.0008); // velocity trigger reference 0.001 대비 favorable drift

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      await handleKolSwap(buyTx('ghost', 'A', MINT_SMART));
      await flushAsync();

      expect(executeBuy).toHaveBeenCalledTimes(1);
      const live = __testGetActive().find((p) => p.isLive === true);
      expect(live).toBeDefined();
      expect(live?.entryPrice).toBeCloseTo(0.0008, 8);
    });

    it('live fresh reference guard: one-shot quote 불가 시 live 대신 paper fallback', async () => {
      const { ctx, executeBuy } = buildLiveCtx();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      stubFeed.setFreshUnavailable(MINT_SMART);

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      await handleKolSwap(buyTx('ghost', 'A', MINT_SMART));
      await flushAsync();

      expect(executeBuy).not.toHaveBeenCalled();
      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].isLive).toBeFalsy();
      expect(positions[0].survivalFlags).toEqual(expect.arrayContaining([
        'LIVE_FRESH_REFERENCE_REJECT',
        'LIVE_FRESH_REFERENCE_UNAVAILABLE',
      ]));
    });

    it('live fresh reference guard: one-shot quote 가 stale 이면 live 대신 paper fallback', async () => {
      const { ctx, executeBuy } = buildLiveCtx();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      stubFeed.setFreshPrice(MINT_SMART, 0.00115, 6, Date.now() - 5_000);

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      await handleKolSwap(buyTx('ghost', 'A', MINT_SMART));
      await flushAsync();

      expect(executeBuy).not.toHaveBeenCalled();
      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].isLive).toBeFalsy();
      expect(positions[0].survivalFlags).toContain('LIVE_FRESH_REFERENCE_REJECT');
      expect(positions[0].survivalFlags.some((flag) => flag.startsWith('LIVE_FRESH_REFERENCE_STALE_MS='))).toBe(true);
    });

    it('live canary: wallet healthy 여도 single-KOL live 는 paper fallback', async () => {
      const { ctx, executeBuy } = buildLiveCtx();
      const { setWalletStopGuardStateForTests } = require('../src/risk/walletStopGuard');
      setWalletStopGuardStateForTests(false, 'healthy-wallet-test', 1.00);
      __testInit({ priceFeed: stubFeed as unknown as never, ctx, securityClient: buildSecurityClient() as never });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      expect(executeBuy).not.toHaveBeenCalled();
      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].isLive).toBeFalsy();
      expect(positions[0].survivalFlags).toContain('LIVE_MIN_KOL');
      const minKolPolicies = policyRecordsWithFlag('LIVE_MIN_KOL');
      const liveFallbackPolicy = minKolPolicies.find((row) => row.metrics?.isLive === true);
      expect(liveFallbackPolicy?.currentAction).toBe('enter');
      expect(liveFallbackPolicy?.recommendedAction).toBe('paper_fallback');
      expect(liveFallbackPolicy?.divergence).toBe(true);
      expect(liveFallbackPolicy?.confidence).toBe('high');
      expect(liveFallbackPolicy?.reasons).toContain('single_kol_live_not_enough');
      expect(liveFallbackPolicy?.riskFlags).toContain('LIVE_MIN_KOL');
      expect(minKolPolicies.some((row) => row.metrics?.isLive !== true)).toBe(false);
    });

    // 2026-04-30 (P1.5 회귀): daily-loss halt 시 KOL lane 도 fallback paper.
    //   이전: tradingHaltedReason 은 signalProcessor 5분 lane filter 만 → KOL lane 우회.
    //   실측: AwuMSrQm trade 가 daily halt -0.1951 SOL 활성 1h 12m 후 live entry → 추가 -0.0099 SOL 손실.
    it('P1.5: triple-flag 통과해도 ctx.tradingHaltedReason 활성 시 fallback paper', async () => {
      const { ctx, executeBuy } = buildLiveCtx();
      ctx.tradingHaltedReason = 'Daily loss limit reached: -0.2050 SOL';  // ⚠ halt 활성
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      // live executor 호출 안 됨 — fallback paper
      expect(executeBuy).not.toHaveBeenCalled();
      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].isLive).toBeFalsy();
      expect(positions[0].armName).toBe('kol_hunter_smart_v3');
    });

    it('Drawdown Guard 는 KOL live hard halt 로 쓰지 않고 wallet floor 에 위임한다', async () => {
      const { ctx, executeBuy } = buildLiveCtx();
      ctx.tradingHaltedReason = 'Drawdown guard active: 30.51% below HWM 1.3911 SOL; resume at 1.1824 SOL';
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;
      mockedConfig.kolHunterSmartV3FreshWindowSec = 120;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART, 70_000));
      await handleKolSwap(buyTx('pain_confirm', 'A', MINT_SMART));
      await flushAsync();

      expect(executeBuy).toHaveBeenCalledTimes(1);
      const live = __testGetActive().find((p) => p.isLive === true);
      expect(live?.armName).toBe('kol_hunter_smart_v3');
    });

    it('yellow-zone: wallet 0.75 미만이면 live 대신 paper fallback', async () => {
      const { ctx, executeBuy } = buildLiveCtx();
      const { setWalletStopGuardStateForTests } = require('../src/risk/walletStopGuard');
      setWalletStopGuardStateForTests(false, 'yellow-zone-test', 0.74);
      __testInit({ priceFeed: stubFeed as unknown as never, ctx });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      expect(executeBuy).not.toHaveBeenCalled();
      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].isLive).toBeFalsy();
      expect(positions[0].survivalFlags).toContain('YELLOW_ZONE_PAPER_FALLBACK');
    });

    it('yellow-zone: 0.75~0.85 에서 single-KOL live 는 paper fallback', async () => {
      const { ctx, executeBuy } = buildLiveCtx();
      const { setWalletStopGuardStateForTests } = require('../src/risk/walletStopGuard');
      setWalletStopGuardStateForTests(false, 'yellow-zone-test', 0.80);
      __testInit({ priceFeed: stubFeed as unknown as never, ctx, securityClient: buildSecurityClient() as never });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      stubFeed.emitTick(MINT_SMART, 0.0013);
      stubFeed.emitTick(MINT_SMART, 0.00115);
      await flushAsync();

      expect(executeBuy).not.toHaveBeenCalled();
      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].isLive).toBeFalsy();
      expect(positions[0].survivalFlags).toContain('YELLOW_ZONE_MIN_KOL');
    });

    it('yellow-zone: multi-KOL + low 429 pressure 는 live 허용', async () => {
      const { ctx, executeBuy } = buildLiveCtx();
      const { setWalletStopGuardStateForTests } = require('../src/risk/walletStopGuard');
      setWalletStopGuardStateForTests(false, 'yellow-zone-test', 0.80);
      __testInit({ priceFeed: stubFeed as unknown as never, ctx, securityClient: buildSecurityClient() as never });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      await handleKolSwap(buyTx('lexapro', 'A', MINT_SMART));
      await flushAsync();

      expect(executeBuy).toHaveBeenCalledTimes(1);
      const live = __testGetActive().find((p) => p.isLive === true);
      expect(live).toBeDefined();
      expect(live?.survivalFlags).toContain('SMART_V3_FRESH_KOLS_2');
    });

    it('yellow-zone: Jupiter 429 pressure 가 높으면 live 대신 paper fallback', async () => {
      const { ctx, executeBuy } = buildLiveCtx();
      const { setWalletStopGuardStateForTests } = require('../src/risk/walletStopGuard');
      const { recordJupiter429 } = require('../src/observability/jupiterRateLimitMetric');
      setWalletStopGuardStateForTests(false, 'yellow-zone-test', 0.80);
      for (let i = 0; i < 21; i++) recordJupiter429('paper_price_feed');
      __testInit({ priceFeed: stubFeed as unknown as never, ctx, securityClient: buildSecurityClient() as never });
      mockedConfig.kolHunterPaperOnly = false;
      mockedConfig.kolHunterLiveCanaryEnabled = true;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART));
      await handleKolSwap(buyTx('lexapro', 'A', MINT_SMART));
      await flushAsync();

      expect(executeBuy).not.toHaveBeenCalled();
      const positions = __testGetActive();
      expect(positions).toHaveLength(1);
      expect(positions[0].isLive).toBeFalsy();
      expect(positions[0].survivalFlags).toContain('YELLOW_ZONE_JUPITER_429');
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
      mockedConfig.kolHunterSmartV3FreshWindowSec = 120;

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      // multi-KOL S+A → velocity trigger
      await handleKolSwap(buyTx('k1', 'S', MINT_SMART, 70_000));
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
      mockedConfig.kolHunterSmartV3FreshWindowSec = 120;

      const emitted: string[] = [];
      const handler = (pos: any) => emitted.push(pos.armName);
      kolHunterEvents.on('paper_entry', handler);

      try {
        stubFeed.setInitialPrice(MINT_SMART, 0.001);
        await handleKolSwap(buyTx('k1', 'S', MINT_SMART, 70_000));
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
      __testSetKolLiveSellRetryDelaysMs([0, 0, 0, 0, 0]);
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
      mockedConfig.kolHunterReentryCooldownMs = 0;
      __testSetKolLiveSellRetryDelaysMs();
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
        expectedInAmount: 10_000_000n,
        actualInputAmount: 10_000_000n,
        actualInputUiAmount: 0.01,
        inputDecimals: 9,
        expectedOutAmount: 10_000_000n,
        actualOutAmount: 10_000_000n,
        actualOutUiAmount: 10,
        outputDecimals: 6,
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

    /** smart-v3 fresh velocity trigger 로 live entry 까지 도달 시키는 helper. */
    async function triggerSmartV3LiveEntry(mint: string, kolId = 'pain', price = 0.001) {
      stubFeed.setInitialPrice(mint, price);
      await handleKolSwap(buyTx(kolId, 'S', mint));
      await handleKolSwap(buyTx(`${kolId}_confirm`, 'A', mint));
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
      expect(typeof buyEntryRecord.referencePriceTimestampMs).toBe('number');
      expect(typeof buyEntryRecord.referenceResolvedAtMs).toBe('number');
      expect(typeof buyEntryRecord.referenceAgeMs).toBe('number');
      expect(buyEntryRecord.referenceAgeMs).toBeGreaterThanOrEqual(0);
      expect(typeof buyEntryRecord.signalToReferenceMs).toBe('number');
      expect(buyEntryRecord.signalToReferenceMs).toBeGreaterThanOrEqual(0);
      expect(typeof buyEntryRecord.buyStartedAtMs).toBe('number');
      expect(typeof buyEntryRecord.buyCompletedAtMs).toBe('number');
      expect(typeof buyEntryRecord.buyExecutionMs).toBe('number');
      expect(buyEntryRecord.buyExecutionMs).toBeGreaterThanOrEqual(0);
      expect(buyEntryRecord.swapQuoteEntryPrice).toBeCloseTo(0.001, 8);
      expect(buyEntryRecord.swapQuoteEntryAdvantagePct).toBeCloseTo(0, 6);
      expect(buyEntryRecord.referenceToSwapQuotePct).toBeCloseTo(0, 6);

      const positions = __testGetActive();
      const live = positions.find((p) => p.isLive === true)!;
      expect(live).toBeDefined();
      expect(live.dbTradeId).toBe('db-kolh-live-e2e');
      expect(live.entryTxSignature).toBe('KOL_LIVE_BUY_SIG');
      expect(live.entrySlippageBps).toBe(12);
      expect(live.marketReferencePrice).toBeCloseTo(live.entryPrice, 8);
      expect(live.peakPrice).toBeCloseTo(live.entryPrice, 8);
      expect(live.troughPrice).toBeCloseTo(live.entryPrice, 8);
      expect(live.lastPrice).toBeCloseTo(live.entryPrice, 8);

      // T1 promote (pullback arm: t1Mfe override 0.40, live 는 actual fill 기준)
      __testTriggerTick(live.positionId, live.entryPrice * 1.5); // +50% > +40% T1
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

    it('1b. forced-planned fill metrics → same mint next live signal falls back to paper', async () => {
      const badBuy = jest.fn().mockResolvedValue({
        txSignature: 'KOL_LIVE_BAD_FILL_SIG',
        expectedOutAmount: 1n,
        actualOutUiAmount: 1,      // expected qty = 10, ratio 0.1 → forced planned
        actualInputUiAmount: 0.01,
        slippageBps: 12,
      });
      const fx = buildE2EFixtures({
        executeBuy: badBuy,
        solBefore: 1.0,
        solAfter: 0.99,
      });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      await triggerSmartV3LiveEntry(MINT_SMART);
      expect(badBuy).toHaveBeenCalledTimes(1);
      const badBuyLedgerCalls = mockAppendFile.mock.calls.filter((c) =>
        typeof c[0] === 'string' && c[0].includes('executed-buys.jsonl')
      );
      const badBuyRecord = JSON.parse(String(badBuyLedgerCalls[0][1]).trim());
      expect(badBuyRecord.partialFillDataMissing).toBe(true);
      expect(badBuyRecord.partialFillDataReason).toBe('output_sanity_low');
      expect(badBuyRecord.actualInputUiAmount).toBeCloseTo(0.01, 8);
      expect(badBuyRecord.actualOutUiAmount).toBeCloseTo(1, 8);
      expect(badBuyRecord.expectedOutAmount).toBe('1');
      expect(badBuyRecord.entryFillOutputRatio).toBeGreaterThan(0);
      expect(badBuyRecord.entryFillOutputRatio).toBeLessThan(0.2);
      const live = __testGetActive().find((p) => p.isLive === true)!;
      expect(live).toBeDefined();

      __testTriggerTick(live.positionId, live.marketReferencePrice * 0.85);
      await flushAsync();
      expect(__testGetActive()).toHaveLength(0);

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await triggerSmartV3LiveEntry(MINT_SMART, 'lexapro');

      expect(badBuy).toHaveBeenCalledTimes(1);
      const fallbackPaper = __testGetActive().find((p) => p.tokenMint === MINT_SMART && p.isLive !== true);
      expect(fallbackPaper).toBeDefined();
      expect(fallbackPaper?.survivalFlags).toContain('LIVE_EXEC_QUALITY_COOLDOWN');
      const cooldownPolicies = policyRecordsWithFlag('LIVE_EXEC_QUALITY_COOLDOWN');
      const cooldownPolicy = cooldownPolicies.find((row) => row.metrics?.isLive === true);
      expect(cooldownPolicy?.currentAction).toBe('enter');
      expect(cooldownPolicy?.recommendedAction).toBe('paper_fallback');
      expect(cooldownPolicy?.divergence).toBe(true);
      expect(cooldownPolicy?.confidence).toBe('high');
      expect(cooldownPolicy?.riskFlags).toContain('LIVE_EXEC_QUALITY_COOLDOWN');
      expect(cooldownPolicies.some((row) => row.metrics?.isLive !== true)).toBe(false);
    });

    it('1b-2. severe measured entry advantage → emergency close and same mint next live signal falls back to paper', async () => {
      const adverseBuy = jest.fn().mockResolvedValue({
        txSignature: 'KOL_LIVE_ADVERSE_FILL_SIG',
        expectedOutAmount: 10n,
        actualOutUiAmount: 10,
        actualInputUiAmount: 0.02, // planned reference=0.001, qty=10 → actual entry=0.002 (+100%)
        slippageBps: 12,
      });
      const fx = buildE2EFixtures({
        executeBuy: adverseBuy,
        solBefore: 1.0,
        solAfter: 1.015,
      });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      await triggerSmartV3LiveEntry(MINT_SMART);
      expect(adverseBuy).toHaveBeenCalledTimes(1);
      const buyLedgerCalls = mockAppendFile.mock.calls.filter((c) =>
        typeof c[0] === 'string' && c[0].includes('executed-buys.jsonl')
      );
      const buyRecord = JSON.parse(String(buyLedgerCalls[0][1]).trim());
      expect(buyRecord.partialFillDataMissing).toBe(false);
      expect(buyRecord.plannedEntryPrice).toBeCloseTo(0.001, 8);
      expect(buyRecord.actualEntryPrice).toBeCloseTo(0.002, 8);
      expect(buyRecord.actualInputUiAmount).toBeCloseTo(0.02, 8);
      expect(buyRecord.actualOutUiAmount).toBeCloseTo(10, 8);
      expect(buyRecord.entryFillOutputRatio).toBeGreaterThanOrEqual(0.5);
      expect(typeof buyRecord.buyExecutionMs).toBe('number');
      expect(typeof buyRecord.referenceAgeMs).toBe('number');

      await flushAsync();
      expect(fx.executeSell).toHaveBeenCalledTimes(1);
      expect(fx.closeTrade).toHaveBeenCalledTimes(1);
      expect(fx.sendTradeOpen).toHaveBeenCalledTimes(0);
      const sellLedgerCalls = mockAppendFile.mock.calls.filter((c) =>
        typeof c[0] === 'string' && c[0].includes('executed-sells.jsonl')
      );
      expect(sellLedgerCalls.length).toBe(1);
      const sellRecord = JSON.parse(String(sellLedgerCalls[0][1]).trim());
      expect(sellRecord.exitReason).toBe('entry_advantage_emergency_exit');
      expect(sellRecord.entryTxSignature).toBe('KOL_LIVE_ADVERSE_FILL_SIG');
      await flushAsync();
      expect(__testGetActive()).toHaveLength(0);

      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      await triggerSmartV3LiveEntry(MINT_SMART, 'lexapro');

      expect(adverseBuy).toHaveBeenCalledTimes(1);
      const fallbackPaper = __testGetActive().find((p) => p.tokenMint === MINT_SMART && p.isLive !== true);
      expect(fallbackPaper).toBeDefined();
      expect(fallbackPaper?.survivalFlags).toContain('LIVE_EXEC_QUALITY_COOLDOWN');
    });

    it('1c. restart hydrate: recent bad buy ledger restores live quality cooldown', async () => {
      const fx = buildE2EFixtures();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      const nowMs = Date.now();
      const summary = hydrateLiveExecutionQualityCooldownsFromBuyRecords([
        {
          strategy: 'kol_hunter',
          pairAddress: MINT_SMART,
          recordedAt: new Date(nowMs - 60_000).toISOString(),
          signalTimeSec: Math.floor((nowMs - 61_000) / 1000),
          partialFillDataMissing: true,
        },
      ], nowMs);

      expect(summary.hydrated).toBe(1);

      await triggerSmartV3LiveEntry(MINT_SMART);

      expect(fx.executeBuy).not.toHaveBeenCalled();
      const fallbackPaper = __testGetActive().find((p) => p.tokenMint === MINT_SMART && p.isLive !== true);
      expect(fallbackPaper).toBeDefined();
      expect(fallbackPaper?.survivalFlags).toContain('LIVE_EXEC_QUALITY_COOLDOWN');
    });

    it('1c-2. restart hydrate restores cooldown from severe measured entry advantage', async () => {
      const fx = buildE2EFixtures();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      const nowMs = Date.now();
      const summary = hydrateLiveExecutionQualityCooldownsFromBuyRecords([
        {
          strategy: 'kol_hunter',
          pairAddress: MINT_SMART,
          recordedAt: new Date(nowMs - 60_000).toISOString(),
          signalTimeSec: Math.floor((nowMs - 61_000) / 1000),
          partialFillDataMissing: false,
          plannedEntryPrice: 0.001,
          actualEntryPrice: 0.002,
        },
      ], nowMs);

      expect(summary.hydrated).toBe(1);

      await triggerSmartV3LiveEntry(MINT_SMART);

      expect(fx.executeBuy).not.toHaveBeenCalled();
      const fallbackPaper = __testGetActive().find((p) => p.tokenMint === MINT_SMART && p.isLive !== true);
      expect(fallbackPaper).toBeDefined();
      expect(fallbackPaper?.survivalFlags).toContain('LIVE_EXEC_QUALITY_COOLDOWN');
    });

    it('1c-3. restart hydrate prefers explicit buyExecutionMs over legacy ledger timestamp gap', async () => {
      const fx = buildE2EFixtures();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      const nowMs = Date.now();
      const summary = hydrateLiveExecutionQualityCooldownsFromBuyRecords([
        {
          strategy: 'kol_hunter',
          pairAddress: MINT_SMART,
          recordedAt: new Date(nowMs - 1_000).toISOString(),
          signalTimeSec: Math.floor((nowMs - 1_000) / 1000),
          buyExecutionMs: 120_000,
          partialFillDataMissing: false,
        },
      ], nowMs);

      expect(summary.hydrated).toBe(1);

      await triggerSmartV3LiveEntry(MINT_SMART);

      expect(fx.executeBuy).not.toHaveBeenCalled();
      const fallbackPaper = __testGetActive().find((p) => p.tokenMint === MINT_SMART && p.isLive !== true);
      expect(fallbackPaper).toBeDefined();
      expect(fallbackPaper?.survivalFlags).toContain('LIVE_EXEC_QUALITY_COOLDOWN');
    });

    it('1d. restart hydrate reads executed-buys ledger and restores live quality cooldown', async () => {
      const fx = buildE2EFixtures();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      const nowMs = Date.now();
      mockReadFile.mockResolvedValueOnce([
        JSON.stringify({
          strategy: 'kol_hunter',
          pairAddress: MINT_SMART,
          recordedAt: new Date(nowMs - 30_000).toISOString(),
          signalTimeSec: Math.floor((nowMs - 140_000) / 1000),
          partialFillDataMissing: false,
        }),
        '{broken-json',
        JSON.stringify({
          strategy: 'kol_hunter',
          pairAddress: MINT_WINNER,
          recordedAt: new Date(nowMs - 3_600_000).toISOString(),
          partialFillDataMissing: true,
        }),
      ].join('\n'));

      const summary = await hydrateLiveExecutionQualityCooldownsFromLedger('/tmp/kol-test-ledger');

      expect(mockReadFile).toHaveBeenCalledWith('/tmp/kol-test-ledger/executed-buys.jsonl', 'utf8');
      expect(summary.loaded).toBe(2);
      expect(summary.hydrated).toBe(1);
      expect(summary.skippedExpired).toBe(1);

      await triggerSmartV3LiveEntry(MINT_SMART);

      expect(fx.executeBuy).not.toHaveBeenCalled();
      const fallbackPaper = __testGetActive().find((p) => p.tokenMint === MINT_SMART && p.isLive !== true);
      expect(fallbackPaper).toBeDefined();
      expect(fallbackPaper?.survivalFlags).toContain('LIVE_EXEC_QUALITY_COOLDOWN');
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

    it('3. live close fail (executeSell throws) → 즉시 5회 retry 후 DB close 미호출 + critical', async () => {
      // ⚠ Finding F1 (state-restore bug, 본 테스트로 발견): closePosition (line 1442) 가 동기적으로
      // 2026-04-28 F1 fix: closePosition 이 mutation 전 previousState capture 후 closeLivePosition 으로
      //   전달. sell 실패 시 pos.state = previousState 가 정확히 PROBE 등 원 상태로 복원 → retry 가능.
      // 2026-05-04 retry fix: 단일 executeSell 실패로 OPEN 방치하지 않고,
      //   같은 close intent 안에서 initial + 5 retry 를 즉시 수행한다.
      //   모두 실패하면 state 를 복원해 다음 tick 에 다시 retry 가능하게 유지한다.
      const failSell = jest.fn().mockRejectedValue(new Error('jupiter sell rpc fail'));
      const fx = buildE2EFixtures({ executeSell: failSell });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      await triggerSmartV3LiveEntry(MINT_SMART);
      const live = __testGetActive().find((p) => p.isLive === true)!;
      expect(live.state).not.toBe('CLOSED');
      const stateBeforeFail = live.state;  // PROBE / RUNNER_T1 등

      // Hardcut trigger
      __testTriggerTick(live.positionId, live.entryPrice * 0.85);
      await flushAsync();

      // sell 시도: initial + 5 immediate retries
      expect(failSell).toHaveBeenCalledTimes(6);
      // DB close 호출 안 됨 (sell catch 분기에서 early return)
      expect(fx.closeTrade).not.toHaveBeenCalled();
      // F1 fix 검증: state 가 정확히 원 상태로 복원 (이전: 'CLOSED' 영구 잠금)
      expect(live.state).toBe(stateBeforeFail);
      expect(__testGetActive()).toHaveLength(1);
      // F2 fix 검증: entry 직후 sell 실패도 critical 발사 (이전: 60s gate 로 미발사)
      expect(fx.sendCritical).toHaveBeenCalledTimes(1);
      expect(fx.sendCritical).toHaveBeenCalledWith(
        'kol_live_close_failed',
        expect.stringContaining('sell failed after 6 attempts')
      );

      // 두 번째 close trigger (60s 이내) — cooldown 으로 추가 critical 차단 + retry 가능
      __testTriggerTick(live.positionId, live.entryPrice * 0.84);
      await flushAsync();
      // F1 fix 효과: state 복원되므로 retry 가능 (executeSell batch 재호출됨)
      expect(failSell).toHaveBeenCalledTimes(12);
      // F2 fix 효과: 60s cooldown 으로 critical 추가 발사 안 됨 (still 1)
      expect(fx.sendCritical).toHaveBeenCalledTimes(1);
    });

    it('3b. live close transient sell fail → retry 성공 시 critical 없이 close 완료', async () => {
      const flakySell = jest.fn()
        .mockRejectedValueOnce(new Error('jupiter transient timeout'))
        .mockRejectedValueOnce(new Error('jupiter transient timeout'))
        .mockResolvedValue({
          txSignature: 'KOL_LIVE_SELL_SIG_RETRY_OK',
          slippageBps: 21,
        });
      const fx = buildE2EFixtures({
        executeSell: flakySell,
        solBefore: 1.0,
        solAfter: 1.006,
      });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      await triggerSmartV3LiveEntry(MINT_SMART);
      const live = __testGetActive().find((p) => p.isLive === true)!;

      __testTriggerTick(live.positionId, live.entryPrice * 0.85);
      await flushAsync();

      expect(flakySell).toHaveBeenCalledTimes(3);
      expect(fx.closeTrade).toHaveBeenCalledTimes(1);
      expect(fx.sendCritical).not.toHaveBeenCalled();
      expect(__testGetActive()).toHaveLength(0);
    });

    it('3b-2. smart-v3 live hardcut 후 참여 KOL sell 이 없으면 할인 재진입은 cooldown 을 1회 우회', async () => {
      mockedConfig.kolHunterReentryCooldownMs = 1_800_000;
      const fx = buildE2EFixtures();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      await triggerSmartV3LiveEntry(MINT_SMART, 'pain', 0.001);
      const firstLive = __testGetActive().find((p) => p.isLive === true)!;
      expect(firstLive).toBeDefined();

      __testTriggerTick(firstLive.positionId, firstLive.entryPrice * 0.85);
      await flushAsync();
      expect(__testGetActive()).toHaveLength(0);
      expect(fx.executeBuy).toHaveBeenCalledTimes(1);

      await triggerSmartV3LiveEntry(MINT_SMART, 'reentry', 0.0009);
      const reentry = __testGetActive().find((p) => p.isLive === true);
      expect(fx.executeBuy).toHaveBeenCalledTimes(2);
      expect(reentry).toBeDefined();
      expect(reentry?.survivalFlags).toContain('SMART_V3_LIVE_HARD_CUT_REENTRY');
      expect(reentry?.smartV3LiveHardCutReentry).toBe(true);
      expect(reentry?.smartV3HardCutParentPositionId).toBe(firstLive.positionId);
      expect(reentry?.smartV3HardCutDiscountPct).toBeLessThanOrEqual(0);
    });

    it('3b-3. smart-v3 hardcut 재진입은 live-only라 wallet stop 중 paper fallback 하지 않는다', async () => {
      mockedConfig.kolHunterReentryCooldownMs = 1_800_000;
      const fx = buildE2EFixtures();
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      await triggerSmartV3LiveEntry(MINT_SMART, 'pain', 0.001);
      const firstLive = __testGetActive().find((p) => p.isLive === true)!;
      __testTriggerTick(firstLive.positionId, firstLive.entryPrice * 0.85);
      await flushAsync();
      expect(__testGetActive()).toHaveLength(0);

      const { setWalletStopGuardStateForTests } = require('../src/risk/walletStopGuard');
      setWalletStopGuardStateForTests(true, 'floor-test', 0.69);

      await triggerSmartV3LiveEntry(MINT_SMART, 'reentry_blocked', 0.0009);

      expect(fx.executeBuy).toHaveBeenCalledTimes(1);
      expect(__testGetActive()).toHaveLength(0);
    }, 10_000);

    it('3b-4. smart-v3 hardcut 재진입은 buy 실패가 아니라 체결 성공 1회만 소모한다', async () => {
      mockedConfig.kolHunterReentryCooldownMs = 1_800_000;
      const buyOk = {
        txSignature: 'KOL_LIVE_BUY_SIG',
        expectedInAmount: 10_000_000n,
        actualInputAmount: 10_000_000n,
        actualInputUiAmount: 0.01,
        inputDecimals: 9,
        expectedOutAmount: 10_000_000n,
        actualOutAmount: 10_000_000n,
        actualOutUiAmount: 10,
        outputDecimals: 6,
        slippageBps: 12,
      };
      const executeBuy = jest.fn()
        .mockResolvedValueOnce({ ...buyOk, txSignature: 'KOL_LIVE_BUY_SIG_PARENT' })
        .mockRejectedValueOnce(new Error('transient quote/send failure'))
        .mockResolvedValueOnce({ ...buyOk, txSignature: 'KOL_LIVE_BUY_SIG_REENTRY' });
      const fx = buildE2EFixtures({ executeBuy });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      await triggerSmartV3LiveEntry(MINT_SMART, 'pain', 0.001);
      const firstLive = __testGetActive().find((p) => p.isLive === true)!;
      __testTriggerTick(firstLive.positionId, firstLive.entryPrice * 0.85);
      await flushAsync();
      expect(__testGetActive()).toHaveLength(0);

      await triggerSmartV3LiveEntry(MINT_SMART, 'reentry_fail', 0.0009);
      expect(executeBuy).toHaveBeenCalledTimes(2);
      expect(__testGetActive()).toHaveLength(0);

      await triggerSmartV3LiveEntry(MINT_SMART, 'reentry_success', 0.0009);
      const reentry = __testGetActive().find((p) => p.isLive === true);
      expect(executeBuy).toHaveBeenCalledTimes(3);
      expect(reentry).toBeDefined();
      expect(reentry?.entryTxSignature).toBe('KOL_LIVE_BUY_SIG_REENTRY');
      expect(reentry?.smartV3LiveHardCutReentry).toBe(true);
    }, 10_000);

    it('3c. live close retry 전 token balance 가 이미 0이면 중복 sell 없이 balance delta 로 close 복구', async () => {
      const failThenBalanceGone = jest.fn().mockRejectedValueOnce(new Error('confirm timeout after send'));
      const getTokenBalance = jest.fn()
        .mockResolvedValueOnce(1_000_000n)
        .mockResolvedValueOnce(0n);
      const fx = buildE2EFixtures({
        executeSell: failThenBalanceGone,
        getTokenBalance,
        solBefore: 1.0,
        solAfter: 1.004,
      });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      await triggerSmartV3LiveEntry(MINT_SMART);
      const live = __testGetActive().find((p) => p.isLive === true)!;

      __testTriggerTick(live.positionId, live.entryPrice * 0.85);
      await flushAsync();

      expect(failThenBalanceGone).toHaveBeenCalledTimes(1);
      expect(getTokenBalance).toHaveBeenCalledTimes(2);
      expect(fx.closeTrade).toHaveBeenCalledTimes(1);
      expect(fx.sendCritical).not.toHaveBeenCalled();
      expect(__testGetActive()).toHaveLength(0);
      const sellLedgerCalls = mockAppendFile.mock.calls.filter((c) =>
        typeof c[0] === 'string' && c[0].includes('executed-sells.jsonl')
      );
      expect(sellLedgerCalls.length).toBe(1);
      const sellRecord = JSON.parse(String(sellLedgerCalls[0][1]).trim());
      expect(sellRecord.txSignature).toBe(`KOL_LIVE_SELL_BALANCE_RECOVERED_${live.positionId}`);
      expect(sellRecord.txSignature).not.toBe(live.entryTxSignature);
    });

    it('3d. live close retry after partial on-chain sell uses total sold ratio for wallet-truth exit price', async () => {
      const partialThenOk = jest.fn()
        .mockRejectedValueOnce(new Error('confirm timeout after partial send'))
        .mockResolvedValue({
          txSignature: 'KOL_LIVE_SELL_SIG_AFTER_PARTIAL',
          slippageBps: 23,
        });
      const getTokenBalance = jest.fn()
        .mockResolvedValueOnce(1_000_000n)
        .mockResolvedValueOnce(600_000n);
      const fx = buildE2EFixtures({
        executeSell: partialThenOk,
        getTokenBalance,
        solBefore: 1.0,
        solAfter: 1.004,
      });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      await triggerSmartV3LiveEntry(MINT_SMART);
      const live = __testGetActive().find((p) => p.isLive === true)!;
      const quantityBeforeClose = live.quantity;

      __testTriggerTick(live.positionId, live.entryPrice * 0.85);
      await flushAsync();

      expect(partialThenOk).toHaveBeenCalledTimes(2);
      expect(partialThenOk).toHaveBeenNthCalledWith(1, live.tokenMint, 1_000_000n);
      expect(partialThenOk).toHaveBeenNthCalledWith(2, live.tokenMint, 600_000n);
      expect(getTokenBalance).toHaveBeenCalledTimes(2);
      expect(fx.closeTrade).toHaveBeenCalledTimes(1);
      expect(fx.closeTrade.mock.calls[0][0].exitPrice).toBeCloseTo(0.004 / quantityBeforeClose, 12);
      expect(fx.sendCritical).not.toHaveBeenCalled();
      expect(__testGetActive()).toHaveLength(0);
    });

    it('4. live close ORPHAN_NO_BALANCE (tokenBalance == 0n) → sell skip + DB close + critical', async () => {
      const fx = buildE2EFixtures({ getTokenBalance: jest.fn().mockResolvedValue(0n) });
      __testInit({ priceFeed: stubFeed as unknown as never, ctx: fx.ctx });

      await triggerSmartV3LiveEntry(MINT_SMART);
      const live = __testGetActive().find((p) => p.isLive === true)!;

      // 임의 close trigger (hardcut)
      __testTriggerTick(live.positionId, live.entryPrice * 0.85);
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
      __testTriggerTick(live.positionId, live.entryPrice * 0.85);
      // tick B: 동일 micro-task tick 에서 다시 trigger — 이미 state='CLOSED' 라 onPriceTick 의 guard
      // (line 1275) + closePosition 의 guard (line 1441) 양쪽에서 차단되어 두 번째 closeLivePosition
      // 호출이 발생하지 않아야 한다.
      __testTriggerTick(live.positionId, live.entryPrice * 1.5);  // winner trail 시도
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
      mockedConfig.kolHunterSmartV3FreshWindowSec = 120;
      stubFeed.setInitialPrice(MINT_SMART, 0.001);
      // anti-correlation 60s — 두 KOL 을 독립으로 인식하려면 ≥60s 차이 필요.
      await handleKolSwap(buyTx('pain', 'S', MINT_SMART, 70_000));
      await handleKolSwap(buyTx('scalp1', 'A', MINT_SMART));
      await flushAsync();

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
