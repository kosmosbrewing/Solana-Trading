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
    fixedRiskPerTrade: 0.01,  // Bootstrap/Calibration 모두 1% 고정 (strategy-catalog 참조)
    // 2026-04-29: 5% → 15% (Confirmed/Proven 와 정합).
    // Why: floor 0.7 SOL + KOL canary cap 0.2 SOL 가 이미 catastrophic day 방어 cover.
    //   기존 5% 는 wallet ~1 SOL 기준 0.05 SOL 일 limit → mission §3 (200 trades + 5x winner)
    //   측정 단계에서 인위적 거래 차단 (-0.094 SOL 에서 halt 사례 2026-04-29 발생).
    //   floor 까지 여유 0.24 SOL 인데 0.05 SOL 에서 멈추는 misalignment.
    //   Calibration tier 도 lane 별 canaryCap (cupsey/kol_hunter) 가 일별 보호 → 15% 로 통일.
    maxDailyLoss: 0.15,
    maxDrawdownPct: 0.30,
    kellyScale: 0,
    kellyCap: 0.01,
  },
  Confirmed: {
    fixedRiskPerTrade: 0.02,
    maxDailyLoss: 0.15,
    maxDrawdownPct: 0.35,
    kellyScale: 0.25,
    kellyCap: 0.03, // v2: 6.25%→3% — 마이크로캡 exit-liquidity 부족 대응
  },
  Proven: {
    fixedRiskPerTrade: 0.02,
    maxDailyLoss: 0.15,
    maxDrawdownPct: 0.40,
    kellyScale: 0.25, // v2: 1/2→1/4 Kelly — 생존 우선
    kellyCap: 0.05,   // v2: 12.5%→5% — 마이크로캡 exit-liquidity 부족 대응
  },
};

/** 선형 보간 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

export function resolveRiskTierProfile(
  stats: Pick<EdgePerformanceStats, 'edgeState' | 'kellyFraction' | 'kellyEligible' | 'totalTrades'>,
  recoveryPct: number
): RiskTierProfile {
  const tier = RISK_TIERS[stats.edgeState];
  const kellyApplied = tier.kellyScale > 0 && stats.kellyEligible;

  let maxRiskPerTrade = kellyApplied
    ? Math.min(stats.kellyFraction * tier.kellyScale, tier.kellyCap)
    : tier.fixedRiskPerTrade;

  // v4: 보간 — tier 경계에서 급변(cliff) 방지
  const tc = stats.totalTrades;

  // Calibration→Confirmed 전환 (trades 40~60): calibrationRisk → confirmedRisk
  if (stats.edgeState === 'Confirmed' && tc >= 40 && tc < 60) {
    const calibrationRisk = RISK_TIERS.Calibration.fixedRiskPerTrade; // 1%
    const confirmedRisk = maxRiskPerTrade;
    if (confirmedRisk > calibrationRisk) {
      const progress = (tc - 40) / 20;
      maxRiskPerTrade = lerp(calibrationRisk, confirmedRisk, progress);
    }
  }

  // Confirmed→Proven 전환 (trades 85~115): confirmedRisk → provenRisk
  if (stats.edgeState === 'Proven' && tc >= 85 && tc < 115) {
    const prevTierRisk = kellyApplied
      ? RISK_TIERS.Confirmed.kellyCap   // Kelly 활성 시 이전 tier cap
      : RISK_TIERS.Confirmed.fixedRiskPerTrade; // Kelly 비활성 시 이전 tier fixed
    const provenRisk = maxRiskPerTrade;
    if (provenRisk > prevTierRisk) {
      const progress = (tc - 85) / 30;
      maxRiskPerTrade = lerp(prevTierRisk, provenRisk, progress);
    }
  }

  return {
    edgeState: stats.edgeState,
    maxRiskPerTrade,
    maxDailyLoss: tier.maxDailyLoss,
    maxDrawdownPct: tier.maxDrawdownPct,
    recoveryPct,
    kellyFraction: stats.kellyFraction,
    kellyApplied,
    // v2: Proven도 1/4 Kelly. 'half' 타입은 향후 복원 가능성 유지
    kellyMode: tier.kellyScale >= 0.5 ? 'half' : tier.kellyScale > 0 ? 'quarter' : 'fixed',
  };
}

/**
 * Phase 4: Resolve risk tier with demotion check.
 * Uses EdgeTracker.checkDemotion() to detect recent performance degradation.
 * On demotion: drops one tier (Proven→Confirmed, Confirmed→Calibration).
 */
export function resolveRiskTierWithDemotion(
  edgeTracker: EdgeTracker,
  recoveryPct: number,
  mode: 'portfolio' | StrategyName = 'portfolio'
): { profile: RiskTierProfile; demoted: boolean; demotionReason?: string } {
  // Why: portfolio mode에서는 sandbox trade를 제외하여 main lane만 평가
  const stats = mode === 'portfolio'
    ? edgeTracker.getMainPortfolioStats()
    : edgeTracker.getStrategyStats(mode as StrategyName);

  let profile = resolveRiskTierProfile(stats, recoveryPct);

  // Check demotion (H-08: strategy mode 전달)
  const demotion = mode === 'portfolio'
    ? edgeTracker.checkDemotion()
    : edgeTracker.checkDemotion(mode as StrategyName);
  if (demotion.shouldDemote) {
    const demotedState = demoteEdgeState(profile.edgeState);
    if (demotedState !== profile.edgeState) {
      const kellyEligible = demotedState === 'Confirmed' || demotedState === 'Proven';
      const demotedStats = {
        ...stats,
        edgeState: demotedState,
        kellyEligible,
        // C-14: 강등 시 Kelly fraction도 리셋 (eligible하지 않으면 0)
        kellyFraction: kellyEligible ? stats.kellyFraction : 0,
      };
      profile = resolveRiskTierProfile(demotedStats, recoveryPct);
      return { profile, demoted: true, demotionReason: demotion.reason };
    }
  }

  return { profile, demoted: false };
}

function demoteEdgeState(state: EdgeState): EdgeState {
  switch (state) {
    case 'Proven': return 'Confirmed';
    case 'Confirmed': return 'Calibration';
    default: return state;
  }
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
  // Why: sandbox trade 제외 — main lane만 risk tier 산출에 사용
  const stats = new EdgeTracker(trades).getMainPortfolioStats();
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
  // Why: sandbox trade 제외 — main lane만 drawdown guard 평가에 사용
  return replayTieredDrawdownGuard(currentBalanceSol, trades, tracker =>
    resolveRiskTierProfile(tracker.getMainPortfolioStats(), recoveryPct)
  );
}

// H-23: tier 변경 가능한 trade 수 경계 — 이 시점에서만 프로필 재계산
const TIER_BOUNDARIES = new Set([20, 50, 100]);

function replayTieredDrawdownGuard(
  currentBalanceSol: number,
  trades: EdgeTrackerTrade[],
  getProfile: (tracker: EdgeTracker) => RiskTierProfile
): DrawdownGuardState {
  const totalRealizedPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  let balance = currentBalanceSol - totalRealizedPnl;
  let state = createDrawdownGuardState(balance);
  const tracker = new EdgeTracker();
  let cachedProfile: RiskTierProfile | null = null;

  for (let i = 0; i < trades.length; i++) {
    tracker.recordTrade(trades[i]);
    balance += trades[i].pnl;
    const tradeCount = i + 1;
    // 프로필 재계산: 첫 trade, tier 경계, 마지막 trade
    if (!cachedProfile || TIER_BOUNDARIES.has(tradeCount) || i === trades.length - 1) {
      cachedProfile = getProfile(tracker);
    }
    state = updateDrawdownGuardState(state, balance, cachedProfile);
  }

  return state;
}
