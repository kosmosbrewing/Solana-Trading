import { Pool } from 'pg';
import { config } from './utils/config';
import { createModuleLogger } from './utils/logger';
import { HealthMonitor } from './utils/healthMonitor';
import { Candle, Signal } from './utils/types';

import {
  GeckoTerminalClient,
  BirdeyeClient,
  Ingester,
  IngesterConfig,
  OnchainSecurityClient,
  attachBirdeyeListingSource,
} from './ingester';
import { BirdeyeWSClient } from './ingester/birdeyeWSClient';
import { EventMonitor, EventScoreStore } from './event';
import {
  CompositeTrendingTokenProvider,
} from './discovery/trendingTokenProvider';
import { InternalTrendingTokenProvider } from './discovery/internalTrendingTokenProvider';
import { CandleStore, InternalCandleSource, TradeStore } from './candle';
import { RiskManager, RiskConfig, RegimeFilter } from './risk';
import {
  EdgeTracker,
  PaperMetricsTracker,
  RealtimeOutcomeTracker,
  RealtimeSignalLogger,
  RuntimeDiagnosticsStore,
  RuntimeDiagnosticsTracker,
} from './reporting';
import { Executor, ExecutorConfig, WalletManager } from './executor';
import { Notifier } from './notifier';
import {
  HeliusPoolDiscovery,
  HeliusWSIngester,
  MicroCandleBuilder,
  ReplayWarmSync,
  RealtimeAdmissionTracker,
  RealtimeAdmissionStore,
  RealtimePoolOwnerResolver,
  RealtimeReplayStore,
  warmReplayCandlesIntoStore,
  classifyRealtimeAdmissionSkip,
  detectRealtimeDiscoveryMismatch,
  detectRealtimePoolProgramMismatch,
  selectRealtimeEligiblePair,
  type RealtimePoolMetadata,
} from './realtime';
import { UniverseEngine, UniverseEngineConfig } from './universe';
import {
  ScannerEngine,
  ScannerEngineConfig,
  CompositeTokenPairResolver,
  DexScreenerClient,
  HeliusPoolRegistry,
  SocialMentionTracker,
  attachScannerFreshListingSource,
  createScannerBlacklistCheck,
} from './scanner';
import { ExecutionLock, PositionStore, runRecovery } from './state';
import { SignalAuditLogger } from './audit';
import { scheduleDailySummary } from './orchestration/reporting';
import { handleNewCandle } from './orchestration/candleHandler';
import { handleRealtimeSignal } from './orchestration/realtimeHandler';
import { evaluateNewLpSniper, buildNewLpOrder, prepareNewLpCandidate } from './strategy/newLpSniper';
import { MomentumTrigger, VolumeMcapSpikeTrigger } from './strategy';
import { checkOpenPositions, closeTrade } from './orchestration/tradeExecution';
import { runPreflightCheck } from './orchestration/preflightCheck';
import { SpreadMeasurer } from './gate/spreadMeasurer';
import { SOL_MINT } from './utils/constants';
import { BotContext } from './orchestration/types';
import { resolveAmmFeePct } from './utils/dexFeeMap';
import { buildRuntimeDriftSnapshot, evaluateRuntimeDriftWarnings } from './ops/runtimeDrift';
import path from 'path';
import { prepareRealtimePersistenceLayout } from './realtime/persistenceLayout';

const log = createModuleLogger('Main');
const SCANNER_INGESTER_QUEUE_GAP_MS = 10_000;
const REGIME_SOL_CACHE_TTL_MS = 60 * 60 * 1000;
const REALTIME_ADMISSION_MIN_OBSERVED = 50;
const REALTIME_ADMISSION_MIN_PARSE_RATE_PCT = 1;
const REALTIME_ADMISSION_MIN_SKIPPED_RATE_PCT = 90;
const REALTIME_TRIGGER_SEED_BUFFER_BARS = 4;
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

function getRealtimeSeedLookbackSec(): number {
  const primaryLookbackBars = Math.max(
    config.realtimeVolumeSurgeLookback,
    config.realtimePriceBreakoutLookback
  ) + 1;
  const primaryLookbackSec =
    (primaryLookbackBars + REALTIME_TRIGGER_SEED_BUFFER_BARS) * config.realtimePrimaryIntervalSec;
  const confirmLookbackSec =
    (config.realtimeConfirmMinBars + 1) * config.realtimeConfirmIntervalSec;
  return Math.max(primaryLookbackSec, confirmLookbackSec);
}

function formatRealtimeEligibilityContext(
  pairs: Array<{ dexId: string; quoteToken?: { address: string; symbol?: string } }>
): string {
  const dexIds = [...new Set(pairs.map((pair) => pair.dexId).filter(Boolean))].slice(0, 3);
  const quoteSymbols = [
    ...new Set(
      pairs
        .map((pair) => pair.quoteToken?.symbol ?? pair.quoteToken?.address)
        .filter((value): value is string => Boolean(value))
    ),
  ].slice(0, 3);
  const parts = [];
  if (dexIds.length > 0) parts.push(`dexId=${dexIds.join('|')}`);
  if (quoteSymbols.length > 0) parts.push(`quote=${quoteSymbols.join('|')}`);
  return parts.join(' ');
}

async function main() {
  const tradingMode = config.tradingMode;
  log.info(`=== Solana Momentum Bot v0.5 starting (mode: ${tradingMode}) ===`);
  const runtimeSnapshot = buildRuntimeDriftSnapshot({
    processName: process.env.name,
    pid: process.pid,
    tradingMode,
    realtimeEnabled: config.realtimeEnabled,
    jupiterApiUrl: config.jupiterApiUrl,
    pm2AllowedProcesses: config.pm2AllowedProcesses,
  });
  log.info(`Runtime snapshot: ${JSON.stringify(runtimeSnapshot)}`);
  for (const warning of evaluateRuntimeDriftWarnings({
    processName: process.env.name,
    pid: process.pid,
    tradingMode,
    realtimeEnabled: config.realtimeEnabled,
    jupiterApiUrl: config.jupiterApiUrl,
    pm2AllowedProcesses: config.pm2AllowedProcesses,
  })) {
    log.warn(`Runtime drift warning: ${warning}`);
  }
  const heliusPoolRegistry = new HeliusPoolRegistry();
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
  let heliusPoolDiscovery: HeliusPoolDiscovery | null = null;
  let replayWarmSync: ReplayWarmSync | null = null;
  let realtimeCandleBuilder: MicroCandleBuilder | null = null;
  let bootstrapTriggerRef: VolumeMcapSpikeTrigger | null = null;

  const setRealtimePoolTarget = (logicalPair: string, subscriptionPair: string) => {
    realtimePoolTargets.set(logicalPair, subscriptionPair);
    realtimePoolAliases.set(subscriptionPair, logicalPair);
  };
  const setRealtimePoolMetadata = (subscriptionPair: string, metadata: RealtimePoolMetadata) => {
    realtimePoolMetadata.set(subscriptionPair, metadata);
    const logicalPair = realtimePoolAliases.get(subscriptionPair);
    heliusPoolRegistry.upsertObservedPair({
      pairAddress: subscriptionPair,
      dexId: metadata.dexId,
      baseTokenAddress: metadata.baseMint || logicalPair || subscriptionPair,
      baseTokenSymbol: logicalPair && logicalPair !== subscriptionPair ? logicalPair : undefined,
      quoteTokenAddress: metadata.quoteMint,
      quoteTokenSymbol: metadata.quoteMint === SOL_MINT ? 'SOL' : undefined,
    });
  };
  const removeRealtimePoolTarget = (logicalPair: string) => {
    const existing = realtimePoolTargets.get(logicalPair);
    realtimePoolTargets.delete(logicalPair);
    if (existing) {
      realtimePoolAliases.delete(existing);
      realtimePoolMetadata.delete(existing);
      heliusIngester?.clearPoolMetadata(existing);
      // Why: alias 삭제 후 구독 잔존 방지 — swap이 계속 들어오면 alias miss 발생
      void heliusIngester?.unsubscribePools([existing]);
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
  if (!realtimeModeEnabled && config.realtimePersistenceEnabled) {
    const replayImportStore = new RealtimeReplayStore(config.realtimeDataDir);
    if (await replayImportStore.hasCandles()) {
      await warmReplayCandlesIntoStore(replayImportStore, candleStore);
      if (config.realtimeReplayWarmSyncEnabled) {
        replayWarmSync = new ReplayWarmSync(
          replayImportStore,
          candleStore,
          config.realtimeReplayWarmSyncIntervalMs
        );
      }
    }
  }
  // Phase 2: EventScore persistence (C-1)
  const eventScoreStore = new EventScoreStore(dbPool);
  await eventScoreStore.initialize();
  log.info('Database initialized');

  const notifier = new Notifier(config.telegramBotToken, config.telegramChatId);
  const walletManager = new WalletManager({
    solanaRpcUrl: config.solanaRpcUrl,
    mainWalletKey: config.walletPrivateKey,
    sandboxWalletKey: config.sandboxWalletKey || undefined,
    sandboxDailyLossLimitSol: config.sandboxDailyLossLimitSol,
    sandboxMaxPositionSol: config.sandboxMaxPositionSol,
  }, dbPool);

  // ─── Phase 2: Pre-flight check (live mode gate) ────
  let effectiveMode = tradingMode;
  if (tradingMode === 'live') {
    try {
      const mainWalletBalanceSol = await walletManager.getBalance('main');
      const preflight = await runPreflightCheck(dbPool, {
        tradingMode,
        enforceGate: config.preflightEnforceGate,
        requireJupiterApiKey: true,
        hasJupiterApiKey: Boolean(config.jupiterApiKey),
        minMainWalletBalanceSol: config.livePreflightMinWalletBalanceSol,
        mainWalletBalanceSol,
      });
      if (!preflight.passed && config.preflightEnforceGate) {
        log.warn('Falling back to paper mode — pre-flight criteria not met');
        effectiveMode = 'paper';
        await notifier.sendWarning('PreFlight', `Live mode blocked: ${preflight.reasons.join(', ')}`);
      }
    } catch (err) {
      // H-27: DB query 실패 시 안전하게 paper mode fallback (live 진입 차단)
      log.error(`Pre-flight DB query failed: ${err}. Falling back to paper mode.`);
      effectiveMode = 'paper';
      await notifier.sendWarning('PreFlight', `DB query failed — forced paper mode`);
    }
  }

  const realtimePersistenceLayout = realtimeModeEnabled
    ? await prepareRealtimePersistenceLayout(config.realtimeDataDir, {
      tradingMode: effectiveMode,
    })
    : null;
  const runtimeDiagnosticsStore = realtimePersistenceLayout
    ? new RuntimeDiagnosticsStore(realtimePersistenceLayout.runtimeDiagnosticsPath)
    : null;
  const realtimeReplayStore = realtimePersistenceLayout && config.realtimePersistenceEnabled
    ? new RealtimeReplayStore(realtimePersistenceLayout.datasetDir)
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
  if (realtimePersistenceLayout) {
    log.info(`Realtime persistence dataset: ${realtimePersistenceLayout.datasetDir}`);
  }

  // ─── Initialize modules ─────────────────────────────
  const runtimeDiagnosticsInitialEvents = runtimeDiagnosticsStore
    ? await runtimeDiagnosticsStore.load()
    : [];
  const runtimeDiagnosticsTracker = new RuntimeDiagnosticsTracker(
    runtimeDiagnosticsStore ?? undefined,
    runtimeDiagnosticsInitialEvents
  );
  if (runtimeDiagnosticsInitialEvents.length > 0) {
    log.info(`Loaded runtime diagnostics snapshot: ${runtimeDiagnosticsInitialEvents.length} events`);
  }
  const geckoClient = new GeckoTerminalClient((source) => {
    runtimeDiagnosticsTracker.recordRateLimit(source);
  });
  // Why: Birdeye optional — overview/legacy REST + Strategy D WS 보조용
  const birdeyeClient = config.birdeyeApiKey ? new BirdeyeClient(config.birdeyeApiKey) : null;
  const onchainSecurityClient = new OnchainSecurityClient(config.solanaRpcUrl);

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
    samePairOpenPositionBlock: config.samePairOpenPositionBlock,
    perTokenLossCooldownLosses: config.perTokenLossCooldownLosses,
    perTokenLossCooldownMinutes: config.perTokenLossCooldownMinutes,
    perTokenDailyTradeCap: config.perTokenDailyTradeCap,
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

  // ─── Phase 3: Wallet Manager (main + sandbox isolation) ───
  await walletManager.initDailyPnlStore();

  // ─── Phase 1B: Regime Filter + Paper Metrics ────────
  const regimeFilter = new RegimeFilter();
  const paperMetrics = new PaperMetricsTracker();

  const healthMonitor = new HealthMonitor();
  healthMonitor.setDbConnected(true);
  healthMonitor.start();
  const internalCandleSource = new InternalCandleSource(candleStore);

  // ─── Execution Lock (v0.3) ─────────────────────────
  const executionLock = new ExecutionLock(async () => {
    await notifier.sendWarning('ExecutionLock', 'Lock timeout — auto released');
  });

  // ─── Phase 1A: Birdeye WebSocket (requires API key) ──
  let birdeyeWS: BirdeyeWSClient | null = null;
  const handleStrategyDListingCandidate = async (
    listingCandidate: import('./strategy/newLpSniper').NewLpListingInput,
    sourceLabel: string
  ): Promise<void> => {
    if (!config.strategyDEnabled || !walletManager.hasSandboxWallet()) return;
    if (!listingCandidate.address) return;

    try {
      const strategyDParams = {
        ticketSizeSol: config.strategyDTicketSol,
        minAgeMinutes: config.strategyDMinAge,
        maxAgeMinutes: config.strategyDMaxAge,
        takeProfitMultiplier: config.strategyDTpMultiplier,
      };
      const prepared = await prepareNewLpCandidate(listingCandidate, {
        getTokenSecurityDetailed: (tokenMint) => onchainSecurityClient.getTokenSecurityDetailed(tokenMint),
        getExitLiquidity: (tokenMint) => onchainSecurityClient.getExitLiquidity(tokenMint),
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
          `Strategy D skipped ${listingCandidate.symbol ?? listingCandidate.address} ` +
          `(${sourceLabel}): ${prepared.rejectionReason ?? 'unknown'}`
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
        `Strategy D signal (${sourceLabel}): ${prepared.candidate.tokenSymbol} ticket=${order.quantity} SOL ` +
        `impact=${((prepared.quoteGate?.priceImpactPct ?? 0) * 100).toFixed(2)}%`
      );

      if (effectiveMode === 'paper') {
        log.info(`[PAPER] Strategy D: ${JSON.stringify(order)}`);
      }
      // Live execution은 Jito bundle + sandbox wallet 통합 후 활성화
    } catch (err) {
      log.warn(`Strategy D evaluation failed (${sourceLabel}): ${err}`);
    }
  };

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
    if (config.strategyDEnabled && walletManager.hasSandboxWallet()) {
      attachBirdeyeListingSource(birdeyeWS, (listingCandidate) =>
        handleStrategyDListingCandidate(listingCandidate, 'birdeye_ws')
      );
    }

    log.info('Birdeye WebSocket client initialized');
  }

  // ─── DexScreener Client (free — API key optional) ─────
  const dexScreenerClient = new DexScreenerClient(
    config.dexScreenerApiKey || undefined,
    (source) => { runtimeDiagnosticsTracker.recordRateLimit(source); }
  );
  const tokenPairResolver = new CompositeTokenPairResolver(heliusPoolRegistry, dexScreenerClient);
  const internalTrendingProvider = new InternalTrendingTokenProvider(
    heliusPoolRegistry,
    internalCandleSource
  );
  const trendingProvider = new CompositeTrendingTokenProvider(
    internalTrendingProvider,
    geckoClient
  );
  const eventMonitor = new EventMonitor(trendingProvider, {
    pollingIntervalMs: config.eventPollingIntervalMs,
    minAttentionScore: config.eventMinScore,
    fetchLimit: config.eventTrendingFetchLimit,
    expiryMinutes: config.eventExpiryMinutes,
    minLiquidityUsd: config.eventMinLiquidityUsd,
  });
  eventMonitor.setScoreStore(eventScoreStore);
  log.info('DexScreener client initialized');

  // ─── Phase 1A: Scanner Engine ─────────────────────
  let scanner: ScannerEngine | null = null;
  if (config.scannerEnabled) {
    const scannerConfig: ScannerEngineConfig = {
      geckoClient,
      trendingProvider,
      dexScreenerClient,
      maxWatchlistSize: config.maxWatchlistSize,
      minWatchlistScore: config.scannerMinWatchlistScore,
      trendingPollIntervalMs: config.scannerTrendingPollMs,
      geckoNewPoolIntervalMs: config.scannerGeckoNewPoolMs,
      dexDiscoveryIntervalMs: config.scannerDexDiscoveryMs,
      dexEnrichIntervalMs: config.scannerDexEnrichMs,
      laneAMinAgeSec: config.scannerLaneAMinAgeSec,
      laneBMaxAgeSec: config.scannerLaneBMaxAgeSec,
      reentryCooldownMs: config.scannerReentryCooldownMs,
      minimumResidencyMs: config.scannerMinimumResidencyMs,
      replacementScoreMargin: config.scannerReplacementScoreMargin,
      // Why: Scanner minLiquidity는 SafetyGate minPoolLiquidity 이상이어야 함 (config gap 방지)
      minLiquidityUsd: Math.max(config.eventMinLiquidityUsd, config.minPoolLiquidity),
      socialMentionTracker, // H-02: social score → WatchlistScore 연동
      // R3: 블랙리스트 pair 재진입 차단
      blacklistCheck: await createScannerBlacklistCheck(tradeStore),
      candidateFilter: realtimeModeEnabled ? async (token) => {
        const discoverySource =
          typeof token.raw?.discovery_source === 'string' ? token.raw.discovery_source : undefined;
        const dexId = typeof token.raw?.dex_id === 'string' ? token.raw.dex_id : undefined;
        const pairAddress = typeof token.raw?.pair_address === 'string' ? token.raw.pair_address : undefined;
          const mismatch = detectRealtimeDiscoveryMismatch({
            dexId,
            quoteTokenAddress:
              typeof token.raw?.quote_token_address === 'string' ? token.raw.quote_token_address : undefined,
          });
        if (mismatch) {
          runtimeDiagnosticsTracker.recordPreWatchlistReject({
            tokenMint: token.address,
            reason: mismatch,
            source: discoverySource,
            dexId,
          });
          return { allowed: false, reason: mismatch };
        }
        if (realtimePoolOwnerResolver && pairAddress && dexId) {
          try {
            const owners = await realtimePoolOwnerResolver.resolveOwners([pairAddress]);
            const poolProgramMismatch = detectRealtimePoolProgramMismatch({
              dexId,
              poolOwner: owners.get(pairAddress),
            });
            if (poolProgramMismatch) {
              runtimeDiagnosticsTracker.recordPreWatchlistReject({
                tokenMint: token.address,
                reason: poolProgramMismatch,
                source: discoverySource,
                dexId,
              });
              return { allowed: false, reason: poolProgramMismatch };
            }
          } catch (error) {
            log.debug(`Realtime prefilter owner resolve skipped for ${token.symbol}: ${error}`);
          }
        }
        return { allowed: true };
      } : undefined,
    };
    scanner = new ScannerEngine(scannerConfig);
    attachScannerFreshListingSource(scanner, (listingCandidate) => {
      if (birdeyeWS) return;
      return handleStrategyDListingCandidate(listingCandidate, listingCandidate.source);
    });
    // Bridge: Scanner → Ingester + UniverseEngine (rate limit 방지 큐)
    const ingesterQueue: import('./scanner').WatchlistEntry[] = [];
    let ingesterQueueRunning = false;

    const processIngesterQueue = async () => {
      if (ingesterQueueRunning) return;
      ingesterQueueRunning = true;
      while (ingesterQueue.length > 0) {
        const entry = ingesterQueue.shift()!;
        try {
          if (entry.pairAddress !== entry.tokenMint && entry.quoteTokenAddress) {
            heliusPoolRegistry.upsertObservedPair({
              pairAddress: entry.pairAddress,
              dexId: entry.dexId,
              baseTokenAddress: entry.baseTokenAddress || entry.tokenMint,
              baseTokenSymbol: entry.symbol,
              quoteTokenAddress: entry.quoteTokenAddress,
              quoteTokenSymbol: entry.quoteTokenAddress === SOL_MINT ? 'SOL' : undefined,
              priceUsd: entry.lastPriceUsd,
              liquidityUsd: entry.poolInfo?.tvl,
              volume24hUsd: entry.poolInfo?.dailyVolume,
              marketCap: entry.poolInfo?.marketCap,
              pairCreatedAt: undefined,
            });
          }

          // Why: GeckoTerminal OHLCV는 pool address 필요 (token mint ≠ pool address)
          // DexScreener pair 목록에서 최고 유동성 pair를 선택
          const pairs = await tokenPairResolver.getTokenPairs(entry.tokenMint);
          heliusPoolRegistry.upsertPairs(pairs);
          const bestPair = pairs[0];
          const poolAddress = bestPair?.pairAddress;
          if (!poolAddress) {
            if (realtimeModeEnabled) {
              runtimeDiagnosticsTracker.recordAdmissionSkip({
                tokenMint: entry.tokenMint,
                reason: 'no_pairs',
                detail: pairs.length === 0 ? 'resolver_miss' : 'empty_pairs',
                source: entry.discoverySource,
                dexId: bestPair?.dexId,
              });
            }
            log.warn(`No pool found for ${entry.symbol} (${entry.tokenMint}), skipping ingester`);
            continue;
          }

          let poolOwners: Map<string, string | null> | undefined;
          if (realtimeModeEnabled && realtimePoolOwnerResolver) {
            try {
              poolOwners = await realtimePoolOwnerResolver.resolveOwners(
                pairs.map((pair) => pair.pairAddress)
              );
            } catch (error) {
              log.warn(`Realtime pool owner resolve failed for ${entry.symbol}: ${error}`);
            }
          }
          const admissionPairs = realtimeAdmissionTracker
            ? pairs.filter((pair) => !realtimeAdmissionTracker.isBlocked(pair.pairAddress))
            : pairs;
          const realtimeEligibility = selectRealtimeEligiblePair(admissionPairs, poolOwners);
          if (realtimeEligibility.eligible && realtimeEligibility.pair) {
            heliusPoolRegistry.upsertObservedPair({
              pairAddress: realtimeEligibility.pair.pairAddress,
              dexId: realtimeEligibility.pair.dexId,
              baseTokenAddress: realtimeEligibility.pair.baseToken?.address || entry.tokenMint,
              baseTokenSymbol: realtimeEligibility.pair.baseToken?.symbol || entry.symbol,
              quoteTokenAddress: realtimeEligibility.pair.quoteToken?.address || SOL_MINT,
              quoteTokenSymbol: realtimeEligibility.pair.quoteToken?.symbol,
              liquidityUsd: realtimeEligibility.pair.liquidity?.usd,
            });
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
            if (heliusIngester && realtimeCandleBuilder && config.realtimeSeedBackfillEnabled) {
              const lookbackSec = getRealtimeSeedLookbackSec();
              let recentSwaps: import('./realtime').ParsedSwap[] = [];
              try {
                recentSwaps = await heliusIngester.backfillRecentSwaps(
                  realtimeEligibility.pair.pairAddress,
                  {
                    lookbackSec,
                    allowSingleFetchFallback: config.realtimeSeedAllowSingleTxFallback,
                  }
                );
              } catch (error) {
                if (String(error).includes('429')) {
                  runtimeDiagnosticsTracker.recordRateLimit('helius_seed_backfill');
                }
                log.warn(`Realtime seed backfill failed for ${entry.symbol}: ${error}`);
              }
              if (recentSwaps.length > 0) {
                const seeded = realtimeCandleBuilder.seedSwaps(
                  recentSwaps.map((swap) => ({
                    ...swap,
                    pool: entry.tokenMint,
                  }))
                );
                log.info(
                  `Realtime seed applied for ${entry.symbol}: ${seeded} swaps ` +
                  `(${Math.round(lookbackSec / 60)}m lookback)`
                );
                if (realtimeReplayStore) {
                  await Promise.all(recentSwaps.map((swap) =>
                    realtimeReplayStore.appendSwap({
                      ...swap,
                      pairAddress: entry.tokenMint,
                      poolAddress: swap.pool,
                      tokenMint: entry.tokenMint,
                    })
                  ));
                }
              }
            }
          } else {
            removeRealtimePoolTarget(entry.tokenMint);
            if (realtimeModeEnabled) {
              const admissionSkipDetail = classifyRealtimeAdmissionSkip({
                resolvedPairs: pairs,
                admissionPairs,
                result: realtimeEligibility,
              });
              runtimeDiagnosticsTracker.recordAdmissionSkip({
                tokenMint: entry.tokenMint,
                reason: realtimeEligibility.reason,
                detail: admissionSkipDetail,
                source: entry.discoverySource,
                dexId: admissionPairs[0]?.dexId ?? pairs[0]?.dexId,
              });
              log.info(
                `Realtime skipped for ${entry.symbol} (${entry.tokenMint}) — ${realtimeEligibility.reason} ` +
                `${formatRealtimeEligibilityContext(admissionPairs)}`
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
      runtimeDiagnosticsTracker.recordRealtimeCandidateSeen({
        tokenMint: entry.tokenMint,
        source: entry.discoverySource,
      });
      log.info(`Scanner: new candidate ${entry.symbol} lane=${entry.lane} score=${entry.watchlistScore.totalScore}`);

      // UniverseEngine은 즉시 추가 (API 호출 없음)
      universeEngine.addPoolDirect({
        pairAddress: entry.tokenMint,
        tokenMint: entry.tokenMint,
        symbol: entry.symbol,
        tvl: entry.poolInfo?.tvl ?? 0,
        marketCap: entry.poolInfo?.marketCap,
        dailyVolume: entry.poolInfo?.dailyVolume ?? 0,
        tradeCount24h: entry.poolInfo?.tradeCount24h ?? 0,
        spreadPct: entry.poolInfo?.spreadPct ?? 0,
        ammFeePct: entry.poolInfo?.ammFeePct ?? resolveAmmFeePct(entry.dexId),
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
      bootstrapTriggerRef?.clearPoolContext(tokenMint);
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

  const universeEngine = new UniverseEngine(
    geckoClient,
    universeConfig,
    tokenPairResolver,
    internalCandleSource
  );
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
    internalCandleSource,
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
    onchainSecurityClient,
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
    runtimeDiagnosticsTracker,
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
      disableSingleTxFallbackOnBatchUnsupported:
        config.realtimeDisableSingleTxFallbackOnBatchUnsupported,
    });
    if (config.realtimePoolDiscoveryEnabled) {
      heliusPoolDiscovery = new HeliusPoolDiscovery({
        rpcWsUrl: buildHeliusWsUrl(),
        rpcHttpUrl: config.solanaRpcUrl,
        concurrency: config.realtimePoolDiscoveryConcurrency,
        queueLimit: config.realtimePoolDiscoveryQueueLimit,
        requestSpacingMs: config.realtimePoolDiscoveryRequestSpacingMs,
      });
      heliusPoolDiscovery.on('poolDiscovered', (candidate) => {
        heliusPoolRegistry.upsertObservedPair(candidate);
        log.info(
          `Helius pool discovered ${candidate.dexId ?? 'unknown'} ${candidate.pairAddress} ` +
          `${candidate.baseTokenAddress}/${candidate.quoteTokenAddress}`
        );
      });
      heliusPoolDiscovery.on('error', ({ programId, signature, error, cooldownMs }: {
        programId: string;
        signature: string;
        error: unknown;
        cooldownMs?: number;
      }) => {
        const cooldownSuffix = cooldownMs ? ` (cooldown ${cooldownMs}ms)` : '';
        log.debug(`Helius pool discovery handled error for ${programId} ${signature}: ${error}${cooldownSuffix}`);
      });
      heliusPoolDiscovery.on('capacity', ({ source, reason, detail }: {
        source: string;
        reason: string;
        detail?: string;
      }) => {
        runtimeDiagnosticsTracker.recordCapacity({ source, reason, detail });
      });
    }
    for (const [pool, metadata] of realtimePoolMetadata.entries()) {
      heliusIngester.setPoolMetadata(pool, metadata);
    }
    realtimeCandleBuilder = new MicroCandleBuilder({
      intervals: realtimeIntervals,
      maxHistory: 200,
    });
    // Why: bootstrap 모드는 breakout/confirm 제거, volume+buyRatio만으로 발화 (signal 밀도 개선)
    let trigger: MomentumTrigger | VolumeMcapSpikeTrigger;

    if (config.realtimeTriggerMode === 'bootstrap') {
      const bootstrapTrigger = new VolumeMcapSpikeTrigger(
        {
          primaryIntervalSec: config.realtimePrimaryIntervalSec,
          volumeSurgeLookback: config.realtimeVolumeSurgeLookback,
          volumeSurgeMultiplier: config.realtimeVolumeSurgeMultiplier,
          cooldownSec: config.realtimeCooldownSec,
          minBuyRatio: config.realtimeBootstrapMinBuyRatio,
          atrPeriod: 14,
        },
        // Why: RejectStats → runtime-diagnostics.json (원격 디버깅)
        (s) => {
          runtimeDiagnosticsTracker.recordTriggerStats(
            `evals=${s.evaluations} signals=${s.signals} insuffCandles=${s.insufficientCandles} ` +
            `volInsuf=${s.volumeInsufficient} lowBuyRatio=${s.lowBuyRatio} cooldown=${s.cooldown}`,
            'bootstrap_trigger'
          );
        },
      );
      for (const pool of universeEngine.getWatchlist()) {
        if (pool.marketCap !== undefined) {
          bootstrapTrigger.setPoolContext(pool.pairAddress, { marketCap: pool.marketCap });
        }
      }
      trigger = bootstrapTrigger;
      bootstrapTriggerRef = bootstrapTrigger;
      log.info(`Trigger: bootstrap (vm=${config.realtimeVolumeSurgeMultiplier}, br=${config.realtimeBootstrapMinBuyRatio})`);
    } else {
      trigger = new MomentumTrigger(
        {
          primaryIntervalSec: config.realtimePrimaryIntervalSec,
          confirmIntervalSec: config.realtimeConfirmIntervalSec,
          volumeSurgeLookback: config.realtimeVolumeSurgeLookback,
          volumeSurgeMultiplier: config.realtimeVolumeSurgeMultiplier,
          priceBreakoutLookback: config.realtimePriceBreakoutLookback,
          confirmMinBars: config.realtimeConfirmMinBars,
          confirmMinPriceChangePct: config.realtimeConfirmMinChangePct,
          cooldownSec: config.realtimeCooldownSec,
        },
        // Why: RejectStats → runtime-diagnostics.json (원격 디버깅)
        (s) => {
          runtimeDiagnosticsTracker.recordTriggerStats(
            `evals=${s.evaluations} signals=${s.signals} insuffCandles=${s.insufficientCandles} ` +
            `volInsuf=${s.volumeInsufficient} noBreakout=${s.noBreakout} confirmFail=${s.confirmFail} cooldown=${s.cooldown}`
          );
        },
      );
      log.info(`Trigger: core (vm=${config.realtimeVolumeSurgeMultiplier})`);
    }

    ctx.realtimeCandleBuilder = realtimeCandleBuilder;

    heliusIngester.on('connected', () => {
      healthMonitor.setWsConnected(true);
      log.info('Helius real-time pipeline connected');
    });
    heliusIngester.on('disconnected', () => {
      healthMonitor.setWsConnected(false);
    });
    heliusIngester.on('swap', (swap) => {
      const logicalPair = realtimePoolAliases.get(swap.pool);
      if (!logicalPair) {
        // Why: alias 없는 pool의 swap → candle key에 pool address가 들어가서 watchlist lookup 100% 실패
        // stale 구독을 즉시 해제하여 반복 alias miss 방지
        runtimeDiagnosticsTracker.recordAliasMiss(swap.pool);
        void heliusIngester!.unsubscribePools([swap.pool]);
        return;
      }
      const metadata = realtimePoolMetadata.get(swap.pool);
      if (metadata) {
        heliusPoolRegistry.upsertObservedPair({
          pairAddress: swap.pool,
          dexId: metadata.dexId,
          baseTokenAddress: metadata.baseMint || logicalPair,
          baseTokenSymbol: logicalPair !== swap.pool ? logicalPair : undefined,
          quoteTokenAddress: metadata.quoteMint,
          quoteTokenSymbol: metadata.quoteMint === SOL_MINT ? 'SOL' : undefined,
        });
      }
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
      if (String(error).includes('429')) {
        runtimeDiagnosticsTracker.recordRateLimit('helius_ws');
      }
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
          log.info(`🎯 Signal fired: ${signal.strategy} ${signal.pairAddress.slice(0, 12)}… price=${signal.price} vr=${signal.meta.volumeRatio?.toFixed(1)}`);
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
    runtimeDiagnosticsTracker.recordPollFailure('gecko_ingester');
    if (String(error).includes('429')) {
      runtimeDiagnosticsTracker.recordRateLimit('gecko_ingester');
    }
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
        solPoolAddress = await tokenPairResolver.getBestPoolAddress(SOL_MINT);
      }

      if (solPoolAddress) {
        const nowMs = Date.now();
        const currentBucketStartMs = Math.floor(nowMs / (4 * 3600_000)) * (4 * 3600_000);
        const useCachedCandles = cachedSol4hCandles
          && cachedSol4hCandles.bucketStartMs === currentBucketStartMs
          && (nowMs - cachedSol4hCandles.fetchedAtMs) < REGIME_SOL_CACHE_TTL_MS;

        if (!useCachedCandles) {
          const internalSol4hCandles = await internalCandleSource.getCandlesInRange(
            solPoolAddress,
            4 * 3600,
            new Date(tenDaysAgo * 1000),
            new Date(now * 1000)
          );
          const sol4hCandles = internalSol4hCandles.length > 0
            ? internalSol4hCandles
            : await geckoClient.getOHLCV(solPoolAddress, '4H', tenDaysAgo, now);
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
    if (heliusPoolDiscovery) {
      await heliusPoolDiscovery.start();
    }
    await heliusIngester.subscribePools(resolveRealtimePools(
      universeEngine.getWatchlist().map((pool) => pool.pairAddress)
    ));
    universeEngine.on('watchlistUpdated', (pools: { pairAddress: string; marketCap?: number }[]) => {
      void heliusIngester!.subscribePools(
        resolveRealtimePools(pools.map((pool) => pool.pairAddress))
      );
      // Bootstrap trigger mcap context 갱신
      if (bootstrapTriggerRef) {
        for (const pool of pools) {
          if (pool.marketCap !== undefined) {
            bootstrapTriggerRef.setPoolContext(pool.pairAddress, { marketCap: pool.marketCap });
          }
        }
      }
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
  if (!realtimeModeEnabled) {
    if (replayWarmSync) {
      await replayWarmSync.start();
    }
    await ingester.start();
  } else {
    log.info('Gecko ingester skipped in realtime mode (internal candles active)');
  }
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
    await runtimeDiagnosticsTracker.flush().catch((error) => {
      log.warn(`Failed to persist runtime diagnostics snapshot: ${error}`);
    });
    await ingester.stop();
    eventMonitor.stop();
    universeEngine.stop();
    if (scanner) scanner.stop();
    if (birdeyeWS) birdeyeWS.stop();
    replayWarmSync?.stop();
    if (realtimeCandleBuilder) realtimeCandleBuilder.stop();
    if (heliusPoolDiscovery) await heliusPoolDiscovery.stop();
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
