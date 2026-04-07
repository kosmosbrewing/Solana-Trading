import { StrategyName, isSandboxStrategy } from '../utils/types';
import {
  average,
  isFiniteNumber,
  summarizeRiskMetrics,
  toRiskMultiple,
} from './riskMetrics';

export type EdgeState = 'Bootstrap' | 'Calibration' | 'Confirmed' | 'Proven';

export interface EdgeTrackerTrade {
  pairAddress: string;
  strategy: StrategyName;
  entryPrice: number;
  stopLoss: number;
  quantity: number;
  pnl: number;
  /** Phase B1: sanitizer가 planned vs actual entry 정합성을 검사할 때 참조 */
  plannedEntryPrice?: number | null;
  /** Phase B1: sanitizer가 "TP인데 음수 pnl" 케이스를 제거할 때 참조 */
  exitReason?: string | null;
  /** 2026-04-07: sanitizer가 Jupiter saturated slippage fake fill을 drop하기 위해 참조 */
  exitSlippageBps?: number | null;
  /** 2026-04-07: tradeExecution이 기록한 anomaly reason (fake_fill_*, slippage_saturated=*) */
  exitAnomalyReason?: string | null;
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
  /** Blacklist if win rate BELOW this threshold */
  minWinRate: number;
  /** Blacklist if R:R BELOW this threshold */
  minRewardRisk: number;
  maxSharpeRatio: number;
  minConsecutiveLosses: number;
  /** 최근 N개 트레이드만 평가 (0 = 전체, default 10) — decay 윈도우 */
  decayWindowTrades: number;
}

const STRATEGIES: StrategyName[] = [
  'volume_spike', 'bootstrap_10s', 'core_momentum',
  'fib_pullback', 'new_lp_sniper', 'momentum_cascade',
];
const DEFAULT_PAIR_BLACKLIST_CONFIG: PairBlacklistConfig = {
  minTrades: 5,
  minWinRate: 0.35,
  minRewardRisk: 1.0,
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

/**
 * Phase 4: Demotion gates — recent-window performance check.
 * If recent N trades fall below these thresholds, demote by one tier.
 */
interface DemotionGate {
  recentWindowSize: number;
  /** Demote if recent WR falls BELOW this */
  minWinRate: number;
  /** Demote if recent R:R falls BELOW this */
  minRewardRisk: number;
  minConsecutiveLosses: number; // Demote if ABOVE this
}

const DEMOTION_GATES: Record<'Proven' | 'Confirmed', DemotionGate> = {
  Proven: {
    recentWindowSize: 20,
    minWinRate: 0.35,
    minRewardRisk: 1.0,
    minConsecutiveLosses: 5,
  },
  Confirmed: {
    recentWindowSize: 15,
    minWinRate: 0.30,
    minRewardRisk: 0.8,
    minConsecutiveLosses: 5,
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
    // H-21: O(n) pre-group으로 O(n²) → O(n) 최적화
    const grouped = new Map<string, EdgeTrackerTrade[]>();
    for (const trade of this.trades) {
      let arr = grouped.get(trade.pairAddress);
      if (!arr) { arr = []; grouped.set(trade.pairAddress, arr); }
      arr.push(trade);
    }
    const results: PairEdgeStats[] = [];
    for (const [pairAddress, trades] of grouped) {
      const windowed = threshold.decayWindowTrades > 0 && trades.length > threshold.decayWindowTrades
        ? trades.slice(-threshold.decayWindowTrades)
        : trades;
      const stat = summarizePair(windowed, pairAddress);
      if (stat.totalTrades >= threshold.minTrades && isBlacklisted(stat, threshold)) {
        results.push(stat);
      }
    }
    return results;
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

  // Why: sandbox(new_lp_sniper)는 별도 지갑/위험 예산이므로
  // risk tier, Kelly, drawdown guard 등 포트폴리오 수준 판단에서 제외한다.
  getMainPortfolioStats(): EdgePerformanceStats {
    return summarizeTrades(this.trades.filter(t => !isSandboxStrategy(t.strategy)));
  }

  /**
   * Phase 4: Get stats for recent N trades only.
   * Used for demotion checks and recent-window Kelly recalculation.
   */
  getRecentStats(windowSize: number): EdgePerformanceStats {
    const recentTrades = windowSize > 0 && this.trades.length > windowSize
      ? this.trades.slice(-windowSize)
      : this.trades;
    return summarizeTrades(recentTrades);
  }

  /** Recent N main-lane trades only (sandbox 제외). Demotion check에서 사용. */
  getRecentMainStats(windowSize: number): EdgePerformanceStats {
    const mainTrades = this.trades.filter(t => !isSandboxStrategy(t.strategy));
    const recentTrades = windowSize > 0 && mainTrades.length > windowSize
      ? mainTrades.slice(-windowSize)
      : mainTrades;
    return summarizeTrades(recentTrades);
  }

  /**
   * Phase 4: Get strategy-specific recent stats.
   */
  getRecentStrategyStats(strategy: StrategyName, windowSize: number): StrategyEdgeStats {
    let stratTrades = this.trades.filter(t => t.strategy === strategy);
    if (windowSize > 0 && stratTrades.length > windowSize) {
      stratTrades = stratTrades.slice(-windowSize);
    }
    return { strategy, ...summarizeTrades(stratTrades) };
  }

  /**
   * Phase 4: Check if current edge state should be demoted
   * based on recent performance deterioration.
   * H-08: strategy mode 지원 — strategy 지정 시 해당 전략 트레이드만으로 평가
   */
  checkDemotion(strategy?: StrategyName): { shouldDemote: boolean; reason?: string } {
    // Why: portfolio mode에서는 sandbox 제외하여 main lane만 평가
    const fullStats = strategy
      ? this.getStrategyStats(strategy)
      : this.getMainPortfolioStats();

    const getRecent = (windowSize: number) => strategy
      ? this.getRecentStrategyStats(strategy, windowSize)
      : this.getRecentMainStats(windowSize);

    if (fullStats.edgeState === 'Proven') {
      const gate = DEMOTION_GATES.Proven;
      const recent = getRecent(gate.recentWindowSize);
      if (recent.totalTrades >= gate.recentWindowSize) {
        if (recent.winRate < gate.minWinRate) {
          return { shouldDemote: true, reason: `Recent WR ${(recent.winRate * 100).toFixed(1)}% < ${(gate.minWinRate * 100).toFixed(0)}%` };
        }
        if (recent.rewardRisk < gate.minRewardRisk && Number.isFinite(recent.rewardRisk)) {
          return { shouldDemote: true, reason: `Recent R:R ${recent.rewardRisk.toFixed(2)} < ${gate.minRewardRisk}` };
        }
        if (recent.maxConsecutiveLosses >= gate.minConsecutiveLosses) {
          return { shouldDemote: true, reason: `${recent.maxConsecutiveLosses} consecutive losses` };
        }
      }
    }

    if (fullStats.edgeState === 'Confirmed') {
      const gate = DEMOTION_GATES.Confirmed;
      const recent = getRecent(gate.recentWindowSize);
      if (recent.totalTrades >= gate.recentWindowSize) {
        if (recent.winRate < gate.minWinRate) {
          return { shouldDemote: true, reason: `Recent WR ${(recent.winRate * 100).toFixed(1)}% < ${(gate.minWinRate * 100).toFixed(0)}%` };
        }
        if (recent.rewardRisk < gate.minRewardRisk && Number.isFinite(recent.rewardRisk)) {
          return { shouldDemote: true, reason: `Recent R:R ${recent.rewardRisk.toFixed(2)} < ${gate.minRewardRisk}` };
        }
        if (recent.maxConsecutiveLosses >= gate.minConsecutiveLosses) {
          return { shouldDemote: true, reason: `${recent.maxConsecutiveLosses} consecutive losses` };
        }
      }
    }

    return { shouldDemote: false };
  }

  /**
   * Phase 4: Get expectancy (average R-multiple per trade).
   * Positive expectancy is prerequisite for Strategy E activation.
   */
  getExpectancy(strategy?: StrategyName): number {
    const trades = strategy
      ? this.trades.filter(t => t.strategy === strategy)
      : this.trades;
    if (trades.length === 0) return 0;
    const rMultiples = trades.map(toRiskMultiple).filter(isFiniteNumber);
    return rMultiples.length > 0 ? average(rMultiples) : 0;
  }

  /** Total trade count */
  getTradeCount(): number {
    return this.trades.length;
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
  const summary = summarizeRiskMetrics(trades);
  const kellyFraction = calculateKellyFraction(
    summary.winRate,
    summary.rewardRisk
  );
  const edgeState = resolveEdgeState({
    totalTrades: summary.totalTrades,
    winRate: summary.winRate,
    rewardRisk: summary.rewardRisk,
    sharpeRatio: summary.sharpeRatio,
    maxConsecutiveLosses: summary.maxConsecutiveLosses,
  });

  return {
    totalTrades: summary.totalTrades,
    wins: summary.wins,
    losses: summary.losses,
    winRate: summary.winRate,
    avgWinR: summary.avgWinR,
    avgLossR: summary.avgLossR,
    rewardRisk: summary.rewardRisk,
    sharpeRatio: summary.sharpeRatio,
    maxConsecutiveLosses: summary.maxConsecutiveLosses,
    edgeState,
    kellyFraction,
    kellyEligible: isKellyEligible(edgeState, kellyFraction),
  };
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

function isBlacklisted(stat: PairEdgeStats, threshold: PairBlacklistConfig): boolean {
  return (
    stat.maxConsecutiveLosses >= threshold.minConsecutiveLosses ||
    (
      stat.winRate <= threshold.minWinRate &&
      stat.rewardRisk <= threshold.minRewardRisk &&
      stat.sharpeRatio <= threshold.maxSharpeRatio
    )
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
