import { Pool } from 'pg';
import { config, TradingMode } from './utils/config';
import { createModuleLogger } from './utils/logger';
import { HealthMonitor } from './utils/healthMonitor';
import { Candle, Signal, Order, Trade, CloseReason, PoolInfo } from './utils/types';

import { BirdeyeClient, Ingester, IngesterConfig } from './ingester';
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

  const riskConfig: RiskConfig = {
    maxRiskPerTrade: config.maxRiskPerTrade,
    maxDailyLoss: config.maxDailyLoss,
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

  // Grade C → 진입 금지
  if (gateResult.rejected) {
    const filterReason = gateResult.filterReason || `Grade C (score ${totalScore})`;
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
    const [balanceSol, portfolio] = await Promise.all([
      ctx.executor.getBalance(),
      ctx.riskManager.getPortfolioState(0),
    ]);
    portfolio.balanceSol = balanceSol;

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

    if (ctx.tradingMode === 'paper') {
      log.info(`[PAPER] Would execute: ${JSON.stringify(order)}`);
      await ctx.notifier.sendTradeOpen(order, 'PAPER_TRADE');
      await ctx.auditLogger.logSignal({
        pairAddress: signal.pairAddress,
        strategy: signal.strategy,
        ...signal.breakoutScore!,
        candleClose: signal.price,
        volume: candles[candles.length - 1].volume,
        poolTvl: signal.poolTvl || 0,
        action: 'EXECUTED',
        positionSize: quantity,
        sizeConstraint: riskResult.sizeConstraint,
      });
      await ctx.positionStore.updateState(positionId, 'EXIT_CONFIRMED');
      return;
    }

    // Live execution
    try {
      await ctx.positionStore.updateState(positionId, 'ORDER_SUBMITTED');

      const buyResult = await ctx.executor.executeBuy(order);
      const txSignature = buyResult.txSignature;

      // 실제 슬리피지 기록
      if (buyResult.slippageBps > 0) {
        log.info(`Entry slippage: ${buyResult.slippageBps}bps`);
      }

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
        breakoutGrade: grade,
        sizeConstraint: riskResult.sizeConstraint,
      });

      await ctx.positionStore.updateState(positionId, 'MONITORING');

      ctx.healthMonitor.updateTradeTime();
      await ctx.notifier.sendTradeOpen(order, txSignature);

      await ctx.auditLogger.logSignal({
        pairAddress: signal.pairAddress,
        strategy: signal.strategy,
        ...signal.breakoutScore!,
        candleClose: signal.price,
        volume: candles[candles.length - 1].volume,
        poolTvl: signal.poolTvl || 0,
        action: 'EXECUTED',
        positionSize: quantity,
        sizeConstraint: riskResult.sizeConstraint,
      });

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
  if (ctx.tradingMode === 'paper') return;

  const openTrades = await ctx.tradeStore.getOpenTrades();
  ctx.healthMonitor.updatePositions(openTrades.length);
  const dailyPnl = await ctx.tradeStore.getTodayPnl();
  ctx.healthMonitor.updateDailyPnl(dailyPnl);
  const balance = await ctx.executor.getBalance();
  await enforceDailyLossHalt(ctx, dailyPnl, balance);

  if (openTrades.length === 0) {
    return;
  }

  for (const trade of openTrades) {
    const now = new Date();

    // Time Stop 체크
    if (now >= trade.timeStopAt) {
      log.info(`Time stop triggered for trade ${trade.id}`);
      await closeTrade(trade, 'TIME_STOP', ctx);
      continue;
    }

    // 현재 가격 조회
    const recentCandles = await ctx.candleStore.getRecentCandles(
      trade.pairAddress,
      300,
      10
    );
    if (recentCandles.length === 0) continue;

    const currentPrice = recentCandles[recentCandles.length - 1].close;

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
      await closeTrade(trade, 'STOP_LOSS', ctx);
      continue;
    }

    // Take Profit 2 체크
    if (currentPrice >= trade.takeProfit2) {
      log.info(`Take profit 2 triggered for trade ${trade.id} at ${currentPrice}`);
      await closeTrade(trade, 'TAKE_PROFIT_2', ctx);
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
        await closeTrade(trade, 'EXHAUSTION', ctx);
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
        await closeTrade(trade, 'TRAILING_STOP', ctx);
        continue;
      }
    }
  }

}

async function enforceDailyLossHalt(
  ctx: BotContext,
  dailyPnl: number,
  balance: number
): Promise<void> {
  const exceeded = dailyPnl < -(balance * config.maxDailyLoss);

  if (!exceeded && ctx.tradingHaltedReason) {
    log.info(`Trading resumed: daily PnL ${dailyPnl.toFixed(4)} within limit`);
    await ctx.notifier.sendInfo('Trading resumed — daily loss limit cleared');
    ctx.tradingHaltedReason = undefined;
    return;
  }

  if (!exceeded || ctx.tradingHaltedReason) {
    return;
  }

  const reason =
    `Trading halted: daily loss ${(Math.abs(dailyPnl) * 100 / Math.max(balance, 1e-9)).toFixed(2)}% ` +
    `exceeds ${(config.maxDailyLoss * 100).toFixed(2)}% limit`;

  ctx.tradingHaltedReason = reason;
  log.error(reason);
  await ctx.notifier.sendCritical('Daily Loss', reason);
}

async function closeTrade(
  trade: Trade,
  reason: CloseReason,
  ctx: BotContext
): Promise<void> {
  try {
    const tokenBalance = await ctx.executor.getTokenBalance(trade.pairAddress);

    let txSignature: string | undefined;
    let exitPrice = trade.entryPrice;
    let executionSlippage = 0;

    if (tokenBalance > 0n) {
      // 매도 전 SOL 잔고 기록
      const solBefore = await ctx.executor.getBalance();

      const sellResult = await ctx.executor.executeSell(trade.pairAddress, tokenBalance);
      txSignature = sellResult.txSignature;

      // 매도 후 SOL 잔고로 실제 수신액 계산
      const solAfter = await ctx.executor.getBalance();
      const receivedSol = solAfter - solBefore;

      // 실제 exitPrice = 받은 SOL / 보유 토큰 수량
      if (receivedSol > 0 && trade.quantity > 0) {
        exitPrice = receivedSol / trade.quantity;
      }

      // 실행 슬리피지 = Jupiter quote 대비 실제 수신량 차이
      executionSlippage = sellResult.slippageBps / 10000;

      log.info(
        `Sell executed: received=${receivedSol.toFixed(6)} SOL, ` +
        `exitPrice=${exitPrice.toFixed(8)}, slippage=${sellResult.slippageBps}bps`
      );
    } else {
      log.warn(`No token balance for trade ${trade.id} — closing with entry price`);
    }

    const pnl = (exitPrice - trade.entryPrice) * trade.quantity;

    await ctx.tradeStore.closeTrade(trade.id, exitPrice, pnl, executionSlippage, reason);

    const closedTrade = { ...trade, exitPrice, pnl, slippage: executionSlippage, status: 'CLOSED' as const, exitReason: reason };
    await ctx.notifier.sendTradeClose(closedTrade);

    // Update position state
    const openPositions = await ctx.positionStore.getOpenPositions();
    for (const pos of openPositions) {
      if (pos.pairAddress === trade.pairAddress) {
        await ctx.positionStore.updateState(pos.id, 'EXIT_CONFIRMED', {
          txExit: txSignature,
          exitReason: reason,
          pnl,
        });
      }
    }

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
    const tokenBalance = await ctx.executor.getTokenBalance(trade.pairAddress);
    const partialTokenAmount = tokenBalance / 2n;

    if (partialTokenAmount <= 0n || trade.quantity <= 0) {
      log.warn(`Partial TP1 unavailable for trade ${trade.id}; closing full position instead`);
      await closeTrade(trade, 'TAKE_PROFIT_1', ctx);
      return;
    }

    const soldQuantity = trade.quantity * 0.5;
    const remainingQuantity = trade.quantity - soldQuantity;

    if (remainingQuantity <= 0 || soldQuantity <= 0) {
      log.warn(`Invalid TP1 split for trade ${trade.id}; closing full position instead`);
      await closeTrade(trade, 'TAKE_PROFIT_1', ctx);
      return;
    }

    const solBefore = await ctx.executor.getBalance();
    const sellResult = await ctx.executor.executeSell(trade.pairAddress, partialTokenAmount);
    const solAfter = await ctx.executor.getBalance();
    const receivedSol = solAfter - solBefore;

    const exitPrice = receivedSol > 0 ? receivedSol / soldQuantity : currentPrice;
    const executionSlippage = sellResult.slippageBps / 10000;
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

    const openPositions = await ctx.positionStore.getOpenPositions();
    for (const pos of openPositions) {
      if (pos.pairAddress === trade.pairAddress) {
        await ctx.positionStore.updateState(pos.id, 'MONITORING', {
          quantity: remainingQuantity,
          stopLoss: trade.entryPrice,
          takeProfit1: trade.takeProfit2,
          takeProfit2: trade.takeProfit2,
          trailingStop: trade.trailingStop,
        });
      }
    }

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
    dailyLossUsed: balance > 0 ? Math.abs(dailyPnl) / balance : 0,
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
