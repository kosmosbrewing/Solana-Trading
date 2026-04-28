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
import { getKolLaneRole, getKolTradingStyle } from '../kol/db';
import { PaperPriceFeed, type PriceTick } from '../kol/paperPriceFeed';
import { trackRejectForMissedAlpha, type MissedAlphaEvent } from '../observability/missedAlphaObserver';
import { evaluateSecurityGate } from '../gate/securityGate';
import { evaluateSellQuoteProbe } from '../gate/sellQuoteProbe';
import type { OnchainSecurityClient } from '../ingester/onchainSecurity';
import type { GateCacheManager } from '../gate/gateCacheManager';
// 2026-04-27 (KOL live canary): pure_ws live path 와 동일 패턴.
import type { Order } from '../utils/types';
import type { BotContext } from './types';
import { acquireCanarySlot, releaseCanarySlot } from '../risk/canaryConcurrencyGuard';
import { reportCanaryClose } from '../risk/canaryAutoHalt';
import { reportBleed } from '../risk/dailyBleedBudget';
import { isWalletStopActive, getWalletStopGuardState } from '../risk/walletStopGuard';
import { persistOpenTradeWithIntegrity, appendEntryLedger, isEntryHaltActive, triggerEntryHalt } from './entryIntegrity';
import { resolveActualEntryMetrics } from './signalProcessor';
import { bpsToDecimal } from '../utils/units';

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
  | 'stalk_expired_no_consensus'
  // 2026-04-27 (P1 audit fix): live canary closeLivePosition 의 orphan path 에서 사용.
  // 기존 cast `as unknown as CloseReason` 제거 — type safety 회복.
  | 'ORPHAN_NO_BALANCE';

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
  /**
   * 2026-04-28: inactive (shadow) KOL 만으로 trigger 된 paper position 여부.
   * true 면 active KOL paper 분포와 분리된 ledger (`kol-shadow-paper-trades.jsonl`) 로 dump.
   * 결정 정책: cand.kolTxs 의 모든 tx 가 isShadow=true 일 때만 shadow. active 가 1명이라도
   * 끼면 active 우선 (downgrade 안 함).
   */
  isShadowKol?: boolean;
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
  // 2026-04-27 (KOL live canary): live wallet path 진입 여부.
  // closePosition 가 isLive=true 면 live sell + DB close + canary release 까지 처리.
  // 기본값 false (paper). enterLivePosition 만 true 로 설정.
  isLive?: boolean;
  /** Live position 의 DB tradeId — closeTrade 시 사용. */
  dbTradeId?: string;
  /** Live entry tx signature — ledger / notifier 에 전파. */
  entryTxSignature?: string;
  /** Live entry slippage (bps) — ledger 기록용. */
  entrySlippageBps?: number;
  /**
   * 2026-04-28 F2 fix: live close failure 의 critical notifier 60s cooldown.
   * 이전 코드는 `nowSec - entryTimeSec >= 60s` 라 entry 직후 60s 내 sell 실패 시 critical 미발사.
   * cupsey/pure_ws/migration 패턴 동일 — 마지막 critical 발사 시각 비교.
   */
  lastCloseFailureAtSec?: number;
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
// 2026-04-26 P1 audit fix #5: O(N) `[...active.values()].filter(p => p.tokenMint === X)` 패턴이
// 매 price tick / kol_swap 마다 hot path 에 등장. token → positionId Set 인덱스로 O(1) 화.
// 항상 active 와 동기화 (setActivePosition / deleteActivePosition wrapper 만 사용).
const activeByMint = new Map<string, Set<string>>();
function setActivePosition(pos: PaperPosition): void {
  active.set(pos.positionId, pos);
  let set = activeByMint.get(pos.tokenMint);
  if (!set) {
    set = new Set();
    activeByMint.set(pos.tokenMint, set);
  }
  set.add(pos.positionId);
}
function deleteActivePosition(positionId: string): void {
  const pos = active.get(positionId);
  if (!pos) return;
  active.delete(positionId);
  const set = activeByMint.get(pos.tokenMint);
  if (set) {
    set.delete(positionId);
    if (set.size === 0) activeByMint.delete(pos.tokenMint);
  }
}
function getActivePositionsByMint(tokenMint: string): PaperPosition[] {
  const set = activeByMint.get(tokenMint);
  if (!set || set.size === 0) return [];
  const out: PaperPosition[] = [];
  for (const id of set) {
    const pos = active.get(id);
    if (pos) out.push(pos);
  }
  return out;
}
const recentKolTxs: KolTx[] = [];                           // scoring 용 buffer (24h)

// 2026-04-26 P0 audit fix #2: shift while-loop 가 O(N) per push 라 24h × N KOLs × tx-rate 누적 시
// 매 신규 tx 마다 30k+ shift = handler latency 누적. push 마다 prune 대신 batch (1024 마다 1회).
const RECENT_TX_PRUNE_BATCH = 1024;
let pushesSinceLastPrune = 0;
function pruneRecentKolTxsByCutoff(cutoffMs: number): void {
  // 첫 retain index 찾기 → 단 1회 splice. shift while 루프보다 O(N) 한 번으로 감소.
  let firstKeep = 0;
  while (firstKeep < recentKolTxs.length && recentKolTxs[firstKeep].timestamp < cutoffMs) {
    firstKeep++;
  }
  if (firstKeep > 0) recentKolTxs.splice(0, firstKeep);
}

// 2026-04-26 P1 audit fix #7: computeKolDiscoveryScore 가 같은 token 에 대해 5 호출 사이트
// (handleKolSwap / registerSmartV3Pending / resolveSmartV3NoTrigger / evaluateSmartV3Triggers /
// resolveStalk) 에서 호출됨. 매번 30k+ recentKolTxs 풀 스캔 → tx burst 시 CPU spike.
// → 토큰별로 (recentKolTxs.length, nowMs/SCORE_CACHE_BUCKET_MS) 키로 결과 캐싱.
// recentKolTxs 가 push/splice 될 때마다 length 가 바뀌므로 자동 invalidation.
const SCORE_CACHE_BUCKET_MS = 1000;  // 1s bucket — 같은 second 내 중복 호출만 캐시 hit
const scoreCache = new Map<string, { recentTxsLen: number; nowBucket: number; score: KolDiscoveryScore }>();
function computeKolDiscoveryScoreCached(tokenMint: string, nowMs: number): KolDiscoveryScore {
  const bucket = Math.floor(nowMs / SCORE_CACHE_BUCKET_MS);
  const cached = scoreCache.get(tokenMint);
  if (
    cached &&
    cached.recentTxsLen === recentKolTxs.length &&
    cached.nowBucket === bucket
  ) {
    return cached.score;
  }
  const score = computeKolDiscoveryScore(tokenMint, recentKolTxs, nowMs, {
    windowMs: config.kolScoringWindowMs,
    antiCorrelationMs: config.kolAntiCorrelationMs,
  });
  scoreCache.set(tokenMint, { recentTxsLen: recentKolTxs.length, nowBucket: bucket, score });
  // Cache size cap — 1000 token (스캐닝 token 수가 그 이상이면 LRU 효과로 oldest 제거)
  if (scoreCache.size > 1000) {
    const firstKey = scoreCache.keys().next().value;
    if (firstKey) scoreCache.delete(firstKey);
  }
  return score;
}
let priceFeed: PaperPriceFeed | null = null;
const priceListeners = new Map<string, (tick: PriceTick) => void>(); // tokenMint → fan-out handler

// 2026-04-28 (P0-2A fix, ralph-loop): inflight dedup for live entry path.
// Why: KOL hunter 가 cupsey/pure_ws 패턴의 inflight guard 누락 — 동일 mint 동시 signal
// 들어오면 enterLivePosition 두 번 진입 → executeBuy 두 번 + DB duplicate row 위험.
// pure_ws 의 inflightEntryByPair 와 cupsey 의 enteringLock 패턴 동일.
// live entry 전체 lifetime (subscribe → first tick → executeBuy → persist) 동안 보호.
const inflightLiveEntry = new Set<string>();

/**
 * MISSION_CONTROL §KOL Control survival 의존성 (2026-04-25):
 * Phase 3 paper-mode 도 live 와 동일한 entry-side gate 를 거쳐야 paper 결과가 live 비교 가능.
 * `initKolHunter({ securityClient, gateCache })` 로 주입. 미주입 시 survival 단계 skip
 * (config.kolHunterSurvivalAllowDataMissing 동작과 동일).
 */
let securityClient: OnchainSecurityClient | undefined;
let gateCache: GateCacheManager | undefined;
// 2026-04-27 (KOL live canary): ctx 보존 — closePosition 등 deep call site 에서 사용.
// initKolHunter 시 주입. paper-only 경로에선 unused (graceful null check).
let botCtx: BotContext | undefined;

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

  // 2026-04-28 (P2 fix): trail buildup 을 style-aware 로 변경 — buildup/reduce 비대칭 해결.
  // 이전: 모든 KOL buy → trail += inc (style 무관). Phase 1 의 lower_confidence (scalper sell)
  //   가 trail -= inc 했는데 scalper buy 가 다시 trail += inc → 정책 효과 약화.
  // 수정: scalper KOL buy 는 trail 변경 안 함 (reinforcementCount 만 +1). longhold/swing/unknown
  //   buy 만 trail buildup. unknown 은 보수적 fallback (기존 default 보존, 운영자 분류 후 점진).
  const buyerStyle = getKolTradingStyle(tx.kolId);
  if (buyerStyle === 'scalper') {
    log.info(
      `[KOL_REINFORCEMENT] ${pos.positionId} +1 from kol=${tx.kolId} tier=${tx.tier} (scalper — trail unchanged)`
    );
    return;
  }
  const nextTrail = Math.min(
    config.kolHunterSmartV3ReinforcementTrailMax,
    (pos.t1TrailPctOverride ?? config.kolHunterT1TrailPct) + config.kolHunterSmartV3ReinforcementTrailInc
  );
  pos.t1TrailPctOverride = nextTrail;
  log.info(
    `[KOL_REINFORCEMENT] ${pos.positionId} +1 from kol=${tx.kolId} tier=${tx.tier} style=${buyerStyle} ` +
    `trail=${(nextTrail * 100).toFixed(1)}% floor=${pos.t1ProfitFloorMult ?? 'none'}`
  );
}

// ─── Init / Shutdown ─────────────────────────────────────

export function initKolHunter(
  options: {
    priceFeed?: PaperPriceFeed;
    securityClient?: OnchainSecurityClient;
    gateCache?: GateCacheManager;
    ctx?: BotContext;
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
  // 2026-04-27 (KOL live canary): ctx 주입 — live path (executeBuy/executeSell, DB persist) 에 필요.
  // paper-only 경로는 ctx 없어도 동작. live 가능 여부는 isLiveCanaryEnabled() 가 ctx 존재 + 3 flag 모두 검증.
  botCtx = options.ctx;
  const liveCapable = botCtx != null
    && config.kolHunterLiveCanaryEnabled
    && !config.kolHunterPaperOnly
    && botCtx.tradingMode === 'live';
  log.info(
    `[KOL_HUNTER] initialized — paperOnly=${config.kolHunterPaperOnly} ` +
    `survival=${securityClient ? 'enabled' : 'skipped (no client)'} ` +
    `liveCanary=${liveCapable ? 'ENABLED (live wallet exposure)' : 'disabled'}`
  );
}

// ─── Live canary helpers (2026-04-27, Phase 5 P1-9~14) ───────────────
/**
 * 3-flag triple gate. 어느 하나라도 false 면 live wallet 영향 0 (paper fallback).
 * - kolHunterLiveCanaryEnabled (env, default false)
 * - !kolHunterPaperOnly (env, default true → must explicit set false)
 * - tradingMode === 'live' (env)
 * + botCtx 주입 + executor available
 */
function isLiveCanaryActive(): boolean {
  if (!botCtx) return false;
  if (botCtx.tradingMode !== 'live') return false;
  if (config.kolHunterPaperOnly) return false;
  if (!config.kolHunterLiveCanaryEnabled) return false;
  return true;
}

/** Live canary 의 wallet executor 결정. 현 phase 5 P1-15: main wallet 사용.
 *  추후 KOL_HUNTER_WALLET_MODE env 추가 가능 (sandbox / main). */
function getKolHunterExecutor(ctx: BotContext) {
  return ctx.executor;
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
  activeByMint.clear();   // P1 #5: index 동기화
  recentKolTxs.length = 0;
  pushesSinceLastPrune = 0;
  scoreCache.clear();     // P1 #7: score cache 동기화
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

  // 2026-04-26 paper notifier L1: discovery 카운팅 (kolPaperNotifier 가 hourly digest 에 사용)
  kolHunterEvents.emit('discovery', tx);

  // recent buffer 유지 (24h). audit fix #2: batch prune (매 1024 push 마다, splice 1회).
  recentKolTxs.push(tx);
  pushesSinceLastPrune++;
  if (pushesSinceLastPrune >= RECENT_TX_PRUNE_BATCH) {
    pruneRecentKolTxsByCutoff(Date.now() - config.kolScoringWindowMs);
    pushesSinceLastPrune = 0;
  }

  if (tx.action === 'sell') {
    handleKolSellSignal(tx);
    return;
  }

  // Active 또는 pending 이미 있으면 추가 KOL 만 집계 (P1 #5: O(1) lookup)
  const existingActive = getActivePositionsByMint(tx.tokenMint);
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

/**
 * 2026-04-28 (Phase 1): Style-aware insider_exit decision.
 *
 * Why: 외부 피드백 + GUfyGEF6 incident 정합. kev (5분 flip scalper) sell 한 건이 bflg
 *   (13일 hold copy_core) thesis 까지 청산하는 mismatch 차단.
 *
 * Decision tree (input: position 의 진입 KOL 들 + sell 한 KOL 의 lane_role/style):
 *   1) sell 한 KOL 이 'observer' lane → 무시 (entry 대상도 아니므로 close 도 trigger 안 함).
 *   2) sell 한 KOL 이 'scalper' style + position 의 다른 진입 KOL 중 'longhold/swing' 있음
 *      → confidence 하향만 (close 안 함). scalper sell 은 short-term flip 신호.
 *   3) sell 한 KOL 이 'longhold' or 'swing' style (copy_core/canary 무관)
 *      → close. 의미 있는 exit 신호.
 *   4) sell 한 KOL 이 lane_role/style 모두 'unknown' → close (보수적 fallback, 기존 default).
 *   5) Position 의 모든 진입 KOL 이 scalper 면 어쨌든 close (cohort 자체가 short-term).
 *
 * 'unknown' fallback 정책: KOL DB 의 운영자 manual 분류 (Phase 0A) 가 완료되기 전엔 거의 모든
 *   KOL 이 unknown 이라 기존 behavior 보존. 분류 누적될수록 점진적 정확도 향상.
 */
type InsiderExitAction = 'close' | 'lower_confidence' | 'ignore';

export function evaluateInsiderExitDecision(
  pos: PaperPosition,
  sellingKolId: string
): { action: InsiderExitAction; reason: string } {
  const sellingRole = getKolLaneRole(sellingKolId);
  const sellingStyle = getKolTradingStyle(sellingKolId);

  // (1) Observer 는 trigger 안 줌. 단 entry 도 안 줘야 정합 — observer KOL 이 진입 KOL 에 있는
  //     것 자체가 misconfiguration. 안전: ignore (close 도 안 함, 다른 진입 KOL 의 신호 대기).
  if (sellingRole === 'observer') {
    return { action: 'ignore', reason: `kol=${sellingKolId} is observer-only` };
  }

  // (5) 모든 진입 KOL 이 scalper 면 cohort 자체가 short-term — sell 은 그대로 따라감.
  const allScalper = pos.participatingKols.length > 0
    && pos.participatingKols.every((k) => getKolTradingStyle(k.id) === 'scalper');
  if (allScalper) {
    return { action: 'close', reason: `all-scalper cohort, follow sell` };
  }

  // (2) Scalper sell + position 에 longhold/swing 진입 KOL 있음 → confidence 하향만.
  //     scalper 의 5분 flip 신호로 swing thesis 청산 방지.
  if (sellingStyle === 'scalper') {
    const hasNonScalper = pos.participatingKols.some((k) => {
      const s = getKolTradingStyle(k.id);
      return s === 'longhold' || s === 'swing';
    });
    if (hasNonScalper) {
      return { action: 'lower_confidence', reason: `scalper sell ignored (longhold/swing in cohort)` };
    }
  }

  // (3) Longhold / swing sell → close.
  if (sellingStyle === 'longhold' || sellingStyle === 'swing') {
    return { action: 'close', reason: `${sellingStyle} kol sell` };
  }

  // (4) Unknown fallback — 보수적으로 close (기존 default behavior 보존).
  return { action: 'close', reason: `unknown style, conservative close` };
}

function handleKolSellSignal(tx: KolTx): void {
  const cand = pending.get(tx.tokenMint);
  if (cand?.smartV3 && cand.kolTxs.some((buy) => buy.kolId === tx.kolId)) {
    cleanupPendingCandidate(cand, true);
    pending.delete(tx.tokenMint);
    const score = computeKolDiscoveryScoreCached(tx.tokenMint, Date.now());  // P1 #7
    log.info(`[KOL_HUNTER_SMART_V3_CANCEL] ${tokenMint(tx)} kol=${tx.kolId} sell during observe`);
    fireRejectObserver(tx.tokenMint, 'smart_v3_kol_sell_cancel', cand, score);
    return;
  }

  const positions = getActivePositionsByMint(tx.tokenMint).filter((p) =>
    p.participatingKols.some((k) => k.id === tx.kolId)
  );
  if (positions.length === 0) {
    log.debug(`[KOL_HUNTER] sell ${tx.kolId} ${tx.tokenMint.slice(0, 8)} (no matching active/pending position)`);
    return;
  }

  for (const pos of positions) {
    const decision = evaluateInsiderExitDecision(pos, tx.kolId);
    const nowSec = Math.floor(Date.now() / 1000);
    const ref = pos.marketReferencePrice;
    const mfePct = (pos.peakPrice - ref) / ref;
    const maePct = (pos.troughPrice - ref) / ref;

    if (decision.action === 'close') {
      log.info(
        `[KOL_HUNTER_INSIDER_EXIT] ${pos.positionId} kol=${tx.kolId} action=close reason="${decision.reason}"`
      );
      closePosition(pos, pos.lastPrice, 'insider_exit_full', nowSec, mfePct, maePct);
    } else if (decision.action === 'lower_confidence') {
      // 2026-04-28 (Phase 1 QA F1 fix): scalper sell → close 안 함 + trail 즉시 보수화.
      // 이전: kolReinforcementCount 만 하향 — applySmartV3Reinforcement 가 buildup 만 하고
      //   reduce 안 하므로 t1TrailPctOverride stuck → 정책 영향 0 였음 (cosmetic 만).
      // 수정: t1TrailPctOverride 를 ReinforcementTrailInc 만큼 즉시 보수 회복. 다음 reinforcement
      //   buildup 시 다시 올라가지만, 일시적으로 trail 좁혀 scalper sell 의 단기 retreat 위험 차단.
      pos.kolReinforcementCount = Math.max(0, pos.kolReinforcementCount - 1);
      const baseTrail = config.kolHunterT1TrailPct;
      const inc = config.kolHunterSmartV3ReinforcementTrailInc;
      const currentTrail = pos.t1TrailPctOverride ?? baseTrail;
      const reducedTrail = Math.max(baseTrail, currentTrail - inc);
      pos.t1TrailPctOverride = reducedTrail;
      log.info(
        `[KOL_HUNTER_SCALPER_SELL_IGNORE] ${pos.positionId} kol=${tx.kolId} action=lower_confidence ` +
        `reason="${decision.reason}" reinforcementCount=${pos.kolReinforcementCount} ` +
        `trail=${(currentTrail * 100).toFixed(1)}% → ${(reducedTrail * 100).toFixed(1)}%`
      );
    } else {
      log.debug(
        `[KOL_HUNTER_OBSERVER_SELL_IGNORE] ${pos.positionId} kol=${tx.kolId} action=ignore reason="${decision.reason}"`
      );
    }
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
  const score = computeKolDiscoveryScoreCached(tokenMint, nowMs);  // P1 #7: 1s bucket cache
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
  // 2026-04-28 P1-A fix: 10s → 5s. PaperPriceFeed pollIntervalMs=3s 라 첫 tick typical 1-3s 도달.
  // 10s 는 과보수적 — worst case latency 50% 단축. 캐시 hit 은 즉시 반환 (timeout 영향 없음).
  const firstTick = await waitForFirstTick(tokenMint, 5_000);
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
    const positions = getActivePositionsByMint(tokenMint);
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
  const score = computeKolDiscoveryScoreCached(tokenMint, Date.now());  // P1 #7
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
  const hasActive = (activeByMint.get(tokenMint)?.size ?? 0) > 0;
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

  const score = computeKolDiscoveryScoreCached(cand.tokenMint, Date.now());  // P1 #7
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
  const entryOptions: PaperEntryOptions = {
    parameterVersion: config.kolHunterSmartV3ParameterVersion,
    entryReason: trigger.reason,
    convictionLevel: trigger.conviction,
    tokenDecimals: smart.tokenDecimals,
    tokenDecimalsSource: smart.tokenDecimalsSource,
  };

  // 2026-04-28 fix: smart-v3 main arm 이 live canary 의 1st-class entry path. 이전에는
  // enterPaperPosition 만 호출하여 KOL_HUNTER_LIVE_CANARY_ENABLED=true 환경에서도
  // executor.executeBuy 가 절대 호출되지 않는 dead-path 였다 (commit 1469a08 의 누락).
  // triple-flag gate 통과 시 enterLivePosition 으로 분기. swing-v2 shadow 는 enterLivePosition
  // 안에서 paper paired 로 자동 추가됨 (재귀 방지).
  // 2026-04-28: inactive (shadow) KOL 만으로 trigger 된 cand 는 live canary 차단 — 무조건 paper.
  // shadow 측정 자체가 active 승격 candidate 식별용이라 실 자산 노출 금지.
  const candIsShadow = cand.kolTxs.length > 0 && cand.kolTxs.every((t) => t.isShadow === true);
  if (isLiveCanaryActive() && botCtx && !candIsShadow) {
    if (isWalletStopActive()) {
      log.warn(
        `[KOL_HUNTER_WALLET_STOP] ${cand.tokenMint.slice(0, 8)} smart-v3 trigger — ` +
        `wallet floor active. fallback paper.`
      );
      await enterPaperPosition(cand.tokenMint, cand, score, smart.preEntryFlags, entryOptions);
      return;
    }
    if (isEntryHaltActive(LANE_STRATEGY)) {
      log.warn(
        `[KOL_HUNTER_ENTRY_HALT] ${cand.tokenMint.slice(0, 8)} smart-v3 trigger — ` +
        `lane halt active. fallback paper.`
      );
      await enterPaperPosition(cand.tokenMint, cand, score, smart.preEntryFlags, entryOptions);
      return;
    }
    await enterLivePosition(
      cand.tokenMint,
      cand,
      score,
      smart.preEntryFlags,
      botCtx,
      entryOptions
    );
    return;
  }
  await enterPaperPosition(cand.tokenMint, cand, score, smart.preEntryFlags, entryOptions);
}

async function resolveStalk(tokenMint: string): Promise<void> {
  const cand = pending.get(tokenMint);
  if (!cand) return;
  pending.delete(tokenMint);

  const nowMs = Date.now();
  const score = computeKolDiscoveryScoreCached(tokenMint, nowMs);  // P1 #7

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

  // 2026-04-27 (Phase 5 P1-9~14): live canary 실제 구현. triple-flag gate 모두 통과 시 live wallet 사용.
  // 그 외 경우는 paper-only (default 안전).
  // 2026-04-28: shadow KOL 만으로 trigger 된 cand 는 live canary 차단 (실 자산 노출 금지).
  const candIsShadow = cand.kolTxs.length > 0 && cand.kolTxs.every((t) => t.isShadow === true);
  if (isLiveCanaryActive() && botCtx && !candIsShadow) {
    // Hard guards (live wallet protection)
    if (isWalletStopActive()) {
      log.warn(`[KOL_HUNTER_WALLET_STOP] ${tokenMint.slice(0, 8)} signal ignored — wallet floor active`);
      fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score, {
        survivalReason: 'wallet_stop_active',
        survivalFlags: ['WALLET_STOP'],
      });
      return;
    }
    if (isEntryHaltActive(LANE_STRATEGY)) {
      log.warn(`[KOL_HUNTER_ENTRY_HALT] ${tokenMint.slice(0, 8)} signal ignored — integrity halt`);
      fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score, {
        survivalReason: 'entry_halt_active',
        survivalFlags: ['ENTRY_HALT'],
      });
      return;
    }
    await enterLivePosition(tokenMint, cand, score, preEntry.flags, botCtx);
    return;
  }
  if (!config.kolHunterPaperOnly && !config.kolHunterLiveCanaryEnabled) {
    log.warn(`[KOL_HUNTER] PAPER_ONLY=false 인데 LIVE_CANARY_ENABLED=false — paper 로만 동작`);
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
  // 2026-04-28 P1-A fix: 10s → 5s. PaperPriceFeed pollIntervalMs=3s 라 첫 tick typical 1-3s 도달.
  // 10s 는 과보수적 — worst case latency 50% 단축. 캐시 hit 은 즉시 반환 (timeout 영향 없음).
  const firstTick = await waitForFirstTick(tokenMint, 5_000);
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
  // 2026-04-26: smart-v3 main path 에서도 swing-v2 paper shadow 측정 허용.
  // 이전: `primaryVersion === v1.0.0` 일 때만 shadow 생성 → smart-v3 default ON 이면 swing-v2 영구 비활성.
  // 수정: primary 가 swing-v2 자기자신이 아니면 (재귀 방지) shadow 생성. smart-v3/v1 양쪽 path 에서 동작.
  // 이유: swing 손익비 정책 자체의 paradigm-agnostic 검증 + KOL_HUNTER_SMART_V3_ENABLED 와 SWING_V2_ENABLED 동시 ON 가능.
  const swingEligible =
    primaryVersion !== config.kolHunterSwingV2ParameterVersion && isSwingV2Eligible(score);

  // 2026-04-28: inactive KOL paper trade flag.
  // cand.kolTxs 의 모든 tx 가 isShadow=true 일 때만 position 을 shadow 로 마킹.
  // active 가 1명이라도 끼면 active 우선 (downgrade 안 함) — 분포 정합 + 보수적 정책.
  // active KOL 이 없는 cand 는 enterPaperPosition 에 도달하기 전에 multi-KOL hurdle 에서 거의
  // reject 되므로 실제 shadow position 은 inactive 만으로 hurdle 충족하는 케이스만.
  const isShadowKolPosition =
    cand.kolTxs.length > 0 && cand.kolTxs.every((t) => t.isShadow === true);

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
      isShadowKol: isShadowKolPosition,  // 2026-04-28: 분포 분리 marker.
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
    setActivePosition(pos);  // P1 #5: index 동기화 (Map + activeByMint Set)
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
    const positions = getActivePositionsByMint(tokenMint);
    for (const pos of positions) onPriceTick(pos.positionId, tick);
  };
  priceListeners.set(tokenMint, listener);
  priceFeed.on('price', listener);
}

// ─── Paper-only 휴리스틱 named constants ─────────────────
// 2026-04-26: hardcode magic number 를 named constant 로 추출 (의도 명시 + 향후 config 화 후보).
// Paper-only 휴리스틱 — Phase 4+ live 에서는 실 candle / buy ratio / tx density 기반으로 대체 예정.
const KOL_PAPER_PROBE_FLAT_BAND_PCT = 0.10;                  // stalk 만료 시 ±10% 범위 내면 timeout reject
const KOL_PAPER_PROBE_TRAIL_PCT = 0.15;                      // PROBE 의 peak-pullback trail (15%)
const KOL_PAPER_QUICK_REJECT_MFE_LOW_THRESHOLD = 0.02;       // (a) MFE 2% 미만 + 30s 경과 시 factor +1
const KOL_PAPER_QUICK_REJECT_MFE_LOW_ELAPSED_SEC = 30;
const KOL_PAPER_QUICK_REJECT_PRICE_DROP_THRESHOLD = -0.05;   // (b) 현 price -5% 이하 시 factor +1
const KOL_PAPER_QUICK_REJECT_PULLBACK_THRESHOLD = 0.20;      // (c) peak 로부터 20% pullback 시 factor +1
// 2026-04-28: 0.30 → config 화 (default 0.45). config.kolHunterHoldPhasePeakDriftThreshold 참조.
// 사유: Sprint 1A paper 분석 (n=401) — mfe 200%+ winner 4건 sentinel cut 발견. 임계 완화로 large
// winner retreat capture. config/kolHunter.ts 의 정책 주석 참조.

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
        // 2026-04-26: hardcode 0.10 → KOL_PAPER_PROBE_FLAT_BAND_PCT (paper 휴리스틱 named const)
        const inFlatBand = Math.abs(currentPct) <= KOL_PAPER_PROBE_FLAT_BAND_PCT;
        if (inFlatBand) {
          closePosition(pos, currentPrice, 'probe_reject_timeout', nowSec, mfePct, maePct);
          return;
        }
      }
      // 4. Probe trail (flat band 벗어난 후 pullback)
      if (pos.peakPrice > pos.entryPrice) {
        const trailStop = pos.peakPrice * (1 - KOL_PAPER_PROBE_TRAIL_PCT);
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

function countQuickRejectFactors(pos: PaperPosition, currentPrice: number, elapsedSec: number): number {
  // Paper 모드에서는 candle microstructure 데이터 없음 → price-based 휴리스틱
  let factors = 0;
  const mfeSoFar = (pos.peakPrice - pos.marketReferencePrice) / pos.marketReferencePrice;
  const currentPct = (currentPrice - pos.marketReferencePrice) / pos.marketReferencePrice;
  if (
    mfeSoFar < KOL_PAPER_QUICK_REJECT_MFE_LOW_THRESHOLD &&
    elapsedSec > KOL_PAPER_QUICK_REJECT_MFE_LOW_ELAPSED_SEC
  ) factors += 1;
  if (currentPct < KOL_PAPER_QUICK_REJECT_PRICE_DROP_THRESHOLD) factors += 1;
  const pullback = (pos.peakPrice - currentPrice) / Math.max(pos.peakPrice, 1e-12);
  if (pullback > KOL_PAPER_QUICK_REJECT_PULLBACK_THRESHOLD) factors += 1;
  return factors;
}

function detectHoldPhaseDegraded(pos: PaperPosition, currentPrice: number): boolean {
  // Paper: peak 로부터 큰 drop + price 감소 지속 시 degraded 판정
  const peakDrift = (pos.peakPrice - currentPrice) / Math.max(pos.peakPrice, 1e-12);
  return peakDrift > config.kolHunterHoldPhasePeakDriftThreshold;
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
  // 2026-04-27 (KOL live canary): live position 은 비동기 sell + DB close 별도 분기.
  // fire-and-forget — tickMonitor 흐름은 막지 않음. 실패 시 critical alert.
  if (pos.isLive === true) {
    // 2026-04-27 race fix: tickMonitor 가 동시에 close signal 두 번 발사 시 (예: hardcut + insider_exit)
    // closeLivePosition 가 비동기라 두 번째 invocation 이 첫 sell 완료 전 진입 → 2중 sell 위험.
    // 즉시 state='CLOSED' 로 mark + closing flag 로 추가 동시 호출 차단. 실제 sell/DB close 는 비동기.
    if (pos.state === 'CLOSED') return;  // 이미 진행 중
    // 2026-04-28 F1 fix: previousState 를 mutation 전 capture → closeLivePosition 의 sell-fail 분기에서
    // pos.state = previousState 가 의미 있는 복원이 됨. 이전 코드는 mutation 후 capture 라
    // sell 실패 시 영구 'CLOSED' 잠금 (DB 는 OPEN 으로 남음 → orphan 상태 누적).
    const previousState = pos.state;
    pos.state = 'CLOSED';
    void closeLivePosition(pos, exitPrice, reason, nowSec, mfePctAtClose, maePctAtClose, previousState);
    return;
  }
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

  deleteActivePosition(pos.positionId);  // P1 #5: index 동기화

  // price feed unsubscribe — token 의 모든 A/B arm 이 닫힌 뒤에만 정리
  unsubscribePriceIfIdle(pos.tokenMint);

  // 2026-04-26 paper notifier L2: peak MFE 같이 전달 → anomaly 알림 (5x+ winner) 판정 가능
  const mfePctPeak = pos.marketReferencePrice > 0
    ? (pos.peakPrice - pos.marketReferencePrice) / pos.marketReferencePrice
    : 0;
  kolHunterEvents.emit('paper_close', { pos, reason, exitPrice, netSol, netPct, mfePctPeak, holdSec });
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
      isShadowKol: pos.isShadowKol ?? false,  // 2026-04-28: shadow 분리 marker.
      tokenDecimals: pos.tokenDecimals ?? null,
      tokenDecimalsSource: pos.tokenDecimalsSource ?? null,
      closedAt: new Date().toISOString(),
    };
    // 2026-04-28: inactive KOL paper trade 결과는 별도 ledger 로 분리. active 분포 무결성 유지.
    const fileName = pos.isShadowKol
      ? config.kolShadowPaperTradesFileName
      : 'kol-paper-trades.jsonl';
    await appendFile(path.join(dir, fileName), JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    log.debug(`[KOL_HUNTER] paper ledger append failed: ${String(err)}`);
  }
}

// ─── Live canary entry / close (Phase 5 P1-9~14, 2026-04-27) ─────────
// pure_ws live path 와 동일 패턴. Real Asset Guard, canary slot, DB persist, ledger 정합.
// triple-flag gate 통과 시에만 실행 (isLiveCanaryActive() in resolveStalk).

async function enterLivePosition(
  tokenMint: string,
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  survivalFlags: string[],
  ctx: BotContext,
  options: PaperEntryOptions = {}
): Promise<void> {
  if (!priceFeed) {
    log.warn(`[KOL_HUNTER_LIVE] priceFeed not initialized — fallback paper`);
    await enterPaperPosition(tokenMint, cand, score, survivalFlags, options);
    return;
  }

  // 2026-04-28 P0-2A inflight dedup: 동일 mint 동시 signal 시 enterLivePosition 2회 진입 차단.
  // executeBuy 2회 + DB duplicate row 위험 방지. pure_ws/cupsey 동일 패턴.
  if (inflightLiveEntry.has(tokenMint)) {
    log.debug(`[KOL_HUNTER_LIVE] inflight entry already in progress for ${tokenMint.slice(0, 12)} — skip`);
    return;
  }
  inflightLiveEntry.add(tokenMint);

  try {
  // 1. Entry reference price — paper feed 와 동일 (Jupiter probe quote).
  priceFeed.subscribe(tokenMint);
  // 2026-04-28 P1-A fix: 10s → 5s. PaperPriceFeed pollIntervalMs=3s 라 첫 tick typical 1-3s 도달.
  // 10s 는 과보수적 — worst case latency 50% 단축. 캐시 hit 은 즉시 반환 (timeout 영향 없음).
  const firstTick = await waitForFirstTick(tokenMint, 5_000);
  if (firstTick === null) {
    unsubscribePriceIfIdle(tokenMint);
    log.warn(`[KOL_HUNTER_LIVE] entry price timeout ${tokenMint.slice(0, 8)} — reject`);
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score, {
      survivalReason: 'live_price_timeout',
      survivalFlags: ['LIVE_PRICE_TIMEOUT'],
    });
    return;
  }
  const referencePrice = firstTick.price;
  const ticketSol = config.kolHunterTicketSol;
  const plannedQty = referencePrice > 0 ? ticketSol / referencePrice : 0;
  if (plannedQty <= 0) {
    unsubscribePriceIfIdle(tokenMint);
    return;
  }

  // 2. Real Asset Guard — global canary slot.
  if (!acquireCanarySlot(LANE_STRATEGY)) {
    log.debug(`[KOL_HUNTER_LIVE] global canary slot full — defer ${tokenMint.slice(0, 8)}`);
    unsubscribePriceIfIdle(tokenMint);
    return;
  }

  // 3. executeBuy.
  let actualEntryPrice = referencePrice;
  let actualQuantity = plannedQty;
  let entryTxSignature = 'KOL_LIVE_PENDING';
  let entrySlippageBps = 0;
  let partialFillDataMissing = false;
  const nowSec = Math.floor(Date.now() / 1000);
  const positionId = `kolh-live-${tokenMint.slice(0, 8)}-${nowSec}`;

  try {
    const buyExecutor = getKolHunterExecutor(ctx);
    const order: Order = {
      pairAddress: tokenMint,
      strategy: LANE_STRATEGY,
      side: 'BUY',
      price: referencePrice,
      quantity: plannedQty,
      stopLoss: referencePrice * (1 - config.kolHunterHardcutPct),
      takeProfit1: referencePrice * (1 + config.kolHunterT1Mfe),
      takeProfit2: referencePrice * (1 + config.kolHunterT2Mfe),
      timeStopMinutes: Math.ceil(config.kolHunterStalkWindowSec / 60),
    };
    const buyResult = await buyExecutor.executeBuy(order);
    const metrics = resolveActualEntryMetrics(order, buyResult);
    actualEntryPrice = metrics.entryPrice;
    actualQuantity = metrics.quantity;
    entryTxSignature = buyResult.txSignature;
    entrySlippageBps = buyResult.slippageBps;
    partialFillDataMissing = metrics.partialFillDataMissing;
    log.info(
      `[KOL_HUNTER_LIVE_BUY] ${positionId} sig=${entryTxSignature.slice(0, 12)} ` +
      `slip=${entrySlippageBps}bps qty=${actualQuantity.toFixed(2)}`
    );
  } catch (buyErr) {
    log.warn(`[KOL_HUNTER_LIVE_BUY] ${positionId} buy failed: ${buyErr}`);
    releaseCanarySlot(LANE_STRATEGY);
    unsubscribePriceIfIdle(tokenMint);
    return;
  }

  // 4. DB persist (entryIntegrity halt 보호).
  const persistResult = await persistOpenTradeWithIntegrity({
    ctx,
    lane: LANE_STRATEGY,
    tradeData: {
      pairAddress: tokenMint,
      strategy: LANE_STRATEGY,
      side: 'BUY',
      sourceLabel: `kol_hunter:${score.participatingKols.map((k) => k.id).join(',')}`,
      discoverySource: 'kol_discovery_v1',
      entryPrice: actualEntryPrice,
      plannedEntryPrice: referencePrice,
      quantity: actualQuantity,
      stopLoss: actualEntryPrice * (1 - config.kolHunterHardcutPct),
      takeProfit1: actualEntryPrice * (1 + config.kolHunterT1Mfe),
      takeProfit2: actualEntryPrice * (1 + config.kolHunterT2Mfe),
      trailingStop: undefined,
      highWaterMark: actualEntryPrice,
      timeStopAt: new Date((nowSec + config.kolHunterStalkWindowSec) * 1000),
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
      wallet: 'main',
      pairAddress: tokenMint,
      plannedEntryPrice: referencePrice,
      actualEntryPrice,
      actualQuantity,
      slippageBps: entrySlippageBps,
      signalTimeSec: nowSec,
      signalPrice: referencePrice,
      partialFillDataMissing,
      kolScore: score.finalScore,
      independentKolCount: score.independentKolCount,
    },
    notifierKey: 'kol_live_open_persist',
    buildNotifierMessage: (err) =>
      `${positionId} kol live buy persisted FAILED after tx=${entryTxSignature}: ${err} — NEW POSITIONS HALTED.`,
  });

  // 5. Build PaperPosition (with isLive=true).
  // 2026-04-28 fix: smart-v3 / swing-v2 main path 의 live wiring 을 위해 caller 가 전달한
  // options (paramVersion / entryReason / conviction / tokenDecimals) 사용. 옵션 미주입 시 v1
  // fallback default 유지 (기존 동작과 동일).
  const primaryVersion = options.parameterVersion ?? config.kolHunterParameterVersion;
  const armName = armNameForVersion(primaryVersion);
  const entryReason = options.entryReason ?? defaultEntryReasonForVersion(primaryVersion);
  const conviction = options.convictionLevel ?? defaultConvictionForVersion(primaryVersion);
  const dynamicExit = primaryVersion === config.kolHunterSmartV3ParameterVersion
    ? dynamicExitParamsForEntry(entryReason)
    : {};
  const liveDecimals = typeof options.tokenDecimals === 'number'
    ? options.tokenDecimals
    : firstTick.outputDecimals ?? undefined;
  const liveDecimalsSource = options.tokenDecimalsSource;
  const position: PaperPosition = {
    positionId,
    tokenMint,
    state: 'PROBE',
    entryPrice: actualEntryPrice,
    entryTimeSec: nowSec,
    ticketSol,
    quantity: actualQuantity,
    marketReferencePrice: referencePrice,
    peakPrice: referencePrice,
    troughPrice: referencePrice,
    lastPrice: referencePrice,
    participatingKols: score.participatingKols.map((k) => ({ ...k })),
    kolScore: score.finalScore,
    armName,
    parameterVersion: primaryVersion,
    isShadowArm: false,
    kolEntryReason: entryReason,
    kolConvictionLevel: conviction,
    t1MfeOverride: dynamicExit.t1Mfe,
    t1TrailPctOverride: dynamicExit.t1TrailPct,
    t1ProfitFloorMult: dynamicExit.t1ProfitFloorMult,
    probeFlatTimeoutSec: dynamicExit.probeFlatTimeoutSec,
    kolReinforcementCount: 0,
    detectorVersion: config.kolHunterDetectorVersion,
    independentKolCount: score.independentKolCount,
    survivalFlags: [
      ...survivalFlags,
      `LIVE_DECIMALS_${liveDecimals ?? 'UNKNOWN'}`,
    ],
    tokenDecimals: liveDecimals,
    tokenDecimalsSource: liveDecimalsSource,
    isLive: true,
    dbTradeId: persistResult.dbTradeId ?? undefined,
    entryTxSignature,
    entrySlippageBps,
  };

  setActivePosition(position);
  ensurePriceListener(tokenMint);

  // 2026-04-28 fix: swing-v2 paper shadow 는 main arm 이 live 이더라도 paired observation
  // 으로 paper 진입 (실 자산 영향 없음). enterPaperPosition 의 logic 과 정합 (line 1103-1167).
  // 재귀 방지: primary 가 swing-v2 자기자신이 아닐 때만.
  if (
    primaryVersion !== config.kolHunterSwingV2ParameterVersion &&
    isSwingV2Eligible(score)
  ) {
    const swingShadowId = `${positionId}-swing-v2`;
    const swingPos: PaperPosition = {
      positionId: swingShadowId,
      tokenMint,
      state: 'PROBE',
      entryPrice: actualEntryPrice,
      entryTimeSec: nowSec,
      ticketSol,
      quantity: actualQuantity,
      marketReferencePrice: referencePrice,
      peakPrice: referencePrice,
      troughPrice: referencePrice,
      lastPrice: referencePrice,
      participatingKols: score.participatingKols.map((k) => ({ ...k })),
      kolScore: score.finalScore,
      armName: armNameForVersion(config.kolHunterSwingV2ParameterVersion),
      parameterVersion: config.kolHunterSwingV2ParameterVersion,
      isShadowArm: true,
      parentPositionId: positionId,
      kolEntryReason: defaultEntryReasonForVersion(config.kolHunterSwingV2ParameterVersion),
      kolConvictionLevel: defaultConvictionForVersion(config.kolHunterSwingV2ParameterVersion),
      kolReinforcementCount: 0,
      detectorVersion: config.kolHunterDetectorVersion,
      independentKolCount: score.independentKolCount,
      survivalFlags: [
        ...survivalFlags,
        `LIVE_PAIRED_PAPER_SHADOW`,
        `DECIMALS_${liveDecimalsSource?.toUpperCase() ?? 'UNKNOWN'}`,
      ],
      tokenDecimals: liveDecimals,
      tokenDecimalsSource: liveDecimalsSource,
      isLive: false,  // ← shadow 는 paper. main arm 만 live.
    };
    setActivePosition(swingPos);
    // 2026-04-28 QA fix: paired shadow 도 paper_entry emit 해야 kolPaperNotifier 의
    // hourly digest + 5x anomaly alert 에 포함됨 (enterPaperPosition line 1216 와 정합).
    kolHunterEvents.emit('paper_entry', swingPos);
    log.info(
      `[KOL_HUNTER_SWING_V2] ${positionId} ${tokenMint.slice(0, 8)} (paired with LIVE main) ` +
      `kols=${score.independentKolCount} score=${score.finalScore.toFixed(2)} ` +
      `stalk=${config.kolHunterSwingV2StalkWindowSec}s trail=${(config.kolHunterSwingV2T1TrailPct * 100).toFixed(0)}% ` +
      `profitFloor=${config.kolHunterSwingV2T1ProfitFloorMult}x`
    );
  }

  if (persistResult.dbTradeId) {
    // 2026-04-28 P0-B fix: notifier fire-and-forget. Telegram 429 시 entry path 200-2000ms blocking 차단.
    // 신뢰도: notifier 실패는 trade 경제성에 영향 없음 (DB / wallet 은 이미 commit). log.warn 만 충분.
    void ctx.notifier.sendTradeOpen({
      tradeId: persistResult.dbTradeId,
      pairAddress: tokenMint,
      strategy: LANE_STRATEGY,
      side: 'BUY',
      price: actualEntryPrice,
      plannedEntryPrice: referencePrice,
      quantity: actualQuantity,
      sourceLabel: position.armName,
      discoverySource: 'kol_discovery_v1',
      stopLoss: actualEntryPrice * (1 - config.kolHunterHardcutPct),
      takeProfit1: actualEntryPrice * (1 + config.kolHunterT1Mfe),
      takeProfit2: actualEntryPrice * (1 + config.kolHunterT2Mfe),
      timeStopMinutes: Math.ceil(config.kolHunterStalkWindowSec / 60),
    }, entryTxSignature).catch((err) => {
      log.warn(`[KOL_HUNTER_LIVE_NOTIFY_OPEN_FAIL] ${positionId} ${err}`);
    });
  }

  log.info(
    `[KOL_HUNTER_LIVE_OPEN] ${positionId} ${tokenMint.slice(0, 8)} ` +
    `entry=${actualEntryPrice.toFixed(8)} qty=${actualQuantity.toFixed(2)} ticket=${ticketSol}SOL ` +
    `kols=${score.independentKolCount} score=${score.finalScore.toFixed(2)}`
  );
  kolHunterEvents.emit('paper_entry', position);
  } finally {
    // 2026-04-28 P0-2A: inflight dedup release (try block 시작 → 모든 return / throw 경로 cover).
    inflightLiveEntry.delete(tokenMint);
  }
}

async function closeLivePosition(
  pos: PaperPosition,
  exitPrice: number,
  reason: CloseReason,
  nowSec: number,
  mfePctAtClose: number,
  maePctAtClose: number,
  // 2026-04-28 F1 fix: closePosition 에서 mutation 전 capture 한 previousState 를 명시적 전달.
  // undefined 시 fallback 으로 pos.state 사용 (recovery 경로 등 기존 호출자 호환).
  callerPreviousState?: LaneTState
): Promise<void> {
  if (!botCtx) {
    log.error(`[KOL_HUNTER_LIVE_CLOSE] ${pos.positionId} no botCtx — cannot live close, falling back to paper close`);
    pos.isLive = false;
    closePosition(pos, exitPrice, reason, nowSec, mfePctAtClose, maePctAtClose);
    return;
  }
  const ctx = botCtx;
  const previousState = pos.state;
  let actualExitPrice = exitPrice;
  let executionSlippage = 0;
  let exitTxSignature = pos.entryTxSignature;
  let sellCompleted = false;
  let liveReceivedSol = 0;
  let effectiveReason: CloseReason = reason;

  try {
    const sellExecutor = getKolHunterExecutor(ctx);
    // 2026-04-28 P0-C fix: tokenBalance + getBalance(solBefore) 병렬화 (이전엔 직렬 await).
    // 두 RPC 모두 sellExecutor 의 read-only 호출 — 병렬 안전. ~250ms latency 단축.
    const [tokenBalance, solBefore] = await Promise.all([
      sellExecutor.getTokenBalance(pos.tokenMint),
      sellExecutor.getBalance(),
    ]);
    if (tokenBalance > 0n) {
      const sellResult = await sellExecutor.executeSell(pos.tokenMint, tokenBalance);
      const solAfter = await sellExecutor.getBalance();
      const receivedSol = solAfter - solBefore;
      liveReceivedSol = receivedSol;
      if (receivedSol > 0 && pos.quantity > 0) {
        actualExitPrice = receivedSol / pos.quantity;
      }
      executionSlippage = bpsToDecimal(sellResult.slippageBps);
      exitTxSignature = sellResult.txSignature;
      sellCompleted = true;
      log.info(
        `[KOL_HUNTER_LIVE_SELL] ${pos.positionId} sig=${sellResult.txSignature.slice(0, 12)} ` +
        `received=${receivedSol.toFixed(6)} SOL slip=${sellResult.slippageBps}bps`
      );
      const solSpentNominal = pos.entryPrice * pos.quantity;
      const dbPnl = (actualExitPrice - pos.entryPrice) * pos.quantity;
      const walletDelta = receivedSol - solSpentNominal;
      const dbPnlDrift = dbPnl - walletDelta;
      if (Math.abs(dbPnlDrift) > 0.001) {
        log.warn(
          `[KOL_HUNTER_LIVE_PNL_DRIFT] ${pos.positionId} dbPnl=${dbPnl.toFixed(6)} ` +
          `walletDelta=${walletDelta.toFixed(6)} drift=${dbPnlDrift.toFixed(6)} SOL`
        );
      }
      const mfePctPeak = pos.marketReferencePrice > 0
        ? (pos.peakPrice - pos.marketReferencePrice) / pos.marketReferencePrice
        : 0;
      await appendEntryLedger('sell', {
        positionId: pos.positionId,
        dbTradeId: pos.dbTradeId,
        txSignature: exitTxSignature,
        entryTxSignature: pos.entryTxSignature,
        strategy: LANE_STRATEGY,
        wallet: 'main',
        pairAddress: pos.tokenMint,
        exitReason: effectiveReason,
        receivedSol,
        actualExitPrice,
        slippageBps: sellResult.slippageBps,
        entryPrice: pos.entryPrice,
        holdSec: nowSec - pos.entryTimeSec,
        mfePctPeak,
        peakPrice: pos.peakPrice,
        troughPrice: pos.troughPrice,
        marketReferencePrice: pos.marketReferencePrice,
        t1VisitAtSec: pos.t1VisitAtSec ?? null,
        t2VisitAtSec: pos.t2VisitAtSec ?? null,
        t3VisitAtSec: pos.t3VisitAtSec ?? null,
        closeState: pos.state,
        dbPnlSol: dbPnl,
        walletDeltaSol: walletDelta,
        dbPnlDriftSol: dbPnlDrift,
        solSpentNominal,
        kolScore: pos.kolScore,
        independentKolCount: pos.independentKolCount,
        armName: pos.armName,
        parameterVersion: pos.parameterVersion,
      });
    } else {
      // ORPHAN_NO_BALANCE — pure_ws 패턴 동일.
      log.warn(
        `[KOL_HUNTER_LIVE_ORPHAN] ${pos.positionId} ${pos.tokenMint.slice(0, 12)} zero balance — ` +
        `force closing pnl=0 (previousReason=${reason})`
      );
      effectiveReason = 'ORPHAN_NO_BALANCE';
      actualExitPrice = pos.entryPrice;
      sellCompleted = true;
      exitTxSignature = pos.entryTxSignature ?? 'ORPHAN_NO_TX';
      await ctx.notifier.sendCritical(
        'kol_live_orphan',
        `${pos.positionId} ${pos.tokenMint} zero balance at close — force closing 0 pnl`
      ).catch(() => {});
    }
  } catch (sellErr) {
    log.warn(`[KOL_HUNTER_LIVE_SELL] ${pos.positionId} sell failed: ${sellErr}`);
    // 2026-04-28 F1 fix: callerPreviousState 가 있으면 그걸 사용 (closePosition mutation 이전 값).
    // 없으면 기존 previousState fallback (recovery 경로 등 직접 호출자).
    pos.state = callerPreviousState ?? previousState;
    // 2026-04-28 F2 fix: critical notifier cooldown — 마지막 critical 발사 시각 비교.
    // cupsey/pure_ws/migration 패턴 동일. 이전 코드 (entryTimeSec >= 60s 비교) 는
    // entry 직후 60s 내 sell 실패 시 critical 미발사 → 운영자 무지각 위험.
    if (!pos.lastCloseFailureAtSec || nowSec - pos.lastCloseFailureAtSec >= 60) {
      pos.lastCloseFailureAtSec = nowSec;
      await ctx.notifier.sendCritical(
        'kol_live_close_failed',
        `${pos.positionId} ${pos.tokenMint} reason=${reason} sell failed — OPEN 유지`
      ).catch(() => {});
    }
    return;
  }
  void liveReceivedSol;

  pos.state = 'CLOSED';
  const rawPnl = (actualExitPrice - pos.entryPrice) * pos.quantity;
  const pnl = rawPnl;  // live: round-trip cost 는 wallet delta 에 이미 반영됨
  const pnlPct = pos.entryPrice > 0
    ? ((actualExitPrice - pos.entryPrice) / pos.entryPrice)
    : 0;

  // DB closeTrade.
  let dbCloseSucceeded = false;
  try {
    if (pos.dbTradeId && sellCompleted) {
      await ctx.tradeStore.closeTrade({
        id: pos.dbTradeId,
        exitPrice: actualExitPrice,
        pnl,
        slippage: executionSlippage,
        exitReason: effectiveReason,
        exitSlippageBps: Math.round(executionSlippage * 10_000),
        decisionPrice: exitPrice,
      });
      dbCloseSucceeded = true;
    }
  } catch (err) {
    log.warn(`[KOL_HUNTER_LIVE_CLOSE_PERSIST] ${pos.positionId}: ${err}`);
    // 2026-04-27 fix: live sell 성공 후 DB close 실패 → wallet ↔ DB drift 누적 가능.
    // pure_ws/cupsey 패턴 동일 적용 — kol_hunter lane entry halt 트리거.
    // 운영자 reconciliation 후 resetEntryHalt('kol_hunter') 로 해제 필요.
    triggerEntryHalt('kol_hunter', `KOL live close persist failed for ${pos.positionId}: ${err}`);
    await ctx.notifier.sendCritical(
      'kol_live_close_persist',
      `${pos.positionId} ${pos.tokenMint} sell ok but DB close failed — NEW POSITIONS HALTED`
    ).catch(() => {});
  }
  void dbCloseSucceeded;

  log.info(
    `[KOL_HUNTER_LIVE_CLOSED] ${pos.positionId} reason=${effectiveReason} state=${previousState} ` +
    `pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(2)}%) ` +
    `hold=${nowSec - pos.entryTimeSec}s mfe=${(mfePctAtClose * 100).toFixed(2)}% mae=${(maePctAtClose * 100).toFixed(2)}%`
  );

  // 2026-04-27: live close 운영자 즉시 알림. 기존엔 hourly digest + 5x anomaly 만 → 일반
  // close 가 무음이라 운영자가 실 자산 close 를 즉시 인지 못 함 (cupsey/migration 와 일관성 결여).
  // hourly digest 는 그대로 유지 (집계용).
  // 2026-04-28 P0-B fix: notifier fire-and-forget — Telegram 429 close path blocking 차단.
  void ctx.notifier.sendInfo(
    `[KOL_LIVE_CLOSE] ${pos.tokenMint.slice(0, 12)} reason=${effectiveReason} ` +
    `pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(2)}%) ` +
    `hold=${nowSec - pos.entryTimeSec}s state=${previousState}` +
    (pos.dbTradeId ? '' : ' [NO_DB_RECORD — manual reconcile]'),
    'kol_live_close'
  ).catch((err) => log.warn(`[KOL_HUNTER_LIVE_NOTIFY_CLOSE_FAIL] ${pos.positionId} ${err}`));

  deleteActivePosition(pos.positionId);
  unsubscribePriceIfIdle(pos.tokenMint);

  // Real Asset Guard feed: canary auto-halt + bleed budget.
  reportCanaryClose(LANE_STRATEGY, pnl);
  releaseCanarySlot(LANE_STRATEGY);
  if (config.dailyBleedBudgetEnabled) {
    const walletState = getWalletStopGuardState();
    const walletBaselineSol = walletState.lastBalanceSol > 0 && Number.isFinite(walletState.lastBalanceSol)
      ? walletState.lastBalanceSol
      : config.walletStopMinSol + 0.01;
    const bleedSol = pnl < 0 ? -pnl : 0;
    reportBleed(bleedSol, walletBaselineSol, {
      alpha: config.dailyBleedAlpha,
      minCapSol: config.dailyBleedMinCapSol,
      maxCapSol: config.dailyBleedMaxCapSol,
    });
  }

  const mfePctPeak = pos.marketReferencePrice > 0
    ? (pos.peakPrice - pos.marketReferencePrice) / pos.marketReferencePrice
    : 0;
  kolHunterEvents.emit('paper_close', {
    pos, reason: effectiveReason, exitPrice: actualExitPrice,
    netSol: pnl, netPct: pnlPct, mfePctPeak, holdSec: nowSec - pos.entryTimeSec,
  });
  void exitTxSignature;
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

// ─── Recovery (2026-04-28, Sprint 2A) ────────────────────
//
// Why: 봇 크래시 / 재시작 시 DB 의 OPEN status kol_hunter trade 가 in-memory active map 에서
//   사라져 → tick stream 미수신 → 영구 OPEN row + 토큰 wallet orphan 위험.
// Pattern: cupsey / pure_ws recovery 와 동일.
//   1. DB getOpenTrades() filter strategy='kol_hunter'
//   2. live 모드: on-chain getTokenBalance == 0 → ORPHAN_NO_BALANCE 강제 close (재시도 spam 방지)
//      dust (< 1000 raw) → ORPHAN_DUST_BALANCE 강제 close
//   3. balance > 0: HWM 기준 inferredState (PROBE / RUNNER_T1 / T2 / T3) 추정 후 rehydrate
//      - participatingKols / kolScore / detectorVersion 일부 정보는 DB 미저장 → lost (best-effort)
//      - parameterVersion 도 DB 미저장 → kolHunterParameterVersion default 사용 (보수)
//      - marketReferencePrice = plannedEntryPrice ?? entryPrice (재시작 후 새 tick 자연 보정)
//   4. setActivePosition + ensurePriceListener + priceFeed.subscribe → tick 재개
export async function recoverKolHunterOpenPositions(ctx: BotContext): Promise<number> {
  if (!config.kolHunterEnabled) return 0;
  if (!priceFeed) {
    log.warn('[KOL_HUNTER_RECOVERY] priceFeed not initialized — skip recovery');
    return 0;
  }

  const openTrades = await ctx.tradeStore.getOpenTrades();
  const kolOpenTrades = openTrades.filter((t) => t.strategy === LANE_STRATEGY);
  let recovered = 0;

  for (const trade of kolOpenTrades) {
    // 1. orphan / dust 검사 (live 모드 필수). RPC 실패 시 보수적 fallback (in-memory load).
    if (ctx.tradingMode === 'live') {
      try {
        const probeExecutor = getKolHunterExecutor(ctx);
        const onchainBalance = await probeExecutor.getTokenBalance(trade.pairAddress);
        if (onchainBalance === 0n) {
          log.warn(
            `[KOL_HUNTER_RECOVERY_ORPHAN] trade=${trade.id.slice(0, 8)} pair=${trade.pairAddress.slice(0, 12)} ` +
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
          }).catch((err) => log.error(`[KOL_HUNTER_RECOVERY_ORPHAN] DB close failed for ${trade.id}: ${err}`));
          await ctx.notifier.sendCritical(
            'kol_hunter_recovery_orphan',
            `KOL recovery: ${trade.id.slice(0, 8)} ${trade.pairAddress} zero balance — DB closed, not loaded`
          ).catch(() => {});
          continue;
        }
        if (onchainBalance > 0n && onchainBalance < 1000n) {
          log.warn(
            `[KOL_HUNTER_RECOVERY_DUST] trade=${trade.id.slice(0, 8)} pair=${trade.pairAddress.slice(0, 12)} ` +
            `dust balance ${onchainBalance.toString()} < 1000 raw — closing DB with 0 pnl`
          );
          await ctx.tradeStore.closeTrade({
            id: trade.id,
            exitPrice: trade.entryPrice,
            pnl: 0,
            slippage: 0,
            exitReason: 'ORPHAN_DUST_BALANCE',
            exitSlippageBps: undefined,
            decisionPrice: trade.entryPrice,
          }).catch((err) => log.error(`[KOL_HUNTER_RECOVERY_DUST] DB close failed for ${trade.id}: ${err}`));
          continue;
        }
      } catch (balanceErr) {
        log.warn(
          `[KOL_HUNTER_RECOVERY_ORPHAN] balance check failed for ${trade.pairAddress.slice(0, 12)}: ` +
          `${balanceErr} — falling back to in-memory load`
        );
      }
    }

    // 2. State 추정 — HWM 기준 (cupsey/pure_ws 동일 패턴).
    //    KOL T3 = 9x → safe peak 상한 entryPrice * 20 (outlier 보호).
    const highWaterMark = trade.highWaterMark ?? trade.entryPrice;
    const safePeak = Math.min(highWaterMark, trade.entryPrice * 20);
    const inferredState: LaneTState =
      safePeak >= trade.entryPrice * (1 + config.kolHunterT3Mfe) ? 'RUNNER_T3'
      : safePeak >= trade.entryPrice * (1 + config.kolHunterT2Mfe) ? 'RUNNER_T2'
      : safePeak >= trade.entryPrice * (1 + config.kolHunterT1Mfe) ? 'RUNNER_T1'
      : 'PROBE';

    const entryTimeSec = Math.floor(trade.createdAt.getTime() / 1000);
    const positionId = `kolh-recover-${trade.pairAddress.slice(0, 8)}-${entryTimeSec}`;
    const t2BreakevenLockPrice = (inferredState === 'RUNNER_T2' || inferredState === 'RUNNER_T3')
      ? trade.entryPrice * config.kolHunterT2BreakevenLockMult
      : undefined;

    // parameterVersion / kol metadata 는 DB 미저장 → default 로 fallback (best-effort).
    const recoveredVersion = config.kolHunterParameterVersion;
    const recoveredArmName = armNameForVersion(recoveredVersion);
    const recoveredEntryReason = defaultEntryReasonForVersion(recoveredVersion);
    const recoveredConviction = defaultConvictionForVersion(recoveredVersion);

    const marketReferencePrice = trade.plannedEntryPrice ?? trade.entryPrice;
    // ticketSol: 정책상 fixed 0.01 SOL 이지만 보수적으로 trade row 에서 역산.
    const recoveredTicketSol = trade.entryPrice * trade.quantity;

    const position: PaperPosition = {
      positionId,
      tokenMint: trade.pairAddress,
      state: inferredState,
      entryPrice: trade.entryPrice,
      entryTimeSec,
      ticketSol: recoveredTicketSol,
      quantity: trade.quantity,
      marketReferencePrice,
      peakPrice: safePeak,
      troughPrice: marketReferencePrice,
      lastPrice: marketReferencePrice,
      participatingKols: [],
      kolScore: 0,
      armName: recoveredArmName,
      parameterVersion: recoveredVersion,
      isShadowArm: false,
      kolEntryReason: recoveredEntryReason,
      kolConvictionLevel: recoveredConviction,
      kolReinforcementCount: 0,
      detectorVersion: config.kolHunterDetectorVersion,
      independentKolCount: 0,
      survivalFlags: ['RECOVERED_FROM_DB'],
      t2BreakevenLockPrice,
      isLive: ctx.tradingMode === 'live',
      dbTradeId: trade.id,
      entryTxSignature: trade.txSignature,
      entrySlippageBps: trade.entrySlippageBps,
    };

    setActivePosition(position);
    ensurePriceListener(trade.pairAddress);
    priceFeed.subscribe(trade.pairAddress);
    recovered++;
    log.info(
      `[KOL_HUNTER_RECOVERED] ${positionId} trade=${trade.id.slice(0, 8)} ` +
      `state=${inferredState} pair=${trade.pairAddress.slice(0, 12)} live=${position.isLive}`
    );
  }

  return recovered;
}

// ─── Test utilities ──────────────────────────────────────

/** 테스트 전용: price feed override + 직접 시뮬레이션. */
export function __testInit(options: { priceFeed: PaperPriceFeed; ctx?: BotContext }): void {
  stopKolHunter();
  initKolHunter({ priceFeed: options.priceFeed, ctx: options.ctx });
}

/** 테스트 전용: live canary triple-flag gate 평가 결과 노출. */
export function __testIsLiveCanaryActive(): boolean {
  return isLiveCanaryActive();
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
