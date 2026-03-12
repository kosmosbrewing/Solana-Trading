// ─── Candle ───

export interface Candle {
  pairAddress: string;
  timestamp: Date;
  intervalSec: number; // 60, 300 등
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
}

// ─── Signal ───

export type SignalAction = 'BUY' | 'SELL' | 'HOLD';

export interface Signal {
  action: SignalAction;
  strategy: StrategyName;
  pairAddress: string;
  price: number;
  timestamp: Date;
  meta: Record<string, number>; // ATR, volume ratio 등 부가 정보
}

// ─── Strategy ───

export type StrategyName = 'volume_spike' | 'pump_detect';

export interface StrategyConfig {
  name: StrategyName;
  timeframeSec: number;
  params: Record<string, number>;
}

// ─── Order / Trade ───

export type TradeSide = 'BUY' | 'SELL';
export type TradeStatus = 'OPEN' | 'CLOSED' | 'FAILED';

export interface Order {
  pairAddress: string;
  strategy: StrategyName;
  side: TradeSide;
  price: number;
  quantity: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  trailingStop?: number;
  timeStopMinutes: number;
}

export interface Trade {
  id: string;
  pairAddress: string;
  strategy: StrategyName;
  side: TradeSide;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  pnl?: number;
  slippage?: number;
  txSignature?: string;
  status: TradeStatus;
  createdAt: Date;
  closedAt?: Date;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  trailingStop?: number;
  timeStopAt: Date;
}

// ─── Risk ───

export interface RiskCheckResult {
  approved: boolean;
  reason?: string;
  adjustedQuantity?: number;
}

// ─── Safety Filters ───

export interface TokenSafety {
  poolLiquidity: number;   // TVL in USD
  tokenAgeHours: number;
  lpBurned: boolean;
  ownershipRenounced: boolean;
  top10HolderPct: number;  // 0~1
}

// ─── Portfolio ───

export interface PortfolioState {
  balanceSol: number;
  balanceUsd: number;
  openTrades: Trade[];
  dailyPnl: number;
  dailyTradeCount: number;
  consecutiveLosses: number;
  lastLossTime?: Date;
}

// ─── Health ───

export interface HealthStatus {
  uptime: number;
  lastCandleAt?: Date;
  lastTradeAt?: Date;
  dbConnected: boolean;
  wsConnected: boolean;
  openPositions: number;
  dailyPnl: number;
}
