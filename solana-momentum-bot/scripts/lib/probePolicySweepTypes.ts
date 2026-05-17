import { type ReturnStats } from './admissionEdgeTypes';

export const DEFAULT_PROBE_CONFIRM_HORIZONS_SEC = [30, 45, 60, 90];
export const DEFAULT_PROBE_CONFIRM_THRESHOLDS_PCT = [0.05, 0.08, 0.12, 0.15];
export const DEFAULT_PROBE_TARGET_HORIZONS_SEC = [180, 300, 600, 1800];
export const DEFAULT_PROBE_SWEEP_MIN_ROWS = 50;
export const DEFAULT_PROBE_SWEEP_MAX_TAIL_KILL_RATE = 0.01;
export const DEFAULT_PROBE_SWEEP_MIN_MEDIAN_LOSS_REDUCTION = 0.3;
export const DEFAULT_PROBE_ROUND_TRIP_COST_PCT = 0.005;

export type ProbePolicyVerdict =
  | 'PROBE_POLICY_CANDIDATE'
  | 'REJECT_TAIL_KILL'
  | 'REJECT_NO_IMPROVEMENT'
  | 'DATA_GAP'
  | 'WATCH';

export interface ProbePolicySweepArgs {
  realtimeDir: string;
  confirmHorizonsSec: number[];
  confirmThresholdsPct: number[];
  targetHorizonsSec: number[];
  roundTripCostPct: number;
  minRows: number;
  maxTailKillRate: number;
  minMedianLossReduction: number;
  mdOut?: string;
  jsonOut?: string;
}

export interface ProbePolicyResult {
  cohort: string;
  confirmHorizonSec: number;
  confirmThresholdPct: number;
  targetHorizonSec: number;
  coveredRows: number;
  passRows: number;
  failRows: number;
  baseline: ReturnStats;
  probeHoldCut: ReturnStats;
  delayedEntryPassToTarget: ReturnStats;
  medianImprovement: number | null;
  medianLossReduction: number | null;
  loser20Reduction: number | null;
  tailKillDelta: number | null;
  score: number | null;
  verdict: ProbePolicyVerdict;
  reasons: string[];
}

export interface ProbePolicySweepReport {
  generatedAt: string;
  realtimeDir: string;
  confirmHorizonsSec: number[];
  confirmThresholdsPct: number[];
  targetHorizonsSec: number[];
  roundTripCostPct: number;
  minRows: number;
  maxTailKillRate: number;
  minMedianLossReduction: number;
  anchorRows: number;
  buyAnchors: number;
  markoutRows: number;
  okBuyMarkoutRows: number;
  candidates: number;
  verdict: ProbePolicyVerdict;
  topPolicies: ProbePolicyResult[];
  bestByCohort: ProbePolicyResult[];
  forwardShadowCandidates: ProbePolicyResult[];
  promotionGate: {
    status: 'FORWARD_PAPER_SHADOW_READY' | 'NO_FORWARD_SHADOW_CANDIDATE';
    forwardPaperMinCloses: number;
    livePromotionMinCloses: number;
    requiresNoTailKillIncrease: boolean;
    requiresWalletTruthReview: boolean;
  };
  results: ProbePolicyResult[];
  reasons: string[];
}
