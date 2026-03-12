import { Candle, Order, StrategyName } from '../utils/types';
import { VolumeSpikeParams } from '../strategy/volumeSpikeBreakout';
import { PumpDetectParams } from '../strategy/pumpDetection';

// ─── Backtest Configuration ───

export interface BacktestConfig {
  /** Initial balance in SOL */
  initialBalance: number;
  /** Slippage deduction ratio (design doc: 0.30 = 30%) */
  slippageDeduction: number;
  /** Max risk per trade as fraction of balance */
  maxRiskPerTrade: number;
  /** Max daily loss as fraction of balance */
  maxDailyLoss: number;
  /** Max consecutive losses before cooldown */
  maxConsecutiveLosses: number;
  /** Cooldown duration in minutes */
  cooldownMinutes: number;
  /** Strategy params overrides */
  volumeSpikeParams: Partial<VolumeSpikeParams>;
  pumpDetectParams: Partial<PumpDetectParams>;
  /** Date range filter */
  startDate?: Date;
  endDate?: Date;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  initialBalance: 10,
  slippageDeduction: 0.30,
  maxRiskPerTrade: 0.01,
  maxDailyLoss: 0.05,
  maxConsecutiveLosses: 3,
  cooldownMinutes: 30,
  volumeSpikeParams: {},
  pumpDetectParams: {},
};

// ─── Backtest Trade ───

export type ExitReason = 'STOP_LOSS' | 'TAKE_PROFIT_1' | 'TAKE_PROFIT_2' | 'TRAILING_STOP' | 'TIME_STOP';

export interface BacktestTrade {
  id: number;
  strategy: StrategyName;
  pairAddress: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnlSol: number;
  pnlPct: number;
  exitReason: ExitReason;
  entryTime: Date;
  exitTime: Date;
  entryIdx: number;
  exitIdx: number;
  peakPrice: number;
  drawdownFromPeak: number;
}

// ─── Equity Point ───

export interface EquityPoint {
  timestamp: Date;
  equity: number;
  drawdown: number;
  tradeId?: number;
}

// ─── Backtest Result ───

export interface BacktestResult {
  config: BacktestConfig;
  pairAddress: string;
  strategy: StrategyName | 'combined';
  candleCount: number;
  dateRange: { start: Date; end: Date };

  // Trade stats
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;

  // PnL
  grossPnl: number;
  netPnl: number;            // after slippage deduction
  netPnlPct: number;
  profitFactor: number;

  // Risk metrics
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  avgWinPct: number;
  avgLossPct: number;
  largestWin: number;
  largestLoss: number;
  avgHoldingBars: number;

  // Risk rejections
  rejections: {
    dailyLimit: number;
    cooldown: number;
    positionOpen: number;
    zeroSize: number;
  };

  // Data
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  finalEquity: number;
}

// ─── Candle Data Source ───

export interface CandleDataSource {
  load(pairAddress: string, intervalSec: number): Promise<Candle[]>;
}
