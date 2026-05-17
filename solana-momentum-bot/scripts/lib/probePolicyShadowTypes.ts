export const PROBE_POLICY_SHADOW_ARM = 'smart_v3_probe_confirm_shadow_v1';
export const PROBE_POLICY_SHADOW_ROLE = 'probe_policy_shadow';
export const PROBE_POLICY_PARENT_ARM = 'kol_hunter_smart_v3';
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

export interface ProbePolicyShadowReport {
  generatedAt: string;
  realtimeDir: string;
  since: string;
  minCloses: number;
  maxTailKillRate: number;
  probeArm: string;
  parentArm: string;
  paperRows: number;
  probeRows: number;
  parentRows: number;
  pairedRows: number;
  comparison: ProbePolicyShadowComparison;
  exitReasons: Array<{ reason: string; count: number }>;
  verdict: ProbePolicyShadowVerdict;
  reasons: string[];
  promotionGate: {
    forwardPaperMinCloses: number;
    livePromotionAllowed: false;
    requiresSeparateReview: true;
  };
}
