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
  resolveCohortFromSources,
  type Cohort,
} from './scanner';
import { ExecutionLock, PositionStore, runRecovery } from './state';
import { SignalAuditLogger } from './audit';
import { scheduleDailySummary } from './orchestration/reporting';
import { handleNewCandle } from './orchestration/candleHandler';
import { handleRealtimeSignal } from './orchestration/realtimeHandler';
import { handleCupseyLaneSignal, recoverCupseyOpenPositions, updateCupseyPositions } from './orchestration/cupseyLaneHandler';
import {
  handlePureWsSignal,
  updatePureWsPositions,
  recoverPureWsOpenPositions,
  resolvePureWsWalletLabel,
  scanPureWsV2Burst,
} from './orchestration/pureWsBreakoutHandler';
import { updateMigrationPositions, onMigrationEvent, recoverMigrationOpenPositions } from './orchestration/migrationLaneHandler';
import type { MigrationEvent } from './strategy/migrationHandoffReclaim';
import { isPumpSwapDexId } from './realtime/pumpSwapParser';
import { logAdmissionSkipDex } from './realtime/admissionSkipLogger';
import { startWalletStopGuard, stopWalletStopGuardPoller } from './risk/walletStopGuard';
import { startWalletDeltaComparator, stopWalletDeltaComparator } from './risk/walletDeltaComparator';
import { resolveCupseyWalletLabel } from './orchestration/cupseyLaneHandler';
import { resolveMigrationWalletLabel } from './orchestration/migrationLaneHandler';
import { persistOpenTradeWithIntegrity, isEntryHaltActive } from './orchestration/entryIntegrity';
import { evaluateNewLpSniper, buildNewLpOrder, prepareNewLpCandidate } from './strategy/newLpSniper';
import { MomentumTrigger, VolumeMcapSpikeTrigger, TickTrigger } from './strategy';
import { closeTrade } from './orchestration/tradeExecution';
import { checkTickLevelExit } from './orchestration/tickPositionMonitor';
import { runPreflightCheck } from './orchestration/preflightCheck';
import { SpreadMeasurer } from './gate/spreadMeasurer';
import { GateCacheManager } from './gate/gateCacheManager';
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
  let tickTriggerRef: TickTrigger | null = null;

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
      // Phase 1: cohort tagging for re-admission events (closure-captured scanner may be null before init).
      // Why: logicalPair 는 호출자에 따라 tokenMint (line 769) 또는 pairAddress (line 945) 일 수 있으므로
      //      양쪽 lookup 을 모두 시도한다.
      const readdedEntry =
        scanner?.getEntry(logicalPair) ?? scanner?.getEntryByPairAddress(logicalPair);
      runtimeDiagnosticsTracker.recordCandidateReadded(
        logicalPair,
        'within_grace',
        readdedEntry?.cohort
      );
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
  const removeRealtimePoolTarget = (logicalPair: string, opts?: { immediate?: boolean }) => {
    const existing = realtimePoolTargets.get(logicalPair);
    realtimePoolTargets.delete(logicalPair);
    if (existing) {
      realtimePoolMetadata.delete(existing);
      heliusIngester?.clearPoolMetadata(existing);

      // Why: idle eviction은 10분 무활동 pair → 재진입 가능성 ≈ 0 → grace 불필요, 즉시 해제
      if (opts?.immediate) {
        realtimePoolAliases.delete(existing);
        void heliusIngester?.unsubscribePools([existing]);
        zombiePoolBlacklist.set(existing, Date.now());
        return;
      }

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

  // 2026-04-11: Sandbox Executor (Strategy D live 전용, main wallet 격리)
  let sandboxExecutor: Executor | null = null;
  if (config.sandboxWalletKey && config.strategyDLiveEnabled) {
    sandboxExecutor = new Executor({
      ...executorConfig,
      walletPrivateKey: config.sandboxWalletKey,
    });
    log.info('Sandbox executor initialized for Strategy D live');
  }

  // ─── Phase 3: Wallet Manager (main + sandbox isolation) ───
  await walletManager.initDailyPnlStore();

  // ─── Phase 1B: Regime Filter + Paper Metrics ────────
  const regimeFilter = new RegimeFilter();
  const paperMetrics = new PaperMetricsTracker();

  const healthMonitor = new HealthMonitor();
  healthMonitor.setDbConnected(true);
  healthMonitor.start();

  // 2026-04-17: Wallet Stop Guard (override 가드레일 #2)
  // live 모드에서만 poller 시작. paper 에서는 wallet balance 의미 없음.
  if (config.walletStopGuardEnabled && tradingMode === 'live') {
    startWalletStopGuard(walletManager, notifier, {
      minWalletSol: config.walletStopMinSol,
      pollIntervalMs: config.walletStopPollIntervalMs,
      walletName: config.walletStopWalletName,
      rpcFailSafeThreshold: config.walletStopRpcFailSafeThreshold,
    });
  } else {
    log.info(
      `[WALLET_STOP] guard ${config.walletStopGuardEnabled ? 'skipped (paper mode)' : 'disabled (config)'}`
    );
  }
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
      // 2026-04-11: Strategy D live via sandbox Executor (main wallet 격리)
      if (effectiveMode === 'live' && config.strategyDLiveEnabled && sandboxExecutor) {
        // 2026-04-17 Block 1.5-2: halt check — integrity 실패 후 새 entry 차단
        if (isEntryHaltActive('strategy_d')) {
          log.warn(`[STRATEGY_D_HALT] skipping entry — entry halt active. Call resetEntryHalt('strategy_d') after reconciliation.`);
          return;
        }
        try {
          log.info(
            `[STRATEGY_D_LIVE] Executing via sandbox: ${prepared.candidate!.tokenSymbol ?? order.pairAddress.slice(0, 12)} ` +
            `ticket=${order.quantity.toFixed(4)} SOL`
          );
          const buyResult = await sandboxExecutor.executeBuy(order);
          log.info(
            `[STRATEGY_D_LIVE] Filled: sig=${buyResult.txSignature.slice(0, 16)} ` +
            `slip=${buyResult.slippageBps}bps qty=${buyResult.actualOutUiAmount ?? 'unknown'}`
          );
          // DB record — shared integrity helper (2026-04-17)
          const persistResult = await persistOpenTradeWithIntegrity({
            ctx,
            lane: 'strategy_d',
            tradeData: {
              pairAddress: order.pairAddress,
              strategy: 'new_lp_sniper',
              side: 'BUY',
              tokenSymbol: signal.tokenSymbol,
              entryPrice: order.price,
              quantity: order.quantity,
              stopLoss: order.stopLoss,
              takeProfit1: order.takeProfit1,
              takeProfit2: order.takeProfit2,
              trailingStop: undefined,
              highWaterMark: order.price,
              timeStopAt: new Date(Date.now() + (order.timeStopMinutes ?? 15) * 60_000),
              status: 'OPEN',
              txSignature: buyResult.txSignature,
              createdAt: new Date(),
            },
            ledgerEntry: {
              txSignature: buyResult.txSignature,
              strategy: 'new_lp_sniper',
              pairAddress: order.pairAddress,
              tokenSymbol: signal.tokenSymbol,
              plannedEntryPrice: order.price,
              actualEntryPrice: order.price,
              actualQuantity: order.quantity,
              slippageBps: buyResult.slippageBps,
            },
            notifierKey: 'strategy_d_open_persist',
            buildNotifierMessage: (err) =>
              `strategy_d entry persist FAILED after tx=${buyResult.txSignature.slice(0, 16)} ` +
              `pair=${order.pairAddress.slice(0, 12)} — sandbox. err=${err}`,
          });
          if (!persistResult.dbTradeId) return;
          walletManager.recordPnl('sandbox', 0);
          await notifier.sendInfo(
            `[Strategy D Live] ${prepared.candidate!.tokenSymbol ?? 'unknown'} ` +
            `BUY ${order.quantity.toFixed(4)} SOL via sandbox`,
            'trade'
          ).catch(() => {});
        } catch (execErr) {
          log.warn(`[STRATEGY_D_LIVE] Execution failed: ${execErr}`);
          await notifier.sendError('strategy_d_live', execErr).catch(() => {});
        }
      } else if (effectiveMode === 'live' && config.strategyDLiveEnabled && !sandboxExecutor) {
        log.warn(
          `[STRATEGY_D_LIVE] Signal detected but SANDBOX_WALLET_PRIVATE_KEY not configured. ` +
          `Skipping. pair=${order.pairAddress.slice(0, 12)}`
        );
      }
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
      // Why: idle eviction은 WS slot 순환 목적 → realtime 모드에서만 활성화
      idleEvictionMs: realtimeModeEnabled ? config.scannerIdleEvictionMs : 0,
      idleEvictionSweepIntervalMs: config.scannerIdleEvictionSweepIntervalMs,
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
        // Why: Phase 1 fresh-cohort instrumentation — pre-watchlist reject 도 cohort tagging.
        //      여기서는 evaluateCandidate 이전이므로 WatchlistEntry 가 없어 cohort 를 즉석 판정한다.
        const rawPoolCreatedAt =
          typeof token.raw?.pool_created_at === 'string' ? token.raw.pool_created_at : undefined;
        const pairCreatedAtMs = rawPoolCreatedAt ? Date.parse(rawPoolCreatedAt) : NaN;
        const cohort: Cohort = resolveCohortFromSources({
          birdeyeUpdatedAt: token.updatedAt,
          pairCreatedAtMs: Number.isFinite(pairCreatedAtMs) ? pairCreatedAtMs : null,
        });
        if (isOperatorBlacklisted(token.address) || isOperatorBlacklisted(pairAddress)) {
          runtimeDiagnosticsTracker.recordPreWatchlistReject({
            tokenMint: token.address,
            reason: 'operator_blacklist',
            detail: pairAddress && isOperatorBlacklisted(pairAddress) ? 'pair_address' : 'token_mint',
            source: discoverySource,
            dexId,
            cohort,
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
            cohort,
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
                cohort,
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
                cohort: entry.cohort,
              });
              // Block 2 (2026-04-18): coverage telemetry — 실제 어떤 DEX/mint 가 skip 되는지 persist.
              void logAdmissionSkipDex({
                reason: 'no_pairs',
                detail: pairs.length === 0 ? 'resolver_miss' : 'empty_pairs',
                tokenMint: entry.tokenMint,
                dexId: bestPair?.dexId,
                samplePair: bestPair?.pairAddress,
                resolvedPairsCount: pairs.length,
                source: entry.discoverySource,
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
                cohort: entry.cohort,
              });
              // Block 2 (2026-04-18): coverage telemetry.
              void logAdmissionSkipDex({
                reason: realtimeEligibility.reason,
                detail: admissionSkipDetail,
                tokenMint: entry.tokenMint,
                dexId: admissionPairs[0]?.dexId ?? pairs[0]?.dexId,
                samplePair: admissionPairs[0]?.pairAddress ?? pairs[0]?.pairAddress,
                resolvedPairsCount: pairs.length,
                admissionPairsCount: admissionPairs.length,
                source: entry.discoverySource,
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
        cohort: entry.cohort,
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

      // Gate cache pre-warm: tick mode에서 signal 도착 전 security/liquidity 사전 적재
      if (ctx.gateCache && ctx.onchainSecurityClient) {
        void (async () => {
          const [secData, exitData] = await Promise.all([
            ctx.onchainSecurityClient!.getTokenSecurityDetailed(entry.tokenMint),
            ctx.onchainSecurityClient!.getExitLiquidity(entry.tokenMint),
          ]);
          ctx.gateCache!.set(entry.tokenMint, { tokenSecurityData: secData, exitLiquidityData: exitData });
        })().catch(() => {});
      }

      // Tier 1 (2026-04-17): Migration Handoff Reclaim detection
      // Why: pumpfun graduation → PumpSwap canonical pool 이벤트는 scanner 의
      // candidateDiscovered 시점에 dexId=pumpswap 이고 tokenAgeHours 가 작은 pair 로 나타난다.
      // 정확한 on-chain tx decode 는 후속 작업 — 현재는 heuristic (dexId + age) 기반.
      if (config.migrationLaneEnabled) {
        const ageHours = entry.poolInfo?.tokenAgeHours ?? 999;
        const isPumpSwap = isPumpSwapDexId(entry.dexId);
        const isFreshEnough = ageHours <= 0.25; // 15분 이내
        if (isPumpSwap && isFreshEnough) {
          // Why: universe/candle builder 는 tokenMint 를 primary key 로 사용 (line 944 참조)
          // 하지만 pairAddress 기반 경로도 있어 둘 다 시도. 첫 candle 도착 전이면 price=null →
          // 10초 간격 최대 6회 (60초) retry. 60초 이후는 migration edge 판정 시간 내 (900s) 충분.
          const candleKey = entry.tokenMint;
          const eventSignature = `migration-${candleKey}`;
          const firstRegisteredAt = Math.floor(Date.now() / 1000);
          const attemptRegister = (attemptsLeft: number): void => {
            const candlePrice =
              realtimeCandleBuilder?.getCurrentPrice(candleKey) ??
              realtimeCandleBuilder?.getCurrentPrice(entry.pairAddress);
            if (candlePrice && candlePrice > 0) {
              const ageSec = Math.floor(ageHours * 3600);
              const event: MigrationEvent = {
                kind: 'pumpswap_canonical_init',
                pairAddress: candleKey,
                tokenSymbol: entry.symbol,
                eventPrice: candlePrice,
                eventTimeSec: firstRegisteredAt - ageSec,
                signature: eventSignature, // idempotent — retry 해도 중복 방지
              };
              log.info(
                `[MIG_CANDIDATE] ${entry.symbol} pair=${candleKey.slice(0, 12)} ` +
                `ageHours=${ageHours.toFixed(3)} price=${candlePrice.toFixed(8)} (SOL axis)`
              );
              onMigrationEvent(event, ctx);
              return;
            }
            if (attemptsLeft > 0) {
              setTimeout(() => attemptRegister(attemptsLeft - 1), 10_000);
            } else {
              log.debug(`[MIG_CANDIDATE_TIMEOUT] ${entry.symbol} no candle price after 60s — skip`);
            }
          };
          attemptRegister(6);
        }
      }
    });
    scanner.on('candidateEvicted', (tokenMint: string, reason?: string, detail?: string, cohort?: Cohort) => {
      log.info(`Scanner: evicted ${tokenMint} reason=${reason ?? 'score'}`);
      runtimeDiagnosticsTracker.recordCandidateEvicted({
        tokenMint,
        reason,
        detail: detail != null
          ? `${detail}|immediate=${reason === 'idle'}`
          : `immediate=${reason === 'idle'}`,
        cohort,
      });
      // Why: idle eviction은 10분 무활동 → 재진입 가능성 ≈ 0 → grace 우회하여 즉시 slot 해제
      removeRealtimePoolTarget(tokenMint, { immediate: reason === 'idle' });
      ingester.removePair(tokenMint);
      universeEngine.removePool(tokenMint);
      bootstrapTriggerRef?.clearPoolContext(tokenMint);
      tickTriggerRef?.clearPoolContext(tokenMint);
      // Why: evicted token의 stale security data 방지 — 재발견 시 fresh fetch 강제
      ctx.gateCache?.invalidate(tokenMint);
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
    // 2026-04-11: Strategy D sandbox executor (isSandboxStrategy trade 의 sell 에 사용)
    sandboxExecutor: sandboxExecutor ?? undefined,
    // 2026-04-11: Gate cache for tick mode — security/liquidity fetch 재사용 (30s TTL)
    gateCache: config.realtimeTriggerMode === 'tick' ? new GateCacheManager(30_000) : undefined,
  };

  // Block 1 (2026-04-18): lane wallet mode resolution — 시작 시 명시적으로 로그 + fail-fast validate.
  // Why: Layer 5 bottleneck 에서 cupsey wallet ownership 이 암묵적이라 확정 불가했음.
  // Block 1 QA fix: sandbox 모드인데 sandbox executor 없으면 startup 단계에서 즉시 실패 (runtime-late failure 방지).
  const assertSandboxAvailable = (lane: string, mode: 'auto' | 'main' | 'sandbox'): void => {
    if (mode === 'sandbox' && !sandboxExecutor) {
      throw new Error(
        `${lane} wallet mode='sandbox' but sandbox executor not initialized. ` +
        `Check SANDBOX_WALLET_PRIVATE_KEY and STRATEGY_D_LIVE_ENABLED, or switch ${lane} to mode='main'.`
      );
    }
  };
  if (config.cupseyLaneEnabled) {
    assertSandboxAvailable('CUPSEY', config.cupseyWalletMode);
    const cupseyLabel = resolveCupseyWalletLabel(ctx);
    log.info(
      `[CUPSEY_WALLET] mode='${config.cupseyWalletMode}' resolved='${cupseyLabel}' ` +
      `(sandbox_available=${Boolean(sandboxExecutor)})`
    );
  }
  if (config.migrationLaneEnabled) {
    assertSandboxAvailable('MIGRATION', config.migrationWalletMode);
    const migrationLabel = resolveMigrationWalletLabel(ctx);
    log.info(
      `[MIGRATION_WALLET] mode='${config.migrationWalletMode}' resolved='${migrationLabel}' ` +
      `(sandbox_available=${Boolean(sandboxExecutor)})`
    );
  }
  if (config.pureWsLaneEnabled) {
    assertSandboxAvailable('PUREWS', config.pureWsLaneWalletMode);
    const pureWsLabel = resolvePureWsWalletLabel(ctx);
    log.info(
      `[PUREWS_WALLET] mode='${config.pureWsLaneWalletMode}' resolved='${pureWsLabel}' ` +
      `(sandbox_available=${Boolean(sandboxExecutor)})`
    );
  }

  // Block 1 (2026-04-18): Always-on wallet delta comparator
  // Why: 2026-04-17 wallet-reconcile 에서 DB pnl 허수 drift +18.34 SOL 사후 발견.
  // 운영 중 상시 감지 경로를 추가한다. live 모드에서만 작동 (paper 는 wallet 변화 없음).
  if (config.walletDeltaComparatorEnabled && tradingMode === 'live') {
    void startWalletDeltaComparator(walletManager, notifier, {
      enabled: true,
      pollIntervalMs: config.walletDeltaPollIntervalMs,
      driftWarnSol: config.walletDeltaDriftWarnSol,
      driftHaltSol: config.walletDeltaDriftHaltSol,
      minSamplesBeforeAlert: config.walletDeltaMinSamplesBeforeAlert,
      walletName: config.walletStopWalletName,
      realtimeDataDir: config.realtimeDataDir,
    });
  } else {
    log.info(
      `[WALLET_DELTA] comparator ${config.walletDeltaComparatorEnabled ? 'skipped (paper mode)' : 'disabled (config)'}`
    );
  }

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
    // tick 모드는 candle trigger 불필요 — swap handler에서 TickTrigger 직접 평가
    let trigger: MomentumTrigger | VolumeMcapSpikeTrigger;

    // Why: tick mode에서도 candle trigger는 bootstrap으로 초기화 (ATR/history 전용, eval은 skip)
    if (config.realtimeTriggerMode === 'tick') {
      const tickTrigger = new TickTrigger(
        {
          windowSec: config.tickTriggerWindowSec,
          burstSec: config.tickTriggerBurstSec,
          volumeSurgeMultiplier: config.tickTriggerVolumeSurgeMultiplier,
          minBuyRatio: config.tickTriggerMinBuyRatio,
          cooldownSec: config.tickTriggerCooldownSec,
          sparseMinSwaps: config.tickTriggerSparseMinSwaps,
          volumeMcapBoostThreshold: config.tickTriggerVolumeMcapBoostThreshold,
          volumeMcapBoostMultiplier: config.tickTriggerVolumeMcapBoostMultiplier,
        },
        (s) => {
          runtimeDiagnosticsTracker.recordTriggerStats(
            `evals=${s.evaluations} signals=${s.signals} insuffSwaps=${s.insufficientSwaps} ` +
            `volInsuf=${s.volumeInsufficient} lowBuyRatio=${s.lowBuyRatio} cooldown=${s.cooldown} ` +
            `boosted=${s.volumeMcapBoosted} sparseRef=${s.sparseReference}`,
            'tick_trigger',
          );
        },
      );
      for (const pool of universeEngine.getWatchlist()) {
        if (pool.marketCap !== undefined) {
          tickTrigger.setPoolContext(pool.pairAddress, { marketCap: pool.marketCap });
        }
      }
      tickTriggerRef = tickTrigger;
      // Why: tick mode에서도 candle-based trigger는 필요 (ATR 계산, candle persistence)
      // bootstrap trigger를 dummy로 초기화하되 candle handler에서 eval은 skip
      const dummyBootstrap = new VolumeMcapSpikeTrigger({
        primaryIntervalSec: config.realtimePrimaryIntervalSec,
        volumeSurgeLookback: config.realtimeVolumeSurgeLookback,
        volumeSurgeMultiplier: config.realtimeVolumeSurgeMultiplier,
        cooldownSec: config.realtimeCooldownSec,
        minBuyRatio: config.realtimeBootstrapMinBuyRatio,
        atrPeriod: 14,
      });
      trigger = dummyBootstrap;
      log.info(`Trigger: tick (vm=${config.tickTriggerVolumeSurgeMultiplier}, br=${config.tickTriggerMinBuyRatio}, burst=${config.tickTriggerBurstSec}s)`);
    } else if (config.realtimeTriggerMode === 'bootstrap') {
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
          // Why: per-pair idle offender top-5를 detail에 포함 → sparseOpsSummary.extractTopIdleOffenders()에서 파싱
          let detail =
            `evals=${s.evaluations} signals=${s.signals}(sparse=${s.sparseSignals} boosted=${s.volumeMcapBoosted}) insuffCandles=${s.insufficientCandles} ` +
            `volInsuf=${s.volumeInsufficient} sparseInsuf=${s.sparseDataInsufficient} lowBuyRatio=${s.lowBuyRatio} cooldown=${s.cooldown} ` +
            `idleSkip=${s.idlePairSkipped ?? 0} activePairs=${s.perPairEvaluations?.size ?? 0} sparsePairs=${s.perPairSparseInsuf?.size ?? 0}`;
          if (s.perPairIdleSkip && s.perPairIdleSkip.size > 0) {
            const topIdle = [...s.perPairIdleSkip.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([p, count]) => `${p}=${count}`)
              .join(',');
            detail += ` topIdleSkip: ${topIdle}`;
          }
          runtimeDiagnosticsTracker.recordTriggerStats(detail, 'bootstrap_trigger');
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
      // Why: idle eviction — non-zero swap이면 pair activity 갱신
      if (scanner && swap.amountQuote > 0) {
        scanner.updateActivity(logicalPair);
      }
      // [Tick Mode] swap마다 즉시 trigger 평가 — candle close 대기 없음
      if (config.realtimeTriggerMode === 'tick' && tickTriggerRef) {
        if (!ctx.riskManager.isCapSuppressed(logicalPair)) {
          const signal = tickTriggerRef.onTick({
            pool: logicalPair,
            amountQuote: swap.amountQuote,
            side: swap.side,
            priceNative: swap.priceNative,
            timestamp: swap.timestamp ?? Date.now(),
          });
          if (signal) {
            log.info(`🎯 Tick signal: ${signal.strategy} ${signal.pairAddress.slice(0, 12)}… price=${signal.price} vr=${signal.meta.volumeRatio?.toFixed(1)}`);
            void handleRealtimeSignal(signal, realtimeCandleBuilder!, ctx).catch((err) => {
              log.error(`Tick signal handling failed: ${err}`);
              notifier.sendError('tick_signal', err).catch(() => {});
            });
            if (config.cupseyLaneEnabled) {
              void handleCupseyLaneSignal(signal, realtimeCandleBuilder!, ctx).catch((err) => {
                log.error(`Tick cupsey signal handling failed: ${err}`);
              });
            }
            // Block 3 (2026-04-18): pure_ws_breakout lane — 같은 signal 소비, 별도 state machine.
            if (config.pureWsLaneEnabled) {
              void handlePureWsSignal(signal, realtimeCandleBuilder!, ctx).catch((err) => {
                log.error(`Tick purews signal handling failed: ${err}`);
              });
            }
          }
        }
        // Tick-level position monitoring: 활성 포지션의 swap → 즉시 SL/TP 체크
        void checkTickLevelExit(logicalPair, swap.priceNative, ctx).catch((err) => {
          log.warn(`Tick position monitor error: ${err}`);
        });
        // Cupsey position update on each swap (tick mode only)
        if (config.cupseyLaneEnabled) {
          void updateCupseyPositions(ctx, realtimeCandleBuilder!).catch(() => {});
        }
        if (config.pureWsLaneEnabled) {
          void updatePureWsPositions(ctx, realtimeCandleBuilder!).catch(() => {});
        }
      }
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
        // Trigger evaluation: tick mode에서는 swap handler에서 이미 평가 → candle trigger skip
        if (config.realtimeTriggerMode !== 'tick') {
          const signal = trigger.onCandle(candle, realtimeCandleBuilder!);
          if (signal) {
            log.info(`🎯 Signal fired: ${signal.strategy} ${signal.pairAddress.slice(0, 12)}… price=${signal.price} vr=${signal.meta.volumeRatio?.toFixed(1)}`);
            await handleRealtimeSignal(signal, realtimeCandleBuilder!, ctx);
            // Path A (2026-04-11): cupsey-inspired lane — 같은 signal, 별도 post-entry state machine.
            // 기존 handleRealtimeSignal 과 독립적으로 실행. sandbox ticket, main core 오염 없음.
            if (config.cupseyLaneEnabled) {
              await handleCupseyLaneSignal(signal, realtimeCandleBuilder!, ctx);
            }
            // Block 3 (2026-04-18): pure_ws_breakout lane — convexity-aligned separate state machine.
            if (config.pureWsLaneEnabled) {
              await handlePureWsSignal(signal, realtimeCandleBuilder!, ctx);
            }
          }
        }
        // Path A: cupsey position monitoring (매 candle tick 마다)
        if (config.cupseyLaneEnabled) {
          await updateCupseyPositions(ctx, realtimeCandleBuilder!);
        }
        if (config.pureWsLaneEnabled) {
          await updatePureWsPositions(ctx, realtimeCandleBuilder!);
        }
        // DEX_TRADE Phase 1.3: v2 detector 독립 scan (candle close 마다 watchlist 전체 평가)
        // bootstrap signal 과 별개 경로. pureWsV2Enabled=true + pureWsLaneEnabled=true 일 때만 작동.
        if (config.pureWsV2Enabled && config.pureWsLaneEnabled) {
          const watchlistEntries = universeEngine.getWatchlist();
          const pairs = watchlistEntries.map((e) => e.pairAddress);
          const symByPair = new Map<string, string | undefined>(
            watchlistEntries.map((e) => [e.pairAddress, e.symbol])
          );
          await scanPureWsV2Burst(ctx, realtimeCandleBuilder!, pairs, symByPair).catch((err) => {
            log.warn(`Pure WS v2 scan failed: ${err}`);
          });
        }
        // Tier 1 (2026-04-17): migration handoff reclaim lane. candle tick 경로만 사용 (race 예방).
        if (config.migrationLaneEnabled) {
          await updateMigrationPositions(ctx, realtimeCandleBuilder!);
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
      await tradeStore.closeTrade({
        id: openTrade.id,
        exitPrice: resolvedExitPrice,
        pnl,
        slippage: 0,
        exitReason,
      });
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

  if (config.cupseyLaneEnabled) {
    const recoveredCupseyCount = await recoverCupseyOpenPositions(ctx);
    if (recoveredCupseyCount > 0) {
      await notifier.sendInfo(
        `Cupsey recovery: ${recoveredCupseyCount} OPEN trades rehydrated from ledger`,
        'recovery'
      ).catch(() => {});
    }
  }

  if (config.migrationLaneEnabled) {
    const recoveredMigrationCount = await recoverMigrationOpenPositions(ctx);
    if (recoveredMigrationCount > 0) {
      await notifier.sendInfo(
        `Migration recovery: ${recoveredMigrationCount} OPEN trades rehydrated from ledger`,
        'recovery'
      ).catch(() => {});
    }
  }

  // Block 3 (2026-04-18): pure_ws_breakout lane recovery
  if (config.pureWsLaneEnabled) {
    const recoveredPureWsCount = await recoverPureWsOpenPositions(ctx);
    if (recoveredPureWsCount > 0) {
      await notifier.sendInfo(
        `Pure WS recovery: ${recoveredPureWsCount} OPEN trades rehydrated`,
        'recovery'
      ).catch(() => {});
    }
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
      // Bootstrap/Tick trigger mcap context 갱신
      if (bootstrapTriggerRef) {
        for (const pool of pools) {
          if (pool.marketCap !== undefined) {
            bootstrapTriggerRef.setPoolContext(pool.pairAddress, { marketCap: pool.marketCap });
          }
        }
      }
      if (tickTriggerRef) {
        for (const pool of pools) {
          if (pool.marketCap !== undefined) {
            tickTriggerRef.setPoolContext(pool.pairAddress, { marketCap: pool.marketCap });
          }
        }
      }
    });
    log.info('Real-time Helius pipeline started');
  }

  // Path B2 (2026-04-11): KOL wallet tracker — cupsey wallet buy 감지 → scanner watchlist 추가
  if (config.kolWalletTrackingEnabled && config.kolWalletAddresses.length > 0 && scanner) {
    const { KolWalletTracker } = await import('./discovery/kolWalletTracker');
    const kolTracker = new KolWalletTracker({
      rpcUrl: config.solanaRpcUrl,
      walletAddresses: config.kolWalletAddresses,
    });
    kolTracker.on('buy', (signal: { tokenMint: string; estimatedPrice: number; walletAddress: string }) => {
      log.info(
        `[KOL_DISCOVERY] ${signal.walletAddress.slice(0, 8)} → ${signal.tokenMint.slice(0, 12)} ` +
        `price=${signal.estimatedPrice.toFixed(8)} — adding to scanner`
      );
      scanner!.addManualEntry(
        signal.tokenMint,
        signal.tokenMint, // pairAddress = tokenMint (scanner 가 pair resolve)
        `KOL:${signal.walletAddress.slice(0, 8)}`
      );
    });
    kolTracker.on('error', ({ wallet, error }: { wallet: string; error: unknown }) => {
      log.warn(`KOL tracker error for ${wallet.slice(0, 8)}: ${error}`);
    });
    await kolTracker.start();
    log.info(`KOL wallet tracker started: ${config.kolWalletAddresses.length} wallets`);
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
    stopWalletStopGuardPoller();
    stopWalletDeltaComparator();
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
