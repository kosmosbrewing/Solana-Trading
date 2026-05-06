import { Pool } from 'pg';
import { config } from './utils/config';
import { createModuleLogger } from './utils/logger';
import { HealthMonitor } from './utils/healthMonitor';
import { checkAllLanesAutoResetHalt, hydrateCanaryAutoHaltFromLedger } from './risk/canaryAutoHalt';
import { enforceTicketPolicyForAllLanes } from './utils/policyGuards';
import { Candle, Signal } from './utils/types';

import {
  GeckoTerminalClient,
  Ingester,
  IngesterConfig,
  OnchainSecurityClient,
} from './ingester';
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
  createScannerBlacklistCheck,
  resolveCohortFromSources,
  type Cohort,
} from './scanner';
import { ExecutionLock, PositionStore, runRecovery } from './state';
import { SignalAuditLogger } from './audit';
import { scheduleDailySummary } from './orchestration/reporting';
import { handleNewCandle } from './orchestration/candleHandler';
import { handleRealtimeSignal } from './orchestration/realtimeHandler';
import { handleCupseyLaneSignal, updateCupseyPositions } from './orchestration/cupseyLaneHandler';
import {
  handlePureWsSignal,
  updatePureWsPositions,
  resolvePureWsWalletLabel,
  scanPureWsV2Burst,
  logPureWsV2TelemetrySummary,
  isPureWsNewPairWatchlistEntry,
} from './orchestration/pureWsBreakoutHandler';
import { updateMigrationPositions, onMigrationEvent } from './orchestration/migrationLaneHandler';
import type { MigrationEvent } from './strategy/migrationHandoffReclaim';
import { isPumpSwapDexId } from './realtime/pumpSwapParser';
import { logAdmissionSkipDex } from './realtime/admissionSkipLogger';
import { startWalletStopGuard } from './risk/walletStopGuard';
import { startWalletDeltaComparator } from './risk/walletDeltaComparator';
import { createWalletExternalDeltaClassifier } from './risk/walletExternalDeltaClassifier';
import { startJupiter429SummaryLoop } from './observability/jupiterRateLimitMetric';
// 2026-04-23 Option 5: KOL Discovery
import { Connection } from '@solana/web3.js';
import { initKolDb, getKolDbStats } from './kol/db';
import { initDevWalletRegistry, getDevWalletRegistryStats } from './observability/devWalletRegistry';
import { KolWalletTracker } from './ingester/kolWalletTracker';
import { startKolTrackerWithPreparedHunter } from './init/kolHunterStartup';
import {
  handleKolSwap,
  hydrateLiveExecutionQualityCooldownsFromLedger,
  hydrateTradeMarkoutsFromLedger,
  initKolHunter,
  setHeliusPoolRegistryForKolHunter,
} from './orchestration/kolSignalHandler';
import { initKolPaperNotifier } from './orchestration/kolPaperNotifier';
import { resolveCupseyWalletLabel } from './orchestration/cupseyLaneHandler';
import { resolveMigrationWalletLabel } from './orchestration/migrationLaneHandler';
import { persistOpenTradeWithIntegrity, isEntryHaltActive } from './orchestration/entryIntegrity';
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
import {
  SCANNER_INGESTER_QUEUE_GAP_MS,
  REGIME_SOL_CACHE_TTL_MS,
  REALTIME_ADMISSION_MIN_OBSERVED,
  REALTIME_ADMISSION_MIN_PARSE_RATE_PCT,
  REALTIME_ADMISSION_MIN_SKIPPED_RATE_PCT,
  buildHeliusWsUrl,
  getRealtimeSeedLookbackSec,
  formatRealtimeEligibilityContext,
} from './init/mainConstants';
import { runLaneRecoveries } from './init/runLaneRecoveries';
import { setupShutdown } from './init/setupShutdown';

const log = createModuleLogger('Main');

async function realtimeCandleStage<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error) {
      (err as Error & { realtimeCandleStage?: string }).realtimeCandleStage = stage;
    }
    throw err;
  }
}

function withRealtimeCandleStage(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const stage = (error as Error & { realtimeCandleStage?: string }).realtimeCandleStage;
  if (!stage) return error;
  const staged = new Error(`stage=${stage}: ${error.message}`);
  staged.stack = error.stack;
  return staged;
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
  // 2026-05-01 (Helius Stream X1): KOL Hunter 의 token quality observer 가 registry 사용.
  //   EXIT_LIQUIDITY_UNKNOWN / POOL_NOT_PREWARMED flag 정확도 향상 (registry hit 시 POOL flag 미발사).
  setHeliusPoolRegistryForKolHunter(heliusPoolRegistry);
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

  // 2026-04-11: Sandbox Executor — main wallet 격리.
  // 2026-04-26 cleanup: Strategy D 제거됐지만 cupseyLaneHandler 의 CUPSEY_WALLET_MODE=sandbox 에서 여전히 사용.
  let sandboxExecutor: Executor | null = null;
  if (config.sandboxWalletKey) {
    sandboxExecutor = new Executor({
      ...executorConfig,
      walletPrivateKey: config.sandboxWalletKey,
    });
    log.info('Sandbox executor initialized (cupsey sandbox mode)');
  }

  // ─── Phase 3: Wallet Manager (main + sandbox isolation) ───
  await walletManager.initDailyPnlStore();

  // ─── Phase 1B: Regime Filter + Paper Metrics ────────
  const regimeFilter = new RegimeFilter();
  const paperMetrics = new PaperMetricsTracker();

  const healthMonitor = new HealthMonitor();
  healthMonitor.setDbConnected(true);
  healthMonitor.start();

  // 2026-04-21 (QA F5) — Ticket size policy enforcement.
  // Why: behavioral drift 방지. Mission refinement 의 Real Asset Guard 정책값 `0.01 SOL`
  // 을 env override 만으로 쉽게 바꿀 수 있으면, bleeding 중에 "한 번만" 키우고 싶은
  // 심리에 굴복 → convexity 파괴. 의도적 마찰 추가:
  //   - POLICY_TICKET_MAX_SOL 초과 + ack 없음 → 강제 0.01 로 복원 + Telegram critical
  //   - 정당한 Stage 4 확대 시 {LANE}_TICKET_OVERRIDE_ACK=stage4_approved_YYYY_MM_DD 필요
  const ticketPolicyResults = enforceTicketPolicyForAllLanes([
    {
      lane: 'pure_ws',
      configuredTicketSol: config.pureWsLaneTicketSol,
      ackEnvName: 'PUREWS_TICKET_OVERRIDE_ACK',
      ackEnvValue: process.env.PUREWS_TICKET_OVERRIDE_ACK,
    },
    {
      lane: 'cupsey',
      configuredTicketSol: config.cupseyLaneTicketSol,
      ackEnvName: 'CUPSEY_TICKET_OVERRIDE_ACK',
      ackEnvValue: process.env.CUPSEY_TICKET_OVERRIDE_ACK,
    },
    {
      lane: 'migration',
      configuredTicketSol: config.migrationLaneTicketSol,
      ackEnvName: 'MIGRATION_TICKET_OVERRIDE_ACK',
      ackEnvValue: process.env.MIGRATION_TICKET_OVERRIDE_ACK,
    },
    {
      // 2026-04-26: pure_ws_swing_v2 live canary 도 Real Asset Guard 정책 일괄 적용.
      lane: 'pure_ws_swing_v2',
      configuredTicketSol: config.pureWsSwingV2TicketSol,
      ackEnvName: 'PUREWS_SWING_V2_TICKET_OVERRIDE_ACK',
      ackEnvValue: process.env.PUREWS_SWING_V2_TICKET_OVERRIDE_ACK,
    },
    {
      // 2026-04-28: kol_hunter 도 Real Asset Guard 정책 enforcement 등록.
      // policyGuards.POLICY_TICKET_MAX_SOL_BY_LANE.kol_hunter = 0.03 (lane-specific cap).
      // 운영자가 0.03 초과로 env override 시 ack 필요. ack 부재 시 0.03 으로 강제 복원.
      lane: 'kol_hunter',
      configuredTicketSol: config.kolHunterTicketSol,
      ackEnvName: 'KOL_HUNTER_TICKET_OVERRIDE_ACK',
      ackEnvValue: process.env.KOL_HUNTER_TICKET_OVERRIDE_ACK,
    },
  ]);

  // 정책 위반 시 config 값 강제 복원 + Telegram critical alert 1회.
  // config 는 readonly 가 아니라 runtime mutation 가능. 이후 모든 사용처가 갱신값 참조.
  for (const result of ticketPolicyResults) {
    if (result.violation) {
      if (result.lane === 'pure_ws') {
        (config as { pureWsLaneTicketSol: number }).pureWsLaneTicketSol = result.effectiveTicketSol;
      } else if (result.lane === 'cupsey') {
        (config as { cupseyLaneTicketSol: number }).cupseyLaneTicketSol = result.effectiveTicketSol;
      } else if (result.lane === 'migration') {
        (config as { migrationLaneTicketSol: number }).migrationLaneTicketSol = result.effectiveTicketSol;
      } else if (result.lane === 'pure_ws_swing_v2') {
        (config as { pureWsSwingV2TicketSol: number }).pureWsSwingV2TicketSol = result.effectiveTicketSol;
      } else if (result.lane === 'kol_hunter') {
        (config as { kolHunterTicketSol: number }).kolHunterTicketSol = result.effectiveTicketSol;
      }
      if (result.criticalMessage) {
        notifier.sendCritical(
          `policy_violation_ticket_${result.lane}`,
          result.criticalMessage
        ).catch(() => {});
      }
    }
  }

  // 2026-04-21 mission refinement: 실행 시 Real Asset Guard effective 값 한 줄 로그.
  // Why: 정책값과 env override 간 괴리 발생해도 startup log 에서 즉시 확인 가능하게.
  // 이 로그는 판단/관측 guard 가 아닌 실 자산 보호 guard 의 한정된 집합만 출력.
  // 위 F5 policy enforcement 이후이므로 effective 값 반영.
  log.info(
    `[REAL_ASSET_GUARD] walletFloor=${config.walletStopMinSol} ` +
    `canaryLossCap=-${config.canaryMaxBudgetSol} ` +
    `canaryMaxTrades=${config.canaryMaxTrades} ` +
    `kolCanaryLossCap=-${config.kolHunterCanaryMaxBudgetSol} ` +
    `kolCanaryMaxTrades=${config.kolHunterCanaryMaxTrades} ` +
    `maxConcurrent=${config.pureWsMaxConcurrent} ` +
    `ticketSol=${config.pureWsLaneTicketSol} ` +
    `kolTicketSol=${config.kolHunterTicketSol} ` +
    `canaryHydrateLookbackH=${config.canaryAutoHaltHydrateLookbackHours} ` +
    `mode=${tradingMode}${config.pureWsLiveCanaryEnabled ? '_canary' : ''}`
  );

  // 2026-04-26 사명 §3 phase gate 인지 알림.
  // Live canary flag 가 켜져 있으면 운영자에게 경고 — Stage 4 SCALE 충족 (200 paper trades + 5x+ winner) 의무.
  // 코드는 운영자 판단을 신뢰 (auto-block 안 함) 하지만 startup log 로 명시 알림.
  if (tradingMode === 'live') {
    const liveLanesEnabled: string[] = [];
    if (config.pureWsLiveCanaryEnabled) liveLanesEnabled.push('PUREWS_LIVE_CANARY');
    if (config.pureWsSwingV2LiveCanaryEnabled) liveLanesEnabled.push('PUREWS_SWING_V2_LIVE_CANARY');
    if (config.cupseyLaneEnabled) liveLanesEnabled.push('CUPSEY_LANE');
    if (config.migrationLaneEnabled && !config.migrationLaneSignalOnly) liveLanesEnabled.push('MIGRATION_LANE');
    // 2026-04-27: KOL live canary triple-flag gate (kolHunterLiveCanaryEnabled + !kolHunterPaperOnly + tradingMode='live')
    if (config.kolHunterLiveCanaryEnabled && !config.kolHunterPaperOnly) {
      liveLanesEnabled.push('KOL_HUNTER_LIVE_CANARY');
    }
    if (config.kolHunterRotationChaseTopupLiveCanaryEnabled) {
      const chaseTopupLiveActive = config.kolHunterLiveCanaryEnabled && !config.kolHunterPaperOnly;
      liveLanesEnabled.push(
        chaseTopupLiveActive
          ? 'KOL_HUNTER_ROTATION_CHASE_TOPUP_LIVE_CANARY'
          : 'KOL_HUNTER_ROTATION_CHASE_TOPUP_LIVE_CANARY_CONFIGURED_INACTIVE'
      );
    }
    if (liveLanesEnabled.length > 0) {
      log.warn(
        `[STAGE_GATE_REMINDER] live canary flags=[${liveLanesEnabled.join(',')}]. ` +
        `사명 §3 phase gate 의무: paper trades ≥ 200 + 5x+ winner ≥ 1건 입증 + 별도 ADR + ` +
        `Telegram critical ack (stage4_approved_YYYY_MM_DD) 충족 후만 활성화. ` +
        `미달 상태에서 활성 시 운영자가 자발적 책임 인지로 간주.`
      );
    }
  }

  // 2026-04-30: restart-resilient canary state.
  // reportCanaryClose 는 in-memory 라 재기동 시 KOL/PureWS budget 이 0 으로 리셋될 수 있었다.
  // live boot 에서 executed-sells ledger 를 replay 해 이미 소진된 budget/max-trade halt 를 복원한다.
  if (tradingMode === 'live' && config.canaryAutoHaltHydrateOnStart) {
    await hydrateCanaryAutoHaltFromLedger(config.realtimeDataDir);
  }

  // 2026-04-21 P0 (observability) + 2026-04-27 (handle 저장): v2 scanner / canary auto-reset
  // 의 setInterval handle 은 monitoringHandles 가 생성된 *이후* 에 부착한다.
  // 아래 line 1725 부근의 startMonitoringLoops 호출 다음 블록 참조.

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

  // 2026-04-26 cleanup: Strategy D (newLpSniper / Birdeye WS / sandbox-only entry)
  // 가 영구 retire 됐다. 사명 paradigm 이 KOL Discovery + 자체 Execution (Option 5) 로
  // 전환되며 New LP Sniper lane 은 더 이상 사용되지 않는다.

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
  const preparePureWsSignalFromWatchlist = (signal: Signal): boolean => {
    if (!config.pureWsNewPairSourceGateEnabled) return true;
    const entry =
      scanner?.getEntryByPairAddress(signal.pairAddress) ??
      scanner?.getEntry(signal.pairAddress);
    if (!isPureWsNewPairWatchlistEntry(entry)) return false;
    signal.discoverySource = entry.discoverySource;
    signal.tokenSymbol ??= entry.symbol;
    return true;
  };
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
    // 2026-04-26 cleanup: attachScannerFreshListingSource (Strategy D New LP Sniper) 제거.
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
        `Check SANDBOX_WALLET_PRIVATE_KEY, or switch ${lane} to mode='main'.`
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
    const walletProfile = walletManager.getWallet(config.walletStopWalletName);
    const externalDeltaClassifier = walletProfile
      ? createWalletExternalDeltaClassifier({
        connection: new Connection(config.solanaRpcUrl, 'confirmed'),
        walletName: config.walletStopWalletName,
        walletPublicKey: walletProfile.keypair.publicKey,
        realtimeDataDir: config.realtimeDataDir,
      })
      : undefined;
    void startWalletDeltaComparator(walletManager, notifier, {
      enabled: true,
      pollIntervalMs: config.walletDeltaPollIntervalMs,
      driftWarnSol: config.walletDeltaDriftWarnSol,
      driftHaltSol: config.walletDeltaDriftHaltSol,
      minSamplesBeforeAlert: config.walletDeltaMinSamplesBeforeAlert,
      walletName: config.walletStopWalletName,
      realtimeDataDir: config.realtimeDataDir,
      // Sprint A1 (2026-04-28): warn alert dedup
      warnAlertCooldownMs: config.walletDeltaWarnAlertCooldownMs,
      warnDriftDeltaToleranceSol: config.walletDeltaWarnDriftDeltaToleranceSol,
      externalDeltaClassifier,
    });
  } else {
    log.info(
      `[WALLET_DELTA] comparator ${config.walletDeltaComparatorEnabled ? 'skipped (paper mode)' : 'disabled (config)'}`
    );
  }

  // 2026-04-22 P1-1: Jupiter 429 metric summary loop (5분 주기).
  // Why: 2026-04-22 9h 운영 중 429 cluster 로 유일 live buy 전멸. silent loss 추적 metric.
  startJupiter429SummaryLoop(5 * 60 * 1000);
  log.info('[JUPITER_429] summary loop started (5min interval)');

  // 2026-04-23 Option 5: KOL Discovery Layer (Phase 1 passive logging)
  // ADR: docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md
  // env gate: KOL_TRACKER_ENABLED=true 일 때만 활성. Phase 0 DB 정제 완료 후 켤 것.
  // 2026-05-01 (Decu Quality Layer Phase B.5): Dev Wallet Registry — observe-only.
  //   tokenQualityObserverEnabled=true (default) 이거나 dev DB 가 존재하면 init.
  //   fail-open — load 실패 시 빈 DB (Gate pipeline 중단 금지).
  if (config.tokenQualityObserverEnabled) {
    await initDevWalletRegistry({
      path: config.devWalletDbPath,
      hotReloadIntervalMs: config.devWalletHotReloadIntervalMs,
    });
    const devStats = getDevWalletRegistryStats();
    log.info(
      `[BOOT] dev wallet registry: ${devStats.activeEntries}/${devStats.totalEntries} active, ` +
      `addresses=${devStats.addressCount}, allowlist=${devStats.byStatus.allowlist}, ` +
      `blacklist=${devStats.byStatus.blacklist}`
    );
  }

  let kolTracker: KolWalletTracker | null = null;
  if (config.kolTrackerEnabled) {
    await initKolDb({
      path: config.kolDbPath,
      hotReloadIntervalMs: config.kolHotReloadIntervalMs,
    });
    const stats = getKolDbStats();
    if (stats.activeKols > 0) {
      // Dedicated Connection — executor 의 private connection 과 격리 (rate limit 상호 영향 방지)
      const kolConnection = new Connection(config.solanaRpcUrl, 'confirmed');
      kolTracker = new KolWalletTracker({
        connection: kolConnection,
        realtimeDataDir: config.realtimeDataDir,
        logFileName: config.kolTxLogFileName,
        txFetchTimeoutMs: config.kolTxFetchTimeoutMs,
        enabled: true,
        // Option A (2026-04-27): inactive KOL shadow track. paper position 영향 0.
        shadowTrackInactive: config.kolHunterShadowTrackInactive,
        shadowLogFileName: config.kolShadowTxLogFileName,
        // Option B (2026-04-28): inactive KOL paper trade opt-in. handler 가 isShadow=true 분기.
        shadowPaperTradeEnabled: config.kolHunterShadowPaperTradeEnabled,
      });

      // Phase 3: kol_hunter paper lane 활성화 여부
      await startKolTrackerWithPreparedHunter({
        tracker: kolTracker,
        ctx,
        notifier,
        log,
        activeKols: stats.activeKols,
        kolHunterEnabled: config.kolHunterEnabled,
        kolHunterLiveCanaryEnabled: config.kolHunterLiveCanaryEnabled,
        kolHunterPaperOnly: config.kolHunterPaperOnly,
        runtime: {
          initKolHunter,
          hydrateLiveExecutionQualityCooldownsFromLedger,
          hydrateTradeMarkoutsFromLedger,
          handleKolSwap,
          initKolPaperNotifier,
        },
      });
    } else {
      log.warn(`[KOL_DISCOVERY] KOL DB empty — tracker NOT started. data/kol/wallets.json 채우기`);
    }
  } else {
    log.info(`[KOL_DISCOVERY] disabled (KOL_TRACKER_ENABLED=false) — Option 5 Phase 0-5 대기 중`);
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
      watchdogIntervalMs: config.heliusWatchdogIntervalMs,
      reconnectCooldownMs: config.heliusReconnectCooldownMs,
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
            if (config.pureWsLaneEnabled && preparePureWsSignalFromWatchlist(signal)) {
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
          await realtimeCandleStage('replay_store_append', () => realtimeReplayStore.appendCandle({
            ...candle,
            tokenMint: candle.pairAddress,
          }));
        }
        await realtimeCandleStage('outcome_tracker', async () => {
          await realtimeOutcomeTracker?.onCandle(candle);
        });
        if (candle.intervalSec >= 60) {
          await realtimeCandleStage('candle_store_insert', () => candleStore.insertCandles([candle]));
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
          const signal = await realtimeCandleStage('trigger_eval', async () =>
            trigger.onCandle(candle, realtimeCandleBuilder!)
          );
          if (signal) {
            log.info(`🎯 Signal fired: ${signal.strategy} ${signal.pairAddress.slice(0, 12)}… price=${signal.price} vr=${signal.meta.volumeRatio?.toFixed(1)}`);
            await realtimeCandleStage('handle_realtime_signal', () =>
              handleRealtimeSignal(signal, realtimeCandleBuilder!, ctx)
            );
            // Path A (2026-04-11): cupsey-inspired lane — 같은 signal, 별도 post-entry state machine.
            // 기존 handleRealtimeSignal 과 독립적으로 실행. sandbox ticket, main core 오염 없음.
            if (config.cupseyLaneEnabled) {
              await realtimeCandleStage('handle_cupsey_signal', () =>
                handleCupseyLaneSignal(signal, realtimeCandleBuilder!, ctx)
              );
            }
            // Block 3 (2026-04-18): pure_ws_breakout lane — convexity-aligned separate state machine.
            if (config.pureWsLaneEnabled && preparePureWsSignalFromWatchlist(signal)) {
              await realtimeCandleStage('handle_pure_ws_signal', () =>
                handlePureWsSignal(signal, realtimeCandleBuilder!, ctx)
              );
            }
          }
        }
        // Path A: cupsey position monitoring (매 candle tick 마다)
        if (config.cupseyLaneEnabled) {
          await realtimeCandleStage('cupsey_update', () => updateCupseyPositions(ctx, realtimeCandleBuilder!));
        }
        if (config.pureWsLaneEnabled) {
          await realtimeCandleStage('pure_ws_update', () => updatePureWsPositions(ctx, realtimeCandleBuilder!));
        }
        // DEX_TRADE Phase 1.3: v2 detector 독립 scan (candle close 마다 watchlist 전체 평가)
        // bootstrap signal 과 별개 경로. pureWsV2Enabled=true + pureWsLaneEnabled=true 일 때만 작동.
        if (config.pureWsV2Enabled && config.pureWsLaneEnabled) {
          const watchlistEntries = universeEngine.getWatchlist();
          const pureWsNewPairEntries = config.pureWsNewPairSourceGateEnabled
            ? watchlistEntries.filter(isPureWsNewPairWatchlistEntry)
            : watchlistEntries;
          const pairs = pureWsNewPairEntries.map((e) => e.pairAddress);
          const symByPair = new Map<string, string | undefined>(
            pureWsNewPairEntries.map((e) => [e.pairAddress, e.symbol])
          );
          const discoverySourceByPair = new Map<string, string | undefined>(
            pureWsNewPairEntries.map((e) => [e.pairAddress, e.discoverySource])
          );
          await realtimeCandleStage('pure_ws_v2_scan', () =>
            scanPureWsV2Burst(ctx, realtimeCandleBuilder!, pairs, symByPair, discoverySourceByPair)
          ).catch((err) => {
            log.warn(`Pure WS v2 scan failed: ${err}`);
          });
        }
        // Tier 1 (2026-04-17): migration handoff reclaim lane. candle tick 경로만 사용 (race 예방).
        if (config.migrationLaneEnabled) {
          await realtimeCandleStage('migration_update', () => updateMigrationPositions(ctx, realtimeCandleBuilder!));
        }
      } catch (error) {
        const stagedError = withRealtimeCandleStage(error);
        log.error(`Realtime candle handling failed: ${stagedError}`);
        await notifier.sendError('realtime_candle', stagedError).catch(() => {});
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

  await runLaneRecoveries(ctx, notifier);

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

  // 2026-04-21 P0 (observability): v2 scanner 누적 telemetry 주기 출력.
  // Why: VPS 24h 관측에서 PUREWS_V2_PASS 0건이지만 REJECT 는 log.debug 라 원인 진단 불가.
  // HealthMonitor 와 같은 1분 주기로 v2 scan 통계 (insuf/rejects/halt/PASS) 를 info 로 출력.
  // 2026-04-27: handle 을 monitoringHandles 에 부착해 setupShutdown 이 clearInterval 가능.
  if (config.pureWsLaneEnabled && config.pureWsV2Enabled) {
    monitoringHandles.pureWsV2TelemetryInterval = setInterval(() => {
      try { logPureWsV2TelemetrySummary(); } catch (err) {
        log.warn(`Pure WS v2 telemetry log failed: ${err}`);
      }
    }, 60_000);
  }

  // 2026-04-21 P2: canary halt 자동 해제 tick.
  // Why: 4-streak consecutive loss 는 표본 부족. 시간 경과 + budget 여유 시 자동 해제하여
  // Phase 1-3 관측 재개. budget 초과 halt 는 skip (실 자산 보호 유지).
  if (config.canaryAutoResetEnabled) {
    monitoringHandles.canaryAutoResetInterval = setInterval(() => {
      try { checkAllLanesAutoResetHalt(); } catch (err) {
        log.warn(`Canary auto-reset tick failed: ${err}`);
      }
    }, 60_000);
  }


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

  // 2026-04-26 cleanup: Path B2 (구 KOL wallet tracker, kolWalletTrackingEnabled 플래그)
  // 영구 retire. Option 5 (`src/ingester/kolWalletTracker.ts`) 가 대체.

  // Phase 1A: Start scanner (2026-04-26 cleanup: Birdeye WS 제거)
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
  // 2026-04-27: handle 저장 → setupShutdown 에서 clearInterval.
  monitoringHandles.dailySummaryInterval = scheduleDailySummary(ctx);

  // ─── Graceful shutdown ──────────────────────────────
  setupShutdown({
    monitoringHandles,
    pendingAliasCleanups,
    realtimeAdmissionTracker,
    realtimeAdmissionStore,
    runtimeDiagnosticsTracker,
    ingester,
    eventMonitor,
    universeEngine,
    scanner,
    replayWarmSync,
    realtimeCandleBuilder,
    heliusPoolDiscovery,
    heliusIngester,
    executionLock,
    healthMonitor,
    kolTracker,
    dbPool,
    notifier,
  });
}

// ─── Entry Point ─────────────────────────────────────────
main().catch((error) => {
  log.error(`Fatal error: ${error}`);
  process.exit(1);
});
