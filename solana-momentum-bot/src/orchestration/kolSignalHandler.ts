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
  | 'winner_trailing_t1'
  | 'winner_trailing_t2'
  | 'winner_trailing_t3'
  | 'stalk_expired_no_consensus';

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
  // 2026-04-25 MISSION_CONTROL §Control 5 telemetry — paper trade ledger 가 live 와 비교 가능하려면
  // arm identity / discovery cluster / parameter version 이 trade 단위로 기록되어야 한다.
  parameterVersion: string;
  detectorVersion: string;
  independentKolCount: number;
  survivalFlags: string[];
}

interface PendingCandidate {
  tokenMint: string;
  firstKolEntryMs: number;
  stalkExpiresAtMs: number;
  timer: NodeJS.Timeout;
  kolTxs: KolTx[];
}

// ─── Module State ────────────────────────────────────────

const pending = new Map<string, PendingCandidate>();        // tokenMint → pending
const active = new Map<string, PaperPosition>();            // positionId → position
const recentKolTxs: KolTx[] = [];                           // scoring 용 buffer (24h)
let priceFeed: PaperPriceFeed | null = null;
const priceListeners = new Map<string, (tick: PriceTick) => void>(); // tokenMint → handler

/**
 * MISSION_CONTROL §KOL Control survival 의존성 (2026-04-25):
 * Phase 3 paper-mode 도 live 와 동일한 entry-side gate 를 거쳐야 paper 결과가 live 비교 가능.
 * `initKolHunter({ securityClient, gateCache })` 로 주입. 미주입 시 survival 단계 skip
 * (config.kolHunterSurvivalAllowDataMissing 동작과 동일).
 */
let securityClient: OnchainSecurityClient | undefined;
let gateCache: GateCacheManager | undefined;

export const kolHunterEvents = new EventEmitter();           // 외부 관측용 (test/index)

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
    active: active.size,
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
    // Phase 4+: sell event 는 해당 mint 의 open position 에 exit cue 로 사용 가능
    log.debug(`[KOL_HUNTER] sell ${tx.kolId} ${tx.tokenMint.slice(0, 8)} (Phase 4+ exit signal)`);
    return;
  }

  // Active 또는 pending 이미 있으면 추가 KOL 만 집계
  const existingActive = [...active.values()].find((p) => p.tokenMint === tx.tokenMint);
  if (existingActive) {
    // 이미 진입한 포지션에 추가 KOL 은 정보만 누적 (sizing 변경 없음)
    if (!existingActive.participatingKols.find((k) => k.id === tx.kolId)) {
      existingActive.participatingKols.push({ id: tx.kolId, tier: tx.tier, timestamp: tx.timestamp });
    }
    return;
  }

  const existingPending = pending.get(tx.tokenMint);
  if (existingPending) {
    existingPending.kolTxs.push(tx);
    return;
  }

  // REFACTORING §2.1 hard constraint: max concurrent (Lane T 단독 상한).
  // 전역 3 은 canaryConcurrencyGuard 관할 — Phase 4 에서 연결 예정.
  const activeCount = active.size;
  const pendingCount = pending.size;
  const laneConcurrentBudget = activeCount + pendingCount;
  if (laneConcurrentBudget >= config.kolHunterMaxConcurrent) {
    log.info(
      `[KOL_HUNTER_SKIP] max concurrent (active=${activeCount} pending=${pendingCount} ` +
      `>= cap=${config.kolHunterMaxConcurrent}) — ${tokenMint(tx)} ${tx.kolId}`
    );
    return;
  }

  // 신규 pending candidate 생성 + stalk window 시작
  await registerPending(tx);
}

function tokenMint(tx: KolTx): string {
  return tx.tokenMint.slice(0, 8);
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

  // 진입 준비 — paper mode 강제. sell-quote sizing 은 enterPaperPosition 내부에서
  // entry price 가 확정된 후 별도로 수행 (planned quantity = ticketSol / entryPrice).
  if (!config.kolHunterPaperOnly) {
    log.warn(`[KOL_HUNTER] paper-only 강제 해제 감지 — Phase 4 canary 단계에서만 허용`);
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
 * (즉 0.01 SOL 로 살 양). decimals 는 securityClient.getMintDecimals 로 fetch (실패 시 6 fallback).
 *
 * Network 실패 / rate-limit 시 false halt 방지 — observability flag 만 남기고 통과.
 */
async function checkKolSellQuoteSized(
  tokenMint: string,
  plannedQuantityUi: number,
  ticketSol: number
): Promise<{ approved: boolean; reason?: string; flags: string[] }> {
  if (!config.kolHunterRunSellQuoteProbe) {
    return { approved: true, flags: ['SELL_PROBE_DISABLED'] };
  }
  if (!Number.isFinite(plannedQuantityUi) || plannedQuantityUi <= 0) {
    return { approved: true, flags: ['SELL_PROBE_INVALID_QTY'] };
  }
  let decimals: number | null = null;
  if (securityClient) {
    try {
      decimals = await securityClient.getMintDecimals(tokenMint);
    } catch (err) {
      log.debug(`[KOL_HUNTER_SURVIVAL] decimals fetch error ${tokenMint.slice(0, 12)}: ${err}`);
    }
  }
  const decimalsResolved = decimals ?? 6;
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
    const baseFlags = [`SELL_DECIMALS_${decimals === null ? 'FALLBACK6' : decimalsResolved}`];
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

// ─── Paper Entry ─────────────────────────────────────────

async function enterPaperPosition(
  tokenMint: string,
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  survivalFlags: string[] = []
): Promise<void> {
  if (!priceFeed) {
    log.warn(`[KOL_HUNTER] priceFeed not initialized — cannot enter`);
    return;
  }

  // 1. Entry price 측정 — priceFeed subscribe 후 최초 tick 까지 대기 (또는 1회 poll)
  priceFeed.subscribe(tokenMint);
  const entryPrice = await waitForFirstPrice(tokenMint, 10_000);
  if (entryPrice === null) {
    priceFeed.unsubscribe(tokenMint);
    log.warn(`[KOL_HUNTER] entry price fetch timeout ${tokenMint.slice(0, 8)}`);
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score);
    return;
  }

  const ticketSol = config.kolHunterTicketSol;
  const nowSec = Math.floor(Date.now() / 1000);
  const positionId = `kolh-${tokenMint.slice(0, 8)}-${nowSec}`;
  const quantity = entryPrice > 0 ? ticketSol / entryPrice : 0;

  // MISSION_CONTROL §KOL Control 2단계 — size-aware sell-quote probe.
  // 0.01 SOL 로 살 plannedQuantity 그대로를 매도 quote 로 검증 (1 token 가짜 probe 가 아님).
  // 거부되면 PROBE 진입 자체를 막아 paper 결과의 sell-side viability 분포를 정확히 측정.
  const sellSized = await checkKolSellQuoteSized(tokenMint, quantity, ticketSol);
  if (!sellSized.approved) {
    priceFeed.unsubscribe(tokenMint);
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
  const combinedSurvivalFlags = [...survivalFlags, ...sellSized.flags];

  const pos: PaperPosition = {
    positionId,
    tokenMint,
    state: 'PROBE',
    entryPrice,
    entryTimeSec: nowSec,
    ticketSol,
    quantity,
    marketReferencePrice: entryPrice,
    peakPrice: entryPrice,
    troughPrice: entryPrice,
    participatingKols: score.participatingKols,
    kolScore: score.finalScore,
    parameterVersion: config.kolHunterParameterVersion,
    detectorVersion: config.kolHunterDetectorVersion,
    independentKolCount: score.independentKolCount,
    survivalFlags: combinedSurvivalFlags,
  };
  active.set(positionId, pos);

  log.info(
    `[KOL_HUNTER_PAPER_ENTER] ${positionId} ${tokenMint.slice(0, 8)} ` +
    `entry=${entryPrice.toFixed(8)} ticket=${ticketSol}SOL kols=${score.independentKolCount} ` +
    `score=${score.finalScore.toFixed(2)}`
  );

  // 2. price listener 등록 — 이후 tick 마다 state machine 평가
  const listener = (tick: PriceTick) => {
    if (tick.tokenMint !== tokenMint) return;
    onPriceTick(positionId, tick);
  };
  priceListeners.set(tokenMint, listener);
  priceFeed.on('price', listener);

  kolHunterEvents.emit('paper_entry', pos);
}

async function waitForFirstPrice(tokenMint: string, timeoutMs: number): Promise<number | null> {
  if (!priceFeed) return null;
  const cached = priceFeed.getLastPrice(tokenMint);
  if (cached) return cached.price;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      priceFeed?.off('price', handler);
      resolve(null);
    }, timeoutMs);
    const handler = (tick: PriceTick) => {
      if (tick.tokenMint !== tokenMint) return;
      clearTimeout(timeout);
      priceFeed?.off('price', handler);
      resolve(tick.price);
    };
    priceFeed?.on('price', handler);
  });
}

// ─── State Machine ───────────────────────────────────────

function onPriceTick(positionId: string, tick: PriceTick): void {
  const pos = active.get(positionId);
  if (!pos || pos.state === 'CLOSED') return;

  const currentPrice = tick.price;
  if (currentPrice <= 0) return;

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
      if (elapsedSec >= config.kolHunterStalkWindowSec) {
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
      if (mfePct >= config.kolHunterT1Mfe) {
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
      const trailStop = pos.peakPrice * (1 - config.kolHunterT1TrailPct);
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
      },
    },
    buildObserverConfig()
  );

  // Paper ledger append
  void appendPaperLedger(pos, exitPrice, reason, holdSec, mfePctAtClose, maePctAtClose, netSol, netPct);

  // price feed unsubscribe
  const listener = priceListeners.get(pos.tokenMint);
  if (listener) {
    priceFeed?.off('price', listener);
    priceListeners.delete(pos.tokenMint);
  }
  priceFeed?.unsubscribe(pos.tokenMint);
  active.delete(pos.positionId);

  kolHunterEvents.emit('paper_close', { pos, reason, exitPrice, netSol, netPct });
}

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
      parameterVersion: pos.parameterVersion,
      detectorVersion: pos.detectorVersion,
      independentKolCount: pos.independentKolCount,
      survivalFlags: pos.survivalFlags,
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
