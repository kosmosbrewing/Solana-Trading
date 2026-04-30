/**
 * Migration Handoff Reclaim — Lane Handler (2026-04-17, Tier 1)
 *
 * State machine: COOLDOWN → STALK → READY → (entry) → PROBE → WINNER → CLOSED
 *
 * cupseyLaneHandler.ts 와 구조적으로 유사하지만 **독립 Map**으로 격리된다.
 * Phase A/B1 패턴을 그대로 복제 (enteringLock reentrancy guard).
 *
 * Signal-only mode:
 *   config.migrationLaneSignalOnly = true 이면 READY 시점에 signal-intent 기록만 하고
 *   실거래(executeBuy)는 수행하지 않는다. paper/live 전환 전 검증용.
 */
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import { Order, PartialFillDataReason, Trade, CloseReason } from '../utils/types';
import { config } from '../utils/config';
import { MicroCandleBuilder } from '../realtime';
import {
  MigrationEvent,
  MigrationStageResult,
  MigrationGateConfig,
  evaluateMigrationStage,
} from '../strategy/migrationHandoffReclaim';
import { BotContext } from './types';
import { bpsToDecimal } from '../utils/units';
import { isWalletStopActive } from '../risk/walletStopGuard';
import { acquireCanarySlot, releaseCanarySlot } from '../risk/canaryConcurrencyGuard';
import { reportCanaryClose } from '../risk/canaryAutoHalt';
import { checkPureWsSurvival } from './pureWs/survivalCheck';
import { serializeClose } from './swapSerializer';
import { appendEntryLedger, persistOpenTradeWithIntegrity, isEntryHaltActive } from './entryIntegrity';
import { resolveActualEntryMetrics } from './signalProcessor';
import { resolveTokenSymbol, lookupCachedSymbol } from '../ingester/tokenSymbolResolver';

const log = createModuleLogger('MigrationLane');

interface MigrationPosition {
  tradeId: string;
  dbTradeId?: string;
  event: MigrationEvent;
  stage: 'COOLDOWN' | 'STALK' | 'PROBE' | 'WINNER' | 'REJECT' | 'CLOSED';
  /** reclaim 이후 entry 가격 */
  entryPrice: number;
  /** 실 매수 시각 */
  entryTimeSec: number;
  quantity: number;
  peakPrice: number;
  troughPrice: number;
  entryTxSignature?: string;
  entrySlippageBps?: number;
  /** Patch A 패턴: entry 중복 실행 차단 */
  enteringLock?: boolean;
  lastCloseFailureAtSec?: number;
}

const activePositions = new Map<string, MigrationPosition>();
// 2026-04-17 M1: TTL-based dedupe (Set → Map<signature, timestampMs>)
// Why: `Set<string>` 는 무한 증가. 24h TTL 이후 prune. cupsey executedLedger 패턴 재사용.
const processedEventTimestamps = new Map<string, number>();
const PROCESSED_EVENT_TTL_MS = 24 * 60 * 60 * 1000;
let signalLedgerDirEnsured = false;

function pruneProcessedEvents(nowMs = Date.now()): void {
  const cutoff = nowMs - PROCESSED_EVENT_TTL_MS;
  for (const [sig, ts] of processedEventTimestamps) {
    if (ts < cutoff) processedEventTimestamps.delete(sig);
  }
}

function isEventProcessed(sig: string): boolean {
  const ts = processedEventTimestamps.get(sig);
  if (ts == null) return false;
  if (Date.now() - ts >= PROCESSED_EVENT_TTL_MS) {
    processedEventTimestamps.delete(sig);
    return false;
  }
  return true;
}

export function getActiveMigrationPositions(): ReadonlyMap<string, MigrationPosition> {
  return activePositions;
}

export function resetMigrationLaneStateForTests(): void {
  activePositions.clear();
  processedEventTimestamps.clear();
}

function getExecutor(ctx: BotContext) {
  // Block 1 (2026-04-18): explicit wallet mode — wallet ownership ambiguity 해소.
  const mode = config.migrationWalletMode;
  if (mode === 'main') return ctx.executor;
  if (mode === 'sandbox') {
    if (!ctx.sandboxExecutor) {
      throw new Error(
        `MIGRATION_WALLET_MODE=sandbox but sandboxExecutor not initialized. ` +
        `Check SANDBOX_WALLET_PRIVATE_KEY.`
      );
    }
    return ctx.sandboxExecutor;
  }
  return ctx.sandboxExecutor ?? ctx.executor;
}

export function resolveMigrationWalletLabel(ctx: BotContext): 'main' | 'sandbox' {
  const mode = config.migrationWalletMode;
  if (mode === 'main') return 'main';
  if (mode === 'sandbox') return 'sandbox';
  return ctx.sandboxExecutor ? 'sandbox' : 'main';
}

function makeGateConfig(): MigrationGateConfig {
  return {
    cooldownSec: config.migrationCooldownSec,
    maxAgeSec: config.migrationMaxAgeSec,
    stalkMinPullbackPct: config.migrationStalkMinPullbackPct,
    stalkMaxPullbackPct: config.migrationStalkMaxPullbackPct,
    reclaimBuyRatioMin: config.migrationReclaimBuyRatioMin,
  };
}

/**
 * 재시작 시 DB의 OPEN 상태 migration_reclaim trade 를 in-memory 로 복구.
 * cupsey.recoverCupseyOpenPositions 패턴 복제 + peak sanity guard 동일 적용.
 */
export async function recoverMigrationOpenPositions(ctx: BotContext): Promise<number> {
  if (!config.migrationLaneEnabled) return 0;

  const openTrades = await ctx.tradeStore.getOpenTrades();
  const migrationOpenTrades = openTrades.filter((trade) => trade.strategy === 'migration_reclaim');
  let recovered = 0;

  for (const trade of migrationOpenTrades) {
    // 중복 추적 방지
    const alreadyTracked = [...activePositions.values()].some(
      (position) =>
        position.dbTradeId === trade.id ||
        (position.event.pairAddress === trade.pairAddress && position.stage !== 'CLOSED')
    );
    if (alreadyTracked) continue;

    // Peak sanity: DB HWM 이 entry 대비 cupseyMaxPeakMultiplier 초과면 entry 로 clamp.
    const maxAllowedPeak = trade.entryPrice * config.cupseyMaxPeakMultiplier;
    const rawHwm = trade.highWaterMark ?? trade.entryPrice;
    const sanitizedHwm = rawHwm > maxAllowedPeak ? trade.entryPrice : Math.max(rawHwm, trade.entryPrice);
    if (rawHwm > maxAllowedPeak) {
      log.warn(
        `[MIG_RECOVER_HWM_CLAMP] trade=${trade.id.slice(0, 8)} DB hwm=${rawHwm.toFixed(8)} > ` +
        `${config.cupseyMaxPeakMultiplier}x entry=${trade.entryPrice.toFixed(8)} — clamped to entry`
      );
    }

    // 원본 event 정보 복원 — DB 에는 `discovery_source` 에 kind 저장, event_time 은 created_at 근사.
    const entryTimeSec = Math.floor(trade.createdAt.getTime() / 1000);
    const recoveredKind = (trade.discoverySource as MigrationEvent['kind']) ?? 'pumpswap_canonical_init';
    const recoveredEvent: MigrationEvent = {
      kind: recoveredKind,
      pairAddress: trade.pairAddress,
      tokenSymbol: trade.tokenSymbol,
      eventPrice: trade.entryPrice,
      eventTimeSec: entryTimeSec,
      signature: `migration-recover-${trade.id}`,
    };

    // Inferred stage: DB HWM 가 MFE threshold 이상이면 WINNER, 아니면 PROBE.
    const mfeRatio = (sanitizedHwm - trade.entryPrice) / trade.entryPrice;
    const recoveredStage: MigrationPosition['stage'] =
      mfeRatio >= config.migrationProbeMfeThreshold ? 'WINNER' : 'PROBE';

    const positionId = `migration-recover-${trade.id}`;
    activePositions.set(positionId, {
      tradeId: positionId,
      dbTradeId: trade.id,
      event: recoveredEvent,
      stage: recoveredStage,
      entryPrice: trade.entryPrice,
      entryTimeSec,
      quantity: trade.quantity,
      peakPrice: sanitizedHwm,
      troughPrice: trade.entryPrice,
      entryTxSignature: trade.txSignature,
      entrySlippageBps: trade.entrySlippageBps,
    });
    // processedEvents 에 signature 등록 — 같은 DB 상태에서 중복 복구 방지.
    processedEventTimestamps.set(recoveredEvent.signature, Date.now());
    recovered++;
    log.info(
      `[MIG_RECOVERED] ${positionId} trade=${trade.id.slice(0, 8)} ` +
      `stage=${recoveredStage} pair=${trade.pairAddress.slice(0, 12)}`
    );
  }

  return recovered;
}

/**
 * 새 migration event 수신 → STALK 포지션 생성 (미체결).
 * idempotent: 같은 signature의 event는 한 번만 처리.
 */
export function onMigrationEvent(event: MigrationEvent, ctx: BotContext): void {
  if (!config.migrationLaneEnabled) return;
  // Wallet stop guard (override 가드레일 #2) — entry만 차단
  if (isWalletStopActive()) {
    log.debug(`[MIG_EVENT_WALLET_STOP] ${event.signature.slice(0, 12)} ignored — wallet stop active`);
    return;
  }
  // 2026-04-17 Block 1.5-2: entry integrity halt (insertTrade 실패 누적 방지)
  if (isEntryHaltActive('migration')) {
    log.debug(`[MIG_EVENT_HALT] ${event.signature.slice(0, 12)} ignored — migration entry halt active`);
    return;
  }
  pruneProcessedEvents();
  if (isEventProcessed(event.signature)) {
    log.debug(`[MIG_EVENT_DUP] ${event.signature.slice(0, 12)} already processed`);
    return;
  }
  processedEventTimestamps.set(event.signature, Date.now());

  // 2026-04-29: token symbol prefetch (Helius DAS + pump.fun, 24h cache).
  // F3 fix: cache hit 시 함수 진입 skip.
  if (!event.tokenSymbol && !lookupCachedSymbol(event.pairAddress)) {
    void resolveTokenSymbol(event.pairAddress).catch(() => {});
  }

  // 같은 pair 에 이미 활성 포지션 있으면 skip (cupsey와 독립 카운트)
  for (const pos of activePositions.values()) {
    if (pos.event.pairAddress === event.pairAddress && pos.stage !== 'CLOSED') {
      log.debug(`[MIG_EVENT_SKIP] ${event.pairAddress.slice(0, 12)} already tracked`);
      return;
    }
  }

  // 동시 활성 제한
  const activeCount = [...activePositions.values()].filter((p) => p.stage !== 'CLOSED').length;
  if (activeCount >= config.migrationMaxConcurrent) {
    log.debug(`[MIG_EVENT_SKIP] max concurrent ${activeCount} — ignoring ${event.pairAddress.slice(0, 12)}`);
    return;
  }

  const positionId = `migration-${event.pairAddress.slice(0, 8)}-${event.eventTimeSec}`;
  activePositions.set(positionId, {
    tradeId: positionId,
    event,
    stage: 'COOLDOWN',
    entryPrice: event.eventPrice,
    entryTimeSec: event.eventTimeSec,
    quantity: 0,
    peakPrice: event.eventPrice,
    troughPrice: event.eventPrice,
  });
  log.info(
    `[MIG_EVENT] ${positionId} ${event.kind} pair=${event.pairAddress.slice(0, 12)} ` +
    `eventPrice=${event.eventPrice.toFixed(8)} — entering COOLDOWN`
  );
}

/**
 * 매 candle tick 마다 활성 포지션의 상태를 전진.
 */
export async function updateMigrationPositions(
  ctx: BotContext,
  candleBuilder: MicroCandleBuilder
): Promise<void> {
  if (!config.migrationLaneEnabled) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const gate = makeGateConfig();

  for (const [id, pos] of activePositions) {
    if (pos.stage === 'CLOSED' || pos.stage === 'REJECT') {
      activePositions.delete(id);
      continue;
    }

    const currentPrice = candleBuilder.getCurrentPrice(pos.event.pairAddress);
    if (currentPrice == null || currentPrice <= 0) continue;

    // STALK 판정 (COOLDOWN/STALK/READY 결정)
    if (pos.stage === 'COOLDOWN' || pos.stage === 'STALK') {
      const recentCandles = candleBuilder.getRecentCandles(
        pos.event.pairAddress,
        config.realtimePrimaryIntervalSec,
        10
      );
      const stageResult = evaluateMigrationStage(pos.event, nowSec, currentPrice, recentCandles, gate);

      if (stageResult.stage === 'REJECT_CRASH' || stageResult.stage === 'REJECT_TIMEOUT' || stageResult.stage === 'REJECT_NO_PULLBACK') {
        log.info(`[MIG_REJECT] ${id} ${stageResult.stage}: ${stageResult.reason}`);
        pos.stage = 'REJECT';
        activePositions.delete(id);
        continue;
      }

      if (stageResult.stage === 'COOLDOWN') {
        pos.stage = 'COOLDOWN';
        continue;
      }

      if (stageResult.stage === 'STALK') {
        pos.stage = 'STALK';
        continue;
      }

      if (stageResult.stage === 'READY') {
        // Patch A 패턴: reentrancy guard
        if (pos.enteringLock) {
          log.debug(`[MIG_READY_REENTRY_BLOCKED] ${id} entering in progress`);
          continue;
        }
        // Wallet stop guard: event 발화 후 READY 까지 수 분 경과 가능 — 재확인.
        if (isWalletStopActive()) {
          log.info(`[MIG_READY_WALLET_STOP] ${id} skipping entry — wallet stop active. dropping position.`);
          pos.stage = 'REJECT';
          activePositions.delete(id);
          continue;
        }
        pos.enteringLock = true;

        // Signal-only 모드: 체결 없이 signal-intent 기록만
        if (config.migrationLaneSignalOnly) {
          await appendMigrationSignal({
            positionId: id,
            event: pos.event,
            readyAtSec: nowSec,
            pullbackPct: stageResult.pullbackPct,
            buyRatio: stageResult.buyRatio ?? 0,
            ageSec: stageResult.ageSec,
            currentPrice,
            mode: 'signal_only',
          });
          log.info(
            `[MIG_SIGNAL_ONLY] ${id} READY recorded — pullback=${(stageResult.pullbackPct * 100).toFixed(1)}% ` +
            `buy_ratio=${stageResult.buyRatio?.toFixed(3)} (no execution)`
          );
          pos.stage = 'CLOSED';
          activePositions.delete(id);
          continue;
        }

        // Live/paper entry
        await enterMigrationProbe(id, pos, currentPrice, stageResult, ctx);
        continue;
      }
    }

    // PROBE 진입 이후: cupsey와 동일한 logic 재사용 (간략 버전)
    if (pos.stage === 'PROBE' || pos.stage === 'WINNER') {
      // Peak sanity guard (cupseyMaxPeakMultiplier 공유) — HWM axis oxidation 방어.
      // cupsey와 동일 방어 패턴 복제 (docs/audits/... 2026-04-17 참조).
      const maxAllowedPeak = pos.entryPrice * config.cupseyMaxPeakMultiplier;
      if (currentPrice <= maxAllowedPeak) {
        pos.peakPrice = Math.max(pos.peakPrice, currentPrice);
      } else {
        log.warn(
          `[MIG_PEAK_SPIKE_SKIP] ${id} currentPrice=${currentPrice.toFixed(8)} > ` +
          `${config.cupseyMaxPeakMultiplier}x entry=${pos.entryPrice.toFixed(8)} — skipping peak update`
        );
      }
      pos.troughPrice = Math.min(pos.troughPrice, currentPrice);
      const elapsed = nowSec - pos.entryTimeSec;
      const mfePct = (pos.peakPrice - pos.entryPrice) / pos.entryPrice;
      const maePct = (pos.troughPrice - pos.entryPrice) / pos.entryPrice;

      if (pos.stage === 'PROBE') {
        if (maePct <= -config.migrationProbeHardCutPct) {
          log.info(`[MIG_REJECT] ${id} hard cut MAE=${(maePct * 100).toFixed(2)}% elapsed=${elapsed}s`);
          await closeMigrationPosition(id, pos, currentPrice, 'REJECT_HARD_CUT', ctx);
          continue;
        }
        if (mfePct >= config.migrationProbeMfeThreshold) {
          pos.stage = 'WINNER';
          log.info(`[MIG_WINNER] ${id} promoted MFE=${(mfePct * 100).toFixed(2)}% elapsed=${elapsed}s`);
          continue;
        }
        if (elapsed >= config.migrationProbeWindowSec) {
          log.info(`[MIG_REJECT] ${id} probe timeout elapsed=${elapsed}s`);
          await closeMigrationPosition(id, pos, currentPrice, 'REJECT_TIMEOUT', ctx);
          continue;
        }
      }

      if (pos.stage === 'WINNER') {
        const trailingStop = pos.peakPrice * (1 - config.migrationWinnerTrailingPct);
        if (elapsed >= config.migrationWinnerMaxHoldSec) {
          log.info(`[MIG_CLOSE] ${id} winner time stop elapsed=${elapsed}s`);
          await closeMigrationPosition(id, pos, currentPrice, 'WINNER_TIME_STOP', ctx);
          continue;
        }
        if (currentPrice <= trailingStop) {
          log.info(`[MIG_CLOSE] ${id} trailing stop hit price=${currentPrice.toFixed(8)} trail=${trailingStop.toFixed(8)}`);
          await closeMigrationPosition(id, pos, currentPrice, 'TRAILING_STOP', ctx);
          continue;
        }
      }
    }
  }
}

async function enterMigrationProbe(
  id: string,
  pos: MigrationPosition,
  currentPrice: number,
  stageResult: MigrationStageResult,
  ctx: BotContext
): Promise<void> {
  const ticketSol = config.migrationLaneTicketSol;
  const quantity = currentPrice > 0 ? ticketSol / currentPrice : 0;
  if (quantity <= 0) {
    log.warn(`[MIG_ENTRY_SKIP] ${id} quantity<=0 (currentPrice=${currentPrice})`);
    pos.stage = 'REJECT';
    activePositions.delete(id);
    return;
  }

  // 2026-04-26 Real Asset Guard 정합 fix: security hard reject (§6).
  // 이전: migration 은 stage 평가만 — honeypot/Token-2022 transferHook 무방어.
  // live 모드에서 survival check 호출 (pureWs/checkPureWsSurvival 재사용, gateCache 공유).
  if (config.securityGateEnabled && ctx.tradingMode === 'live') {
    const survival = await checkPureWsSurvival(pos.event.pairAddress, ctx);
    if (!survival.approved) {
      log.warn(
        `[MIG_SURVIVAL_REJECT] ${id} ${pos.event.pairAddress.slice(0, 12)} ` +
        `reason=${survival.reason} flags=[${survival.flags.join(',')}]`
      );
      pos.stage = 'REJECT';
      activePositions.delete(id);
      return;
    }
  }

  // 2026-04-26 Real Asset Guard 정합 fix:
  // Migration lane 이 canary slot acquire 미사용 → cupsey/pure_ws 와 합산 시 전역 cap 우회됨.
  // primary canary lane 으로 등록 — release 는 close path 에서.
  if (!acquireCanarySlot('migration')) {
    log.info(`[MIG_ENTRY_SKIP] ${id} global canary slot full`);
    pos.stage = 'REJECT';
    activePositions.delete(id);
    return;
  }

  let actualEntryPrice = currentPrice;
  let actualQuantity = quantity;
  let actualNotionalSol = currentPrice * quantity;  // 2026-04-29: RPC 측정 wallet delta 전파용
  let partialFillDataMissing = false;
  let partialFillDataReason: PartialFillDataReason | undefined;
  let entryTxSignature = 'PAPER_TRADE';
  let entrySlippageBps = 0;

  if (ctx.tradingMode === 'live') {
    try {
      const executor = getExecutor(ctx);
      const order: Order = {
        pairAddress: pos.event.pairAddress,
        strategy: 'migration_reclaim',
        side: 'BUY',
        price: currentPrice,
        quantity,
        stopLoss: currentPrice * (1 - config.migrationProbeHardCutPct),
        takeProfit1: currentPrice * (1 + config.migrationProbeMfeThreshold),
        takeProfit2: currentPrice * (1 + config.migrationWinnerTrailingPct * 2),
        timeStopMinutes: Math.ceil(config.migrationWinnerMaxHoldSec / 60),
      };
      const buyResult = await executor.executeBuy(order);
      // 2026-04-18 drift fix: all-or-nothing guard (same root cause as cupsey/pure_ws).
      const metrics = resolveActualEntryMetrics(order, buyResult);
      actualEntryPrice = metrics.entryPrice;
      actualQuantity = metrics.quantity;
      actualNotionalSol = metrics.actualEntryNotionalSol;
      partialFillDataMissing = metrics.partialFillDataMissing;
      partialFillDataReason = metrics.partialFillDataReason;
      entryTxSignature = buyResult.txSignature;
      entrySlippageBps = buyResult.slippageBps;
      log.info(
        `[MIG_LIVE_BUY] ${id} sig=${entryTxSignature.slice(0, 12)} slip=${entrySlippageBps}bps`
      );
    } catch (buyErr) {
      log.warn(`[MIG_LIVE_BUY] ${id} buy failed: ${buyErr}`);
      pos.stage = 'REJECT';
      activePositions.delete(id);
      releaseCanarySlot('migration');  // 2026-04-26 Real Asset Guard: 누수 방지
      return;
    }
  }

  pos.stage = 'PROBE';
  pos.entryPrice = actualEntryPrice;
  pos.entryTimeSec = Math.floor(Date.now() / 1000);
  pos.quantity = actualQuantity;
  pos.peakPrice = actualEntryPrice;
  pos.troughPrice = actualEntryPrice;
  pos.entryTxSignature = entryTxSignature;
  pos.entrySlippageBps = entrySlippageBps;

  // DB persist — cupsey와 동일한 `source_label` 구분으로 attribution 분리.
  // 2026-04-17 Block 1.5-2: 공통 entryIntegrity helper 적용 (lane='migration').
  // 이전에는 halt 없이 critical 만 발송 (M8 Low 우선순위로 flag됨) — 이제 승격.
  const persistResult = await persistOpenTradeWithIntegrity({
    ctx,
    lane: 'migration',
    tradeData: {
      pairAddress: pos.event.pairAddress,
      strategy: 'migration_reclaim',
      side: 'BUY',
      tokenSymbol: pos.event.tokenSymbol,
      sourceLabel: config.migrationSourceLabel,
      discoverySource: pos.event.kind,
      entryPrice: actualEntryPrice,
      plannedEntryPrice: currentPrice,
      quantity: actualQuantity,
      stopLoss: actualEntryPrice * (1 - config.migrationProbeHardCutPct),
      takeProfit1: actualEntryPrice * (1 + config.migrationProbeMfeThreshold),
      takeProfit2: actualEntryPrice * (1 + config.migrationWinnerTrailingPct * 2),
      trailingStop: undefined,
      highWaterMark: actualEntryPrice,
      timeStopAt: new Date((pos.entryTimeSec + config.migrationWinnerMaxHoldSec) * 1000),
      status: 'OPEN',
      txSignature: entryTxSignature,
      createdAt: new Date(pos.entryTimeSec * 1000),
      entrySlippageBps,
    },
    ledgerEntry: {
      positionId: id,
      txSignature: entryTxSignature,
      strategy: 'migration_reclaim',
      wallet: resolveMigrationWalletLabel(ctx), // Block 1 QA fix: wallet-aware comparator
      pairAddress: pos.event.pairAddress,
      tokenSymbol: pos.event.tokenSymbol,
      plannedEntryPrice: currentPrice,
      actualEntryPrice,
      actualQuantity,
      slippageBps: entrySlippageBps,
      partialFillDataMissing,
      partialFillDataReason,
    },
    notifierKey: 'migration_open_persist',
    buildNotifierMessage: (err) =>
      `${id} ${pos.event.pairAddress} buy persisted FAILED after tx=${entryTxSignature} — ` +
      `NEW MIGRATION ENTRIES HALTED. Call resetEntryHalt('migration') after reconciliation. err=${err}`,
  });
  if (persistResult.dbTradeId) {
    pos.dbTradeId = persistResult.dbTradeId;
    // 2026-04-28 P0-B fix: notifier fire-and-forget (이전엔 await 였으나 .catch(() => {}) 만 있어 사실상 fire-and-forget. void 로 의도 명시).
    void ctx.notifier.sendTradeOpen({
      tradeId: persistResult.dbTradeId,
      pairAddress: pos.event.pairAddress,
      strategy: 'migration_reclaim',
      side: 'BUY',
      // 2026-04-29: event upstream → resolver cache → undefined fallback.
      tokenSymbol: pos.event.tokenSymbol ?? lookupCachedSymbol(pos.event.pairAddress) ?? undefined,
      price: actualEntryPrice,
      plannedEntryPrice: currentPrice,
      quantity: actualQuantity,
      sourceLabel: config.migrationSourceLabel,
      discoverySource: pos.event.kind,
      stopLoss: actualEntryPrice * (1 - config.migrationProbeHardCutPct),
      takeProfit1: actualEntryPrice * (1 + config.migrationProbeMfeThreshold),
      takeProfit2: actualEntryPrice * (1 + config.migrationWinnerTrailingPct * 2),
      timeStopMinutes: Math.ceil(config.migrationWinnerMaxHoldSec / 60),
      // 2026-04-29: RPC 측정 wallet delta + partial-fill flag.
      actualNotionalSol,
      partialFillDataMissing,
      partialFillDataReason,
    }, entryTxSignature).catch(() => {});
  }
}

async function closeMigrationPosition(
  id: string,
  pos: MigrationPosition,
  exitPrice: number,
  reason: CloseReason,
  ctx: BotContext
): Promise<void> {
  // Shared close mutex (with cupsey) — 두 lane 공유 wallet 의 solBefore/solAfter race 차단.
  return serializeClose(() => closeMigrationPositionSerialized(id, pos, exitPrice, reason, ctx));
}

async function closeMigrationPositionSerialized(
  id: string,
  pos: MigrationPosition,
  exitPrice: number,
  reason: CloseReason,
  ctx: BotContext
): Promise<void> {
  // 직렬화 대기 중 이미 다른 경로가 close 완료했을 가능성 — 재검사.
  if (pos.stage === 'CLOSED') {
    log.debug(`[MIG_CLOSE_SKIP] ${id} already CLOSED — skip re-entry`);
    return;
  }
  let actualExitPrice = exitPrice;
  let executionSlippage = 0;
  let exitTxSignature = pos.entryTxSignature;
  const holdSec = Math.floor(Date.now() / 1000) - pos.entryTimeSec;

  if (ctx.tradingMode === 'live') {
    try {
      const executor = getExecutor(ctx);
      // 2026-04-28 P0-C fix: tokenBalance + getBalance(solBefore) 병렬 (~250ms 단축).
      const [tokenBalance, solBefore] = await Promise.all([
        executor.getTokenBalance(pos.event.pairAddress),
        executor.getBalance(),
      ]);
      if (tokenBalance > 0n) {
        const sellResult = await executor.executeSell(pos.event.pairAddress, tokenBalance);
        const solAfter = await executor.getBalance();
        const receivedSol = solAfter - solBefore;
        // 2026-04-29: wallet ground truth — receivedSol 부호 무관 항상 wallet 기준.
        if (pos.quantity > 0) {
          actualExitPrice = receivedSol / pos.quantity;
        }
        executionSlippage = bpsToDecimal(sellResult.slippageBps);
        exitTxSignature = sellResult.txSignature;
        log.info(
          `[MIG_LIVE_SELL] ${id} sig=${sellResult.txSignature.slice(0, 12)} ` +
          `received=${receivedSol.toFixed(6)} SOL slip=${sellResult.slippageBps}bps`
        );
      } else {
        log.warn(`[MIG_SELL] ${id} no token balance — skipping sell`);
      }
    } catch (sellErr) {
      log.warn(`[MIG_LIVE_SELL] ${id} sell failed: ${sellErr}`);
      const nowSec = Math.floor(Date.now() / 1000);
      if (!pos.lastCloseFailureAtSec || nowSec - pos.lastCloseFailureAtSec >= 60) {
        pos.lastCloseFailureAtSec = nowSec;
        await ctx.notifier.sendCritical(
          'migration_close_failed',
          `${id} ${pos.event.pairAddress} reason=${reason} sell failed`
        ).catch(() => {});
      }
      return;
    }
  }

  pos.stage = 'CLOSED';
  const rawPnl = (actualExitPrice - pos.entryPrice) * pos.quantity;
  const paperCost = ctx.tradingMode === 'paper'
    ? pos.entryPrice * pos.quantity * (config.defaultAmmFeePct + config.defaultMevMarginPct)
    : 0;
  const pnl = rawPnl - paperCost;
  const exitSlippageBps = ctx.tradingMode === 'live' ? Math.round(executionSlippage * 10_000) : undefined;

  if (pos.dbTradeId) {
    try {
      await ctx.tradeStore.closeTrade({
        id: pos.dbTradeId,
        exitPrice: actualExitPrice,
        pnl,
        slippage: executionSlippage,
        exitReason: reason,
        exitSlippageBps,
      });
    } catch (err) {
      log.warn(`[MIG_CLOSE_PERSIST_FAIL] ${id}: ${err}`);
    }
  }

  log.info(
    `[MIG_CLOSED] ${id} reason=${reason} ` +
    `pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL hold=${holdSec}s`
  );

  if (pos.dbTradeId) {
    const closedTrade: Trade = {
      id: pos.dbTradeId,
      pairAddress: pos.event.pairAddress,
      strategy: 'migration_reclaim',
      side: 'BUY',
      // 2026-04-29: close path 도 동일 fallback 체인.
      tokenSymbol: pos.event.tokenSymbol ?? lookupCachedSymbol(pos.event.pairAddress) ?? undefined,
      sourceLabel: config.migrationSourceLabel,
      discoverySource: pos.event.kind,
      entryPrice: pos.entryPrice,
      exitPrice: actualExitPrice,
      quantity: pos.quantity,
      pnl,
      slippage: executionSlippage,
      txSignature: exitTxSignature,
      status: 'CLOSED',
      createdAt: new Date(pos.entryTimeSec * 1000),
      closedAt: new Date(),
      stopLoss: pos.entryPrice * (1 - config.migrationProbeHardCutPct),
      takeProfit1: pos.entryPrice * (1 + config.migrationProbeMfeThreshold),
      takeProfit2: pos.entryPrice * (1 + config.migrationWinnerTrailingPct * 2),
      highWaterMark: pos.peakPrice,
      timeStopAt: new Date((pos.entryTimeSec + config.migrationWinnerMaxHoldSec) * 1000),
      entrySlippageBps: pos.entrySlippageBps,
      exitSlippageBps,
      exitReason: reason,
    };
    // 2026-04-28 P0-B fix: notifier fire-and-forget.
    void ctx.notifier.sendTradeClose(closedTrade).catch(() => {});
  }

  // 2026-04-26 Real Asset Guard fix: per-lane auto-halt feed + global slot release.
  // migration 은 이전까지 reportCanaryClose 호출 부재 → consec losers / budget cap 추적 안 됐음.
  reportCanaryClose('migration', pnl);
  releaseCanarySlot('migration');

  activePositions.delete(id);
}

/**
 * Signal-only 모드 로깅. paper/live 배포 전에 READY 이벤트의 자연 occurrence를 집계.
 */
async function appendMigrationSignal(entry: Record<string, unknown>): Promise<void> {
  try {
    const logDir = config.realtimeDataDir;
    if (!signalLedgerDirEnsured) {
      await mkdir(logDir, { recursive: true });
      signalLedgerDirEnsured = true;
    }
    await appendFile(
      path.join(logDir, 'migration-signals.jsonl'),
      JSON.stringify({ ...entry, recordedAt: new Date().toISOString() }) + '\n',
      'utf8'
    );
  } catch {
    // Why: signal 기록 실패는 trading path 차단하지 않음
  }
}
