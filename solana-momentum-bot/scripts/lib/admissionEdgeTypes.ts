export const DEFAULT_CONFIRM_HORIZON_SEC = 60;
export const DEFAULT_TARGET_HORIZON_SEC = 300;
export const DEFAULT_CARRY_HORIZON_SEC = 1800;
export const DEFAULT_CONFIRM_THRESHOLD_PCT = 0.12;
export const DEFAULT_ROUND_TRIP_COST_PCT = 0.005;

export type AdmissionVerdict =
  | 'DATA_GAP'
  | 'ADMISSION_EDGE_GAP'
  | 'PROBE_HOLD_CUT_REVIEW'
  | 'WATCH';

export interface JsonRow {
  [key: string]: unknown;
}

export interface AdmissionEdgeArgs {
  realtimeDir: string;
  confirmHorizonSec: number;
  targetHorizonSec: number;
  carryHorizonSec: number;
  confirmThresholdPct: number;
  roundTripCostPct: number;
  mdOut?: string;
  jsonOut?: string;
}

export interface AnchorMeta {
  key: string;
  positionId: string;
  anchorAt: string;
  source: string;
  family: string;
  mode: string;
  kolBucket: string;
}

export interface MarkoutCandidate extends AnchorMeta {
  deltas: Map<number, number>;
}

export interface ReturnStats {
  rows: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
  trimmedAverage: number | null;
  positiveRate: number | null;
  ge5Rate: number | null;
  ge12Rate: number | null;
  ge50Rate: number | null;
  leNeg5Rate: number | null;
  leNeg10Rate: number | null;
  leNeg20Rate: number | null;
}

export interface CohortAdmissionEdge {
  cohort: string;
  rows: number;
  coverageRows: number;
  baseline: ReturnStats;
  confirmPassAnchorToTarget: ReturnStats;
  confirmFailAnchorToTarget: ReturnStats;
  delayedEntryPassToTarget: ReturnStats;
  delayedEntryPassToCarry: ReturnStats;
  holdIfConfirmElseCut: ReturnStats;
  passRows: number;
  failRows: number;
  verdict: AdmissionVerdict;
  reasons: string[];
}

export interface AdmissionEdgeReport {
  generatedAt: string;
  realtimeDir: string;
  confirmHorizonSec: number;
  targetHorizonSec: number;
  carryHorizonSec: number;
  confirmThresholdPct: number;
  roundTripCostPct: number;
  anchorRows: number;
  buyAnchors: number;
  markoutRows: number;
  okBuyMarkoutRows: number;
  candidates: number;
  cohorts: CohortAdmissionEdge[];
  verdict: AdmissionVerdict;
  reasons: string[];
}
