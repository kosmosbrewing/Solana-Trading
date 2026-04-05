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
  buildRealtimeAdmissionSkipDetail,
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
import { closeTrade } from './orchestration/tradeExecution';
import { runPreflightCheck } from './orchestration/preflightCheck';
import { SpreadMeasurer } from './gate/spreadMeasurer';
import { SOL_MINT } from './utils/constants';
import { BotContext } from './orchestration/types';
import { resolveAmmFeePct } from './utils/dexFeeMap';
import { buildRuntimeDriftSnapshot, evaluateRuntimeDriftWarnings } from './ops/runtimeDrift';
import path from 'path';
import { prepareRealtimePersistenceLayout } from './realtime/persistenceLayout';
import { initStores } from './init/initStores';
import { startMonitoringLoops, type MonitoringHandles } from './init/monitoringLoops';

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
  const operatorTokenBlacklist = new Set(config.operatorTokenBlacklist);
  const isOperatorBlacklisted = (value?: string): boolean =>
    Boolean(value && operatorTokenBlacklist.has(value));
  if (operatorTokenBlacklist.size > 0) {
    log.info(`Operator blacklist loaded: ${operatorTokenBlacklist.size} entries`);
  }
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

  const ALIAS_GRACE_PERIOD_MS = 5 * 60 * 1000;
  const pendingAliasCleanups = new Map<string, { timer: NodeJS.Timeout; poolAddress: string }>();
  const ALIAS_MISS_CLEANUP_WINDOW_MS = 60_000;
  const ALIAS_MISS_CLEANUP_THRESHOLD = 3;
  const ALIAS_MISS_CLEANUP_TTL_MS = ALIAS_GRACE_PERIOD_MS * 2;
  const aliasMissCleanupState = new Map<string, { count: number; windowStartedMs: number; lastCleanupMs: number }>();
  // Why: unsubscribe 완료 후에도 WS lag으로 swap이 계속 유입되는 zombie pool 차단
  // — 반복 unsubscribe + 로깅 노이즈 방지. TTL 후 자동 제거.
  const ZOMBIE_POOL_TTL_MS = 30 * 60 * 1000; // 30min
  const zombiePoolBlacklist = new Map<string, number>(); // poolAddress → blacklistedAtMs

  const isPendingAliasCleanupPool = (poolAddress: string) => {
    for (const pending of pendingAliasCleanups.values()) {
      if (pending.poolAddress === poolAddress) return true;
    }
    return false;
  };

  const isActiveRealtimeTargetPool = (poolAddress: string) => {
    for (const activePool of realtimePoolTargets.values()) {
      if (activePool === poolAddress) return true;
    }
    return false;
  };

  const shouldCleanupAliasMissPool = (poolAddress: string) => {
    const now = Date.now();
    for (const [trackedPool, state] of aliasMissCleanupState.entries()) {
      const lastTouchedMs = Math.max(state.windowStartedMs, state.lastCleanupMs);
      if (now - lastTouchedMs > ALIAS_MISS_CLEANUP_TTL_MS) {
        aliasMissCleanupState.delete(trackedPool);
      }
    }
    const current = aliasMissCleanupState.get(poolAddress);
    if (!current || now - current.windowStartedMs > ALIAS_MISS_CLEANUP_WINDOW_MS) {
      aliasMissCleanupState.set(poolAddress, {
        count: 1,
        windowStartedMs: now,
        lastCleanupMs: current?.lastCleanupMs ?? 0,
      });
      return false;
    }

    current.count += 1;
    if (current.count < ALIAS_MISS_CLEANUP_THRESHOLD) {
      return false;
    }
    if (now - current.lastCleanupMs < ALIAS_GRACE_PERIOD_MS) {
      return false;
    }

    current.count = 0;
    current.windowStartedMs = now;
    current.lastCleanupMs = now;
    return true;
  };

  const setRealtimePoolTarget = (logicalPair: string, subscriptionPair: string) => {
    // Why: grace period 중이면 취소 — 재진입 성공
    const pending = pendingAliasCleanups.get(logicalPair);
    if (pending) {
      clearTimeout(pending.timer);
      pendingAliasCleanups.delete(logicalPair);
      runtimeDiagnosticsTracker.recordCandidateReadded(logicalPair, 'within_grace');
    }
    realtimePoolTargets.set(logicalPair, subscriptionPair);
    realtimePoolAliases.set(subscriptionPair, logicalPair);
    aliasMissCleanupState.delete(subscriptionPair);
    zombiePoolBlacklist.delete(subscriptionPair);
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
      realtimePoolMetadata.delete(existing);
      heliusIngester?.clearPoolMetadata(existing);
      // Why: alias를 즉시 삭제하지 않고 grace period 후 정리 — 재진입 시 swap 즉시 처리
      const timer = setTimeout(() => {
        if (!realtimePoolTargets.has(logicalPair)) {
          realtimePoolAliases.delete(existing);
          void heliusIngester?.unsubscribePools([existing]);
          // Why: grace period 종료 후 WS lag swap을 zombie blacklist로 흡수
          zombiePoolBlacklist.set(existing, Date.now());
        }
        pendingAliasCleanups.delete(logicalPair);
      }, ALIAS_GRACE_PERIOD_MS);
      pendingAliasCleanups.set(logicalPair, { timer, poolAddress: existing });
    }
  };
  const resolveRealtimePools = (logicalPairs: string[]) => {
    const resolved = logicalPairs
      .map((pair) => realtimePoolTargets.get(pair))
      .filter((pair): pair is string => Boolean(pair));
    // Why: grace period 중인 pool은 subscribePools의 unsubscribe 대상에서 보호
    for (const { poolAddress } of pendingAliasCleanups.values()) {
      if (!resolved.includes(poolAddress)) {
        resolved.push(poolAddress);
      }
    }
    return [...new Set(resolved)];
  };

  // ─── 공유 DB Pool + 스토어 초기화 ─────────────────
  const { dbPool, candleStore, tradeStore, positionStore, auditLogger, eventScoreStore } =
    await initStores({ databaseUrl: config.databaseUrl });
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
    }, realtimeSignalLogger, realtimeSignalLogger)
    : null;
  if (realtimePersistenceLayout) {
    log.info(`Realtime persistence dataset: ${realtimePersistenceLayout.datasetDir}`);
  }

  // ─── Initialize modules ─────────────────────────────
  const runtimeDiagnosticsSnapshot = runtimeDiagnosticsStore
    ? await runtimeDiagnosticsStore.load()
    : { events: [] };
  const runtimeDiagnosticsTracker = new RuntimeDiagnosticsTracker(
    runtimeDiagnosticsStore ?? undefined,
    runtimeDiagnosticsSnapshot.events,
    runtimeDiagnosticsSnapshot.capSuppress
  );
  if (runtimeDiagnosticsSnapshot.events.length > 0) {
    log.info(`Loaded runtime diagnostics snapshot: ${runtimeDiagnosticsSnapshot.events.length} events`);
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
  riskManager.setDiagnosticsTracker(runtimeDiagnosticsTracker);

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
    const scannerBlacklistCheck = await createScannerBlacklistCheck(tradeStore);
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
      blacklistCheck: (pairAddress) =>
        scannerBlacklistCheck(pairAddress) || isOperatorBlacklisted(pairAddress),
      candidateFilter: async (token) => {
        const discoverySource =
          typeof token.raw?.discovery_source === 'string' ? token.raw.discovery_source : undefined;
        const dexId = typeof token.raw?.dex_id === 'string' ? token.raw.dex_id : undefined;
        const pairAddress = typeof token.raw?.pair_address === 'string' ? token.raw.pair_address : undefined;
        if (isOperatorBlacklisted(token.address) || isOperatorBlacklisted(pairAddress)) {
          runtimeDiagnosticsTracker.recordPreWatchlistReject({
            tokenMint: token.address,
            reason: 'operator_blacklist',
            detail: pairAddress && isOperatorBlacklisted(pairAddress) ? 'pair_address' : 'token_mint',
            source: discoverySource,
            dexId,
          });
          return { allowed: false, reason: 'operator_blacklist' };
        }
        if (!realtimeModeEnabled) {
          return { allowed: true };
        }
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
      },
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
              const admissionSkipDetail = buildRealtimeAdmissionSkipDetail({
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
        discoverySource: entry.discoverySource,
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
      runtimeDiagnosticsTracker.recordCandidateEvicted(tokenMint);
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
    isInGracePeriod: (tokenMint) => pendingAliasCleanups.has(tokenMint),
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
          volumeMcapBoostThreshold: config.realtimeVolumeMcapBoostThreshold,
          volumeMcapBoostMultiplier: config.realtimeVolumeMcapBoostMultiplier,
          sparseVolumeLookback: config.realtimeSparseVolumeLookback,
          minActiveCandles: config.realtimeMinActiveCandles,
        },
        // Why: RejectStats → runtime-diagnostics.json (원격 디버깅)
        (s) => {
          runtimeDiagnosticsTracker.recordTriggerStats(
            `evals=${s.evaluations} signals=${s.signals}(sparse=${s.sparseSignals} boosted=${s.volumeMcapBoosted}) insuffCandles=${s.insufficientCandles} ` +
            `volInsuf=${s.volumeInsufficient} sparseInsuf=${s.sparseDataInsufficient} lowBuyRatio=${s.lowBuyRatio} cooldown=${s.cooldown}`,
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
        // Why: zombie blacklist 확인 — 이미 unsubscribe 완료된 pool은 WS lag으로 유입되는 swap 무시
        const zombieAt = zombiePoolBlacklist.get(swap.pool);
        if (zombieAt) {
          if (Date.now() - zombieAt > ZOMBIE_POOL_TTL_MS) {
            zombiePoolBlacklist.delete(swap.pool);
          }
          return; // silently drop — no logging, no re-unsubscribe
        }
        runtimeDiagnosticsTracker.recordAliasMiss(swap.pool);
        if (
          !isPendingAliasCleanupPool(swap.pool) &&
          !isActiveRealtimeTargetPool(swap.pool) &&
          shouldCleanupAliasMissPool(swap.pool)
        ) {
          realtimePoolMetadata.delete(swap.pool);
          heliusIngester?.clearPoolMetadata(swap.pool);
          log.info(`Alias-miss cleanup: unsubscribing stale pool ${swap.pool}`);
          void heliusIngester?.unsubscribePools([swap.pool]);
          // Why: unsubscribe 후에도 WS lag으로 swap 유입될 수 있음 — blacklist에 등록하여 무시
          zombiePoolBlacklist.set(swap.pool, Date.now());
          aliasMissCleanupState.delete(swap.pool);
        }
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
        // Why: 99% zero-volume synthetic candle → disk 비대화 방지. in-memory 처리는 유지.
        if (realtimeReplayStore && candle.tradeCount > 0) {
          await realtimeReplayStore.appendCandle({
            ...candle,
            tokenMint: candle.pairAddress,
          });
        }
        await realtimeOutcomeTracker?.onCandle(candle);
        if (candle.intervalSec >= 60) {
          await candleStore.insertCandles([candle]);
        }
        // Why: cap hit pair의 trigger eval 낭비 방지 — candle은 쌓되 eval은 skip
        if (ctx.riskManager.isCapSuppressed(candle.pairAddress)) {
          if (candle.intervalSec === config.realtimePrimaryIntervalSec) {
            runtimeDiagnosticsTracker.recordCapSuppressed(candle.pairAddress);
          }
          return;
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

  // ─── Monitoring loops (position check, regime, pruning) ──
  const monitoringHandles = await startMonitoringLoops({
    ctx,
    notifier,
    regimeFilter,
    eventScoreStore,
    tokenPairResolver,
    internalCandleSource,
    geckoClient,
    paperMetrics,
    regimeSolCacheTtlMs: REGIME_SOL_CACHE_TTL_MS,
  });


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

  await notifier.sendInfo(`Bot started (v0.5 — Phase 2 Core Live, mode: ${effectiveMode})`, 'lifecycle');

  // ─── Daily summary scheduler ────────────────────────
  scheduleDailySummary(ctx);

  // ─── Graceful shutdown ──────────────────────────────
  const shutdown = async () => {
    log.info('Shutting down...');
    clearInterval(monitoringHandles.positionCheckInterval);
    clearInterval(monitoringHandles.regimeInterval);
    clearInterval(monitoringHandles.pruneInterval);
    // Why: grace period timer가 shutdown 후 발동하면 stopped ingester 호출 → 에러 방지
    for (const { timer } of pendingAliasCleanups.values()) {
      clearTimeout(timer);
    }
    pendingAliasCleanups.clear();
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
