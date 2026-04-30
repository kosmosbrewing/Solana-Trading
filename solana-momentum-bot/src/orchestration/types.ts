import { SignalAuditLogger } from '../audit';
import { CandleStore, InternalCandleSource, TradeStore } from '../candle';
import { EventMonitor, EventScoreStore } from '../event';
import { Executor, WalletManager } from '../executor';
import { SpreadMeasurer } from '../gate/spreadMeasurer';
import { GeckoTerminalClient, OnchainSecurityClient } from '../ingester';
import { Notifier } from '../notifier';
import { MicroCandleBuilder, RealtimeAdmissionTracker } from '../realtime';
import { PaperMetricsTracker, RealtimeOutcomeTracker, RealtimeSignalLogger, RuntimeDiagnosticsTracker } from '../reporting';
import { RiskManager, RegimeFilter } from '../risk';
import { ScannerEngine, SocialMentionTracker } from '../scanner';
import { ExecutionLock, PositionStore } from '../state';
import { UniverseEngine } from '../universe';
import { GateCacheManager } from '../gate/gateCacheManager';
import { HealthMonitor } from '../utils/healthMonitor';
import { TradingMode } from '../utils/config';
import { RealtimeReplayStore } from '../realtime';

export interface BotContext {
  tradingMode: TradingMode;
  candleStore: CandleStore;
  internalCandleSource?: InternalCandleSource;
  tradeStore: TradeStore;
  riskManager: RiskManager;
  executor: Executor;
  notifier: Notifier;
  healthMonitor: HealthMonitor;
  universeEngine: UniverseEngine;
  eventMonitor: EventMonitor;
  executionLock: ExecutionLock;
  positionStore: PositionStore;
  auditLogger: SignalAuditLogger;
  previousTvl: Map<string, number>;
  tradingHaltedReason?: string;
  /** Phase 1A: Scanner Engine (null = legacy single-pair mode) */
  scanner?: ScannerEngine;
  /** GeckoTerminal client (OHLCV, trending — Birdeye 대체) */
  geckoClient?: GeckoTerminalClient;
  /** Helius RPC 기반 Security Gate client */
  onchainSecurityClient?: OnchainSecurityClient;
  /** Phase 1B: Market Regime Filter */
  regimeFilter?: RegimeFilter;
  /** Phase 1B: Paper Trading Metrics Tracker */
  paperMetrics?: PaperMetricsTracker;
  /** Phase 2: Social mention tracker (C-2) */
  socialMentionTracker?: SocialMentionTracker;
  /** Phase 2: Jupiter quote-based spread measurer (H-2/H-3) */
  spreadMeasurer?: SpreadMeasurer;
  /** Phase 2: EventScore persistent store (C-1) */
  eventScoreStore?: EventScoreStore;
  /** Phase 3: Wallet manager (main + sandbox isolation) */
  walletManager?: WalletManager;
  /** Realtime micro-candle source (optional — Helius WS mode) */
  realtimeCandleBuilder?: MicroCandleBuilder;
  /** Realtime noisy-pool admission state (optional — Helius WS mode) */
  realtimeAdmissionTracker?: RealtimeAdmissionTracker;
  /** Realtime signal outcome tracker (optional — Helius WS mode) */
  realtimeOutcomeTracker?: RealtimeOutcomeTracker;
  /** Realtime signal logger (optional — Helius WS mode) */
  realtimeSignalLogger?: RealtimeSignalLogger;
  /** Realtime replay persistence store (optional — Helius WS mode) */
  realtimeReplayStore?: RealtimeReplayStore;
  /** Runtime diagnostics tracker (optional — cadence/data-plane summary) */
  runtimeDiagnosticsTracker?: RuntimeDiagnosticsTracker;
  /** Grace period 여부 확인 (optional — realtime watchlist lifecycle diagnostics) */
  isInGracePeriod?: (tokenMint: string) => boolean;
  /** Paper 모드 시뮬레이션 잔고 (SOL). PnL에 따라 동적 업데이트 */
  paperBalance?: number;
  /** 2026-04-11: Strategy D sandbox Executor (main wallet 격리). isSandboxStrategy 인 trade 의 sell 에 사용 */
  sandboxExecutor?: Executor;
  /** 2026-04-11: Gate result cache for tick mode — security/liquidity fetch 재사용 */
  gateCache?: GateCacheManager;
}
