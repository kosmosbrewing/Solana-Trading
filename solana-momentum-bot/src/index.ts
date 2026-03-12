import { config } from './utils/config';
import { createModuleLogger } from './utils/logger';
import { HealthMonitor } from './utils/healthMonitor';
import { Candle, Signal, Order } from './utils/types';

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

// ─── Mode ─────────────────────────────────────────────
// P2 = paper trading (시그널만, 실행 안함)
// P3 = live trading (실제 스왑 실행)
const TRADING_MODE: 'paper' | 'live' = (process.env.TRADING_MODE as 'paper' | 'live') || 'paper';

async function main() {
  log.info(`=== Solana Momentum Bot starting (mode: ${TRADING_MODE}) ===`);

  // ─── Initialize stores ──────────────────────────────
  const candleStore = new CandleStore(config.databaseUrl);
  const tradeStore = new TradeStore(config.databaseUrl);
  await candleStore.initialize();
  await tradeStore.initialize();
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
      pollIntervalMs: config.defaultTimeframe * 1000, // 캔들 주기와 동일
    },
  ];

  const ingester = new Ingester(birdeyeClient, candleStore, ingesterConfigs);

  // ─── Candle event handler ───────────────────────────
  ingester.on('newCandle', async (candle: Candle) => {
    healthMonitor.updateCandleTime();

    try {
      await handleNewCandle(
        candle,
        candleStore,
        tradeStore,
        riskManager,
        executor,
        notifier,
        healthMonitor
      );
    } catch (error) {
      log.error(`Error processing candle: ${error}`);
      await notifier.sendError('candle_processing', error);
    }
  });

  ingester.on('error', async ({ pairAddress, error }) => {
    log.error(`Ingester error for ${pairAddress}: ${error}`);
    await notifier.sendError('ingester', error);
  });

  // ─── Position monitor (SL/TP/Time Stop) ─────────────
  const positionCheckInterval = setInterval(async () => {
    try {
      await checkOpenPositions(tradeStore, executor, notifier, healthMonitor, candleStore);
    } catch (error) {
      log.error(`Position check error: ${error}`);
    }
  }, 10000); // 10초마다 체크

  // ─── Start ingester ─────────────────────────────────
  await ingester.start();
  log.info('Bot is running. Press Ctrl+C to stop.');

  // ─── Graceful shutdown ──────────────────────────────
  const shutdown = async () => {
    log.info('Shutting down...');
    clearInterval(positionCheckInterval);
    await ingester.stop();
    healthMonitor.stop();
    await candleStore.close();
    await tradeStore.close();
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ─── Core Logic ──────────────────────────────────────────

async function handleNewCandle(
  candle: Candle,
  candleStore: CandleStore,
  tradeStore: TradeStore,
  riskManager: RiskManager,
  executor: Executor,
  notifier: Notifier,
  healthMonitor: HealthMonitor
): Promise<void> {
  // 최근 캔들 가져오기
  const candles = await candleStore.getRecentCandles(
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
      await processSignal(signal, candles, 'volume_spike', riskManager, executor, tradeStore, notifier, healthMonitor);
    }
  }

  // Strategy B: Pump Detection (1분봉)
  if (candle.intervalSec === 60) {
    const signal = evaluatePumpDetection(candles, {
      consecutiveCandles: config.pumpConsecutiveCandles,
      minPriceMove: config.pumpMinPriceMove,
    });

    if (signal.action === 'BUY') {
      await processSignal(signal, candles, 'pump_detect', riskManager, executor, tradeStore, notifier, healthMonitor);
    }
  }
}

async function processSignal(
  signal: Signal,
  candles: Candle[],
  strategy: 'volume_spike' | 'pump_detect',
  riskManager: RiskManager,
  executor: Executor,
  tradeStore: TradeStore,
  notifier: Notifier,
  healthMonitor: HealthMonitor
): Promise<void> {
  log.info(`Signal: ${signal.action} from ${strategy} at ${signal.price}`);
  await notifier.sendSignal(signal);

  // 잔고 조회
  const balanceSol = await executor.getBalance();
  const portfolio = await riskManager.getPortfolioState(balanceSol, signal.price);

  // 리스크 체크
  const riskResult = await riskManager.checkOrder(
    { pairAddress: signal.pairAddress, strategy, side: 'BUY', price: signal.price, quantity: 0, stopLoss: 0, takeProfit1: 0, takeProfit2: 0, timeStopMinutes: 0 },
    portfolio
  );

  if (!riskResult.approved) {
    log.warn(`Order rejected by risk manager: ${riskResult.reason}`);
    return;
  }

  // 주문 생성
  const quantity = riskResult.adjustedQuantity || 0;
  const order: Order = strategy === 'volume_spike'
    ? buildVolumeSpikeOrder(signal, candles, quantity)
    : buildPumpOrder(signal, candles, quantity);

  if (TRADING_MODE === 'paper') {
    log.info(`[PAPER] Would execute: ${JSON.stringify(order)}`);
    await notifier.sendTradeOpen(order, 'PAPER_TRADE');
    return;
  }

  // Live execution
  try {
    const txSignature = await executor.executeBuy(order);

    const timeStopAt = new Date(Date.now() + order.timeStopMinutes * 60 * 1000);
    await tradeStore.insertTrade({
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

    healthMonitor.updateTradeTime();
    await notifier.sendTradeOpen(order, txSignature);
    log.info(`Trade opened: ${txSignature}`);
  } catch (error) {
    log.error(`Trade execution failed: ${error}`);
    await notifier.sendError('trade_execution', error);
  }
}

/**
 * 열린 포지션 모니터링 (SL/TP/Time Stop)
 */
async function checkOpenPositions(
  tradeStore: TradeStore,
  executor: Executor,
  notifier: Notifier,
  healthMonitor: HealthMonitor,
  candleStore: CandleStore
): Promise<void> {
  if (TRADING_MODE === 'paper') return;

  const openTrades = await tradeStore.getOpenTrades();
  healthMonitor.updatePositions(openTrades.length);

  for (const trade of openTrades) {
    const now = new Date();

    // Time Stop 체크
    if (now >= trade.timeStopAt) {
      log.info(`Time stop triggered for trade ${trade.id}`);
      await closeTrade(trade, 'TIME_STOP', executor, tradeStore, notifier);
      continue;
    }

    // 현재 가격 조회 (최신 캔들에서)
    const recentCandles = await candleStore.getRecentCandles(
      trade.pairAddress,
      300,
      1
    );
    if (recentCandles.length === 0) continue;

    const currentPrice = recentCandles[recentCandles.length - 1].close;

    // Stop Loss 체크
    if (currentPrice <= trade.stopLoss) {
      log.info(`Stop loss triggered for trade ${trade.id} at ${currentPrice}`);
      await closeTrade(trade, 'STOP_LOSS', executor, tradeStore, notifier);
      continue;
    }

    // Take Profit 1 체크 (50% 청산 — 간소화: 전량 청산)
    if (currentPrice >= trade.takeProfit1) {
      log.info(`Take profit 1 triggered for trade ${trade.id} at ${currentPrice}`);
      await closeTrade(trade, 'TAKE_PROFIT', executor, tradeStore, notifier);
      continue;
    }

    // Trailing Stop 체크
    if (trade.trailingStop) {
      const trailingStopPrice = currentPrice - trade.trailingStop;
      if (currentPrice > trade.entryPrice && trailingStopPrice > trade.stopLoss) {
        // 트레일링 스탑 갱신 (DB 업데이트는 생략 — 메모리 기반)
      }
    }
  }

  // 일일 PnL 업데이트
  const dailyPnl = await tradeStore.getTodayPnl();
  healthMonitor.updateDailyPnl(dailyPnl);
}

async function closeTrade(
  trade: import('./utils/types').Trade,
  reason: string,
  executor: Executor,
  tradeStore: TradeStore,
  notifier: Notifier
): Promise<void> {
  try {
    // TODO: 실제 매도 실행 — 토큰 잔고 조회 후 executeSell 호출 필요
    // const txSignature = await executor.executeSell(tokenMint, amount);

    const exitPrice = trade.entryPrice; // placeholder — 실제 체결가로 대체 필요
    const pnl = (exitPrice - trade.entryPrice) * trade.quantity;
    const slippage = 0;

    await tradeStore.closeTrade(trade.id, exitPrice, pnl, slippage);

    const closedTrade = { ...trade, exitPrice, pnl, slippage, status: 'CLOSED' as const };
    await notifier.sendTradeClose(closedTrade);

    log.info(`Trade ${trade.id} closed (${reason}). PnL: ${pnl.toFixed(6)} SOL`);
  } catch (error) {
    log.error(`Failed to close trade ${trade.id}: ${error}`);
    await tradeStore.failTrade(trade.id, `Close failed: ${error}`);
    await notifier.sendError('trade_close', error);
  }
}

// ─── Entry Point ─────────────────────────────────────────
main().catch((error) => {
  log.error(`Fatal error: ${error}`);
  process.exit(1);
});
