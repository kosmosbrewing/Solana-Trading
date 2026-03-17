// ─── Candle ───

export type CandleInterval = '1m' | '5m' | '15m' | '1H' | '4H';

export interface Candle {
  pairAddress: string;
  timestamp: Date;
  intervalSec: number; // 60, 300 등
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  tradeCount: number;
}

// ─── Signal ───

export type SignalAction = 'BUY' | 'SELL' | 'HOLD';
export type BreakoutGrade = 'A' | 'B' | 'C';

export interface BreakoutScoreComponent {
  key: string;
  label: string;
  score: number;
  maxScore: number;
  value?: number;
}

export interface BreakoutScoreDetail {
  volumeScore: number;     // 0~25
  buyRatioScore: number;   // 0~25
  multiTfScore: number;    // 0~20
  whaleScore: number;      // 0~15
  lpScore: number;         // -10~15
  totalScore: number;      // 0~100
  grade: BreakoutGrade;
  components?: BreakoutScoreComponent[];
}

export interface Signal {
  action: SignalAction;
  strategy: StrategyName;
  pairAddress: string;
  price: number;
  timestamp: Date;
  meta: Record<string, number>;
  breakoutScore?: BreakoutScoreDetail;
  poolTvl?: number;
  spreadPct?: number;
}

// ─── Strategy ───

export type StrategyName = 'volume_spike' | 'fib_pullback' | 'new_lp_sniper';

export interface StrategyConfig {
  name: StrategyName;
  timeframeSec: number;
  params: Record<string, number>;
}

// ─── Order / Trade ───

export type TradeSide = 'BUY' | 'SELL';
export type TradeStatus = 'OPEN' | 'CLOSED' | 'FAILED';
export type CloseReason =
  | 'STOP_LOSS'
  | 'TAKE_PROFIT_1'
  | 'TAKE_PROFIT_2'
  | 'TRAILING_STOP'
  | 'TIME_STOP'
  | 'EXHAUSTION'
  | 'EMERGENCY'
  | 'MANUAL'
  | 'RECOVERED_CLOSED';
export type SizeConstraint = 'RISK' | 'LIQUIDITY' | 'EMERGENCY';

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
  breakoutScore?: number;
  breakoutGrade?: BreakoutGrade;
  sizeConstraint?: SizeConstraint;
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
  highWaterMark?: number;
  timeStopAt: Date;
  breakoutScore?: number;
  breakoutGrade?: BreakoutGrade;
  sizeConstraint?: SizeConstraint;
  exitReason?: CloseReason;
}

// ─── Position State Machine (v0.3) ───

export type PositionState =
  | 'IDLE'
  | 'SIGNAL_DETECTED'
  | 'ORDER_SUBMITTED'
  | 'ENTRY_CONFIRMED'
  | 'MONITORING'
  | 'EXIT_TRIGGERED'
  | 'EXIT_CONFIRMED'
  | 'ORDER_FAILED';

export interface PositionRecord {
  id: string;
  pairAddress: string;
  state: PositionState;
  signalData?: Record<string, unknown>;
  entryPrice?: number;
  quantity?: number;
  stopLoss?: number;
  takeProfit1?: number;
  takeProfit2?: number;
  trailingStop?: number;
  txEntry?: string;
  txExit?: string;
  exitReason?: string;
  pnl?: number;
  updatedAt: Date;
  createdAt: Date;
}

// ─── Risk ───

export interface RiskCheckResult {
  approved: boolean;
  reason?: string;
  adjustedQuantity?: number;
  sizeConstraint?: SizeConstraint;
  appliedAdjustments?: string[];
}

export interface DrawdownGuardState {
  peakBalanceSol: number;
  currentBalanceSol: number;
  drawdownPct: number;
  recoveryBalanceSol: number;
  halted: boolean;
}

export interface PortfolioRiskTier {
  edgeState: 'Bootstrap' | 'Calibration' | 'Confirmed' | 'Proven';
  maxRiskPerTrade: number;
  maxDailyLoss: number;
  maxDrawdownPct: number;
  recoveryPct: number;
  kellyFraction: number;
  kellyApplied: boolean;
  kellyMode: 'fixed' | 'quarter' | 'half';
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
  equitySol: number;
  openTrades: Trade[];
  dailyPnl: number;
  consecutiveLosses: number;
  lastLossTime?: Date;
  drawdownGuard: DrawdownGuardState;
  riskTier?: PortfolioRiskTier;
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

// ─── Universe ───

export interface PoolInfo {
  pairAddress: string;
  tokenMint: string;
  tvl: number;
  dailyVolume: number;
  tradeCount24h: number;
  spreadPct: number;
  ammFeePct?: number;
  mevMarginPct?: number;
  tokenAgeHours: number;
  top10HolderPct: number;
  lpBurned: boolean;
  ownershipRenounced: boolean;
  rankScore: number;
}

// ─── Alert System (v0.3) ───

export type AlertLevel = 'CRITICAL' | 'WARNING' | 'TRADE' | 'INFO';

// ─── Signal Audit ───

export interface SignalAuditEntry {
  pairAddress: string;
  strategy: StrategyName;
  volumeScore?: number;
  buyRatioScore?: number;
  multiTfScore?: number;
  whaleScore?: number;
  lpScore?: number;
  totalScore: number;
  grade: BreakoutGrade;
  candleClose: number;
  volume: number;
  buyVolume?: number;
  sellVolume?: number;
  poolTvl: number;
  spreadPct?: number;
  action: 'EXECUTED' | 'FILTERED' | 'STALE' | 'RISK_REJECTED';
  filterReason?: string;
  positionSize?: number;
  sizeConstraint?: SizeConstraint;
  exitPrice?: number;
  exitReason?: string;
  pnl?: number;
  slippageActual?: number;
  effectiveRR?: number;
  roundTripCost?: number;
}
