import { GateEvaluationResult, evaluateExecutionViabilityForOrder } from '../gate';
import { buildFibPullbackOrder, buildVolumeSpikeOrder } from '../strategy';
import { checkStaleSignal } from '../state';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { Candle, Order, Signal } from '../utils/types';
import { buildSignalAuditBase, recordOpenedTrade, runnerStateMap, syncTradingHalts } from './tradeExecution';
import { BotContext } from './types';

const log = createModuleLogger('SignalProcessor');

export async function processSignal(
  signal: Signal,
  candles: Candle[],
  ctx: BotContext,
  gateResult: GateEvaluationResult
): Promise<void> {
  const grade = gateResult.breakoutScore.grade;
  const totalScore = gateResult.breakoutScore.totalScore;

  const attentionInfo = gateResult.attentionScore
    ? `Attention: ${gateResult.attentionScore.attentionScore} (${gateResult.attentionScore.confidence})`
    : 'Attention: none';
  log.info(`Signal: ${signal.action} from ${signal.strategy} at ${signal.price} (Score: ${totalScore}, Grade: ${grade}, ${attentionInfo})`);

  const balanceSol = await ctx.executor.getBalance();
  const portfolio = await ctx.riskManager.getPortfolioState(balanceSol);

  // v3: Runner trade ID를 portfolio에 주입 — concurrent 판정에 사용
  const runnerIds = new Set<string>();
  for (const [tradeId, isRunner] of runnerStateMap) {
    if (isRunner) runnerIds.add(tradeId);
  }
  if (runnerIds.size > 0) {
    portfolio.runnerTradeIds = runnerIds;
  }

  await syncTradingHalts(ctx, portfolio);

  if (ctx.tradingHaltedReason) {
    log.warn(`Signal filtered: trading halted (${ctx.tradingHaltedReason})`);
    await ctx.auditLogger.logSignal({
      ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult),
      action: 'FILTERED',
      filterReason: ctx.tradingHaltedReason,
    });
    return;
  }

  if (gateResult.rejected) {
    const filterReason = gateResult.filterReason || `Score ${totalScore} rejected by gate threshold`;
    log.info(`Signal filtered: ${filterReason}`);
    await ctx.auditLogger.logSignal({
      ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult),
      action: 'FILTERED',
      filterReason,
    });
    return;
  }

  if (!ctx.executionLock.acquire()) {
    log.info('Signal skipped — execution lock held');
    await ctx.auditLogger.logSignal({
      ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult),
      action: 'FILTERED',
      filterReason: 'Execution lock held',
    });
    return;
  }

  try {
    const candleAgeMs = Date.now() - candles[candles.length - 1].timestamp.getTime();
    const staleResult = checkStaleSignal({
      signal,
      currentPrice: candles[candles.length - 1].close,
      currentTvl: signal.poolTvl,
      dataLatencyMs: Math.min(candleAgeMs, 30_000),
    });

    if (staleResult.isStale) {
      log.info(`Stale signal: ${staleResult.reason}`);
      await ctx.auditLogger.logSignal({
        ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult),
        action: 'STALE',
        filterReason: staleResult.reason,
      });
      return;
    }

    await ctx.notifier.sendSignal(signal);

    const riskResult = await ctx.riskManager.checkOrder(
      {
        pairAddress: signal.pairAddress,
        strategy: signal.strategy,
        side: 'BUY',
        price: signal.price,
        stopLoss: candles[candles.length - 1].low,
        breakoutGrade: grade,
        poolTvl: signal.poolTvl,
      },
      portfolio,
      gateResult.tokenSafety
    );

    if (!riskResult.approved) {
      log.warn(`Order rejected by risk manager: ${riskResult.reason}`);
      await ctx.auditLogger.logSignal({
        ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult),
        action: 'RISK_REJECTED',
        filterReason: riskResult.reason,
      });
      return;
    }

    if (riskResult.appliedAdjustments && riskResult.appliedAdjustments.length > 0) {
      log.warn(
        `Risk adjustments applied to ${signal.pairAddress}: ${riskResult.appliedAdjustments.join(', ')}`
      );
    }

    let quantity = (riskResult.adjustedQuantity || 0) * gateResult.gradeSizeMultiplier;
    if (gateResult.gradeSizeMultiplier < 1) {
      log.info(
        `Gate sizing multiplier applied: ${gateResult.gradeSizeMultiplier.toFixed(2)} ` +
        `effectiveRR=${gateResult.executionViability.effectiveRR.toFixed(2)}`
      );
    }

    // Phase 1B: Apply regime filter sizing
    if (ctx.regimeFilter) {
      const regimeMult = ctx.regimeFilter.getSizeMultiplier();
      if (regimeMult <= 0) {
        const regime = ctx.regimeFilter.getRegime();
        log.info(`Signal blocked by regime filter: ${regime} (sizeMultiplier=0)`);
        await ctx.auditLogger.logSignal({
          ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult),
          action: 'FILTERED',
          filterReason: `Regime ${regime} — no new entries`,
        });
        return;
      }
      if (regimeMult < 1) {
        quantity *= regimeMult;
        log.info(`Regime sizing: ${ctx.regimeFilter.getRegime()} x${regimeMult.toFixed(2)}`);
      }
    }
    // H-01: WalletManager pre-trade 체크 (일일 손실 한도 + 포지션 한도)
    if (ctx.walletManager) {
      const positionSol = quantity * signal.price;
      const walletLimit = ctx.walletManager.checkTradeLimits(signal.strategy, positionSol);
      if (!walletLimit.allowed) {
        log.warn(`Signal filtered: ${walletLimit.reason}`);
        await ctx.auditLogger.logSignal({
          ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult),
          action: 'RISK_REJECTED',
          filterReason: walletLimit.filterReason,
        });
        return;
      }
    }

    let order: Order;
    if (signal.strategy === 'volume_spike') {
      order = buildVolumeSpikeOrder(signal, candles, quantity);
    } else if (signal.strategy === 'fib_pullback') {
      order = buildFibPullbackOrder(signal, candles, quantity, {
        timeStopMinutes: config.fibTimeStopMinutes,
      });
    } else {
      throw new Error(`Unsupported live strategy: ${signal.strategy}`);
    }

    order.breakoutScore = totalScore;
    order.breakoutGrade = grade;
    order.sizeConstraint = riskResult.sizeConstraint;

    const actualExecution = evaluateExecutionViabilityForOrder(order, signal.poolTvl || 0, {
      ammFeePct: signal.meta.ammFeePct,
      mevMarginPct: signal.meta.mevMarginPct,
    }, {
      rrReject: config.executionRrReject,
      rrPass: config.executionRrPass,
    });
    if (actualExecution.rejected) {
      log.warn(`Signal filtered after size-aware execution check: ${actualExecution.filterReason}`);
      await ctx.auditLogger.logSignal({
        ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult),
        action: 'FILTERED',
        filterReason: actualExecution.filterReason,
      });
      return;
    }
    if (actualExecution.sizeMultiplier < 1) {
      order.quantity *= actualExecution.sizeMultiplier;
      quantity = order.quantity;
      log.info(
        `Actual-size execution haircut applied: x${actualExecution.sizeMultiplier.toFixed(2)} ` +
        `effectiveRR=${actualExecution.effectiveRR.toFixed(2)}`
      );
    }

    const positionId = await ctx.positionStore.createPosition(
      signal.pairAddress,
      { signal: signal.meta, score: totalScore, grade }
    );

    try {
      let txSignature = 'PAPER_TRADE';

      if (ctx.tradingMode === 'paper') {
        log.info(`[PAPER] Simulating execution: ${JSON.stringify(order)}`);
      } else {
        await ctx.positionStore.updateState(positionId, 'ORDER_SUBMITTED');
        const buyResult = await ctx.executor.executeBuy(order);
        txSignature = buyResult.txSignature;

        if (buyResult.slippageBps > 0) {
          log.info(`Entry slippage: ${buyResult.slippageBps}bps`);
        }
      }

      await recordOpenedTrade(
        ctx,
        positionId,
        signal,
        candles[candles.length - 1],
        gateResult,
        order,
        totalScore,
        quantity,
        riskResult.sizeConstraint,
        txSignature
      );

      // Phase 1B: Record paper metrics entry
      if (ctx.paperMetrics) {
        ctx.paperMetrics.recordEntry({
          id: positionId,
          pairAddress: signal.pairAddress,
          strategy: signal.strategy,
          entryPrice: order.price,
          quantity: order.quantity,
          entryTime: new Date(),
          entryPriceImpactPct: gateResult.quoteGate?.priceImpactPct,
          regimeAtEntry: ctx.regimeFilter?.getRegime(),
          securityFlags: gateResult.securityGate?.flags,
        });
      }

      log.info(`Trade opened: ${txSignature}`);
    } catch (error) {
      log.error(`Trade execution failed: ${error}`);
      await ctx.positionStore.updateState(positionId, 'ORDER_FAILED');
      await ctx.notifier.sendError('trade_execution', error).catch(() => {});
    }
  } finally {
    ctx.executionLock.release();
  }
}
