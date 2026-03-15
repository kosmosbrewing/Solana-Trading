import { Pool } from 'pg';
import { config, TradingMode } from './utils/config';
import { createModuleLogger } from './utils/logger';
import { HealthMonitor } from './utils/healthMonitor';
import { Candle, Signal, Order, Trade, CloseReason, PoolInfo } from './utils/types';

import { BirdeyeClient, Ingester, IngesterConfig } from './ingester';
import { EventMonitor } from './event';
import { CandleStore, TradeStore } from './candle';
import {
  evaluateVolumeSpikeBreakout,
  buildVolumeSpikeOrder,
  evaluateFibPullback,
  buildFibPullbackOrder,
  calcATR,
  checkExhaustion,
  calcAdaptiveTrailingStop,
} from './strategy';
import { evaluateGates, GateEvaluationResult } from './gate';
import { RiskManager, RiskConfig } from './risk';
import { Executor, ExecutorConfig } from './executor';
import { Notifier } from './notifier';
import { UniverseEngine, UniverseEngineConfig } from './universe';
import { ExecutionLock, PositionStore, checkStaleSignal, runRecovery } from './state';
import { SignalAuditLogger } from './audit';

const log = createModuleLogger('Main');

// ─── Bot Context ──────────────────

interface BotContext {
  tradingMode: TradingMode;
  candleStore: CandleStore;
  tradeStore: TradeStore;
  riskManager: RiskManager;
  executor: Executor;
  notifier: Notifier;
  healthMonitor: HealthMonitor;
  universeEngine: UniverseEngine;
  executionLock: ExecutionLock;
  positionStore: PositionStore;
  auditLogger: SignalAuditLogger;
  previousTvl: Map<string, number>;
  tradingHaltedReason?: string;
}

async function main() {
  const tradingMode = config.tradingMode;
  log.info(`=== Solana Momentum Bot v0.3 starting (mode: ${tradingMode}) ===`);

  // ─── 공유 DB Pool ─────────────────────────────────
  const dbPool = new Pool({ connectionString: config.databaseUrl });

  const candleStore = new CandleStore(dbPool);
  const tradeStore = new TradeStore(dbPool);
  const positionStore = new PositionStore(dbPool);
  const auditLogger = new SignalAuditLogger(dbPool);
  await Promise.all([
    candleStore.initialize(),
    tradeStore.initialize(),
    positionStore.initialize(),
    auditLogger.initialize(),
  ]);
  log.info('Database initialized');

  // ─── Initialize modules ─────────────────────────────
  const birdeyeClient = new BirdeyeClient(config.birdeyeApiKey);
  const eventMonitor = new EventMonitor(birdeyeClient, {
    pollingIntervalMs: config.eventPollingIntervalMs,
    minEventScore: config.eventMinScore,
    fetchLimit: config.eventTrendingFetchLimit,
    expiryMinutes: config.eventExpiryMinutes,
    minLiquidityUsd: config.eventMinLiquidityUsd,
  });

  const riskConfig: RiskConfig = {
    maxRiskPerTrade: config.maxRiskPerTrade,
    maxDailyLoss: config.maxDailyLoss,
    maxDrawdownPct: config.maxDrawdownPct,
    recoveryPct: config.recoveryPct,
    maxConsecutiveLosses: config.maxConsecutiveLosses,
    cooldownMinutes: config.cooldownMinutes,
    maxSlippage: config.maxSlippage,
    minPoolLiquidity: config.minPoolLiquidity,
    minTokenAgeHours: config.minTokenAgeHours,
    maxHolderConcentration: config.maxHolderConcentration,
    liquidityParams: {
      maxSlippagePct: config.maxSlippage,
      maxPoolImpactPct: config.maxPoolImpact,
      emergencyHaircut: config.emergencyHaircut,
    },
  };
  const riskManager = new RiskManager(riskConfig, tradeStore);

  const executorConfig: ExecutorConfig = {
    solanaRpcUrl: config.solanaRpcUrl,
    walletPrivateKey: config.walletPrivateKey,
    jupiterApiUrl: config.jupiterApiUrl,
    maxSlippage: config.maxSlippage,
    maxRetries: config.maxRetries,
    txTimeoutMs: config.txTimeoutMs,
  };
  const executor = new Executor(executorConfig);

  const notifier = new Notifier(config.telegramBotToken, config.telegramChatId);

  const healthMonitor = new HealthMonitor();
  healthMonitor.setDbConnected(true);
  healthMonitor.start();

  // ─── Execution Lock (v0.3) ─────────────────────────
  const executionLock = new ExecutionLock(async () => {
    await notifier.sendWarning('ExecutionLock', 'Lock timeout — auto released');
  });

  // ─── Universe Engine ───────────────────────────────
  const targetPair = process.env.TARGET_PAIR_ADDRESS;
  if (!targetPair) {
    log.error('TARGET_PAIR_ADDRESS not set. Exiting.');
    process.exit(1);
  }

  const universeConfig: UniverseEngineConfig = {
    params: {
      minPoolTVL: config.minPoolTVL,
      minTokenAgeSec: config.minTokenAgeSec,
      maxTop10HolderPct: config.maxTop10HolderPct,
      minDailyVolume: config.minDailyVolume,
      minTradeCount24h: config.minTradeCount24h,
      maxSpreadPct: config.maxSpreadPct,
      maxWatchlistSize: config.maxWatchlistSize,
    },
    refreshIntervalMs: config.universeRefreshIntervalMs,
    poolAddresses: [targetPair],
  };

  const universeEngine = new UniverseEngine(birdeyeClient, universeConfig);

  eventMonitor.on('events', (scores) => {
    for (const score of scores) {
      log.info(JSON.stringify({
        type: 'event_score',
        ...score,
      }));
    }
  });

  eventMonitor.on('error', async (error: unknown) => {
    await notifier.sendError('event_monitor', error).catch(() => {});
  });

  universeEngine.on('poolEvent', async (event: { type: string; pairAddress: string; detail: string }) => {
    if (event.type === 'RUG_PULL' || event.type === 'LP_DROP') {
      await notifier.sendCritical('Pool Event', `${event.type}: ${event.detail}`);
      // Emergency close if we have a position
      if (tradingMode === 'live') {
        const openTrades = await tradeStore.getOpenTrades();
        for (const trade of openTrades) {
          if (trade.pairAddress === event.pairAddress) {
            log.warn(`Emergency close triggered for ${trade.id}`);
            await closeTrade(trade, 'EMERGENCY', ctx);
          }
        }
      }
    } else {
      await notifier.sendWarning('Pool Event', `${event.type}: ${event.detail}`);
    }
  });

  const ctx: BotContext = {
    tradingMode,
    candleStore,
    tradeStore,
    riskManager,
    executor,
    notifier,
    healthMonitor,
    universeEngine,
    executionLock,
    positionStore,
    auditLogger,
    previousTvl: new Map(),
    tradingHaltedReason: undefined,
  };

  // ─── Crash Recovery (v0.3) ─────────────────────────
  const recoveryResult = await runRecovery({
    positionStore,
    getTokenBalance: (addr) => executor.getTokenBalance(addr),
    getCurrentPrice: async (addr) => {
      const candles = await candleStore.getRecentCandles(addr, 300, 1);
      return candles.length > 0 ? candles[0].close : null;
    },
    executeSell: (addr, amountRaw) => executor.executeSell(addr, amountRaw),
    finalizeRecoveredTrade: async (pairAddress, txSignature, exitPrice, exitReason = 'RECOVERED_CLOSED') => {
      const openTrade = (await tradeStore.getOpenTrades()).find(trade => trade.pairAddress === pairAddress);
      if (!openTrade) return;

      const resolvedExitPrice = exitPrice ?? openTrade.entryPrice;
      const pnl = (resolvedExitPrice - openTrade.entryPrice) * openTrade.quantity;
      await tradeStore.closeTrade(openTrade.id, resolvedExitPrice, pnl, 0, exitReason);
      await notifier.sendTradeClose({
        ...openTrade,
        exitPrice: resolvedExitPrice,
        pnl,
        slippage: 0,
        status: 'CLOSED',
        txSignature,
        exitReason,
        closedAt: new Date(),
      });
    },
    notifyCritical: (context, message) => notifier.sendCritical(context, message),
  });

  if (recoveryResult.recovered > 0 || recoveryResult.closed > 0) {
    await notifier.sendRecoveryReport(recoveryResult.details);
  }

  // ─── Configure ingester ─────────────────────────────
  const ingesterConfigs: IngesterConfig[] = [
    {
      pairAddress: targetPair,
      intervalType: config.defaultTimeframe === 60 ? '1m' : '5m',
      pollIntervalMs: config.defaultTimeframe * 1000,
    },
  ];

  const ingester = new Ingester(birdeyeClient, candleStore, ingesterConfigs);

  ingester.on('candles', async (candles: Candle[]) => {
    healthMonitor.updateCandleTime();

    const lastCandle = candles[candles.length - 1];
    try {
      await handleNewCandle(lastCandle, ctx);
    } catch (error) {
      log.error(`Error processing candle: ${error}`);
      await notifier.sendError('candle_processing', error).catch(() => {});
    }
  });

  ingester.on('error', async ({ pairAddress, error }: { pairAddress: string; error: unknown }) => {
    log.error(`Ingester error for ${pairAddress}: ${error}`);
    await notifier.sendError('ingester', error).catch(() => {});
  });

  // ─── Position monitor (SL/TP/Time Stop/Exhaustion) ──
  // 5초 간격: micro-cap에서 10초는 SL 관통 슬리피지를 크게 악화시킴
  const positionCheckInterval = setInterval(async () => {
    try {
      await checkOpenPositions(ctx);
    } catch (error) {
      log.error(`Position check error: ${error}`);
      await notifier.sendError('position_check', error).catch(() => {});
    }
  }, 5000);

  // ─── Universe Engine start ──────────────────────────
  await eventMonitor.start();
  await universeEngine.start();

  // ─── Start ingester ─────────────────────────────────
  await ingester.start();
  log.info('Bot is running. Press Ctrl+C to stop.');

  await notifier.sendInfo('Bot started (v0.3)');

  // ─── Daily summary scheduler ────────────────────────
  scheduleDailySummary(ctx);

  // ─── Graceful shutdown ──────────────────────────────
  const shutdown = async () => {
    log.info('Shutting down...');
    clearInterval(positionCheckInterval);
    await ingester.stop();
    eventMonitor.stop();
    universeEngine.stop();
    executionLock.destroy();
    healthMonitor.stop();
    await dbPool.end();
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ─── Core Logic ──────────────────────────────────────────

async function handleNewCandle(candle: Candle, ctx: BotContext): Promise<void> {
  const candles = await ctx.candleStore.getRecentCandles(
    candle.pairAddress,
    candle.intervalSec,
    30
  );

  if (candles.length < 21) {
    log.debug('Not enough candles for strategy evaluation');
    return;
  }

  // Get pool info for breakout score
  const watchlist = ctx.universeEngine.getWatchlist();
  const poolInfo = watchlist.find(p => p.pairAddress === candle.pairAddress);
  if (!poolInfo) {
    log.info(`Skipping ${candle.pairAddress} — pair is not in active watchlist`);
    return;
  }
  const poolTvl = poolInfo.tvl;

  // Strategy A: Volume Spike Breakout (5분봉)
  if (candle.intervalSec === 300) {
    const signal = evaluateVolumeSpikeBreakout(candles, {
      lookback: config.volumeSpikeLookback,
      volumeMultiplier: config.volumeSpikeMultiplier,
    });

    if (signal.action === 'BUY') {
      const prevTvl = ctx.previousTvl.get(candle.pairAddress) || poolTvl;
      const gateResult = evaluateGates({
        signal,
        candles,
        poolInfo,
        previousTvl: prevTvl,
        fibConfig: {
          impulseMinPct: config.fibImpulseMinPct,
          volumeClimaxMultiplier: config.fibVolumeClimaxMultiplier,
          minWickRatio: config.fibMinWickRatio,
        },
        thresholds: {
          minBuyRatio: config.minBuyRatio,
          minBreakoutScore: config.minBreakoutScore,
        },
      });

      signal.breakoutScore = gateResult.breakoutScore;
      signal.poolTvl = poolTvl;

      await processSignal(signal, candles, ctx, gateResult);
    }
  }

  // Strategy C: Fib Pullback (5분봉) — 임펄스 후 되돌림 매수
  if (candle.intervalSec === 300) {
    const fibCandles = await ctx.candleStore.getRecentCandles(
      candle.pairAddress,
      candle.intervalSec,
      Math.max(config.fibImpulseWindowBars + 10, 30)
    );

    if (fibCandles.length >= config.fibImpulseWindowBars + 5) {
      const fibSignal = evaluateFibPullback(fibCandles, {
        impulseWindowBars: config.fibImpulseWindowBars,
        impulseMinPct: config.fibImpulseMinPct,
        fibEntryLow: config.fibEntryLow,
        fibEntryHigh: config.fibEntryHigh,
        fibInvalidation: config.fibInvalidation,
        volumeClimaxMultiplier: config.fibVolumeClimaxMultiplier,
        minWickRatio: config.fibMinWickRatio,
        timeStopMinutes: config.fibTimeStopMinutes,
      });

      if (fibSignal.action === 'BUY') {
        const prevTvl = ctx.previousTvl.get(candle.pairAddress) || poolTvl;
        const gateResult = evaluateGates({
          signal: fibSignal,
          candles: fibCandles,
          poolInfo,
          previousTvl: prevTvl,
          fibConfig: {
            impulseMinPct: config.fibImpulseMinPct,
            volumeClimaxMultiplier: config.fibVolumeClimaxMultiplier,
            minWickRatio: config.fibMinWickRatio,
          },
          thresholds: {
            minBuyRatio: config.minBuyRatio,
            minBreakoutScore: config.minBreakoutScore,
          },
        });

        fibSignal.poolTvl = poolTvl;
        fibSignal.breakoutScore = gateResult.breakoutScore;

        await processSignal(fibSignal, fibCandles, ctx, gateResult);
      }
    }
  }

  ctx.previousTvl.set(candle.pairAddress, poolTvl);
}

async function processSignal(
  signal: Signal,
  candles: Candle[],
  ctx: BotContext,
  gateResult: GateEvaluationResult
): Promise<void> {
  const grade = gateResult.breakoutScore.grade;
  const totalScore = gateResult.breakoutScore.totalScore;

  log.info(`Signal: ${signal.action} from ${signal.strategy} at ${signal.price} (Score: ${totalScore}, Grade: ${grade})`);

  const balanceSol = await ctx.executor.getBalance();
  const portfolio = await ctx.riskManager.getPortfolioState(balanceSol);
  await syncTradingHalts(ctx, portfolio);

  if (ctx.tradingHaltedReason) {
    log.warn(`Signal filtered: trading halted (${ctx.tradingHaltedReason})`);
    await ctx.auditLogger.logSignal({
      pairAddress: signal.pairAddress,
      strategy: signal.strategy,
      ...signal.breakoutScore!,
      candleClose: signal.price,
      volume: candles[candles.length - 1].volume,
      buyVolume: candles[candles.length - 1].buyVolume,
      sellVolume: candles[candles.length - 1].sellVolume,
      poolTvl: signal.poolTvl || 0,
      action: 'FILTERED',
      filterReason: ctx.tradingHaltedReason,
    });
    return;
  }

  // Configured score threshold 미만 → 진입 금지
  if (gateResult.rejected) {
    const filterReason = gateResult.filterReason || `Score ${totalScore} rejected by gate threshold`;
    log.info(`Signal filtered: ${filterReason}`);
    await ctx.auditLogger.logSignal({
      pairAddress: signal.pairAddress,
      strategy: signal.strategy,
      ...signal.breakoutScore!,
      candleClose: signal.price,
      volume: candles[candles.length - 1].volume,
      buyVolume: candles[candles.length - 1].buyVolume,
      sellVolume: candles[candles.length - 1].sellVolume,
      poolTvl: signal.poolTvl || 0,
      action: 'FILTERED',
      filterReason,
    });
    return;
  }

  // Execution Lock
  if (!ctx.executionLock.acquire()) {
    log.info('Signal skipped — execution lock held');
    await ctx.auditLogger.logSignal({
      pairAddress: signal.pairAddress,
      strategy: signal.strategy,
      ...signal.breakoutScore!,
      candleClose: signal.price,
      volume: candles[candles.length - 1].volume,
      poolTvl: signal.poolTvl || 0,
      action: 'FILTERED',
      filterReason: 'Execution lock held',
    });
    return;
  }

  try {
    // Stale Signal Check
    // 캔들 close 가격은 폴링 주기만큼 지연 가능 — dataLatencyMs로 보정
    const candleAgeMs = Date.now() - candles[candles.length - 1].timestamp.getTime();
    const staleResult = checkStaleSignal({
      signal,
      currentPrice: candles[candles.length - 1].close,
      currentTvl: signal.poolTvl,
      dataLatencyMs: Math.min(candleAgeMs, 30_000), // 최대 30초까지 보정
    });

    if (staleResult.isStale) {
      log.info(`Stale signal: ${staleResult.reason}`);
      await ctx.auditLogger.logSignal({
        pairAddress: signal.pairAddress,
        strategy: signal.strategy,
        ...signal.breakoutScore!,
        candleClose: signal.price,
        volume: candles[candles.length - 1].volume,
        poolTvl: signal.poolTvl || 0,
        action: 'STALE',
        filterReason: staleResult.reason,
      });
      return;
    }

    await ctx.notifier.sendSignal(signal);

    // Risk check
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
        pairAddress: signal.pairAddress,
        strategy: signal.strategy,
        ...signal.breakoutScore!,
        candleClose: signal.price,
        volume: candles[candles.length - 1].volume,
        poolTvl: signal.poolTvl || 0,
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

    // Build order
    const quantity = riskResult.adjustedQuantity || 0;
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

    // Record position state
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

      await recordOpenedTrade(ctx, positionId, signal, candles[candles.length - 1], order, totalScore, quantity, riskResult.sizeConstraint, txSignature);
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

/**
 * 열린 포지션 모니터링 (SL/TP/Time Stop/Exhaustion/Adaptive Trailing)
 */
async function checkOpenPositions(ctx: BotContext): Promise<void> {
  const balanceSol = await ctx.executor.getBalance();
  const portfolio = await ctx.riskManager.getPortfolioState(balanceSol);
  const openTrades = portfolio.openTrades;
  ctx.healthMonitor.updatePositions(openTrades.length);
  ctx.healthMonitor.updateDailyPnl(portfolio.dailyPnl);
  await syncTradingHalts(ctx, portfolio);

  if (openTrades.length === 0) {
    return;
  }

  for (const trade of openTrades) {
    const now = new Date();

    // 현재 가격 조회
    const recentCandles = await ctx.candleStore.getRecentCandles(
      trade.pairAddress,
      300,
      10
    );
    if (recentCandles.length === 0) continue;

    const currentPrice = recentCandles[recentCandles.length - 1].close;

    // Time Stop 체크
    if (now >= trade.timeStopAt) {
      log.info(`Time stop triggered for trade ${trade.id}`);
      await closeTrade(trade, 'TIME_STOP', ctx, currentPrice);
      continue;
    }

    // Stop Loss 체크
    if (currentPrice <= trade.stopLoss) {
      // SL 관통 정도를 경고 — 실제 청산 가격은 더 아래일 수 있음
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

    // Take Profit 2 체크
    if (currentPrice >= trade.takeProfit2) {
      log.info(`Take profit 2 triggered for trade ${trade.id} at ${currentPrice}`);
      await closeTrade(trade, 'TAKE_PROFIT_2', ctx, currentPrice);
      continue;
    }

    // Take Profit 1 체크
    if (currentPrice >= trade.takeProfit1) {
      log.info(`Take profit 1 triggered for trade ${trade.id} at ${currentPrice}`);
      await handleTakeProfit1Partial(trade, currentPrice, ctx);
      continue;
    }

    // Exhaustion Exit 체크
    if (recentCandles.length >= 2) {
      const { exhausted, indicators } = checkExhaustion(recentCandles, config.exhaustionThreshold);
      if (exhausted && currentPrice > trade.entryPrice) {
        log.info(`Exhaustion exit for trade ${trade.id}: ${indicators.join(', ')}`);
        await closeTrade(trade, 'EXHAUSTION', ctx, currentPrice);
        continue;
      }
    }

    // Adaptive Trailing Stop 체크
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
        continue;
      }
    }
  }

}

async function syncTradingHalts(
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

async function closeTrade(
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

    const closedTrade = { ...trade, exitPrice, pnl, slippage: executionSlippage, status: 'CLOSED' as const, exitReason: reason };
    await ctx.notifier.sendTradeClose(closedTrade);
    await updatePositionsForPair(ctx, trade.pairAddress, 'EXIT_CONFIRMED', {
      txExit: txSignature,
      exitReason: reason,
      pnl,
    });

    ctx.healthMonitor.updateTradeTime();
    log.info(`Trade ${trade.id} closed (${reason}). PnL: ${pnl.toFixed(6)} SOL`);
  } catch (error) {
    log.error(`Failed to close trade ${trade.id}: ${error}`);
    await ctx.tradeStore.failTrade(trade.id, `Close failed: ${error}`);
    await ctx.notifier.sendError('trade_close', error).catch(() => {});
  }
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

async function recordOpenedTrade(
  ctx: BotContext,
  positionId: string,
  signal: Signal,
  lastCandle: Candle,
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
    pairAddress: signal.pairAddress,
    strategy: signal.strategy,
    ...signal.breakoutScore!,
    candleClose: signal.price,
    volume: lastCandle.volume,
    poolTvl: signal.poolTvl || 0,
    action: 'EXECUTED',
    positionSize: quantity,
    sizeConstraint,
  });
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

/**
 * 일일 요약 리포트 스케줄러 (매일 KST 09:00)
 */
function scheduleDailySummary(ctx: BotContext): void {
  const checkInterval = setInterval(async () => {
    const now = new Date();
    const kstHour = (now.getUTCHours() + 9) % 24;
    const minute = now.getMinutes();

    // KST 09:00 ~ 09:01
    if (kstHour === 9 && minute === 0) {
      try {
        await sendDailySummaryReport(ctx);
      } catch (error) {
        log.error(`Daily summary failed: ${error}`);
      }
    }
  }, 60_000);

  // Cleanup on shutdown handled by process exit
}

async function sendDailySummaryReport(ctx: BotContext): Promise<void> {
  const todayTrades = await ctx.tradeStore.getTodayTrades();
  const dailyPnl = await ctx.tradeStore.getTodayPnl();
  const signalCounts = await ctx.auditLogger.getTodaySignalCounts();
  const balance = await ctx.executor.getBalance();
  const status = ctx.healthMonitor.getStatus();

  const wins = todayTrades.filter(t => (t.pnl || 0) > 0);
  const losses = todayTrades.filter(t => (t.pnl || 0) <= 0 && t.status === 'CLOSED');

  const portfolio = await ctx.riskManager.getPortfolioState(balance);

  let bestTrade: { pair: string; pnl: number; score: number; grade: string } | undefined;
  let worstTrade: { pair: string; pnl: number; score: number; grade: string } | undefined;

  for (const t of todayTrades) {
    if (t.pnl !== undefined) {
      if (!bestTrade || t.pnl > bestTrade.pnl) {
        bestTrade = { pair: t.pairAddress, pnl: t.pnl, score: t.breakoutScore || 0, grade: t.breakoutGrade || 'N/A' };
      }
      if (!worstTrade || t.pnl < worstTrade.pnl) {
        worstTrade = { pair: t.pairAddress, pnl: t.pnl, score: t.breakoutScore || 0, grade: t.breakoutGrade || 'N/A' };
      }
    }
  }

  await ctx.notifier.sendDailySummary({
    totalTrades: todayTrades.length,
    wins: wins.length,
    losses: losses.length,
    pnl: dailyPnl,
    portfolioValue: balance,
    bestTrade,
    worstTrade,
    signalsDetected: signalCounts.detected,
    signalsExecuted: signalCounts.executed,
    signalsFiltered: signalCounts.filtered,
    dailyLossUsed: portfolio.equitySol > 0 ? Math.abs(dailyPnl) / portfolio.equitySol : 0,
    dailyLossLimit: config.maxDailyLoss,
    consecutiveLosses: portfolio.consecutiveLosses,
    uptime: status.uptime,
    restarts: 0,
  });
}

// ─── Entry Point ─────────────────────────────────────────
main().catch((error) => {
  log.error(`Fatal error: ${error}`);
  process.exit(1);
});
