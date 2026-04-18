// Re-exported to keep Order/Trade/RiskOrderInput self-contained without circular scanner imports.
import type { Cohort } from '../scanner/cohort';
export type { Cohort } from '../scanner/cohort';

// ─── Candle ───

export type CandleInterval = '5s' | '15s' | '1m' | '5m' | '15m' | '1H' | '4H';

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
  mcapVolumeScore: number; // 0~15
  totalScore: number;      // 0~100
  grade: BreakoutGrade;
  components?: BreakoutScoreComponent[];
}

export interface GateTraceSnapshot {
  attentionScore?: number;
  attentionConfidence?: 'low' | 'medium' | 'high';
  attentionSources?: string[];
  rejected: boolean;
  filterReason?: string;
  gradeSizeMultiplier: number;
  security?: {
    approved: boolean;
    reason?: string;
    sizeMultiplier: number;
    flags: string[];
  };
  quote?: {
    approved: boolean;
    reason?: string;
    routeFound: boolean;
    priceImpactPct?: number;
    sizeMultiplier: number;
  };
  execution: {
    rejected: boolean;
    filterReason?: string;
    effectiveRR: number;
    roundTripCost: number;
    sizeMultiplier: number;
    riskPct?: number;
    rewardPct?: number;
    entryPriceImpactPct?: number;
    exitPriceImpactPct?: number;
    quantity?: number;
    notionalSol?: number;
    preGate?: {
      rejected: boolean;
      filterReason?: string;
      effectiveRR: number;
      roundTripCost: number;
      sizeMultiplier: number;
      riskPct?: number;
      rewardPct?: number;
      entryPriceImpactPct?: number;
      exitPriceImpactPct?: number;
      quantity?: number;
      notionalSol?: number;
    };
    postSize?: {
      rejected: boolean;
      filterReason?: string;
      effectiveRR: number;
      roundTripCost: number;
      sizeMultiplier: number;
      riskPct?: number;
      rewardPct?: number;
      entryPriceImpactPct?: number;
      exitPriceImpactPct?: number;
      quantity?: number;
      notionalSol?: number;
    };
  };
  sellImpactPct?: number;
}

export interface Signal {
  action: SignalAction;
  strategy: StrategyName;
  pairAddress: string;
  tokenSymbol?: string;
  price: number;
  timestamp: Date;
  meta: Record<string, number>;
  sourceLabel?: string;
  // Why: sourceLabel은 signal path (어떤 trigger가 발화했는���),
  //      discoverySource는 discovery provenance (어떻게 이 토큰을 발견했는가).
  //      두 질문의 답이 다르므로 분리한다.
  discoverySource?: string;
  breakoutScore?: BreakoutScoreDetail;
  poolTvl?: number;
  spreadPct?: number;
}

// ─── Strategy ───

export type StrategyName =
  | 'volume_spike'         // Strategy A: 5min breakout
  | 'bootstrap_10s'        // Realtime bootstrap trigger (10s volume+buyRatio)
  | 'core_momentum'        // Realtime core trigger (10s 3-AND, standby)
  | 'tick_momentum'        // Tick-level trigger (raw swap, sub-second eval)
  | 'fib_pullback'         // Strategy C: confirmed pullback
  | 'new_lp_sniper'        // Strategy D: sandbox LP sniper
  | 'momentum_cascade'     // Strategy E: conditional add-on
  | 'cupsey_flip_10s'      // Path A: cupsey-inspired quick-reject + winner-hold lane (sandbox)
  | 'migration_reclaim'    // Tier 1 (2026-04-17): Pump.fun/PumpSwap/LaunchLab post-migration reclaim
  | 'pure_ws_breakout';    // Block 3 (2026-04-18): mission-pivot convexity lane — immediate PROBE + tiered runner

// Why: volume_spike order building logic을 bootstrap_10s, core_momentum도 공유한다.
// 라우팅(order shape, scoring, gate)은 같지만 expectancy/reporting은 분리 집계.
export const VOLUME_SPIKE_FAMILY: ReadonlySet<StrategyName> = new Set([
  'volume_spike',
  'bootstrap_10s',
  'core_momentum',
  'tick_momentum',
]);

export function isVolumeSpikeFamilyStrategy(s: StrategyName): boolean {
  return VOLUME_SPIKE_FAMILY.has(s);
}

// Why: sandbox lane은 별도 지갑, 별도 위험 예산을 사용하므로
// 포트폴리오 수준 quality metrics(risk tier, Kelly, drawdown guard)에 섞지 않는다.
export const SANDBOX_STRATEGIES: ReadonlySet<StrategyName> = new Set([
  'new_lp_sniper',
  'cupsey_flip_10s',    // Path A: sandbox lane, main core 오염 차단
  'migration_reclaim',  // Tier 1: 실험 단계, portfolio-level quality에 섞지 않음
  'pure_ws_breakout',   // Block 3 (2026-04-18): mission-pivot convexity lane, portfolio-level 섞지 않음
]);

export function isSandboxStrategy(s: StrategyName): boolean {
  return SANDBOX_STRATEGIES.has(s);
}

export interface StrategyConfig {
  name: StrategyName;
  timeframeSec: number;
  params: Record<string, number>;
}

// ─── Order / Trade ───

export type TradeSide = 'BUY' | 'SELL';
export type TradeStatus = 'OPEN' | 'CLOSED' | 'FAILED';
export type CloseReason =
  | 'DEGRADED_EXIT'     // v2: Priority 0 — sellImpact > 5% 또는 quote 3연속 실패
  | 'STOP_LOSS'
  | 'TAKE_PROFIT_1'
  | 'TAKE_PROFIT_2'
  | 'TRAILING_STOP'
  | 'TIME_STOP'
  | 'EXHAUSTION'
  | 'REJECT_HARD_CUT'
  | 'REJECT_TIMEOUT'
  | 'WINNER_TIME_STOP'
  | 'WINNER_TRAILING'
  | 'WINNER_BREAKEVEN'
  | 'EMERGENCY'
  | 'MANUAL'
  | 'RECOVERED_CLOSED';
export type SizeConstraint = 'RISK' | 'LIQUIDITY' | 'EMERGENCY';

export interface Order {
  pairAddress: string;
  strategy: StrategyName;
  side: TradeSide;
  tradeId?: string;
  tokenSymbol?: string;
  price: number;
  plannedEntryPrice?: number;
  quantity: number; // token units, not SOL notional
  sourceLabel?: string;
  discoverySource?: string;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  trailingStop?: number;
  timeStopMinutes: number;
  breakoutScore?: number;
  breakoutGrade?: BreakoutGrade;
  sizeConstraint?: SizeConstraint;
  /** Strategy-specific slippage override (bps). Executor uses this if set, else config default. */
  slippageBps?: number;
  /**
   * Phase 1 fresh-cohort instrumentation (optional).
   * Upstream watchlist 에서 판정한 cohort. Risk/Trade/diagnostic 로 전파되어
   * fresh pair drop 경로를 측정 가능하게 한다.
   */
  cohort?: Cohort;
}

export interface Trade {
  id: string;
  pairAddress: string;
  strategy: StrategyName;
  side: TradeSide;
  tokenSymbol?: string;
  entryPrice: number;
  plannedEntryPrice?: number;
  sourceLabel?: string;
  discoverySource?: string;
  exitPrice?: number;
  quantity: number; // token units, not SOL notional
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
  // Why: decision price = exit trigger 판정가 (TP2/SL 등), fill과의 gap 계측용
  decisionPrice?: number;
  // Why: P0-2 cost decomposition — 거래별 비용 원인 분해
  entrySlippageBps?: number;
  exitSlippageBps?: number;
  entryPriceImpactPct?: number;
  roundTripCostPct?: number;
  effectiveRR?: number;
  // Why: P1-4 degraded exit telemetry — exit 악화 원인 DB 기록
  degradedTriggerReason?: 'sell_impact' | 'quote_fail';
  degradedQuoteFailCount?: number;
  parentTradeId?: string;
  // Why: 2026-04-07 — fake-fill (Jupiter Ultra outputAmountResult=0 fallback) 또는
  //       Phase A4 anomaly reason을 downstream 분석(sanitizer/edge/ratio)이 필터링할 수 있게 마킹
  exitAnomalyReason?: string | null;
  /**
   * Phase 1 fresh-cohort instrumentation (optional).
   * Order 에서 전파되어 reporting/DB 회고에 사용된다. Phase 1 에서는 in-memory 전파만 수행,
   * DB 컬럼 추가(Phase 2.7) 전까지는 persist 되지 않는다.
   */
  cohort?: Cohort;
  // Why: 2026-04-08 Phase E1 — exit execution mechanism telemetry.
  // monitor trigger 발동 시점 ~ Jupiter swap 응답까지의 latency 와 가격 reverse 측정.
  // exit-execution-mechanism-2026-04-08.md Phase E1 참조.
  /** monitor 가 trigger 발동 시점에 관찰한 가격 (closeTrade 의 paperExitPrice 인자로 전달됨) */
  monitorTriggerPrice?: number;
  /** monitor trigger 발동 시각 (closeTrade 진입 직후 캡처) */
  monitorTriggerAt?: Date;
  /** Jupiter swap 호출 직전 시각. paper 모드에선 monitorTriggerAt 와 동일 */
  swapSubmitAt?: Date;
  /** Jupiter swap 응답 수신 시각. paper 모드에선 monitorTriggerAt 와 동일 */
  swapResponseAt?: Date;
  /** swap 호출 직전 realtimeCandleBuilder.getCurrentPrice() (없으면 undefined) */
  preSubmitTickPrice?: number;
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
  // Why: null = 데이터 미확인 (GeckoTerminal/DexScreener 미제공), false = 확인된 미해소
  lpBurned: boolean | null;
  ownershipRenounced: boolean | null;
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
  /** v3: Runner 상태인 trade ID 집합 — concurrent 허용 판정에 사용 */
  runnerTradeIds?: Set<string>;
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
  symbol?: string;
  discoverySource?: string;
  tvl: number;
  marketCap?: number;
  dailyVolume: number;
  tradeCount24h: number;
  spreadPct: number;
  ammFeePct?: number;
  mevMarginPct?: number;
  tokenAgeHours: number;
  top10HolderPct: number;
  // Why: null = 데이터 미확인, false = 확인된 미해소, true = 확인된 해소
  lpBurned: boolean | null;
  ownershipRenounced: boolean | null;
  rankScore: number;
}

// ─── Alert System (v0.3) ───

export type AlertLevel = 'CRITICAL' | 'WARNING' | 'TRADE' | 'INFO';

// ─── Signal Audit ───

export interface SignalAuditEntry {
  pairAddress: string;
  strategy: StrategyName;
  sourceLabel?: string;
  discoverySource?: string;
  attentionScore?: number;
  attentionConfidence?: 'low' | 'medium' | 'high';
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
  gateTrace?: GateTraceSnapshot;
}
