import { Pool } from 'pg';
import { config } from './utils/config';
import { createModuleLogger } from './utils/logger';
import { HealthMonitor } from './utils/healthMonitor';
import { Candle } from './utils/types';

import { BirdeyeClient, Ingester, IngesterConfig } from './ingester';
import { BirdeyeWSClient } from './ingester/birdeyeWSClient';
import { EventMonitor } from './event';
import { CandleStore, TradeStore } from './candle';
import { RiskManager, RiskConfig, RegimeFilter } from './risk';
import { PaperMetricsTracker } from './reporting';
import { Executor, ExecutorConfig } from './executor';
import { Notifier } from './notifier';
import { UniverseEngine, UniverseEngineConfig } from './universe';
import { ScannerEngine, ScannerEngineConfig, DexScreenerClient } from './scanner';
import { ExecutionLock, PositionStore, runRecovery } from './state';
import { SignalAuditLogger } from './audit';
import { scheduleDailySummary } from './orchestration/reporting';
import { handleNewCandle } from './orchestration/candleHandler';
import { checkOpenPositions, closeTrade } from './orchestration/tradeExecution';
import { BotContext } from './orchestration/types';

const log = createModuleLogger('Main');

async function main() {
  const tradingMode = config.tradingMode;
  log.info(`=== Solana Momentum Bot v0.4 starting (mode: ${tradingMode}) ===`);

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
    minAttentionScore: config.eventMinScore,
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

  // ─── Phase 1B: Regime Filter + Paper Metrics ────────
  const regimeFilter = new RegimeFilter();
  const paperMetrics = new PaperMetricsTracker();

  const healthMonitor = new HealthMonitor();
  healthMonitor.setDbConnected(true);
  healthMonitor.start();

  // ─── Execution Lock (v0.3) ─────────────────────────
  const executionLock = new ExecutionLock(async () => {
    await notifier.sendWarning('ExecutionLock', 'Lock timeout — auto released');
  });

  // ─── Phase 1A: Birdeye WebSocket ──────────────────
  let birdeyeWS: BirdeyeWSClient | null = null;
  if (config.birdeyeWSEnabled) {
    birdeyeWS = new BirdeyeWSClient({
      apiKey: config.birdeyeApiKey,
    });
    birdeyeWS.on('connected', () => {
      log.info('Birdeye WS connected');
      healthMonitor.setWsConnected(true);
    });
    birdeyeWS.on('disconnected', () => {
      healthMonitor.setWsConnected(false);
    });
    birdeyeWS.on('error', (err: Error) => {
      log.error(`Birdeye WS error: ${err.message}`);
    });
    log.info('Birdeye WebSocket client initialized');
  }

  // ─── Phase 1A: DexScreener Client ─────────────────
  let dexScreenerClient: DexScreenerClient | null = null;
  if (config.dexScreenerApiKey) {
    dexScreenerClient = new DexScreenerClient(config.dexScreenerApiKey);
    log.info('DexScreener client initialized');
  }

  // ─── Phase 1A: Scanner Engine ─────────────────────
  let scanner: ScannerEngine | null = null;
  if (config.scannerEnabled) {
    const scannerConfig: ScannerEngineConfig = {
      birdeyeClient,
      birdeyeWS,
      dexScreenerClient,
      maxWatchlistSize: config.maxWatchlistSize,
      minWatchlistScore: config.scannerMinWatchlistScore,
      trendingPollIntervalMs: config.scannerTrendingPollMs,
      dexEnrichIntervalMs: config.scannerDexEnrichMs,
      laneAMinAgeSec: config.scannerLaneAMinAgeSec,
      laneBMaxAgeSec: config.scannerLaneBMaxAgeSec,
      minLiquidityUsd: config.eventMinLiquidityUsd,
    };
    scanner = new ScannerEngine(scannerConfig);
    scanner.on('candidateDiscovered', (entry) => {
      log.info(`Scanner: new candidate ${entry.symbol} lane=${entry.lane} score=${entry.watchlistScore.totalScore}`);
    });
    scanner.on('candidateEvicted', (tokenMint: string) => {
      log.info(`Scanner: evicted ${tokenMint}`);
    });
    log.info('Scanner engine initialized');
  }

  // ─── Universe Engine ───────────────────────────────
  // Legacy mode: TARGET_PAIR_ADDRESS, Scanner mode: 동적 watchlist
  const targetPair = process.env.TARGET_PAIR_ADDRESS;
  if (!targetPair && !config.scannerEnabled) {
    log.error('TARGET_PAIR_ADDRESS not set and SCANNER_ENABLED is false. Exiting.');
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
    poolAddresses: targetPair ? [targetPair] : [],
  };

  const universeEngine = new UniverseEngine(birdeyeClient, universeConfig);

  eventMonitor.on('events', (scores) => {
    for (const score of scores) {
      log.info(JSON.stringify({
        type: 'attention_score',
        ...score,
      }));
    }
  });

  eventMonitor.on('error', async (error: unknown) => {
    await notifier.sendError('event_monitor', error).catch(() => {});
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
    eventMonitor,
    executionLock,
    positionStore,
    auditLogger,
    previousTvl: new Map(),
    tradingHaltedReason: undefined,
    scanner: scanner ?? undefined,
    birdeyeClient,
    birdeyeWS: birdeyeWS ?? undefined,
    regimeFilter,
    paperMetrics,
  };

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
  const ingesterConfigs: IngesterConfig[] = [];
  if (targetPair) {
    ingesterConfigs.push({
      pairAddress: targetPair,
      intervalType: config.defaultTimeframe === 60 ? '1m' : '5m',
      pollIntervalMs: config.defaultTimeframe * 1000,
    });
  }

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
  const positionCheckInterval = setInterval(async () => {
    try {
      await checkOpenPositions(ctx);
    } catch (error) {
      log.error(`Position check error: ${error}`);
      await notifier.sendError('position_check', error).catch(() => {});
    }
  }, 5000);

  // ─── Phase 1B: Regime Filter periodic update ───────
  const SOL_USDC_PAIR = 'So11111111111111111111111111111111111111112';
  const REGIME_UPDATE_INTERVAL_MS = 15 * 60 * 1000; // 15 min

  const updateRegime = async () => {
    try {
      // Factor 1: SOL 4H trend from Birdeye (60 candles × 4h = 10 days)
      const now = Math.floor(Date.now() / 1000);
      const tenDaysAgo = now - 60 * 4 * 3600;
      const sol4hCandles = await birdeyeClient.getOHLCV(SOL_USDC_PAIR, '4H', tenDaysAgo, now);
      if (sol4hCandles.length >= 50) {
        regimeFilter.updateSolTrend(sol4hCandles);
      }

      // Factor 2+3: breadth & follow-through from paper metrics
      const summary = paperMetrics.getSummary(48);
      if (summary.totalTrades > 0) {
        // Breadth: win rate as proxy for watchlist health
        regimeFilter.updateBreadth(summary.wins, summary.totalTrades);
        // Follow-through: TP1 hit rate
        const tp1Hits = Math.round(summary.tp1HitRate * summary.totalTrades);
        regimeFilter.updateFollowThrough(tp1Hits, summary.totalTrades);
      }

      const state = regimeFilter.getState();
      log.info(
        `Regime: ${state.regime} (size=${state.sizeMultiplier}x) ` +
        `SOL=${state.solTrendBullish ? 'bull' : 'bear'} ` +
        `breadth=${(state.breadthPct * 100).toFixed(0)}% ` +
        `follow=${(state.followThroughPct * 100).toFixed(0)}%`
      );
    } catch (error) {
      log.warn(`Regime update failed: ${error}`);
    }
  };

  // Initial update + schedule
  await updateRegime();
  const regimeInterval = setInterval(updateRegime, REGIME_UPDATE_INTERVAL_MS);

  // ─── Start services ───────────────────────────────
  await eventMonitor.start();
  await universeEngine.start();

  // Phase 1A: Start scanner + WS
  if (birdeyeWS) {
    birdeyeWS.start();
    log.info('Birdeye WebSocket started');
  }
  if (scanner) {
    // If TARGET_PAIR_ADDRESS is set, add it as manual entry for backward compatibility
    if (targetPair) {
      scanner.addManualEntry(targetPair, targetPair, 'LEGACY_TARGET');
    }
    await scanner.start();
    log.info(`Scanner started. Watchlist: ${scanner.getWatchlist().length} entries.`);
  }

  // ─── Start ingester ─────────────────────────────────
  if (ingesterConfigs.length > 0) {
    await ingester.start();
  }
  log.info('Bot is running. Press Ctrl+C to stop.');

  await notifier.sendInfo('Bot started (v0.4 — Phase 1A Scanner)');

  // ─── Daily summary scheduler ────────────────────────
  scheduleDailySummary(ctx);

  // ─── Graceful shutdown ──────────────────────────────
  const shutdown = async () => {
    log.info('Shutting down...');
    clearInterval(positionCheckInterval);
    clearInterval(regimeInterval);
    await ingester.stop();
    eventMonitor.stop();
    universeEngine.stop();
    if (scanner) scanner.stop();
    if (birdeyeWS) birdeyeWS.stop();
    executionLock.destroy();
    healthMonitor.stop();
    await dbPool.end();
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ─── Entry Point ─────────────────────────────────────────
main().catch((error) => {
  log.error(`Fatal error: ${error}`);
  process.exit(1);
});
