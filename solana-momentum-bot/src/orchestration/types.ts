import { SignalAuditLogger } from '../audit';
import { CandleStore, TradeStore } from '../candle';
import { EventMonitor } from '../event';
import { Executor } from '../executor';
import { Notifier } from '../notifier';
import { RiskManager } from '../risk';
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
}
