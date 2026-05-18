import type { ReturnStats } from './admissionEdgeTypes';

export const DEFAULT_MISSION_ENTRY_HORIZONS_SEC = [30, 60, 300, 1800] as const;
export const DEFAULT_MISSION_ENTRY_ROUND_TRIP_COST_PCT = 0.005;
export const DEFAULT_MISSION_ENTRY_MIN_ROWS = 50;
export const DEFAULT_MISSION_ENTRY_BLEED_SHARE_THRESHOLD = 0.5;

export const MISSION_BLEED_EXIT_REASONS = [
  'probe_hard_cut',
  'entry_advantage_emergency_exit',
  'rotation_dead_on_arrival',
  'smart_v3_mae_fast_fail',
  'rotation_mae_fast_fail',
  'quick_reject_classifier_exit',
] as const;

export const MISSION_SHADOW_ARMS = [
  'rotation_doa_veto_shadow_v1',
  'smart_v3_probe_confirm_shadow_v1',
  'rotation_good_kol_focus_v1',
] as const;

export type MissionEntryVerdict =
  | 'ADMISSION_QUALITY_ROOT_CAUSE'
  | 'ADMISSION_DECAY_CONFIRMED'
  | 'EXECUTION_OR_COST_REVIEW'
  | 'DATA_GAP'
  | 'WATCH';

export type MissionEntryCohortVerdict =
  | 'ADMISSION_DECAY_CONFIRMED'
  | 'ADMISSION_EDGE_GAP'
  | 'DATA_GAP'
  | 'WATCH';

export interface MissionEntryArgs {
  realtimeDir: string;
  horizonsSec: number[];
  roundTripCostPct: number;
  minRows: number;
  bleedShareThreshold: number;
  mdOut?: string;
  jsonOut?: string;
}

export interface MissionHorizonStats {
  horizonSec: number;
  stats: ReturnStats;
}

export interface MissionEntryCohort {
  cohort: string;
  sourceRows: number;
  horizons: MissionHorizonStats[];
  decay30To300: number | null;
  decay300To1800: number | null;
  verdict: MissionEntryCohortVerdict;
  reasons: string[];
}

export interface LiveBleedExitBucket {
  exitReason: string;
  rows: number;
  netSol: number;
  winRate: number | null;
  medianMfePct: number | null;
  medianHoldSec: number | null;
}

export interface LiveBleedSummary {
  liveRows: number;
  liveNetSol: number;
  bleedRows: number;
  bleedNetSol: number;
  bleedNetShare: number | null;
  buckets: LiveBleedExitBucket[];
}

export interface PaperShadowArmSummary {
  armName: string;
  rows: number;
  netSol: number;
  winRate: number | null;
  medianNetPct: number | null;
  medianMfePct: number | null;
  medianHoldSec: number | null;
}

export type RotationDoaVetoCoverageVerdict =
  | 'DATA_GAP'
  | 'NO_ARTIFACTS'
  | 'COVERAGE_GAP'
  | 'COLLECT_FORWARD_ROWS'
  | 'PAIRED_REVIEW_READY';

export interface RotationDoaVetoSkipReasonSummary {
  reason: string;
  count: number;
}

export interface RotationDoaVetoCoverageSummary {
  verdict: RotationDoaVetoCoverageVerdict;
  parentRows: number;
  shadowRows: number;
  pairedRows: number;
  rawSkipRows: number;
  uniqueSkipRows: number;
  attributedCoverage: number | null;
  unattributedParentRows: number;
  parentNetSol: number;
  shadowNetSol: number;
  pairedParentNetSol: number;
  pairedShadowNetSol: number;
  pairedNetDeltaSol: number | null;
  skipReasons: RotationDoaVetoSkipReasonSummary[];
  reasons: string[];
}

export interface MissionEntryReport {
  generatedAt: string;
  realtimeDir: string;
  horizonsSec: number[];
  roundTripCostPct: number;
  minRows: number;
  bleedShareThreshold: number;
  anchorRows: number;
  buyAnchors: number;
  markoutRows: number;
  okBuyMarkoutRows: number;
  candidates: number;
  verdict: MissionEntryVerdict;
  reasons: string[];
  cohorts: MissionEntryCohort[];
  liveBleed: LiveBleedSummary;
  paperShadows: PaperShadowArmSummary[];
  rotationDoaVetoCoverage: RotationDoaVetoCoverageSummary;
  nextActions: string[];
}
