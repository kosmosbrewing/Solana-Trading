import type { ReturnStats } from './admissionEdgeTypes';

export const DEFAULT_CANDLE_PROOF_HORIZONS_SEC = [15, 30, 60, 300] as const;
export const DEFAULT_CANDLE_PROOF_PRE_WINDOWS_SEC = [20, 60] as const;
export const DEFAULT_CANDLE_PROOF_ROUND_TRIP_COST_PCT = 0.005;
export const DEFAULT_CANDLE_PROOF_MIN_ROWS = 30;

export type CandleProofVerdict =
  | 'CANDIDATE'
  | 'COLLECT'
  | 'DATA_GAP'
  | 'REJECT';

export type CandleProofArmRole =
  | 'allow_filter'
  | 'veto_trigger'
  | 'survivor_trail'
  | 'cooldown_keep';

export interface CandleEntryProofArgs {
  realtimeDir: string;
  sessionsDir: string;
  horizonsSec: number[];
  preWindowsSec: number[];
  roundTripCostPct: number;
  minRows: number;
  mdOut?: string;
  jsonOut?: string;
  martDir?: string;
  maxCandles?: number;
}

export interface CandleWindowFeature {
  rows: number;
  tradeCount: number;
  buyVolume: number;
  sellVolume: number;
  buyRatio: number | null;
  returnPct: number | null;
  maxAbsReturnPct: number | null;
  realizedAbsSumPct: number | null;
  upCloseShare: number | null;
  downCloseShare: number | null;
  terminalPosInRange: number | null;
}

export interface CandleHorizonOutcome {
  horizonSec: number;
  closePct: number | null;
  mfePct: number | null;
  maePct: number | null;
  quoteDeltaPct: number | null;
}

export interface CandleAnchorFeatureRow {
  key: string;
  positionId: string;
  tokenMint: string;
  anchorAt: string;
  anchorAtMs: number;
  day: string;
  source: string;
  family: string;
  mode: string;
  kolBucket: string;
  anchorPrice: number;
  tokenCandleRows: number;
  tokenFirstCandleAt: string | null;
  tokenLastCandleAt: string | null;
  coverageReason: string;
  coverageDetail: string;
  pre: Record<string, CandleWindowFeature>;
  outcomes: Record<string, CandleHorizonOutcome>;
}

export interface CandleCoverageReasonSummary {
  reason: string;
  count: number;
  share: number | null;
}

export interface CandleCoverageGroupSummary {
  groupBy: 'family' | 'source' | 'day';
  group: string;
  anchors: number;
  pre60: number;
  outcome300: number;
  fullCoverage: number;
  fullCoverageRate: number | null;
  topReasons: CandleCoverageReasonSummary[];
}

export interface CandleProofArmEvaluation {
  arm: string;
  role: CandleProofArmRole;
  family: string;
  rows: number;
  activeDays: number;
  parentRows: number;
  blockedRows: number;
  stats: ReturnStats;
  parentStats: ReturnStats;
  medianDeltaVsParent: number | null;
  lose20ReductionVsParent: number | null;
  maxLossStreak: number;
  top5WinnerShare: number | null;
  top10WinnerShare: number | null;
  winnerLeakage12Rate: number | null;
  verdict: CandleProofVerdict;
  reasons: string[];
}

export interface CandleProofFoldSummary {
  fold: string;
  arm: string;
  role: CandleProofArmRole;
  rows: number;
  activeDays: number;
  stats: ReturnStats;
  maxLossStreak: number;
  top5WinnerShare: number | null;
  verdict: CandleProofVerdict;
}

export interface CandleProofReentryCluster {
  tokenMint: string;
  day: string;
  clusterStartAt: string;
  clusterEndAt: string;
  attempts: number;
  fail30Attempts: number;
  sumReturn300: number | null;
  bestReturn300: number | null;
  worstReturn300: number | null;
}

export interface CandleEntryProofReport {
  generatedAt: string;
  realtimeDir: string;
  sessionsDir: string;
  horizonsSec: number[];
  preWindowsSec: number[];
  roundTripCostPct: number;
  minRows: number;
  anchorRows: number;
  buyAnchors: number;
  candleFiles: number;
  candleRowsScanned: number;
  anchorsWithPre60: number;
  anchorsWithOutcome300: number;
  anchorsWithFullCoverage: number;
  directCoverage: number | null;
  fullCoverage: number | null;
  coverageGroups: CandleCoverageGroupSummary[];
  evaluations: CandleProofArmEvaluation[];
  folds: CandleProofFoldSummary[];
  reentryClusters: CandleProofReentryCluster[];
  verdict: CandleProofVerdict;
  reasons: string[];
  nextActions: string[];
}
