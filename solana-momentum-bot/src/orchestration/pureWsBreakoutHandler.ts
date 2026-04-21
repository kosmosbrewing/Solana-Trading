/**
 * Pure WS Breakout Lane Handler (Block 3, 2026-04-18)
 *
 * Why: Mission pivot convexity — cupsey benchmark 를 건드리지 않고 별도 lane 으로
 * convexity 지향 entry/exit 구조를 paper 부터 실험한다.
 * 설계: docs/design-docs/pure-ws-breakout-lane-2026-04-18.md
 *
 * State machine:
 *   [signal] → loose gate → immediate PROBE buy
 *   [PROBE]      30s window, trail 3%, hardcut -3%, flat timeout
 *     → MFE ≥ +100% → [RUNNER_T1]
 *     → MAE ≤ -3% → close LOSER_HARDCUT
 *     → 30s flat → close LOSER_TIMEOUT
 *     → trail stop → close PROBE_TRAIL
 *   [RUNNER_T1]  2x-5x, trail 7%
 *     → MFE ≥ +400% → [RUNNER_T2]
 *     → trail stop → close T1_TRAIL
 *   [RUNNER_T2]  5x-10x, trail 15%, lock = entry×3 (never close below 3x)
 *     → MFE ≥ +900% → [RUNNER_T3]
 *     → trail stop → close T2_TRAIL
 *   [RUNNER_T3]  10x+, trail 25%, no time stop
 *     → trail stop → close T3_TRAIL
 *
 * Shared guards (설계 문서 #3.2):
 *   - Wallet Stop Guard
 *   - entryIntegrity('pure_ws_breakout')
 *   - swapSerializer shared close mutex
 *   - HWM peak sanity (pureWsMaxPeakMultiplier)
 *
 * NOT a copy of cupseyLaneHandler — independent state machine with different exit philosophy.
 */
import { createModuleLogger } from '../utils/logger';
import { Order, Signal, Trade, CloseReason } from '../utils/types';
import { config } from '../utils/config';
import { MicroCandleBuilder } from '../realtime';
import { evaluateCupseySignalGate, CupseySignalGateConfig } from '../strategy/cupseySignalGate';
import { evaluateWsBurst } from '../strategy/wsBurstDetector';
import type { WsBurstDetectorConfig } from '../strategy/wsBurstDetector';
import { checkProbeViabilityFloor } from '../gate/probeViabilityFloor';
import { evaluateEntryDriftGuard } from '../gate/entryDriftGuard';
import { evaluateSellQuoteProbe } from '../gate/sellQuoteProbe';
import { evaluateSecurityGate } from '../gate/securityGate';
import { remainingDailyBudget, reportBleed } from '../risk/dailyBleedBudget';
import { getWalletStopGuardState } from '../risk/walletStopGuard';
import { evaluateQuickReject } from '../risk/quickRejectClassifier';
import { evaluateHoldPhaseSentinel } from '../risk/holdPhaseSentinel';
import { BotContext } from './types';
import { bpsToDecimal } from '../utils/units';
import { isWalletStopActive } from '../risk/walletStopGuard';
import { serializeClose } from './swapSerializer';
import { resolveActualEntryMetrics } from './signalProcessor';
import {
  persistOpenTradeWithIntegrity,
  appendEntryLedger,
  isEntryHaltActive,
} from './entryIntegrity';
import { reportCanaryClose } from '../risk/canaryAutoHalt';
import { acquireCanarySlot, releaseCanarySlot } from '../risk/canaryConcurrencyGuard';

const log = createModuleLogger('PureWsBreakout');
const LANE_STRATEGY: 'pure_ws_breakout' = 'pure_ws_breakout';

// ─── State Machine ───

type PureWsTradeState = 'PROBE' | 'RUNNER_T1' | 'RUNNER_T2' | 'RUNNER_T3' | 'CLOSED';

interface PureWsPosition {
  tradeId: string;                // in-memory positionId
  dbTradeId?: string;
  pairAddress: string;
  /** Jupiter fill 가격 — pnl 계산 기준 (실제 지출 / 수령 토큰). */
  entryPrice: number;
  /**
   * 2026-04-19: Signal price (WS feed) — MAE/MFE hard-cut 판정 기준.
   * Why: Jupiter fill 이 signal 대비 +20-50% 드리프트 되는 경우 (Token-2022 / low-liq route)
   * entry 기준 MAE 는 시장이 수평인데도 -20% 로 찍혀 즉시 hardcut → bad fill 을 rug 로 오인.
   * market reference 기준 MAE/MFE 는 실제 가격 움직임만 측정.
   */
  marketReferencePrice: number;
  entryTimeSec: number;
  quantity: number;
  state: PureWsTradeState;
  peakPrice: number;
  troughPrice: number;
  tokenSymbol?: string;
  sourceLabel?: string;
  discoverySource?: string;
  plannedEntryPrice?: number;
  entryTxSignature?: string;
  entrySlippageBps?: number;
  lastCloseFailureAtSec?: number;
  /** T2 도달 시 캐시 — 이후 close 하한선 (never close below entry × breakeven_lock) */
  t2BreakevenLockPrice?: number;
  /** Phase 3 snapshot — entry 시점 microstructure (quickReject / holdPhase 분석용) */
  buyRatioAtEntry?: number;
  txCountAtEntry?: number;
}

const activePositions = new Map<string, PureWsPosition>();

export function getActivePureWsPositions(): ReadonlyMap<string, PureWsPosition> {
  return activePositions;
}

// ─── Funnel Stats ───

interface PureWsFunnelStats {
  signalsReceived: number;
  gatePass: number;
  entry: number;
  txSuccess: number;
  dbPersisted: number;
  notifierOpenSent: number;
  closedTrades: number;
  winnersT1: number;
  winnersT2: number;
  winnersT3: number;
  sessionStartAt: Date;
}
const funnelStats: PureWsFunnelStats = {
  signalsReceived: 0, gatePass: 0, entry: 0,
  txSuccess: 0, dbPersisted: 0, notifierOpenSent: 0, closedTrades: 0,
  winnersT1: 0, winnersT2: 0, winnersT3: 0,
  sessionStartAt: new Date(),
};
export function getPureWsFunnelStats(): Readonly<PureWsFunnelStats> {
  return funnelStats;
}

// ─── Wallet Mode Resolution ───

function getPureWsExecutor(ctx: BotContext) {
  const mode = config.pureWsLaneWalletMode;
  if (mode === 'main') return ctx.executor;
  if (mode === 'sandbox') {
    if (!ctx.sandboxExecutor) {
      throw new Error(
        `PUREWS_WALLET_MODE=sandbox but sandboxExecutor not initialized. ` +
        `Check SANDBOX_WALLET_PRIVATE_KEY and STRATEGY_D_LIVE_ENABLED.`
      );
    }
    return ctx.sandboxExecutor;
  }
  return ctx.sandboxExecutor ?? ctx.executor;
}

export function resolvePureWsWalletLabel(ctx: BotContext): 'main' | 'sandbox' {
  const mode = config.pureWsLaneWalletMode;
  if (mode === 'main') return 'main';
  if (mode === 'sandbox') return 'sandbox';
  return ctx.sandboxExecutor ? 'sandbox' : 'main';
}

// ─── Test Helpers ───

// ─── V2 Detector per-pair cooldown (Phase 1.3) ───
// Why: paper replay 에서 Top pair (pippin 164 pass / 32k eval) 쏠림 관측. 같은 pair 에 연속 burst 진입 방지.
const v2LastTriggerSecByPair = new Map<string, number>();

// 2026-04-21 P1: v1 (bootstrap) 경로 per-pair cooldown.
// Why: VPS 4/20-21 관측 — bootstrap_10s 가 BOME(ukHH6c7m) 한 토큰에 반복 signal → duplicate
// guard 는 "이미 holding" 상태만 차단하므로 close 직후 재signal 이 들어오면 또 진입 →
// 4 consecutive losers → canary halt 조기 유발. v2 와 동일 메커니즘으로 close 이후에도
// pair-level cooldown 적용하여 pair diversity 확보.
const v1LastEntrySecByPair = new Map<string, number>();

// 2026-04-21 P0 (observability): v2 scanner 가 production 에서 24h 동안 PASS 0건 관측됨.
// reject 는 log.debug 라 INFO 레벨 운영 로그에 안 찍혀 진단 불가.
// counter 기반 누적 telemetry 를 주기적으로 info log 출력 — threshold 튜닝 근거 확보.
interface PureWsV2TelemetryState {
  scansCalled: number;
  pairsEvaluated: number;
  candlesInsufficient: number;
  detectorRejects: Record<string, number>;
  noCurrentPrice: number;
  cooldownSkipped: number;
  haltSkipped: number;
  passed: number;
  sessionStartMs: number;
}

const v2Telemetry: PureWsV2TelemetryState = {
  scansCalled: 0,
  pairsEvaluated: 0,
  candlesInsufficient: 0,
  detectorRejects: {},
  noCurrentPrice: 0,
  cooldownSkipped: 0,
  haltSkipped: 0,
  passed: 0,
  sessionStartMs: Date.now(),
};

export function getPureWsV2Telemetry(): Readonly<PureWsV2TelemetryState> {
  return v2Telemetry;
}

export function resetPureWsV2TelemetryForTests(): void {
  v2Telemetry.scansCalled = 0;
  v2Telemetry.pairsEvaluated = 0;
  v2Telemetry.candlesInsufficient = 0;
  v2Telemetry.detectorRejects = {};
  v2Telemetry.noCurrentPrice = 0;
  v2Telemetry.cooldownSkipped = 0;
  v2Telemetry.haltSkipped = 0;
  v2Telemetry.passed = 0;
  v2Telemetry.sessionStartMs = Date.now();
}

/**
 * 주기적으로 (caller: HealthMonitor tick) 호출되어 v2 scan 누적 통계를 info 로그로 출력.
 * counter 는 reset 하지 않고 누적 유지 — 운영자가 lifetime 추이도 관찰 가능.
 * detectorRejects 는 top 3 reason 만 inline 으로, 나머지는 'other' 로 집계.
 */
export function logPureWsV2TelemetrySummary(): void {
  if (!config.pureWsLaneEnabled || !config.pureWsV2Enabled) return;
  const t = v2Telemetry;
  const rejectEntries = Object.entries(t.detectorRejects).sort((a, b) => b[1] - a[1]);
  const top3 = rejectEntries.slice(0, 3).map(([k, v]) => `${k}=${v}`).join(',');
  const rest = rejectEntries.slice(3).reduce((sum, [, v]) => sum + v, 0);
  const rejectSummary = top3 + (rest > 0 ? `,other=${rest}` : '');
  const uptimeMin = Math.round((Date.now() - t.sessionStartMs) / 60000);
  log.info(
    `[PUREWS_V2_SUMMARY] uptime=${uptimeMin}m scans=${t.scansCalled} ` +
    `eval=${t.pairsEvaluated} insuf=${t.candlesInsufficient} ` +
    `rejects=[${rejectSummary || 'none'}] noPrice=${t.noCurrentPrice} ` +
    `cooldown=${t.cooldownSkipped} halt=${t.haltSkipped} PASS=${t.passed}`
  );
}

export function resetPureWsLaneStateForTests(): void {
  activePositions.clear();
  v2LastTriggerSecByPair.clear();
  v1LastEntrySecByPair.clear();
  funnelStats.signalsReceived = 0;
  funnelStats.gatePass = 0;
  funnelStats.entry = 0;
  funnelStats.txSuccess = 0;
  funnelStats.dbPersisted = 0;
  funnelStats.notifierOpenSent = 0;
  funnelStats.closedTrades = 0;
  funnelStats.winnersT1 = 0;
  funnelStats.winnersT2 = 0;
  funnelStats.winnersT3 = 0;
  funnelStats.sessionStartAt = new Date();
}

/**
 * 2026-04-21 Survival Layer (P0 mission-refinement-2026-04-21):
 * pure_ws 진입 전 security + exit liquidity 체크.
 *
 * 반환 형태는 evaluateSecurityGate 와 유사하지만 sizing multiplier 는 제거 (pure_ws fixed ticket).
 * gateCache 재사용 — bootstrap path 에서 이미 populate 된 pair 는 즉시 hit.
 *
 * 데이터 resolve 실패 (RPC 간헐 / onchainSecurityClient 미구성) 시 config 로 제어:
 *  - `pureWsSurvivalAllowDataMissing=true`  → 진입 허용 (observability flag `NO_SECURITY_DATA`)
 *  - `pureWsSurvivalAllowDataMissing=false` → 보수적 reject
 */
async function checkPureWsSurvival(
  tokenMint: string,
  ctx: BotContext
): Promise<{ approved: boolean; reason?: string; flags: string[] }> {
  // 1) gateCache hit: bootstrap path 에서 populate 된 data 재사용
  const cached = ctx.gateCache?.get(tokenMint);
  let tokenSecurityData = cached?.tokenSecurityData ?? null;
  let exitLiquidityData = cached?.exitLiquidityData ?? null;

  // 2) cache miss — onchainSecurityClient 직접 조회
  if (!cached && ctx.onchainSecurityClient) {
    try {
      const [secData, exitData] = await Promise.all([
        ctx.onchainSecurityClient.getTokenSecurityDetailed(tokenMint),
        ctx.onchainSecurityClient.getExitLiquidity(tokenMint),
      ]);
      tokenSecurityData = secData;
      exitLiquidityData = exitData;
      // cache populate 하여 같은 signal 반복 시 RPC 절약
      ctx.gateCache?.set(tokenMint, {
        tokenSecurityData: secData,
        exitLiquidityData: exitData,
      });
    } catch (err) {
      log.warn(`[PUREWS_SURVIVAL] ${tokenMint.slice(0, 12)} security fetch failed: ${err}`);
    }
  }

  // 3) 데이터 자체 없음 (client 미구성 or 조회 실패)
  if (!tokenSecurityData) {
    if (config.pureWsSurvivalAllowDataMissing) {
      return { approved: true, flags: ['NO_SECURITY_DATA'] };
    }
    return {
      approved: false,
      reason: 'security_data_unavailable',
      flags: ['NO_SECURITY_DATA'],
    };
  }

  // 4) evaluateSecurityGate 재사용 — 공유 로직 단일화.
  //    exit liquidity 값은 null 이어도 gate 가 soft handling (reduced sizing).
  //    pure_ws 는 fixed ticket 이므로 sizing 은 무시, approved flag 만 본다.
  const gateResult = evaluateSecurityGate(tokenSecurityData, exitLiquidityData, {
    minExitLiquidityUsd: config.pureWsSurvivalMinExitLiquidityUsd,
    maxTop10HolderPct: config.pureWsSurvivalMaxTop10HolderPct,
    // pure_ws 는 mintable reject 유지 (allowMintableWithReduction=false default).
  });

  return {
    approved: gateResult.approved,
    reason: gateResult.reason,
    flags: gateResult.flags,
  };
}

function buildV2DetectorConfig(): WsBurstDetectorConfig {
  return {
    enabled: true,
    nRecent: config.pureWsV2NRecent,
    nBaseline: config.pureWsV2NBaseline,
    minPassScore: config.pureWsV2MinPassScore,
    wVolume: config.pureWsV2WVolume,
    wBuy: config.pureWsV2WBuy,
    wDensity: config.pureWsV2WDensity,
    wPrice: config.pureWsV2WPrice,
    wReverse: config.pureWsV2WReverse,
    floorVol: config.pureWsV2FloorVol,
    floorBuy: config.pureWsV2FloorBuy,
    floorTx: config.pureWsV2FloorTx,
    floorPrice: config.pureWsV2FloorPrice,
    buyRatioAbsoluteFloor: config.pureWsV2BuyRatioAbsFloor,
    txCountAbsoluteFloor: config.pureWsV2TxCountAbsFloor,
    zVolSaturate: config.pureWsV2ZVolSaturate,
    zBuySaturate: config.pureWsV2ZBuySaturate,
    zTxSaturate: config.pureWsV2ZTxSaturate,
    bpsPriceSaturate: config.pureWsV2BpsPriceSaturate,
  };
}

export function addPureWsPositionForTests(pos: PureWsPosition): void {
  activePositions.set(pos.tradeId, pos);
}

// ─── Signal Handler — Immediate PROBE ───

export async function handlePureWsSignal(
  signal: Signal,
  candleBuilder: MicroCandleBuilder,
  ctx: BotContext
): Promise<void> {
  if (!config.pureWsLaneEnabled) return;

  funnelStats.signalsReceived++;

  // Hard guards
  if (isEntryHaltActive(LANE_STRATEGY)) {
    log.warn('[PUREWS_ENTRY_HALT] signal ignored — integrity halt active');
    return;
  }
  if (isWalletStopActive()) {
    log.debug('[PUREWS_WALLET_STOP] signal ignored — wallet balance below threshold');
    return;
  }

  // Duplicate guard (same pair already held)
  for (const pos of activePositions.values()) {
    if (pos.pairAddress === signal.pairAddress && pos.state !== 'CLOSED') {
      log.debug(`[PUREWS_SKIP] already holding ${signal.pairAddress.slice(0, 12)}`);
      return;
    }
  }

  // 2026-04-21 P1: v1 (bootstrap) 경로 per-pair cooldown.
  // v2 sourced signal (ws_burst_v2) 은 scanner 가 cooldown 관리하므로 여기선 v1 만 적용.
  // BOME 같이 같은 pair 반복 진입 → consecutive losers 누적 → canary halt 조기 유발.
  if (signal.sourceLabel !== 'ws_burst_v2') {
    const nowSecForCooldown = Math.floor(Date.now() / 1000);
    const lastEntrySec = v1LastEntrySecByPair.get(signal.pairAddress) ?? 0;
    const cooldown = config.pureWsV1PerPairCooldownSec;
    if (nowSecForCooldown - lastEntrySec < cooldown) {
      const remaining = cooldown - (nowSecForCooldown - lastEntrySec);
      log.debug(
        `[PUREWS_V1_COOLDOWN] ${signal.pairAddress.slice(0, 12)} active ` +
        `(${remaining}s remaining, cooldown=${cooldown}s)`
      );
      return;
    }
  }

  // Concurrency cap — lane-level
  const activeCount = [...activePositions.values()].filter((p) => p.state !== 'CLOSED').length;
  if (activeCount >= config.pureWsMaxConcurrent) {
    log.debug(`[PUREWS_SKIP] lane max concurrent (${activeCount})`);
    return;
  }

  // V2 detector-sourced signal 은 v1 gate 재평가 skip (factor set 다름 → double-reject 방지).
  const skipV1Gate = signal.sourceLabel === 'ws_burst_v2';

  // Loose signal gate (factor set reuse, threshold 완화)
  if (config.pureWsGateEnabled && !skipV1Gate) {
    const recentCandles = candleBuilder.getRecentCandles(
      signal.pairAddress,
      config.realtimePrimaryIntervalSec,
      config.pureWsGateLookbackBars
    );
    const gateCfg: CupseySignalGateConfig = {
      enabled: true,
      minVolumeAccelRatio: config.pureWsGateMinVolumeAccelRatio,
      minPriceChangePct: config.pureWsGateMinPriceChangePct,
      minAvgBuyRatio: config.pureWsGateMinAvgBuyRatio,
      minTradeCountRatio: config.pureWsGateMinTradeCountRatio,
      lookbackBars: config.pureWsGateLookbackBars,
      recentBars: config.pureWsGateRecentBars,
    };
    const gateResult = evaluateCupseySignalGate(recentCandles, gateCfg);
    if (!gateResult.pass) {
      log.debug(
        `[PUREWS_GATE_REJECT] ${signal.pairAddress.slice(0, 12)} ` +
        `reason=${gateResult.rejectReason} score=${gateResult.score}`
      );
      return;
    }
    funnelStats.gatePass++;
  }

  const ticketSol = config.pureWsLaneTicketSol;
  const quantity = signal.price > 0 ? ticketSol / signal.price : 0;
  if (quantity <= 0) return;

  // 2026-04-21 Survival Layer (P0 mission-refinement): rug / honeypot / Token-2022 dangerous ext /
  // top-holder / exit liquidity 검사. 이전까지 pure_ws 는 securityGate 를 우회 중이어서
  // 위험 token (Token-2022 transferHook, 80%+ holder concentration 등) 도 무비판적 진입.
  //
  // 설계:
  //  - gateCache 재사용 (bootstrap candleHandler 와 공유)
  //  - 데이터 resolve 실패 시 config 로 제어 (allow/reject)
  //  - sizing multiplier 는 무시 (pure_ws 는 fixed ticket 정책)
  //  - paper 모드도 동일하게 체크 (관측 data 정합성 유지)
  if (config.pureWsSurvivalCheckEnabled) {
    const survival = await checkPureWsSurvival(signal.pairAddress, ctx);
    if (!survival.approved) {
      log.info(
        `[PUREWS_SURVIVAL_REJECT] ${signal.pairAddress.slice(0, 12)} ` +
        `reason=${survival.reason ?? 'unknown'} flags=[${survival.flags.join(',')}]`
      );
      return;
    }
    if (survival.flags.length > 0) {
      log.debug(
        `[PUREWS_SURVIVAL_PASS] ${signal.pairAddress.slice(0, 12)} flags=[${survival.flags.join(',')}]`
      );
    }
  }

  // DEX_TRADE Phase 2: Probe Viability Floor + Daily Bleed Budget
  // Why: RR gate retire 이후 최소 viability 체크. bleed budget 으로 시도 수 통제.
  if (config.probeViabilityFloorEnabled) {
    const walletState = getWalletStopGuardState();
    const walletBaselineSol = walletState.lastBalanceSol > 0 && Number.isFinite(walletState.lastBalanceSol)
      ? walletState.lastBalanceSol
      : config.walletStopMinSol + 0.01;  // fallback — near halt threshold (보수적)
    const budgetCfg = {
      alpha: config.dailyBleedAlpha,
      minCapSol: config.dailyBleedMinCapSol,
      maxCapSol: config.dailyBleedMaxCapSol,
    };
    const remainingBudget = config.dailyBleedBudgetEnabled
      ? remainingDailyBudget(walletBaselineSol, budgetCfg)
      : Number.POSITIVE_INFINITY;
    const viability = checkProbeViabilityFloor(
      {
        venue: undefined,  // Phase 2 초기 — venue resolver 미구현, unknown fallback 사용
        ticketSol,
      },
      {
        minTicketSol: config.probeViabilityMinTicketSol,
        maxBleedPct: config.probeViabilityMaxBleedPct,
        maxSellImpactPct: config.probeViabilityMaxSellImpactPct,
        remainingDailyBudgetSol: remainingBudget,
      }
    );
    if (!viability.allow) {
      log.info(
        `[PUREWS_VIABILITY_REJECT] ${signal.pairAddress.slice(0, 12)} reason=${viability.reason} ` +
        `bleed=${viability.bleed.totalSol.toFixed(6)}SOL (${(viability.bleed.totalPct * 100).toFixed(2)}%) ` +
        `budget=${remainingBudget.toFixed(6)}SOL`
      );
      return;
    }
  }

  // 2026-04-19: Entry drift guard — Jupiter probe quote 로 expected fill price 를
  // 미리 계산, signal price 와 drift 가 maxEntryDriftPct 초과면 entry 차단.
  // Why: 2026-04-18 관측 4 trades 전부 +20~51% fill drift → 체결 즉시 MAE −20% → hard cut
  // → canary halt. market-ref MAE 로 전환해도 "실제 지출 대비 pnl" 은 항상 음수 시작이므로
  // bad fill 자체를 차단해야 convexity 목표 부합.
  // quote 실패 / decimals 미확인은 gate 통과 (observability only).
  //
  // 2026-04-19 (QA Q1): Jupiter API response 에 outputDecimals 없음 → executor.getMintDecimals
  // 로 사전 해결해서 hint 전달해야 guard 가 실질 동작. cache 내부 적용 — 반복 호출 시 0 RPC.
  if (config.pureWsEntryDriftGuardEnabled && ctx.tradingMode === 'live') {
    const probeSolAmount = ticketSol;
    let tokenDecimals: number | undefined;
    try {
      const buyExecutor = getPureWsExecutor(ctx);
      tokenDecimals = await buyExecutor.getMintDecimals(signal.pairAddress);
    } catch (err) {
      log.debug(`[PUREWS_ENTRY_DRIFT] ${signal.pairAddress.slice(0, 12)} decimals resolve failed: ${err}`);
    }
    const driftResult = await evaluateEntryDriftGuard(
      {
        tokenMint: signal.pairAddress,
        signalPrice: signal.price,
        probeSolAmount,
        tokenDecimals,
      },
      {
        jupiterApiUrl: config.jupiterApiUrl,
        jupiterApiKey: config.jupiterApiKey,
        maxDriftPct: config.pureWsMaxEntryDriftPct,
      }
    );
    if (driftResult.routeFound && !driftResult.quoteFailed) {
      log.info(
        `[PUREWS_ENTRY_DRIFT] ${signal.pairAddress.slice(0, 12)} ` +
        `signal=${driftResult.signalPrice.toFixed(8)} ` +
        `expectedFill=${(driftResult.expectedFillPrice ?? 0).toFixed(8)} ` +
        `drift=${(driftResult.observedDriftPct * 100).toFixed(2)}%`
      );
    }
    if (!driftResult.approved) {
      log.info(
        `[PUREWS_ENTRY_DRIFT_REJECT] ${signal.pairAddress.slice(0, 12)} ${driftResult.reason ?? 'drift'}`
      );
      return;
    }
  }

  // 2026-04-21 Survival Layer Tier B-1: Active Sell Quote Probe (exitability).
  // Jupiter 에 tokenMint→SOL quote 요청 → "팔릴 수 있는가" 직접 검증.
  // securityGate 는 static properties (freeze/mint authority, Token-2022 ext) 만 보고,
  // entryDriftGuard 는 buy fill 정합성만 본다. "honeypot by liquidity" (route 없음 /
  // sell impact 폭증) 는 오직 sell quote 로만 드러남.
  //
  // quote 실패는 entry 차단 금지 (observability only) — false positive 비용 ↑.
  // no_sell_route 는 진입 차단 — honeypot 신호.
  if (config.pureWsSellQuoteProbeEnabled && ctx.tradingMode === 'live') {
    try {
      const buyExecutor = getPureWsExecutor(ctx);
      const tokenDecimals = await buyExecutor.getMintDecimals(signal.pairAddress);
      if (tokenDecimals != null && tokenDecimals >= 0 && tokenDecimals <= 18) {
        // probeTokenAmountRaw = 예상 받을 토큰 수 (raw).
        // quantity (UI amount) × 10^decimals 로 raw 변환.
        const probeTokenAmountRaw = BigInt(
          Math.floor(quantity * Math.pow(10, tokenDecimals))
        );
        if (probeTokenAmountRaw > 0n) {
          const sellProbe = await evaluateSellQuoteProbe(
            {
              tokenMint: signal.pairAddress,
              probeTokenAmountRaw,
              expectedSolReceive: ticketSol,
              tokenDecimals,
            },
            {
              jupiterApiUrl: config.jupiterApiUrl,
              jupiterApiKey: config.jupiterApiKey,
              maxImpactPct: config.pureWsSellQuoteMaxImpactPct,
              minRoundTripPct: config.pureWsSellQuoteMinRoundTripPct,
            }
          );
          if (sellProbe.routeFound && !sellProbe.quoteFailed) {
            log.info(
              `[PUREWS_SELL_PROBE] ${signal.pairAddress.slice(0, 12)} ` +
              `outSol=${sellProbe.observedOutSol.toFixed(6)} ` +
              `impact=${(sellProbe.observedImpactPct * 100).toFixed(2)}% ` +
              `roundTrip=${isFinite(sellProbe.roundTripPct) ? (sellProbe.roundTripPct * 100).toFixed(1) + '%' : 'n/a'}`
            );
          }
          if (!sellProbe.approved) {
            log.info(
              `[PUREWS_SELL_PROBE_REJECT] ${signal.pairAddress.slice(0, 12)} ${sellProbe.reason ?? 'sell_probe'}`
            );
            return;
          }
        }
      }
    } catch (err) {
      log.debug(`[PUREWS_SELL_PROBE] ${signal.pairAddress.slice(0, 12)} probe skipped: ${err}`);
      // skip → 진입 계속 (observability only)
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const positionId = `purews-${signal.pairAddress.slice(0, 8)}-${nowSec}`;

  // ─── Immediate PROBE entry (NO STALK) ───
  let actualEntryPrice = signal.price;
  let actualQuantity = quantity;
  let entryTxSignature = 'PAPER_TRADE';
  let entrySlippageBps = 0;

  if (ctx.tradingMode === 'live') {
    // Block 3 paper-first enforcement (2026-04-18 QA fix):
    // PUREWS_LANE_ENABLED=true + TRADING_MODE=live 만으로는 live buy 금지.
    // 운영자가 paper 관측 후 PUREWS_LIVE_CANARY_ENABLED=true 로 명시 opt-in 해야 함.
    if (!config.pureWsLiveCanaryEnabled) {
      log.info(
        `[PUREWS_PAPER_FIRST] ${positionId} live buy suppressed — PUREWS_LIVE_CANARY_ENABLED=false. ` +
        `signal observed, no tx submitted. signal_price=${signal.price.toFixed(8)}`
      );
      return;
    }
  }

  // Block 4 QA fix: wallet-level 전역 canary concurrency guard (opt-in).
  // lane 별 cap 보다 엄격할 수 있음 — gate + paper-first pass 이후 시점에서 acquire.
  // 어느 실패 경로에서도 누수 방지를 위해 release 를 반드시 대응하여 호출한다.
  if (!acquireCanarySlot(LANE_STRATEGY)) {
    log.debug(`[PUREWS_SKIP] global canary slot full`);
    return;
  }

  if (ctx.tradingMode === 'live') {
    try {
      const buyExecutor = getPureWsExecutor(ctx);
      const order: Order = {
        pairAddress: signal.pairAddress,
        strategy: LANE_STRATEGY,
        side: 'BUY',
        price: signal.price,
        quantity,
        stopLoss: signal.price * (1 - config.pureWsProbeHardCutPct),
        takeProfit1: signal.price * (1 + config.pureWsT1MfeThreshold),
        takeProfit2: signal.price * (1 + config.pureWsT2MfeThreshold),
        timeStopMinutes: Math.ceil(config.pureWsProbeWindowSec / 60),
      };
      const buyResult = await buyExecutor.executeBuy(order);
      // 2026-04-18 drift fix: all-or-nothing guard (same root cause as cupsey/migration).
      const metrics = resolveActualEntryMetrics(order, buyResult);
      actualEntryPrice = metrics.entryPrice;
      actualQuantity = metrics.quantity;
      entryTxSignature = buyResult.txSignature;
      entrySlippageBps = buyResult.slippageBps;
      log.info(
        `[PUREWS_LIVE_BUY] ${positionId} immediate PROBE sig=${entryTxSignature.slice(0, 12)} ` +
        `slip=${entrySlippageBps}bps`
      );
      funnelStats.txSuccess++;
    } catch (buyErr) {
      log.warn(`[PUREWS_LIVE_BUY] ${positionId} buy failed: ${buyErr}`);
      releaseCanarySlot(LANE_STRATEGY); // QA fix — 누수 방지
      return;
    }
  }

  funnelStats.entry++;

  // DB persist with integrity halt protection
  const persistResult = await persistOpenTradeWithIntegrity({
    ctx,
    lane: LANE_STRATEGY,
    tradeData: {
      pairAddress: signal.pairAddress,
      strategy: LANE_STRATEGY,
      side: 'BUY',
      tokenSymbol: signal.tokenSymbol,
      sourceLabel: signal.sourceLabel,
      discoverySource: signal.discoverySource,
      entryPrice: actualEntryPrice,
      plannedEntryPrice: signal.price,
      quantity: actualQuantity,
      stopLoss: actualEntryPrice * (1 - config.pureWsProbeHardCutPct),
      takeProfit1: actualEntryPrice * (1 + config.pureWsT1MfeThreshold),
      takeProfit2: actualEntryPrice * (1 + config.pureWsT2MfeThreshold),
      trailingStop: undefined,
      highWaterMark: actualEntryPrice,
      timeStopAt: new Date((nowSec + config.pureWsProbeWindowSec) * 1000),
      status: 'OPEN',
      txSignature: entryTxSignature,
      createdAt: new Date(nowSec * 1000),
      entrySlippageBps,
    },
    ledgerEntry: {
      signalId: positionId,
      positionId,
      txSignature: entryTxSignature,
      strategy: LANE_STRATEGY,
      wallet: resolvePureWsWalletLabel(ctx), // Block 1 QA fix: wallet-aware comparator
      pairAddress: signal.pairAddress,
      tokenSymbol: signal.tokenSymbol,
      plannedEntryPrice: signal.price,
      actualEntryPrice,
      actualQuantity,
      slippageBps: entrySlippageBps,
      signalTimeSec: nowSec,
      signalPrice: signal.price,
    },
    notifierKey: 'purews_open_persist',
    buildNotifierMessage: (err) =>
      `${positionId} buy persisted FAILED after tx=${entryTxSignature}: ${err} — NEW POSITIONS HALTED.`,
  });

  // Phase 3: entry 시점 microstructure snapshot (quickReject/holdPhase 기준점)
  const entryCandles = candleBuilder.getRecentCandles(
    signal.pairAddress,
    config.realtimePrimaryIntervalSec,
    1
  );
  const entryCandle = entryCandles[entryCandles.length - 1];
  const entryBuyRatio = entryCandle
    ? (entryCandle.buyVolume + entryCandle.sellVolume > 0
      ? entryCandle.buyVolume / (entryCandle.buyVolume + entryCandle.sellVolume)
      : 0.5)
    : 0.5;
  const entryTxCount = entryCandle?.tradeCount ?? 0;

  // 2026-04-19: market reference = signal price (MAE/MFE hard-cut 기준).
  // peakPrice/troughPrice 도 signal price 로 초기화 — 첫 tick 에서 신호 가격 대비
  // 이동만 반영 (bad fill 의 entry-to-fill gap 은 배제).
  const marketReferencePrice = config.pureWsUseMarketReferencePrice
    ? signal.price
    : actualEntryPrice;

  const position: PureWsPosition = {
    tradeId: positionId,
    dbTradeId: persistResult.dbTradeId ?? undefined,
    pairAddress: signal.pairAddress,
    entryPrice: actualEntryPrice,
    marketReferencePrice,
    entryTimeSec: nowSec,
    quantity: actualQuantity,
    state: 'PROBE',
    peakPrice: marketReferencePrice,
    troughPrice: marketReferencePrice,
    tokenSymbol: signal.tokenSymbol,
    sourceLabel: signal.sourceLabel,
    discoverySource: signal.discoverySource,
    plannedEntryPrice: signal.price,
    entryTxSignature,
    entrySlippageBps,
    buyRatioAtEntry: entryBuyRatio,
    txCountAtEntry: entryTxCount,
  };

  if (persistResult.dbTradeId) {
    funnelStats.dbPersisted++;
    try {
      await ctx.notifier.sendTradeOpen({
        tradeId: persistResult.dbTradeId,
        pairAddress: position.pairAddress,
        strategy: LANE_STRATEGY,
        side: 'BUY',
        tokenSymbol: position.tokenSymbol,
        price: actualEntryPrice,
        plannedEntryPrice: signal.price,
        quantity: actualQuantity,
        sourceLabel: position.sourceLabel,
        discoverySource: position.discoverySource,
        stopLoss: actualEntryPrice * (1 - config.pureWsProbeHardCutPct),
        takeProfit1: actualEntryPrice * (1 + config.pureWsT1MfeThreshold),
        takeProfit2: actualEntryPrice * (1 + config.pureWsT2MfeThreshold),
        timeStopMinutes: Math.ceil(config.pureWsProbeWindowSec / 60),
      }, entryTxSignature);
      funnelStats.notifierOpenSent++;
    } catch (err) {
      log.warn(`[PUREWS_NOTIFY_OPEN_FAIL] ${positionId} ${err}`);
    }
  }

  activePositions.set(positionId, position);
  // 2026-04-21 P1: v1 (bootstrap) 경로 entry 성공 시 pair cooldown 기록.
  // v2 sourced signal 은 scanner 가 cooldown 관리하므로 제외.
  if (signal.sourceLabel !== 'ws_burst_v2') {
    v1LastEntrySecByPair.set(signal.pairAddress, Math.floor(Date.now() / 1000));
  }
  log.info(
    `[PUREWS_PROBE_OPEN] ${positionId} ${signal.pairAddress.slice(0, 12)} ` +
    `entry=${actualEntryPrice.toFixed(8)} qty=${actualQuantity.toFixed(4)}`
  );
}

// ─── Tick Monitor ───

export async function updatePureWsPositions(
  ctx: BotContext,
  candleBuilder: MicroCandleBuilder
): Promise<void> {
  if (!config.pureWsLaneEnabled) return;

  const nowSec = Math.floor(Date.now() / 1000);

  for (const [id, pos] of activePositions) {
    if (pos.state === 'CLOSED') continue;

    const currentPrice = candleBuilder.getCurrentPrice(pos.pairAddress);
    if (currentPrice == null || currentPrice <= 0) continue;

    // HWM peak sanity (Patch B2 동일 원칙) — max 기준은 market reference price.
    const referencePrice = pos.marketReferencePrice;
    const maxPeak = referencePrice * config.pureWsMaxPeakMultiplier;
    const elapsedForPeak = nowSec - pos.entryTimeSec;
    // 2026-04-19 (QA Q2): Peak warmup — 진입 직후 pureWsPeakWarmupSec 동안은 봇 자신의
    // BUY tx 가 pool price 를 띄운 영향이 candleBuilder currentPrice 에 반영될 수 있음.
    // 따라서 market ref 대비 peakWarmupMaxDeviationPct 이내만 peak 로 인정.
    const peakCeilingInWarmup =
      elapsedForPeak < config.pureWsPeakWarmupSec
        ? referencePrice * (1 + config.pureWsPeakWarmupMaxDeviationPct)
        : maxPeak;
    if (currentPrice > pos.peakPrice && currentPrice <= peakCeilingInWarmup) {
      pos.peakPrice = currentPrice;
    }
    if (currentPrice < pos.troughPrice) {
      pos.troughPrice = currentPrice;
    }

    // 2026-04-19: MAE/MFE/currentPct 는 market reference (signal price) 기준.
    // Jupiter bad-fill 의 entry-to-fill gap 이 시장 이동으로 잡히지 않도록 분리.
    // Pnl 계산은 아래 closePureWsPosition 에서 entryPrice (Jupiter fill) 기준 유지.
    const mfePct = (pos.peakPrice - referencePrice) / referencePrice;
    const maePct = (pos.troughPrice - referencePrice) / referencePrice;
    const currentPct = (currentPrice - referencePrice) / referencePrice;
    const elapsedSec = nowSec - pos.entryTimeSec;

    switch (pos.state) {
      case 'PROBE': {
        // Hard cut (loser quick cut)
        if (maePct <= -config.pureWsProbeHardCutPct) {
          log.info(
            `[PUREWS_LOSER_HARDCUT] ${id} MAE=${(maePct * 100).toFixed(2)}% elapsed=${elapsedSec}s`
          );
          await closePureWsPosition(id, pos, currentPrice, 'REJECT_HARD_CUT', ctx);
          continue;
        }

        // DEX_TRADE Phase 3: Quick Reject Classifier (microstructure-based)
        // Why: price-only cut 금지. time-box + buy ratio decay + tx density drop 조합 판정.
        if (config.quickRejectClassifierEnabled && elapsedSec <= config.quickRejectWindowSec) {
          const recentCandles = candleBuilder.getRecentCandles(
            pos.pairAddress,
            config.realtimePrimaryIntervalSec,
            3
          );
          const qr = evaluateQuickReject(
            {
              elapsedSec,
              mfePct,
              buyRatioAtEntry: pos.buyRatioAtEntry ?? 0.5,
              txCountAtEntry: pos.txCountAtEntry ?? 0,
              recentCandles,
            },
            {
              enabled: true,
              windowSec: config.quickRejectWindowSec,
              minMfePct: config.quickRejectMinMfePct,
              buyRatioDecayThreshold: config.quickRejectBuyRatioDecay,
              txDensityDropThreshold: config.quickRejectTxDensityDrop,
              degradeCountForExit: config.quickRejectDegradeCountForExit,
            }
          );
          if (qr.action === 'exit') {
            log.info(
              `[PUREWS_QUICK_REJECT] ${id} microstructure degraded — factors=${qr.degradeFactors.join(',')} ` +
              `mfe=${(mfePct * 100).toFixed(2)}% elapsed=${elapsedSec}s`
            );
            await closePureWsPosition(id, pos, currentPrice, 'REJECT_TIMEOUT', ctx);
            continue;
          }
          // 'reduce' action 은 Phase 3 초기 — 로그만 남김 (partial exit 는 Phase 4 후보)
          if (qr.action === 'reduce') {
            log.debug(
              `[PUREWS_QUICK_REJECT_WARN] ${id} reduce candidate — factors=${qr.degradeFactors.join(',')} ` +
              `elapsed=${elapsedSec}s`
            );
          }
        }

        // Flat timeout
        if (elapsedSec >= config.pureWsProbeWindowSec) {
          const inFlatBand = Math.abs(currentPct) <= config.pureWsProbeFlatBandPct;
          if (inFlatBand) {
            log.info(
              `[PUREWS_LOSER_TIMEOUT] ${id} flat band currentPct=${(currentPct * 100).toFixed(2)}% ` +
              `MFE=${(mfePct * 100).toFixed(2)}%`
            );
            await closePureWsPosition(id, pos, currentPrice, 'REJECT_TIMEOUT', ctx);
            continue;
          }
          // 창 넘겼지만 flat 아님 → 추가 관찰 (trailing 로직으로 처리)
        }
        // PROBE trail
        if (pos.peakPrice > pos.entryPrice) {
          const trailStop = pos.peakPrice * (1 - config.pureWsProbeTrailingPct);
          if (currentPrice <= trailStop) {
            log.info(
              `[PUREWS_PROBE_TRAIL] ${id} peak=${pos.peakPrice.toFixed(8)} ` +
              `trail=${trailStop.toFixed(8)} currentPct=${(currentPct * 100).toFixed(2)}%`
            );
            await closePureWsPosition(id, pos, currentPrice, 'WINNER_TRAILING', ctx);
            continue;
          }
        }
        // Promote to T1
        if (mfePct >= config.pureWsT1MfeThreshold) {
          pos.state = 'RUNNER_T1';
          funnelStats.winnersT1++;
          log.info(
            `[PUREWS_T1] ${id} promoted RUNNER_T1 MFE=${(mfePct * 100).toFixed(2)}%`
          );
        }
        break;
      }

      case 'RUNNER_T1': {
        if (mfePct >= config.pureWsT2MfeThreshold) {
          pos.state = 'RUNNER_T2';
          // 2026-04-19: T2 breakeven lock 는 peakPrice/trailStop 과 같은 domain 이어야
          // 한다 (market reference 기반). Pnl break-even 은 closePureWsPosition 에서
          // entry (Jupiter fill) 기준으로 별도 계산.
          pos.t2BreakevenLockPrice = referencePrice * config.pureWsT2BreakevenLockMultiplier;
          funnelStats.winnersT2++;
          log.info(
            `[PUREWS_T2] ${id} promoted RUNNER_T2 MFE=${(mfePct * 100).toFixed(2)}% ` +
            `lock=${pos.t2BreakevenLockPrice.toFixed(8)}`
          );
          break;
        }
        // Phase 3: hold-phase sentinel — degraded 시 즉시 degraded exit
        if (await checkHoldPhaseDegraded(id, pos, currentPrice, candleBuilder, ctx)) continue;
        const trailStop = pos.peakPrice * (1 - config.pureWsT1TrailingPct);
        if (currentPrice <= trailStop) {
          log.info(
            `[PUREWS_T1_TRAIL] ${id} peak=${pos.peakPrice.toFixed(8)} ` +
            `trail=${trailStop.toFixed(8)} currentPct=${(currentPct * 100).toFixed(2)}%`
          );
          await closePureWsPosition(id, pos, currentPrice, 'WINNER_TRAILING', ctx);
          continue;
        }
        break;
      }

      case 'RUNNER_T2': {
        if (mfePct >= config.pureWsT3MfeThreshold) {
          pos.state = 'RUNNER_T3';
          funnelStats.winnersT3++;
          log.info(
            `[PUREWS_T3] ${id} promoted RUNNER_T3 MFE=${(mfePct * 100).toFixed(2)}%`
          );
          break;
        }
        if (await checkHoldPhaseDegraded(id, pos, currentPrice, candleBuilder, ctx)) continue;
        const trailStop = Math.max(
          pos.peakPrice * (1 - config.pureWsT2TrailingPct),
          pos.t2BreakevenLockPrice ?? referencePrice * config.pureWsT2BreakevenLockMultiplier
        );
        if (currentPrice <= trailStop) {
          log.info(
            `[PUREWS_T2_TRAIL] ${id} peak=${pos.peakPrice.toFixed(8)} ` +
            `trail=${trailStop.toFixed(8)} (lock=${(pos.t2BreakevenLockPrice ?? 0).toFixed(8)}) ` +
            `currentPct=${(currentPct * 100).toFixed(2)}%`
          );
          await closePureWsPosition(id, pos, currentPrice, 'WINNER_TRAILING', ctx);
          continue;
        }
        break;
      }

      case 'RUNNER_T3': {
        if (await checkHoldPhaseDegraded(id, pos, currentPrice, candleBuilder, ctx)) continue;
        // No time stop — runner mode. 단일 exit = trail 25%.
        const trailStop = Math.max(
          pos.peakPrice * (1 - config.pureWsT3TrailingPct),
          pos.t2BreakevenLockPrice ?? referencePrice * config.pureWsT2BreakevenLockMultiplier
        );
        if (currentPrice <= trailStop) {
          log.info(
            `[PUREWS_T3_TRAIL] ${id} peak=${pos.peakPrice.toFixed(8)} ` +
            `trail=${trailStop.toFixed(8)} currentPct=${(currentPct * 100).toFixed(2)}%`
          );
          await closePureWsPosition(id, pos, currentPrice, 'WINNER_TRAILING', ctx);
          continue;
        }
        break;
      }
    }
  }
}

/**
 * Phase 3 helper: hold-phase sentinel 평가 + degraded 시 DEGRADED_EXIT 로 close.
 * @returns true 면 close 수행됨 (caller 는 continue)
 */
async function checkHoldPhaseDegraded(
  id: string,
  pos: PureWsPosition,
  currentPrice: number,
  candleBuilder: MicroCandleBuilder,
  ctx: BotContext
): Promise<boolean> {
  if (!config.holdPhaseSentinelEnabled) return false;
  const recentCandles = candleBuilder.getRecentCandles(
    pos.pairAddress,
    config.realtimePrimaryIntervalSec,
    3
  );
  const result = evaluateHoldPhaseSentinel(
    {
      buyRatioAtEntry: pos.buyRatioAtEntry ?? 0.5,
      txCountAtEntry: pos.txCountAtEntry ?? 0,
      peakPrice: pos.peakPrice,
      currentPrice,
      recentCandles,
    },
    {
      enabled: true,
      buyRatioCollapseThreshold: config.holdPhaseBuyRatioCollapse,
      txDensityDropThreshold: config.holdPhaseTxDensityDrop,
      peakDriftThreshold: config.holdPhasePeakDrift,
      degradedFactorCount: config.holdPhaseDegradedFactorCount,
    }
  );
  if (result.status === 'degraded') {
    log.warn(
      `[PUREWS_HOLD_DEGRADED] ${id} state=${pos.state} factors=${result.warnFactors.join(',')} ` +
      `peakDrift=${(result.peakDriftPct * 100).toFixed(2)}% buyR=${result.recentBuyRatio.toFixed(2)} tx=${result.recentTxCount.toFixed(1)}`
    );
    await closePureWsPosition(id, pos, currentPrice, 'DEGRADED_EXIT', ctx);
    return true;
  }
  if (result.status === 'warn') {
    log.debug(
      `[PUREWS_HOLD_WARN] ${id} state=${pos.state} factors=${result.warnFactors.join(',')}`
    );
  }
  return false;
}

// ─── Close ───

async function closePureWsPosition(
  id: string,
  pos: PureWsPosition,
  exitPrice: number,
  reason: CloseReason,
  ctx: BotContext
): Promise<void> {
  return serializeClose(() => closePureWsPositionSerialized(id, pos, exitPrice, reason, ctx));
}

async function closePureWsPositionSerialized(
  id: string,
  pos: PureWsPosition,
  exitPrice: number,
  reason: CloseReason,
  ctx: BotContext
): Promise<void> {
  if (pos.state === 'CLOSED') return;

  let actualExitPrice = exitPrice;
  let executionSlippage = 0;
  let exitTxSignature = pos.entryTxSignature;
  const holdSec = Math.floor(Date.now() / 1000) - pos.entryTimeSec;
  const previousState = pos.state;
  let sellCompleted = ctx.tradingMode !== 'live';
  let dbCloseSucceeded = false;

  if (ctx.tradingMode === 'live') {
    try {
      const sellExecutor = getPureWsExecutor(ctx);
      const tokenBalance = await sellExecutor.getTokenBalance(pos.pairAddress);
      if (tokenBalance > 0n) {
        const solBefore = await sellExecutor.getBalance();
        const sellResult = await sellExecutor.executeSell(pos.pairAddress, tokenBalance);
        const solAfter = await sellExecutor.getBalance();
        const receivedSol = solAfter - solBefore;
        if (receivedSol > 0 && pos.quantity > 0) {
          actualExitPrice = receivedSol / pos.quantity;
        }
        executionSlippage = bpsToDecimal(sellResult.slippageBps);
        exitTxSignature = sellResult.txSignature;
        sellCompleted = true;
        log.info(
          `[PUREWS_LIVE_SELL] ${id} sig=${sellResult.txSignature.slice(0, 12)} ` +
          `received=${receivedSol.toFixed(6)} SOL slip=${sellResult.slippageBps}bps`
        );
        await appendEntryLedger('sell', {
          positionId: id,
          dbTradeId: pos.dbTradeId,
          txSignature: exitTxSignature,
          entryTxSignature: pos.entryTxSignature,
          strategy: LANE_STRATEGY,
          wallet: resolvePureWsWalletLabel(ctx), // Block 1 QA fix
          pairAddress: pos.pairAddress,
          tokenSymbol: pos.tokenSymbol,
          exitReason: reason,
          receivedSol,
          actualExitPrice,
          slippageBps: sellResult.slippageBps,
          entryPrice: pos.entryPrice,
          holdSec,
        });
      } else {
        // 2026-04-20 P0 fix: orphan position (지갑에 토큰 없음) — 기존 `throw Error` 는
        // previousState 복원 → 매 tick sell 재시도 → 무한 loop (VPS 4/20 관측 3,982회/8분).
        // 원인: 외부 sell / rug / DB OPEN 으로 남은 이전 세션 trade recovery.
        // Fix: tokenBalance==0 을 정상 close 로 마감 — pnl=0, reason=ORPHAN_NO_BALANCE,
        // sellCompleted=true 로 DB close 진행. 1회 critical notifier.
        log.warn(
          `[PUREWS_ORPHAN_CLOSE] ${id} ${pos.pairAddress.slice(0, 12)} zero token balance — ` +
          `force closing (previousReason=${reason} entry=${pos.entryPrice.toFixed(8)} qty=${pos.quantity})`
        );
        reason = 'ORPHAN_NO_BALANCE';
        actualExitPrice = pos.entryPrice;  // pnl = 0
        sellCompleted = true;
        exitTxSignature = pos.entryTxSignature ?? 'ORPHAN_NO_TX';
        await ctx.notifier.sendCritical(
          'purews_orphan_close',
          `${id} ${pos.pairAddress} zero token balance at close — force closing with 0 pnl`
        ).catch(() => {});
      }
    } catch (sellErr) {
      log.warn(`[PUREWS_LIVE_SELL] ${id} sell failed: ${sellErr}`);
      pos.state = previousState;
      const nowSec = Math.floor(Date.now() / 1000);
      if (!pos.lastCloseFailureAtSec || nowSec - pos.lastCloseFailureAtSec >= 60) {
        pos.lastCloseFailureAtSec = nowSec;
        await ctx.notifier.sendCritical(
          'purews_close_failed',
          `${id} ${pos.pairAddress} reason=${reason} sell failed — OPEN 유지`
        ).catch(() => {});
      }
      return;
    }
  }

  pos.state = 'CLOSED';
  funnelStats.closedTrades++;

  const rawPnl = (actualExitPrice - pos.entryPrice) * pos.quantity;
  const paperCost = ctx.tradingMode === 'paper'
    ? pos.entryPrice * pos.quantity * (config.defaultAmmFeePct + config.defaultMevMarginPct)
    : 0;
  const pnl = rawPnl - paperCost;
  const pnlPct = pos.entryPrice > 0
    ? ((actualExitPrice - pos.entryPrice) / pos.entryPrice) * 100
    : 0;
  const exitSlippageBps = ctx.tradingMode === 'live' ? Math.round(executionSlippage * 10_000) : undefined;

  let tradeId = pos.dbTradeId;
  try {
    if (!tradeId) {
      // fallback: persistOpen 단계에서 실패했으면 close 시점에 다시 시도
      tradeId = await ctx.tradeStore.insertTrade({
        pairAddress: pos.pairAddress,
        strategy: LANE_STRATEGY,
        side: 'BUY',
        tokenSymbol: pos.tokenSymbol,
        sourceLabel: pos.sourceLabel,
        discoverySource: pos.discoverySource,
        entryPrice: pos.entryPrice,
        plannedEntryPrice: pos.plannedEntryPrice,
        quantity: pos.quantity,
        stopLoss: pos.entryPrice * (1 - config.pureWsProbeHardCutPct),
        takeProfit1: pos.entryPrice * (1 + config.pureWsT1MfeThreshold),
        takeProfit2: pos.entryPrice * (1 + config.pureWsT2MfeThreshold),
        highWaterMark: pos.peakPrice,
        timeStopAt: new Date((pos.entryTimeSec + config.pureWsProbeWindowSec) * 1000),
        status: 'OPEN',
        txSignature: pos.entryTxSignature,
        createdAt: new Date(pos.entryTimeSec * 1000),
        entrySlippageBps: pos.entrySlippageBps,
      });
    }
    if (!sellCompleted) {
      throw new Error(`purews close reached DB close without completed sell: ${id}`);
    }
    await ctx.tradeStore.closeTrade({
      id: tradeId,
      exitPrice: actualExitPrice,
      pnl,
      slippage: executionSlippage,
      exitReason: reason,
      exitSlippageBps,
      decisionPrice: exitPrice,
    });
    dbCloseSucceeded = true;
  } catch (error) {
    log.warn(`Failed to record purews trade ${id}: ${error}`);
    await ctx.notifier.sendCritical(
      'purews_close_persist',
      `${id} ${pos.pairAddress} reason=${reason} sell ok but DB close failed`
    ).catch(() => {});
  }

  const sym = pos.tokenSymbol || pos.pairAddress.slice(0, 8);
  log.info(
    `[PUREWS_CLOSED] ${id} ${sym} reason=${reason} state=${previousState} ` +
    `pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) ` +
    `hold=${holdSec}s peak=${((pos.peakPrice - pos.marketReferencePrice) / pos.marketReferencePrice * 100).toFixed(2)}%`
  );

  if (tradeId && dbCloseSucceeded) {
    const closedTrade: Trade = {
      id: tradeId,
      pairAddress: pos.pairAddress,
      strategy: LANE_STRATEGY,
      side: 'BUY',
      tokenSymbol: pos.tokenSymbol,
      sourceLabel: pos.sourceLabel,
      discoverySource: pos.discoverySource,
      entryPrice: pos.entryPrice,
      plannedEntryPrice: pos.plannedEntryPrice,
      exitPrice: actualExitPrice,
      quantity: pos.quantity,
      pnl,
      slippage: executionSlippage,
      txSignature: exitTxSignature,
      status: 'CLOSED',
      createdAt: new Date(pos.entryTimeSec * 1000),
      closedAt: new Date(),
      stopLoss: pos.entryPrice * (1 - config.pureWsProbeHardCutPct),
      takeProfit1: pos.entryPrice * (1 + config.pureWsT1MfeThreshold),
      takeProfit2: pos.entryPrice * (1 + config.pureWsT2MfeThreshold),
      highWaterMark: pos.peakPrice,
      timeStopAt: new Date((pos.entryTimeSec + config.pureWsProbeWindowSec) * 1000),
      entrySlippageBps: pos.entrySlippageBps,
      exitSlippageBps,
      exitReason: reason,
      decisionPrice: exitPrice,
    };
    await ctx.notifier.sendTradeClose(closedTrade).catch(() => {});
  }

  // Block 4: canary auto-halt feed
  reportCanaryClose(LANE_STRATEGY, pnl);
  // Block 4 QA fix: 전역 concurrency slot 해제 (acquire 대응)
  releaseCanarySlot(LANE_STRATEGY);

  // DEX_TRADE Phase 2: daily bleed budget 누적
  // Why: close 직후 실제 발생한 loss 를 budget 에 반영. winner 는 budget 영향 없음 (spend 0).
  if (config.dailyBleedBudgetEnabled) {
    const walletState = getWalletStopGuardState();
    const walletBaselineSol = walletState.lastBalanceSol > 0 && Number.isFinite(walletState.lastBalanceSol)
      ? walletState.lastBalanceSol
      : config.walletStopMinSol + 0.01;
    // pnl < 0 이면 -pnl 을 소비로 집계. pnl >= 0 이면 소비 없음.
    const bleedSol = pnl < 0 ? -pnl : 0;
    reportBleed(bleedSol, walletBaselineSol, {
      alpha: config.dailyBleedAlpha,
      minCapSol: config.dailyBleedMinCapSol,
      maxCapSol: config.dailyBleedMaxCapSol,
    });
  }
}

// ─── Recovery ───

export async function recoverPureWsOpenPositions(ctx: BotContext): Promise<number> {
  if (!config.pureWsLaneEnabled) return 0;

  const openTrades = await ctx.tradeStore.getOpenTrades();
  const pureWsOpenTrades = openTrades.filter((t) => t.strategy === LANE_STRATEGY);
  let recovered = 0;

  for (const trade of pureWsOpenTrades) {
    // 2026-04-20 P0 fix: 선제 orphan 검사 — live 모드에서만 수행.
    // Why: DB OPEN 인데 지갑에 토큰이 없는 trade 를 in-memory 로 로드하면 tick 마다 close 시도
    // → getTokenBalance==0 → 3,982 회 sell 재시도 spam (4/20 BOME ukHH6c7m 관측).
    // 해결: balance==0 이면 DB 를 직접 orphan close 로 업데이트하고 in-memory load 건너뛴다.
    // balance check 실패 (RPC 문제 등) 시 기존 recovery 로 load (보수적 fallback).
    if (ctx.tradingMode === 'live') {
      try {
        const probeExecutor = getPureWsExecutor(ctx);
        const onchainBalance = await probeExecutor.getTokenBalance(trade.pairAddress);
        if (onchainBalance === 0n) {
          log.warn(
            `[PUREWS_RECOVERY_ORPHAN] trade=${trade.id.slice(0, 8)} pair=${trade.pairAddress.slice(0, 12)} ` +
            `zero token balance — closing DB with 0 pnl, skipping in-memory load`
          );
          await ctx.tradeStore.closeTrade({
            id: trade.id,
            exitPrice: trade.entryPrice,
            pnl: 0,
            slippage: 0,
            exitReason: 'ORPHAN_NO_BALANCE',
            exitSlippageBps: undefined,
            decisionPrice: trade.entryPrice,
          }).catch((err) => log.error(`[PUREWS_RECOVERY_ORPHAN] DB close failed for ${trade.id}: ${err}`));
          await ctx.notifier.sendCritical(
            'purews_recovery_orphan',
            `recovery: ${trade.id.slice(0, 8)} ${trade.pairAddress} zero balance — DB closed, not loaded`
          ).catch(() => {});
          continue;
        }
      } catch (balanceErr) {
        // RPC 실패 시 보수적으로 기존 recovery 로 진행 (close loop fix 가 안전망 역할).
        log.warn(
          `[PUREWS_RECOVERY_ORPHAN] balance check failed for ${trade.pairAddress.slice(0, 12)}: ` +
          `${balanceErr} — falling back to in-memory load`
        );
      }
    }

    // Sanitize HWM (Patch B2 pattern)
    const highWaterMark = trade.highWaterMark ?? trade.entryPrice;
    const safePeak = Math.min(highWaterMark, trade.entryPrice * config.pureWsMaxPeakMultiplier);
    const inferredState: PureWsTradeState =
      safePeak >= trade.entryPrice * (1 + config.pureWsT3MfeThreshold) ? 'RUNNER_T3'
      : safePeak >= trade.entryPrice * (1 + config.pureWsT2MfeThreshold) ? 'RUNNER_T2'
      : safePeak >= trade.entryPrice * (1 + config.pureWsT1MfeThreshold) ? 'RUNNER_T1'
      : 'PROBE';

    const entryTimeSec = Math.floor(trade.createdAt.getTime() / 1000);
    const positionId = `purews-${trade.pairAddress.slice(0, 8)}-${entryTimeSec}`;
    const t2Lock = inferredState === 'RUNNER_T2' || inferredState === 'RUNNER_T3'
      ? trade.entryPrice * config.pureWsT2BreakevenLockMultiplier
      : undefined;

    // 2026-04-19: DB 에 marketReferencePrice 저장 안 됨 → plannedEntryPrice (= signal price)
    // fallback, 없으면 entryPrice. 재시작 이후 새 tick 부터 market ref 기준 적용.
    const marketReferencePrice =
      trade.plannedEntryPrice ?? trade.entryPrice;
    // 2026-04-19 (QA Q4): troughPrice 도 marketReferencePrice domain 이어야 MAE 계산 정합.
    // 기존처럼 entryPrice (fill) 기준으로 두면 trough 가 marketRef 보다 높아 초기 MAE 가
    // 음수로 안 찍힘 → real market drop 반영 지연.
    activePositions.set(positionId, {
      tradeId: positionId,
      dbTradeId: trade.id,
      pairAddress: trade.pairAddress,
      entryPrice: trade.entryPrice,
      marketReferencePrice,
      entryTimeSec,
      quantity: trade.quantity,
      state: inferredState,
      peakPrice: safePeak,
      troughPrice: marketReferencePrice,
      tokenSymbol: trade.tokenSymbol,
      sourceLabel: trade.sourceLabel,
      discoverySource: trade.discoverySource,
      plannedEntryPrice: trade.plannedEntryPrice,
      entryTxSignature: trade.txSignature,
      entrySlippageBps: trade.entrySlippageBps,
      t2BreakevenLockPrice: t2Lock,
    });
    recovered++;
    log.info(
      `[PUREWS_RECOVERED] ${positionId} trade=${trade.id.slice(0, 8)} ` +
      `state=${inferredState} pair=${trade.pairAddress.slice(0, 12)}`
    );
  }

  return recovered;
}

// ─── Phase 1.3: V2 Independent Detector Scanner ───

/**
 * V2 detector 기반 independent burst scanner.
 *
 * Why: v1 은 bootstrap signal 을 그대로 소비해서 candle-close 이벤트에 의존했다. V2 는
 * `evaluateWsBurst` 로 **독립적 burst 판정** → bootstrap 과 무관한 trigger 경로.
 *
 * 호출 지점: index.ts 의 candle close listener 또는 tick monitor 에서 watchlist pair 를 전달.
 *
 * 동작:
 *   1) config.pureWsV2Enabled 확인 (disabled 면 no-op)
 *   2) per-pair cooldown 체크 (default 5분)
 *   3) evaluateWsBurst 호출
 *   4) pass 면 synthetic Signal 생성 + handlePureWsSignal 로 일반 entry path 재사용
 *      (sourceLabel='ws_burst_v2' 로 v1 gate bypass)
 */
export async function scanPureWsV2Burst(
  ctx: BotContext,
  candleBuilder: MicroCandleBuilder,
  pairAddresses: Iterable<string>,
  tokenSymbolByPair?: Map<string, string | undefined>
): Promise<void> {
  if (!config.pureWsLaneEnabled) return;
  if (!config.pureWsV2Enabled) return;
  // 2026-04-20 P2 fix: lane halt 활성화 상태면 scan 자체를 skip.
  // Why: 기존 동작은 v2 evaluateWsBurst + PUREWS_V2_PASS 로그를 매번 찍은 뒤 handler 에서
  // `PUREWS_ENTRY_HALT` 로 return → position 안 만들어짐 → cooldown 설정 안 됨 →
  // 다음 scan 에서 다시 pass → 무한 loop (4/20 관측 GEr3mp 567 반복 pass).
  // halt 가 풀리기 전까지는 scan 의미 없음 — 로그 spam + Jupiter rate-limit 유발.
  if (isEntryHaltActive(LANE_STRATEGY)) {
    v2Telemetry.haltSkipped++;
    return;
  }

  v2Telemetry.scansCalled++;
  const detectorCfg = buildV2DetectorConfig();
  const requiredCandles = detectorCfg.nRecent + detectorCfg.nBaseline;
  const nowSec = Math.floor(Date.now() / 1000);
  const cooldownSec = config.pureWsV2PerPairCooldownSec;

  for (const pair of pairAddresses) {
    // per-pair cooldown (Top pair 쏠림 방어 — paper replay 에서 pippin 58% 점유 관측)
    const lastTriggerSec = v2LastTriggerSecByPair.get(pair) ?? 0;
    if (nowSec - lastTriggerSec < cooldownSec) {
      v2Telemetry.cooldownSkipped++;
      continue;
    }

    v2Telemetry.pairsEvaluated++;

    const candles = candleBuilder.getRecentCandles(
      pair,
      config.realtimePrimaryIntervalSec,
      requiredCandles
    );
    if (candles.length < requiredCandles) {
      v2Telemetry.candlesInsufficient++;
      continue;
    }

    const result = evaluateWsBurst(candles, detectorCfg);
    if (!result.pass) {
      const reasonKey = result.rejectReason ?? 'unknown';
      v2Telemetry.detectorRejects[reasonKey] = (v2Telemetry.detectorRejects[reasonKey] ?? 0) + 1;
      log.debug(
        `[PUREWS_V2_REJECT] ${pair.slice(0, 12)} reason=${reasonKey} score=${result.score}`
      );
      continue;
    }

    const currentPrice = candleBuilder.getCurrentPrice(pair);
    if (currentPrice == null || currentPrice <= 0) {
      v2Telemetry.noCurrentPrice++;
      continue;
    }

    v2Telemetry.passed++;
    log.info(
      `[PUREWS_V2_PASS] ${pair.slice(0, 12)} score=${result.score} ` +
      `vol=${result.factors.volumeAccelZ.toFixed(2)} buy=${result.factors.buyPressureZ.toFixed(2)} ` +
      `tx=${result.factors.txDensityZ.toFixed(2)} price=${result.factors.priceAccel.toFixed(2)} ` +
      `bps=${result.factors.rawPriceChangeBps.toFixed(1)}`
    );

    // QA fix (F8, 2026-04-18): cooldown 을 handler 성공 이후에만 설정.
    // 이전 구현 bug: handler 가 viability / paper-first / acquire 에서 reject 해도 cooldown 활성 → 5min lockout.
    // 수정: activePositions 크기로 성공 판정. 실패한 scan 은 다음 candle 에서 재시도 가능.
    const activeCountBefore = activePositions.size;

    // Synthesize Signal + reuse existing handler (security / concurrency / persist / PROBE 전부 재사용)
    const syntheticSignal: Signal = {
      action: 'BUY',
      strategy: LANE_STRATEGY,
      pairAddress: pair,
      tokenSymbol: tokenSymbolByPair?.get(pair),
      price: currentPrice,
      timestamp: new Date(nowSec * 1000),
      meta: {
        burstScore: result.score,
        volumeAccelZ: result.factors.volumeAccelZ,
        buyPressureZ: result.factors.buyPressureZ,
        txDensityZ: result.factors.txDensityZ,
        priceAccel: result.factors.priceAccel,
        rawBuyRatio: result.factors.rawBuyRatioRecent,
        rawTxCount: result.factors.rawTxCountRecent,
        rawPriceChangeBps: result.factors.rawPriceChangeBps,
      },
      sourceLabel: 'ws_burst_v2',
      discoverySource: 'pure_ws_v2',
    };
    await handlePureWsSignal(syntheticSignal, candleBuilder, ctx);

    // QA fix (F8): cooldown 은 실제로 position 이 생겼을 때만 설정.
    // handler 가 viability/paper-first/concurrency 로 reject 하면 cooldown 안 함 → 다음 candle 에서 재시도.
    if (activePositions.size > activeCountBefore) {
      v2LastTriggerSecByPair.set(pair, nowSec);
    }
  }
}

/** Test helper — scanPureWsV2Burst 이후 cooldown state 초기화 */
export function resetPureWsV2CooldownForTests(): void {
  v2LastTriggerSecByPair.clear();
}
