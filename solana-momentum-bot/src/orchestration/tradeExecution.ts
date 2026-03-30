import { GateEvaluationResult } from '../gate';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { Candle, CloseReason, Order, Signal, Trade } from '../utils/types';
import { calcATR, calcAdaptiveTrailingStop, checkExhaustion } from '../strategy';
import { PositionStore } from '../state';
import { RiskManager } from '../risk';
import { BotContext } from './types';
import { buildGateTraceSnapshot } from './signalTrace';
import { summarizeTradeObservation } from './tradeMonitoring';

const log = createModuleLogger('TradeExecution');

// ─── v2: Degraded Exit State (in-memory, DB 변경 불필요) ───

interface DegradedState {
  /** 첫 partial 매도 시각 (phase 2 타이머 기준) */
  partialSoldAt: Date;
  /** 원본 trade의 pairAddress (잔여분 새 trade 매칭용) */
  pairAddress: string;
}

export interface EntryExecutionSummary {
  entryPrice: number;
  quantity: number;
  plannedEntryPrice: number;
  plannedQuantity: number;
  entrySlippageBps: number;
  entrySlippagePct: number;
  expectedOutAmount?: string;
  actualOutAmount?: string;
  outputDecimals?: number;
  effectiveRR: number;
  roundTripCost: number;
}

/** trade.id → DegradedState (실제 트리거된 거래만 포함) */
export const degradedStateMap = new Map<string, DegradedState>();

/** trade.id → quote 연속 실패 카운트 (degraded 판정 전 추적용) */
export const quoteFailCountMap = new Map<string, number>();

export function isDegraded(tradeId: string): boolean {
  return degradedStateMap.has(tradeId);
}

function applyPaperExitProceeds(ctx: BotContext, quantity: number, exitPrice: number): void {
  if (ctx.tradingMode !== 'paper' || ctx.paperBalance == null) return;
  ctx.paperBalance = Math.max(0, ctx.paperBalance + (quantity * exitPrice));
}

/**
 * v2: Degraded Exit 판정
 * 조건: sellImpact > threshold OR quote 연속 실패 >= limit
 * degradedStateMap에는 조건 충족 시에만 추가 (C-1 fix)
 */
export function checkDegradedCondition(
  tradeId: string,
  sellImpact: number | null,
  quoteSuccess: boolean
): boolean {
  if (!config.degradedExitEnabled) return false;

  // Quote 실패 카운트 (별도 Map — degraded 여부와 분리)
  if (!quoteSuccess) {
    const count = (quoteFailCountMap.get(tradeId) ?? 0) + 1;
    quoteFailCountMap.set(tradeId, count);
  } else {
    quoteFailCountMap.set(tradeId, 0);
  }

  // 이미 degraded면 중복 처리 불필요
  if (degradedStateMap.has(tradeId)) return true;

  // 조건 판정
  const impactTriggered = sellImpact !== null && sellImpact > config.degradedSellImpactThreshold;
  const quoteFailTriggered = (quoteFailCountMap.get(tradeId) ?? 0) >= config.degradedQuoteFailLimit;

  return impactTriggered || quoteFailTriggered;
}

/**
 * v2: Degraded Exit phase 1 실행 — TP1 partial 패턴 따라 부분 청산 + 잔여분 새 trade 생성
 * (C-2 fix: closeTrade가 trade를 CLOSED 처리하므로 잔여분은 새 trade로 생성)
 */
export async function handleDegradedExitPhase1(
  trade: Trade,
  currentPrice: number,
  ctx: BotContext
): Promise<void> {
  const partialPct = config.degradedPartialPct;
  const soldQuantity = trade.quantity * partialPct;
  const remainingQuantity = trade.quantity - soldQuantity;

  if (remainingQuantity <= 0 || soldQuantity <= 0) {
    log.warn(`Invalid degraded split for trade ${trade.id}; closing full position`);
    degradedStateMap.delete(trade.id);
    quoteFailCountMap.delete(trade.id);
    await closeTrade(trade, 'DEGRADED_EXIT', ctx, currentPrice);
    return;
  }

  log.warn(
    `DEGRADED_EXIT phase 1: selling ${(partialPct * 100).toFixed(0)}% ` +
    `of trade ${trade.id} (${soldQuantity.toFixed(6)} SOL)`
  );

  // TP1 partial 패턴: 부분 청산
  let exitPrice = currentPrice;
  let executionSlippage = 0;

  if (ctx.tradingMode === 'live') {
    const tokenBalance = await ctx.executor.getTokenBalance(trade.pairAddress);
    const partialTokenAmount = BigInt(Math.floor(Number(tokenBalance) * partialPct));

    if (partialTokenAmount > 0n) {
      const solBefore = await ctx.executor.getBalance();
      const sellResult = await ctx.executor.executeSell(trade.pairAddress, partialTokenAmount);
      const solAfter = await ctx.executor.getBalance();
      const receivedSol = solAfter - solBefore;
      exitPrice = receivedSol > 0 ? receivedSol / soldQuantity : currentPrice;
      executionSlippage = sellResult.slippageBps / 10000;
    }
  }

  const realizedPnl = (exitPrice - trade.entryPrice) * soldQuantity;
  applyPaperExitProceeds(ctx, soldQuantity, exitPrice);
  await ctx.tradeStore.closeTrade(trade.id, exitPrice, realizedPnl, executionSlippage, 'DEGRADED_EXIT', soldQuantity);

  // 잔여분 새 trade 생성 (phase 2에서 청산)
  const remainingTrade: Omit<Trade, 'id'> = {
    ...trade,
    quantity: remainingQuantity,
    status: 'OPEN',
    createdAt: new Date(),
    closedAt: undefined,
    exitPrice: undefined,
    pnl: undefined,
    slippage: undefined,
    exitReason: undefined,
  };
  await ctx.tradeStore.insertTrade(remainingTrade);

  // degraded 상태 기록 (phase 2 타이머 시작)
  degradedStateMap.set(trade.id, { partialSoldAt: new Date(), pairAddress: trade.pairAddress });

  const partialTrade: Trade = {
    ...trade,
    quantity: soldQuantity,
    exitPrice,
    pnl: realizedPnl,
    slippage: executionSlippage,
    status: 'CLOSED',
    exitReason: 'DEGRADED_EXIT',
    closedAt: new Date(),
  };
  await ctx.notifier.sendTradeClose(partialTrade);
  await ctx.notifier.sendTradeAlert(
    `DEGRADED_EXIT phase 1: ${trade.strategy} sold ${(partialPct * 100).toFixed(0)}%, ` +
    `remaining ${remainingQuantity.toFixed(6)} SOL — phase 2 in ${(config.degradedDelayMs / 60_000).toFixed(0)}min`
  );
  ctx.healthMonitor.updateTradeTime();
}

/**
 * v2: Degraded Exit 모니터링 — 이미 degraded인 거래의 phase 2 대기/실행
 * openTrades에서 잔여분이 새 trade.id로 나타남 → pairAddress 기반 매칭
 */
async function handleDegradedExit(
  trade: Trade,
  currentPrice: number,
  ctx: BotContext
): Promise<void> {
  // phase 1의 원본 trade.id로 degradedState를 찾음
  // 잔여분은 새 trade.id이므로, pairAddress로 기존 degraded 상태 검색
  let degradedEntry: [string, DegradedState] | undefined;
  for (const [id, state] of degradedStateMap) {
    if (id === trade.id || state.pairAddress === trade.pairAddress) {
      degradedEntry = [id, state];
      break;
    }
  }
  if (!degradedEntry) return;

  const [originalId, state] = degradedEntry;
  const elapsed = Date.now() - state.partialSoldAt.getTime();

  if (elapsed >= config.degradedDelayMs) {
    log.warn(
      `DEGRADED_EXIT phase 2: closing remaining ${trade.quantity.toFixed(6)} SOL ` +
      `of trade ${trade.id} (original: ${originalId})`
    );
    degradedStateMap.delete(originalId);
    quoteFailCountMap.delete(originalId);
    await closeTrade(trade, 'DEGRADED_EXIT', ctx, currentPrice);
  }
  // delay 미경과 시 다음 사이클까지 대기
}

// ─── v2: Runner Extension State ───

/** trade.id → runner mode 활성화 여부 */
export const runnerStateMap = new Map<string, boolean>();

/** v3: Runner 활성화 결과 — Grade별 사이징 분기 */
export interface RunnerActivation {
  activate: boolean;
  sizeMultiplier: number;
}

/**
 * v3: Runner 조건 체크 — TP2 도달 시 trailing-only 전환 여부 결정
 * Grade A: full trailing (sizeMultiplier 1.0)
 * Grade B + flag on: 50% TP2 매도 + 50% trailing (sizeMultiplier 0.5)
 */
export function shouldActivateRunner(
  trade: Trade,
  ctx: BotContext
): RunnerActivation {
  if (!config.runnerEnabled) return { activate: false, sizeMultiplier: 0 };
  if (isDegraded(trade.id)) return { activate: false, sizeMultiplier: 0 };
  if (ctx.tradingHaltedReason) return { activate: false, sizeMultiplier: 0 };

  if (trade.breakoutGrade === 'A') {
    return { activate: true, sizeMultiplier: 1.0 };
  }
  if (trade.breakoutGrade === 'B' && config.runnerGradeBEnabled) {
    return { activate: true, sizeMultiplier: 0.5 };
  }
  return { activate: false, sizeMultiplier: 0 };
}

async function loadTradeMonitoringSnapshot(
  trade: Trade,
  ctx: BotContext
): Promise<{ trade: Trade; recentCandles: Candle[]; currentPrice: number } | undefined> {
  const recentCandles = await ctx.candleStore.getRecentCandles(
    trade.pairAddress,
    300,
    10
  );
  const realtimePrice = ctx.realtimeCandleBuilder?.getCurrentPrice(trade.pairAddress) ?? null;
  const candlePrice = recentCandles[recentCandles.length - 1]?.close;
  const currentPrice = realtimePrice ?? candlePrice;

  if (currentPrice == null) {
    return undefined;
  }

  return {
    trade,
    recentCandles,
    currentPrice,
  };
}

export async function checkOpenPositions(ctx: BotContext): Promise<void> {
  const balanceSol = ctx.tradingMode === 'paper' && ctx.paperBalance != null
    ? ctx.paperBalance
    : await ctx.executor.getBalance();
  const portfolio = await ctx.riskManager.getPortfolioState(balanceSol);
  const openTrades = portfolio.openTrades;
  ctx.healthMonitor.updatePositions(openTrades.length);
  ctx.healthMonitor.updateDailyPnl(portfolio.dailyPnl);

  if (openTrades.length === 0) {
    await syncTradingHalts(ctx, portfolio);
    return;
  }

  const monitoredTrades = await Promise.all(
    openTrades.map((trade) => loadTradeMonitoringSnapshot(trade, ctx))
  );
  const activeTrades = monitoredTrades.filter((item): item is NonNullable<typeof item> => !!item);
  const portfolioWithUnrealized = ctx.riskManager.applyUnrealizedDrawdown(
    portfolio,
    activeTrades.map(item => ({
      quantity: item.trade.quantity,
      currentPrice: item.currentPrice,
    }))
  );
  await syncTradingHalts(ctx, portfolioWithUnrealized);

  for (const { trade, recentCandles, currentPrice } of activeTrades) {
    // Phase 1B: Update MAE/MFE excursions
    if (ctx.paperMetrics) {
      ctx.paperMetrics.updateExcursion(trade.id, currentPrice);
    }

    const now = new Date();

    // v2 Priority 0: Degraded Exit — phase 2 대기 중인 거래 처리
    if (config.degradedExitEnabled) {
      // 이미 degraded 상태(phase 1 완료)인 거래는 phase 2 진행
      if (isDegraded(trade.id)) {
        await handleDegradedExit(trade, currentPrice, ctx);
        continue;
      }
      // 같은 pairAddress의 degraded 잔여분인지 확인 (phase 1에서 새 trade로 생성됨)
      let isRemainder = false;
      for (const [, state] of degradedStateMap) {
        if (state.pairAddress === trade.pairAddress) {
          isRemainder = true;
          break;
        }
      }
      if (isRemainder) {
        await handleDegradedExit(trade, currentPrice, ctx);
        continue;
      }
    }

    const observation = summarizeTradeObservation(trade, recentCandles, currentPrice);
    if (!trade.highWaterMark || observation.peakPrice > trade.highWaterMark) {
      await ctx.tradeStore.updateHighWaterMark(trade.id, observation.peakPrice);
      trade.highWaterMark = observation.peakPrice;
    }

    if (now >= trade.timeStopAt) {
      log.info(`Time stop triggered for trade ${trade.id}`);
      await closeTrade(trade, 'TIME_STOP', ctx, currentPrice);
      continue;
    }

    if (observation.observedLow <= trade.stopLoss) {
      const stopLossPrice = currentPrice <= trade.stopLoss ? currentPrice : trade.stopLoss;
      const penetrationPct = ((trade.stopLoss - observation.observedLow) / trade.stopLoss) * 100;
      if (penetrationPct > 1) {
        log.warn(
          `SL penetration warning: low ${observation.observedLow} is ${penetrationPct.toFixed(1)}% below SL ${trade.stopLoss}. ` +
          `Actual exit slippage may be significant.`
        );
      }
      log.info(`Stop loss triggered for trade ${trade.id} at ${stopLossPrice}`);
      await closeTrade(trade, 'STOP_LOSS', ctx, stopLossPrice);
      continue;
    }

    if (observation.observedHigh >= trade.takeProfit2) {
      // v3: Runner Extension — Grade A(full) / Grade B(50% partial) runner 분기
      const runnerResult = shouldActivateRunner(trade, ctx);
      if (runnerResult.activate && !runnerStateMap.has(trade.id)) {
        if (runnerResult.sizeMultiplier >= 1.0 && currentPrice >= trade.takeProfit2) {
          // Grade A: 전량 trailing-only
          runnerStateMap.set(trade.id, true);
          const newStopLoss = trade.takeProfit1;
          await ctx.tradeStore.updateHighWaterMark(trade.id, currentPrice);
          trade.highWaterMark = currentPrice;
          trade.stopLoss = newStopLoss;
          trade.trailingStop = trade.trailingStop ?? currentPrice * 0.9;
          await updatePositionsForPair(ctx, trade.pairAddress, 'MONITORING', {
            stopLoss: newStopLoss,
          });
          log.info(
            `Runner activated (Grade A) for trade ${trade.id}: SL→${newStopLoss.toFixed(8)}, ` +
            `trailing-only from ${currentPrice.toFixed(8)}`
          );
          await ctx.notifier.sendTradeAlert(
            `Runner activated (A): ${trade.strategy} ${trade.id}, trailing from TP2`
          );
          continue;
        }
        if (runnerResult.sizeMultiplier < 1.0) {
          // Grade B: 50% TP2 매도 + 50% trailing (TP1 partial 패턴)
          await handleRunnerGradeBPartial(trade, currentPrice, ctx);
          continue;
        }
      }
      const takeProfit2Price = currentPrice >= trade.takeProfit2 ? currentPrice : trade.takeProfit2;
      log.info(`Take profit 2 triggered for trade ${trade.id} at ${takeProfit2Price}`);
      await closeTrade(trade, 'TAKE_PROFIT_2', ctx, takeProfit2Price);
      continue;
    }

    if (observation.observedHigh >= trade.takeProfit1) {
      const takeProfit1Price = currentPrice >= trade.takeProfit1 ? currentPrice : trade.takeProfit1;
      log.info(`Take profit 1 triggered for trade ${trade.id} at ${takeProfit1Price}`);
      await handleTakeProfit1Partial(trade, takeProfit1Price, ctx);
      continue;
    }

    // Exhaustion Exit — 최소 10분(2봉) 보유 후 적용
    // Why: 진입 봉(volume spike)→직후 1봉은 자연스럽게 volume/body 감소. 1봉 exhaustion 오탐만 스킵
    const minExhaustionMs = 10 * 60 * 1000;
    const holdDuration = Date.now() - trade.createdAt.getTime();
    if (holdDuration >= minExhaustionMs && recentCandles.length >= 2) {
      const { exhausted, indicators } = checkExhaustion(recentCandles, config.exhaustionThreshold);
      if (exhausted && currentPrice > trade.entryPrice) {
        log.info(`Exhaustion exit for trade ${trade.id}: ${indicators.join(', ')}`);
        await closeTrade(trade, 'EXHAUSTION', ctx, currentPrice);
        continue;
      }
    }

    if (trade.trailingStop && recentCandles.length >= 8) {
      // Why: backtest와 동일하게 최소 2봉 보유 후 trailing 활성화
      const minTrailingHoldMs = config.defaultTimeframe * 1000 * 2;
      const trailingHoldDuration = Date.now() - trade.createdAt.getTime();
      if (trailingHoldDuration < minTrailingHoldMs) continue;

      const atr = calcATR(recentCandles, 7);
      // Why: TP1 후 잔여 trade는 SL이 entryPrice로 올라감 → tp1Hit 근사 판별
      const tp1Hit = trade.stopLoss >= trade.entryPrice;
      const adaptiveStop = calcAdaptiveTrailingStop(
        recentCandles,
        atr,
        trade.entryPrice,
        observation.peakPrice,
        trade.stopLoss,
        tp1Hit
      );

      if (observation.observedLow <= adaptiveStop && observation.observedLow > trade.stopLoss) {
        const trailingPrice = currentPrice <= adaptiveStop ? currentPrice : adaptiveStop;
        log.info(`Adaptive trailing stop triggered for trade ${trade.id} at ${trailingPrice}`);
        await closeTrade(trade, 'TRAILING_STOP', ctx, trailingPrice);
      }
    }
  }
}

export async function syncTradingHalts(
  ctx: BotContext,
  portfolio: Awaited<ReturnType<RiskManager['getPortfolioState']>>
): Promise<void> {
  const activeHalt = ctx.riskManager.getActiveHalt(portfolio);

  if (!activeHalt && ctx.tradingHaltedReason) {
    log.info(`Trading resumed: ${ctx.tradingHaltedReason}`);
    await ctx.notifier.sendInfo('Trading resumed — risk halt cleared');
    ctx.tradingHaltedReason = undefined;
    return;
  }

  if (!activeHalt || ctx.tradingHaltedReason === activeHalt.reason) {
    return;
  }

  ctx.tradingHaltedReason = activeHalt.reason;
  log.error(activeHalt.reason);
  await ctx.notifier.sendCritical(
    activeHalt.kind === 'drawdown' ? 'Drawdown Guard' : 'Daily Loss',
    activeHalt.reason
  );
}

export async function closeTrade(
  trade: Trade,
  reason: CloseReason,
  ctx: BotContext,
  paperExitPrice?: number
): Promise<void> {
  try {
    let txSignature: string | undefined;
    let exitPrice = paperExitPrice ?? trade.entryPrice;
    let executionSlippage = 0;

    if (ctx.tradingMode === 'paper') {
      txSignature = 'PAPER_TRADE';
    } else {
      await updatePositionsForPair(ctx, trade.pairAddress, 'EXIT_TRIGGERED', { exitReason: reason });
      const tokenBalance = await ctx.executor.getTokenBalance(trade.pairAddress);

      if (tokenBalance > 0n) {
        const solBefore = await ctx.executor.getBalance();
        const sellResult = await ctx.executor.executeSell(trade.pairAddress, tokenBalance);
        txSignature = sellResult.txSignature;

        const solAfter = await ctx.executor.getBalance();
        const receivedSol = solAfter - solBefore;

        if (receivedSol > 0 && trade.quantity > 0) {
          exitPrice = receivedSol / trade.quantity;
        }

        executionSlippage = sellResult.slippageBps / 10000;

        log.info(
          `Sell executed: received=${receivedSol.toFixed(6)} SOL, ` +
          `exitPrice=${exitPrice.toFixed(8)}, slippage=${sellResult.slippageBps}bps`
        );
      } else {
        log.warn(`No token balance for trade ${trade.id} — closing with entry price`);
      }
    }

    const pnl = (exitPrice - trade.entryPrice) * trade.quantity;
    applyPaperExitProceeds(ctx, trade.quantity, exitPrice);

    await ctx.tradeStore.closeTrade(trade.id, exitPrice, pnl, executionSlippage, reason);

    const closedTrade = {
      ...trade,
      exitPrice,
      pnl,
      slippage: executionSlippage,
      txSignature,
      status: 'CLOSED' as const,
      exitReason: reason,
    };
    await ctx.notifier.sendTradeClose(closedTrade);
    await updatePositionsForPair(ctx, trade.pairAddress, 'EXIT_CONFIRMED', {
      txExit: txSignature,
      exitReason: reason,
      pnl,
    });

    // Phase 1B: Record paper metrics exit
    if (ctx.paperMetrics) {
      ctx.paperMetrics.recordExit(trade.id, exitPrice, reason);
    }

    // Phase 3: WalletManager PnL 기록 (H-01)
    if (ctx.walletManager) {
      const walletName = trade.strategy === 'new_lp_sniper' ? 'sandbox' : 'main';
      ctx.walletManager.recordPnl(walletName, pnl);
    }

    // M-2 fix: state map cleanup (메모리 누수 방지)
    degradedStateMap.delete(trade.id);
    quoteFailCountMap.delete(trade.id);
    runnerStateMap.delete(trade.id);

    ctx.healthMonitor.updateTradeTime();
    log.info(`Trade ${trade.id} closed (${reason}). PnL: ${pnl.toFixed(6)} SOL`);
  } catch (error) {
    log.error(`Failed to close trade ${trade.id}: ${error}`);
    await ctx.tradeStore.failTrade(trade.id, `Close failed: ${error}`);
    await ctx.notifier.sendError('trade_close', error).catch(() => {});
  }
}

export async function recordOpenedTrade(
  ctx: BotContext,
  positionId: string,
  signal: Signal,
  lastCandle: Candle,
  gateResult: GateEvaluationResult,
  order: Order,
  totalScore: number,
  sizeConstraint: Trade['sizeConstraint'],
  txSignature: string,
  executionSummary: EntryExecutionSummary
): Promise<void> {
  const openedOrder: Order = {
    ...order,
    price: executionSummary.entryPrice,
    quantity: executionSummary.quantity,
  };
  await ctx.positionStore.updateState(positionId, 'ENTRY_CONFIRMED', {
    signalData: {
      execution: {
        plannedEntryPrice: executionSummary.plannedEntryPrice,
        plannedQuantity: executionSummary.plannedQuantity,
        entryPrice: executionSummary.entryPrice,
        quantity: executionSummary.quantity,
        entrySlippageBps: executionSummary.entrySlippageBps,
        entrySlippagePct: executionSummary.entrySlippagePct,
        expectedOutAmount: executionSummary.expectedOutAmount,
        actualOutAmount: executionSummary.actualOutAmount,
        outputDecimals: executionSummary.outputDecimals,
        effectiveRR: executionSummary.effectiveRR,
        roundTripCost: executionSummary.roundTripCost,
      },
    },
    entryPrice: openedOrder.price,
    quantity: openedOrder.quantity,
    stopLoss: openedOrder.stopLoss,
    takeProfit1: openedOrder.takeProfit1,
    takeProfit2: openedOrder.takeProfit2,
    trailingStop: openedOrder.trailingStop,
    txEntry: txSignature,
  });

  const timeStopAt = new Date(Date.now() + openedOrder.timeStopMinutes * 60 * 1000);
  await ctx.tradeStore.insertTrade({
    pairAddress: openedOrder.pairAddress,
    strategy: openedOrder.strategy,
    side: openedOrder.side,
    tokenSymbol: openedOrder.tokenSymbol,
    sourceLabel: signal.sourceLabel,
    entryPrice: openedOrder.price,
    quantity: openedOrder.quantity,
    stopLoss: openedOrder.stopLoss,
    takeProfit1: openedOrder.takeProfit1,
    takeProfit2: openedOrder.takeProfit2,
    trailingStop: openedOrder.trailingStop,
    highWaterMark: openedOrder.price,
    timeStopAt,
    status: 'OPEN',
    txSignature,
    createdAt: new Date(),
    breakoutScore: totalScore,
    breakoutGrade: order.breakoutGrade,
    sizeConstraint,
  });

  await ctx.positionStore.updateState(positionId, 'MONITORING');
  ctx.healthMonitor.updateTradeTime();
  await ctx.notifier.sendTradeOpen(openedOrder, txSignature);
  await ctx.auditLogger.logSignal({
    ...buildSignalAuditBase(signal, lastCandle, gateResult),
    action: 'EXECUTED',
    positionSize: executionSummary.quantity,
    sizeConstraint,
    effectiveRR: executionSummary.effectiveRR,
    roundTripCost: executionSummary.roundTripCost,
  });
}

export function buildSignalAuditBase(
  signal: Signal,
  candle: Candle,
  gateResult: GateEvaluationResult
) {
  return {
    pairAddress: signal.pairAddress,
    strategy: signal.strategy,
    sourceLabel: signal.sourceLabel,
    attentionScore: gateResult.attentionScore?.attentionScore,
    attentionConfidence: gateResult.attentionScore?.confidence,
    ...signal.breakoutScore!,
    candleClose: signal.price,
    volume: candle.volume,
    buyVolume: candle.buyVolume,
    sellVolume: candle.sellVolume,
    poolTvl: signal.poolTvl || 0,
    spreadPct: signal.spreadPct,
    effectiveRR: gateResult.executionViability.effectiveRR,
    roundTripCost: gateResult.executionViability.roundTripCost,
    gateTrace: buildGateTraceSnapshot(gateResult),
  };
}

async function handleTakeProfit1Partial(
  trade: Trade,
  currentPrice: number,
  ctx: BotContext
): Promise<void> {
  try {
    const soldQuantity = trade.quantity * 0.5;
    const remainingQuantity = trade.quantity - soldQuantity;

    if (remainingQuantity <= 0 || soldQuantity <= 0) {
      log.warn(`Invalid TP1 split for trade ${trade.id}; closing full position instead`);
      await closeTrade(trade, 'TAKE_PROFIT_1', ctx, currentPrice);
      return;
    }

    let exitPrice = currentPrice;
    let executionSlippage = 0;

    if (ctx.tradingMode === 'live') {
      const tokenBalance = await ctx.executor.getTokenBalance(trade.pairAddress);
      const partialTokenAmount = tokenBalance / 2n;

      if (partialTokenAmount <= 0n || trade.quantity <= 0) {
        log.warn(`Partial TP1 unavailable for trade ${trade.id}; closing full position instead`);
        await closeTrade(trade, 'TAKE_PROFIT_1', ctx, currentPrice);
        return;
      }

      const solBefore = await ctx.executor.getBalance();
      const sellResult = await ctx.executor.executeSell(trade.pairAddress, partialTokenAmount);
      const solAfter = await ctx.executor.getBalance();
      const receivedSol = solAfter - solBefore;

      exitPrice = receivedSol > 0 ? receivedSol / soldQuantity : currentPrice;
      executionSlippage = sellResult.slippageBps / 10000;
    }

    const realizedPnl = (exitPrice - trade.entryPrice) * soldQuantity;
    applyPaperExitProceeds(ctx, soldQuantity, exitPrice);

    await ctx.tradeStore.closeTrade(
      trade.id,
      exitPrice,
      realizedPnl,
      executionSlippage,
      'TAKE_PROFIT_1',
      soldQuantity
    );

    // v3: TP1 후 잔여 trade에 time stop 연장 — Runner 활성화 시간 확보
    const extendedTimeStopAt = new Date(Date.now() + config.tp1TimeExtensionMinutes * 60_000);

    const remainingTrade: Omit<Trade, 'id'> = {
      ...trade,
      quantity: remainingQuantity,
      stopLoss: trade.entryPrice,
      takeProfit1: trade.takeProfit2,
      takeProfit2: trade.takeProfit2,
      highWaterMark: Math.max(trade.highWaterMark ?? trade.entryPrice, currentPrice),
      timeStopAt: extendedTimeStopAt,
      status: 'OPEN',
      createdAt: new Date(),
      closedAt: undefined,
      exitPrice: undefined,
      pnl: undefined,
      slippage: undefined,
      exitReason: undefined,
    };

    await ctx.tradeStore.insertTrade(remainingTrade);

    const partialTrade: Trade = {
      ...trade,
      quantity: soldQuantity,
      exitPrice,
      pnl: realizedPnl,
      slippage: executionSlippage,
      status: 'CLOSED',
      exitReason: 'TAKE_PROFIT_1',
      closedAt: new Date(),
    };
    await ctx.notifier.sendTradeClose(partialTrade);
    await ctx.notifier.sendTradeAlert(
      `TP1 partial exit: ${trade.strategy} remaining ${remainingQuantity.toFixed(6)} SOL, ` +
      `SL moved to breakeven ${trade.entryPrice.toFixed(8)}`
    );

    await updatePositionsForPair(ctx, trade.pairAddress, 'MONITORING', {
      quantity: remainingQuantity,
      stopLoss: trade.entryPrice,
      takeProfit1: trade.takeProfit2,
      takeProfit2: trade.takeProfit2,
      trailingStop: trade.trailingStop,
    });

    ctx.healthMonitor.updateTradeTime();
    log.info(
      `Trade ${trade.id} partially closed at TP1. Realized=${realizedPnl.toFixed(6)} SOL, ` +
      `remaining=${remainingQuantity.toFixed(6)}`
    );
  } catch (error) {
    log.error(`Failed to partially close trade ${trade.id}: ${error}`);
    await ctx.notifier.sendError('trade_partial_close', error).catch(() => {});
  }
}

/**
 * v3: Grade B Runner — 50% TP2 매도 + 50% trailing-only
 * TP1 partial 패턴과 동일하게 부분 청산 + 잔여 trade 생성
 */
async function handleRunnerGradeBPartial(
  trade: Trade,
  currentPrice: number,
  ctx: BotContext
): Promise<void> {
  try {
    const soldQuantity = trade.quantity * 0.5;
    const remainingQuantity = trade.quantity - soldQuantity;

    if (remainingQuantity <= 0 || soldQuantity <= 0) {
      log.warn(`Invalid Grade B runner split for trade ${trade.id}; closing full at TP2`);
      await closeTrade(trade, 'TAKE_PROFIT_2', ctx, currentPrice);
      return;
    }

    let exitPrice = currentPrice;
    let executionSlippage = 0;

    if (ctx.tradingMode === 'live') {
      const tokenBalance = await ctx.executor.getTokenBalance(trade.pairAddress);
      const partialTokenAmount = tokenBalance / 2n;

      if (partialTokenAmount <= 0n) {
        log.warn(`Grade B runner partial unavailable for trade ${trade.id}; closing full at TP2`);
        await closeTrade(trade, 'TAKE_PROFIT_2', ctx, currentPrice);
        return;
      }

      const solBefore = await ctx.executor.getBalance();
      const sellResult = await ctx.executor.executeSell(trade.pairAddress, partialTokenAmount);
      const solAfter = await ctx.executor.getBalance();
      const receivedSol = solAfter - solBefore;
      exitPrice = receivedSol > 0 ? receivedSol / soldQuantity : currentPrice;
      executionSlippage = sellResult.slippageBps / 10000;
    }

    const realizedPnl = (exitPrice - trade.entryPrice) * soldQuantity;
    applyPaperExitProceeds(ctx, soldQuantity, exitPrice);
    await ctx.tradeStore.closeTrade(trade.id, exitPrice, realizedPnl, executionSlippage, 'TAKE_PROFIT_2', soldQuantity);

    // 원본 trade state map 정리 (closeTrade 경유하지 않으므로 수동 정리)
    degradedStateMap.delete(trade.id);
    quoteFailCountMap.delete(trade.id);
    runnerStateMap.delete(trade.id);

    // 잔여분: trailing-only runner로 전환
    const newStopLoss = trade.takeProfit1;
    const extendedTimeStopAt = new Date(Date.now() + config.tp1TimeExtensionMinutes * 60_000);

    const remainingTrade: Omit<Trade, 'id'> = {
      ...trade,
      quantity: remainingQuantity,
      stopLoss: newStopLoss,
      takeProfit1: trade.takeProfit2,
      takeProfit2: trade.takeProfit2 * 2, // Grade B runner: 상향된 TP2
      highWaterMark: Math.max(trade.highWaterMark ?? trade.entryPrice, currentPrice),
      trailingStop: trade.trailingStop ?? currentPrice * 0.9,
      timeStopAt: extendedTimeStopAt,
      status: 'OPEN',
      createdAt: new Date(),
      closedAt: undefined,
      exitPrice: undefined,
      pnl: undefined,
      slippage: undefined,
      exitReason: undefined,
    };
    const insertedId = await ctx.tradeStore.insertTrade(remainingTrade);

    // 잔여분을 runner로 등록
    if (insertedId) {
      runnerStateMap.set(insertedId, true);
    }

    const partialTrade: Trade = {
      ...trade,
      quantity: soldQuantity,
      exitPrice,
      pnl: realizedPnl,
      slippage: executionSlippage,
      status: 'CLOSED',
      exitReason: 'TAKE_PROFIT_2',
      closedAt: new Date(),
    };
    await ctx.notifier.sendTradeClose(partialTrade);

    // Phase 1B: Paper metrics (closeTrade 우회하므로 수동 기록)
    if (ctx.paperMetrics) {
      ctx.paperMetrics.recordExit(trade.id, exitPrice, 'TAKE_PROFIT_2');
    }
    // Phase 3: WalletManager PnL 기록
    if (ctx.walletManager) {
      const walletName = trade.strategy === 'new_lp_sniper' ? 'sandbox' : 'main';
      ctx.walletManager.recordPnl(walletName, realizedPnl);
    }

    await ctx.notifier.sendTradeAlert(
      `Runner activated (B, 0.5x): ${trade.strategy} ${trade.id}, ` +
      `sold 50% at TP2, remaining ${remainingQuantity.toFixed(6)} SOL trailing`
    );

    await updatePositionsForPair(ctx, trade.pairAddress, 'MONITORING', {
      quantity: remainingQuantity,
      stopLoss: newStopLoss,
      trailingStop: trade.trailingStop,
    });

    ctx.healthMonitor.updateTradeTime();
    log.info(
      `Grade B runner: trade ${trade.id} partial TP2. Realized=${realizedPnl.toFixed(6)} SOL, ` +
      `remaining=${remainingQuantity.toFixed(6)} trailing from ${currentPrice.toFixed(8)}`
    );
  } catch (error) {
    log.error(`Failed Grade B runner partial for trade ${trade.id}: ${error}`);
    await ctx.notifier.sendError('runner_grade_b_partial', error).catch(() => {});
  }
}

async function updatePositionsForPair(
  ctx: BotContext,
  pairAddress: string,
  state: Parameters<PositionStore['updateState']>[1],
  updates: Parameters<PositionStore['updateState']>[2] = {}
): Promise<void> {
  const openPositions = await ctx.positionStore.getOpenPositions();
  for (const pos of openPositions) {
    if (pos.pairAddress === pairAddress) {
      await ctx.positionStore.updateState(pos.id, state, updates);
    }
  }
}
