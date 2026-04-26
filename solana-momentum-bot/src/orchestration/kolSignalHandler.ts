/**
 * kol_hunter Lane Handler (Option 5 Phase 3 — FULL, 2026-04-23)
 *
 * ADR: docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md
 * REFACTORING_v1.0.md §8: Phase 3 paper-first full state machine.
 *
 * Paper-mode only (config.kolHunterPaperOnly=true 강제 권장).
 * Live 전환은 Phase 4 canary 단계에서 운영자 명시 승인 필요.
 *
 * ─── Flow ─────────────────────────────────────────────
 *  1. handleKolSwap(tx) — KolWalletTracker 에서 emit 된 KolTx 수신
 *  2. sell event → Phase 4+ exit tracking (현재 로깅만)
 *  3. buy event → pending candidate 로 등록 + stalk window 시작
 *  4. Stalk window 내 추가 KOL tx → multi-KOL consensus 집계
 *  5. Stalk 만료 or consensus ≥ minConsensus → PaperPosition 생성
 *  6. price feed subscribe → 주기 tick 으로 state machine 평가
 *  7. PROBE → T1(+50%) → T2(+400%) → T3(+900%) — Lane T 파라미터
 *  8. exit 시 observer 훅 (5 category) + paper ledger append
 *
 * ─── State Machine (Lane T 파라미터) ──────────────────
 *  PROBE:
 *    - hardcut: MAE ≤ -10%                          → probe_hard_cut
 *    - quickReject: 180s 내 3-factor degraded exit  → quick_reject_classifier_exit
 *    - flat timeout: stalk window+180s 만료 + flat → probe_reject_timeout
 *    - probe trail: peak × (1 - 15%) hit           → probe_flat_cut
 *    - T1 promote: MFE ≥ +50%
 *  RUNNER_T1:
 *    - T2 promote: MFE ≥ +400%
 *    - holdPhase degraded (3+ factor)              → hold_phase_sentinel_degraded_exit
 *    - T1 trail: peak × (1 - 15%)                  → WINNER_TRAILING
 *  RUNNER_T2:
 *    - T3 promote: MFE ≥ +900%
 *    - T2 trail: max(peak × (1-20%), entry×3 lock)
 *    - holdPhase degraded                          → hold_phase_sentinel_degraded_exit
 *  RUNNER_T3:
 *    - no time stop
 *    - T3 trail: peak × (1 - 25%)
 *
 * Real Asset Guard 무영향 (paper only, 지갑 trade 0).
 */
import { EventEmitter } from 'events';
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import { config } from '../utils/config';
import type { KolTx, KolDiscoveryScore } from '../kol/types';
import { computeKolDiscoveryScore } from '../kol/scoring';
import { PaperPriceFeed, type PriceTick } from '../kol/paperPriceFeed';
import { trackRejectForMissedAlpha, type MissedAlphaEvent } from '../observability/missedAlphaObserver';
import { evaluateSecurityGate } from '../gate/securityGate';
import { evaluateSellQuoteProbe } from '../gate/sellQuoteProbe';
import type { OnchainSecurityClient } from '../ingester/onchainSecurity';
import type { GateCacheManager } from '../gate/gateCacheManager';

const log = createModuleLogger('KolHunter');
const LANE_STRATEGY = 'kol_hunter' as const;

// ─── State Types ─────────────────────────────────────────

export type LaneTState =
  | 'STALK'        // 첫 KOL tx 수신 후 consensus 대기
  | 'PROBE'        // entry 직후
  | 'RUNNER_T1'
  | 'RUNNER_T2'
  | 'RUNNER_T3'
  | 'CLOSED';

export type CloseReason =
  | 'probe_hard_cut'
  | 'probe_reject_timeout'
  | 'probe_flat_cut'
  | 'quick_reject_classifier_exit'
  | 'hold_phase_sentinel_degraded_exit'
  | 'smart_v3_no_trigger'
  | 'smart_v3_price_timeout'
  | 'smart_v3_kol_sell_cancel'
  | 'insider_exit_full'
  | 'winner_trailing_t1'
  | 'winner_trailing_t2'
  | 'winner_trailing_t3'
  | 'stalk_expired_no_consensus';

export type KolEntryReason =
  | 'legacy_v1'
  | 'swing_v2'
  | 'pullback'
  | 'velocity'
  | 'pullback_and_velocity';

export type KolConvictionLevel =
  | 'LOW'
  | 'MEDIUM_HIGH'
  | 'HIGH'
  | 'HIGH_PLUS';

export interface PaperPosition {
  positionId: string;
  tokenMint: string;
  state: LaneTState;
  // entry
  entryPrice: number;           // Jupiter quote 시점 가격 (paper — 실 fill 없음)
  entryTimeSec: number;
  ticketSol: number;
  quantity: number;             // 가상 수량 (ticketSol / entryPrice)
  // market reference (MAE/MFE 계산 기준)
  marketReferencePrice: number;
  peakPrice: number;
  troughPrice: number;
  // tier visit timestamps (P2-4 호환)
  t1VisitAtSec?: number;
  t2VisitAtSec?: number;
  t3VisitAtSec?: number;
  // kol metadata
  participatingKols: Array<{ id: string; tier: 'S' | 'A' | 'B'; timestamp: number }>;
  kolScore: number;
  // t2 lock
  t2BreakevenLockPrice?: number;
  /**
   * 2026-04-26 (P1 critical fix): tokenDecimals 를 entry 시점에 stash.
   * Why: missed_alpha_observer 가 close 후 T+60/300/1800s Jupiter price 조회 시
   *      decimals 모르면 'decimals_unknown' error 로 trajectory 측정 불가.
   *      현재 KOL paper 21 trades 의 missed-alpha 대부분이 decimals_unknown 이라 swing arm 결정 데이터 부재.
   *      securityClient 또는 Jupiter quote 에서 정확히 확인된 decimals 만 저장 → close 시 observer 에 전파.
   */
  tokenDecimals?: number;
  tokenDecimalsSource?: 'security_client' | 'jupiter_quote';
  lastPrice: number;
  // 2026-04-25 MISSION_CONTROL §Control 5 telemetry — paper trade ledger 가 live 와 비교 가능하려면
  // arm identity / discovery cluster / parameter version 이 trade 단위로 기록되어야 한다.
  armName: string;
  parameterVersion: string;
  isShadowArm: boolean;
  parentPositionId?: string;
  kolEntryReason: KolEntryReason;
  kolConvictionLevel: KolConvictionLevel;
  t1MfeOverride?: number;
  t1TrailPctOverride?: number;
  t1ProfitFloorMult?: number;
  probeFlatTimeoutSec?: number;
  kolReinforcementCount: number;
  detectorVersion: string;
  independentKolCount: number;
  survivalFlags: string[];
}

interface SmartV3PendingState {
  startedAtMs: number;
  observeExpiresAtMs: number;
  kolEntryPrice: number;
  peakPrice: number;
  currentPrice: number;
  preEntryFlags: string[];
  tokenDecimals?: number;
  tokenDecimalsSource?: 'security_client' | 'jupiter_quote';
  resolving: boolean;
}

interface PaperEntryOptions {
  parameterVersion?: string;
  entryReason?: KolEntryReason;
  convictionLevel?: KolConvictionLevel;
  tokenDecimals?: number;
  tokenDecimalsSource?: 'security_client' | 'jupiter_quote';
}

interface DynamicExitParams {
  t1Mfe?: number;
  t1TrailPct?: number;
  t1ProfitFloorMult?: number;
  probeFlatTimeoutSec?: number;
}

interface PendingCandidate {
  tokenMint: string;
  firstKolEntryMs: number;
  stalkExpiresAtMs: number;
  timer: NodeJS.Timeout;
  kolTxs: KolTx[];
  smartV3?: SmartV3PendingState;
}

// ─── Module State ────────────────────────────────────────

const pending = new Map<string, PendingCandidate>();        // tokenMint → pending
const active = new Map<string, PaperPosition>();            // positionId → position
const recentKolTxs: KolTx[] = [];                           // scoring 용 buffer (24h)
let priceFeed: PaperPriceFeed | null = null;
const priceListeners = new Map<string, (tick: PriceTick) => void>(); // tokenMint → fan-out handler

/**
 * MISSION_CONTROL §KOL Control survival 의존성 (2026-04-25):
 * Phase 3 paper-mode 도 live 와 동일한 entry-side gate 를 거쳐야 paper 결과가 live 비교 가능.
 * `initKolHunter({ securityClient, gateCache })` 로 주입. 미주입 시 survival 단계 skip
 * (config.kolHunterSurvivalAllowDataMissing 동작과 동일).
 */
let securityClient: OnchainSecurityClient | undefined;
let gateCache: GateCacheManager | undefined;

export const kolHunterEvents = new EventEmitter();           // 외부 관측용 (test/index)

// ─── Swing-v2 arm 판정 (2026-04-26) ─────────────────────

/**
 * Paper-only swing arm 진입 자격 — 3 조건 모두 만족 시 swing-v2 파라미터 사용.
 * - KOL_HUNTER_SWING_V2_ENABLED=true
 * - independentKolCount ≥ minKolCount (default 2 — multi-KOL only)
 * - kolScore ≥ minScore (default 5.0 — high confidence only)
 * 외부 review feedback (Q2 답변): single-KOL 까지 swing 보내면 confidence 부족.
 */
function isSwingV2Eligible(score: KolDiscoveryScore): boolean {
  if (!config.kolHunterSwingV2Enabled) return false;
  if (score.independentKolCount < config.kolHunterSwingV2MinKolCount) return false;
  if (score.finalScore < config.kolHunterSwingV2MinScore) return false;
  return true;
}

/** PaperPosition 에 stash 된 parameterVersion 으로 swing-v2 여부 판정. */
function isSwingV2Position(pos: PaperPosition): boolean {
  return pos.parameterVersion === config.kolHunterSwingV2ParameterVersion;
}

function isSmartV3Position(pos: PaperPosition): boolean {
  return pos.parameterVersion === config.kolHunterSmartV3ParameterVersion;
}

function armNameForVersion(parameterVersion: string): string {
  if (parameterVersion === config.kolHunterSmartV3ParameterVersion) return 'kol_hunter_smart_v3';
  if (parameterVersion === config.kolHunterSwingV2ParameterVersion) return 'kol_hunter_swing_v2';
  return 'kol_hunter_v1';
}

function defaultEntryReasonForVersion(parameterVersion: string): KolEntryReason {
  if (parameterVersion === config.kolHunterSmartV3ParameterVersion) return 'velocity';
  if (parameterVersion === config.kolHunterSwingV2ParameterVersion) return 'swing_v2';
  return 'legacy_v1';
}

function defaultConvictionForVersion(parameterVersion: string): KolConvictionLevel {
  if (parameterVersion === config.kolHunterSmartV3ParameterVersion) return 'MEDIUM_HIGH';
  if (parameterVersion === config.kolHunterSwingV2ParameterVersion) return 'HIGH';
  return 'LOW';
}

function dynamicExitParamsForEntry(reason: KolEntryReason): DynamicExitParams {
  switch (reason) {
    case 'pullback_and_velocity':
      return {
        t1Mfe: config.kolHunterSmartV3T1ThresholdHigh,
        t1TrailPct: config.kolHunterSmartV3T1TrailBoth,
        t1ProfitFloorMult: config.kolHunterSmartV3ProfitFloorBoth,
        probeFlatTimeoutSec: config.kolHunterSmartV3ProbeTimeoutBothSec,
      };
    case 'pullback':
      return {
        t1Mfe: config.kolHunterSmartV3T1ThresholdHigh,
        t1TrailPct: config.kolHunterSmartV3T1TrailPullback,
        t1ProfitFloorMult: config.kolHunterSmartV3ProfitFloorPullback,
        probeFlatTimeoutSec: config.kolHunterSmartV3ProbeTimeoutPullbackSec,
      };
    case 'velocity':
      return {
        t1Mfe: config.kolHunterT1Mfe,
        t1TrailPct: config.kolHunterSmartV3T1TrailVelocity,
        t1ProfitFloorMult: config.kolHunterSmartV3ProfitFloorVelocity,
        probeFlatTimeoutSec: config.kolHunterSmartV3ProbeTimeoutVelocitySec,
      };
    default:
      return {};
  }
}

function countActivePrimaryPositions(): number {
  return [...active.values()].filter((p) => !p.isShadowArm).length;
}

function appendParticipatingKol(pos: PaperPosition, tx: KolTx): void {
  if (!pos.participatingKols.find((k) => k.id === tx.kolId)) {
    pos.participatingKols.push({ id: tx.kolId, tier: tx.tier, timestamp: tx.timestamp });
  }
}

function applySmartV3Reinforcement(pos: PaperPosition, tx: KolTx): void {
  appendParticipatingKol(pos, tx);
  if (!isSmartV3Position(pos)) return;
  pos.kolReinforcementCount += 1;
  const nextTrail = Math.min(
    config.kolHunterSmartV3ReinforcementTrailMax,
    (pos.t1TrailPctOverride ?? config.kolHunterT1TrailPct) + config.kolHunterSmartV3ReinforcementTrailInc
  );
  pos.t1TrailPctOverride = nextTrail;
  log.info(
    `[KOL_REINFORCEMENT] ${pos.positionId} +1 from kol=${tx.kolId} tier=${tx.tier} ` +
    `trail=${(nextTrail * 100).toFixed(1)}% floor=${pos.t1ProfitFloorMult ?? 'none'}`
  );
}

// ─── Init / Shutdown ─────────────────────────────────────

export function initKolHunter(
  options: {
    priceFeed?: PaperPriceFeed;
    securityClient?: OnchainSecurityClient;
    gateCache?: GateCacheManager;
  } = {}
): void {
  priceFeed = options.priceFeed ?? new PaperPriceFeed({
    jupiterApiUrl: config.jupiterApiUrl,
    jupiterApiKey: config.jupiterApiKey,
    pollIntervalMs: 3_000,
    probeSolAmount: 0.01,
  });
  securityClient = options.securityClient;
  gateCache = options.gateCache;
  log.info(
    `[KOL_HUNTER] initialized — paperOnly=${config.kolHunterPaperOnly} ` +
    `survival=${securityClient ? 'enabled' : 'skipped (no client)'}`
  );
}

export function stopKolHunter(): void {
  for (const [mint, listener] of priceListeners) {
    priceFeed?.off('price', listener);
    priceFeed?.unsubscribe(mint);
  }
  priceListeners.clear();
  priceFeed?.stopAll();
  priceFeed = null;
  for (const c of pending.values()) clearTimeout(c.timer);
  pending.clear();
  active.clear();
  recentKolTxs.length = 0;
}

export function getKolHunterState(): {
  pending: number;
  active: number;
  closed: number;
  tiersByState: Record<LaneTState, number>;
} {
  const tiersByState: Record<LaneTState, number> = {
    STALK: 0, PROBE: 0, RUNNER_T1: 0, RUNNER_T2: 0, RUNNER_T3: 0, CLOSED: 0,
  };
  for (const pos of active.values()) tiersByState[pos.state] = (tiersByState[pos.state] ?? 0) + 1;
  return {
    pending: pending.size,
    active: countActivePrimaryPositions(),
    closed: 0, // in-memory closed 제거, ledger 가 누적
    tiersByState,
  };
}

// ─── Entry Point ─────────────────────────────────────────

/**
 * KolWalletTracker 에서 'kol_swap' event 수신 시 호출.
 */
export async function handleKolSwap(tx: KolTx): Promise<void> {
  if (!config.kolHunterEnabled) return;

  // recent buffer 유지 (24h)
  recentKolTxs.push(tx);
  const cutoff = Date.now() - config.kolScoringWindowMs;
  while (recentKolTxs.length > 0 && recentKolTxs[0].timestamp < cutoff) {
    recentKolTxs.shift();
  }

  if (tx.action === 'sell') {
    handleKolSellSignal(tx);
    return;
  }

  // Active 또는 pending 이미 있으면 추가 KOL 만 집계
  const existingActive = [...active.values()].filter((p) => p.tokenMint === tx.tokenMint);
  if (existingActive.length > 0) {
    // 이미 진입한 포지션에 추가 KOL 은 정보만 누적 (sizing 변경 없음).
    // v1 + swing shadow 가 동시에 떠 있으면 두 arm 모두 동일 discovery context 를 유지한다.
    for (const pos of existingActive) applySmartV3Reinforcement(pos, tx);
    return;
  }

  const existingPending = pending.get(tx.tokenMint);
  if (existingPending) {
    existingPending.kolTxs.push(tx);
    if (existingPending.smartV3) {
      await evaluateSmartV3Triggers(existingPending);
    }
    return;
  }

  // REFACTORING §2.1 hard constraint: max concurrent (Lane T 단독 상한).
  // 전역 3 은 canaryConcurrencyGuard 관할 — Phase 4 에서 연결 예정.
  const activeCount = countActivePrimaryPositions();
  const pendingCount = pending.size;
  const laneConcurrentBudget = activeCount + pendingCount;
  if (laneConcurrentBudget >= config.kolHunterMaxConcurrent) {
    log.info(
      `[KOL_HUNTER_SKIP] max concurrent (active=${activeCount} pending=${pendingCount} ` +
      `>= cap=${config.kolHunterMaxConcurrent}) — ${tokenMint(tx)} ${tx.kolId}`
    );
    return;
  }

  // 신규 pending candidate 생성 + stalk/observe window 시작
  if (config.kolHunterSmartV3Enabled) {
    await registerSmartV3Pending(tx);
  } else {
    await registerPending(tx);
  }
}

function tokenMint(tx: KolTx): string {
  return tx.tokenMint.slice(0, 8);
}

function handleKolSellSignal(tx: KolTx): void {
  const cand = pending.get(tx.tokenMint);
  if (cand?.smartV3 && cand.kolTxs.some((buy) => buy.kolId === tx.kolId)) {
    cleanupPendingCandidate(cand, true);
    pending.delete(tx.tokenMint);
    const score = computeKolDiscoveryScore(tx.tokenMint, recentKolTxs, Date.now(), {
      windowMs: config.kolScoringWindowMs,
      antiCorrelationMs: config.kolAntiCorrelationMs,
    });
    log.info(`[KOL_HUNTER_SMART_V3_CANCEL] ${tokenMint(tx)} kol=${tx.kolId} sell during observe`);
    fireRejectObserver(tx.tokenMint, 'smart_v3_kol_sell_cancel', cand, score);
    return;
  }

  const positions = [...active.values()].filter((p) =>
    p.tokenMint === tx.tokenMint &&
    p.participatingKols.some((k) => k.id === tx.kolId)
  );
  if (positions.length === 0) {
    log.debug(`[KOL_HUNTER] sell ${tx.kolId} ${tx.tokenMint.slice(0, 8)} (no matching active/pending position)`);
    return;
  }

  for (const pos of positions) {
    const nowSec = Math.floor(Date.now() / 1000);
    const ref = pos.marketReferencePrice;
    const mfePct = (pos.peakPrice - ref) / ref;
    const maePct = (pos.troughPrice - ref) / ref;
    closePosition(pos, pos.lastPrice, 'insider_exit_full', nowSec, mfePct, maePct);
  }
}

// ─── Pending / Stalk Window ──────────────────────────────

async function registerPending(tx: KolTx): Promise<void> {
  const tokenMint = tx.tokenMint;
  const stalkMs = config.kolHunterStalkWindowSec * 1000;
  const expiresAt = Date.now() + stalkMs;
  const timer = setTimeout(() => {
    void resolveStalk(tokenMint);
  }, stalkMs);
  if (timer.unref) timer.unref();
  pending.set(tokenMint, {
    tokenMint,
    firstKolEntryMs: tx.timestamp,
    stalkExpiresAtMs: expiresAt,
    timer,
    kolTxs: [tx],
  });
  log.info(
    `[KOL_HUNTER_STALK] ${tokenMint.slice(0, 8)} opened — kol=${tx.kolId} tier=${tx.tier} ` +
    `stalk=${config.kolHunterStalkWindowSec}s`
  );
}

async function registerSmartV3Pending(tx: KolTx): Promise<void> {
  const tokenMint = tx.tokenMint;
  if (!priceFeed) {
    log.warn(`[KOL_HUNTER_SMART_V3] priceFeed not initialized — cannot observe`);
    return;
  }

  const nowMs = Date.now();
  const score = computeKolDiscoveryScore(tokenMint, recentKolTxs, nowMs, {
    windowMs: config.kolScoringWindowMs,
    antiCorrelationMs: config.kolAntiCorrelationMs,
  });
  const preEntry = await checkKolSurvivalPreEntry(tokenMint);
  if (!preEntry.approved) {
    const rejected: PendingCandidate = {
      tokenMint,
      firstKolEntryMs: tx.timestamp,
      stalkExpiresAtMs: nowMs,
      timer: setTimeout(() => undefined, 0),
      kolTxs: [tx],
    };
    clearTimeout(rejected.timer);
    log.info(
      `[KOL_HUNTER_SMART_V3_SURVIVAL_REJECT] ${tokenMint.slice(0, 8)} ` +
      `reason=${preEntry.reason ?? 'unknown'} flags=${preEntry.flags.join(',')}`
    );
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', rejected, score, {
      survivalReason: preEntry.reason ?? null,
      survivalFlags: preEntry.flags,
      smartV3: true,
    });
    return;
  }

  priceFeed.subscribe(tokenMint);
  const firstTick = await waitForFirstTick(tokenMint, 10_000);
  if (firstTick === null) {
    priceFeed.unsubscribe(tokenMint);
    const rejected: PendingCandidate = {
      tokenMint,
      firstKolEntryMs: tx.timestamp,
      stalkExpiresAtMs: nowMs,
      timer: setTimeout(() => undefined, 0),
      kolTxs: [tx],
    };
    clearTimeout(rejected.timer);
    fireRejectObserver(tokenMint, 'smart_v3_price_timeout', rejected, score, { smartV3: true });
    return;
  }

  const entryTokenDecimals = await resolveTokenDecimalsForObserver(tokenMint, firstTick.outputDecimals);
  const observeMs = config.kolHunterSmartV3ObserveWindowSec * 1000;
  const expiresAt = Date.now() + observeMs;
  const timer = setTimeout(() => {
    void resolveSmartV3NoTrigger(tokenMint);
  }, observeMs);
  if (timer.unref) timer.unref();

  const cand: PendingCandidate = {
    tokenMint,
    firstKolEntryMs: tx.timestamp,
    stalkExpiresAtMs: expiresAt,
    timer,
    kolTxs: [tx],
    smartV3: {
      startedAtMs: Date.now(),
      observeExpiresAtMs: expiresAt,
      kolEntryPrice: firstTick.price,
      peakPrice: firstTick.price,
      currentPrice: firstTick.price,
      preEntryFlags: [
        ...preEntry.flags,
        `DECIMALS_${entryTokenDecimals.source?.toUpperCase() ?? 'UNKNOWN'}`,
      ],
      tokenDecimals: entryTokenDecimals.value,
      tokenDecimalsSource: entryTokenDecimals.source,
      resolving: false,
    },
  };
  pending.set(tokenMint, cand);
  ensurePendingPriceListener(tokenMint);
  log.info(
    `[KOL_HUNTER_SMART_V3_OBSERVE] ${tokenMint.slice(0, 8)} opened — kol=${tx.kolId} tier=${tx.tier} ` +
    `observe=${config.kolHunterSmartV3ObserveWindowSec}s entryRef=${firstTick.price.toFixed(8)}`
  );
  await evaluateSmartV3Triggers(cand);
}

function ensurePendingPriceListener(tokenMint: string): void {
  if (!priceFeed || priceListeners.has(tokenMint)) return;
  const listener = (tick: PriceTick) => {
    if (tick.tokenMint !== tokenMint) return;
    const cand = pending.get(tokenMint);
    if (cand?.smartV3) {
      cand.smartV3.currentPrice = tick.price;
      if (tick.price > cand.smartV3.peakPrice) cand.smartV3.peakPrice = tick.price;
      void evaluateSmartV3Triggers(cand);
    }
    const positions = [...active.values()].filter((p) => p.tokenMint === tokenMint);
    for (const pos of positions) onPriceTick(pos.positionId, tick);
  };
  priceListeners.set(tokenMint, listener);
  priceFeed.on('price', listener);
}

async function resolveSmartV3NoTrigger(tokenMint: string): Promise<void> {
  const cand = pending.get(tokenMint);
  if (!cand?.smartV3 || cand.smartV3.resolving) return;
  cand.smartV3.resolving = true;
  pending.delete(tokenMint);
  const score = computeKolDiscoveryScore(tokenMint, recentKolTxs, Date.now(), {
    windowMs: config.kolScoringWindowMs,
    antiCorrelationMs: config.kolAntiCorrelationMs,
  });
  cleanupPendingCandidate(cand, true);
  log.info(`[KOL_HUNTER_SMART_V3_REJECT] ${tokenMint.slice(0, 8)} no trigger`);
  fireRejectObserver(tokenMint, 'smart_v3_no_trigger', cand, score, {
    smartV3: true,
    peakPrice: cand.smartV3.peakPrice,
    currentPrice: cand.smartV3.currentPrice,
    kolEntryPrice: cand.smartV3.kolEntryPrice,
  });
}

function cleanupPendingCandidate(cand: PendingCandidate, unsubscribePrice: boolean): void {
  clearTimeout(cand.timer);
  if (!unsubscribePrice) return;
  unsubscribePriceIfIdle(cand.tokenMint);
}

function unsubscribePriceIfIdle(tokenMint: string): void {
  const hasActive = [...active.values()].some((p) => p.tokenMint === tokenMint);
  const hasPending = pending.has(tokenMint);
  if (hasActive || hasPending) return;
  const listener = priceListeners.get(tokenMint);
  if (listener) {
    priceFeed?.off('price', listener);
    priceListeners.delete(tokenMint);
  }
  priceFeed?.unsubscribe(tokenMint);
}

interface SmartV3TriggerResult {
  pullback: boolean;
  velocity: boolean;
  reason?: Extract<KolEntryReason, 'pullback' | 'velocity' | 'pullback_and_velocity'>;
  conviction?: Extract<KolConvictionLevel, 'MEDIUM_HIGH' | 'HIGH' | 'HIGH_PLUS'>;
}

function evaluateSmartV3TriggerState(cand: PendingCandidate, score: KolDiscoveryScore): SmartV3TriggerResult {
  const smart = cand.smartV3;
  if (!smart) return { pullback: false, velocity: false };

  const pullbackPct = (smart.peakPrice - smart.currentPrice) / Math.max(smart.peakPrice, 1e-12);
  const aboveKolDrawdownFloor =
    smart.currentPrice >= smart.kolEntryPrice * (1 - config.kolHunterSmartV3MaxDrawdownFromKolEntryPct);
  const pullback =
    smart.peakPrice > smart.kolEntryPrice &&
    pullbackPct >= config.kolHunterSmartV3MinPullbackPct &&
    aboveKolDrawdownFloor;

  const velocity =
    score.finalScore >= config.kolHunterSmartV3VelocityScoreThreshold &&
    score.independentKolCount >= config.kolHunterSmartV3VelocityMinIndependentKol &&
    hasSmartV3TierStrength(score.participatingKols);

  if (pullback && velocity) return { pullback, velocity, reason: 'pullback_and_velocity', conviction: 'HIGH_PLUS' };
  if (pullback) return { pullback, velocity, reason: 'pullback', conviction: 'HIGH' };
  if (velocity) return { pullback, velocity, reason: 'velocity', conviction: 'MEDIUM_HIGH' };
  return { pullback, velocity };
}

function hasSmartV3TierStrength(kols: Array<{ tier: 'S' | 'A' | 'B' }>): boolean {
  // Velocity path 의 tier 정책 (의도적):
  //  - "S+A or A+A" 의 실무 해석: S/A급 독립 판단이 2명 이상이면 velocity 신뢰.
  //  - Tier B 단독 / Tier B + Tier B 는 velocity 진입 영구 reject. (single-wallet 추세를 신호로 보지 않음)
  //  - Tier B 가 합류해도 S/A ≥ 2 가 충족되어야 velocity 통과.
  //  - Pullback path 는 별도 evaluator (`evaluatePullbackTrigger`) 에서 KOL tier 상관없이 가격 조건만 검사.
  //    즉 Tier B 단독은 pullback path 로만 진입 가능, velocity 단독으로는 절대 진입 불가.
  return kols.filter((k) => k.tier === 'S' || k.tier === 'A').length >= 2;
}

async function evaluateSmartV3Triggers(cand: PendingCandidate): Promise<void> {
  const smart = cand.smartV3;
  if (!smart || smart.resolving) return;

  const score = computeKolDiscoveryScore(cand.tokenMint, recentKolTxs, Date.now(), {
    windowMs: config.kolScoringWindowMs,
    antiCorrelationMs: config.kolAntiCorrelationMs,
  });
  const trigger = evaluateSmartV3TriggerState(cand, score);
  if (!trigger.reason || !trigger.conviction) return;

  smart.resolving = true;
  pending.delete(cand.tokenMint);
  cleanupPendingCandidate(cand, false);
  log.info(
    `[KOL_HUNTER_SMART_V3_TRIGGER] ${cand.tokenMint.slice(0, 8)} reason=${trigger.reason} ` +
    `conviction=${trigger.conviction} score=${score.finalScore.toFixed(2)} ` +
    `kols=${score.independentKolCount}`
  );
  await enterPaperPosition(cand.tokenMint, cand, score, smart.preEntryFlags, {
    parameterVersion: config.kolHunterSmartV3ParameterVersion,
    entryReason: trigger.reason,
    convictionLevel: trigger.conviction,
    tokenDecimals: smart.tokenDecimals,
    tokenDecimalsSource: smart.tokenDecimalsSource,
  });
}

async function resolveStalk(tokenMint: string): Promise<void> {
  const cand = pending.get(tokenMint);
  if (!cand) return;
  pending.delete(tokenMint);

  const nowMs = Date.now();
  const score = computeKolDiscoveryScore(tokenMint, recentKolTxs, nowMs, {
    windowMs: config.kolScoringWindowMs,
    antiCorrelationMs: config.kolAntiCorrelationMs,
  });

  // 최소 1명의 독립 KOL 이 있어야 진입 (multi-KOL 합의 선호)
  if (score.independentKolCount === 0) {
    log.info(
      `[KOL_HUNTER_STALK_EXPIRED] ${tokenMint.slice(0, 8)} no_independent_kol — reject`
    );
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score);
    return;
  }

  // MISSION_CONTROL §KOL Control 1단계: security / exit liquidity (price-independent).
  // Paper 결과를 live 와 비교하려면 동일 entry-side gate 를 통과한 분포여야 한다.
  const preEntry = await checkKolSurvivalPreEntry(tokenMint);
  if (!preEntry.approved) {
    log.info(
      `[KOL_HUNTER_SURVIVAL_REJECT] ${tokenMint.slice(0, 8)} reason=${preEntry.reason ?? 'unknown'} ` +
      `flags=${preEntry.flags.join(',')}`
    );
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score, {
      survivalReason: preEntry.reason ?? null,
      survivalFlags: preEntry.flags,
    });
    return;
  }

  // Phase 5 P1-15 (2026-04-25): live canary 명시적 opt-in.
  // KOL_HUNTER_PAPER_ONLY=false 만으로는 live 안 됨 (review feedback P0). 별도 flag 필요.
  // 본 sprint 에서는 enterLivePosition 의 Jupiter swap path 가 미구현 — flag 가 켜져 있어도
  // 안전하게 paper 로 fallback + critical alert. P1-9~14 후속 sprint 에서 enterLivePosition 구현.
  if (config.kolHunterLiveCanaryEnabled && !config.kolHunterPaperOnly) {
    log.error(
      `[KOL_HUNTER_LIVE_NOT_IMPLEMENTED] ${tokenMint.slice(0, 8)} ` +
      `KOL_HUNTER_LIVE_CANARY_ENABLED=true 이지만 enterLivePosition 미구현 — paper 로 fallback`
    );
    // paperOnly 강제 false 로 들어왔어도 실제 wallet 에는 buy 안 함 (paper path).
  } else if (!config.kolHunterPaperOnly) {
    log.warn(
      `[KOL_HUNTER] PAPER_ONLY=false 인데 LIVE_CANARY_ENABLED=false — paper 로만 동작`
    );
  }
  await enterPaperPosition(tokenMint, cand, score, preEntry.flags);
}

/**
 * MISSION_CONTROL §KOL Control survival 의 1단계 — entry price 가 필요 없는 검사 (security data,
 * exit liquidity). resolveStalk 직후 호출 (PROBE 진입 직전, price subscribe 전).
 *
 * `securityClient` 미주입 시 `kolHunterSurvivalAllowDataMissing` 에 따라 통과/거부.
 */
async function checkKolSurvivalPreEntry(
  tokenMint: string
): Promise<{ approved: boolean; reason?: string; flags: string[] }> {
  const flags: string[] = [];

  if (!securityClient) {
    if (config.kolHunterSurvivalAllowDataMissing) {
      return { approved: true, flags: ['NO_SECURITY_CLIENT'] };
    }
    return {
      approved: false,
      reason: 'no_security_client',
      flags: ['NO_SECURITY_CLIENT'],
    };
  }

  // gateCache hit (pure_ws 와 공유)
  const cached = gateCache?.get(tokenMint);
  let tokenSecurityData = cached?.tokenSecurityData ?? null;
  let exitLiquidityData = cached?.exitLiquidityData ?? null;

  if (!cached) {
    try {
      const [secData, exitData] = await Promise.all([
        securityClient.getTokenSecurityDetailed(tokenMint),
        securityClient.getExitLiquidity(tokenMint),
      ]);
      tokenSecurityData = secData;
      exitLiquidityData = exitData;
      gateCache?.set(tokenMint, {
        tokenSecurityData: secData,
        exitLiquidityData: exitData,
      });
    } catch (err) {
      log.warn(`[KOL_HUNTER_SURVIVAL] ${tokenMint.slice(0, 12)} security fetch failed: ${err}`);
      // Phase 6 P2-6: stale fallback — RPC pressure 방어.
      const stale = gateCache?.getStaleFallback(tokenMint);
      if (stale) {
        tokenSecurityData = stale.tokenSecurityData;
        exitLiquidityData = stale.exitLiquidityData;
        log.info(
          `[KOL_HUNTER_SURVIVAL_STALE_FALLBACK] ${tokenMint.slice(0, 12)} RPC fail, using stale cache`
        );
      }
    }
  }

  if (!tokenSecurityData) {
    if (config.kolHunterSurvivalAllowDataMissing) {
      return { approved: true, flags: [...flags, 'NO_SECURITY_DATA'] };
    }
    return {
      approved: false,
      reason: 'security_data_unavailable',
      flags: [...flags, 'NO_SECURITY_DATA'],
    };
  }

  const gateResult = evaluateSecurityGate(tokenSecurityData, exitLiquidityData, {
    minExitLiquidityUsd: config.kolHunterSurvivalMinExitLiquidityUsd,
    maxTop10HolderPct: config.kolHunterSurvivalMaxTop10HolderPct,
  });

  if (!gateResult.approved) {
    return {
      approved: false,
      reason: gateResult.reason,
      flags: [...flags, ...gateResult.flags],
    };
  }

  return {
    approved: true,
    flags: [...flags, ...gateResult.flags],
  };
}

/**
 * MISSION_CONTROL §KOL Control survival 의 2단계 — **size-aware** sell-quote probe.
 * (2026-04-25 review fix: 1 token raw 가 아니라 실 ticket 으로 잡힐 expected quantity 를 검증.)
 *
 * `enterPaperPosition` 가 entry price 를 확정한 직후 호출. probeTokenAmount 는 ticketSol / entryPrice
 * (즉 0.01 SOL 로 살 양). 정확한 decimals 가 없으면 sell-probe raw amount 계산에만 6 fallback 을 쓰고,
 * missed-alpha observer 에는 fallback 값을 넘기지 않는다.
 *
 * Network 실패 / rate-limit 시 false halt 방지 — observability flag 만 남기고 통과.
 */
async function checkKolSellQuoteSized(
  tokenMint: string,
  plannedQuantityUi: number,
  ticketSol: number,
  tokenDecimals?: number
): Promise<{ approved: boolean; reason?: string; flags: string[] }> {
  if (!config.kolHunterRunSellQuoteProbe) {
    return { approved: true, flags: ['SELL_PROBE_DISABLED'] };
  }
  if (!Number.isFinite(plannedQuantityUi) || plannedQuantityUi <= 0) {
    return { approved: true, flags: ['SELL_PROBE_INVALID_QTY'] };
  }
  const decimalsResolved = tokenDecimals ?? 6;
  // Why: probeTokenAmountRaw = floor(plannedQuantityUi × 10^decimals). plannedQuantityUi 가
  // 큰 (1e9+) 메모코인이라도 BigInt 변환은 안전 — Math.floor 후 stringify.
  const rawAmount = BigInt(Math.max(1, Math.floor(plannedQuantityUi * 10 ** decimalsResolved)));
  try {
    const sellResult = await evaluateSellQuoteProbe({
      tokenMint,
      probeTokenAmountRaw: rawAmount,
      expectedSolReceive: ticketSol, // round-trip 비교 — ticket 대비 회수율 측정
      tokenDecimals: decimalsResolved,
    });
    const baseFlags = [`SELL_DECIMALS_${tokenDecimals == null ? 'FALLBACK6' : decimalsResolved}`];
    if (!sellResult.routeFound) {
      return {
        approved: false,
        reason: sellResult.reason ?? 'no_sell_route',
        flags: [...baseFlags, 'NO_SELL_ROUTE'],
      };
    }
    if (!sellResult.approved) {
      return {
        approved: false,
        reason: sellResult.reason ?? 'sell_quote_rejected',
        flags: [...baseFlags, `SELL_REJECT_${(sellResult.reason ?? 'unknown').toUpperCase()}`],
      };
    }
    return { approved: true, flags: baseFlags };
  } catch (err) {
    log.debug(`[KOL_HUNTER_SURVIVAL] sellQuoteProbe error ${tokenMint.slice(0, 12)}: ${err}`);
    // false halt 방지 — observability flag 만 남기고 진입 허용
    return { approved: true, flags: ['SELL_QUOTE_ERROR'] };
  }
}

async function resolveTokenDecimalsForObserver(
  tokenMint: string,
  quoteDecimals: number | null
): Promise<{ value?: number; source?: 'security_client' | 'jupiter_quote' }> {
  if (securityClient) {
    try {
      const decimals = await securityClient.getMintDecimals(tokenMint);
      if (
        typeof decimals === 'number' &&
        Number.isFinite(decimals) &&
        decimals >= 0 &&
        decimals <= 18
      ) {
        return { value: decimals, source: 'security_client' };
      }
    } catch (err) {
      log.debug(`[KOL_HUNTER_SURVIVAL] decimals fetch error ${tokenMint.slice(0, 12)}: ${err}`);
    }
  }

  if (
    typeof quoteDecimals === 'number' &&
    Number.isFinite(quoteDecimals) &&
    quoteDecimals >= 0 &&
    quoteDecimals <= 18
  ) {
    return { value: quoteDecimals, source: 'jupiter_quote' };
  }

  return {};
}

// ─── Paper Entry ─────────────────────────────────────────

async function enterPaperPosition(
  tokenMint: string,
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  survivalFlags: string[] = [],
  options: PaperEntryOptions = {}
): Promise<void> {
  if (!priceFeed) {
    log.warn(`[KOL_HUNTER] priceFeed not initialized — cannot enter`);
    return;
  }

  // 1. Entry price 측정 — priceFeed subscribe 후 최초 tick 까지 대기 (또는 1회 poll)
  // 2026-04-26 P1 fix: price tick 의 known decimals 와 security decimals 를 분리해서 stash.
  // fallback 6 은 observer 로 넘기지 않아 잘못된 post-close delta 를 막는다.
  priceFeed.subscribe(tokenMint);
  const firstTick = await waitForFirstTick(tokenMint, 10_000);
  if (firstTick === null) {
    unsubscribePriceIfIdle(tokenMint);
    log.warn(`[KOL_HUNTER] entry price fetch timeout ${tokenMint.slice(0, 8)}`);
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score);
    return;
  }
  const entryPrice = firstTick.price;
  const entryTokenDecimals = typeof options.tokenDecimals === 'number'
    ? { value: options.tokenDecimals, source: options.tokenDecimalsSource }
    : await resolveTokenDecimalsForObserver(tokenMint, firstTick.outputDecimals);

  const ticketSol = config.kolHunterTicketSol;
  const nowSec = Math.floor(Date.now() / 1000);
  const positionId = `kolh-${tokenMint.slice(0, 8)}-${nowSec}`;
  const quantity = entryPrice > 0 ? ticketSol / entryPrice : 0;
  const primaryVersion = options.parameterVersion ?? config.kolHunterParameterVersion;

  // MISSION_CONTROL §KOL Control 2단계 — size-aware sell-quote probe.
  // 0.01 SOL 로 살 plannedQuantity 그대로를 매도 quote 로 검증 (1 token 가짜 probe 가 아님).
  // 거부되면 PROBE 진입 자체를 막아 paper 결과의 sell-side viability 분포를 정확히 측정.
  const sellSized = await checkKolSellQuoteSized(tokenMint, quantity, ticketSol, entryTokenDecimals.value);
  if (!sellSized.approved) {
    unsubscribePriceIfIdle(tokenMint);
    log.info(
      `[KOL_HUNTER_SELL_REJECT] ${tokenMint.slice(0, 8)} qty=${quantity.toFixed(2)} ticket=${ticketSol}SOL ` +
      `reason=${sellSized.reason ?? 'unknown'} flags=${sellSized.flags.join(',')}`
    );
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score, {
      survivalReason: sellSized.reason ?? null,
      survivalFlags: [...survivalFlags, ...sellSized.flags],
      plannedQuantity: quantity,
      ticketSol,
      entryPrice,
    });
    return;
  }
  const combinedSurvivalFlags = [
    ...survivalFlags,
    ...sellSized.flags,
    `DECIMALS_${entryTokenDecimals.source?.toUpperCase() ?? 'UNKNOWN'}`,
  ];
  const swingEligible = primaryVersion === config.kolHunterParameterVersion && isSwingV2Eligible(score);

  const makePosition = (
    id: string,
    parameterVersion: string,
    isShadowArm: boolean,
    parentPositionId?: string
  ): PaperPosition => {
    const entryReason = parameterVersion === primaryVersion
      ? options.entryReason ?? defaultEntryReasonForVersion(parameterVersion)
      : defaultEntryReasonForVersion(parameterVersion);
    const convictionLevel = parameterVersion === primaryVersion
      ? options.convictionLevel ?? defaultConvictionForVersion(parameterVersion)
      : defaultConvictionForVersion(parameterVersion);
    const dynamicExit = parameterVersion === config.kolHunterSmartV3ParameterVersion
      ? dynamicExitParamsForEntry(entryReason)
      : {};
    return {
      positionId: id,
      tokenMint,
      state: 'PROBE',
      entryPrice,
      entryTimeSec: nowSec,
      ticketSol,
      quantity,
      marketReferencePrice: entryPrice,
      peakPrice: entryPrice,
      troughPrice: entryPrice,
      lastPrice: entryPrice,
      participatingKols: score.participatingKols.map((k) => ({ ...k })),
      kolScore: score.finalScore,
      armName: armNameForVersion(parameterVersion),
      parameterVersion,
      isShadowArm,
      parentPositionId,
      kolEntryReason: entryReason,
      kolConvictionLevel: convictionLevel,
      t1MfeOverride: dynamicExit.t1Mfe,
      t1TrailPctOverride: dynamicExit.t1TrailPct,
      t1ProfitFloorMult: dynamicExit.t1ProfitFloorMult,
      probeFlatTimeoutSec: dynamicExit.probeFlatTimeoutSec,
      kolReinforcementCount: 0,
      detectorVersion: config.kolHunterDetectorVersion,
      independentKolCount: score.independentKolCount,
      survivalFlags: combinedSurvivalFlags,
      tokenDecimals: entryTokenDecimals.value,
      tokenDecimalsSource: entryTokenDecimals.source,
    };
  };

  const positions = [
    makePosition(positionId, primaryVersion, false),
  ];
  if (swingEligible) {
    positions.push(
      makePosition(`${positionId}-swing-v2`, config.kolHunterSwingV2ParameterVersion, true, positionId)
    );
    log.info(
      `[KOL_HUNTER_SWING_V2] ${positionId} ${tokenMint.slice(0, 8)} ` +
      `kols=${score.independentKolCount} score=${score.finalScore.toFixed(2)} ` +
      `stalk=${config.kolHunterSwingV2StalkWindowSec}s trail=${(config.kolHunterSwingV2T1TrailPct * 100).toFixed(0)}% ` +
      `profitFloor=${config.kolHunterSwingV2T1ProfitFloorMult}x`
    );
  }

  for (const pos of positions) {
    active.set(pos.positionId, pos);
    log.info(
      `[KOL_HUNTER_PAPER_ENTER] ${pos.positionId} ${tokenMint.slice(0, 8)} ` +
      `arm=${pos.armName}${pos.isShadowArm ? ' shadow' : ''} ` +
      `entry=${entryPrice.toFixed(8)} ticket=${ticketSol}SOL kols=${score.independentKolCount} ` +
      `score=${score.finalScore.toFixed(2)}`
    );
  }

  // 2. price listener 등록 — token 별 fan-out 으로 v1/v2 shadow arm 을 동시에 평가
  ensurePriceListener(tokenMint);

  for (const pos of positions) kolHunterEvents.emit('paper_entry', pos);
}

/**
 * 2026-04-26 P1 fix: 첫 tick 전체 (price + outputDecimals) 반환.
 * 기존 waitForFirstPrice 는 price 만 반환 → decimals 유실 → missed_alpha decimals_unknown.
 * 본 helper 가 PaperPosition 의 tokenDecimals stash 핵심.
 */
async function waitForFirstTick(
  tokenMint: string,
  timeoutMs: number
): Promise<{ price: number; outputDecimals: number | null } | null> {
  if (!priceFeed) return null;
  const cached = priceFeed.getLastTick?.(tokenMint);
  if (cached) return { price: cached.price, outputDecimals: cached.outputDecimals };

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      priceFeed?.off('price', handler);
      resolve(null);
    }, timeoutMs);
    const handler = (tick: PriceTick) => {
      if (tick.tokenMint !== tokenMint) return;
      clearTimeout(timeout);
      priceFeed?.off('price', handler);
      resolve({ price: tick.price, outputDecimals: tick.outputDecimals });
    };
    priceFeed?.on('price', handler);
  });
}

function ensurePriceListener(tokenMint: string): void {
  if (!priceFeed || priceListeners.has(tokenMint)) return;
  const listener = (tick: PriceTick) => {
    if (tick.tokenMint !== tokenMint) return;
    const positions = [...active.values()].filter((p) => p.tokenMint === tokenMint);
    for (const pos of positions) onPriceTick(pos.positionId, tick);
  };
  priceListeners.set(tokenMint, listener);
  priceFeed.on('price', listener);
}

// ─── State Machine ───────────────────────────────────────

function onPriceTick(positionId: string, tick: PriceTick): void {
  const pos = active.get(positionId);
  if (!pos || pos.state === 'CLOSED') return;

  const currentPrice = tick.price;
  if (currentPrice <= 0) return;
  pos.lastPrice = currentPrice;

  // Market reference peak/trough
  if (currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;
  if (currentPrice < pos.troughPrice) pos.troughPrice = currentPrice;

  const ref = pos.marketReferencePrice;
  const mfePct = (pos.peakPrice - ref) / ref;
  const maePct = (pos.troughPrice - ref) / ref;
  const currentPct = (currentPrice - ref) / ref;
  const nowSec = Math.floor(Date.now() / 1000);
  const elapsedSec = nowSec - pos.entryTimeSec;

  switch (pos.state) {
    case 'PROBE': {
      // 1. Hard cut (Lane T 파라미터: -10%)
      if (maePct <= -config.kolHunterHardcutPct) {
        closePosition(pos, currentPrice, 'probe_hard_cut', nowSec, mfePct, maePct);
        return;
      }
      // 2. Quick reject classifier (Lane T: 180s + 3 factor)
      // paper 는 microstructure data 없음 → elapsed + price 기반 단순 휴리스틱
      if (elapsedSec <= config.kolHunterQuickRejectWindowSec) {
        const factors = countQuickRejectFactors(pos, currentPrice, elapsedSec);
        if (factors >= config.kolHunterQuickRejectFactorCount) {
          closePosition(pos, currentPrice, 'quick_reject_classifier_exit', nowSec, mfePct, maePct);
          return;
        }
      }
      // 3. Flat timeout (stalk 후에도 +10% band 안 넘으면 timeout)
      // arm 별 timeout 적용. smart-v3 는 entry reason 별 RR confidence 를 반영한다.
      const armStalkSec = pos.probeFlatTimeoutSec
        ?? (isSwingV2Position(pos) ? config.kolHunterSwingV2StalkWindowSec : config.kolHunterStalkWindowSec);
      if (elapsedSec >= armStalkSec) {
        const inFlatBand = Math.abs(currentPct) <= 0.10;
        if (inFlatBand) {
          closePosition(pos, currentPrice, 'probe_reject_timeout', nowSec, mfePct, maePct);
          return;
        }
      }
      // 4. Probe trail (flat band 벗어난 후 pullback)
      if (pos.peakPrice > pos.entryPrice) {
        const trailStop = pos.peakPrice * (1 - 0.15);
        if (currentPrice <= trailStop) {
          closePosition(pos, currentPrice, 'probe_flat_cut', nowSec, mfePct, maePct);
          return;
        }
      }
      // 5. T1 promote
      if (mfePct >= (pos.t1MfeOverride ?? config.kolHunterT1Mfe)) {
        pos.state = 'RUNNER_T1';
        pos.t1VisitAtSec = nowSec;
        log.info(`[KOL_HUNTER_T1] ${pos.positionId} promoted MFE=${(mfePct * 100).toFixed(2)}%`);
      }
      break;
    }

    case 'RUNNER_T1': {
      if (mfePct >= config.kolHunterT2Mfe) {
        pos.state = 'RUNNER_T2';
        pos.t2VisitAtSec = nowSec;
        pos.t2BreakevenLockPrice = pos.marketReferencePrice * config.kolHunterT2BreakevenLockMult;
        log.info(
          `[KOL_HUNTER_T2] ${pos.positionId} promoted MFE=${(mfePct * 100).toFixed(2)}% ` +
          `lock=${pos.t2BreakevenLockPrice.toFixed(8)}`
        );
        break;
      }
      if (detectHoldPhaseDegraded(pos, currentPrice)) {
        closePosition(pos, currentPrice, 'hold_phase_sentinel_degraded_exit', nowSec, mfePct, maePct);
        return;
      }
      // 2026-04-26 swing-v2: T1 trail 25% (vs v1 15%) + profit floor entry × 1.10.
      // Why: KOL discovery edge 는 "스윙 winner" — T1 winner 가 너무 빨리 손실 전환되는 것 방지.
      //   profit floor 는 stop 하한선이다. price 가 floor 아래로 내려가면 close 해서 수익 반납을 막는다.
      const t1TrailPct = pos.t1TrailPctOverride
        ?? (isSwingV2Position(pos) ? config.kolHunterSwingV2T1TrailPct : config.kolHunterT1TrailPct);
      const rawTrailStop = pos.peakPrice * (1 - t1TrailPct);
      const profitFloorMult = pos.t1ProfitFloorMult
        ?? (isSwingV2Position(pos) ? config.kolHunterSwingV2T1ProfitFloorMult : undefined);
      const trailStop = profitFloorMult != null
        ? Math.max(rawTrailStop, pos.entryPrice * profitFloorMult)
        : rawTrailStop;
      if (currentPrice <= trailStop) {
        closePosition(pos, currentPrice, 'winner_trailing_t1', nowSec, mfePct, maePct);
        return;
      }
      break;
    }

    case 'RUNNER_T2': {
      if (mfePct >= config.kolHunterT3Mfe) {
        pos.state = 'RUNNER_T3';
        pos.t3VisitAtSec = nowSec;
        log.info(`[KOL_HUNTER_T3] ${pos.positionId} promoted MFE=${(mfePct * 100).toFixed(2)}%`);
        break;
      }
      if (detectHoldPhaseDegraded(pos, currentPrice)) {
        closePosition(pos, currentPrice, 'hold_phase_sentinel_degraded_exit', nowSec, mfePct, maePct);
        return;
      }
      const trailStop = Math.max(
        pos.peakPrice * (1 - config.kolHunterT2TrailPct),
        pos.t2BreakevenLockPrice ?? pos.marketReferencePrice * config.kolHunterT2BreakevenLockMult
      );
      if (currentPrice <= trailStop) {
        closePosition(pos, currentPrice, 'winner_trailing_t2', nowSec, mfePct, maePct);
        return;
      }
      break;
    }

    case 'RUNNER_T3': {
      // no time stop
      const trailStop = pos.peakPrice * (1 - config.kolHunterT3TrailPct);
      if (currentPrice <= trailStop) {
        closePosition(pos, currentPrice, 'winner_trailing_t3', nowSec, mfePct, maePct);
        return;
      }
      break;
    }
  }
}

// ─── Quick Reject / Hold Phase (paper 용 단순 휴리스틱) ───

function countQuickRejectFactors(pos: PaperPosition, currentPrice: number, elapsedSec: number): number {
  // Paper 모드에서는 candle microstructure 데이터 없음 → price-based 휴리스틱
  // Phase 4+ live 에서는 실 candle / buy ratio / tx density 사용 예정
  let factors = 0;
  const mfeSoFar = (pos.peakPrice - pos.marketReferencePrice) / pos.marketReferencePrice;
  const currentPct = (currentPrice - pos.marketReferencePrice) / pos.marketReferencePrice;
  // (a) mfe 낮음
  if (mfeSoFar < 0.02 && elapsedSec > 30) factors += 1;
  // (b) 가격 감소 중
  if (currentPct < -0.05) factors += 1;
  // (c) peak 로부터 deep pullback
  const pullback = (pos.peakPrice - currentPrice) / Math.max(pos.peakPrice, 1e-12);
  if (pullback > 0.20) factors += 1;
  return factors;
}

function detectHoldPhaseDegraded(pos: PaperPosition, currentPrice: number): boolean {
  // Paper: peak 로부터 큰 drop + price 감소 지속 시 degraded 판정
  const peakDrift = (pos.peakPrice - currentPrice) / Math.max(pos.peakPrice, 1e-12);
  return peakDrift > 0.30;
}

// ─── Close ───────────────────────────────────────────────

function closePosition(
  pos: PaperPosition,
  exitPrice: number,
  reason: CloseReason,
  nowSec: number,
  mfePctAtClose: number,
  maePctAtClose: number
): void {
  pos.state = 'CLOSED';

  const holdSec = nowSec - pos.entryTimeSec;
  const netPct = (exitPrice - pos.entryPrice) / pos.entryPrice;
  const paperRoundTripCostPct = config.kolHunterPaperRoundTripCostPct;
  const netSol = pos.ticketSol * (netPct - paperRoundTripCostPct);

  log.info(
    `[KOL_HUNTER_PAPER_CLOSE] ${pos.positionId} reason=${reason} ` +
    `hold=${holdSec}s mfe=${(mfePctAtClose * 100).toFixed(2)}% mae=${(maePctAtClose * 100).toFixed(2)}% ` +
    `net=${(netPct * 100).toFixed(2)}% t1=${pos.t1VisitAtSec ? 'y' : 'n'} ` +
    `t2=${pos.t2VisitAtSec ? 'y' : 'n'} t3=${pos.t3VisitAtSec ? 'y' : 'n'}`
  );

  // Observer 훅 (5 close category + 3 winner category)
  const observerCategory: MissedAlphaEvent['rejectCategory'] =
    reason === 'probe_hard_cut' ? 'probe_hard_cut'
    : reason === 'probe_reject_timeout' ? 'probe_reject_timeout'
    : reason === 'probe_flat_cut' ? 'probe_flat_cut'
    : reason === 'quick_reject_classifier_exit' ? 'quick_reject_classifier_exit'
    : reason === 'hold_phase_sentinel_degraded_exit' ? 'hold_phase_sentinel_degraded_exit'
    : 'other';

  trackRejectForMissedAlpha(
    {
      rejectCategory: observerCategory,
      rejectReason: reason,
      tokenMint: pos.tokenMint,
      lane: LANE_STRATEGY,
      signalPrice: pos.marketReferencePrice,
      probeSolAmount: pos.ticketSol,
      // 2026-04-26 P1 fix: decimals_unknown 차단 — entry 시 stash 한 값 전파
      tokenDecimals: pos.tokenDecimals,
      signalSource: `kol_hunter:${pos.participatingKols.map((k) => k.id).join(',')}`,
      extras: {
        closeState: pos.state,
        elapsedSecAtClose: holdSec,
        mfePctAtClose,
        maePctAtClose,
        entryPrice: pos.entryPrice,
        exitPrice,
        peakPrice: pos.peakPrice,
        troughPrice: pos.troughPrice,
        t1VisitAtSec: pos.t1VisitAtSec ?? null,
        t2VisitAtSec: pos.t2VisitAtSec ?? null,
        t3VisitAtSec: pos.t3VisitAtSec ?? null,
        kolScore: pos.kolScore,
        armName: pos.armName,
        parameterVersion: pos.parameterVersion,
        isShadowArm: pos.isShadowArm,
        parentPositionId: pos.parentPositionId ?? null,
        kolEntryReason: pos.kolEntryReason,
        kolConvictionLevel: pos.kolConvictionLevel,
        kolReinforcementCount: pos.kolReinforcementCount,
        t1MfeOverride: pos.t1MfeOverride ?? null,
        t1TrailPctOverride: pos.t1TrailPctOverride ?? null,
        t1ProfitFloorMult: pos.t1ProfitFloorMult ?? null,
        probeFlatTimeoutSec: pos.probeFlatTimeoutSec ?? null,
        tokenDecimalsSource: pos.tokenDecimalsSource ?? null,
      },
    },
    buildObserverConfig()
  );

  // Paper ledger append
  void appendPaperLedger(pos, exitPrice, reason, holdSec, mfePctAtClose, maePctAtClose, netSol, netPct);

  active.delete(pos.positionId);

  // price feed unsubscribe — token 의 모든 A/B arm 이 닫힌 뒤에만 정리
  unsubscribePriceIfIdle(pos.tokenMint);

  kolHunterEvents.emit('paper_close', { pos, reason, exitPrice, netSol, netPct });
}

/**
 * Paper ledger writer (`kol-paper-trades.jsonl`).
 *
 * Cohort dimension policy (F7 verification, 2026-04-26):
 *  - paper Kelly P1 의 cohort 는 `lane × armName/(kolEntryReason)/(convictionLevel)` 로 sub-구분.
 *    `kol-paper-arm-report.ts` 가 이 ledger 를 직접 읽어 `${arm}/${kolEntryReason}/${conviction}`
 *    형태의 arm key 를 생성한다 (sub-arm).
 *  - **live 이전 시 필수**: kol_hunter 가 Stage 4 SCALE 로 승격하여 `executed-buys.jsonl` 을
 *    쓰게 되면, 그 ledger entry 에도 `armName` 에 entryReason/conviction 을 인코딩하거나
 *    별도 필드를 추가해야 lane-edge-controller P1 의 cohort 가 이 차원을 보존한다.
 *    (현재 P0/P1 cohort 는 laneName × armName × discoverySource 만 — entryReason 차원은
 *    armName 인코딩으로 흡수한다.)
 */
async function appendPaperLedger(
  pos: PaperPosition,
  exitPrice: number,
  reason: CloseReason,
  holdSec: number,
  mfePct: number,
  maePct: number,
  netSol: number,
  netPct: number
): Promise<void> {
  try {
    const dir = config.realtimeDataDir;
    await mkdir(dir, { recursive: true });
    const record = {
      positionId: pos.positionId,
      strategy: LANE_STRATEGY,
      tokenMint: pos.tokenMint,
      entryPrice: pos.entryPrice,
      exitPrice,
      marketReferencePrice: pos.marketReferencePrice,
      peakPrice: pos.peakPrice,
      troughPrice: pos.troughPrice,
      mfePctPeak: mfePct,
      maePct,
      netPct,
      netSol,
      holdSec,
      exitReason: reason,
      t1VisitAtSec: pos.t1VisitAtSec ?? null,
      t2VisitAtSec: pos.t2VisitAtSec ?? null,
      t3VisitAtSec: pos.t3VisitAtSec ?? null,
      kols: pos.participatingKols,
      kolScore: pos.kolScore,
      // MISSION_CONTROL §Control 5 telemetry — arm identity + discovery context + parameter trace.
      lane: LANE_STRATEGY,
      armName: pos.armName,
      parameterVersion: pos.parameterVersion,
      isShadowArm: pos.isShadowArm,
      parentPositionId: pos.parentPositionId ?? null,
      kolEntryReason: pos.kolEntryReason,
      kolConvictionLevel: pos.kolConvictionLevel,
      kolReinforcementCount: pos.kolReinforcementCount,
      t1MfeOverride: pos.t1MfeOverride ?? null,
      t1TrailPctOverride: pos.t1TrailPctOverride ?? null,
      t1ProfitFloorMult: pos.t1ProfitFloorMult ?? null,
      probeFlatTimeoutSec: pos.probeFlatTimeoutSec ?? null,
      detectorVersion: pos.detectorVersion,
      independentKolCount: pos.independentKolCount,
      survivalFlags: pos.survivalFlags,
      tokenDecimals: pos.tokenDecimals ?? null,
      tokenDecimalsSource: pos.tokenDecimalsSource ?? null,
      closedAt: new Date().toISOString(),
    };
    await appendFile(path.join(dir, 'kol-paper-trades.jsonl'), JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    log.debug(`[KOL_HUNTER] paper ledger append failed: ${String(err)}`);
  }
}

// ─── Observer (reject side) ──────────────────────────────

function fireRejectObserver(
  tokenMint: string,
  reason: CloseReason,
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  extras: Record<string, unknown> = {}
): void {
  // Pre-entry reject — 진입 안 된 pair 의 trajectory 관측
  trackRejectForMissedAlpha(
    {
      rejectCategory: 'viability', // pre-entry stalk expire 를 viability 류로 분류
      rejectReason: reason,
      tokenMint,
      lane: LANE_STRATEGY,
      signalPrice: 0.01, // unknown — use probe sol
      probeSolAmount: config.kolHunterTicketSol,
      signalSource: `kol_hunter_stalk:${cand.kolTxs[0]?.kolId ?? 'unknown'}`,
      extras: {
        stalkDurationMs: Date.now() - cand.firstKolEntryMs,
        kolCount: cand.kolTxs.length,
        independentKolCount: score.independentKolCount,
        kolScore: score.finalScore,
        parameterVersion: config.kolHunterParameterVersion,
        detectorVersion: config.kolHunterDetectorVersion,
        ...extras,
      },
    },
    buildObserverConfig()
  );
}

// ─── Helpers ─────────────────────────────────────────────

function buildObserverConfig() {
  return {
    enabled: config.missedAlphaObserverEnabled,
    offsetsSec: config.missedAlphaObserverOffsetsSec,
    jitterPct: config.missedAlphaObserverJitterPct,
    maxInflight: config.missedAlphaObserverMaxInflight,
    dedupWindowSec: config.missedAlphaObserverDedupWindowSec,
    outputFile: path.join(config.realtimeDataDir, 'missed-alpha.jsonl'),
    jupiterApiUrl: config.jupiterApiUrl,
    jupiterApiKey: config.jupiterApiKey,
  };
}

// ─── Test utilities ──────────────────────────────────────

/** 테스트 전용: price feed override + 직접 시뮬레이션. */
export function __testInit(options: { priceFeed: PaperPriceFeed }): void {
  stopKolHunter();
  initKolHunter({ priceFeed: options.priceFeed });
}

export function __testGetActive(): PaperPosition[] {
  return [...active.values()];
}

export function __testForceResolveStalk(tokenMint: string): Promise<void> {
  const cand = pending.get(tokenMint);
  if (cand?.smartV3) return resolveSmartV3NoTrigger(tokenMint);
  return resolveStalk(tokenMint);
}

export function __testTriggerTick(positionId: string, price: number): void {
  const pos = active.get(positionId);
  if (!pos) return;
  onPriceTick(positionId, {
    tokenMint: pos.tokenMint,
    price,
    outAmountUi: 0.01 / price,
    outputDecimals: 6,
    probeSolAmount: 0.01,
    timestamp: Date.now(),
  });
}
