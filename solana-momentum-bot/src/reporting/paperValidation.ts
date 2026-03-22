import { DEFAULT_BACKTEST_CONFIG } from '../backtest/types';
import { replayDrawdownGuardState } from '../risk/drawdownGuard';
import { CloseReason, StrategyName } from '../utils/types';
import { summarizeRiskMetrics } from './riskMetrics';
import {
  assessMeasuredEdgeStage,
  BacktestStageDecision,
  EdgeGateStatus,
  EdgeScoreBreakdown,
} from './measurement';

export interface PaperValidationTrade {
  strategy: StrategyName;
  pairAddress: string;
  entryPrice: number;
  stopLoss: number;
  quantity: number;
  pnl: number;
  exitReason?: CloseReason;
  closedAt: Date;
}

export interface PaperValidationSignal {
  strategy: StrategyName;
  action: 'EXECUTED' | 'FILTERED' | 'STALE' | 'RISK_REJECTED';
  filterReason?: string | null;
}

export interface PaperValidationOptions {
  initialBalance?: number;
  minTrades?: number;
  minWinRate?: number;
  minRewardRisk?: number;
  maxDrawdownPct?: number;
  recoveryPct?: number;
}

export interface StrategyValidationStats {
  strategy: StrategyName;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  profitFactor: number;
  avgWinR: number;
  avgLossR: number;
  expectancyR: number;
  rewardRisk: number;
  sharpeRatio: number;
}

export interface PaperValidationReport {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  netPnlPct: number;
  profitFactor: number;
  avgWinR: number;
  avgLossR: number;
  expectancyR: number;
  rewardRisk: number;
  sharpeRatio: number;
  strategyStats: StrategyValidationStats[];
  notTrendingFiltered: number;
  drawdownGuardFiltered: number;
  executedSignals: number;
  filteredSignals: number;
  maxRealizedDrawdownPct: number;
  drawdownGuardHalted: boolean;
  edgeScore: number;
  stageScore: number;
  edgeDecision: BacktestStageDecision;
  edgeGateStatus: EdgeGateStatus;
  edgeGateReasons: string[];
  edgeScoreBreakdown: EdgeScoreBreakdown;
  criteria: {
    minTradesMet: boolean;
    winRateMet: boolean;
    rewardRiskMet: boolean;
    phase2Ready: boolean;
    attentionGateObserved: boolean;
    drawdownGuardObserved: boolean;
  };
}

const STRATEGIES: StrategyName[] = ['volume_spike', 'fib_pullback', 'new_lp_sniper'];

export function buildPaperValidationReport(
  trades: PaperValidationTrade[],
  signals: PaperValidationSignal[],
  options: PaperValidationOptions = {}
): PaperValidationReport {
  const minTrades = options.minTrades ?? 50;
  const minWinRate = options.minWinRate ?? 0.4;
  const minRewardRisk = options.minRewardRisk ?? 2;
  const initialBalance = options.initialBalance ?? DEFAULT_BACKTEST_CONFIG.initialBalance;
  const maxDrawdownPct = options.maxDrawdownPct ?? DEFAULT_BACKTEST_CONFIG.maxDrawdownPct;
  const recoveryPct = options.recoveryPct ?? DEFAULT_BACKTEST_CONFIG.recoveryPct;

  const overall = summarizeTrades(trades);
  const strategyStats = STRATEGIES.map(strategy =>
    summarizeTrades(trades.filter(trade => trade.strategy === strategy), strategy)
  );

  const balances = [initialBalance];
  let balance = initialBalance;
  for (const trade of trades) {
    balance += trade.pnl;
    balances.push(balance);
  }
  const drawdown = replayDrawdownGuardState(balances, { maxDrawdownPct, recoveryPct });

  const notTrendingFiltered = signals.filter(
    signal => signal.action === 'FILTERED' && (signal.filterReason === 'not_trending' || signal.filterReason === 'no_event_context')
  ).length;
  const drawdownGuardFiltered = signals.filter(
    signal =>
      signal.action === 'FILTERED' &&
      typeof signal.filterReason === 'string' &&
      signal.filterReason.startsWith('Drawdown guard active:')
  ).length;
  const executedSignals = signals.filter(signal => signal.action === 'EXECUTED').length;
  const filteredSignals = signals.filter(signal => signal.action !== 'EXECUTED').length;

  const minTradesMet = overall.totalTrades >= minTrades;
  const winRateMet = overall.winRate >= minWinRate;
  const rewardRiskMet = overall.rewardRisk >= minRewardRisk;
  const netPnlPct = initialBalance > 0 ? overall.netPnl / initialBalance : 0;
  const edgeAssessment = assessMeasuredEdgeStage({
    netPnlPct,
    expectancyR: overall.expectancyR,
    profitFactor: overall.profitFactor,
    sharpeRatio: overall.sharpeRatio,
    maxDrawdownPct: drawdown.drawdownPct,
    totalTrades: overall.totalTrades,
  });

  return {
    totalTrades: overall.totalTrades,
    wins: overall.wins,
    losses: overall.losses,
    winRate: overall.winRate,
    netPnl: overall.netPnl,
    netPnlPct,
    profitFactor: overall.profitFactor,
    avgWinR: overall.avgWinR,
    avgLossR: overall.avgLossR,
    expectancyR: overall.expectancyR,
    rewardRisk: overall.rewardRisk,
    sharpeRatio: overall.sharpeRatio,
    strategyStats,
    notTrendingFiltered,
    drawdownGuardFiltered,
    executedSignals,
    filteredSignals,
    maxRealizedDrawdownPct: drawdown.drawdownPct,
    drawdownGuardHalted: drawdown.halted,
    edgeScore: edgeAssessment.edgeScore,
    stageScore: edgeAssessment.stageScore,
    edgeDecision: edgeAssessment.decision,
    edgeGateStatus: edgeAssessment.gateStatus,
    edgeGateReasons: edgeAssessment.gateReasons,
    edgeScoreBreakdown: edgeAssessment.breakdown,
    criteria: {
      minTradesMet,
      winRateMet,
      rewardRiskMet,
      phase2Ready: minTradesMet && winRateMet && rewardRiskMet,
      attentionGateObserved: notTrendingFiltered > 0,
      drawdownGuardObserved: drawdownGuardFiltered > 0,
    },
  };
}

function summarizeTrades(
  trades: PaperValidationTrade[],
  strategy?: StrategyName
): StrategyValidationStats {
  const summary = summarizeRiskMetrics(trades);

  return {
    strategy: strategy ?? 'volume_spike',
    totalTrades: summary.totalTrades,
    wins: summary.wins,
    losses: summary.losses,
    winRate: summary.winRate,
    netPnl: summary.netPnl,
    profitFactor: summary.profitFactor,
    avgWinR: summary.avgWinR,
    avgLossR: summary.avgLossR,
    expectancyR: summary.expectancyR,
    rewardRisk: summary.rewardRisk,
    sharpeRatio: summary.sharpeRatio,
  };
}
