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
import { BotContext } from './types';
import { bpsToDecimal } from '../utils/units';
import { isWalletStopActive } from '../risk/walletStopGuard';
import { serializeClose } from './swapSerializer';
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
  entryPrice: number;
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

export function resetPureWsLaneStateForTests(): void {
  activePositions.clear();
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

  // Concurrency cap — lane-level
  const activeCount = [...activePositions.values()].filter((p) => p.state !== 'CLOSED').length;
  if (activeCount >= config.pureWsMaxConcurrent) {
    log.debug(`[PUREWS_SKIP] lane max concurrent (${activeCount})`);
    return;
  }

  // Loose signal gate (factor set reuse, threshold 완화)
  if (config.pureWsGateEnabled) {
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
      if (buyResult.actualOutUiAmount && buyResult.actualOutUiAmount > 0) {
        actualQuantity = buyResult.actualOutUiAmount;
      }
      if (buyResult.actualInputUiAmount && buyResult.actualInputUiAmount > 0 && actualQuantity > 0) {
        actualEntryPrice = buyResult.actualInputUiAmount / actualQuantity;
      }
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

  const position: PureWsPosition = {
    tradeId: positionId,
    dbTradeId: persistResult.dbTradeId ?? undefined,
    pairAddress: signal.pairAddress,
    entryPrice: actualEntryPrice,
    entryTimeSec: nowSec,
    quantity: actualQuantity,
    state: 'PROBE',
    peakPrice: actualEntryPrice,
    troughPrice: actualEntryPrice,
    tokenSymbol: signal.tokenSymbol,
    sourceLabel: signal.sourceLabel,
    discoverySource: signal.discoverySource,
    plannedEntryPrice: signal.price,
    entryTxSignature,
    entrySlippageBps,
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

    // HWM peak sanity (Patch B2 동일 원칙)
    const maxPeak = pos.entryPrice * config.pureWsMaxPeakMultiplier;
    if (currentPrice > pos.peakPrice && currentPrice <= maxPeak) {
      pos.peakPrice = currentPrice;
    }
    if (currentPrice < pos.troughPrice) {
      pos.troughPrice = currentPrice;
    }

    const mfePct = (pos.peakPrice - pos.entryPrice) / pos.entryPrice;
    const maePct = (pos.troughPrice - pos.entryPrice) / pos.entryPrice;
    const currentPct = (currentPrice - pos.entryPrice) / pos.entryPrice;
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
          pos.t2BreakevenLockPrice = pos.entryPrice * config.pureWsT2BreakevenLockMultiplier;
          funnelStats.winnersT2++;
          log.info(
            `[PUREWS_T2] ${id} promoted RUNNER_T2 MFE=${(mfePct * 100).toFixed(2)}% ` +
            `lock=${pos.t2BreakevenLockPrice.toFixed(8)}`
          );
          break;
        }
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
        const trailStop = Math.max(
          pos.peakPrice * (1 - config.pureWsT2TrailingPct),
          pos.t2BreakevenLockPrice ?? pos.entryPrice * config.pureWsT2BreakevenLockMultiplier
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
        // No time stop — runner mode. 단일 exit = trail 25%.
        const trailStop = Math.max(
          pos.peakPrice * (1 - config.pureWsT3TrailingPct),
          pos.t2BreakevenLockPrice ?? pos.entryPrice * config.pureWsT2BreakevenLockMultiplier
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
        throw new Error('no token balance for purews close');
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
    `hold=${holdSec}s peak=${((pos.peakPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)}%`
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
}

// ─── Recovery ───

export async function recoverPureWsOpenPositions(ctx: BotContext): Promise<number> {
  if (!config.pureWsLaneEnabled) return 0;

  const openTrades = await ctx.tradeStore.getOpenTrades();
  const pureWsOpenTrades = openTrades.filter((t) => t.strategy === LANE_STRATEGY);
  let recovered = 0;

  for (const trade of pureWsOpenTrades) {
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

    activePositions.set(positionId, {
      tradeId: positionId,
      dbTradeId: trade.id,
      pairAddress: trade.pairAddress,
      entryPrice: trade.entryPrice,
      entryTimeSec,
      quantity: trade.quantity,
      state: inferredState,
      peakPrice: safePeak,
      troughPrice: trade.entryPrice,
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
