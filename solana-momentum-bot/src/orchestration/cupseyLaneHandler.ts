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

import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import { Signal, Order } from '../utils/types';
import { config } from '../utils/config';
import { MicroCandleBuilder } from '../realtime';
import { evaluateCupseySignalGate, CupseySignalGateConfig, CupseySignalGateResult } from '../strategy/cupseySignalGate';
import { initCusumState, updateCusum, CusumState, CusumConfig } from '../strategy/cusumDetector';
import { BotContext } from './types';

const log = createModuleLogger('CupseyLane');

// ─── Gate Log Persistence (Phase 0 measurement) ───
// Why: gate score + factors 를 JSONL 로 persist 하여 Phase 1 score-outcome 상관 분석에 사용.
// pass + reject 모두 기록. 거래 파라미터는 건드리지 않음.

let gateLogDirEnsured = false;

// ─── CUSUM Per-Pair State (Phase 0: observation-only) ───
const cusumStates = new Map<string, CusumState>();

async function persistCupseyGateLog(
  pairAddress: string,
  signalPrice: number,
  gateResult: CupseySignalGateResult,
  tokenSymbol?: string,
  cusumStrength?: number
): Promise<void> {
  try {
    const logDir = config.realtimeDataDir;
    if (!gateLogDirEnsured) {
      await mkdir(logDir, { recursive: true });
      gateLogDirEnsured = true;
    }
    const entry = {
      t: new Date().toISOString(),
      pair: pairAddress,
      sym: tokenSymbol,
      price: signalPrice,
      pass: gateResult.pass,
      score: gateResult.score,
      f: gateResult.factors,
      reason: gateResult.rejectReason ?? null,
      cusum: cusumStrength ?? null,  // Phase 0: observation-only. Phase 1 상관 분석용
    };
    await appendFile(
      path.join(logDir, 'cupsey-gate-log.jsonl'),
      JSON.stringify(entry) + '\n',
      'utf8'
    );
  } catch {
    // Why: persist 실패해도 trading path 차단하지 않음
  }
}

// ─── State Machine Types ───
//
// STALK → PROBE → WINNER → CLOSED
//                → REJECT → CLOSED
//
// STALK (신규): signal 직후 즉시 매수하지 않고 pullback 대기.
// spike 꼭대기 매수 방지. pullback 오면 entry, 안 오면 skip.

type CupseyTradeState = 'STALK' | 'PROBE' | 'WINNER' | 'REJECT' | 'CLOSED';

interface CupseyPosition {
  tradeId: string;
  pairAddress: string;
  /** STALK 시: signal price (아직 미매수). PROBE/WINNER 시: actual entry price */
  entryPrice: number;
  /** signal 발화 시각 (STALK 시작) */
  signalTimeSec: number;
  /** 실제 매수 시각 (STALK → PROBE 전환 시) */
  entryTimeSec: number;
  quantity: number;
  state: CupseyTradeState;
  /** STALK 시: signal price (pullback 기준). PROBE/WINNER 시: entry 이후 peak */
  signalPrice: number;
  peakPrice: number;
  troughPrice: number;
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
  if (activeCount >= config.cupseyMaxConcurrent) {
    log.debug(`Cupsey lane skip: max concurrent (${activeCount})`);
    return;
  }

  // ─── CUSUM Volume Regime Change Detection (Phase 0: observation-only) ───
  // Why: CUSUM strength 를 gate log 에 기록하여 Phase 1 상관 분석에 사용.
  // trade 결정에는 영향 없음. bootstrap trigger 가 이미 fire 한 signal 에 대해서만 적용.
  let cusumStrength = 0;
  {
    const cusumCfg: CusumConfig = {
      kMultiplier: config.cusumKMultiplier,
      hMultiplier: config.cusumHMultiplier,
      warmupPeriods: config.cusumWarmupPeriods,
    };
    let state = cusumStates.get(signal.pairAddress) ?? initCusumState();
    // Cold start warmup: feed recent candles to build mean/variance
    if (state.sampleCount < cusumCfg.warmupPeriods) {
      const warmupCandles = candleBuilder.getRecentCandles(
        signal.pairAddress,
        config.realtimePrimaryIntervalSec,
        30 // feed up to 30 candles for warmup
      );
      // Feed all but the last (which we process below)
      for (const c of warmupCandles.slice(0, -1)) {
        state = updateCusum(state, c.volume, cusumCfg).state;
      }
      // Process the last candle (current signal candle)
      const lastCandle = warmupCandles[warmupCandles.length - 1];
      if (lastCandle) {
        const result = updateCusum(state, lastCandle.volume, cusumCfg);
        state = result.state;
        cusumStrength = result.strength;
      }
    } else {
      // Already warm: just update with signal's trigger volume
      const recentCandles = candleBuilder.getRecentCandles(
        signal.pairAddress,
        config.realtimePrimaryIntervalSec,
        1
      );
      const lastCandle = recentCandles[recentCandles.length - 1];
      if (lastCandle) {
        const result = updateCusum(state, lastCandle.volume, cusumCfg);
        state = result.state;
        cusumStrength = result.strength;
      }
    }
    cusumStates.set(signal.pairAddress, state);
  }

  // ─── Signal Quality Gate ───
  if (config.cupseyGateEnabled) {
    const recentCandles = candleBuilder.getRecentCandles(
      signal.pairAddress,
      config.realtimePrimaryIntervalSec,
      config.cupseyGateLookbackBars
    );
    const gateConfig: CupseySignalGateConfig = {
      enabled: true,
      minVolumeAccelRatio: config.cupseyGateMinVolumeAccelRatio,
      minPriceChangePct: config.cupseyGateMinPriceChangePct,
      minAvgBuyRatio: config.cupseyGateMinAvgBuyRatio,
      minTradeCountRatio: config.cupseyGateMinTradeCountRatio,
      lookbackBars: config.cupseyGateLookbackBars,
      recentBars: config.cupseyGateRecentBars,
    };
    const gateResult = evaluateCupseySignalGate(recentCandles, gateConfig);
    // Why: Phase 0 measurement — pass/reject 모두 persist하여 score-outcome 상관 분석 가능
    persistCupseyGateLog(signal.pairAddress, signal.price, gateResult, signal.tokenSymbol, cusumStrength);
    if (!gateResult.pass) {
      log.debug(
        `[CUPSEY_GATE_REJECT] ${signal.pairAddress.slice(0, 12)} ` +
        `reason=${gateResult.rejectReason} score=${gateResult.score} cusum=${cusumStrength.toFixed(3)}`
      );
      return;
    }
    log.info(
      `[CUPSEY_GATE_PASS] ${signal.pairAddress.slice(0, 12)} ` +
      `score=${gateResult.score} vol=${gateResult.factors.volumeAccelRatio.toFixed(2)} ` +
      `price=${(gateResult.factors.priceChangePct * 100).toFixed(3)}% ` +
      `buy=${gateResult.factors.avgBuyRatio.toFixed(3)} cusum=${cusumStrength.toFixed(3)}`
    );
  }

  const ticketSol = config.cupseyLaneTicketSol;
  const quantity = signal.price > 0 ? ticketSol / signal.price : 0;
  if (quantity <= 0) return;

  const now = Math.floor(Date.now() / 1000);
  const positionId = `cupsey-${signal.pairAddress.slice(0, 8)}-${now}`;

  // STALK state: 즉시 매수하지 않고 pullback 대기 (spike 꼭대기 매수 방지).
  // signal price 에서 -0.3% 떨어지면 entry, 20s 안에 안 떨어지면 skip.
  const position: CupseyPosition = {
    tradeId: positionId,
    pairAddress: signal.pairAddress,
    signalPrice: signal.price,
    entryPrice: signal.price,   // STALK 동안은 signal price (실제 entry 시 갱신)
    signalTimeSec: now,
    entryTimeSec: now,          // STALK → PROBE 전환 시 갱신
    quantity,
    state: 'STALK',
    peakPrice: signal.price,
    troughPrice: signal.price,
    tokenSymbol: signal.tokenSymbol,
  };
  activePositions.set(positionId, position);
  log.info(
    `[CUPSEY_STALK] ${positionId} ${signal.pairAddress.slice(0, 12)} ` +
    `signalPrice=${signal.price.toFixed(8)} waiting for -${(config.cupseyStalkDropPct * 100).toFixed(1)}% pullback`
  );
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

    // ─── STALK state: pullback 대기 (매수 전) ───
    if (pos.state === 'STALK') {
      const stalkElapsed = now - pos.signalTimeSec;
      const dropFromSignal = (currentPrice - pos.signalPrice) / pos.signalPrice;

      // STALK → SKIP: 시간 초과 (pullback 안 옴)
      if (stalkElapsed >= config.cupseyStalKWindowSec) {
        log.info(
          `[CUPSEY_STALK_SKIP] ${id} no pullback in ${stalkElapsed}s ` +
          `drop=${(dropFromSignal * 100).toFixed(2)}%`
        );
        activePositions.delete(id);
        continue;
      }

      // STALK → SKIP: 너무 많이 떨어짐 (crash, not pullback)
      if (dropFromSignal <= -config.cupseyStalkMaxDropPct) {
        log.info(
          `[CUPSEY_STALK_CRASH] ${id} drop ${(dropFromSignal * 100).toFixed(2)}% > ` +
          `max ${(config.cupseyStalkMaxDropPct * 100).toFixed(1)}% — skipping`
        );
        activePositions.delete(id);
        continue;
      }

      // STALK → PROBE: pullback 확인 → 실제 매수!
      if (dropFromSignal <= -config.cupseyStalkDropPct) {
        log.info(
          `[CUPSEY_STALK_ENTRY] ${id} pullback confirmed ` +
          `signal=${pos.signalPrice.toFixed(8)} → current=${currentPrice.toFixed(8)} ` +
          `drop=${(dropFromSignal * 100).toFixed(2)}% — entering PROBE`
        );

        // 실제 매수 실행
        const ticketSol = config.cupseyLaneTicketSol;
        let actualEntryPrice = currentPrice;
        let actualQuantity = pos.quantity;

        if (ctx.tradingMode === 'live') {
          try {
            const order: Order = {
              pairAddress: pos.pairAddress,
              strategy: 'cupsey_flip_10s',
              side: 'BUY',
              price: currentPrice,
              quantity: pos.quantity,
              stopLoss: currentPrice * (1 - config.cupseyProbeHardCutPct),
              takeProfit1: currentPrice * (1 + config.cupseyProbeMfeThreshold),
              takeProfit2: currentPrice * (1 + config.cupseyWinnerTrailingPct * 2),
              timeStopMinutes: Math.ceil(config.cupseyWinnerMaxHoldSec / 60),
            };
            const buyResult = await ctx.executor.executeBuy(order);
            if (buyResult.actualOutUiAmount && buyResult.actualOutUiAmount > 0) {
              actualQuantity = buyResult.actualOutUiAmount;
            }
            if (buyResult.actualInputUiAmount && buyResult.actualInputUiAmount > 0 && actualQuantity > 0) {
              actualEntryPrice = buyResult.actualInputUiAmount / actualQuantity;
            }
            log.info(
              `[CUPSEY_LIVE_BUY] ${id} pullback entry sig=${buyResult.txSignature.slice(0, 12)} ` +
              `slip=${buyResult.slippageBps}bps`
            );
          } catch (buyErr) {
            log.warn(`[CUPSEY_LIVE_BUY] ${id} pullback buy failed: ${buyErr}`);
            activePositions.delete(id);
            continue;
          }
        }

        // STALK → PROBE 전환
        pos.state = 'PROBE';
        pos.entryPrice = actualEntryPrice;
        pos.entryTimeSec = now;
        pos.quantity = actualQuantity;
        pos.peakPrice = actualEntryPrice;
        pos.troughPrice = actualEntryPrice;
        continue;
      }

      // STALK 진행 중 — 대기
      continue;
    }

    // ─── PROBE / WINNER states (매수 후) ───

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
  let actualExitPrice = exitPrice;
  const holdSec = Math.floor(Date.now() / 1000) - pos.entryTimeSec;

  pos.state = 'CLOSED';

  // Live exit: Jupiter sell
  if (ctx.tradingMode === 'live') {
    try {
      const tokenBalance = await ctx.executor.getTokenBalance(pos.pairAddress);
      if (tokenBalance > 0n) {
        const solBefore = await ctx.executor.getBalance();
        const sellResult = await ctx.executor.executeSell(pos.pairAddress, tokenBalance);
        const solAfter = await ctx.executor.getBalance();
        const receivedSol = solAfter - solBefore;
        if (receivedSol > 0 && pos.quantity > 0) {
          actualExitPrice = receivedSol / pos.quantity;
        }
        log.info(
          `[CUPSEY_LIVE_SELL] ${id} sig=${sellResult.txSignature.slice(0, 12)} ` +
          `received=${receivedSol.toFixed(6)} SOL slip=${sellResult.slippageBps}bps`
        );
      } else {
        log.warn(`[CUPSEY_LIVE_SELL] ${id} no token balance — closing at current price`);
      }
    } catch (sellErr) {
      log.warn(`[CUPSEY_LIVE_SELL] ${id} sell failed: ${sellErr}`);
      // sell 실패해도 position state 는 CLOSED 로 전환 (stale 방지)
    }
  }

  const rawPnl = (actualExitPrice - pos.entryPrice) * pos.quantity;
  // Why: paper 모드는 wallet delta 없이 시장가로 PnL 계산 → AMM/MEV 비용 누락
  const paperCost = ctx.tradingMode === 'paper'
    ? pos.entryPrice * pos.quantity * (config.defaultAmmFeePct + config.defaultMevMarginPct)
    : 0;
  const pnl = rawPnl - paperCost;
  const pnlPct = pos.entryPrice > 0 ? ((actualExitPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;

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
