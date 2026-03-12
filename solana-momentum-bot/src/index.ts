import { Pool } from 'pg';
import { config, TradingMode } from './utils/config';
import { createModuleLogger } from './utils/logger';
import { HealthMonitor } from './utils/healthMonitor';
import { Candle, Signal, Order, Trade, CloseReason } from './utils/types';

import { BirdeyeClient, Ingester, IngesterConfig } from './ingester';
import { CandleStore, TradeStore } from './candle';
import {
  evaluateVolumeSpikeBreakout,
  buildVolumeSpikeOrder,
  evaluatePumpDetection,
  buildPumpOrder,
} from './strategy';
import { RiskManager, RiskConfig } from './risk';
import { Executor, ExecutorConfig } from './executor';
import { Notifier } from './notifier';

const log = createModuleLogger('Main');

// ─── Bot Context (모듈 의존성 묶음) ──────────────────

interface BotContext {
  tradingMode: TradingMode;
  candleStore: CandleStore;
  tradeStore: TradeStore;
  riskManager: RiskManager;
  executor: Executor;
  notifier: Notifier;
  healthMonitor: HealthMonitor;
}

async function main() {
  const tradingMode = config.tradingMode;
  log.info(`=== Solana Momentum Bot starting (mode: ${tradingMode}) ===`);

  // ─── 공유 DB Pool ─────────────────────────────────
  const dbPool = new Pool({ connectionString: config.databaseUrl });

  const candleStore = new CandleStore(dbPool);
  const tradeStore = new TradeStore(dbPool);
  await Promise.all([candleStore.initialize(), tradeStore.initialize()]);
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

  const ctx: BotContext = {
    tradingMode,
    candleStore,
    tradeStore,
    riskManager,
    executor,
    notifier,
    healthMonitor,
  };

  // ─── Configure ingester ─────────────────────────────
  const targetPair = process.env.TARGET_PAIR_ADDRESS;
  if (!targetPair) {
    log.error('TARGET_PAIR_ADDRESS not set. Exiting.');
    process.exit(1);
  }

  const ingesterConfigs: IngesterConfig[] = [
    {
      pairAddress: targetPair,
      intervalType: config.defaultTimeframe === 60 ? '1m' : '5m',
      pollIntervalMs: config.defaultTimeframe * 1000,
    },
  ];

  const ingester = new Ingester(birdeyeClient, candleStore, ingesterConfigs);

  // ─── Candle batch handler (배치 이벤트: 마지막 캔들만 전략 평가) ──
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

  ingester.on('error', async ({ pairAddress, error }) => {
    log.error(`Ingester error for ${pairAddress}: ${error}`);
    await notifier.sendError('ingester', error).catch(() => {});
  });

  // ─── Position monitor (SL/TP/Time Stop) ─────────────
  const positionCheckInterval = setInterval(async () => {
    try {
      await checkOpenPositions(ctx);
    } catch (error) {
      log.error(`Position check error: ${error}`);
      await notifier.sendError('position_check', error).catch(() => {});
    }
  }, 10000);

  // ─── Start ingester ─────────────────────────────────
  await ingester.start();
  log.info('Bot is running. Press Ctrl+C to stop.');

  // ─── Graceful shutdown ──────────────────────────────
  const shutdown = async () => {
    log.info('Shutting down...');
    clearInterval(positionCheckInterval);
    await ingester.stop();
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

  // Strategy A: Volume Spike Breakout (5분봉)
  if (candle.intervalSec === 300) {
    const signal = evaluateVolumeSpikeBreakout(candles, {
      lookback: config.volumeSpikeLookback,
      volumeMultiplier: config.volumeSpikeMultiplier,
    });

    if (signal.action === 'BUY') {
      await processSignal(signal, candles, ctx);
    }
  }

  // Strategy B: Pump Detection (1분봉)
  if (candle.intervalSec === 60) {
    const signal = evaluatePumpDetection(candles, {
      consecutiveCandles: config.pumpConsecutiveCandles,
      minPriceMove: config.pumpMinPriceMove,
    });

    if (signal.action === 'BUY') {
      await processSignal(signal, candles, ctx);
    }
  }
}

async function processSignal(
  signal: Signal,
  candles: Candle[],
  ctx: BotContext
): Promise<void> {
  log.info(`Signal: ${signal.action} from ${signal.strategy} at ${signal.price}`);
  await ctx.notifier.sendSignal(signal);

  // 잔고 + 포트폴리오 병렬 조회
  const [balanceSol, portfolio] = await Promise.all([
    ctx.executor.getBalance(),
    ctx.riskManager.getPortfolioState(0), // 임시 잔고 — 아래에서 보정
  ]);
  portfolio.balanceSol = balanceSol;

  // 리스크 체크 (최소 필드만 전달)
  const riskResult = await ctx.riskManager.checkOrder(
    {
      pairAddress: signal.pairAddress,
      strategy: signal.strategy,
      side: 'BUY',
      price: signal.price,
      stopLoss: candles[candles.length - 1].low, // 예상 SL
    },
    portfolio
  );

  if (!riskResult.approved) {
    log.warn(`Order rejected by risk manager: ${riskResult.reason}`);
    return;
  }

  // 주문 생성
  const quantity = riskResult.adjustedQuantity || 0;
  const order: Order = signal.strategy === 'volume_spike'
    ? buildVolumeSpikeOrder(signal, candles, quantity)
    : buildPumpOrder(signal, candles, quantity);

  if (ctx.tradingMode === 'paper') {
    log.info(`[PAPER] Would execute: ${JSON.stringify(order)}`);
    await ctx.notifier.sendTradeOpen(order, 'PAPER_TRADE');
    return;
  }

  // Live execution
  try {
    const txSignature = await ctx.executor.executeBuy(order);

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
      timeStopAt,
      status: 'OPEN',
      txSignature,
      createdAt: new Date(),
    });

    ctx.healthMonitor.updateTradeTime();
    await ctx.notifier.sendTradeOpen(order, txSignature);
    log.info(`Trade opened: ${txSignature}`);
  } catch (error) {
    log.error(`Trade execution failed: ${error}`);
    await ctx.notifier.sendError('trade_execution', error).catch(() => {});
  }
}

/**
 * 열린 포지션 모니터링 (SL/TP/Time Stop)
 */
async function checkOpenPositions(ctx: BotContext): Promise<void> {
  if (ctx.tradingMode === 'paper') return;

  const openTrades = await ctx.tradeStore.getOpenTrades();
  ctx.healthMonitor.updatePositions(openTrades.length);

  // 열린 포지션이 없으면 PnL만 업데이트하고 종료
  if (openTrades.length === 0) {
    const dailyPnl = await ctx.tradeStore.getTodayPnl();
    ctx.healthMonitor.updateDailyPnl(dailyPnl);
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
      1
    );
    if (recentCandles.length === 0) continue;

    const currentPrice = recentCandles[recentCandles.length - 1].close;

    // Stop Loss 체크
    if (currentPrice <= trade.stopLoss) {
      log.info(`Stop loss triggered for trade ${trade.id} at ${currentPrice}`);
      await closeTrade(trade, 'STOP_LOSS', ctx);
      continue;
    }

    // Take Profit 1 체크
    if (currentPrice >= trade.takeProfit1) {
      log.info(`Take profit 1 triggered for trade ${trade.id} at ${currentPrice}`);
      await closeTrade(trade, 'TAKE_PROFIT', ctx);
      continue;
    }
  }

  // 일일 PnL 업데이트
  const dailyPnl = await ctx.tradeStore.getTodayPnl();
  ctx.healthMonitor.updateDailyPnl(dailyPnl);
}

async function closeTrade(
  trade: Trade,
  reason: CloseReason,
  ctx: BotContext
): Promise<void> {
  try {
    // 토큰 잔고 조회 후 매도 실행
    const tokenBalance = await ctx.executor.getTokenBalance(trade.pairAddress);

    let txSignature: string | undefined;
    let exitPrice = trade.entryPrice;

    if (tokenBalance > 0n) {
      txSignature = await ctx.executor.executeSell(trade.pairAddress, tokenBalance);

      // 매도 후 실제 체결가 추정 (SOL 잔고 변화 기반)
      const balanceAfter = await ctx.executor.getBalance();
      const soldValue = Number(tokenBalance) * trade.entryPrice / trade.quantity;
      exitPrice = soldValue / Number(tokenBalance) || trade.entryPrice;
    } else {
      log.warn(`No token balance for trade ${trade.id} — closing with entry price`);
    }

    const pnl = (exitPrice - trade.entryPrice) * trade.quantity;
    const slippage = trade.entryPrice > 0
      ? Math.abs(exitPrice - trade.entryPrice) / trade.entryPrice
      : 0;

    await ctx.tradeStore.closeTrade(trade.id, exitPrice, pnl, slippage);

    const closedTrade = { ...trade, exitPrice, pnl, slippage, status: 'CLOSED' as const };
    await ctx.notifier.sendTradeClose(closedTrade);

    log.info(`Trade ${trade.id} closed (${reason}). PnL: ${pnl.toFixed(6)} SOL`);
  } catch (error) {
    log.error(`Failed to close trade ${trade.id}: ${error}`);
    await ctx.tradeStore.failTrade(trade.id, `Close failed: ${error}`);
    await ctx.notifier.sendError('trade_close', error).catch(() => {});
  }
}

// ─── Entry Point ─────────────────────────────────────────
main().catch((error) => {
  log.error(`Fatal error: ${error}`);
  process.exit(1);
});
