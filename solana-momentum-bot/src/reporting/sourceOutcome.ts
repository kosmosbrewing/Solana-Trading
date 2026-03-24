import { Trade } from '../utils/types';

export interface SourceOutcomeStats {
  sourceLabel: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnl: number;
}

export function summarizeTradesBySource(trades: Trade[]): SourceOutcomeStats[] {
  const grouped = new Map<string, { totalTrades: number; wins: number; losses: number; pnl: number }>();

  for (const trade of trades) {
    if (trade.status !== 'CLOSED' || trade.pnl == null) continue;

    const sourceLabel = trade.sourceLabel ?? 'unknown';
    const current = grouped.get(sourceLabel) ?? {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      pnl: 0,
    };

    current.totalTrades += 1;
    current.pnl += trade.pnl;
    if (trade.pnl > 0) {
      current.wins += 1;
    } else {
      current.losses += 1;
    }

    grouped.set(sourceLabel, current);
  }

  return [...grouped.entries()]
    .map(([sourceLabel, value]) => ({
      sourceLabel,
      totalTrades: value.totalTrades,
      wins: value.wins,
      losses: value.losses,
      winRate: value.totalTrades > 0 ? value.wins / value.totalTrades : 0,
      pnl: value.pnl,
    }))
    .sort((left, right) => {
      if (right.totalTrades !== left.totalTrades) return right.totalTrades - left.totalTrades;
      if (right.pnl !== left.pnl) return right.pnl - left.pnl;
      return left.sourceLabel.localeCompare(right.sourceLabel);
    });
}
