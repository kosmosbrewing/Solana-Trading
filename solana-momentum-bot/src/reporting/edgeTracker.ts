import { StrategyName } from '../utils/types';

export type EdgeState = 'Bootstrap' | 'Calibration' | 'Confirmed' | 'Proven';

export interface EdgeTrackerTrade {
  pairAddress: string;
  strategy: StrategyName;
  entryPrice: number;
  stopLoss: number;
  quantity: number;
  pnl: number;
}

export interface EdgePerformanceStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  rewardRisk: number;
  sharpeRatio: number;
  maxConsecutiveLosses: number;
  edgeState: EdgeState;
  kellyFraction: number;
  kellyEligible: boolean;
}

export interface StrategyEdgeStats extends EdgePerformanceStats {
  strategy: StrategyName;
}

export interface PairEdgeStats extends EdgePerformanceStats {
  pairAddress: string;
}

export interface PairBlacklistConfig {
  minTrades: number;
  maxWinRate: number;
  maxRewardRisk: number;
  maxSharpeRatio: number;
  minConsecutiveLosses: number;
  /** 최근 N개 트레이드만 평가 (0 = 전체, default 10) — decay 윈도우 */
  decayWindowTrades: number;
}

const STRATEGIES: StrategyName[] = ['volume_spike', 'fib_pullback'];
const DEFAULT_PAIR_BLACKLIST_CONFIG: PairBlacklistConfig = {
  minTrades: 5,
  maxWinRate: 0.35,
  maxRewardRisk: 1.0,
  maxSharpeRatio: 0,
  minConsecutiveLosses: 4,
  decayWindowTrades: 10,
};

interface PromotionGate {
  minTrades: number;
  minWinRate: number;
  minRewardRisk: number;
  minSharpeRatio: number;
  maxConsecutiveLosses: number;
}

const PROMOTION_GATES: Record<'Confirmed' | 'Proven', PromotionGate> = {
  Confirmed: {
    minTrades: 50,
    minWinRate: 0.45,
    minRewardRisk: 1.5,
    minSharpeRatio: 0.5,
    maxConsecutiveLosses: 4,
  },
  Proven: {
    minTrades: 100,
    minWinRate: 0.5,
    minRewardRisk: 1.75,
    minSharpeRatio: 0.75,
    maxConsecutiveLosses: 3,
  },
};

export class EdgeTracker {
  private readonly trades: EdgeTrackerTrade[] = [];

  constructor(trades: EdgeTrackerTrade[] = []) {
    this.recordTrades(trades);
  }

  recordTrade(trade: EdgeTrackerTrade): void {
    this.trades.push(trade);
  }

  recordTrades(trades: EdgeTrackerTrade[]): void {
    for (const trade of trades) {
      this.recordTrade(trade);
    }
  }

  getStrategyStats(strategy: StrategyName): StrategyEdgeStats {
    return summarizeStrategy(this.trades.filter(trade => trade.strategy === strategy), strategy);
  }

  getAllStrategyStats(): StrategyEdgeStats[] {
    return STRATEGIES.map(strategy => this.getStrategyStats(strategy));
  }

  getPairStats(pairAddress: string): PairEdgeStats {
    return summarizePair(this.trades.filter(trade => trade.pairAddress === pairAddress), pairAddress);
  }

  getAllPairStats(minTrades: number = 1): PairEdgeStats[] {
    const pairAddresses = [...new Set(this.trades.map(trade => trade.pairAddress))];
    return pairAddresses
      .map(pairAddress => this.getPairStats(pairAddress))
      .filter(stat => stat.totalTrades >= minTrades);
  }

  getBlacklistedPairs(config: Partial<PairBlacklistConfig> = {}): PairEdgeStats[] {
    const threshold = { ...DEFAULT_PAIR_BLACKLIST_CONFIG, ...config };
    const pairAddresses = [...new Set(this.trades.map(trade => trade.pairAddress))];
    return pairAddresses
      .map(pairAddress => this.getPairStatsWindowed(pairAddress, threshold.decayWindowTrades))
      .filter(stat => stat.totalTrades >= threshold.minTrades)
      .filter(stat => isBlacklisted(stat, threshold));
  }

  isPairBlacklisted(pairAddress: string, config: Partial<PairBlacklistConfig> = {}): boolean {
    const threshold = { ...DEFAULT_PAIR_BLACKLIST_CONFIG, ...config };
    const stat = this.getPairStatsWindowed(pairAddress, threshold.decayWindowTrades);
    if (stat.totalTrades < threshold.minTrades) {
      return false;
    }
    return isBlacklisted(stat, threshold);
  }

  /** 최근 windowSize개 트레이드만으로 페어 통계 산출 (0 = 전체) */
  private getPairStatsWindowed(pairAddress: string, windowSize: number): PairEdgeStats {
    let pairTrades = this.trades.filter(trade => trade.pairAddress === pairAddress);
    if (windowSize > 0 && pairTrades.length > windowSize) {
      pairTrades = pairTrades.slice(-windowSize);
    }
    return summarizePair(pairTrades, pairAddress);
  }

  getPortfolioStats(): EdgePerformanceStats {
    return summarizeTrades(this.trades);
  }
}

function summarizeStrategy(
  trades: EdgeTrackerTrade[],
  strategy: StrategyName
): StrategyEdgeStats {
  return {
    strategy,
    ...summarizeTrades(trades),
  };
}

function summarizePair(
  trades: EdgeTrackerTrade[],
  pairAddress: string
): PairEdgeStats {
  return {
    pairAddress,
    ...summarizeTrades(trades),
  };
}

function summarizeTrades(trades: EdgeTrackerTrade[]): EdgePerformanceStats {
  const wins = trades.filter(trade => trade.pnl > 0);
  const losses = trades.filter(trade => trade.pnl <= 0);
  const riskMultiples = trades.map(toRiskMultiple).filter(isFiniteNumber);
  const winRs = wins.map(toRiskMultiple).filter(isFiniteNumber);
  const lossRs = losses.map(toRiskMultiple).filter(isFiniteNumber).map(value => Math.abs(value));
  const rewardRisk = lossRs.length > 0
    ? average(winRs) / average(lossRs)
    : winRs.length > 0 ? Number.POSITIVE_INFINITY : 0;
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const sharpeRatio = calcSharpe(riskMultiples);
  const maxConsecutiveLosses = calcMaxConsecutiveLosses(trades);
  const kellyFraction = calculateKellyFraction(
    winRate,
    rewardRisk
  );
  const edgeState = resolveEdgeState({
    totalTrades: trades.length,
    winRate,
    rewardRisk,
    sharpeRatio,
    maxConsecutiveLosses,
  });

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWinR: average(winRs),
    avgLossR: average(lossRs),
    rewardRisk,
    sharpeRatio,
    maxConsecutiveLosses,
    edgeState,
    kellyFraction,
    kellyEligible: isKellyEligible(edgeState, kellyFraction),
  };
}

function toRiskMultiple(trade: EdgeTrackerTrade): number {
  const plannedRiskSol = Math.abs(trade.entryPrice - trade.stopLoss) * trade.quantity;
  if (plannedRiskSol <= 0) return Number.NaN;
  return trade.pnl / plannedRiskSol;
}

function calcMaxConsecutiveLosses(trades: EdgeTrackerTrade[]): number {
  let streak = 0;
  let maxStreak = 0;

  for (const trade of trades) {
    if (trade.pnl < 0) {
      streak++;
      maxStreak = Math.max(maxStreak, streak);
      continue;
    }
    streak = 0;
  }

  return maxStreak;
}

function resolveEdgeState(stats: {
  totalTrades: number;
  winRate: number;
  rewardRisk: number;
  sharpeRatio: number;
  maxConsecutiveLosses: number;
}): EdgeState {
  if (passesPromotionGate(stats, PROMOTION_GATES.Proven)) return 'Proven';
  if (passesPromotionGate(stats, PROMOTION_GATES.Confirmed)) return 'Confirmed';
  if (stats.totalTrades >= 20) return 'Calibration';
  return 'Bootstrap';
}

function passesPromotionGate(
  stats: {
    totalTrades: number;
    winRate: number;
    rewardRisk: number;
    sharpeRatio: number;
    maxConsecutiveLosses: number;
  },
  gate: PromotionGate
): boolean {
  return (
    stats.totalTrades >= gate.minTrades &&
    stats.winRate >= gate.minWinRate &&
    stats.rewardRisk >= gate.minRewardRisk &&
    stats.sharpeRatio >= gate.minSharpeRatio &&
    stats.maxConsecutiveLosses <= gate.maxConsecutiveLosses
  );
}

function calculateKellyFraction(winRate: number, rewardRisk: number): number {
  if (!Number.isFinite(winRate) || winRate <= 0) return 0;
  if (rewardRisk === Number.POSITIVE_INFINITY) {
    return winRate;
  }
  if (!Number.isFinite(rewardRisk) || rewardRisk <= 0) return 0;

  const lossRate = 1 - winRate;
  return clamp(winRate - lossRate / rewardRisk, 0, 1);
}

function isKellyEligible(edgeState: EdgeState, kellyFraction: number): boolean {
  return (edgeState === 'Confirmed' || edgeState === 'Proven') && kellyFraction > 0;
}

function calcSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = average(returns);
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(252);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function isBlacklisted(stat: PairEdgeStats, threshold: PairBlacklistConfig): boolean {
  return (
    stat.maxConsecutiveLosses >= threshold.minConsecutiveLosses ||
    (
      stat.winRate <= threshold.maxWinRate &&
      stat.rewardRisk <= threshold.maxRewardRisk &&
      stat.sharpeRatio <= threshold.maxSharpeRatio
    )
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
