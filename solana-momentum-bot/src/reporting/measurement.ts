export interface EdgeScoreInput {
  netPnlPct: number;
  expectancyR: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  totalTrades: number;
  positiveTokenRatio?: number | null;
}

export interface EdgeScoreBreakdown {
  netPnl: number;
  expectancy: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdown: number;
  totalTrades: number;
  positiveTokenRatio?: number;
  total: number;
  maxPossible: number;
  normalized: number;
}

export type EdgeGateStatus = 'pass' | 'weak' | 'fail';
export type BacktestStageDecision =
  | 'keep'
  | 'keep_watch'
  | 'retune'
  | 'reject'
  | 'reject_gate'
  | 'weak_sample';

export interface BacktestStageAssessment {
  edgeScore: number;
  stageScore: number;
  decision: BacktestStageDecision;
  gateStatus: EdgeGateStatus;
  gateReasons: string[];
  breakdown: EdgeScoreBreakdown;
}

export function assessBacktestStage(input: EdgeScoreInput): BacktestStageAssessment {
  return assessMeasuredEdgeStage(input);
}

export function assessMeasuredEdgeStage(input: EdgeScoreInput): BacktestStageAssessment {
  const breakdown = calculateEdgeScore(input);
  const gate = evaluateEdgeGate(input);

  return {
    edgeScore: breakdown.total,
    stageScore: breakdown.normalized,
    decision: decideBacktestStage(breakdown.normalized, gate.status),
    gateStatus: gate.status,
    gateReasons: gate.reasons,
    breakdown,
  };
}

export function calculateEdgeScore(input: EdgeScoreInput): EdgeScoreBreakdown {
  const breakdown: EdgeScoreBreakdown = {
    netPnl: scoreNetPnl(input.netPnlPct),
    expectancy: scoreExpectancy(input.expectancyR),
    profitFactor: scoreProfitFactor(input.profitFactor),
    sharpe: scoreSharpe(input.sharpeRatio),
    maxDrawdown: scoreMaxDrawdown(input.maxDrawdownPct),
    totalTrades: scoreTotalTrades(input.totalTrades),
    total: 0,
    maxPossible: 90,
    normalized: 0,
  };

  if (typeof input.positiveTokenRatio === 'number' && Number.isFinite(input.positiveTokenRatio)) {
    breakdown.positiveTokenRatio = scorePositiveTokenRatio(input.positiveTokenRatio);
    breakdown.maxPossible += 10;
  }

  breakdown.total =
    breakdown.netPnl +
    breakdown.expectancy +
    breakdown.profitFactor +
    breakdown.sharpe +
    breakdown.maxDrawdown +
    breakdown.totalTrades +
    (breakdown.positiveTokenRatio ?? 0);

  breakdown.normalized = breakdown.maxPossible > 0
    ? (breakdown.total / breakdown.maxPossible) * 100
    : 0;

  return breakdown;
}

export function evaluateEdgeGate(input: EdgeScoreInput): { status: EdgeGateStatus; reasons: string[] } {
  const failReasons: string[] = [];
  const weakReasons: string[] = [];

  if (input.expectancyR <= 0) failReasons.push('expectancy<=0R');
  if (input.netPnlPct <= 0) failReasons.push('netPnl<=0');
  if (input.profitFactor < 1.0) failReasons.push('profitFactor<1.0');
  if (typeof input.positiveTokenRatio === 'number' && input.positiveTokenRatio < 0.4) {
    failReasons.push('positiveTokenRatio<40%');
  }
  if (input.totalTrades < 10) {
    failReasons.push('totalTrades<10');
  } else if (input.totalTrades < 20) {
    weakReasons.push('totalTrades<20');
  }

  if (failReasons.length > 0) {
    return { status: 'fail', reasons: failReasons };
  }
  if (weakReasons.length > 0) {
    return { status: 'weak', reasons: weakReasons };
  }
  return { status: 'pass', reasons: [] };
}

function decideBacktestStage(score: number, gateStatus: EdgeGateStatus): BacktestStageDecision {
  if (gateStatus === 'fail') return 'reject_gate';
  if (gateStatus === 'weak') return 'weak_sample';
  if (score >= 80) return 'keep';
  if (score >= 70) return 'keep_watch';
  if (score >= 60) return 'retune';
  return 'reject';
}

function scoreNetPnl(value: number): number {
  if (value <= 0) return 0;
  if (value < 0.005) return 5;
  if (value < 0.01) return 10;
  if (value <= 0.02) return 15;
  return 20;
}

function scoreExpectancy(value: number): number {
  if (value <= 0) return 0;
  if (value < 0.1) return 5;
  if (value < 0.25) return 10;
  if (value <= 0.5) return 15;
  return 20;
}

function scoreProfitFactor(value: number): number {
  if (value < 1.0) return 0;
  if (value < 1.3) return 5;
  if (value < 1.8) return 10;
  if (value < 2.5) return 13;
  return 15;
}

function scoreSharpe(value: number): number {
  if (value <= 0) return 0;
  if (value < 0.5) return 5;
  if (value < 1.0) return 10;
  if (value < 2.0) return 13;
  return 15;
}

function scoreMaxDrawdown(value: number): number {
  if (value > 0.15) return 0;
  if (value >= 0.10) return 3;
  if (value >= 0.05) return 6;
  if (value >= 0.02) return 8;
  return 10;
}

function scoreTotalTrades(value: number): number {
  if (value < 10) return 0;
  if (value < 20) return 3;
  if (value < 50) return 6;
  if (value < 100) return 8;
  return 10;
}

function scorePositiveTokenRatio(value: number): number {
  if (value < 0.4) return 0;
  if (value < 0.5) return 3;
  if (value < 0.6) return 6;
  if (value < 0.7) return 8;
  return 10;
}
