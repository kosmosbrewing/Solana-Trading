/**
 * Cupsey-Inspired Lane Handler (Path A — 2026-04-11)
 *
 * Why: bootstrap_10s trigger 의 entry timing 이 lagging (spike 꼭대기 매수) 이므로,
 * post-entry 30-45초 판정으로 winner/loser 를 빠르게 분류한다.
 * cupsey 의 실전 패턴: 25s p50 hold + quick reject + 2-6min winner hold.
 *
 * State machine:
 *   [PROBE]  0-45s → MFE / MAE 관찰
 *   [REJECT] 즉시 매도 (작은 loss)
 *   [WINNER] trailing hold (2-5min)
 *
 * 기존 core (bootstrap_10s + Option β) 와 완전 격리.
 * sandbox wallet + fixed ticket sizing.
 */

import { createModuleLogger } from '../utils/logger';
import { Signal } from '../utils/types';
import { config } from '../utils/config';
import { MicroCandleBuilder } from '../realtime';
import { BotContext } from './types';

const log = createModuleLogger('CupseyLane');

// ─── State Machine Types ───

type CupseyTradeState = 'PROBE' | 'WINNER' | 'REJECT' | 'CLOSED';

interface CupseyPosition {
  tradeId: string;
  pairAddress: string;
  entryPrice: number;
  entryTimeSec: number;
  quantity: number;
  state: CupseyTradeState;
  peakPrice: number;  // MFE tracking
  troughPrice: number; // MAE tracking
  tokenSymbol?: string;
}

// ─── Active Positions ───

const activePositions = new Map<string, CupseyPosition>();

export function getActiveCupseyPositions(): ReadonlyMap<string, CupseyPosition> {
  return activePositions;
}

// ─── Signal Handler ───

/**
 * bootstrap_10s signal 을 cupsey lane 으로 처리.
 * 기존 handleRealtimeSignal 과 병렬 호출.
 */
export async function handleCupseyLaneSignal(
  signal: Signal,
  candleBuilder: MicroCandleBuilder,
  ctx: BotContext
): Promise<void> {
  // Guard: lane disabled
  if (!config.cupseyLaneEnabled) return;

  // Guard: 이미 같은 pair 에 cupsey position 있음
  for (const pos of activePositions.values()) {
    if (pos.pairAddress === signal.pairAddress && pos.state !== 'CLOSED') {
      log.debug(`Cupsey lane skip: already holding ${signal.pairAddress}`);
      return;
    }
  }

  // Guard: max concurrent cupsey positions (sandbox 보호)
  const activeCount = [...activePositions.values()].filter(p => p.state !== 'CLOSED').length;
  if (activeCount >= 3) {
    log.debug(`Cupsey lane skip: max concurrent (${activeCount})`);
    return;
  }

  // Fixed ticket sizing (risk-per-trade 가 아닌 fixed SOL)
  const ticketSol = config.cupseyLaneTicketSol;
  const quantity = signal.price > 0 ? ticketSol / signal.price : 0;
  if (quantity <= 0) return;

  // Entry execution (paper 에서는 시뮬레이션)
  log.info(
    `[CUPSEY_ENTRY] ${signal.pairAddress.slice(0, 12)} price=${signal.price.toFixed(8)} ` +
    `ticket=${ticketSol} SOL strategy=cupsey_flip_10s`
  );

  const now = Math.floor(Date.now() / 1000);
  const positionId = `cupsey-${signal.pairAddress.slice(0, 8)}-${now}`;

  // Why: cupsey lane 은 paper mode 전용 (live 는 sandbox wallet executor 필요 — 미구현).
  // live 에서 flag 켜도 entry 안 함 — 안전장치.
  if (ctx.tradingMode !== 'paper') {
    log.debug(`Cupsey lane skip: live mode not supported yet (paper only)`);
    return;
  }

  const position: CupseyPosition = {
    tradeId: positionId,
    pairAddress: signal.pairAddress,
    entryPrice: signal.price,
    entryTimeSec: now,
    quantity,
    state: 'PROBE',
    peakPrice: signal.price,
    troughPrice: signal.price,
    tokenSymbol: signal.tokenSymbol,
  };
  activePositions.set(positionId, position);
  log.info(`[CUPSEY_PROBE] ${positionId} entered PROBE state`);

  // Why: cupsey lane 은 자체 paper balance 를 추적하지 않음 (main core 격리).
  // 대신 DB record 의 strategy='cupsey_flip_10s' 로 분리 집계.
  // ctx.paperBalance 는 건드리지 않는다 — main core 오염 방지.
}

// ─── Tick Monitor (MicroCandleBuilder.on('tick') 에서 호출) ───

/**
 * 매 tick 마다 활성 cupsey position 의 state machine 진행.
 * MicroCandleBuilder.on('tick', ...) 또는 checkOpenPositions 주기에서 호출.
 */
export async function updateCupseyPositions(
  ctx: BotContext,
  candleBuilder: MicroCandleBuilder
): Promise<void> {
  if (!config.cupseyLaneEnabled) return;

  const now = Math.floor(Date.now() / 1000);

  for (const [id, pos] of activePositions) {
    if (pos.state === 'CLOSED') continue;

    const currentPrice = candleBuilder.getCurrentPrice(pos.pairAddress);
    if (currentPrice == null || currentPrice <= 0) continue;

    // Update MFE / MAE
    pos.peakPrice = Math.max(pos.peakPrice, currentPrice);
    pos.troughPrice = Math.min(pos.troughPrice, currentPrice);

    const elapsed = now - pos.entryTimeSec;
    const mfePct = (pos.peakPrice - pos.entryPrice) / pos.entryPrice;
    const maePct = (pos.troughPrice - pos.entryPrice) / pos.entryPrice;
    const currentPct = (currentPrice - pos.entryPrice) / pos.entryPrice;

    if (pos.state === 'PROBE') {
      // PROBE → REJECT: hard cut on MAE
      if (maePct <= -config.cupseyProbeHardCutPct) {
        log.info(
          `[CUPSEY_REJECT] ${id} hard cut MAE=${(maePct * 100).toFixed(2)}% ` +
          `elapsed=${elapsed}s`
        );
        await closeCupseyPosition(id, pos, currentPrice, 'REJECT_HARD_CUT', ctx);
        continue;
      }

      // PROBE → WINNER: MFE threshold reached
      if (mfePct >= config.cupseyProbeMfeThreshold) {
        pos.state = 'WINNER';
        log.info(
          `[CUPSEY_WINNER] ${id} promoted to WINNER MFE=${(mfePct * 100).toFixed(2)}% ` +
          `elapsed=${elapsed}s`
        );
        continue;
      }

      // PROBE → REJECT: time expired without momentum
      if (elapsed >= config.cupseyProbeWindowSec) {
        log.info(
          `[CUPSEY_REJECT] ${id} probe timeout MFE=${(mfePct * 100).toFixed(2)}% ` +
          `MAE=${(maePct * 100).toFixed(2)}% elapsed=${elapsed}s`
        );
        await closeCupseyPosition(id, pos, currentPrice, 'REJECT_TIMEOUT', ctx);
        continue;
      }
    }

    if (pos.state === 'WINNER') {
      // WINNER → CLOSE: hard time stop
      if (elapsed >= config.cupseyWinnerMaxHoldSec) {
        log.info(
          `[CUPSEY_TIME_STOP] ${id} winner time stop ` +
          `pnl=${(currentPct * 100).toFixed(2)}% elapsed=${elapsed}s`
        );
        await closeCupseyPosition(id, pos, currentPrice, 'WINNER_TIME_STOP', ctx);
        continue;
      }

      // WINNER → CLOSE: trailing stop
      const trailingStop = pos.peakPrice * (1 - config.cupseyWinnerTrailingPct);
      if (currentPrice <= trailingStop) {
        log.info(
          `[CUPSEY_TRAILING] ${id} trailing stop peak=${pos.peakPrice.toFixed(8)} ` +
          `trail=${trailingStop.toFixed(8)} current=${currentPrice.toFixed(8)} ` +
          `pnl=${(currentPct * 100).toFixed(2)}%`
        );
        await closeCupseyPosition(id, pos, currentPrice, 'WINNER_TRAILING', ctx);
        continue;
      }

      // WINNER → CLOSE: breakeven stop (SL = entry + small buffer)
      const breakevenStop = pos.entryPrice * (1 + config.cupseyWinnerBreakevenPct);
      if (currentPrice <= breakevenStop && mfePct > config.cupseyProbeMfeThreshold * 2) {
        // 이미 MFE 를 상당히 찍었다가 entry 근처로 돌아왔으면 close
        log.info(
          `[CUPSEY_BREAKEVEN] ${id} breakeven stop ` +
          `pnl=${(currentPct * 100).toFixed(2)}%`
        );
        await closeCupseyPosition(id, pos, currentPrice, 'WINNER_BREAKEVEN', ctx);
        continue;
      }
    }
  }
}

// ─── Close Position ───

async function closeCupseyPosition(
  id: string,
  pos: CupseyPosition,
  exitPrice: number,
  reason: string,
  ctx: BotContext
): Promise<void> {
  const pnl = (exitPrice - pos.entryPrice) * pos.quantity;
  const pnlPct = pos.entryPrice > 0 ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
  const holdSec = Math.floor(Date.now() / 1000) - pos.entryTimeSec;

  pos.state = 'CLOSED';

  // Why: cupsey lane 은 ctx.paperBalance 를 건드리지 않는다 (main core 격리).
  // PnL 은 DB record (strategy='cupsey_flip_10s') 에서만 집계.

  // DB record: insert → 반환된 id 로 즉시 close (race condition 방지)
  try {
    const tradeId = await ctx.tradeStore.insertTrade({
      pairAddress: pos.pairAddress,
      strategy: 'cupsey_flip_10s',
      side: 'BUY',
      tokenSymbol: pos.tokenSymbol,
      entryPrice: pos.entryPrice,
      quantity: pos.quantity,
      stopLoss: pos.entryPrice * (1 - config.cupseyProbeHardCutPct),
      takeProfit1: pos.entryPrice * (1 + config.cupseyProbeMfeThreshold),
      takeProfit2: pos.entryPrice * (1 + config.cupseyWinnerTrailingPct * 2),
      trailingStop: undefined,
      highWaterMark: pos.peakPrice,
      timeStopAt: new Date((pos.entryTimeSec + config.cupseyWinnerMaxHoldSec) * 1000),
      status: 'OPEN',
      createdAt: new Date(pos.entryTimeSec * 1000),
    });

    // insertTrade 가 반환한 id 로 즉시 close — getOpenTrades 전체 조회 불필요
    await ctx.tradeStore.closeTrade({
      id: tradeId,
      exitPrice,
      pnl,
      slippage: 0,
      exitReason: reason,
    });
  } catch (error) {
    log.warn(`Failed to record cupsey trade ${id}: ${error}`);
  }

  const sym = pos.tokenSymbol || pos.pairAddress.slice(0, 8);
  log.info(
    `[CUPSEY_CLOSED] ${id} ${sym} reason=${reason} ` +
    `pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) ` +
    `hold=${holdSec}s peak=${((pos.peakPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)}%`
  );

  // Notify
  await ctx.notifier.sendInfo(
    `[Cupsey Lane] ${sym} ${reason}: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${holdSec}s hold)`,
    'trade'
  ).catch(() => {});

  // Cleanup
  activePositions.delete(id);
}

// ─── Cleanup ───

export function cleanupClosedCupseyPositions(): void {
  for (const [id, pos] of activePositions) {
    if (pos.state === 'CLOSED') {
      activePositions.delete(id);
    }
  }
}
