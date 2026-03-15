import { BreakoutGrade, Candle, PoolInfo, StrategyName } from '../utils/types';
import { VolumeSpikeParams } from '../strategy/volumeSpikeBreakout';
import { FibPullbackParams } from '../strategy/fibPullback';

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
  /** Max total drawdown from HWM before halting new entries */
  maxDrawdownPct: number;
  /** Balance recovery threshold from HWM to resume trading */
  recoveryPct: number;
  /** Max consecutive losses before cooldown */
  maxConsecutiveLosses: number;
  /** Cooldown duration in minutes */
  cooldownMinutes: number;
  /** Safety thresholds aligned with live risk config */
  minPoolLiquidity: number;
  minTokenAgeHours: number;
  maxHolderConcentration: number;
  minBuyRatio: number;
  minBreakoutScore: number;
  /** Optional pool metadata used by shared gate evaluation */
  gatePoolInfo?: Partial<PoolInfo>;
  /** Strategy params overrides */
  volumeSpikeParams: Partial<VolumeSpikeParams>;
  fibPullbackParams: Partial<FibPullbackParams>;
  /** Date range filter */
  startDate?: Date;
  endDate?: Date;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  initialBalance: 10,
  slippageDeduction: 0.30,
  maxRiskPerTrade: 0.01,
  maxDailyLoss: 0.05,
  maxDrawdownPct: 0.30,
  recoveryPct: 0.85,
  maxConsecutiveLosses: 3,
  cooldownMinutes: 30,
  minPoolLiquidity: 50_000,
  minTokenAgeHours: 24,
  maxHolderConcentration: 0.80,
  minBuyRatio: 0.65,
  minBreakoutScore: 50,
  gatePoolInfo: {
    tvl: 50_000,
    tokenAgeHours: 24,
    top10HolderPct: 0.80,
    lpBurned: false,
    ownershipRenounced: false,
  },
  volumeSpikeParams: {},
  fibPullbackParams: {},
};

// ─── Backtest Trade ───

export type ExitReason = 'STOP_LOSS' | 'TAKE_PROFIT_1' | 'TAKE_PROFIT_2' | 'TRAILING_STOP' | 'TIME_STOP';

export interface BacktestTrade {
  id: number;
  strategy: StrategyName;
  pairAddress: string;
  breakoutScore?: number;
  breakoutGrade?: BreakoutGrade;
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
    drawdownHalt: number;
    cooldown: number;
    positionOpen: number;
    zeroSize: number;
    gradeFiltered: number;
    safetyFiltered: number;
  };
  gradeDistribution: Record<BreakoutGrade, number>;

  // Data
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  finalEquity: number;
}

// ─── Candle Data Source ───

export interface CandleDataSource {
  load(pairAddress: string, intervalSec: number): Promise<Candle[]>;
}
