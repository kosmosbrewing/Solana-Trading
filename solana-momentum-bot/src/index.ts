import { Pool } from 'pg';
import { config } from './utils/config';
import { createModuleLogger } from './utils/logger';
import { HealthMonitor } from './utils/healthMonitor';
import { Candle } from './utils/types';

import { GeckoTerminalClient, BirdeyeClient, Ingester, IngesterConfig } from './ingester';
import { BirdeyeWSClient } from './ingester/birdeyeWSClient';
import { EventMonitor, EventScoreStore } from './event';
import { CandleStore, TradeStore } from './candle';
import { RiskManager, RiskConfig, RegimeFilter } from './risk';
import { PaperMetricsTracker, RealtimeOutcomeTracker, RealtimeSignalLogger } from './reporting';
import { Executor, ExecutorConfig, WalletManager } from './executor';
import { Notifier } from './notifier';
import {
  HeliusWSIngester,
  MicroCandleBuilder,
  RealtimeAdmissionTracker,
  RealtimeAdmissionStore,
  RealtimePoolOwnerResolver,
  RealtimeReplayStore,
  selectRealtimeEligiblePair,
  type RealtimePoolMetadata,
} from './realtime';
import { UniverseEngine, UniverseEngineConfig } from './universe';
import { ScannerEngine, ScannerEngineConfig, DexScreenerClient, SocialMentionTracker } from './scanner';
import { ExecutionLock, PositionStore, runRecovery } from './state';
import { SignalAuditLogger } from './audit';
import { scheduleDailySummary } from './orchestration/reporting';
import { handleNewCandle } from './orchestration/candleHandler';
import { handleRealtimeSignal } from './orchestration/realtimeHandler';
import { evaluateNewLpSniper, buildNewLpOrder, prepareNewLpCandidate } from './strategy/newLpSniper';
import { MomentumTrigger } from './strategy';
import { checkOpenPositions, closeTrade } from './orchestration/tradeExecution';
import { runPreflightCheck } from './orchestration/preflightCheck';
import { SpreadMeasurer } from './gate/spreadMeasurer';
import { SOL_MINT } from './utils/constants';
import { BotContext } from './orchestration/types';
import path from 'path';

const log = createModuleLogger('Main');
const SCANNER_INGESTER_QUEUE_GAP_MS = 10_000;
const REGIME_SOL_CACHE_TTL_MS = 60 * 60 * 1000;
const REALTIME_ADMISSION_MIN_OBSERVED = 50;
const REALTIME_ADMISSION_MIN_PARSE_RATE_PCT = 1;
const REALTIME_ADMISSION_MIN_SKIPPED_RATE_PCT = 90;
function buildHeliusWsUrl(): string {
  if (config.heliusWsUrl) return config.heliusWsUrl;
  if (config.solanaRpcUrl.startsWith('https://')) {
    return `wss://${config.solanaRpcUrl.slice('https://'.length)}`;
  }
  if (config.solanaRpcUrl.startsWith('http://')) {
    return `ws://${config.solanaRpcUrl.slice('http://'.length)}`;
  }
  return config.solanaRpcUrl;
}

async function main() {
  const tradingMode = config.tradingMode;
  log.info(`=== Solana Momentum Bot v0.5 starting (mode: ${tradingMode}) ===`);
  const realtimePoolTargets = new Map<string, string>();
  const realtimePoolAliases = new Map<string, string>();
  const realtimePoolMetadata = new Map<string, RealtimePoolMetadata>();
  const realtimeModeEnabled = config.realtimeEnabled;
  const realtimePoolOwnerResolver = realtimeModeEnabled
    ? new RealtimePoolOwnerResolver(config.solanaRpcUrl)
    : null;
  const realtimeAdmissionTracker = realtimeModeEnabled
    ? new RealtimeAdmissionTracker({
      minObservedNotifications: REALTIME_ADMISSION_MIN_OBSERVED,
      minParseRatePct: REALTIME_ADMISSION_MIN_PARSE_RATE_PCT,
      minSkippedRatePct: REALTIME_ADMISSION_MIN_SKIPPED_RATE_PCT,
    })
    : null;
  const realtimeAdmissionStore = realtimeModeEnabled
    ? new RealtimeAdmissionStore(path.resolve(process.cwd(), 'data/realtime-admission.json'))
    : null;
  let heliusIngester: HeliusWSIngester | null = null;
  let realtimeCandleBuilder: MicroCandleBuilder | null = null;
  const realtimeReplayStore = realtimeModeEnabled && config.realtimePersistenceEnabled
    ? new RealtimeReplayStore(path.resolve(config.realtimeDataDir))
    : null;
  const realtimeSignalLogger = realtimeReplayStore
    ? new RealtimeSignalLogger(realtimeReplayStore)
    : null;
  const realtimeOutcomeTracker = realtimeSignalLogger
    ? new RealtimeOutcomeTracker({
      horizonsSec: config.realtimeOutcomeHorizonsSec,
      observationIntervalSec: 5,
    }, realtimeSignalLogger)
    : null;

  const setRealtimePoolTarget = (logicalPair: string, subscriptionPair: string) => {
    realtimePoolTargets.set(logicalPair, subscriptionPair);
    realtimePoolAliases.set(subscriptionPair, logicalPair);
  };
  const setRealtimePoolMetadata = (subscriptionPair: string, metadata: RealtimePoolMetadata) => {
    realtimePoolMetadata.set(subscriptionPair, metadata);
  };
  const removeRealtimePoolTarget = (logicalPair: string) => {
    const existing = realtimePoolTargets.get(logicalPair);
    realtimePoolTargets.delete(logicalPair);
    if (existing) {
      realtimePoolAliases.delete(existing);
      realtimePoolMetadata.delete(existing);
      heliusIngester?.clearPoolMetadata(existing);
    }
  };
  const resolveRealtimePools = (logicalPairs: string[]) =>
    logicalPairs
      .map((pair) => realtimePoolTargets.get(pair))
      .filter((pair): pair is string => Boolean(pair));

  // ─── 공유 DB Pool ─────────────────────────────────
  // M-20: pool exhaustion 방지 — max connections 제한 + idle timeout
  const dbPool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  dbPool.on('error', (err) => {
    log.error(`DB pool error: ${err.message}`);
  });

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
  // Phase 2: EventScore persistence (C-1)
  const eventScoreStore = new EventScoreStore(dbPool);
  await eventScoreStore.initialize();
  log.info('Database initialized');

  // ─── Phase 2: Pre-flight check (live mode gate) ────
  let effectiveMode = tradingMode;
  if (tradingMode === 'live') {
    try {
      const preflight = await runPreflightCheck(dbPool, {
        tradingMode,
        enforceGate: config.preflightEnforceGate,
      });
      if (!preflight.passed && config.preflightEnforceGate) {
        log.warn('Falling back to paper mode — pre-flight criteria not met');
        effectiveMode = 'paper';
        await new Notifier(config.telegramBotToken, config.telegramChatId)
          .sendWarning('PreFlight', `Live mode blocked: ${preflight.reasons.join(', ')}`);
      }
    } catch (err) {
      // H-27: DB query 실패 시 안전하게 paper mode fallback (live 진입 차단)
      log.error(`Pre-flight DB query failed: ${err}. Falling back to paper mode.`);
      effectiveMode = 'paper';
      await new Notifier(config.telegramBotToken, config.telegramChatId)
        .sendWarning('PreFlight', `DB query failed — forced paper mode`);
    }
  }

  // ─── Initialize modules ─────────────────────────────
  const geckoClient = new GeckoTerminalClient();
  // Why: Birdeye optional — Security Gate + Strategy D only (live mode)
  const birdeyeClient = config.birdeyeApiKey ? new BirdeyeClient(config.birdeyeApiKey) : null;
  const eventMonitor = new EventMonitor(geckoClient, {
    pollingIntervalMs: config.eventPollingIntervalMs,
    minAttentionScore: config.eventMinScore,
    fetchLimit: config.eventTrendingFetchLimit,
    expiryMinutes: config.eventExpiryMinutes,
    minLiquidityUsd: config.eventMinLiquidityUsd,
  });
  // Phase 2: Attach persistent store for historical replay (C-1)
  eventMonitor.setScoreStore(eventScoreStore);

  // Phase 2: Social mention tracker (C-2)
  const socialMentionTracker = new SocialMentionTracker({
    twitterBearerToken: config.twitterBearerToken,
    influencerMinFollowers: config.socialInfluencerMinFollowers,
  });
  if (realtimeAdmissionTracker && realtimeAdmissionStore) {
    const snapshot = await realtimeAdmissionStore.load();
    realtimeAdmissionTracker.importSnapshot(snapshot);
    if (snapshot.length > 0) {
      log.info(`Loaded realtime admission snapshot: ${snapshot.length} pools`);
    }
  }

  // Phase 2: Jupiter quote-based spread/fee measurer (H-2/H-3)
  const spreadMeasurer = new SpreadMeasurer({
    jupiterApiUrl: config.jupiterApiUrl,
    jupiterApiKey: config.jupiterApiKey || undefined,
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
    runnerConcurrentEnabled: config.runnerConcurrentEnabled,
    maxConcurrentPositions: config.maxConcurrentPositions,
    // v4: 설정 가능화 파라미터
    maxPositionPct: config.maxPositionPct,
    maxConcurrentAbsolute: config.maxConcurrentAbsolute,
    concurrentTier1Sol: config.concurrentTier1Sol,
    concurrentTier2Sol: config.concurrentTier2Sol,
    impactTier1Sol: config.impactTier1Sol,
    impactTier1MaxImpact: config.impactTier1MaxImpact,
    impactTier2Sol: config.impactTier2Sol,
    impactTier2MaxImpact: config.impactTier2MaxImpact,
  };
  const riskManager = new RiskManager(riskConfig, tradeStore);

  const executorConfig: ExecutorConfig = {
    solanaRpcUrl: config.solanaRpcUrl,
    walletPrivateKey: config.walletPrivateKey,
    jupiterApiUrl: config.jupiterApiUrl,
    maxSlippage: config.maxSlippage,
    maxRetries: config.maxRetries,
    txTimeoutMs: config.txTimeoutMs,
    useJitoBundles: config.useJitoBundles,
    jitoRpcUrl: config.jitoRpcUrl,
    jitoTipSol: config.jitoTipSol,
    useJupiterUltra: config.useJupiterUltra,
    jupiterUltraApiUrl: config.jupiterUltraApiUrl,
    jupiterApiKey: config.jupiterApiKey,
  };
  const executor = new Executor(executorConfig);

  const notifier = new Notifier(config.telegramBotToken, config.telegramChatId);

  // ─── Phase 3: Wallet Manager (main + sandbox isolation) ───
  const walletManager = new WalletManager({
    solanaRpcUrl: config.solanaRpcUrl,
    mainWalletKey: config.walletPrivateKey,
    sandboxWalletKey: config.sandboxWalletKey || undefined,
    sandboxDailyLossLimitSol: config.sandboxDailyLossLimitSol,
    sandboxMaxPositionSol: config.sandboxMaxPositionSol,
  }, dbPool);
  await walletManager.initDailyPnlStore();

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

  // ─── Phase 1A: Birdeye WebSocket (requires API key) ──
  let birdeyeWS: BirdeyeWSClient | null = null;
  if (config.birdeyeWSEnabled && config.birdeyeApiKey) {
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
    // H-05: Strategy D — New LP Sniper event handler
    if (config.strategyDEnabled && walletManager.hasSandboxWallet() && birdeyeClient) {
      birdeyeWS.on('newListing', async (update: { address: string; symbol?: string; liquidity?: number; liquidityAddedAt?: number }) => {
        if (!update.address || !birdeyeClient) return;
        try {
          const strategyDParams = {
            ticketSizeSol: config.strategyDTicketSol,
            minAgeMinutes: config.strategyDMinAge,
            maxAgeMinutes: config.strategyDMaxAge,
            takeProfitMultiplier: config.strategyDTpMultiplier,
          };
          const prepared = await prepareNewLpCandidate(update, {
            getTokenSecurityDetailed: (tokenMint) => birdeyeClient!.getTokenSecurityDetailed(tokenMint),
            getExitLiquidity: (tokenMint) => birdeyeClient!.getExitLiquidity(tokenMint),
            getTokenOverview: (tokenMint) => birdeyeClient!.getTokenOverview(tokenMint),
          }, {
            params: strategyDParams,
            securityGate: {
              minExitLiquidityUsd: config.minExitLiquidityUsd,
            },
            quoteGate: {
              jupiterApiUrl: config.jupiterApiUrl,
              jupiterApiKey: config.jupiterApiKey || undefined,
            },
          });

          if (!prepared.candidate) {
            log.debug(
              `Strategy D skipped ${update.symbol ?? update.address}: ${prepared.rejectionReason ?? 'unknown'}`
            );
            return;
          }

          const signal = evaluateNewLpSniper(prepared.candidate, strategyDParams);
          if (signal.action !== 'BUY') return;

          const walletLimit = walletManager.checkTradeLimits('new_lp_sniper', signal.meta.ticketSizeSol * signal.price);
          if (!walletLimit.allowed) {
            log.info(`Strategy D blocked: ${walletLimit.reason}`);
            return;
          }

          const order = buildNewLpOrder(signal, strategyDParams);
          log.info(
            `Strategy D signal: ${prepared.candidate.tokenSymbol} ticket=${order.quantity} SOL ` +
            `impact=${((prepared.quoteGate?.priceImpactPct ?? 0) * 100).toFixed(2)}%`
          );

          if (effectiveMode === 'paper') {
            log.info(`[PAPER] Strategy D: ${JSON.stringify(order)}`);
          }
          // Live execution은 Jito bundle + sandbox wallet 통합 후 활성화
        } catch (err) {
          log.warn(`Strategy D evaluation failed: ${err}`);
        }
      });
    }

    log.info('Birdeye WebSocket client initialized');
  }

  // ─── DexScreener Client (free — API key optional) ─────
  const dexScreenerClient = new DexScreenerClient(config.dexScreenerApiKey || undefined);
  log.info('DexScreener client initialized');

  // ─── Phase 1A: Scanner Engine ─────────────────────
  let scanner: ScannerEngine | null = null;
  if (config.scannerEnabled) {
    const scannerConfig: ScannerEngineConfig = {
      geckoClient,
      birdeyeWS,
      dexScreenerClient,
      maxWatchlistSize: config.maxWatchlistSize,
      minWatchlistScore: config.scannerMinWatchlistScore,
      trendingPollIntervalMs: config.scannerTrendingPollMs,
      dexEnrichIntervalMs: config.scannerDexEnrichMs,
      laneAMinAgeSec: config.scannerLaneAMinAgeSec,
      laneBMaxAgeSec: config.scannerLaneBMaxAgeSec,
      reentryCooldownMs: config.scannerReentryCooldownMs,
      // Why: Scanner minLiquidity는 SafetyGate minPoolLiquidity 이상이어야 함 (config gap 방지)
      minLiquidityUsd: Math.max(config.eventMinLiquidityUsd, config.minPoolLiquidity),
      socialMentionTracker, // H-02: social score → WatchlistScore 연동
    };
    scanner = new ScannerEngine(scannerConfig);
    // Bridge: Scanner → Ingester + UniverseEngine (rate limit 방지 큐)
    const ingesterQueue: import('./scanner').WatchlistEntry[] = [];
    let ingesterQueueRunning = false;

    const processIngesterQueue = async () => {
      if (ingesterQueueRunning) return;
      ingesterQueueRunning = true;
      while (ingesterQueue.length > 0) {
        const entry = ingesterQueue.shift()!;
        try {
          // Why: GeckoTerminal OHLCV는 pool address 필요 (token mint ≠ pool address)
          // DexScreener pair 목록에서 최고 유동성 pair를 선택
          const pairs = await dexScreenerClient.getTokenPairs(entry.tokenMint);
          pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
          const bestPair = pairs[0];
          const poolAddress = bestPair?.pairAddress;
          if (!poolAddress) {
            log.warn(`No pool found for ${entry.symbol} (${entry.tokenMint}), skipping ingester`);
            continue;
          }

          const poolOwners = realtimeModeEnabled && realtimePoolOwnerResolver
            ? await realtimePoolOwnerResolver.resolveOwners(pairs.map((pair) => pair.pairAddress))
            : undefined;
          const admissionPairs = realtimeAdmissionTracker
            ? pairs.filter((pair) => !realtimeAdmissionTracker.isBlocked(pair.pairAddress))
            : pairs;
          const realtimeEligibility = selectRealtimeEligiblePair(admissionPairs, poolOwners);
          if (realtimeEligibility.eligible && realtimeEligibility.pair) {
            setRealtimePoolTarget(entry.tokenMint, realtimeEligibility.pair.pairAddress);
            setRealtimePoolMetadata(realtimeEligibility.pair.pairAddress, {
              dexId: realtimeEligibility.pair.dexId,
              baseMint: realtimeEligibility.pair.baseToken?.address || entry.tokenMint,
              quoteMint: realtimeEligibility.pair.quoteToken?.address || SOL_MINT,
              quoteDecimals: realtimeEligibility.pair.quoteToken?.address === SOL_MINT ? 9 : undefined,
              poolProgram: poolOwners?.get(realtimeEligibility.pair.pairAddress) ?? undefined,
            });
            heliusIngester?.setPoolMetadata(
              realtimeEligibility.pair.pairAddress,
              realtimePoolMetadata.get(realtimeEligibility.pair.pairAddress)!
            );
          } else {
            removeRealtimePoolTarget(entry.tokenMint);
            if (realtimeModeEnabled) {
              log.info(
                `Realtime skipped for ${entry.symbol} (${entry.tokenMint}) — ${realtimeEligibility.reason}`
              );
            }
          }
          await ingester.addPair({
            pairAddress: entry.tokenMint,  // CandleHandler watchlist matching key
            poolAddress,                   // GeckoTerminal OHLCV query key
            intervalType: config.defaultTimeframe === 60 ? '1m' : '5m',
            pollIntervalMs: config.defaultTimeframe * 1000,
            isTokenMint: true,
          });
          if (heliusIngester) {
            await heliusIngester.subscribePools(
              resolveRealtimePools(universeEngine.getWatchlist().map((pool) => pool.pairAddress))
            );
          }
        } catch (err) {
          log.warn(`Failed to add ingester for ${entry.symbol}: ${err}`);
        }
        // GeckoTerminal rate limit 방지: startup backfill은 더 보수적으로 10초 간격
        if (ingesterQueue.length > 0) {
          await new Promise(r => setTimeout(r, SCANNER_INGESTER_QUEUE_GAP_MS));
        }
      }
      ingesterQueueRunning = false;
    };

    scanner.on('candidateDiscovered', (entry: import('./scanner').WatchlistEntry) => {
      log.info(`Scanner: new candidate ${entry.symbol} lane=${entry.lane} score=${entry.watchlistScore.totalScore}`);

      // UniverseEngine은 즉시 추가 (API 호출 없음)
      universeEngine.addPoolDirect({
        pairAddress: entry.tokenMint,
        tokenMint: entry.tokenMint,
        tvl: entry.poolInfo?.tvl ?? 0,
        marketCap: entry.poolInfo?.marketCap,
        dailyVolume: entry.poolInfo?.dailyVolume ?? 0,
        tradeCount24h: entry.poolInfo?.tradeCount24h ?? 0,
        spreadPct: entry.poolInfo?.spreadPct ?? 0,
        ammFeePct: entry.poolInfo?.ammFeePct,
        tokenAgeHours: entry.poolInfo?.tokenAgeHours ?? 0,
        top10HolderPct: entry.poolInfo?.top10HolderPct ?? 0,
        lpBurned: entry.poolInfo?.lpBurned ?? null,
        ownershipRenounced: entry.poolInfo?.ownershipRenounced ?? null,
        rankScore: entry.watchlistScore.totalScore,
      });

      // Ingester는 큐잉 후 순차 처리 (rate limit 방지)
      ingesterQueue.push(entry);
      processIngesterQueue().catch(err => log.error(`Ingester queue error: ${err}`));
    });
    scanner.on('candidateEvicted', (tokenMint: string) => {
      log.info(`Scanner: evicted ${tokenMint}`);
      removeRealtimePoolTarget(tokenMint);
      ingester.removePair(tokenMint);
      universeEngine.removePool(tokenMint);
    });
    log.info('Scanner engine initialized');
  }

  // ─── Universe Engine ───────────────────────────────
  // Legacy mode: TARGET_PAIR_ADDRESS, Scanner mode: 동적 watchlist
  const targetPair = config.targetPairAddress || undefined;
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

  const universeEngine = new UniverseEngine(geckoClient, universeConfig, dexScreenerClient);
  if (targetPair) {
    setRealtimePoolTarget(targetPair, targetPair);
  }

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
    tradingMode: effectiveMode,
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
    geckoClient,
    birdeyeClient: birdeyeClient ?? undefined,
    birdeyeWS: birdeyeWS ?? undefined,
    regimeFilter,
    paperMetrics,
    socialMentionTracker,
    spreadMeasurer,
    eventScoreStore,
    walletManager,
    realtimeAdmissionTracker: realtimeAdmissionTracker ?? undefined,
    realtimeOutcomeTracker: realtimeOutcomeTracker ?? undefined,
    realtimeSignalLogger: realtimeSignalLogger ?? undefined,
    realtimeReplayStore: realtimeReplayStore ?? undefined,
    // Why: Paper 모드에서 온체인 잔고 대신 시뮬레이션 잔고 (기본 1 SOL)
    paperBalance: effectiveMode === 'paper' ? config.paperInitialBalance : undefined,
  };

  if (realtimeModeEnabled) {
    const realtimeIntervals = [5, config.realtimePrimaryIntervalSec, config.realtimeConfirmIntervalSec];
    heliusIngester = new HeliusWSIngester({
      rpcWsUrl: buildHeliusWsUrl(),
      rpcHttpUrl: config.solanaRpcUrl,
      maxSubscriptions: config.realtimeMaxSubscriptions,
      fallbackConcurrency: config.realtimeFallbackConcurrency,
      fallbackRequestsPerSecond: config.realtimeFallbackRequestsPerSecond,
      fallbackBatchSize: config.realtimeFallbackBatchSize,
      maxFallbackQueue: config.realtimeMaxFallbackQueue,
    });
    for (const [pool, metadata] of realtimePoolMetadata.entries()) {
      heliusIngester.setPoolMetadata(pool, metadata);
    }
    realtimeCandleBuilder = new MicroCandleBuilder({
      intervals: realtimeIntervals,
      maxHistory: 200,
    });
    const trigger = new MomentumTrigger({
      primaryIntervalSec: config.realtimePrimaryIntervalSec,
      confirmIntervalSec: config.realtimeConfirmIntervalSec,
      volumeSurgeLookback: config.realtimeVolumeSurgeLookback,
      volumeSurgeMultiplier: config.realtimeVolumeSurgeMultiplier,
      priceBreakoutLookback: config.realtimePriceBreakoutLookback,
      confirmMinBars: config.realtimeConfirmMinBars,
      confirmMinPriceChangePct: config.realtimeConfirmMinChangePct,
      cooldownSec: config.realtimeCooldownSec,
    });

    ctx.realtimeCandleBuilder = realtimeCandleBuilder;

    heliusIngester.on('connected', () => {
      healthMonitor.setWsConnected(true);
      log.info('Helius real-time pipeline connected');
    });
    heliusIngester.on('disconnected', () => {
      healthMonitor.setWsConnected(false);
    });
    heliusIngester.on('swap', (swap) => {
      const logicalPair = realtimePoolAliases.get(swap.pool) ?? swap.pool;
      if (swap.source === 'logs') {
        realtimeAdmissionTracker?.recordLogParsed(swap.pool);
      } else {
        realtimeAdmissionTracker?.recordFallbackParsed(swap.pool);
      }
      if (realtimeReplayStore) {
        void realtimeReplayStore.appendSwap({
          ...swap,
          pairAddress: logicalPair,
          poolAddress: swap.pool,
          tokenMint: logicalPair,
        }).catch((error) => {
          log.warn(`Failed to persist realtime swap: ${error}`);
        });
      }
      realtimeCandleBuilder!.onSwap({
        ...swap,
        pool: logicalPair,
      });
    });
    heliusIngester.on('parseMiss', ({ pool }: { pool: string }) => {
      realtimeAdmissionTracker?.recordParseMiss(pool);
    });
    heliusIngester.on('fallbackSkipped', ({ pool }: { pool: string }) => {
      realtimeAdmissionTracker?.recordFallbackSkipped(pool);
    });
    realtimeAdmissionTracker?.on('blocked', async ({
      pool,
      stats,
    }: {
      pool: string;
      stats: { observedNotifications: number; logParsed: number; fallbackSkipped: number; parseRatePct: number; skippedRatePct: number };
    }) => {
      const logicalPair = realtimePoolAliases.get(pool);
      log.warn(
        `Realtime admission blocked ${pool} parseRate=${stats.parseRatePct}% skippedRate=${stats.skippedRatePct}% observed=${stats.observedNotifications}`
      );
      if (logicalPair) {
        removeRealtimePoolTarget(logicalPair);
      }
      if (realtimeAdmissionStore) {
        await realtimeAdmissionStore.save(realtimeAdmissionTracker.exportSnapshot());
      }
      await heliusIngester!.subscribePools(
        resolveRealtimePools(universeEngine.getWatchlist().map((entry) => entry.pairAddress))
      );
    });
    heliusIngester.on('error', async ({ pool, error }: { pool: string; error: unknown }) => {
      log.warn(`Helius WS error for ${pool}: ${error}`);
      await notifier.sendError('helius_ws', error).catch(() => {});
    });
    realtimeCandleBuilder.on('candle', async (candle: Candle) => {
      try {
        if (realtimeReplayStore) {
          await realtimeReplayStore.appendCandle({
            ...candle,
            tokenMint: candle.pairAddress,
          });
        }
        await realtimeOutcomeTracker?.onCandle(candle);
        if (candle.intervalSec >= 60) {
          await candleStore.insertCandles([candle]);
        }
        const signal = trigger.onCandle(candle, realtimeCandleBuilder!);
        if (signal) {
          await handleRealtimeSignal(signal, realtimeCandleBuilder!, ctx);
        }
      } catch (error) {
        log.error(`Realtime candle handling failed: ${error}`);
        await notifier.sendError('realtime_candle', error).catch(() => {});
      }
    });
  }

  universeEngine.on('poolEvent', async (event: { type: string; pairAddress: string; detail: string }) => {
    if (event.type === 'RUG_PULL' || event.type === 'LP_DROP') {
      await notifier.sendCritical('Pool Event', `${event.type}: ${event.detail}`);
      // Emergency close if we have a position
      if (effectiveMode === 'live') {
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

  const ingester = new Ingester(geckoClient, candleStore, ingesterConfigs);

  ingester.on('candles', async (candles: Candle[]) => {
    healthMonitor.updateCandleTime();

    if (realtimeModeEnabled) {
      return;
    }

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
  // Why: SOL mint 주소로 /defi/ohlcv 엔드포인트 사용 (getOHLCV는 pair address 전용)
  const REGIME_UPDATE_INTERVAL_MS = 15 * 60 * 1000; // 15 min

  // Why: SOL pool address for RegimeFilter — DexScreener 조회 후 캐시
  let solPoolAddress: string | null = null;
  let cachedSol4hCandles: { bucketStartMs: number; fetchedAtMs: number; closes: { close: number; timestamp: number }[] } | null = null;

  const updateRegime = async () => {
    try {
      // Factor 1: SOL 4H trend from GeckoTerminal (60 candles × 4h = 10 days)
      const now = Math.floor(Date.now() / 1000);
      const tenDaysAgo = now - 60 * 4 * 3600;

      // SOL pool address 조회 (최초 1회만)
      if (!solPoolAddress) {
        solPoolAddress = await dexScreenerClient.getBestPoolAddress(SOL_MINT);
      }

      if (solPoolAddress) {
        const nowMs = Date.now();
        const currentBucketStartMs = Math.floor(nowMs / (4 * 3600_000)) * (4 * 3600_000);
        const useCachedCandles = cachedSol4hCandles
          && cachedSol4hCandles.bucketStartMs === currentBucketStartMs
          && (nowMs - cachedSol4hCandles.fetchedAtMs) < REGIME_SOL_CACHE_TTL_MS;

        if (!useCachedCandles) {
          const sol4hCandles = await geckoClient.getOHLCV(solPoolAddress, '4H', tenDaysAgo, now);
          cachedSol4hCandles = {
            bucketStartMs: currentBucketStartMs,
            fetchedAtMs: nowMs,
            closes: sol4hCandles.map(c => ({
              close: c.close,
              timestamp: Math.floor(c.timestamp.getTime() / 1000),
            })),
          };
        }

        if ((cachedSol4hCandles?.closes.length ?? 0) >= 50) {
          regimeFilter.updateSolTrend(cachedSol4hCandles!.closes);
        }
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

  // ─── Phase 2: Daily EventScore pruning ─────────────
  const pruneInterval = setInterval(async () => {
    try {
      await eventScoreStore.pruneOlderThan(config.eventScoreRetentionDays);
    } catch (error) {
      log.warn(`EventScore pruning failed: ${error}`);
    }
  }, 24 * 3600_000); // daily

  // ─── Start services ───────────────────────────────
  await eventMonitor.start();
  await universeEngine.start();

  if (realtimeModeEnabled && heliusIngester && realtimeCandleBuilder) {
    realtimeCandleBuilder.start();
    await heliusIngester.subscribePools(resolveRealtimePools(
      universeEngine.getWatchlist().map((pool) => pool.pairAddress)
    ));
    universeEngine.on('watchlistUpdated', (pools: { pairAddress: string }[]) => {
      void heliusIngester!.subscribePools(
        resolveRealtimePools(pools.map((pool) => pool.pairAddress))
      );
    });
    log.info('Real-time Helius pipeline started');
  }

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
  // Scanner 모드: 동적 addPair()를 위해 항상 start()
  await ingester.start();
  log.info('Bot is running. Press Ctrl+C to stop.');

  await notifier.sendInfo(`Bot started (v0.5 — Phase 2 Core Live, mode: ${effectiveMode})`);

  // ─── Daily summary scheduler ────────────────────────
  scheduleDailySummary(ctx);

  // ─── Graceful shutdown ──────────────────────────────
  const shutdown = async () => {
    log.info('Shutting down...');
    clearInterval(positionCheckInterval);
    clearInterval(regimeInterval);
    clearInterval(pruneInterval);
    if (realtimeAdmissionTracker && realtimeAdmissionStore) {
      await realtimeAdmissionStore.save(realtimeAdmissionTracker.exportSnapshot()).catch((error) => {
        log.warn(`Failed to persist realtime admission snapshot: ${error}`);
      });
    }
    await ingester.stop();
    eventMonitor.stop();
    universeEngine.stop();
    if (scanner) scanner.stop();
    if (birdeyeWS) birdeyeWS.stop();
    if (realtimeCandleBuilder) realtimeCandleBuilder.stop();
    if (heliusIngester) await heliusIngester.stop();
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
