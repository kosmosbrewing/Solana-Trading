export interface RiskLikeTrade {
  entryPrice: number;
  stopLoss: number;
  quantity: number;
  pnl: number;
}

export interface RiskMetricsSummary {
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
  maxConsecutiveLosses: number;
}

export function summarizeRiskMetrics<T extends RiskLikeTrade>(trades: T[]): RiskMetricsSummary {
  const wins = trades.filter(trade => trade.pnl > 0);
  const losses = trades.filter(trade => trade.pnl <= 0);
  const riskMultiples = trades.map(toRiskMultiple).filter(isFiniteNumber);
  const winRs = wins.map(toRiskMultiple).filter(isFiniteNumber);
  const lossRs = losses.map(toRiskMultiple).filter(isFiniteNumber).map(value => Math.abs(value));
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const rewardRisk = lossRs.length > 0
    ? average(winRs) / average(lossRs)
    : winRs.length > 0 ? Number.POSITIVE_INFINITY : 0;
  const profitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    netPnl: trades.reduce((sum, trade) => sum + trade.pnl, 0),
    profitFactor,
    avgWinR: average(winRs),
    avgLossR: average(lossRs),
    expectancyR: average(riskMultiples),
    rewardRisk,
    sharpeRatio: calcSharpe(riskMultiples),
    maxConsecutiveLosses: calcMaxConsecutiveLosses(trades),
  };
}

export function toRiskMultiple(trade: RiskLikeTrade): number {
  const plannedRiskSol = Math.abs(trade.entryPrice - trade.stopLoss) * trade.quantity;
  if (plannedRiskSol <= 0) return Number.NaN;
  return trade.pnl / plannedRiskSol;
}

export function calcMaxConsecutiveLosses<T extends Pick<RiskLikeTrade, 'pnl'>>(trades: T[]): number {
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

export function calcSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = average(returns);
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(365);
}

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}
