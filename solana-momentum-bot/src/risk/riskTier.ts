import { EdgePerformanceStats, EdgeState, EdgeTracker, EdgeTrackerTrade } from '../reporting/edgeTracker';
import { StrategyName } from '../utils/types';
import { createDrawdownGuardState, DrawdownGuardState, updateDrawdownGuardState } from './drawdownGuard';

interface RiskTierDefinition {
  fixedRiskPerTrade: number;
  maxDailyLoss: number;
  maxDrawdownPct: number;
  kellyScale: number;
  kellyCap: number;
}

export interface RiskTierProfile {
  edgeState: EdgeState;
  maxRiskPerTrade: number;
  maxDailyLoss: number;
  maxDrawdownPct: number;
  recoveryPct: number;
  kellyFraction: number;
  kellyApplied: boolean;
  kellyMode: 'fixed' | 'quarter' | 'half';
}

const RISK_TIERS: Record<EdgeState, RiskTierDefinition> = {
  Bootstrap: {
    fixedRiskPerTrade: 0.01,
    maxDailyLoss: 0.05,
    maxDrawdownPct: 0.30,
    kellyScale: 0,
    kellyCap: 0.01,
  },
  Calibration: {
    fixedRiskPerTrade: 0.02,
    maxDailyLoss: 0.08,
    maxDrawdownPct: 0.30,
    kellyScale: 0,
    kellyCap: 0.02,
  },
  Confirmed: {
    fixedRiskPerTrade: 0.02,
    maxDailyLoss: 0.15,
    maxDrawdownPct: 0.35,
    kellyScale: 0.25,
    kellyCap: 0.0625,
  },
  Proven: {
    fixedRiskPerTrade: 0.02,
    maxDailyLoss: 0.15,
    maxDrawdownPct: 0.40,
    kellyScale: 0.50,
    kellyCap: 0.125,
  },
};

export function resolveRiskTierProfile(
  stats: Pick<EdgePerformanceStats, 'edgeState' | 'kellyFraction' | 'kellyEligible'>,
  recoveryPct: number
): RiskTierProfile {
  const tier = RISK_TIERS[stats.edgeState];
  const kellyApplied = tier.kellyScale > 0 && stats.kellyEligible;

  return {
    edgeState: stats.edgeState,
    maxRiskPerTrade: kellyApplied
      ? Math.min(stats.kellyFraction * tier.kellyScale, tier.kellyCap)
      : tier.fixedRiskPerTrade,
    maxDailyLoss: tier.maxDailyLoss,
    maxDrawdownPct: tier.maxDrawdownPct,
    recoveryPct,
    kellyFraction: stats.kellyFraction,
    kellyApplied,
    kellyMode: tier.kellyScale >= 0.5 ? 'half' : tier.kellyScale > 0 ? 'quarter' : 'fixed',
  };
}

export function resolveStrategyRiskTier(
  trades: EdgeTrackerTrade[],
  strategy: StrategyName,
  recoveryPct: number
): RiskTierProfile {
  const stats = new EdgeTracker(trades).getStrategyStats(strategy);
  return resolveRiskTierProfile(stats, recoveryPct);
}

export function resolvePortfolioRiskTier(
  trades: EdgeTrackerTrade[],
  recoveryPct: number
): RiskTierProfile {
  const stats = new EdgeTracker(trades).getPortfolioStats();
  return resolveRiskTierProfile(stats, recoveryPct);
}

export function replayStrategyDrawdownGuard(
  currentBalanceSol: number,
  trades: EdgeTrackerTrade[],
  strategy: StrategyName,
  recoveryPct: number
): DrawdownGuardState {
  return replayTieredDrawdownGuard(currentBalanceSol, trades, tracker =>
    resolveRiskTierProfile(tracker.getStrategyStats(strategy), recoveryPct)
  );
}

export function replayPortfolioDrawdownGuard(
  currentBalanceSol: number,
  trades: EdgeTrackerTrade[],
  recoveryPct: number
): DrawdownGuardState {
  return replayTieredDrawdownGuard(currentBalanceSol, trades, tracker =>
    resolveRiskTierProfile(tracker.getPortfolioStats(), recoveryPct)
  );
}

function replayTieredDrawdownGuard(
  currentBalanceSol: number,
  trades: EdgeTrackerTrade[],
  getProfile: (tracker: EdgeTracker) => RiskTierProfile
): DrawdownGuardState {
  const totalRealizedPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  let balance = currentBalanceSol - totalRealizedPnl;
  let state = createDrawdownGuardState(balance);
  const tracker = new EdgeTracker();

  for (const trade of trades) {
    tracker.recordTrade(trade);
    balance += trade.pnl;
    state = updateDrawdownGuardState(state, balance, getProfile(tracker));
  }

  return state;
}
