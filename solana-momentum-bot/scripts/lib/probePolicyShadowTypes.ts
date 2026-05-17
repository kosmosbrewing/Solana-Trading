export const PROBE_POLICY_SHADOW_ARM = 'smart_v3_probe_confirm_shadow_v1';
export const PROBE_POLICY_SHADOW_ROLE = 'probe_policy_shadow';
export const PROBE_POLICY_PARENT_ARM = 'kol_hunter_smart_v3';
export const PROBE_POLICY_PARENT_ARMS = [
  PROBE_POLICY_PARENT_ARM,
  'smart_v3_fast_fail_live_mirror_v1',
] as const;
export const DEFAULT_PROBE_POLICY_SHADOW_MIN_CLOSES = 50;
export const DEFAULT_PROBE_POLICY_SHADOW_MAX_TAIL_KILL_RATE = 0.01;

export type ProbePolicyShadowVerdict =
  | 'COLLECT'
  | 'READY_FOR_REVIEW'
  | 'TAIL_KILL_RISK'
  | 'NO_IMPROVEMENT';

export interface ProbePolicyShadowArgs {
  realtimeDir: string;
  sinceMs: number;
  minCloses: number;
  maxTailKillRate: number;
  mdOut?: string;
  jsonOut?: string;
}

export interface ProbePolicyShadowStats {
  rows: number;
  medianNetPct: number | null;
  medianNetSol: number | null;
  positiveRate: number | null;
  bigLossRate: number | null;
  tail50Rate: number | null;
  fiveXRate: number | null;
}

export interface ProbePolicyShadowComparison {
  pairedRows: number;
  parent: ProbePolicyShadowStats;
  probe: ProbePolicyShadowStats;
  medianImprovement: number | null;
  bigLossReduction: number | null;
  tailKillDelta: number | null;
}

export interface ProbePolicyShadowCohortComparison extends ProbePolicyShadowComparison {
  cohort: string;
}

export interface ProbePolicyShadowFunnel {
  parentRows: number;
  eligibleParentRows: number;
  belowMinParentRows: number;
  unknownParentRows: number;
  probeRows: number;
  eligibleProbeRows: number;
  belowMinProbeRows: number;
  unknownProbeRows: number;
  pairedRows: number;
  eligiblePairedRows: number;
  eligibleParentWithoutProbeRows: number;
  unpairedProbeRows: number;
  allPairCoverage: number | null;
  eligiblePairCoverage: number | null;
  reasons: string[];
}

export interface ProbePolicyShadowWinnerKillAudit {
  closeReason: 'probe_policy_confirm_fail_cut';
  targetOffsetSec: number;
  thresholdMfe: number;
  cutRows: number;
  observedTargetRows: number;
  winnerKillRows: number;
  winnerKillRate: number | null;
  observationCoverage: number | null;
  examples: Array<{
    positionId: string;
    tokenMint: string;
    postMfe: number;
  }>;
}

export interface ProbePolicyShadowQualitySplit {
  cohort: string;
  pairedRows: number;
  stats: ProbePolicyShadowStats;
  exitReasons: Array<{ reason: string; count: number }>;
}

export type ProbePolicyShadowPromotionCheckStatus = 'PASS' | 'COLLECT' | 'FAIL';

export interface ProbePolicyShadowPromotionCheck {
  name: string;
  status: ProbePolicyShadowPromotionCheckStatus;
  current: string;
  required: string;
}

export interface ProbePolicyShadowReport {
  generatedAt: string;
  realtimeDir: string;
  since: string;
  minCloses: number;
  maxTailKillRate: number;
  probeArm: string;
  parentArm: string;
  parentArms: string[];
  paperRows: number;
  probeRows: number;
  parentRows: number;
  pairedRows: number;
  funnel: ProbePolicyShadowFunnel;
  winnerKillAudit: ProbePolicyShadowWinnerKillAudit;
  comparison: ProbePolicyShadowComparison;
  cohorts: ProbePolicyShadowCohortComparison[];
  qualitySplits: ProbePolicyShadowQualitySplit[];
  exitReasons: Array<{ reason: string; count: number }>;
  verdict: ProbePolicyShadowVerdict;
  reasons: string[];
  promotionGate: {
    forwardPaperMinCloses: number;
    livePromotionAllowed: false;
    requiresSeparateReview: true;
    targetCohort: 'kol:KOL_3plus';
    targetPairedCloses: number;
    nextAction: 'COLLECT_FORWARD_PAPER' | 'BLOCK_PROMOTION_REVIEW_ROOT_CAUSE' | 'BUILD_WALLET_TRUTH_REVIEW_PACKET';
    checks: ProbePolicyShadowPromotionCheck[];
  };
}
