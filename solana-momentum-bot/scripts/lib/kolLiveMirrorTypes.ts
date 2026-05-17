export const SMART_V3_FAST_FAIL_LIVE_ARM = 'smart_v3_fast_fail_live_v1';
export const SMART_V3_FAST_FAIL_LIVE_MIRROR_ARM = 'smart_v3_fast_fail_live_mirror_v1';
export const DEFAULT_LIVE_MIRROR_MIN_PAIRS = 30;
export const DEFAULT_LIVE_MIRROR_EXECUTION_DRAG_RATE = 0.2;
export const DEFAULT_LIVE_MIRROR_STRATEGY_LOSS_RATE = 0.5;

export type LiveMirrorVerdict =
  | 'COLLECT'
  | 'EXECUTION_DRAG_REVIEW'
  | 'STRATEGY_LOSS_REVIEW'
  | 'MIRROR_HEALTHY_REVIEW'
  | 'NO_CLEAR_SIGNAL';

export type LiveMirrorClassification =
  | 'strategy_loss'
  | 'execution_drag'
  | 'strategy_win_execution_ok'
  | 'paper_false_negative';

export interface KolLiveMirrorArgs {
  realtimeDir: string;
  sinceMs: number;
  minPairs: number;
  executionDragRate: number;
  strategyLossRate: number;
  mdOut?: string;
  jsonOut?: string;
}

export interface KolLiveMirrorStats {
  rows: number;
  netSol: number;
  medianNetSol: number | null;
  medianNetPct: number | null;
  positiveRate: number | null;
  medianMfePct: number | null;
  medianHoldSec: number | null;
}

export interface KolLiveMirrorPair {
  livePositionId: string;
  mirrorPositionId: string;
  tokenMint: string | null;
  decisionId: string | null;
  liveExitReason: string;
  mirrorExitReason: string;
  liveNetSol: number;
  mirrorNetSol: number;
  liveNetPct: number | null;
  mirrorNetPct: number | null;
  liveMfePct: number | null;
  mirrorMfePct: number | null;
  liveHoldSec: number | null;
  mirrorHoldSec: number | null;
  liveClosedAt: string | null;
  mirrorClosedAt: string | null;
  deltaNetSol: number;
  deltaNetPct: number | null;
  classification: LiveMirrorClassification;
}

export interface KolLiveMirrorReport {
  generatedAt: string;
  realtimeDir: string;
  since: string;
  liveArm: string;
  mirrorArm: string;
  minPairs: number;
  paperRows: number;
  liveRows: number;
  mirrorRows: number;
  pairedRows: number;
  unpairedMirrorRows: number;
  liveWithoutMirrorRows: number;
  live: KolLiveMirrorStats;
  mirror: KolLiveMirrorStats;
  deltas: {
    medianNetPct: number | null;
    medianNetSol: number | null;
    positiveRate: number | null;
  };
  classifications: Record<LiveMirrorClassification, number>;
  classificationRates: Record<LiveMirrorClassification, number | null>;
  topExecutionDrags: KolLiveMirrorPair[];
  topStrategyLosses: KolLiveMirrorPair[];
  verdict: LiveMirrorVerdict;
  reasons: string[];
  promotionGate: {
    livePromotionAllowed: false;
    requiresSeparateWalletTruthReview: true;
  };
}
