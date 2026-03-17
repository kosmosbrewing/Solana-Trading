import { SignalAuditLogger } from '../audit';
import { CandleStore, TradeStore } from '../candle';
import { EventMonitor, EventScoreStore } from '../event';
import { Executor, WalletManager } from '../executor';
import { SpreadMeasurer } from '../gate/spreadMeasurer';
import { BirdeyeClient } from '../ingester';
import { BirdeyeWSClient } from '../ingester/birdeyeWSClient';
import { Notifier } from '../notifier';
import { PaperMetricsTracker } from '../reporting';
import { RiskManager, RegimeFilter } from '../risk';
import { ScannerEngine, SocialMentionTracker } from '../scanner';
import { ExecutionLock, PositionStore } from '../state';
import { UniverseEngine } from '../universe';
import { HealthMonitor } from '../utils/healthMonitor';
import { TradingMode } from '../utils/config';

export interface BotContext {
  tradingMode: TradingMode;
  candleStore: CandleStore;
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
  /** Phase 1A: Birdeye REST client (for security/exit-liquidity checks) */
  birdeyeClient?: BirdeyeClient;
  /** Phase 1A: Birdeye WS client (null = polling fallback) */
  birdeyeWS?: BirdeyeWSClient;
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
}
