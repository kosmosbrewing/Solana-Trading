import { GateEvaluationResult } from '../gate';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { Candle, CloseReason, Order, Signal, Trade } from '../utils/types';
import { calcATR, calcAdaptiveTrailingStop, checkExhaustion } from '../strategy';
import { PositionStore } from '../state';
import { RiskManager } from '../risk';
import { BotContext } from './types';

const log = createModuleLogger('TradeExecution');

export async function checkOpenPositions(ctx: BotContext): Promise<void> {
  const balanceSol = await ctx.executor.getBalance();
  const portfolio = await ctx.riskManager.getPortfolioState(balanceSol);
  const openTrades = portfolio.openTrades;
  ctx.healthMonitor.updatePositions(openTrades.length);
  ctx.healthMonitor.updateDailyPnl(portfolio.dailyPnl);

  if (openTrades.length === 0) {
    await syncTradingHalts(ctx, portfolio);
    return;
  }

  const monitoredTrades = await Promise.all(openTrades.map(async trade => {
    const recentCandles = await ctx.candleStore.getRecentCandles(
      trade.pairAddress,
      300,
      10
    );
    if (recentCandles.length === 0) return undefined;
    return {
      trade,
      recentCandles,
      currentPrice: recentCandles[recentCandles.length - 1].close,
    };
  }));
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

    if (now >= trade.timeStopAt) {
      log.info(`Time stop triggered for trade ${trade.id}`);
      await closeTrade(trade, 'TIME_STOP', ctx, currentPrice);
      continue;
    }

    if (currentPrice <= trade.stopLoss) {
      const penetrationPct = ((trade.stopLoss - currentPrice) / trade.stopLoss) * 100;
      if (penetrationPct > 1) {
        log.warn(
          `SL penetration warning: price ${currentPrice} is ${penetrationPct.toFixed(1)}% below SL ${trade.stopLoss}. ` +
          `Actual exit slippage may be significant.`
        );
      }
      log.info(`Stop loss triggered for trade ${trade.id} at ${currentPrice}`);
      await closeTrade(trade, 'STOP_LOSS', ctx, currentPrice);
      continue;
    }

    if (currentPrice >= trade.takeProfit2) {
      log.info(`Take profit 2 triggered for trade ${trade.id} at ${currentPrice}`);
      await closeTrade(trade, 'TAKE_PROFIT_2', ctx, currentPrice);
      continue;
    }

    if (currentPrice >= trade.takeProfit1) {
      log.info(`Take profit 1 triggered for trade ${trade.id} at ${currentPrice}`);
      await handleTakeProfit1Partial(trade, currentPrice, ctx);
      continue;
    }

    if (recentCandles.length >= 2) {
      const { exhausted, indicators } = checkExhaustion(recentCandles, config.exhaustionThreshold);
      if (exhausted && currentPrice > trade.entryPrice) {
        log.info(`Exhaustion exit for trade ${trade.id}: ${indicators.join(', ')}`);
        await closeTrade(trade, 'EXHAUSTION', ctx, currentPrice);
        continue;
      }
    }

    if (trade.trailingStop && recentCandles.length >= 8) {
      const atr = calcATR(recentCandles, 7);
      const recentPeak = Math.max(...recentCandles.map(c => c.high));
      const peakPrice = Math.max(trade.highWaterMark ?? trade.entryPrice, recentPeak);
      if (!trade.highWaterMark || peakPrice > trade.highWaterMark) {
        await ctx.tradeStore.updateHighWaterMark(trade.id, peakPrice);
        trade.highWaterMark = peakPrice;
      }
      const adaptiveStop = calcAdaptiveTrailingStop(recentCandles, atr, trade.entryPrice, peakPrice);

      if (currentPrice <= adaptiveStop && currentPrice > trade.stopLoss) {
        log.info(`Adaptive trailing stop triggered for trade ${trade.id} at ${currentPrice}`);
        await closeTrade(trade, 'TRAILING_STOP', ctx, currentPrice);
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

    await ctx.tradeStore.closeTrade(trade.id, exitPrice, pnl, executionSlippage, reason);

    const closedTrade = {
      ...trade,
      exitPrice,
      pnl,
      slippage: executionSlippage,
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
  quantity: number,
  sizeConstraint: Trade['sizeConstraint'],
  txSignature: string
): Promise<void> {
  await ctx.positionStore.updateState(positionId, 'ENTRY_CONFIRMED', {
    entryPrice: order.price,
    quantity: order.quantity,
    stopLoss: order.stopLoss,
    takeProfit1: order.takeProfit1,
    takeProfit2: order.takeProfit2,
    trailingStop: order.trailingStop,
    txEntry: txSignature,
  });

  const timeStopAt = new Date(Date.now() + order.timeStopMinutes * 60 * 1000);
  await ctx.tradeStore.insertTrade({
    pairAddress: order.pairAddress,
    strategy: order.strategy,
    side: order.side,
    entryPrice: order.price,
    quantity: order.quantity,
    stopLoss: order.stopLoss,
    takeProfit1: order.takeProfit1,
    takeProfit2: order.takeProfit2,
    trailingStop: order.trailingStop,
    highWaterMark: order.price,
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
  await ctx.notifier.sendTradeOpen(order, txSignature);
  await ctx.auditLogger.logSignal({
    ...buildSignalAuditBase(signal, lastCandle, gateResult),
    action: 'EXECUTED',
    positionSize: quantity,
    sizeConstraint,
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
    ...signal.breakoutScore!,
    candleClose: signal.price,
    volume: candle.volume,
    buyVolume: candle.buyVolume,
    sellVolume: candle.sellVolume,
    poolTvl: signal.poolTvl || 0,
    spreadPct: signal.spreadPct,
    effectiveRR: gateResult.executionViability.effectiveRR,
    roundTripCost: gateResult.executionViability.roundTripCost,
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

    await ctx.tradeStore.closeTrade(
      trade.id,
      exitPrice,
      realizedPnl,
      executionSlippage,
      'TAKE_PROFIT_1',
      soldQuantity
    );

    const remainingTrade: Omit<Trade, 'id'> = {
      ...trade,
      quantity: remainingQuantity,
      stopLoss: trade.entryPrice,
      takeProfit1: trade.takeProfit2,
      takeProfit2: trade.takeProfit2,
      highWaterMark: Math.max(trade.highWaterMark ?? trade.entryPrice, currentPrice),
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
