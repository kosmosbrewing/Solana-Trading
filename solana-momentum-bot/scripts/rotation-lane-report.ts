#!/usr/bin/env ts-node
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import {
  DEFAULT_DEV_WALLET_CANDIDATE_PATH,
  loadDevWalletCandidateIndex,
  lookupDevWalletCandidate,
  type DevWalletCandidateIndex,
} from '../src/observability/devWalletCandidateRegistry';
import {
  buildKolTransferPosteriorReport,
  loadKolPosteriorCoverageTargetsWithStatus,
  type KolPosteriorCoverage,
  type KolPosteriorCoverageLoadStatus,
  type KolPosteriorCoverageSummary,
  type KolPosteriorCoverageTarget,
  type KolPosteriorMetrics,
  type KolTransferRow,
} from './kol-transfer-posterior-report';

const ROTATION_PAPER_TRADES_FILE = 'rotation-v1-paper-trades.jsonl';
const ROTATION_LIVE_TRADES_FILE = 'rotation-v1-live-trades.jsonl';
const KOL_PAPER_TRADES_FILE = 'kol-paper-trades.jsonl';
const KOL_LIVE_EQUIVALENCE_FILE = 'kol-live-equivalence.jsonl';
const KOL_POLICY_DECISIONS_FILE = 'kol-policy-decisions.jsonl';
const KOL_TX_FILE = 'kol-tx.jsonl';
const KOL_CALL_FUNNEL_FILE = 'kol-call-funnel.jsonl';
const KOL_TRANSFER_INPUT_FILE = 'kol-transfers.jsonl';
const EVIDENCE_MIN_CLOSES = 50;
const EVIDENCE_PROMOTION_MIN_CLOSES = 100;
const EVIDENCE_MIN_OK_COVERAGE = 0.8;
const EVIDENCE_MIN_EDGE_COVERAGE = 0.8;
const EVIDENCE_MIN_EDGE_PASS_RATE = 0.5;
const EVIDENCE_MIN_ROUTE_PROOF_COVERAGE = 1;
const EVIDENCE_PRIMARY_HORIZONS_SEC = [15, 30];
const EVIDENCE_DECAY_HORIZON_SEC = 60;
const EVIDENCE_REQUIRED_COVERAGE_HORIZONS_SEC = EVIDENCE_PRIMARY_HORIZONS_SEC;
const ROTATION_DECAY_GRACE_MIN_TOKENS = 10;
const ROTATION_CONTROL_ARM = 'kol_hunter_rotation_v1';
const ROTATION_LIVE_READINESS_ARM = 'rotation_underfill_cost_aware_exit_v2';
const ROTATION_LIVE_READINESS_MIN_CLOSES = 50;
const ROTATION_LIVE_READINESS_MIN_POST_COST_POSITIVE_RATE = 0.5;
const ROTATION_PAPER_COMPOUND_MIN_CLOSES = 50;
const ROTATION_PAPER_COMPOUND_MIN_POST_COST_POSITIVE_RATE = 0.55;
const ROTATION_COMPOUND_REVIEW_MIN_CLOSES = 30;
const ROTATION_COMPOUND_DECISION_MIN_CLOSES = 50;
const ROTATION_COMPOUND_EARLY_REJECT_MIN_CLOSES = 10;
const ROTATION_COMPOUND_EARLY_MIN_POST_COST_POSITIVE_RATE = 0.45;
const ROTATION_COMPOUND_MAX_LOSING_STREAK = 5;
const POSTHOC_SECOND_KOL_REVIEW_MIN_OBSERVED = 30;
const POSTHOC_SECOND_KOL_DECISION_MIN_OBSERVED = 50;
const POSTHOC_SECOND_KOL_MIN_POSITIVE_RATE = 0.7;
const POSTHOC_SECOND_KOL_REJECT_POSITIVE_RATE = 0.6;
const POSTHOC_SECOND_KOL_SYNTHETIC_ARM = 'posthoc_2nd_kol_wait_next_horizon_v1';
const MICRO_LIVE_REVIEW_TICKET_SOL = 0.02;
const MICRO_LIVE_REVIEW_MAX_DAILY_ATTEMPTS = 3;
const MICRO_LIVE_REVIEW_DAILY_LOSS_CAP_SOL = 0.03;
const ROTATION_REPLAY_RECENT_SELL_SEC = 60;
const ROTATION_REPLAY_MIN_BUY_COUNT = 3;
const ROTATION_REPLAY_MIN_SMALL_BUY_COUNT = 2;
const ROTATION_REPLAY_SMALL_BUY_MAX_SOL = 0.12;
const ROTATION_REPLAY_MIN_GROSS_BUY_SOL = 1.0;
const ROTATION_REPLAY_MAX_LAST_BUY_AGE_SEC = 15;
const ROTATION_UNDERFILL_REPLAY_MAX_LAST_BUY_AGE_SEC = 45;

interface Args {
  realtimeDir: string;
  sinceMs: number;
  horizonsSec: number[];
  roundTripCostPct: number;
  paperTradesFileName?: string;
  assumedAtaRentSol?: number;
  assumedNetworkFeeSol?: number;
  candidateFile?: string;
  kolTransferInput?: string;
  kolDbPath?: string;
  routeProofFreshSinceMs?: number;
  mdOut?: string;
  jsonOut?: string;
}

interface JsonRow {
  [key: string]: unknown;
}

interface HorizonStats {
  horizonSec: number;
  rows: number;
  okRows: number;
  positiveRows: number;
  strongRows: number;
  t1Rows: number;
  positivePostCostRows: number;
  avgDeltaPct: number | null;
  medianDeltaPct: number | null;
  p25DeltaPct: number | null;
  avgPostCostDeltaPct: number | null;
  medianPostCostDeltaPct: number | null;
  p25PostCostDeltaPct: number | null;
}

interface ArmHorizonStats {
  armName: string;
  afterBuy: HorizonStats[];
  afterSell: HorizonStats[];
}

interface PaperArmStats {
  armName: string;
  rows: number;
  wins: number;
  losses: number;
  netSol: number;
  netSolTokenOnly: number;
  refundAdjustedNetSol: number;
  rentAdjustedNetSol: number;
  edgeRows: number;
  edgePassRows: number;
  edgeFailRows: number;
  routeProofRows: number;
  medianEdgeCostRatio: number | null;
  medianEdgeWalletDragRatio: number | null;
  medianRequiredGrossMovePct: number | null;
  hardCutRows: number;
  t1Rows: number;
  tokenOnlyWinnerRefundLoserRows: number;
  mfe5RefundLoserRows: number;
  mfe12RefundLoserRows: number;
  mae5Within15Rows: number;
  mae10BeforeT1Rows: number;
  medianMaeWorstPct: number | null;
  medianHardCutMaePct: number | null;
  medianHoldSec: number | null;
  topExitReasons: Array<{ reason: string; count: number }>;
}

interface WinnerEntryPairingStats {
  armName: string;
  exitBucket: 'winner_trailing_t1' | 'other_exits';
  rows: number;
  wins: number;
  losses: number;
  netSol: number;
  netSolTokenOnly: number;
  refundAdjustedNetSol: number;
  rentAdjustedNetSol: number;
  medianMfePct: number | null;
  medianMaePct: number | null;
  medianHoldSec: number | null;
}

interface WinnerEntryDiagnosticStats {
  armName: string;
  exitBucket: 'winner_trailing_t1' | 'other_exits';
  rows: number;
  medianTopupStrength: number | null;
  medianSellPressure30: number | null;
  medianAnchorBuySol: number | null;
  freshTopupRate: number | null;
  highRiskFlagRate: number | null;
  unknownQualityRate: number | null;
}

interface UnderfillEntryQualityStats {
  scope: 'paper' | 'live';
  rows: number;
  referenceRows: number;
  medianEntryVsKolFillPct: number | null;
  p75EntryVsKolFillPct: number | null;
  favorableRows: number;
  unfavorableRows: number;
}

interface UnderfillRouteCohortStats {
  cohort: string;
  rows: number;
  routeKnownRows: number;
  routeUnknownRows: number;
  independentKol2Rows: number;
  unknownKolRows: number;
  costAwareRows: number;
  wins: number;
  losses: number;
  netSol: number;
  netSolTokenOnly: number;
  refundAdjustedNetSol: number;
  refundAdjustedWinRows: number;
  edgePassRows: number;
  edgeFailRows: number;
  t1Rows: number;
  medianMfePct: number | null;
  medianHoldSec: number | null;
}

interface LiveEquivalenceBucketStats {
  bucket: string;
  rows: number;
  liveWouldEnterRows: number;
  liveAttemptedRows: number;
  blockedRows: number;
  singleKolRows: number;
  twoPlusKolRows: number;
  unknownKolRows: number;
}

interface LiveEquivalenceSummary {
  totalRows: number;
  rotationRows: number;
  liveWouldEnterRows: number;
  liveAttemptedRows: number;
  blockedRows: number;
  yellowZoneRows: number;
  yellowZoneSingleKolRows: number;
  yellowZoneTwoPlusKolRows: number;
  yellowZoneUnknownKolRows: number;
  routeUnknownFallbackRows: number;
  byStage: LiveEquivalenceBucketStats[];
  byBlockReason: LiveEquivalenceBucketStats[];
}

interface RouteUnknownReasonStats {
  reason: string;
  rows: number;
  wins: number;
  losses: number;
  refundAdjustedNetSol: number;
  t1Rows: number;
  medianMfePct: number | null;
  medianHoldSec: number | null;
}

interface RotationCompoundProfile {
  cohort: string;
  rows: number;
  refundAdjustedNetSol: number;
  walletDragStressSol: number;
  postCostPositiveRate: number | null;
  t1Rate: number | null;
  maxLosingStreak: number;
  winnerRows: number;
  winnerRefundAdjustedNetSol: number;
  nonWinnerRows: number;
  nonWinnerRefundAdjustedNetSol: number;
  medianHoldSec: number | null;
  medianMfePct: number | null;
}

interface RouteTruthAuditStats {
  bucket: string;
  rows: number;
  routeKnownRows: number;
  routeUnknownRows: number;
  recoverability: 'ready' | 'structural_block' | 'data_gap' | 'infra_retry' | 'unknown';
  wins: number;
  losses: number;
  refundAdjustedNetSol: number;
  medianMfePct: number | null;
  topReasons: Array<{ reason: string; count: number }>;
}

interface KolTimingStats {
  bucket: string;
  rows: number;
  routeKnownRows: number;
  costAwareRows: number;
  refundAdjustedNetSol: number;
  t1Rows: number;
  medianSecondKolDelaySec: number | null;
}

interface PosthocSecondKolStats {
  cohort: string;
  rows: number;
  routeKnownRows: number;
  costAwareRows: number;
  wins: number;
  losses: number;
  refundAdjustedNetSol: number;
  t1Rows: number;
  medianMfePct: number | null;
  medianSecondKolDelaySec: number | null;
}

interface PosthocSecondKolWaitProxyStats {
  cohort: string;
  exitProfile: string;
  rows: number;
  observedRows: number;
  currentRefundAdjustedNetSol: number;
  currentPostCostPositiveRate: number | null;
  medianWaitEntryDeltaPct: number | null;
  waitEntryFavorableRows: number;
  positiveRows: number;
  postCostPositiveRate: number | null;
  medianPostCostDeltaPct: number | null;
  p25PostCostDeltaPct: number | null;
}

type PosthocSecondKolCandidateVerdict =
  | 'COLLECT'
  | 'WATCH'
  | 'REJECT'
  | 'PAPER_CANDIDATE';

type PosthocSecondKolRouteProofVerdict =
  | 'COLLECT'
  | 'ROUTE_PROOF_MISSING'
  | 'PARTIAL_ROUTE_PROOF'
  | 'ROUTE_PROOF_READY';

interface PosthocSecondKolCandidateDecision {
  cohort: string;
  exitProfile: string;
  verdict: PosthocSecondKolCandidateVerdict;
  observedRows: number;
  minReviewObserved: number;
  minDecisionObserved: number;
  postCostPositiveRate: number | null;
  medianPostCostDeltaPct: number | null;
  p25PostCostDeltaPct: number | null;
  currentRefundAdjustedNetSol: number | null;
  reasons: string[];
}

interface PosthocSecondKolSyntheticPaperArm {
  armName: string;
  sourceCohort: string;
  verdict: PosthocSecondKolCandidateVerdict;
  observedRows: number;
  minDecisionObserved: number;
  postCostPositiveRate: number | null;
  medianPostCostDeltaPct: number | null;
  p25PostCostDeltaPct: number | null;
  currentRefundAdjustedNetSol: number | null;
  proxyOnly: true;
  liveEquivalent: false;
  reasons: string[];
}

interface PosthocSecondKolRouteProofGate {
  cohort: string;
  verdict: PosthocSecondKolRouteProofVerdict;
  rows: number;
  candidateIdRows: number;
  routeKnownRows: number;
  routeProofRows: number;
  routeUnknownRows: number;
  costAwareRows: number;
  structuralBlockRows: number;
  dataGapRows: number;
  infraRetryRows: number;
  unknownRows: number;
  explicitNoSellRouteRows: number;
  exitLiquidityUnknownRows: number;
  securityDataGapRows: number;
  mixedExitLiquidityAndDataGapRows: number;
  missingPositiveEvidenceRows: number;
  recoveryHint: string;
  refundAdjustedNetSol: number | null;
  topReasons: Array<{ reason: string; count: number }>;
  reasons: string[];
}

interface PosthocSecondKolRecoveryBacklogItem {
  cohort: string;
  priority: 'P0' | 'P1' | 'P2';
  status: 'TODO' | 'WAIT_SAMPLE' | 'BLOCKED' | 'READY_FOR_REVIEW';
  nextSprint: string;
  evidenceGap: string;
  requiredBeforeLive: string;
  liveStance: string;
}

interface LiveEquivalenceDrilldownStats {
  bucket: string;
  rows: number;
  candidateIdRows: number;
  missingCandidateIdRows: number;
  unlinkedRows: number;
  reviewCohortLinkedRows: number;
  liveWouldEnterRows: number;
  blockedRows: number;
  paperCloses: number;
  paperWins: number;
  paperRefundAdjustedNetSol: number;
  blockedPaperWinnerRows: number;
  medianPaperMfePct: number | null;
}

interface PaperCohortValidityStats {
  cohort: string;
  rows: number;
  candidateIdRows: number;
  candidateIdCoverage: number | null;
  independentKolRows: number;
  participantRows: number;
  participantTimestampRows: number;
  routeProofRows: number;
  costAwareRows: number;
  unknownTimingRows: number;
}

interface ReviewCohortGenerationAuditStats {
  cohort: string;
  diagnosis: string;
  nextAction: string;
  underfillRows: number;
  routeKnownRows: number;
  costAwareRows: number;
  twoPlusKolRows: number;
  routeKnownTwoPlusRows: number;
  routeKnownCostAwareRows: number;
  singleKolRouteKnownCostAwareRows: number;
  reviewRows: number;
  missingRouteProofRows: number;
  missingCandidateIdRows: number;
  missingParticipantTimestampRows: number;
  reviewMissingCandidateIdRows: number;
  reviewMissingParticipantTimestampRows: number;
  primaryRouteKnownTwoPlusRows: number;
  primaryRouteKnownTwoPlusWithoutCostAwareCloneRows: number;
  blockerReasons: Array<{ reason: string; count: number }>;
}

type RotationSecondKolOpportunityVerdict =
  | 'NO_UNDERFILL_ROWS'
  | 'NO_SINGLE_KOL_ROWS'
  | 'NO_TX_COVERAGE'
  | 'TRUE_SINGLE_KOL_DOMINANT'
  | 'SECOND_KOL_LINKAGE_GAP'
  | 'COLLECT';

interface RotationSecondKolOpportunityTokenStats {
  tokenMint: string;
  shortMint: string;
  rows: number;
  secondKolRows: number;
  secondKolWithin30Rows: number;
  routeKnownCostAwareRows: number;
  routeKnownCostAwareSecondWithin30Rows: number;
  medianSecondKolDelaySec: number | null;
  topSecondKols: Array<{ kol: string; count: number }>;
}

interface RotationSecondKolOpportunityFunnelStats {
  verdict: RotationSecondKolOpportunityVerdict;
  reasons: string[];
  underfillRows: number;
  singleKolRows: number;
  rowsWithToken: number;
  rowsWithEntryTime: number;
  rowsWithTxCoverage: number;
  routeKnownCostAwareSingleRows: number;
  secondKolSeenRows: number;
  secondKolWithin15Rows: number;
  secondKolWithin30Rows: number;
  secondKolWithin60Rows: number;
  secondKolLate180Rows: number;
  routeKnownCostAwareSecondWithin30Rows: number;
  potentialReviewRows: number;
  trueSingleRows: number;
  freshCutoffSource: RouteProofFreshnessStats['cutoffSource'];
  freshSince: string | null;
  freshUnderfillRows: number;
  freshSingleKolRows: number;
  freshRowsWithToken: number;
  freshRowsWithEntryTime: number;
  freshRowsWithTxCoverage: number;
  freshRouteKnownCostAwareSingleRows: number;
  freshSecondKolSeenRows: number;
  freshSecondKolWithin30Rows: number;
  freshRouteKnownCostAwareSecondWithin30Rows: number;
  freshNextSprint: string;
  topSecondKols: Array<{ kol: string; count: number }>;
  topTokens: RotationSecondKolOpportunityTokenStats[];
}

type RotationSecondKolPromotionGapVerdict =
  | 'NO_SECOND_KOL_30'
  | 'BLOCKED_BY_ROUTE_PROOF_AND_COST_AWARE'
  | 'BLOCKED_BY_ROUTE_PROOF'
  | 'BLOCKED_BY_COST_AWARE'
  | 'REVIEW_CANDIDATES_EXIST'
  | 'COLLECT';

interface RotationSecondKolPromotionGapTokenStats {
  tokenMint: string;
  shortMint: string;
  rows: number;
  routeProofRows: number;
  costAwareRows: number;
  routeKnownCostAwareRows: number;
  medianSecondKolDelaySec: number | null;
  topRouteUnknownReasons: Array<{ reason: string; count: number }>;
}

type RouteProofRecoveryHint =
  | 'collect_sample'
  | 'route_proof_ready'
  | 'review_true_no_route_before_live'
  | 'record_exit_quote_and_security_evidence'
  | 'record_exit_quote_evidence'
  | 'record_security_client_evidence'
  | 'record_positive_route_probe'
  | 'collect_more_rows';

interface RouteProofRecoverySummary {
  routeKnownRows: number;
  routeProofRows: number;
  structuralBlockRows: number;
  dataGapRows: number;
  infraRetryRows: number;
  unknownRows: number;
  explicitNoSellRouteRows: number;
  exitLiquidityUnknownRows: number;
  securityDataGapRows: number;
  mixedExitLiquidityAndDataGapRows: number;
  missingPositiveEvidenceRows: number;
  recoveryHint: RouteProofRecoveryHint;
  nextSprint: string;
}

interface RotationSecondKolPromotionGapStats {
  verdict: RotationSecondKolPromotionGapVerdict;
  reasons: string[];
  rows: number;
  routeProofRows: number;
  routeUnknownRows: number;
  costAwareRows: number;
  routeKnownCostAwareRows: number;
  routeKnownMissingCostAwareRows: number;
  costAwareRouteUnknownRows: number;
  candidateIdRows: number;
  participantTimestampRows: number;
  structuralBlockRows: number;
  dataGapRows: number;
  infraRetryRows: number;
  unknownRows: number;
  explicitNoSellRouteRows: number;
  exitLiquidityUnknownRows: number;
  securityDataGapRows: number;
  mixedExitLiquidityAndDataGapRows: number;
  missingPositiveEvidenceRows: number;
  recoveryHint: RouteProofRecoveryHint;
  nextSprint: string;
  freshCutoffSource: RouteProofFreshnessStats['cutoffSource'];
  freshSince: string | null;
  freshRows: number;
  staleRows: number;
  freshRouteProofRows: number;
  freshRouteUnknownRows: number;
  freshCostAwareRows: number;
  freshRouteKnownCostAwareRows: number;
  freshExitQuoteEvidenceRows: number;
  freshNextSprint: string;
  medianSecondKolDelaySec: number | null;
  medianMfePct: number | null;
  refundAdjustedNetSol: number | null;
  topRouteUnknownReasons: Array<{ reason: string; count: number }>;
  topMissingCostAwareArms: Array<{ arm: string; count: number }>;
  topExitReasons: Array<{ reason: string; count: number }>;
  topTokens: RotationSecondKolPromotionGapTokenStats[];
}

interface ReviewCohortEvidenceStats {
  cohort: string;
  closes: number;
  candidateIdRows: number;
  liveEquivalenceRows: number;
  linkedLiveEquivalenceRows: number;
  missingCandidateIdLiveRows: number;
  unlinkedLiveEquivalenceRows: number;
  routeProofRows: number;
  timestampedSecondKolRows: number;
  refundAdjustedNetSol: number | null;
  postCostPositiveRate: number | null;
  t1Rate: number | null;
  minOkCoverage: number | null;
  primaryHorizonPostCost: Array<{ horizonSec: number; medianPostCostDeltaPct: number | null }>;
  routeProofSources: Array<{ source: string; count: number }>;
  kolTimingBuckets: Array<{ bucket: string; count: number }>;
  liveBlockReasons: Array<{ reason: string; count: number }>;
}

interface PaperExitProxyStats {
  cohort: string;
  exitProfile: string;
  rows: number;
  observedRows: number;
  proxyHorizonSec: number | null;
  targetPct: number | null;
  targetHitRows: number | null;
  positiveRows: number;
  postCostPositiveRate: number | null;
  medianPostCostDeltaPct: number | null;
  p25PostCostDeltaPct: number | null;
  refundAdjustedNetSol: number | null;
  maxLosingStreak: number | null;
  medianHoldSec: number | null;
}

type CompoundFitnessVerdict =
  | 'COLLECT'
  | 'REJECT'
  | 'WATCH'
  | 'PASS';

type ReviewCohortDecisionVerdict =
  | 'COLLECT'
  | 'EARLY_REJECT'
  | 'WATCH'
  | 'REJECT'
  | 'PASS';

interface RotationCompoundFitnessGate {
  cohort: string;
  verdict: CompoundFitnessVerdict;
  score: number;
  reasons: string[];
  closes: number;
  minReviewCloses: number;
  minDecisionCloses: number;
  refundAdjustedNetSol: number | null;
  postCostPositiveRate: number | null;
  t1Rate: number | null;
  maxLosingStreak: number | null;
  winnerCoversBleed: boolean | null;
}

interface ReviewCohortDecision {
  cohort: string;
  verdict: ReviewCohortDecisionVerdict;
  closes: number;
  minEarlyRejectCloses: number;
  minReviewCloses: number;
  minDecisionCloses: number;
  refundAdjustedNetSol: number | null;
  postCostPositiveRate: number | null;
  maxLosingStreak: number | null;
  primaryHorizonPostCost: Array<{ horizonSec: number; medianPostCostDeltaPct: number | null }>;
  earlyRejectSignals: string[];
  reasons: string[];
}

type MicroLiveReviewVerdict =
  | 'CONTINUE_COLLECT'
  | 'REJECT'
  | 'WAIT_REVIEW_COHORT_METADATA'
  | 'WAIT_LIVE_EQUIVALENCE_DATA'
  | 'WAIT_LIVE_EQUIVALENCE_CLEAR'
  | 'READY_FOR_MICRO_LIVE_REVIEW';

interface MicroLivePlan {
  ticketSol: number;
  maxDailyAttempts: number;
  dailyLossCapSol: number;
  rollbackConditions: string[];
}

interface MicroLiveReviewPacket {
  verdict: MicroLiveReviewVerdict;
  reasons: string[];
  reviewCohort: string;
  paperVerdict: RotationPaperCompoundReadinessVerdict;
  liveVerdict: RotationLiveReadinessVerdict;
  compoundVerdict: CompoundFitnessVerdict;
  liveEquivalenceRows: number;
  liveEquivalenceBlockers: number;
  linkedLiveEquivalenceRows: number;
  candidateIdRows: number;
  routeProofRows: number;
  timestampedSecondKolRows: number;
  closes: number;
  plan: MicroLivePlan;
}

interface RotationReadinessHorizonCoverage {
  horizonSec: number;
  expectedRows: number;
  observedRows: number;
  okRows: number;
  okCoverage: number | null;
  medianPostCostDeltaPct: number | null;
}

type EvidenceVerdictStatus =
  | 'COLLECT'
  | 'DATA_GAP'
  | 'COST_REJECT'
  | 'POST_COST_REJECT'
  | 'WATCH'
  | 'PROMOTION_CANDIDATE';

type RotationLiveReadinessVerdict =
  | 'BLOCKED'
  | 'COLLECT'
  | 'DATA_GAP'
  | 'COST_REJECT'
  | 'READY_FOR_MICRO_LIVE';

type RotationPaperCompoundReadinessVerdict =
  | 'BLOCKED'
  | 'COLLECT'
  | 'DATA_GAP'
  | 'COST_REJECT'
  | 'PAPER_READY';

type RotationNarrowCohortVerdict =
  | 'DATA_GAP'
  | 'COLLECT'
  | 'WATCH'
  | 'REJECT'
  | 'PAPER_READY';

interface RotationNarrowCohortHorizonStats {
  horizonSec: number;
  okRows: number;
  okCoverage: number | null;
  postCostPositiveRate: number | null;
  medianPostCostDeltaPct: number | null;
}

interface RotationNarrowCohortStats {
  cohort: string;
  verdict: RotationNarrowCohortVerdict;
  reasons: string[];
  rows: number;
  minRequiredRows: number;
  routeProofRows: number;
  routeProofCoverage: number | null;
  candidateIdRows: number;
  twoPlusKolRows: number;
  costAwareRows: number;
  timestampedSecondKolRows: number;
  refundAdjustedNetSol: number | null;
  postCostPositiveRate: number | null;
  edgePassRate: number | null;
  t1Rate: number | null;
  medianMfePct: number | null;
  medianHoldSec: number | null;
  minOkCoverage: number | null;
  primaryHorizonPostCost: RotationNarrowCohortHorizonStats[];
}

type RouteProofFreshnessVerdict =
  | 'WAIT_FRESH_CLOSES'
  | 'INSTRUMENTATION_GAP'
  | 'ROUTE_PROOF_COLLECTING'
  | 'DATA_GAP'
  | 'REJECT'
  | 'READY_FOR_NARROW_REVIEW';

interface RouteProofFreshnessArmStats {
  armName: string;
  rows: number;
  paperCloseWriterSchemaRows: number;
  rotationExitRouteProofSchemaRows: number;
  exitRouteInstrumentedRows: number;
  exitQuoteEvidenceRows: number;
  exitRouteProofSkippedRows: number;
  missingEvidenceRows: number;
  routeFoundTrueRows: number;
  routeFoundFalseRows: number;
  routeFoundNullRows: number;
  routeProofRows: number;
  latestCloseAt: string | null;
  latestExitQuoteEvidenceAt: string | null;
  topExitRouteProofSkipReasons: Array<{ reason: string; count: number }>;
  topPaperCloseWriterSchemas: Array<{ schema: string; count: number }>;
}

interface RouteProofFreshnessStats {
  verdict: RouteProofFreshnessVerdict;
  reasons: string[];
  cutoffSource: 'arg' | 'current_session' | 'first_exit_route_marker' | 'none';
  freshSince: string | null;
  underfillRows: number;
  freshRows: number;
  freshNoTradeRows: number;
  freshNoTradeEvents: number;
  freshMissedAlphaRows: number;
  freshMissedAlphaEvents: number;
  freshPolicyDecisionRows: number;
  freshRotationPolicyDecisionRows: number;
  minRequiredFreshRows: number;
  latestUnderfillCloseAt: string | null;
  latestCostAwareCloseAt: string | null;
  latestExitQuoteEvidenceAt: string | null;
  latestNoTradeAt: string | null;
  paperCloseWriterSchemaRows: number;
  rotationExitRouteProofSchemaRows: number;
  exitRouteInstrumentedRows: number;
  exitQuoteEvidenceRows: number;
  exitQuoteRouteFoundRows: number;
  exitQuoteNoRouteRows: number;
  exitQuoteUnknownRows: number;
  exitRouteProofSkippedRows: number;
  instrumentationMissingRows: number;
  routeProofRows: number;
  explicitNoRouteRows: number;
  routeUnknownRows: number;
  candidateIdRows: number;
  twoPlusKolRows: number;
  costAwareRows: number;
  routeProofedTwoPlusCostAwareRows: number;
  routeProofedTwoPlusCostAwareTimestampedRows: number;
  freshByArm: RouteProofFreshnessArmStats[];
  topNoTradeReasons: Array<{ reason: string; count: number }>;
  topMissedAlphaEntryReasons: Array<{ reason: string; count: number }>;
  topMissedAlphaRejectReasons: Array<{ reason: string; count: number }>;
  topPolicyEntryReasons: Array<{ reason: string; count: number }>;
  topPolicyRejectReasons: Array<{ reason: string; count: number }>;
  topRouteUnknownReasons: Array<{ reason: string; count: number }>;
  topExitRouteProofSkipReasons: Array<{ reason: string; count: number }>;
  topPaperCloseWriterSchemas: Array<{ schema: string; count: number }>;
}

type RotationCandidateFunnelVerdict =
  | 'INPUT_IDLE'
  | 'KOL_FLOW_ACTIVE_NO_ROTATION_PATTERN'
  | 'ROTATION_PATTERN_BLOCKED'
  | 'ROTATION_LEDGER_GAP'
  | 'COLLECT';

interface RotationCandidateFunnelStats {
  verdict: RotationCandidateFunnelVerdict;
  reasons: string[];
  cutoffSource: 'current_session' | 'report_since';
  since: string;
  kolTxRows: number;
  kolBuyRows: number;
  kolSellRows: number;
  kolShadowRows: number;
  distinctKols: number;
  distinctTokens: number;
  latestKolTxAt: string | null;
  callFunnelRows: number;
  rotationCallFunnelRows: number;
  latestCallFunnelAt: string | null;
  rotationNoTradeEvents: number;
  rotationNoTradeRows: number;
  rotationPolicyDecisionRows: number;
  rotationPaperCloseRows: number;
  topKolTxActions: Array<{ action: string; count: number }>;
  topKolTxKols: Array<{ kol: string; count: number }>;
  topBuyKols: Array<{ kol: string; count: number }>;
  topCallFunnelEventTypes: Array<{ eventType: string; count: number }>;
  topRotationCallFunnelEventTypes: Array<{ eventType: string; count: number }>;
  topNoTradeReasons: Array<{ reason: string; count: number }>;
  topPolicyEntryReasons: Array<{ reason: string; count: number }>;
}

type RotationDetectorReplayVerdict =
  | 'NO_KOL_TX'
  | 'BLOCKED_BY_RECENT_SELL'
  | 'INSUFFICIENT_BUY_DEPTH'
  | 'NEEDS_PRICE_CONTEXT'
  | 'COLLECT';

interface RotationDetectorReplayTokenStats {
  tokenMint: string;
  shortMint: string;
  txRows: number;
  buyRows: number;
  sellRows: number;
  grossBuySol: number;
  smallBuyRows: number;
  eligibleUnderfillBuyRows: number;
  distinctKols: number;
  firstBuyAt: string | null;
  lastBuyAt: string | null;
  latestSellAt: string | null;
  lastBuyAgeSec: number | null;
  recentSellRows: number;
  vanillaBlockers: string[];
  underfillBlockers: string[];
  topKols: Array<{ kol: string; count: number }>;
}

interface RotationDetectorReplayStats {
  verdict: RotationDetectorReplayVerdict;
  reasons: string[];
  cutoffSource: 'current_session' | 'report_since';
  since: string;
  tokenRows: number;
  kolTxRows: number;
  kolBuyRows: number;
  kolSellRows: number;
  topVanillaBlockers: Array<{ blocker: string; count: number }>;
  topUnderfillBlockers: Array<{ blocker: string; count: number }>;
  tokens: RotationDetectorReplayTokenStats[];
}

type RotationDetectorBlockerMarkoutVerdict =
  | 'NO_MARKOUT_COVERAGE'
  | 'COLLECT'
  | 'BLOCKER_PROTECTS'
  | 'BLOCKER_REVIEW_CANDIDATE';

interface RotationDetectorBlockerTokenMarkoutStats {
  tokenMint: string;
  shortMint: string;
  txRows: number;
  buyRows: number;
  sellRows: number;
  markoutRows: number;
  primaryMedianPostCostDeltaPct: number | null;
  bestHorizonSec: number | null;
  bestMedianPostCostDeltaPct: number | null;
  topKols: Array<{ kol: string; count: number }>;
}

interface RotationDetectorBlockerMarkoutBucketStats {
  scope: 'underfill' | 'vanilla';
  blocker: string;
  verdict: RotationDetectorBlockerMarkoutVerdict;
  reasons: string[];
  tokenRows: number;
  markoutTokenRows: number;
  tokenCoverage: number | null;
  buyMarkoutRows: number;
  minOkCoverage: number | null;
  primaryHorizonSec: number | null;
  primaryMedianPostCostDeltaPct: number | null;
  primaryPostCostPositiveRate: number | null;
  horizons: HorizonStats[];
  topKols: Array<{ kol: string; count: number }>;
  topTokens: RotationDetectorBlockerTokenMarkoutStats[];
}

interface RotationDetectorBlockerMarkoutStats {
  since: string;
  cutoffSource: 'report_since';
  tokenRows: number;
  buyMarkoutRows: number;
  topBuckets: RotationDetectorBlockerMarkoutBucketStats[];
}

type RotationStaleBuyReviewVerdict =
  | 'NO_STALE_ROWS'
  | 'COLLECT'
  | 'STALE_BUY_REJECT'
  | 'PAPER_STALE_REVIEW_CANDIDATE';

interface RotationStaleBuyBucketStats {
  bucket: string;
  verdict: RotationStaleBuyReviewVerdict;
  reasons: string[];
  tokenRows: number;
  markoutTokenRows: number;
  missingMarkoutTokenRows: number;
  paperProbeTokenRows: number;
  paperProbeRows: number;
  paperProbeOkRows: number;
  paperProbeMinOkCoverage: number | null;
  paperProbePrimaryMedianPostCostDeltaPct: number | null;
  paperProbePrimaryPostCostPositiveRate: number | null;
  otherPaperProbeTokenRows: number;
  otherPaperProbeRows: number;
  darkTokenRows: number;
  unmeasuredTokenRows: number;
  tokenCoverage: number | null;
  buyMarkoutRows: number;
  minOkCoverage: number | null;
  primaryHorizonSec: number | null;
  primaryMedianPostCostDeltaPct: number | null;
  primaryPostCostPositiveRate: number | null;
  medianLastBuyAgeSec: number | null;
  medianGrossBuySol: number | null;
  topKols: Array<{ kol: string; count: number }>;
  topMissingKols: Array<{ kol: string; count: number }>;
  topUnmeasuredKols: Array<{ kol: string; count: number }>;
  topDarkKols: Array<{ kol: string; count: number }>;
  topOtherPaperProbeReasons: Array<{ reason: string; count: number }>;
  topTokens: RotationDetectorBlockerTokenMarkoutStats[];
  topMissingTokens: RotationStaleBuyMissingTokenStats[];
  topUnmeasuredTokens: RotationStaleBuyMissingTokenStats[];
  topDarkTokens: RotationStaleBuyMissingTokenStats[];
}

interface RotationStaleBuyMissingTokenStats {
  tokenMint: string;
  shortMint: string;
  txRows: number;
  buyRows: number;
  sellRows: number;
  lastBuyAgeSec: number | null;
  grossBuySol: number;
  distinctKols: number;
  topKols: Array<{ kol: string; count: number }>;
}

interface RotationStaleBuyReviewStats {
  since: string;
  tokenRows: number;
  candidateTokenRows: number;
  excludedRecentSellTokenRows: number;
  buyMarkoutRows: number;
  paperProbeRows: number;
  buckets: RotationStaleBuyBucketStats[];
}

type KolHunterAdmissionSkipMarkoutVerdict =
  | 'NO_ROWS'
  | 'COLLECT'
  | 'NEGATIVE_AFTER_COST'
  | 'PAPER_REVIEW_CANDIDATE';

interface KolHunterAdmissionSkipTokenStats {
  tokenMint: string;
  shortMint: string;
  rows: number;
  probeRows: number;
  okRows: number;
  bestHorizonSec: number | null;
  bestMedianPostCostDeltaPct: number | null;
  topKols: Array<{ kol: string; count: number }>;
}

interface KolHunterAdmissionSkipMarkoutStats {
  since: string;
  verdict: KolHunterAdmissionSkipMarkoutVerdict;
  reasons: string[];
  rows: number;
  probeRows: number;
  okRows: number;
  tokenRows: number;
  maxConcurrentRows: number;
  minOkCoverage: number | null;
  primaryHorizonSec: number | null;
  primaryMedianPostCostDeltaPct: number | null;
  primaryPostCostPositiveRate: number | null;
  horizons: HorizonStats[];
  topKols: Array<{ kol: string; count: number }>;
  topReasons: Array<{ reason: string; count: number }>;
  topTokens: KolHunterAdmissionSkipTokenStats[];
}

type RotationPriceContextMarkoutVerdict =
  | 'NO_PRICE_CONTEXT_CANDIDATES'
  | 'NO_MARKOUT_COVERAGE'
  | 'COLLECT'
  | 'NEGATIVE_AFTER_COST'
  | 'PAPER_OBSERVE_CANDIDATE';

interface RotationPriceContextTokenMarkoutStats {
  tokenMint: string;
  shortMint: string;
  txRows: number;
  buyRows: number;
  grossBuySol: number;
  distinctKols: number;
  markoutRows: number;
  okRows: number;
  bestHorizonSec: number | null;
  bestMedianPostCostDeltaPct: number | null;
  topKols: Array<{ kol: string; count: number }>;
}

interface RotationPriceContextCoverageGapTokenStats {
  tokenMint: string;
  shortMint: string;
  gapReason: string;
  txRows: number;
  buyRows: number;
  grossBuySol: number;
  distinctKols: number;
  latestBuyAt: string | null;
  anyMarkoutRows: number;
  missedAlphaRows: number;
  rotationNoTradeRows: number;
  callFunnelRows: number;
  rotationCallFunnelRows: number;
  policyDecisionRows: number;
  rotationPolicyDecisionRows: number;
  rotationPolicyAttributionDriftRows: number;
  topNoTradeReasons: Array<{ reason: string; count: number }>;
  topPolicyEntryReasons: Array<{ reason: string; count: number }>;
  topPolicyRejectReasons: Array<{ reason: string; count: number }>;
  topRotationPolicyEntryReasons: Array<{ reason: string; count: number }>;
  topRotationPolicyRejectReasons: Array<{ reason: string; count: number }>;
  topRotationPolicyAttributionDriftReasons: Array<{ reason: string; count: number }>;
  topRotationPolicyAttributionSources: Array<{ source: string; count: number }>;
  topRotationPolicyAttributionSurvivalReasons: Array<{ reason: string; count: number }>;
  topKols: Array<{ kol: string; count: number }>;
}

interface RotationPriceContextCoverageGapStats {
  missingBuyMarkoutTokenRows: number;
  missingBuyMarkoutKolTxRows: number;
  rotationSpecificMissingTokenRows: number;
  rotationSpecificMissingKolTxRows: number;
  rotationPolicyAttributionDriftTokenRows: number;
  rotationPolicyAttributionDriftRows: number;
  topMissingReasons: Array<{ reason: string; count: number }>;
  topMissingKols: Array<{ kol: string; count: number }>;
  topMissingNoTradeReasons: Array<{ reason: string; count: number }>;
  topMissingPolicyEntryReasons: Array<{ reason: string; count: number }>;
  topMissingPolicyRejectReasons: Array<{ reason: string; count: number }>;
  topMissingRotationPolicyEntryReasons: Array<{ reason: string; count: number }>;
  topMissingRotationPolicyRejectReasons: Array<{ reason: string; count: number }>;
  topMissingRotationPolicyAttributionDriftReasons: Array<{ reason: string; count: number }>;
  topMissingRotationPolicyAttributionSources: Array<{ source: string; count: number }>;
  topMissingRotationPolicyAttributionSurvivalReasons: Array<{ reason: string; count: number }>;
  topMissingTokens: RotationPriceContextCoverageGapTokenStats[];
}

interface RotationPriceContextMarkoutStats {
  verdict: RotationPriceContextMarkoutVerdict;
  reasons: string[];
  cutoffSource: 'report_since';
  since: string;
  candidateTokenRows: number;
  candidateKolTxRows: number;
  markoutTokenRows: number;
  markoutTokenCoverage: number | null;
  buyMarkoutRows: number;
  minOkCoverage: number | null;
  horizons: HorizonStats[];
  topTokens: RotationPriceContextTokenMarkoutStats[];
  coverageGap: RotationPriceContextCoverageGapStats;
}

type RotationDecayBlockMarkoutVerdict =
  | 'NO_DECAY_BLOCKS'
  | 'NO_PROBE_COVERAGE'
  | 'COLLECT'
  | 'DECAY_SAVED_LOSS'
  | 'DECAY_KILLED_WINNERS';

type RotationDecayRecoveryClass =
  | 'immediate_winner'
  | 'delayed_recovery'
  | 'saved_loss'
  | 'insufficient_coverage';

interface RotationPolicyParticipantSummary {
  id: string;
  tier: string;
  style: string;
  timestampMs: number | null;
}

interface RotationDecayBlockTokenStats {
  tokenMint: string;
  shortMint: string;
  policyRows: number;
  probeRows: number;
  okRows: number;
  recoveryClass: RotationDecayRecoveryClass;
  primaryHorizonSec: number | null;
  primaryMedianPostCostDeltaPct: number | null;
  decayHorizonSec: number | null;
  decayMedianPostCostDeltaPct: number | null;
  recoveryDeltaPct: number | null;
  bestHorizonSec: number | null;
  bestMedianPostCostDeltaPct: number | null;
  topRejectReasons: Array<{ reason: string; count: number }>;
  topSources: Array<{ source: string; count: number }>;
  topSurvivalReasons: Array<{ reason: string; count: number }>;
  topParameterVersions: Array<{ version: string; count: number }>;
  topSignalSources: Array<{ source: string; count: number }>;
  topStyleBuckets: Array<{ style: string; count: number }>;
  topIndependentBuckets: Array<{ bucket: string; count: number }>;
  topKolTiers: Array<{ tier: string; count: number }>;
  topKols: Array<{ kol: string; count: number }>;
  medianPolicyKolScore: number | null;
}

interface RotationDecayRecoveryProfile {
  recoveryClass: RotationDecayRecoveryClass;
  tokenRows: number;
  policyRows: number;
  medianPolicyKolScore: number | null;
  topParameterVersions: Array<{ version: string; count: number }>;
  topSignalSources: Array<{ source: string; count: number }>;
  topStyleBuckets: Array<{ style: string; count: number }>;
  topIndependentBuckets: Array<{ bucket: string; count: number }>;
  topLiquidityBuckets: Array<{ bucket: string; count: number }>;
  topSecurityBuckets: Array<{ bucket: string; count: number }>;
  topKolTiers: Array<{ tier: string; count: number }>;
  topKols: Array<{ kol: string; count: number }>;
}

type RotationDecayGraceWatchlistVerdict =
  | 'NO_WATCHLIST_ROWS'
  | 'COLLECT'
  | 'PAPER_GRACE_REJECT'
  | 'PAPER_GRACE_CANDIDATE';

interface RotationDecayGraceWatchlistStats {
  profile: string;
  verdict: RotationDecayGraceWatchlistVerdict;
  reasons: string[];
  tokenRows: number;
  policyRows: number;
  probeRows: number;
  minOkCoverage: number | null;
  immediateWinnerTokenRows: number;
  delayedRecoveryTokenRows: number;
  savedLossTokenRows: number;
  insufficientCoverageTokenRows: number;
  horizons: HorizonStats[];
  topTokens: RotationDecayBlockTokenStats[];
}

interface RotationDecayBlockMarkoutStats {
  verdict: RotationDecayBlockMarkoutVerdict;
  reasons: string[];
  since: string;
  policyRows: number;
  tokenRows: number;
  probeRows: number;
  probeTokenRows: number;
  immediateWinnerTokenRows: number;
  delayedRecoveryTokenRows: number;
  savedLossTokenRows: number;
  insufficientCoverageTokenRows: number;
  minOkCoverage: number | null;
  horizons: HorizonStats[];
  topRejectReasons: Array<{ reason: string; count: number }>;
  topSources: Array<{ source: string; count: number }>;
  topSurvivalReasons: Array<{ reason: string; count: number }>;
  recoveryProfiles: RotationDecayRecoveryProfile[];
  graceWatchlist: RotationDecayGraceWatchlistStats;
  topTokens: RotationDecayBlockTokenStats[];
  topDelayedRecoveryTokens: RotationDecayBlockTokenStats[];
}

interface EvidenceVerdict {
  armName: string;
  verdict: EvidenceVerdictStatus;
  reasons: string[];
  closes: number;
  minRequiredCloses: number;
  promotionRequiredCloses: number;
  minOkCoverage: number | null;
  requiredHorizonCoverage: Array<{ horizonSec: number; okCoverage: number | null }>;
  primaryHorizonPostCost: Array<{ horizonSec: number; medianPostCostDeltaPct: number | null }>;
  primaryHorizonSec: number | null;
  primaryMedianPostCostDeltaPct: number | null;
  controlPrimaryMedianPostCostDeltaPct: number | null;
  primaryBeatDeltaPct: number | null;
  decayHorizonSec: number;
  decayMedianPostCostDeltaPct: number | null;
  t60MedianPostCostDeltaPct: number | null;
  controlT60MedianPostCostDeltaPct: number | null;
  controlBeatDeltaPct: number | null;
  refundAdjustedNetSol: number | null;
  rentAdjustedNetSol: number | null;
  edgeCoverage: number | null;
  edgePassRate: number | null;
  routeProofRows: number;
  routeProofCoverage: number | null;
}

interface RotationLiveReadiness {
  armName: string;
  verdict: RotationLiveReadinessVerdict;
  reasons: string[];
  cohort: string;
  closes: number;
  minRequiredCloses: number;
  refundAdjustedNetSol: number | null;
  postCostPositiveRate: number | null;
  edgePassRate: number | null;
  t1Rate: number | null;
  medianMfePct: number | null;
  minOkCoverage: number | null;
  requiredHorizonCoverage: RotationReadinessHorizonCoverage[];
  primaryHorizonPostCost: Array<{ horizonSec: number; medianPostCostDeltaPct: number | null }>;
  evidenceVerdict: EvidenceVerdictStatus | null;
}

interface RotationPaperCompoundReadiness {
  armName: string;
  verdict: RotationPaperCompoundReadinessVerdict;
  reasons: string[];
  cohort: string;
  closes: number;
  minRequiredCloses: number;
  refundAdjustedNetSol: number | null;
  postCostPositiveRate: number | null;
  edgePassRate: number | null;
  t1Rate: number | null;
  medianMfePct: number | null;
  minOkCoverage: number | null;
  requiredHorizonCoverage: RotationReadinessHorizonCoverage[];
  primaryHorizonPostCost: Array<{ horizonSec: number; medianPostCostDeltaPct: number | null }>;
}

interface RotationReport {
  generatedAt: string;
  realtimeDir: string;
  since: string;
  horizonsSec: number[];
  roundTripCostPct: number;
  assumedAtaRentSol: number;
  assumedNetworkFeeSol: number;
  tradeMarkouts: {
    totalRows: number;
    rotationRows: number;
    afterBuy: HorizonStats[];
    afterSell: HorizonStats[];
    afterSellFinal: HorizonStats[];
    afterSellPartial: HorizonStats[];
    afterSellHardCut: HorizonStats[];
    afterSellMaeFastFail: HorizonStats[];
    byArm: ArmHorizonStats[];
  };
  paperTrades: {
    totalRows: number;
    rotationRows: number;
    byArm: PaperArmStats[];
    winnerEntryPairings: WinnerEntryPairingStats[];
    winnerEntryDiagnostics: WinnerEntryDiagnosticStats[];
  };
  liveTrades: {
    totalRows: number;
    rotationRows: number;
    byArm: PaperArmStats[];
  };
  underfillEntryQuality: UnderfillEntryQualityStats[];
  underfillRouteCohorts: UnderfillRouteCohortStats[];
  liveEquivalence: LiveEquivalenceSummary;
  routeUnknownReasons: RouteUnknownReasonStats[];
  routeTruthAudit: RouteTruthAuditStats[];
  routeProofFreshness: RouteProofFreshnessStats;
  rotationCandidateFunnel: RotationCandidateFunnelStats;
  kolHunterAdmissionSkipMarkouts: KolHunterAdmissionSkipMarkoutStats;
  rotationDetectorReplay: RotationDetectorReplayStats;
  rotationDetectorReplayWindow: RotationDetectorReplayStats;
  rotationDetectorBlockerMarkouts: RotationDetectorBlockerMarkoutStats;
  rotationStaleBuyReview: RotationStaleBuyReviewStats;
  rotationPriceContextMarkouts: RotationPriceContextMarkoutStats;
  rotationDecayBlockMarkouts: RotationDecayBlockMarkoutStats;
  rotationNarrowCohorts: RotationNarrowCohortStats[];
  underfillKolCohorts: UnderfillRouteCohortStats[];
  underfillKolTiming: KolTimingStats[];
  posthocSecondKol: PosthocSecondKolStats[];
  posthocSecondKolWaitProxies: PosthocSecondKolWaitProxyStats[];
  posthocSecondKolCandidateDecisions: PosthocSecondKolCandidateDecision[];
  posthocSecondKolSyntheticPaperArms: PosthocSecondKolSyntheticPaperArm[];
  posthocSecondKolRouteProofGates: PosthocSecondKolRouteProofGate[];
  posthocSecondKolRecoveryBacklog: PosthocSecondKolRecoveryBacklogItem[];
  paperCohortValidity: PaperCohortValidityStats[];
  reviewCohortGenerationAudit: ReviewCohortGenerationAuditStats;
  rotationSecondKolOpportunityFunnel: RotationSecondKolOpportunityFunnelStats;
  rotationSecondKolPromotionGap: RotationSecondKolPromotionGapStats;
  liveEquivalenceDrilldown: LiveEquivalenceDrilldownStats[];
  reviewCohortEvidence: ReviewCohortEvidenceStats;
  paperExitProxies: PaperExitProxyStats[];
  compoundProfiles: RotationCompoundProfile[];
  rotationCompoundFitness: RotationCompoundFitnessGate;
  reviewCohortDecision: ReviewCohortDecision;
  microLiveReviewPacket: MicroLiveReviewPacket;
  rotationPaperCompoundReadiness: RotationPaperCompoundReadiness;
  rotationLiveReadiness: RotationLiveReadiness;
  evidenceVerdicts: EvidenceVerdict[];
  noTrade: {
    totalRows: number;
    probeRows: number;
    byHorizon: HorizonStats[];
    byReason: Array<{
      reason: string;
      count: number;
      okRows: number;
      positiveRows: number;
      positivePostCostRows: number;
      medianDeltaPct: number | null;
      medianPostCostDeltaPct: number | null;
    }>;
  };
  byAnchor: Array<{
    anchor: string;
    rows: number;
    okRows: number;
    medianDeltaPct60s: number | null;
    medianPostCostDeltaPct60s: number | null;
    positive60s: number;
    positivePostCost60s: number;
  }>;
  byDevQuality: Array<{
    bucket: string;
    rows: number;
    okRows: number;
    medianDeltaPct60s: number | null;
    medianPostCostDeltaPct60s: number | null;
    positive60s: number;
    positivePostCost60s: number;
  }>;
  kolTransferPosterior: {
    input: string;
    kolDbPath?: string;
    coverageLoadStatus?: KolPosteriorCoverageLoadStatus;
    coverageLoadError?: string;
    rows: number;
    candidates: number;
    coverageSummary?: KolPosteriorCoverageSummary;
    coverage?: KolPosteriorCoverage[];
    topRotationFit: KolPosteriorMetrics[];
  };
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    realtimeDir: path.resolve(process.cwd(), 'data/realtime'),
    sinceMs: Date.now() - 24 * 3600_000,
    horizonsSec: [15, 30, 60],
    roundTripCostPct: 0.005,
    paperTradesFileName: ROTATION_PAPER_TRADES_FILE,
    assumedAtaRentSol: 0.00207408,
    assumedNetworkFeeSol: 0.000105,
    candidateFile: DEFAULT_DEV_WALLET_CANDIDATE_PATH,
    kolTransferInput: path.resolve(process.cwd(), 'data/research', KOL_TRANSFER_INPUT_FILE),
    kolDbPath: path.resolve(process.cwd(), 'data/kol/wallets.json'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--realtime-dir') args.realtimeDir = path.resolve(argv[++i]);
    else if (arg === '--since') args.sinceMs = parseSince(argv[++i]);
    else if (arg === '--horizons') args.horizonsSec = parseHorizons(argv[++i]);
    else if (arg === '--round-trip-cost-pct') args.roundTripCostPct = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--paper-trades-file') args.paperTradesFileName = argv[++i];
    else if (arg === '--assumed-ata-rent-sol') args.assumedAtaRentSol = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--assumed-network-fee-sol') args.assumedNetworkFeeSol = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--candidate-file') args.candidateFile = path.resolve(argv[++i]);
    else if (arg.startsWith('--candidate-file=')) args.candidateFile = path.resolve(arg.split('=')[1]);
    else if (arg === '--no-candidates') args.candidateFile = undefined;
    else if (arg === '--kol-transfer-input') args.kolTransferInput = path.resolve(argv[++i]);
    else if (arg.startsWith('--kol-transfer-input=')) args.kolTransferInput = path.resolve(arg.split('=')[1]);
    else if (arg === '--kol-db') args.kolDbPath = path.resolve(argv[++i]);
    else if (arg === '--no-kol-coverage') args.kolDbPath = undefined;
    else if (arg === '--route-proof-fresh-since') args.routeProofFreshSinceMs = parseSince(argv[++i]);
    else if (arg.startsWith('--route-proof-fresh-since=')) args.routeProofFreshSinceMs = parseSince(arg.split('=')[1]);
    else if (arg === '--md') args.mdOut = path.resolve(argv[++i]);
    else if (arg === '--json') args.jsonOut = path.resolve(argv[++i]);
  }
  return args;
}

function parseNonNegativeNumber(raw: string, label: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid ${label}: ${raw}`);
  return parsed;
}

function parseSince(raw: string): number {
  if (/^\d+h$/.test(raw)) return Date.now() - Number(raw.slice(0, -1)) * 3600_000;
  if (/^\d+d$/.test(raw)) return Date.now() - Number(raw.slice(0, -1)) * 86400_000;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`invalid --since: ${raw}`);
}

function parseHorizons(raw: string): number[] {
  const values = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) throw new Error(`invalid --horizons: ${raw}`);
  return [...new Set(values)].sort((a, b) => a - b);
}

async function readJsonl(file: string): Promise<JsonRow[]> {
  try {
    const raw = await readFile(file, 'utf8');
    return raw.split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as JsonRow];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function readJsonFile(file: string): Promise<JsonRow> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as JsonRow;
  } catch {
    return {};
  }
}

function obj(value: unknown): JsonRow {
  return typeof value === 'object' && value != null ? value as JsonRow : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timeMs(value: unknown): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function probe(row: JsonRow): JsonRow {
  return obj(row.probe);
}

function rowHorizon(row: JsonRow): number | null {
  return num(row.horizonSec) ?? num(probe(row).offsetSec);
}

function rowDelta(row: JsonRow): number | null {
  return num(row.deltaPct) ?? num(probe(row).deltaPct);
}

function rowPositionId(row: JsonRow): string {
  return str(row.positionId) || str(obj(row.extras).positionId);
}

function rowParentPositionId(row: JsonRow): string {
  return rowStringWithExtras(row, ['parentPositionId']);
}

function rowTokenMint(row: JsonRow): string {
  return str(row.tokenMint) || str(obj(row.extras).tokenMint);
}

function rowTokenMintDeep(row: JsonRow): string {
  const context = obj(row.context);
  const bucket = obj(row.bucket);
  return rowTokenMint(row) ||
    str(context.tokenMint) ||
    str(bucket.tokenMint) ||
    str(obj(context.extras).tokenMint);
}

function rowArmName(row: JsonRow): string {
  const extras = obj(row.extras);
  return str(row.profileArm) ||
    str(extras.profileArm) ||
    str(row.armName) ||
    str(extras.armName) ||
    str(row.signalSource) ||
    str(row.parameterVersion) ||
    str(extras.parameterVersion) ||
    '(unknown)';
}

function rotationEdge(row: JsonRow): JsonRow {
  const direct = obj(row.rotationMonetizableEdge);
  if (Object.keys(direct).length > 0) return direct;
  return obj(obj(row.extras).rotationMonetizableEdge);
}

function boolValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

function edgeTicketSol(edge: JsonRow): number | null {
  const value = num(edge.ticketSol);
  return value != null && value > 0 ? value : null;
}

function edgeCopyableCostRatio(edge: JsonRow): number | null {
  const ticketSol = edgeTicketSol(edge);
  const irreversibleCostSol = num(edge.irreversibleCostSol) ?? num(edge.bleedTotalSol);
  if (ticketSol != null && irreversibleCostSol != null && Number.isFinite(irreversibleCostSol)) {
    return irreversibleCostSol / ticketSol;
  }
  return num(edge.costRatio);
}

function edgeWalletDragRatio(edge: JsonRow): number | null {
  const direct = num(edge.walletDragRatio);
  if (direct != null) return direct;
  const ticketSol = edgeTicketSol(edge);
  const walletDragSol = num(edge.walletDragSol) ?? num(edge.totalCostSol);
  if (ticketSol != null && walletDragSol != null && Number.isFinite(walletDragSol)) {
    return walletDragSol / ticketSol;
  }
  return null;
}

function edgePassValue(edge: JsonRow): boolean | null {
  const costRatio = edgeCopyableCostRatio(edge);
  const maxCostRatio = num(edge.maxCostRatio);
  if (costRatio != null && maxCostRatio != null) return costRatio <= maxCostRatio;
  return boolValue(edge.pass);
}

function edgeRequiredGrossMovePct(edge: JsonRow): number | null {
  const copyableCostRatio = edgeCopyableCostRatio(edge);
  if (copyableCostRatio != null) return copyableCostRatio;
  return num(edge.requiredGrossMovePct);
}

function isRotationArmValue(value: string): boolean {
  return value === 'kol_hunter_rotation_v1' ||
    value.startsWith('rotation_') ||
    value.startsWith('rotation-') ||
    value.includes('rotation_v1');
}

function isOk(row: JsonRow): boolean {
  if (row.probe != null) return str(probe(row).quoteStatus) === 'ok' && rowDelta(row) != null;
  return str(row.quoteStatus) === 'ok' && rowDelta(row) != null;
}

function isRotationTradeMarkout(row: JsonRow): boolean {
  const extras = obj(row.extras);
  if (isRotationArmValue(rowArmName(row))) return true;
  if (str(row.signalSource) === 'kol_hunter_rotation_v1') return true;
  if (str(extras.entryReason) === 'rotation_v1') return true;
  return Array.isArray(extras.rotationAnchorKols) && extras.rotationAnchorKols.length > 0;
}

function isRotationPaperTrade(row: JsonRow): boolean {
  if (str(row.lane) !== 'kol_hunter' && str(row.strategy) !== 'kol_hunter') return false;
  if (isRotationArmValue(rowArmName(row))) return true;
  if (str(row.kolEntryReason) === 'rotation_v1') return true;
  if (str(row.entryReason) === 'rotation_v1') return true;
  return str(row.parameterVersion).startsWith('rotation-');
}

function isRotationNoTrade(row: JsonRow): boolean {
  const extras = obj(row.extras);
  return str(row.lane) === 'kol_hunter' &&
    (str(row.signalSource) === 'kol_hunter_rotation_v1' ||
      isRotationArmValue(str(row.signalSource)) ||
      str(extras.eventType) === 'rotation_no_trade' ||
      str(extras.eventType) === 'rotation_arm_skip' ||
      str(row.rejectReason).startsWith('rotation_v1_'));
}

function rowKolTxTimeMs(row: JsonRow): number {
  const candidates = [
    timeMs(row.timestamp),
    timeMs(row.recordedAt),
    timeMs(row.blockTime),
  ];
  return candidates.find((value) => Number.isFinite(value)) ?? NaN;
}

function rowKolTxAction(row: JsonRow): string {
  return str(row.action) || '(unknown)';
}

function rowKolId(row: JsonRow): string {
  return str(row.kolId) || str(row.walletAddress) || '(unknown)';
}

function rowCallFunnelTimeMs(row: JsonRow): number {
  const candidates = [
    timeMs(row.emitTsMs),
    timeMs(row.recordedAt),
    timeMs(row.createdAt),
  ];
  return candidates.find((value) => Number.isFinite(value)) ?? NaN;
}

function rowCallFunnelEventType(row: JsonRow): string {
  return str(row.eventType) || '(unknown)';
}

function isRotationCallFunnelRow(row: JsonRow): boolean {
  const extras = obj(row.extras);
  return isRotationArmValue(str(row.armName)) ||
    isRotationArmValue(str(row.parameterVersion)) ||
    isRotationArmValue(str(row.signalSource)) ||
    isRotationArmValue(str(extras.armName)) ||
    isRotationArmValue(str(extras.parameterVersion)) ||
    str(row.eventType).includes('rotation') ||
    str(row.rejectReason).startsWith('rotation_') ||
    str(row.signalSource) === 'kol_hunter_rotation_v1' ||
    str(extras.entryReason) === 'rotation_v1';
}

function markoutEventType(row: JsonRow): string {
  return str(obj(row.extras).eventType);
}

function markoutExitReason(row: JsonRow): string {
  return str(obj(row.extras).exitReason) || str(row.exitReason);
}

function isPartialSellMarkout(row: JsonRow): boolean {
  const eventType = markoutEventType(row);
  return eventType === 'paper_partial_take' ||
    eventType === 'rotation_flow_reduce' ||
    eventType.includes('partial');
}

function isFinalSellMarkout(row: JsonRow): boolean {
  const eventType = markoutEventType(row);
  return eventType === 'paper_close' ||
    eventType === 'live_close' ||
    (!isPartialSellMarkout(row) && str(row.anchorType) === 'sell');
}

function isHardCutSellMarkout(row: JsonRow): boolean {
  const reason = markoutExitReason(row);
  return reason === 'probe_hard_cut' ||
    reason === 'rotation_dead_on_arrival' ||
    reason === 'rotation_mae_fast_fail' ||
    reason === 'rotation_flow_residual_timeout' ||
    reason === 'quick_reject_classifier_exit';
}

function isMaeFastFailSellMarkout(row: JsonRow): boolean {
  return markoutExitReason(row) === 'rotation_mae_fast_fail';
}

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[idx];
}

function summarize(rows: JsonRow[], horizonsSec: number[], roundTripCostPct: number): HorizonStats[] {
  return horizonsSec.map((horizonSec) => {
    const scoped = rows.filter((row) => rowHorizon(row) === horizonSec);
    const ok = scoped.filter(isOk);
    const deltas = ok.map(rowDelta).filter((value): value is number => value != null);
    const postCostDeltas = deltas.map((value) => value - roundTripCostPct);
    const avg = deltas.length > 0 ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null;
    const postCostAvg = postCostDeltas.length > 0
      ? postCostDeltas.reduce((sum, value) => sum + value, 0) / postCostDeltas.length
      : null;
    return {
      horizonSec,
      rows: scoped.length,
      okRows: ok.length,
      positiveRows: deltas.filter((value) => value > 0).length,
      strongRows: deltas.filter((value) => value >= 0.03).length,
      t1Rows: deltas.filter((value) => value >= 0.12).length,
      positivePostCostRows: postCostDeltas.filter((value) => value > 0).length,
      avgDeltaPct: avg,
      medianDeltaPct: percentile(deltas, 0.5),
      p25DeltaPct: percentile(deltas, 0.25),
      avgPostCostDeltaPct: postCostAvg,
      medianPostCostDeltaPct: percentile(postCostDeltas, 0.5),
      p25PostCostDeltaPct: percentile(postCostDeltas, 0.25),
    };
  });
}

function buildArmHorizonStats(rows: JsonRow[], horizonsSec: number[], roundTripCostPct: number): ArmHorizonStats[] {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows) {
    const key = rowArmName(row);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return [...buckets.entries()]
    .map(([armName, scoped]) => ({
      armName,
      afterBuy: summarize(scoped.filter((row) => str(row.anchorType) === 'buy'), horizonsSec, roundTripCostPct),
      afterSell: summarize(scoped.filter((row) => str(row.anchorType) === 'sell'), horizonsSec, roundTripCostPct),
    }))
    .sort((a, b) => {
      const aRows = a.afterBuy.reduce((sum, row) => sum + row.rows, 0) + a.afterSell.reduce((sum, row) => sum + row.rows, 0);
      const bRows = b.afterBuy.reduce((sum, row) => sum + row.rows, 0) + b.afterSell.reduce((sum, row) => sum + row.rows, 0);
      return bRows - aRows || a.armName.localeCompare(b.armName);
    });
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function buildTopExitReasons(rows: JsonRow[]): Array<{ reason: string; count: number }> {
  const buckets = new Map<string, number>();
  for (const row of rows) {
    const reason = str(row.exitReason) || '(unknown)';
    buckets.set(reason, (buckets.get(reason) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 5);
}

function normalizeReturnFraction(value: number | null): number | null {
  if (value == null) return null;
  return Math.abs(value) > 20 ? value / 100 : value;
}

function rowMaeWorstPct(row: JsonRow): number | null {
  return normalizeReturnFraction(num(row.maeWorstPct) ?? num(row.maePctTokenOnly) ?? num(row.maePct));
}

function rowNumWithExtras(row: JsonRow, keys: string[]): number | null {
  const extras = obj(row.extras);
  for (const key of keys) {
    const direct = num(row[key]);
    if (direct != null) return direct;
    const extra = num(extras[key]);
    if (extra != null) return extra;
  }
  return null;
}

function rowMaeAt5sPct(row: JsonRow): number | null {
  return normalizeReturnFraction(rowNumWithExtras(row, ['maeAt5s', 'rotationMaeAt5s']));
}

function rowMaeAt15sPct(row: JsonRow): number | null {
  return normalizeReturnFraction(rowNumWithExtras(row, ['maeAt15s', 'rotationMaeAt15s']));
}

function rowMfePct(row: JsonRow): number | null {
  return normalizeReturnFraction(num(row.mfePctPeak) ?? num(row.mfePctTokenOnly) ?? num(row.mfePct));
}

function rowHasT1(row: JsonRow): boolean {
  const extras = obj(row.extras);
  return row.t1VisitAtSec != null ||
    row.t1VisitedAt != null ||
    row.t1ReachedAt != null ||
    extras.t1VisitAtSec != null ||
    extras.t1VisitedAt != null ||
    extras.t1ReachedAt != null ||
    str(row.exitReason) === 'winner_trailing_t1';
}

function rowHardCutMaePct(row: JsonRow): number | null {
  return normalizeReturnFraction(num(row.hardCutTriggerMaePct) ?? num(row.maeWorstPct) ?? num(row.maePctTokenOnly) ?? num(row.maePct));
}

function rotationFlowMetrics(row: JsonRow): JsonRow {
  const direct = obj(row.rotationFlowMetrics);
  if (Object.keys(direct).length > 0) return direct;
  return obj(obj(row.extras).rotationFlowMetrics);
}

function rowSurvivalFlags(row: JsonRow): string[] {
  const direct = row.survivalFlags;
  const fromExtras = obj(row.extras).survivalFlags;
  const raw = Array.isArray(direct) ? direct : Array.isArray(fromExtras) ? fromExtras : [];
  return raw.flatMap((flag) => typeof flag === 'string' ? [flag] : []);
}

function rowStringWithExtras(row: JsonRow, keys: string[]): string {
  const extras = obj(row.extras);
  for (const key of keys) {
    const direct = str(row[key]);
    if (direct) return direct;
    const extra = str(extras[key]);
    if (extra) return extra;
  }
  return '';
}

function rowIndependentKolCount(row: JsonRow): number | null {
  const direct = rowNumWithExtras(row, [
    'entryIndependentKolCount',
    'freshIndependentKolCount',
    'independentKolCount',
    'rotationIndependentKolCount',
  ]);
  if (direct != null && direct >= 0) return direct;
  const flag = rowSurvivalFlags(row).find((item) => /^ROTATION_UNDERFILL_KOLS_\d+$/.test(item));
  if (flag) return Number(flag.slice('ROTATION_UNDERFILL_KOLS_'.length));
  const anchorKols = obj(row.extras).rotationAnchorKols;
  if (Array.isArray(anchorKols)) return new Set(anchorKols.map((value) => String(value))).size;
  return null;
}

function isSingleKolRow(row: JsonRow): boolean {
  return rowIndependentKolCount(row) === 1;
}

function isTwoPlusKolRow(row: JsonRow): boolean {
  const count = rowIndependentKolCount(row);
  return count != null && count >= 2;
}

function isUnknownKolCountRow(row: JsonRow): boolean {
  return rowIndependentKolCount(row) == null;
}

function rowCandidateId(row: JsonRow): string {
  return rowStringWithExtras(row, ['liveEquivalenceCandidateId', 'candidateId']);
}

function rowPaperDedupeKey(row: JsonRow): string {
  return rowStringWithExtras(row, ['positionId', 'tradeId', 'id', 'signature']) ||
    [
      rowCandidateId(row),
      rowStringWithExtras(row, ['closedAt', 'exitReason']),
      `${num(row.netSolTokenOnly) ?? num(row.netSol) ?? ''}`,
    ].join(':');
}

function rowParticipants(row: JsonRow): Array<{ id: string; timestampMs: number | null }> {
  const extras = obj(row.extras);
  const raw =
    Array.isArray(row.entryParticipatingKols) ? row.entryParticipatingKols :
    Array.isArray(extras.entryParticipatingKols) ? extras.entryParticipatingKols :
    Array.isArray(row.participatingKols) ? row.participatingKols :
    Array.isArray(extras.participatingKols) ? extras.participatingKols :
    Array.isArray(row.kols) ? row.kols :
    Array.isArray(extras.kols) ? extras.kols :
    Array.isArray(extras.rotationAnchorKols) ? extras.rotationAnchorKols :
    [];
  return raw.flatMap((item) => {
    if (typeof item === 'string') return [{ id: item, timestampMs: null }];
    const record = obj(item);
    const id = str(record.id) || str(record.kolId) || str(record.wallet) || str(record.address);
    if (!id) return [];
    const ts = timeMs(record.timestamp) || timeMs(record.timestampMs) || timeMs(record.firstSeenAt) || timeMs(record.firstBuyAt);
    return [{ id, timestampMs: Number.isFinite(ts) ? ts : null }];
  });
}

function secondKolDelaySec(row: JsonRow): number | null {
  const participants = rowParticipants(row)
    .filter((item) => item.timestampMs != null)
    .sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
  const unique: Array<{ id: string; timestampMs: number }> = [];
  const seen = new Set<string>();
  for (const participant of participants) {
    if (seen.has(participant.id) || participant.timestampMs == null) continue;
    seen.add(participant.id);
    unique.push({ id: participant.id, timestampMs: participant.timestampMs });
  }
  if (unique.length < 2) return null;
  return Math.max(0, (unique[1].timestampMs - unique[0].timestampMs) / 1000);
}

function participantKolCount(row: JsonRow): number {
  const ids = rowParticipants(row)
    .map((item) => item.id)
    .filter(Boolean);
  return new Set(ids).size;
}

function kolTimingBucket(row: JsonRow): string {
  if (isUnknownKolCountRow(row)) return 'unknown_kol_count';
  if (isSingleKolRow(row)) return '1kol';
  const delay = secondKolDelaySec(row);
  if (delay == null) return '2plus_unknown_timing';
  if (delay <= 5) return '2plus_second_within_5s';
  if (delay <= 15) return '2plus_second_within_15s';
  if (delay <= 30) return '2plus_second_within_30s';
  return '2plus_second_late';
}

function rowLiveWouldEnter(row: JsonRow): boolean {
  return row.liveWouldEnter === true || obj(row.extras).liveWouldEnter === true;
}

function rowLiveAttempted(row: JsonRow): boolean {
  return row.liveAttempted === true || obj(row.extras).liveAttempted === true;
}

function rowDecisionStage(row: JsonRow): string {
  return rowStringWithExtras(row, ['decisionStage', 'stage']) || '(unknown)';
}

function rowLiveBlockReason(row: JsonRow): string {
  return rowStringWithExtras(row, ['liveBlockReason']) || '(none)';
}

function isRotationLiveEquivalenceRow(row: JsonRow): boolean {
  const label = rowStringWithExtras(row, ['entrySignalLabel']);
  if (label.startsWith('rotation-')) return true;
  return isRotationArmValue(rowArmName(row)) ||
    rowStringWithExtras(row, ['entryReason']) === 'rotation_v1' ||
    rowSurvivalFlags(row).some((flag) => flag.startsWith('ROTATION_'));
}

function isYellowZoneEquivalenceRow(row: JsonRow): boolean {
  return rowDecisionStage(row) === 'yellow_zone' ||
    rowLiveBlockReason(row).includes('yellow zone') ||
    rowSurvivalFlags(row).some((flag) => flag.startsWith('YELLOW_ZONE'));
}

function isRouteUnknownFallbackRow(row: JsonRow): boolean {
  return rowLiveBlockReason(row) === 'rotation_underfill_live_exit_route_unknown' ||
    rowSurvivalFlags(row).some((flag) => flag === 'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN');
}

function isMicroLiveReviewEquivalenceRow(row: JsonRow, reviewCandidateIds: Set<string>): boolean {
  if (!isRotationLiveEquivalenceRow(row)) return false;
  if (reviewCandidateIds.size === 0) return false;
  const candidateId = rowCandidateId(row);
  if (candidateId && reviewCandidateIds.has(candidateId)) return true;
  return rowArmName(row) === ROTATION_LIVE_READINESS_ARM;
}

function isUnderfillRouteUnknown(row: JsonRow): boolean {
  const flags = rowSurvivalFlags(row);
  if (hasExplicitNoSellRouteEvidence(row)) return true;
  if (hasUnderfillRoutePositiveEvidence(row)) return false;
  if (flags.some((flag) =>
    flag === 'EXIT_LIQUIDITY_UNKNOWN' ||
    flag === 'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN'
  )) return true;
  return !hasUnderfillRoutePositiveEvidence(row);
}

function routeUnknownReasonsForRow(row: JsonRow): string[] {
  if (!isUnderfillRouteUnknown(row)) return [];
  const flags = rowSurvivalFlags(row);
  const reasons = new Set<string>();
  if (hasExplicitNoSellRouteEvidence(row)) reasons.add('NO_SELL_ROUTE');
  const exitRouteProofSkipReason = rowExitRouteProofSkipReason(row);
  if (exitRouteProofSkipReason) reasons.add(`EXIT_ROUTE_PROOF_${exitRouteProofSkipReason.toUpperCase()}`);
  for (const flag of flags) {
    if (flag === 'EXIT_LIQUIDITY_UNKNOWN') reasons.add('EXIT_LIQUIDITY_UNKNOWN');
    else if (flag === 'NO_SELL_ROUTE' || flag === 'SELL_NO_ROUTE' || flag === 'NO_ROUTE' || flag.includes('NO_SELL_ROUTE')) {
      reasons.add('NO_SELL_ROUTE');
    }
    else if (flag === 'TOKEN_QUALITY_UNKNOWN') reasons.add('TOKEN_QUALITY_UNKNOWN');
    else if (flag === 'NO_SECURITY_DATA' || flag === 'NO_SECURITY_CLIENT') reasons.add(flag);
    else if (flag.includes('JUPITER_429')) reasons.add('JUPITER_429');
    else if (flag === 'SECURITY_CLIENT') reasons.add('SECURITY_CLIENT');
    else if (flag === 'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN') reasons.add('ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN');
  }
  if (reasons.size === 0) reasons.add('MISSING_POSITIVE_ROUTE_EVIDENCE');
  return [...reasons].sort();
}

function routeTruthEvidenceSources(row: JsonRow): string[] {
  if (hasExplicitNoSellRouteEvidence(row)) return [];
  const extras = obj(row.extras);
  const sellQuoteEvidence = obj(row.entrySellQuoteEvidence);
  const extraSellQuoteEvidence = obj(extras.entrySellQuoteEvidence);
  const exitSellQuoteEvidence = obj(row.exitSellQuoteEvidence);
  const extraExitSellQuoteEvidence = obj(extras.exitSellQuoteEvidence);
  const sources = new Set<string>();
  if (row.routeFound === true || extras.routeFound === true) sources.add('routeFound');
  if (row.sellRouteKnown === true || extras.sellRouteKnown === true) sources.add('sellRouteKnown');
  if (row.exitRouteFound === true || extras.exitRouteFound === true) sources.add('exitRouteFound');
  if (row.exitSellRouteKnown === true || extras.exitSellRouteKnown === true) sources.add('exitSellRouteKnown');
  if (sellQuoteEvidence.routeFound === true || extraSellQuoteEvidence.routeFound === true) {
    sources.add('entrySellQuote.routeFound');
  }
  if (exitSellQuoteEvidence.routeFound === true || extraExitSellQuoteEvidence.routeFound === true) {
    sources.add('exitSellQuote.routeFound');
  }
  for (const flag of rowSurvivalFlags(row)) {
    if (flag === 'SELL_ROUTE_OK' || flag === 'EXIT_LIQUIDITY_KNOWN' || flag === 'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_KNOWN') {
      sources.add(flag);
    }
  }
  return [...sources].sort();
}

function routeTruthBucket(row: JsonRow): { bucket: string; recoverability: RouteTruthAuditStats['recoverability'] } {
  const sources = routeTruthEvidenceSources(row);
  if (sources.length > 0 && !isUnderfillRouteUnknown(row)) {
    return { bucket: `route_known:${sources[0]}`, recoverability: 'ready' };
  }
  const reasons = routeUnknownReasonsForRow(row);
  if (reasons.some((reason) =>
    reason === 'JUPITER_429' ||
    reason === 'EXIT_ROUTE_PROOF_SELL_QUOTE_ERROR' ||
    reason === 'EXIT_ROUTE_PROOF_EXIT_ROUTE_PROOF_EXCEPTION'
  )) {
    return { bucket: 'route_unknown:infra_retry', recoverability: 'infra_retry' };
  }
  if (reasons.some((reason) =>
    reason === 'EXIT_ROUTE_PROOF_SELL_QUOTE_PROBE_DISABLED' ||
    reason === 'EXIT_ROUTE_PROOF_INVALID_QUANTITY' ||
    reason === 'EXIT_ROUTE_PROOF_ROUTE_FOUND_UNKNOWN' ||
    reason === 'EXIT_ROUTE_PROOF_EXIT_ROUTE_PROOF_MISSING_EVIDENCE'
  )) {
    return { bucket: 'route_unknown:data_gap', recoverability: 'data_gap' };
  }
  if (reasons.some((reason) => reason === 'NO_SELL_ROUTE' || reason === 'EXIT_LIQUIDITY_UNKNOWN' || reason === 'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN')) {
    return { bucket: 'route_unknown:structural_exit_route', recoverability: 'structural_block' };
  }
  if (reasons.some((reason) =>
    reason === 'TOKEN_QUALITY_UNKNOWN' ||
    reason === 'NO_SECURITY_DATA' ||
    reason === 'NO_SECURITY_CLIENT' ||
    reason === 'SECURITY_CLIENT'
  )) {
    return { bucket: 'route_unknown:data_gap', recoverability: 'data_gap' };
  }
  return { bucket: 'route_unknown:missing_positive_evidence', recoverability: 'unknown' };
}

function hasUnderfillRoutePositiveEvidence(row: JsonRow): boolean {
  if (hasExplicitNoSellRouteEvidence(row)) return false;
  const extras = obj(row.extras);
  const sellQuoteEvidence = obj(row.entrySellQuoteEvidence);
  const extraSellQuoteEvidence = obj(extras.entrySellQuoteEvidence);
  const exitSellQuoteEvidence = obj(row.exitSellQuoteEvidence);
  const extraExitSellQuoteEvidence = obj(extras.exitSellQuoteEvidence);
  if (row.routeFound === true || extras.routeFound === true) return true;
  if (row.sellRouteKnown === true || extras.sellRouteKnown === true) return true;
  if (row.exitRouteFound === true || extras.exitRouteFound === true) return true;
  if (row.exitSellRouteKnown === true || extras.exitSellRouteKnown === true) return true;
  if (sellQuoteEvidence.routeFound === true || extraSellQuoteEvidence.routeFound === true) return true;
  if (exitSellQuoteEvidence.routeFound === true || extraExitSellQuoteEvidence.routeFound === true) return true;
  return rowSurvivalFlags(row).some((flag) =>
    flag === 'SELL_ROUTE_OK' ||
    flag === 'EXIT_LIQUIDITY_KNOWN' ||
    flag === 'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_KNOWN'
  );
}

function hasExplicitNoSellRouteEvidence(row: JsonRow): boolean {
  const extras = obj(row.extras);
  const sellQuoteEvidence = obj(row.entrySellQuoteEvidence);
  const extraSellQuoteEvidence = obj(extras.entrySellQuoteEvidence);
  const exitSellQuoteEvidence = obj(row.exitSellQuoteEvidence);
  const extraExitSellQuoteEvidence = obj(extras.exitSellQuoteEvidence);
  if (row.routeFound === false || extras.routeFound === false) return true;
  if (row.sellRouteKnown === false || extras.sellRouteKnown === false) return true;
  if (row.exitRouteFound === false || extras.exitRouteFound === false) return true;
  if (row.exitSellRouteKnown === false || extras.exitSellRouteKnown === false) return true;
  if (sellQuoteEvidence.routeFound === false || extraSellQuoteEvidence.routeFound === false) return true;
  if (exitSellQuoteEvidence.routeFound === false || extraExitSellQuoteEvidence.routeFound === false) return true;
  return rowSurvivalFlags(row).some((flag) =>
    flag === 'NO_SELL_ROUTE' ||
    flag === 'SELL_NO_ROUTE' ||
    flag === 'NO_ROUTE' ||
    flag.includes('NO_SELL_ROUTE')
  );
}

function isRotationUnderfillRow(row: JsonRow): boolean {
  const arm = rowArmName(row);
  const entryArm = rowStringWithExtras(row, ['entryArm']);
  const profileArm = rowStringWithExtras(row, ['profileArm']);
  return arm.startsWith('rotation_underfill') ||
    entryArm.startsWith('rotation_underfill') ||
    profileArm.startsWith('rotation_underfill') ||
    rowSurvivalFlags(row).some((flag) => flag.startsWith('ROTATION_UNDERFILL'));
}

function isCostAwareUnderfillRow(row: JsonRow): boolean {
  const arm = rowArmName(row);
  const profileArm = rowStringWithExtras(row, ['profileArm']);
  const parameterVersion = rowStringWithExtras(row, ['parameterVersion']);
  return arm === 'rotation_underfill_cost_aware_exit_v2' ||
    profileArm === 'rotation_underfill_cost_aware_exit_v2' ||
    parameterVersion.includes('cost-aware') ||
    rowSurvivalFlags(row).some((flag) => flag === 'ROTATION_COST_AWARE_EXIT_V2');
}

function isRouteKnownCostAwareUnderfillRow(row: JsonRow): boolean {
  return isRotationUnderfillRow(row) && !isUnderfillRouteUnknown(row) && isCostAwareUnderfillRow(row);
}

function rowUnderfillReferencePrice(row: JsonRow): number | null {
  const direct = num(row.underfillReferencePrice);
  if (direct != null && direct > 0) return direct;
  const extras = obj(row.extras);
  const extraDirect = num(extras.underfillReferencePrice);
  if (extraDirect != null && extraDirect > 0) return extraDirect;
  const sol = num(row.underfillReferenceSolAmount) ?? num(extras.underfillReferenceSolAmount);
  const tokens = num(row.underfillReferenceTokenAmount) ?? num(extras.underfillReferenceTokenAmount);
  if (sol != null && tokens != null && sol > 0 && tokens > 0) return sol / tokens;
  return null;
}

function rowEntryPriceForUnderfillQuality(row: JsonRow): number | null {
  return num(row.entryPriceTokenOnly) ??
    num(row.entryPrice) ??
    num(obj(row.extras).entryPrice);
}

function buildUnderfillEntryQualityStats(
  scope: UnderfillEntryQualityStats['scope'],
  rows: JsonRow[]
): UnderfillEntryQualityStats {
  const underfillRows = rows.filter((row) => {
    const arm = rowArmName(row);
    const entryArm = str(row.entryArm) || str(obj(row.extras).entryArm);
    return arm === 'rotation_underfill_v1' ||
      arm === 'rotation_underfill_exit_flow_v1' ||
      entryArm === 'rotation_underfill_v1';
  });
  const diffs = underfillRows
    .map((row) => {
      const ref = rowUnderfillReferencePrice(row);
      const entry = rowEntryPriceForUnderfillQuality(row);
      if (ref == null || entry == null || ref <= 0 || entry <= 0) return null;
      return entry / ref - 1;
    })
    .filter((value): value is number => value != null && Number.isFinite(value));
  return {
    scope,
    rows: underfillRows.length,
    referenceRows: diffs.length,
    medianEntryVsKolFillPct: percentile(diffs, 0.5),
    p75EntryVsKolFillPct: percentile(diffs, 0.75),
    favorableRows: diffs.filter((value) => value < 0).length,
    unfavorableRows: diffs.filter((value) => value >= 0).length,
  };
}

function summarizeUnderfillRouteCohort(
  cohort: string,
  rows: JsonRow[],
  assumedNetworkFeeSol: number
): UnderfillRouteCohortStats {
  const netSolValues = rows.map((row) => numberOrZero(row.netSol));
  const tokenOnlyValues = rows.map((row) => num(row.netSolTokenOnly) ?? numberOrZero(row.netSol));
  const refundAdjustedValues = tokenOnlyValues.map((value) => value - assumedNetworkFeeSol);
  const edgeRows = rows.map(rotationEdge).filter((edge) => Object.keys(edge).length > 0);
  const mfeValues = rows.map(rowMfePct).filter((value): value is number => value != null);
  const holdSecValues = rows.map((row) => num(row.holdSec)).filter((value): value is number => value != null);
  return {
    cohort,
    rows: rows.length,
    routeKnownRows: rows.filter((row) => !isUnderfillRouteUnknown(row)).length,
    routeUnknownRows: rows.filter(isUnderfillRouteUnknown).length,
    independentKol2Rows: rows.filter(isTwoPlusKolRow).length,
    unknownKolRows: rows.filter(isUnknownKolCountRow).length,
    costAwareRows: rows.filter(isCostAwareUnderfillRow).length,
    wins: netSolValues.filter((value) => value > 0).length,
    losses: netSolValues.filter((value) => value <= 0).length,
    netSol: netSolValues.reduce((sum, value) => sum + value, 0),
    netSolTokenOnly: tokenOnlyValues.reduce((sum, value) => sum + value, 0),
    refundAdjustedNetSol: refundAdjustedValues.reduce((sum, value) => sum + value, 0),
    refundAdjustedWinRows: refundAdjustedValues.filter((value) => value > 0).length,
    edgePassRows: edgeRows.filter((edge) => edgePassValue(edge) === true).length,
    edgeFailRows: edgeRows.filter((edge) => edgePassValue(edge) === false).length,
    t1Rows: rows.filter(rowHasT1).length,
    medianMfePct: percentile(mfeValues, 0.5),
    medianHoldSec: percentile(holdSecValues, 0.5),
  };
}

function buildUnderfillRouteCohorts(
  rows: JsonRow[],
  assumedNetworkFeeSol: number
): UnderfillRouteCohortStats[] {
  const underfillRows = rows.filter(isRotationUnderfillRow);
  const routeKnownRows = underfillRows.filter((row) => !isUnderfillRouteUnknown(row));
  const routeUnknownRows = underfillRows.filter(isUnderfillRouteUnknown);
  const routeKnown2KolRows = routeKnownRows.filter(isTwoPlusKolRow);
  const routeKnownCostAwareRows = routeKnownRows.filter(isCostAwareUnderfillRow);
  const routeKnown2KolCostAwareRows = routeKnown2KolRows.filter(isCostAwareUnderfillRow);
  return [
    summarizeUnderfillRouteCohort('underfill_all', underfillRows, assumedNetworkFeeSol),
    summarizeUnderfillRouteCohort('route_unknown', routeUnknownRows, assumedNetworkFeeSol),
    summarizeUnderfillRouteCohort('route_known', routeKnownRows, assumedNetworkFeeSol),
    summarizeUnderfillRouteCohort('route_known_2kol', routeKnown2KolRows, assumedNetworkFeeSol),
    summarizeUnderfillRouteCohort('route_known_cost_aware', routeKnownCostAwareRows, assumedNetworkFeeSol),
    summarizeUnderfillRouteCohort('route_known_2kol_cost_aware', routeKnown2KolCostAwareRows, assumedNetworkFeeSol),
  ];
}

function buildUnderfillKolCohorts(
  rows: JsonRow[],
  assumedNetworkFeeSol: number
): UnderfillRouteCohortStats[] {
  const underfillRows = rows.filter(isRotationUnderfillRow);
  const singleKolRows = underfillRows.filter(isSingleKolRow);
  const twoPlusKolRows = underfillRows.filter(isTwoPlusKolRow);
  const unknownKolRows = underfillRows.filter(isUnknownKolCountRow);
  const costAwareRows = underfillRows.filter(isCostAwareUnderfillRow);
  return [
    summarizeUnderfillRouteCohort('underfill_1kol', singleKolRows, assumedNetworkFeeSol),
    summarizeUnderfillRouteCohort('underfill_2plus_kol', twoPlusKolRows, assumedNetworkFeeSol),
    summarizeUnderfillRouteCohort('underfill_unknown_kol', unknownKolRows, assumedNetworkFeeSol),
    summarizeUnderfillRouteCohort('underfill_1kol_cost_aware', singleKolRows.filter(isCostAwareUnderfillRow), assumedNetworkFeeSol),
    summarizeUnderfillRouteCohort('underfill_2plus_kol_cost_aware', twoPlusKolRows.filter(isCostAwareUnderfillRow), assumedNetworkFeeSol),
    summarizeUnderfillRouteCohort('underfill_unknown_kol_cost_aware', unknownKolRows.filter(isCostAwareUnderfillRow), assumedNetworkFeeSol),
    summarizeUnderfillRouteCohort('underfill_cost_aware_all', costAwareRows, assumedNetworkFeeSol),
  ];
}

function buildLiveEquivalenceBucketStats(
  rows: JsonRow[],
  bucketFor: (row: JsonRow) => string
): LiveEquivalenceBucketStats[] {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows) {
    const key = bucketFor(row) || '(unknown)';
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return [...buckets.entries()]
    .map(([bucket, scoped]) => ({
      bucket,
      rows: scoped.length,
      liveWouldEnterRows: scoped.filter(rowLiveWouldEnter).length,
      liveAttemptedRows: scoped.filter(rowLiveAttempted).length,
      blockedRows: scoped.filter((row) => !rowLiveWouldEnter(row)).length,
      singleKolRows: scoped.filter(isSingleKolRow).length,
      twoPlusKolRows: scoped.filter(isTwoPlusKolRow).length,
      unknownKolRows: scoped.filter(isUnknownKolCountRow).length,
    }))
    .sort((a, b) => b.rows - a.rows || a.bucket.localeCompare(b.bucket));
}

function buildLiveEquivalenceSummary(rows: JsonRow[]): LiveEquivalenceSummary {
  const rotationRows = rows.filter(isRotationLiveEquivalenceRow);
  return {
    totalRows: rows.length,
    rotationRows: rotationRows.length,
    liveWouldEnterRows: rotationRows.filter(rowLiveWouldEnter).length,
    liveAttemptedRows: rotationRows.filter(rowLiveAttempted).length,
    blockedRows: rotationRows.filter((row) => !rowLiveWouldEnter(row)).length,
    yellowZoneRows: rotationRows.filter(isYellowZoneEquivalenceRow).length,
    yellowZoneSingleKolRows: rotationRows.filter((row) =>
      isYellowZoneEquivalenceRow(row) && isSingleKolRow(row)
    ).length,
    yellowZoneTwoPlusKolRows: rotationRows.filter((row) =>
      isYellowZoneEquivalenceRow(row) && isTwoPlusKolRow(row)
    ).length,
    yellowZoneUnknownKolRows: rotationRows.filter((row) =>
      isYellowZoneEquivalenceRow(row) && isUnknownKolCountRow(row)
    ).length,
    routeUnknownFallbackRows: rotationRows.filter(isRouteUnknownFallbackRow).length,
    byStage: buildLiveEquivalenceBucketStats(rotationRows, rowDecisionStage),
    byBlockReason: buildLiveEquivalenceBucketStats(rotationRows, rowLiveBlockReason),
  };
}

function buildRouteUnknownReasonStats(
  rows: JsonRow[],
  assumedNetworkFeeSol: number
): RouteUnknownReasonStats[] {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows.filter(isRotationUnderfillRow)) {
    for (const reason of routeUnknownReasonsForRow(row)) {
      buckets.set(reason, [...(buckets.get(reason) ?? []), row]);
    }
  }
  return [...buckets.entries()]
    .map(([reason, scoped]) => {
      const refundAdjustedValues = scoped.map((row) =>
        (num(row.netSolTokenOnly) ?? numberOrZero(row.netSol)) - assumedNetworkFeeSol
      );
      const mfeValues = scoped.map(rowMfePct).filter((value): value is number => value != null);
      const holdSecValues = scoped.map((row) => num(row.holdSec)).filter((value): value is number => value != null);
      return {
        reason,
        rows: scoped.length,
        wins: refundAdjustedValues.filter((value) => value > 0).length,
        losses: refundAdjustedValues.filter((value) => value <= 0).length,
        refundAdjustedNetSol: refundAdjustedValues.reduce((sum, value) => sum + value, 0),
        t1Rows: scoped.filter(rowHasT1).length,
        medianMfePct: percentile(mfeValues, 0.5),
        medianHoldSec: percentile(holdSecValues, 0.5),
      };
    })
    .sort((a, b) => b.rows - a.rows || b.refundAdjustedNetSol - a.refundAdjustedNetSol || a.reason.localeCompare(b.reason));
}

function buildRouteTruthAuditStats(
  rows: JsonRow[],
  assumedNetworkFeeSol: number
): RouteTruthAuditStats[] {
  const buckets = new Map<string, { recoverability: RouteTruthAuditStats['recoverability']; rows: JsonRow[] }>();
  for (const row of rows.filter(isRotationUnderfillRow)) {
    const truth = routeTruthBucket(row);
    const current = buckets.get(truth.bucket) ?? { recoverability: truth.recoverability, rows: [] };
    current.rows.push(row);
    buckets.set(truth.bucket, current);
  }
  return [...buckets.entries()]
    .map(([bucket, value]) => {
      const scoped = value.rows;
      const refundAdjustedValues = scoped.map((row) =>
        (num(row.netSolTokenOnly) ?? numberOrZero(row.netSol)) - assumedNetworkFeeSol
      );
      const reasonCounts = new Map<string, number>();
      for (const row of scoped) {
        const reasons = routeUnknownReasonsForRow(row);
        for (const reason of reasons.length > 0 ? reasons : routeTruthEvidenceSources(row)) {
          reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
        }
      }
      return {
        bucket,
        rows: scoped.length,
        routeKnownRows: scoped.filter((row) => !isUnderfillRouteUnknown(row)).length,
        routeUnknownRows: scoped.filter(isUnderfillRouteUnknown).length,
        recoverability: value.recoverability,
        wins: refundAdjustedValues.filter((item) => item > 0).length,
        losses: refundAdjustedValues.filter((item) => item <= 0).length,
        refundAdjustedNetSol: refundAdjustedValues.reduce((sum, item) => sum + item, 0),
        medianMfePct: percentile(scoped.map(rowMfePct).filter((item): item is number => item != null), 0.5),
        topReasons: [...reasonCounts.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
          .slice(0, 4),
      };
    })
    .sort((a, b) => b.rows - a.rows || a.bucket.localeCompare(b.bucket));
}

function buildKolTimingStats(
  rows: JsonRow[],
  assumedNetworkFeeSol: number
): KolTimingStats[] {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows.filter(isRotationUnderfillRow)) {
    const bucket = kolTimingBucket(row);
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), row]);
  }
  return [...buckets.entries()]
    .map(([bucket, scoped]) => {
      const refundAdjustedValues = scoped.map((row) =>
        (num(row.netSolTokenOnly) ?? numberOrZero(row.netSol)) - assumedNetworkFeeSol
      );
      const delays = bucket.startsWith('2plus')
        ? scoped.map(secondKolDelaySec).filter((item): item is number => item != null)
        : [];
      return {
        bucket,
        rows: scoped.length,
        routeKnownRows: scoped.filter((row) => !isUnderfillRouteUnknown(row)).length,
        costAwareRows: scoped.filter(isCostAwareUnderfillRow).length,
        refundAdjustedNetSol: refundAdjustedValues.reduce((sum, item) => sum + item, 0),
        t1Rows: scoped.filter(rowHasT1).length,
        medianSecondKolDelaySec: percentile(delays, 0.5),
      };
    })
    .sort((a, b) => b.rows - a.rows || a.bucket.localeCompare(b.bucket));
}

function isPosthocSecondKolRow(row: JsonRow): boolean {
  return isRotationUnderfillRow(row) &&
    !isTwoPlusKolRow(row) &&
    participantKolCount(row) >= 2 &&
    secondKolDelaySec(row) != null;
}

function summarizePosthocSecondKol(
  cohort: string,
  rows: JsonRow[],
  assumedNetworkFeeSol: number
): PosthocSecondKolStats {
  const refundAdjustedValues = rows.map((row) =>
    (num(row.netSolTokenOnly) ?? numberOrZero(row.netSol)) - assumedNetworkFeeSol
  );
  const delays = rows.map(secondKolDelaySec).filter((item): item is number => item != null);
  return {
    cohort,
    rows: rows.length,
    routeKnownRows: rows.filter((row) => !isUnderfillRouteUnknown(row)).length,
    costAwareRows: rows.filter(isCostAwareUnderfillRow).length,
    wins: refundAdjustedValues.filter((item) => item > 0).length,
    losses: refundAdjustedValues.filter((item) => item <= 0).length,
    refundAdjustedNetSol: refundAdjustedValues.reduce((sum, item) => sum + item, 0),
    t1Rows: rows.filter(rowHasT1).length,
    medianMfePct: percentile(rows.map(rowMfePct).filter((item): item is number => item != null), 0.5),
    medianSecondKolDelaySec: percentile(delays, 0.5),
  };
}

function buildPosthocSecondKolStats(
  rows: JsonRow[],
  assumedNetworkFeeSol: number
): PosthocSecondKolStats[] {
  const posthocRows = rows.filter(isPosthocSecondKolRow);
  return [
    summarizePosthocSecondKol('posthoc_2nd_kol_all', posthocRows, assumedNetworkFeeSol),
    summarizePosthocSecondKol('posthoc_2nd_kol_cost_aware', posthocRows.filter(isCostAwareUnderfillRow), assumedNetworkFeeSol),
    summarizePosthocSecondKol('posthoc_2nd_kol_secondKOL<=15s', posthocRows.filter((row) => {
      const delay = secondKolDelaySec(row);
      return delay != null && delay <= 15;
    }), assumedNetworkFeeSol),
    summarizePosthocSecondKol('posthoc_2nd_kol_secondKOL<=30s', posthocRows.filter((row) => {
      const delay = secondKolDelaySec(row);
      return delay != null && delay <= 30;
    }), assumedNetworkFeeSol),
    summarizePosthocSecondKol('posthoc_2nd_kol_late', posthocRows.filter((row) => {
      const delay = secondKolDelaySec(row);
      return delay != null && delay > 30;
    }), assumedNetworkFeeSol),
  ];
}

function markoutDeltaAt(row: JsonRow, horizonSec: number, markoutsByPosition: Map<string, JsonRow[]>): number | null {
  const markout = (markoutsByPosition.get(rowPositionId(row)) ?? [])
    .find((item) => rowHorizon(item) === horizonSec && isOk(item));
  return markout ? rowDelta(markout) : null;
}

function waitEntryHorizonSec(row: JsonRow, horizonsSec: number[]): number | null {
  const delay = secondKolDelaySec(row);
  if (delay == null) return null;
  return horizonsSec.find((horizonSec) => horizonSec >= delay) ?? null;
}

function nextWaitExitHorizonSec(entryHorizonSec: number, horizonsSec: number[], minAdditionalSec: number): number | null {
  return horizonsSec.find((horizonSec) => horizonSec >= entryHorizonSec + minAdditionalSec) ?? null;
}

function rebasedPostCostDelta(
  row: JsonRow,
  entryHorizonSec: number,
  exitHorizonSec: number,
  markoutsByPosition: Map<string, JsonRow[]>,
  roundTripCostPct: number
): number | null {
  const entryDelta = markoutDeltaAt(row, entryHorizonSec, markoutsByPosition);
  const exitDelta = markoutDeltaAt(row, exitHorizonSec, markoutsByPosition);
  if (entryDelta == null || exitDelta == null || 1 + entryDelta <= 0) return null;
  return ((1 + exitDelta) / (1 + entryDelta) - 1) - roundTripCostPct;
}

function summarizePosthocSecondKolWaitProxy(
  cohort: string,
  rows: JsonRow[],
  exitProfile: string,
  minAdditionalSec: number,
  markoutsByPosition: Map<string, JsonRow[]>,
  horizonsSec: number[],
  roundTripCostPct: number,
  assumedNetworkFeeSol: number
): PosthocSecondKolWaitProxyStats {
  const refundAdjustedValues = rows.map((row) =>
    (num(row.netSolTokenOnly) ?? numberOrZero(row.netSol)) - assumedNetworkFeeSol
  );
  const entryDeltas: number[] = [];
  const postCostDeltas: number[] = [];
  for (const row of rows) {
    const entryHorizonSec = waitEntryHorizonSec(row, horizonsSec);
    if (entryHorizonSec == null) continue;
    const exitHorizonSec = nextWaitExitHorizonSec(entryHorizonSec, horizonsSec, minAdditionalSec);
    if (exitHorizonSec == null) continue;
    const entryDelta = markoutDeltaAt(row, entryHorizonSec, markoutsByPosition);
    const postCostDelta = rebasedPostCostDelta(
      row,
      entryHorizonSec,
      exitHorizonSec,
      markoutsByPosition,
      roundTripCostPct
    );
    if (entryDelta == null || postCostDelta == null) continue;
    entryDeltas.push(entryDelta);
    postCostDeltas.push(postCostDelta);
  }
  return {
    cohort,
    exitProfile,
    rows: rows.length,
    observedRows: postCostDeltas.length,
    currentRefundAdjustedNetSol: refundAdjustedValues.reduce((sum, item) => sum + item, 0),
    currentPostCostPositiveRate: ratio(refundAdjustedValues.filter((item) => item > 0).length, rows.length),
    medianWaitEntryDeltaPct: percentile(entryDeltas, 0.5),
    waitEntryFavorableRows: entryDeltas.filter((item) => item <= 0).length,
    positiveRows: postCostDeltas.filter((item) => item > 0).length,
    postCostPositiveRate: ratio(postCostDeltas.filter((item) => item > 0).length, postCostDeltas.length),
    medianPostCostDeltaPct: percentile(postCostDeltas, 0.5),
    p25PostCostDeltaPct: percentile(postCostDeltas, 0.25),
  };
}

function buildPosthocSecondKolWaitProxyStats(
  rows: JsonRow[],
  markoutRows: JsonRow[],
  horizonsSec: number[],
  roundTripCostPct: number,
  assumedNetworkFeeSol: number
): PosthocSecondKolWaitProxyStats[] {
  const markoutsByPosition = buyMarkoutsByPosition(markoutRows);
  const posthocRows = rows.filter(isPosthocSecondKolRow);
  const cohorts = [
    { cohort: 'posthoc_2nd_kol_all', rows: posthocRows },
    { cohort: 'posthoc_2nd_kol_cost_aware', rows: posthocRows.filter(isCostAwareUnderfillRow) },
    {
      cohort: 'posthoc_2nd_kol_secondKOL<=15s',
      rows: posthocRows.filter((row) => {
        const delay = secondKolDelaySec(row);
        return delay != null && delay <= 15;
      }),
    },
    {
      cohort: 'posthoc_2nd_kol_secondKOL<=30s',
      rows: posthocRows.filter((row) => {
        const delay = secondKolDelaySec(row);
        return delay != null && delay <= 30;
      }),
    },
  ];
  return cohorts.flatMap(({ cohort, rows: cohortRows }) => [
    summarizePosthocSecondKolWaitProxy(
      cohort,
      cohortRows,
      'wait_to_2nd_kol_then_next_horizon',
      1,
      markoutsByPosition,
      horizonsSec,
      roundTripCostPct,
      assumedNetworkFeeSol
    ),
    summarizePosthocSecondKolWaitProxy(
      cohort,
      cohortRows,
      'wait_to_2nd_kol_then_30s_min',
      30,
      markoutsByPosition,
      horizonsSec,
      roundTripCostPct,
      assumedNetworkFeeSol
    ),
  ]);
}

function buildPosthocSecondKolCandidateDecision(
  cohort: string,
  waitProxies: PosthocSecondKolWaitProxyStats[]
): PosthocSecondKolCandidateDecision {
  const exitProfile = 'wait_to_2nd_kol_then_next_horizon';
  const proxy = waitProxies.find((row) => row.cohort === cohort && row.exitProfile === exitProfile);
  const observedRows = proxy?.observedRows ?? 0;
  const postCostPositiveRate = proxy?.postCostPositiveRate ?? null;
  const medianPostCostDeltaPct = proxy?.medianPostCostDeltaPct ?? null;
  const p25PostCostDeltaPct = proxy?.p25PostCostDeltaPct ?? null;
  const reasons: string[] = [];
  let verdict: PosthocSecondKolCandidateVerdict = 'COLLECT';

  if (!proxy || observedRows === 0) {
    reasons.push('wait-proxy observations missing');
  } else {
    const hasRejectSample = observedRows >= POSTHOC_SECOND_KOL_REVIEW_MIN_OBSERVED;
    const weakPositiveRate =
      postCostPositiveRate != null && postCostPositiveRate < POSTHOC_SECOND_KOL_REJECT_POSITIVE_RATE;
    const weakDownside = p25PostCostDeltaPct != null && p25PostCostDeltaPct <= 0;

    if (hasRejectSample && (weakPositiveRate || weakDownside)) {
      verdict = 'REJECT';
      if (weakPositiveRate) {
        reasons.push(
          `post-cost positive ${formatPct(postCostPositiveRate)} < ` +
          `${formatPct(POSTHOC_SECOND_KOL_REJECT_POSITIVE_RATE)}`
        );
      }
      if (weakDownside) reasons.push(`p25 post-cost ${formatPct(p25PostCostDeltaPct)} <= 0`);
    } else if (observedRows < POSTHOC_SECOND_KOL_REVIEW_MIN_OBSERVED) {
      verdict = 'COLLECT';
      reasons.push(`sample ${observedRows}/${POSTHOC_SECOND_KOL_REVIEW_MIN_OBSERVED}`);
    } else if (observedRows < POSTHOC_SECOND_KOL_DECISION_MIN_OBSERVED) {
      verdict = 'WATCH';
      reasons.push(`review sample ${observedRows}/${POSTHOC_SECOND_KOL_DECISION_MIN_OBSERVED}`);
      if ((postCostPositiveRate ?? 0) < POSTHOC_SECOND_KOL_MIN_POSITIVE_RATE) {
        reasons.push(
          `post-cost positive ${formatPct(postCostPositiveRate)} < ` +
          `${formatPct(POSTHOC_SECOND_KOL_MIN_POSITIVE_RATE)}`
        );
      }
      if ((medianPostCostDeltaPct ?? 0) <= 0) reasons.push(`median post-cost ${formatPct(medianPostCostDeltaPct)} <= 0`);
      if ((p25PostCostDeltaPct ?? 0) <= 0) reasons.push(`p25 post-cost ${formatPct(p25PostCostDeltaPct)} <= 0`);
    } else if (
      (postCostPositiveRate ?? 0) >= POSTHOC_SECOND_KOL_MIN_POSITIVE_RATE &&
      (medianPostCostDeltaPct ?? 0) > 0 &&
      (p25PostCostDeltaPct ?? 0) > 0
    ) {
      verdict = 'PAPER_CANDIDATE';
      reasons.push('paper-only candidate threshold met; live remains unchanged');
    } else {
      verdict = 'REJECT';
      if ((postCostPositiveRate ?? 0) < POSTHOC_SECOND_KOL_MIN_POSITIVE_RATE) {
        reasons.push(
          `post-cost positive ${formatPct(postCostPositiveRate)} < ` +
          `${formatPct(POSTHOC_SECOND_KOL_MIN_POSITIVE_RATE)}`
        );
      }
      if ((medianPostCostDeltaPct ?? 0) <= 0) reasons.push(`median post-cost ${formatPct(medianPostCostDeltaPct)} <= 0`);
      if ((p25PostCostDeltaPct ?? 0) <= 0) reasons.push(`p25 post-cost ${formatPct(p25PostCostDeltaPct)} <= 0`);
    }
  }

  return {
    cohort,
    exitProfile,
    verdict,
    observedRows,
    minReviewObserved: POSTHOC_SECOND_KOL_REVIEW_MIN_OBSERVED,
    minDecisionObserved: POSTHOC_SECOND_KOL_DECISION_MIN_OBSERVED,
    postCostPositiveRate,
    medianPostCostDeltaPct,
    p25PostCostDeltaPct,
    currentRefundAdjustedNetSol: proxy?.currentRefundAdjustedNetSol ?? null,
    reasons,
  };
}

function buildPosthocSecondKolCandidateDecisions(
  waitProxies: PosthocSecondKolWaitProxyStats[]
): PosthocSecondKolCandidateDecision[] {
  return [
    buildPosthocSecondKolCandidateDecision('posthoc_2nd_kol_secondKOL<=15s', waitProxies),
    buildPosthocSecondKolCandidateDecision('posthoc_2nd_kol_secondKOL<=30s', waitProxies),
  ];
}

function buildPosthocSecondKolSyntheticPaperArms(
  decisions: PosthocSecondKolCandidateDecision[]
): PosthocSecondKolSyntheticPaperArm[] {
  return decisions.map((decision) => {
    const suffix = decision.cohort.replace('posthoc_2nd_kol_', '');
    return {
      armName: `${POSTHOC_SECOND_KOL_SYNTHETIC_ARM}:${suffix}`,
      sourceCohort: decision.cohort,
      verdict: decision.verdict,
      observedRows: decision.observedRows,
      minDecisionObserved: decision.minDecisionObserved,
      postCostPositiveRate: decision.postCostPositiveRate,
      medianPostCostDeltaPct: decision.medianPostCostDeltaPct,
      p25PostCostDeltaPct: decision.p25PostCostDeltaPct,
      currentRefundAdjustedNetSol: decision.currentRefundAdjustedNetSol,
      proxyOnly: true,
      liveEquivalent: false,
      reasons: [
        ...decision.reasons,
        'synthetic paper arm only; runtime/live unchanged',
      ],
    };
  });
}

function buildPosthocSecondKolRouteProofGate(
  cohort: string,
  rows: JsonRow[],
  assumedNetworkFeeSol: number
): PosthocSecondKolRouteProofGate {
  const routeKnownRows = rows.filter((row) => !isUnderfillRouteUnknown(row)).length;
  const routeProofRows = rows.filter((row) => routeTruthEvidenceSources(row).length > 0).length;
  const reasonCounts = new Map<string, number>();
  let structuralBlockRows = 0;
  let dataGapRows = 0;
  let infraRetryRows = 0;
  let unknownRows = 0;
  let explicitNoSellRouteRows = 0;
  let exitLiquidityUnknownRows = 0;
  let securityDataGapRows = 0;
  let mixedExitLiquidityAndDataGapRows = 0;
  let missingPositiveEvidenceRows = 0;

  for (const row of rows) {
    const truth = routeTruthBucket(row);
    if (truth.recoverability === 'structural_block') structuralBlockRows += 1;
    else if (truth.recoverability === 'data_gap') dataGapRows += 1;
    else if (truth.recoverability === 'infra_retry') infraRetryRows += 1;
    else if (truth.recoverability === 'unknown') unknownRows += 1;

    const labels = routeUnknownReasonsForRow(row);
    const evidence = routeTruthEvidenceSources(row);
    const hasExplicitNoSellRoute = labels.some((label) =>
      label === 'NO_SELL_ROUTE' ||
      label === 'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN'
    );
    const hasExitLiquidityUnknown = labels.some((label) => label === 'EXIT_LIQUIDITY_UNKNOWN');
    const hasSecurityDataGap = labels.some((label) =>
      label === 'TOKEN_QUALITY_UNKNOWN' ||
      label === 'NO_SECURITY_DATA' ||
      label === 'NO_SECURITY_CLIENT' ||
      label === 'SECURITY_CLIENT'
    );
    const hasMissingPositiveEvidence = labels.some((label) => label === 'MISSING_POSITIVE_ROUTE_EVIDENCE');

    if (hasExplicitNoSellRoute) explicitNoSellRouteRows += 1;
    if (hasExitLiquidityUnknown) exitLiquidityUnknownRows += 1;
    if (hasSecurityDataGap) securityDataGapRows += 1;
    if (hasExitLiquidityUnknown && hasSecurityDataGap) mixedExitLiquidityAndDataGapRows += 1;
    if (hasMissingPositiveEvidence) missingPositiveEvidenceRows += 1;

    for (const label of labels.length > 0 ? labels : evidence) {
      reasonCounts.set(label, (reasonCounts.get(label) ?? 0) + 1);
    }
    if (labels.length === 0 && evidence.length === 0) {
      reasonCounts.set('MISSING_POSITIVE_ROUTE_EVIDENCE', (reasonCounts.get('MISSING_POSITIVE_ROUTE_EVIDENCE') ?? 0) + 1);
    }
  }

  let verdict: PosthocSecondKolRouteProofVerdict = 'COLLECT';
  const reasons: string[] = [];
  if (rows.length === 0) {
    reasons.push('sample missing');
  } else if (routeKnownRows === 0) {
    verdict = 'ROUTE_PROOF_MISSING';
    reasons.push('route-known proof missing; live remains blocked');
  } else if (routeKnownRows < rows.length) {
    verdict = 'PARTIAL_ROUTE_PROOF';
    reasons.push(`route-known ${routeKnownRows}/${rows.length}; keep paper-only`);
  } else {
    verdict = 'ROUTE_PROOF_READY';
    reasons.push('route-known proof complete; still paper-only until sample gate passes');
  }

  let recoveryHint = 'collect_more_rows';
  if (rows.length === 0) {
    recoveryHint = 'collect_sample';
  } else if (routeKnownRows === rows.length) {
    recoveryHint = 'route_proof_ready';
  } else if (explicitNoSellRouteRows > 0) {
    recoveryHint = 'review_true_no_route_before_live';
  } else if (mixedExitLiquidityAndDataGapRows > 0) {
    recoveryHint = 'record_exit_quote_and_security_evidence';
  } else if (exitLiquidityUnknownRows > 0) {
    recoveryHint = 'record_exit_quote_evidence';
  } else if (securityDataGapRows > 0) {
    recoveryHint = 'record_security_client_evidence';
  } else if (missingPositiveEvidenceRows > 0) {
    recoveryHint = 'record_positive_route_probe';
  }

  const refundAdjustedValues = rows.map((row) =>
    (num(row.netSolTokenOnly) ?? numberOrZero(row.netSol)) - assumedNetworkFeeSol
  );
  return {
    cohort,
    verdict,
    rows: rows.length,
    candidateIdRows: rows.filter((row) => Boolean(rowCandidateId(row))).length,
    routeKnownRows,
    routeProofRows,
    routeUnknownRows: rows.length - routeKnownRows,
    costAwareRows: rows.filter(isCostAwareUnderfillRow).length,
    structuralBlockRows,
    dataGapRows,
    infraRetryRows,
    unknownRows,
    explicitNoSellRouteRows,
    exitLiquidityUnknownRows,
    securityDataGapRows,
    mixedExitLiquidityAndDataGapRows,
    missingPositiveEvidenceRows,
    recoveryHint,
    refundAdjustedNetSol: rows.length > 0 ? refundAdjustedValues.reduce((sum, item) => sum + item, 0) : null,
    topReasons: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, 4),
    reasons,
  };
}

function buildPosthocSecondKolRouteProofGates(
  rows: JsonRow[],
  assumedNetworkFeeSol: number
): PosthocSecondKolRouteProofGate[] {
  const posthocRows = rows.filter(isPosthocSecondKolRow);
  const cohortRows = [
    {
      cohort: 'posthoc_2nd_kol_secondKOL<=15s',
      rows: posthocRows.filter((row) => {
        const delay = secondKolDelaySec(row);
        return delay != null && delay <= 15;
      }),
    },
    {
      cohort: 'posthoc_2nd_kol_secondKOL<=30s',
      rows: posthocRows.filter((row) => {
        const delay = secondKolDelaySec(row);
        return delay != null && delay <= 30;
      }),
    },
  ];
  return cohortRows.map((item) =>
    buildPosthocSecondKolRouteProofGate(item.cohort, item.rows, assumedNetworkFeeSol)
  );
}

function buildPosthocSecondKolRecoveryBacklog(
  gates: PosthocSecondKolRouteProofGate[],
  routeProofFreshness?: RouteProofFreshnessStats
): PosthocSecondKolRecoveryBacklogItem[] {
  return gates.map((gate) => {
    const liveStance = 'live blocked; report-only evidence only';
    if (routeProofFreshness?.verdict === 'WAIT_FRESH_CLOSES') {
      return {
        cohort: gate.cohort,
        priority: 'P2',
        status: 'WAIT_SAMPLE',
        nextSprint: 'collect_fresh_underfill_closes',
        evidenceGap: `freshUnderfill=${routeProofFreshness.freshRows}/${routeProofFreshness.minRequiredFreshRows}`,
        requiredBeforeLive: 'collect fresh post-deploy underfill closes with exit quote/liquidity and security evidence',
        liveStance,
      };
    }
    if (gate.rows === 0) {
      return {
        cohort: gate.cohort,
        priority: 'P2',
        status: 'WAIT_SAMPLE',
        nextSprint: 'collect_posthoc_2nd_kol_rows',
        evidenceGap: 'sample=0',
        requiredBeforeLive: 'collect route-proofed paper rows before any review',
        liveStance,
      };
    }
    if (gate.recoveryHint === 'review_true_no_route_before_live') {
      return {
        cohort: gate.cohort,
        priority: 'P0',
        status: 'BLOCKED',
        nextSprint: 'drill_down_true_no_sell_route',
        evidenceGap: `noRoute=${gate.explicitNoSellRouteRows}/${gate.rows}`,
        requiredBeforeLive: 'prove exits are structurally available before spending canary budget',
        liveStance,
      };
    }
    if (gate.recoveryHint === 'record_exit_quote_and_security_evidence') {
      return {
        cohort: gate.cohort,
        priority: 'P0',
        status: 'TODO',
        nextSprint: 'record_exit_quote_and_security_evidence',
        evidenceGap:
          `exitUnknown=${gate.exitLiquidityUnknownRows}/${gate.rows}, ` +
          `securityGap=${gate.securityDataGapRows}/${gate.rows}`,
        requiredBeforeLive: 'new paper rows carry exit quote/liquidity and security evidence snapshots',
        liveStance,
      };
    }
    if (gate.recoveryHint === 'record_exit_quote_evidence') {
      return {
        cohort: gate.cohort,
        priority: 'P0',
        status: 'TODO',
        nextSprint: 'record_exit_quote_evidence',
        evidenceGap: `exitUnknown=${gate.exitLiquidityUnknownRows}/${gate.rows}`,
        requiredBeforeLive: 'new paper rows carry sell-route or exit-liquidity evidence',
        liveStance,
      };
    }
    if (gate.recoveryHint === 'record_security_client_evidence') {
      return {
        cohort: gate.cohort,
        priority: 'P1',
        status: 'TODO',
        nextSprint: 'record_security_client_evidence',
        evidenceGap: `securityGap=${gate.securityDataGapRows}/${gate.rows}`,
        requiredBeforeLive: 'new paper rows carry token/security quality evidence',
        liveStance,
      };
    }
    if (gate.recoveryHint === 'record_positive_route_probe') {
      return {
        cohort: gate.cohort,
        priority: 'P1',
        status: 'TODO',
        nextSprint: 'record_positive_route_probe',
        evidenceGap: `missingProof=${gate.missingPositiveEvidenceRows}/${gate.rows}`,
        requiredBeforeLive: 'new paper rows carry explicit positive route probe evidence',
        liveStance,
      };
    }
    return {
      cohort: gate.cohort,
      priority: gate.verdict === 'ROUTE_PROOF_READY' ? 'P1' : 'P2',
      status: gate.verdict === 'ROUTE_PROOF_READY' ? 'READY_FOR_REVIEW' : 'WAIT_SAMPLE',
      nextSprint: gate.verdict === 'ROUTE_PROOF_READY' ? 'check_sample_gate_and_live_equivalence' : 'collect_more_rows',
      evidenceGap: `routeKnown=${gate.routeKnownRows}/${gate.rows}, routeProof=${gate.routeProofRows}/${gate.rows}`,
      requiredBeforeLive: 'sample gate, live-equivalence, and route proof must all pass',
      liveStance,
    };
  });
}

function countByLabel<T extends string>(
  values: T[],
  labelKey: string
): Array<{ [key: string]: string | number; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ [labelKey]: value, count }))
    .sort((a, b) => b.count - a.count || String(a[labelKey]).localeCompare(String(b[labelKey])));
}

function summarizePaperCohortValidity(cohort: string, rows: JsonRow[]): PaperCohortValidityStats {
  const candidateIdRows = rows.filter((row) => rowCandidateId(row)).length;
  return {
    cohort,
    rows: rows.length,
    candidateIdRows,
    candidateIdCoverage: ratio(candidateIdRows, rows.length),
    independentKolRows: rows.filter((row) => rowIndependentKolCount(row) != null).length,
    participantRows: rows.filter((row) => rowParticipants(row).length > 0).length,
    participantTimestampRows: rows.filter((row) => rowParticipants(row).some((item) => item.timestampMs != null)).length,
    routeProofRows: rows.filter((row) => routeTruthEvidenceSources(row).length > 0).length,
    costAwareRows: rows.filter(isCostAwareUnderfillRow).length,
    unknownTimingRows: rows.filter((row) => isTwoPlusKolRow(row) && secondKolDelaySec(row) == null).length,
  };
}

function buildPaperCohortValidityStats(rows: JsonRow[]): PaperCohortValidityStats[] {
  const underfillRows = rows.filter(isRotationUnderfillRow);
  const routeKnownCostAwareRows = underfillRows.filter(isRouteKnownCostAwareUnderfillRow);
  const routeKnown2KolCostAwareRows = routeKnownCostAwareRows.filter(isTwoPlusKolRow);
  return [
    summarizePaperCohortValidity('underfill_all', underfillRows),
    summarizePaperCohortValidity('route_known_cost_aware', routeKnownCostAwareRows),
    summarizePaperCohortValidity('1kol_route_known_cost_aware', routeKnownCostAwareRows.filter(isSingleKolRow)),
    summarizePaperCohortValidity('2kol_route_known_cost_aware', routeKnown2KolCostAwareRows),
    summarizePaperCohortValidity(
      '2kol_route_known_cost_aware_secondKOL<=15s',
      routeKnown2KolCostAwareRows.filter((row) => {
        const delay = secondKolDelaySec(row);
        return delay != null && delay <= 15;
      })
    ),
    summarizePaperCohortValidity(
      '2kol_route_known_cost_aware_secondKOL<=30s',
      routeKnown2KolCostAwareRows.filter((row) => {
        const delay = secondKolDelaySec(row);
        return delay != null && delay <= 30;
      })
    ),
    summarizePaperCohortValidity(
      '2kol_route_known_cost_aware_secondKOL_late',
      routeKnown2KolCostAwareRows.filter((row) => {
        const delay = secondKolDelaySec(row);
        return delay != null && delay > 30;
      })
    ),
  ];
}

function isPrimaryUnderfillCandidateRow(row: JsonRow): boolean {
  return isRotationUnderfillRow(row) && !isCostAwareUnderfillRow(row);
}

function reviewCohortBlockersForRow(row: JsonRow): string[] {
  const blockers: string[] = [];
  if (isUnderfillRouteUnknown(row)) blockers.push('route_unknown_or_missing_proof');
  if (!isCostAwareUnderfillRow(row)) blockers.push('missing_cost_aware_shadow');
  if (!isTwoPlusKolRow(row)) blockers.push(isSingleKolRow(row) ? 'single_kol' : 'unknown_kol_count');
  if (!rowCandidateId(row)) blockers.push('missing_candidate_id');
  if (!rowParticipants(row).some((item) => item.timestampMs != null)) {
    blockers.push('missing_participant_timestamp');
  }
  return blockers.length > 0 ? blockers : ['review_ready'];
}

function diagnoseReviewCohortGeneration(
  underfillRows: JsonRow[],
  routeKnownRows: JsonRow[],
  routeKnownTwoPlusRows: JsonRow[],
  routeKnownCostAwareRows: JsonRow[],
  reviewRows: JsonRow[],
  reviewMissingCandidateIdRows: number,
  reviewMissingParticipantTimestampRows: number
): { diagnosis: string; nextAction: string } {
  if (underfillRows.length === 0) {
    return {
      diagnosis: 'NO_UNDERFILL_ROWS',
      nextAction: 'collect underfill paper closes; keep live routing unchanged',
    };
  }
  if (routeKnownRows.length === 0) {
    return {
      diagnosis: 'BLOCKED_BY_ROUTE_PROOF',
      nextAction: 'record fresh exit-route proof before interpreting underfill edge',
    };
  }
  if (routeKnownTwoPlusRows.length === 0) {
    const singleKolContext = routeKnownCostAwareRows.length > 0
      ? '; do not promote the 1-KOL route-known cost-aware edge'
      : '';
    return {
      diagnosis: 'BLOCKED_BY_2KOL_ABSENCE',
      nextAction: `collect or posthoc-confirm 2+KOL underfill evidence${singleKolContext}`,
    };
  }
  if (reviewRows.length === 0) {
    return {
      diagnosis: 'BLOCKED_BY_COST_AWARE_CLONE',
      nextAction: 'ensure route-known 2+KOL candidates also write the cost-aware shadow close',
    };
  }
  if (reviewMissingCandidateIdRows > 0) {
    return {
      diagnosis: 'BLOCKED_BY_CANDIDATE_ID',
      nextAction: 'persist candidate IDs before live-equivalence review',
    };
  }
  if (reviewMissingParticipantTimestampRows > 0) {
    return {
      diagnosis: 'BLOCKED_BY_KOL_TIMESTAMPS',
      nextAction: 'persist participant timestamps so second-KOL timing can be audited',
    };
  }
  return {
    diagnosis: 'READY_FOR_SAMPLE_REVIEW',
    nextAction: 'evaluate sample, compound, and live-equivalence gates; live remains manual-review only',
  };
}

function buildReviewCohortGenerationAuditStats(rows: JsonRow[]): ReviewCohortGenerationAuditStats {
  const cohort = 'route_known_2kol_cost_aware';
  const underfillRows = rows.filter(isRotationUnderfillRow);
  const routeKnownRows = underfillRows.filter((row) => !isUnderfillRouteUnknown(row));
  const costAwareRows = underfillRows.filter(isCostAwareUnderfillRow);
  const twoPlusKolRows = underfillRows.filter(isTwoPlusKolRow);
  const routeKnownTwoPlusRows = routeKnownRows.filter(isTwoPlusKolRow);
  const routeKnownCostAwareRows = routeKnownRows.filter(isCostAwareUnderfillRow);
  const singleKolRouteKnownCostAwareRows = routeKnownCostAwareRows.filter(isSingleKolRow);
  const reviewRows = selectRouteKnown2KolCostAwareUnderfillRows(rows);
  const reviewMissingCandidateIdRows = reviewRows.filter((row) => !rowCandidateId(row)).length;
  const reviewMissingParticipantTimestampRows = reviewRows.filter((row) =>
    !rowParticipants(row).some((item) => item.timestampMs != null)
  ).length;
  const primaryRouteKnownTwoPlusRows = routeKnownTwoPlusRows.filter(isPrimaryUnderfillCandidateRow);
  const costAwareParentIds = new Set(
    costAwareRows
      .map(rowParentPositionId)
      .filter(Boolean)
  );
  const primaryRouteKnownTwoPlusWithoutCostAwareCloneRows = primaryRouteKnownTwoPlusRows.filter((row) => {
    const positionId = rowPositionId(row);
    return positionId && !costAwareParentIds.has(positionId);
  });
  const blockerReasons = countByLabel(
    underfillRows.flatMap((row) => {
      const reasons = reviewCohortBlockersForRow(row);
      const positionId = rowPositionId(row);
      if (
        positionId &&
        isPrimaryUnderfillCandidateRow(row) &&
        !isUnderfillRouteUnknown(row) &&
        isTwoPlusKolRow(row) &&
        !costAwareParentIds.has(positionId)
      ) {
        reasons.push('cost_aware_clone_not_recorded');
      }
      return reasons;
    }),
    'reason'
  ) as Array<{ reason: string; count: number }>;
  const { diagnosis, nextAction } = diagnoseReviewCohortGeneration(
    underfillRows,
    routeKnownRows,
    routeKnownTwoPlusRows,
    routeKnownCostAwareRows,
    reviewRows,
    reviewMissingCandidateIdRows,
    reviewMissingParticipantTimestampRows
  );
  return {
    cohort,
    diagnosis,
    nextAction,
    underfillRows: underfillRows.length,
    routeKnownRows: routeKnownRows.length,
    costAwareRows: costAwareRows.length,
    twoPlusKolRows: twoPlusKolRows.length,
    routeKnownTwoPlusRows: routeKnownTwoPlusRows.length,
    routeKnownCostAwareRows: routeKnownCostAwareRows.length,
    singleKolRouteKnownCostAwareRows: singleKolRouteKnownCostAwareRows.length,
    reviewRows: reviewRows.length,
    missingRouteProofRows: underfillRows.length - routeKnownRows.length,
    missingCandidateIdRows: underfillRows.filter((row) => !rowCandidateId(row)).length,
    missingParticipantTimestampRows: underfillRows.filter((row) =>
      !rowParticipants(row).some((item) => item.timestampMs != null)
    ).length,
    reviewMissingCandidateIdRows,
    reviewMissingParticipantTimestampRows,
    primaryRouteKnownTwoPlusRows: primaryRouteKnownTwoPlusRows.length,
    primaryRouteKnownTwoPlusWithoutCostAwareCloneRows: primaryRouteKnownTwoPlusWithoutCostAwareCloneRows.length,
    blockerReasons,
  };
}

function rowRotationAnchorTimeMs(row: JsonRow): number {
  const participants = rowParticipants(row)
    .map((item) => item.timestampMs)
    .filter((value): value is number => value != null && Number.isFinite(value));
  if (participants.length > 0) return Math.min(...participants);
  const directMs = rowNumWithExtras(row, ['rotationFirstBuyAtMs', 'rotationLastBuyAtMs', 'rotationEntryAtMs']);
  if (directMs != null) return directMs < 1e12 ? directMs * 1000 : directMs;
  const candidates = [
    timeMs(row.openedAt),
    timeMs(row.entryTimeSec),
    rowCloseTimeMs(row),
  ];
  return candidates.find((value) => Number.isFinite(value)) ?? NaN;
}

function secondKolCandidatesForRow(row: JsonRow, buysByToken: Map<string, JsonRow[]>): Array<{ kol: string; delaySec: number }> {
  const tokenMint = rowTokenMintDeep(row);
  const anchorMs = rowRotationAnchorTimeMs(row);
  if (!tokenMint || !Number.isFinite(anchorMs)) return [];
  const anchorKols = new Set(rowParticipants(row).map((item) => item.id).filter(Boolean));
  const byKol = new Map<string, number>();
  for (const tx of buysByToken.get(tokenMint) ?? []) {
    const kol = rowKolId(tx);
    if (!kol || kol === '(unknown)' || anchorKols.has(kol)) continue;
    const txMs = rowKolTxTimeMs(tx);
    if (!Number.isFinite(txMs)) continue;
    const delaySec = (txMs - anchorMs) / 1000;
    if (delaySec < 0 || delaySec > 180) continue;
    byKol.set(kol, Math.min(byKol.get(kol) ?? Infinity, delaySec));
  }
  return [...byKol.entries()]
    .map(([kol, delaySec]) => ({ kol, delaySec }))
    .sort((a, b) => a.delaySec - b.delaySec || a.kol.localeCompare(b.kol));
}

function summarizeSecondKolOpportunityToken(input: {
  tokenMint: string;
  rows: JsonRow[];
  buysByToken: Map<string, JsonRow[]>;
}): RotationSecondKolOpportunityTokenStats {
  const candidatesByRow = input.rows.map((row) => secondKolCandidatesForRow(row, input.buysByToken));
  const delays = candidatesByRow.flatMap((items) => items.map((item) => item.delaySec));
  const secondKolWithin30Rows = candidatesByRow.filter((items) => items.some((item) => item.delaySec <= 30)).length;
  const routeKnownCostAwareRows = input.rows.filter(isRouteKnownCostAwareUnderfillRow);
  const routeKnownCostAwareSecondWithin30Rows = routeKnownCostAwareRows.filter((row) =>
    secondKolCandidatesForRow(row, input.buysByToken).some((item) => item.delaySec <= 30)
  ).length;
  return {
    tokenMint: input.tokenMint,
    shortMint: shortTokenMint(input.tokenMint),
    rows: input.rows.length,
    secondKolRows: candidatesByRow.filter((items) => items.length > 0).length,
    secondKolWithin30Rows,
    routeKnownCostAwareRows: routeKnownCostAwareRows.length,
    routeKnownCostAwareSecondWithin30Rows,
    medianSecondKolDelaySec: percentile(delays, 0.5),
    topSecondKols: countByLabel(candidatesByRow.flatMap((items) => items.map((item) => item.kol)), 'kol').slice(0, 5) as Array<{ kol: string; count: number }>,
  };
}

function buildRotationSecondKolOpportunityFunnelStats(input: {
  rotationPaperRows: JsonRow[];
  kolTxRows: JsonRow[];
  routeProofFreshSinceMs?: number;
  currentSessionStartedAtMs?: number;
}): RotationSecondKolOpportunityFunnelStats {
  const underfillRows = input.rotationPaperRows.filter(isRotationUnderfillRow);
  const singleKolRows = underfillRows.filter(isSingleKolRow);
  const freshCutoff = routeProofFreshCutoff(underfillRows, input.routeProofFreshSinceMs, input.currentSessionStartedAtMs);
  const freshUnderfillRows = freshCutoff.cutoffMs == null
    ? underfillRows
    : underfillRows.filter((row) => {
      const closeMs = rowCloseTimeMs(row);
      return Number.isFinite(closeMs) && closeMs >= (freshCutoff.cutoffMs ?? 0);
    });
  const freshSingleKolRows = freshUnderfillRows.filter(isSingleKolRow);
  const buysByToken = new Map<string, JsonRow[]>();
  for (const row of input.kolTxRows) {
    if (rowKolTxActionNormalized(row) !== 'buy') continue;
    const tokenMint = rowTokenMint(row);
    if (!tokenMint) continue;
    buysByToken.set(tokenMint, [...(buysByToken.get(tokenMint) ?? []), row]);
  }
  const candidatesByRow = singleKolRows.map((row) => ({
    row,
    tokenMint: rowTokenMintDeep(row),
    anchorMs: rowRotationAnchorTimeMs(row),
    candidates: secondKolCandidatesForRow(row, buysByToken),
  }));
  const freshCandidatesByRow = freshSingleKolRows.map((row) => ({
    row,
    tokenMint: rowTokenMintDeep(row),
    anchorMs: rowRotationAnchorTimeMs(row),
    candidates: secondKolCandidatesForRow(row, buysByToken),
  }));
  const routeKnownCostAwareSingleRows = singleKolRows.filter(isRouteKnownCostAwareUnderfillRow);
  const freshRouteKnownCostAwareSingleRows = freshSingleKolRows.filter(isRouteKnownCostAwareUnderfillRow);
  const routeKnownCostAwareSecondWithin30Rows = routeKnownCostAwareSingleRows.filter((row) =>
    secondKolCandidatesForRow(row, buysByToken).some((item) => item.delaySec <= 30)
  ).length;
  const freshRouteKnownCostAwareSecondWithin30Rows = freshRouteKnownCostAwareSingleRows.filter((row) =>
    secondKolCandidatesForRow(row, buysByToken).some((item) => item.delaySec <= 30)
  ).length;
  const secondKolSeenRows = candidatesByRow.filter((item) => item.candidates.length > 0).length;
  const secondKolWithin15Rows = candidatesByRow.filter((item) => item.candidates.some((candidate) => candidate.delaySec <= 15)).length;
  const secondKolWithin30Rows = candidatesByRow.filter((item) => item.candidates.some((candidate) => candidate.delaySec <= 30)).length;
  const secondKolWithin60Rows = candidatesByRow.filter((item) => item.candidates.some((candidate) => candidate.delaySec <= 60)).length;
  const secondKolLate180Rows = candidatesByRow.filter((item) =>
    item.candidates.some((candidate) => candidate.delaySec > 30 && candidate.delaySec <= 180)
  ).length;
  const trueSingleRows = candidatesByRow.filter((item) =>
    item.tokenMint &&
    Number.isFinite(item.anchorMs) &&
    (buysByToken.get(item.tokenMint) ?? []).length > 0 &&
    item.candidates.length === 0
  ).length;
  const freshRowsWithToken = freshCandidatesByRow.filter((item) => item.tokenMint).length;
  const freshRowsWithEntryTime = freshCandidatesByRow.filter((item) => Number.isFinite(item.anchorMs)).length;
  const freshRowsWithTxCoverage = freshCandidatesByRow.filter((item) =>
    item.tokenMint && (buysByToken.get(item.tokenMint) ?? []).length > 0
  ).length;
  const freshSecondKolSeenRows = freshCandidatesByRow.filter((item) => item.candidates.length > 0).length;
  const freshSecondKolWithin30Rows = freshCandidatesByRow.filter((item) =>
    item.candidates.some((candidate) => candidate.delaySec <= 30)
  ).length;
  const byToken = new Map<string, JsonRow[]>();
  for (const row of singleKolRows) {
    const tokenMint = rowTokenMintDeep(row);
    if (!tokenMint) continue;
    byToken.set(tokenMint, [...(byToken.get(tokenMint) ?? []), row]);
  }
  const topTokens = [...byToken.entries()]
    .map(([tokenMint, rows]) => summarizeSecondKolOpportunityToken({ tokenMint, rows, buysByToken }))
    .sort((a, b) =>
      b.routeKnownCostAwareSecondWithin30Rows - a.routeKnownCostAwareSecondWithin30Rows ||
      b.secondKolWithin30Rows - a.secondKolWithin30Rows ||
      b.rows - a.rows ||
      a.tokenMint.localeCompare(b.tokenMint)
    )
    .slice(0, 10);

  const reasons: string[] = [];
  let verdict: RotationSecondKolOpportunityVerdict = 'COLLECT';
  if (underfillRows.length === 0) {
    verdict = 'NO_UNDERFILL_ROWS';
    reasons.push('no underfill paper rows in report window');
  } else if (singleKolRows.length === 0) {
    verdict = 'NO_SINGLE_KOL_ROWS';
    reasons.push('underfill rows are not blocked by single-KOL classification');
  } else if (candidatesByRow.filter((item) => item.tokenMint && (buysByToken.get(item.tokenMint) ?? []).length > 0).length === 0) {
    verdict = 'NO_TX_COVERAGE';
    reasons.push('single-KOL rows have no same-token KOL tx coverage to verify a second KOL');
  } else if (routeKnownCostAwareSecondWithin30Rows > 0) {
    verdict = 'SECOND_KOL_LINKAGE_GAP';
    reasons.push('route-known cost-aware single-KOL rows have a second KOL in KOL tx ledger within 30s');
  } else if (trueSingleRows / singleKolRows.length >= 0.8) {
    verdict = 'TRUE_SINGLE_KOL_DOMINANT';
    reasons.push('same-token KOL tx ledger confirms most single-KOL rows stayed single through 180s');
  } else {
    reasons.push('second-KOL opportunity evidence is mixed or still collecting');
  }

  return {
    verdict,
    reasons,
    underfillRows: underfillRows.length,
    singleKolRows: singleKolRows.length,
    rowsWithToken: candidatesByRow.filter((item) => item.tokenMint).length,
    rowsWithEntryTime: candidatesByRow.filter((item) => Number.isFinite(item.anchorMs)).length,
    rowsWithTxCoverage: candidatesByRow.filter((item) => item.tokenMint && (buysByToken.get(item.tokenMint) ?? []).length > 0).length,
    routeKnownCostAwareSingleRows: routeKnownCostAwareSingleRows.length,
    secondKolSeenRows,
    secondKolWithin15Rows,
    secondKolWithin30Rows,
    secondKolWithin60Rows,
    secondKolLate180Rows,
    routeKnownCostAwareSecondWithin30Rows,
    potentialReviewRows: routeKnownCostAwareSecondWithin30Rows,
    trueSingleRows,
    freshCutoffSource: freshCutoff.cutoffSource,
    freshSince: freshCutoff.cutoffMs == null ? null : new Date(freshCutoff.cutoffMs).toISOString(),
    freshUnderfillRows: freshUnderfillRows.length,
    freshSingleKolRows: freshSingleKolRows.length,
    freshRowsWithToken,
    freshRowsWithEntryTime,
    freshRowsWithTxCoverage,
    freshRouteKnownCostAwareSingleRows: freshRouteKnownCostAwareSingleRows.length,
    freshSecondKolSeenRows,
    freshSecondKolWithin30Rows,
    freshRouteKnownCostAwareSecondWithin30Rows,
    freshNextSprint: rotationSecondKolOpportunityFreshNextSprint({
      freshUnderfillRows: freshUnderfillRows.length,
      freshSingleKolRows: freshSingleKolRows.length,
      freshRowsWithToken,
      freshRowsWithEntryTime,
      freshRowsWithTxCoverage,
      freshSecondKolWithin30Rows,
      freshRouteKnownCostAwareSecondWithin30Rows,
    }),
    topSecondKols: countByLabel(candidatesByRow.flatMap((item) => item.candidates.map((candidate) => candidate.kol)), 'kol').slice(0, 8) as Array<{ kol: string; count: number }>,
    topTokens,
  };
}

function rotationSecondKolOpportunityFreshNextSprint(input: {
  freshUnderfillRows: number;
  freshSingleKolRows: number;
  freshRowsWithToken: number;
  freshRowsWithEntryTime: number;
  freshRowsWithTxCoverage: number;
  freshSecondKolWithin30Rows: number;
  freshRouteKnownCostAwareSecondWithin30Rows: number;
}): string {
  if (input.freshUnderfillRows === 0) return 'collect_fresh_underfill_closes';
  if (input.freshSingleKolRows === 0) return 'collect_fresh_single_kol_underfill';
  if (input.freshRowsWithToken < input.freshSingleKolRows || input.freshRowsWithEntryTime < input.freshSingleKolRows) {
    return 'repair_fresh_single_kol_metadata';
  }
  if (input.freshRowsWithTxCoverage === 0) return 'repair_fresh_kol_tx_coverage';
  if (input.freshSecondKolWithin30Rows === 0) return 'collect_fresh_2nd_kol_30_rows';
  if (input.freshRouteKnownCostAwareSecondWithin30Rows === 0) return 'record_fresh_2nd_kol_route_and_cost_aware_evidence';
  return 'review_fresh_2nd_kol_candidates';
}

function secondKolWithin30Rows(input: {
  rotationPaperRows: JsonRow[];
  kolTxRows: JsonRow[];
}): Array<{ row: JsonRow; candidates: Array<{ kol: string; delaySec: number }> }> {
  const buysByToken = new Map<string, JsonRow[]>();
  for (const tx of input.kolTxRows) {
    if (rowKolTxActionNormalized(tx) !== 'buy') continue;
    const tokenMint = rowTokenMint(tx);
    if (!tokenMint) continue;
    buysByToken.set(tokenMint, [...(buysByToken.get(tokenMint) ?? []), tx]);
  }
  return input.rotationPaperRows
    .filter((row) => isRotationUnderfillRow(row) && isSingleKolRow(row))
    .map((row) => ({
      row,
      candidates: secondKolCandidatesForRow(row, buysByToken).filter((candidate) => candidate.delaySec <= 30),
    }))
    .filter((item) => item.candidates.length > 0);
}

function summarizeSecondKolPromotionGapToken(input: {
  tokenMint: string;
  rows: Array<{ row: JsonRow; candidates: Array<{ kol: string; delaySec: number }> }>;
}): RotationSecondKolPromotionGapTokenStats {
  const paperRows = input.rows.map((item) => item.row);
  const delays = input.rows.flatMap((item) => item.candidates.map((candidate) => candidate.delaySec));
  return {
    tokenMint: input.tokenMint,
    shortMint: shortTokenMint(input.tokenMint),
    rows: paperRows.length,
    routeProofRows: paperRows.filter((row) => !isUnderfillRouteUnknown(row)).length,
    costAwareRows: paperRows.filter(isCostAwareUnderfillRow).length,
    routeKnownCostAwareRows: paperRows.filter(isRouteKnownCostAwareUnderfillRow).length,
    medianSecondKolDelaySec: percentile(delays, 0.5),
    topRouteUnknownReasons: countByLabel(paperRows.flatMap(routeUnknownReasonsForRow), 'reason').slice(0, 5) as Array<{ reason: string; count: number }>,
  };
}

function routeProofRecoveryNextSprint(hint: RouteProofRecoveryHint): string {
  if (hint === 'collect_sample') return 'collect_2nd_kol_30_rows';
  if (hint === 'route_proof_ready') return 'check_cost_aware_and_review_metadata';
  if (hint === 'review_true_no_route_before_live') return 'drill_down_true_no_sell_route';
  if (hint === 'record_exit_quote_and_security_evidence') return 'record_exit_quote_and_security_evidence';
  if (hint === 'record_exit_quote_evidence') return 'record_exit_quote_evidence';
  if (hint === 'record_security_client_evidence') return 'record_security_client_evidence';
  if (hint === 'record_positive_route_probe') return 'record_positive_route_probe';
  return 'collect_more_rows';
}

function routeProofFreshSecondKolNextSprint(input: {
  rows: number;
  freshRows: number;
  freshRouteProofRows: number;
  freshCostAwareRows: number;
  freshRouteKnownCostAwareRows: number;
  freshExitQuoteEvidenceRows: number;
}): string {
  if (input.rows === 0) return 'collect_2nd_kol_30_rows';
  if (input.freshRows === 0) return 'collect_fresh_2nd_kol_30_rows';
  if (input.freshRouteKnownCostAwareRows > 0) return 'review_fresh_2nd_kol_candidates';
  if (input.freshRouteProofRows === 0) {
    return input.freshExitQuoteEvidenceRows === 0
      ? 'record_exit_quote_evidence'
      : 'review_exit_quote_rejections_or_errors';
  }
  if (input.freshCostAwareRows === 0) return 'write_cost_aware_shadow_for_fresh_2nd_kol';
  return 'recover_cost_aware_route_proof';
}

function summarizeRouteProofRecovery(rows: JsonRow[]): RouteProofRecoverySummary {
  let structuralBlockRows = 0;
  let dataGapRows = 0;
  let infraRetryRows = 0;
  let unknownRows = 0;
  let explicitNoSellRouteRows = 0;
  let exitLiquidityUnknownRows = 0;
  let securityDataGapRows = 0;
  let mixedExitLiquidityAndDataGapRows = 0;
  let missingPositiveEvidenceRows = 0;

  for (const row of rows) {
    const truth = routeTruthBucket(row);
    if (truth.recoverability === 'structural_block') structuralBlockRows += 1;
    else if (truth.recoverability === 'data_gap') dataGapRows += 1;
    else if (truth.recoverability === 'infra_retry') infraRetryRows += 1;
    else if (truth.recoverability === 'unknown') unknownRows += 1;

    const labels = routeUnknownReasonsForRow(row);
    const hasExplicitNoSellRoute = labels.some((label) =>
      label === 'NO_SELL_ROUTE' ||
      label === 'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN'
    );
    const hasExitLiquidityUnknown = labels.some((label) => label === 'EXIT_LIQUIDITY_UNKNOWN');
    const hasSecurityDataGap = labels.some((label) =>
      label === 'TOKEN_QUALITY_UNKNOWN' ||
      label === 'NO_SECURITY_DATA' ||
      label === 'NO_SECURITY_CLIENT' ||
      label === 'SECURITY_CLIENT'
    );
    const hasMissingPositiveEvidence = labels.some((label) => label === 'MISSING_POSITIVE_ROUTE_EVIDENCE');

    if (hasExplicitNoSellRoute) explicitNoSellRouteRows += 1;
    if (hasExitLiquidityUnknown) exitLiquidityUnknownRows += 1;
    if (hasSecurityDataGap) securityDataGapRows += 1;
    if (hasExitLiquidityUnknown && hasSecurityDataGap) mixedExitLiquidityAndDataGapRows += 1;
    if (hasMissingPositiveEvidence) missingPositiveEvidenceRows += 1;
  }

  const routeKnownRows = rows.filter((row) => !isUnderfillRouteUnknown(row)).length;
  const routeProofRows = rows.filter((row) => routeTruthEvidenceSources(row).length > 0).length;
  let recoveryHint: RouteProofRecoveryHint = 'collect_more_rows';
  if (rows.length === 0) {
    recoveryHint = 'collect_sample';
  } else if (routeKnownRows === rows.length) {
    recoveryHint = 'route_proof_ready';
  } else if (mixedExitLiquidityAndDataGapRows / rows.length >= 0.5) {
    recoveryHint = 'record_exit_quote_and_security_evidence';
  } else if (exitLiquidityUnknownRows > 0) {
    recoveryHint = 'record_exit_quote_evidence';
  } else if (securityDataGapRows > 0) {
    recoveryHint = 'record_security_client_evidence';
  } else if (explicitNoSellRouteRows > 0) {
    recoveryHint = 'review_true_no_route_before_live';
  } else if (missingPositiveEvidenceRows > 0) {
    recoveryHint = 'record_positive_route_probe';
  }

  return {
    routeKnownRows,
    routeProofRows,
    structuralBlockRows,
    dataGapRows,
    infraRetryRows,
    unknownRows,
    explicitNoSellRouteRows,
    exitLiquidityUnknownRows,
    securityDataGapRows,
    mixedExitLiquidityAndDataGapRows,
    missingPositiveEvidenceRows,
    recoveryHint,
    nextSprint: routeProofRecoveryNextSprint(recoveryHint),
  };
}

function buildRotationSecondKolPromotionGapStats(input: {
  rotationPaperRows: JsonRow[];
  kolTxRows: JsonRow[];
  assumedNetworkFeeSol: number;
  routeProofFreshSinceMs?: number;
  currentSessionStartedAtMs?: number;
}): RotationSecondKolPromotionGapStats {
  const rowsWithCandidates = secondKolWithin30Rows(input);
  const rows = rowsWithCandidates.map((item) => item.row);
  const recovery = summarizeRouteProofRecovery(rows);
  const freshCutoff = routeProofFreshCutoff(
    input.rotationPaperRows.filter(isRotationUnderfillRow),
    input.routeProofFreshSinceMs,
    input.currentSessionStartedAtMs
  );
  const freshRows = freshCutoff.cutoffMs == null
    ? rows
    : rows.filter((row) => {
      const closeMs = rowCloseTimeMs(row);
      return Number.isFinite(closeMs) && closeMs >= (freshCutoff.cutoffMs ?? 0);
    });
  const routeProofRows = rows.filter((row) => !isUnderfillRouteUnknown(row));
  const routeKnownCostAwareRows = rows.filter(isRouteKnownCostAwareUnderfillRow);
  const costAwareRows = rows.filter(isCostAwareUnderfillRow);
  const routeKnownMissingCostAwareRows = routeProofRows.filter((row) => !isCostAwareUnderfillRow(row));
  const costAwareRouteUnknownRows = costAwareRows.filter(isUnderfillRouteUnknown);
  const freshRouteProofRows = freshRows.filter((row) => !isUnderfillRouteUnknown(row));
  const freshCostAwareRows = freshRows.filter(isCostAwareUnderfillRow);
  const freshRouteKnownCostAwareRows = freshRows.filter(isRouteKnownCostAwareUnderfillRow);
  const freshExitQuoteEvidenceRows = freshRows.filter(hasExitSellQuoteEvidence);
  const mfeValues = rows.map(rowMfePct).filter((value): value is number => value != null);
  const tokenOnlyValues = rows.map((row) => num(row.netSolTokenOnly) ?? numberOrZero(row.netSol));
  const byToken = new Map<string, Array<{ row: JsonRow; candidates: Array<{ kol: string; delaySec: number }> }>>();
  for (const item of rowsWithCandidates) {
    const tokenMint = rowTokenMintDeep(item.row);
    if (!tokenMint) continue;
    byToken.set(tokenMint, [...(byToken.get(tokenMint) ?? []), item]);
  }
  const topTokens = [...byToken.entries()]
    .map(([tokenMint, scoped]) => summarizeSecondKolPromotionGapToken({ tokenMint, rows: scoped }))
    .sort((a, b) =>
      b.routeKnownCostAwareRows - a.routeKnownCostAwareRows ||
      b.routeProofRows - a.routeProofRows ||
      b.costAwareRows - a.costAwareRows ||
      b.rows - a.rows ||
      a.tokenMint.localeCompare(b.tokenMint)
    )
    .slice(0, 10);

  const reasons: string[] = [];
  let verdict: RotationSecondKolPromotionGapVerdict = 'COLLECT';
  if (rows.length === 0) {
    verdict = 'NO_SECOND_KOL_30';
    reasons.push('no single-KOL underfill rows had a second KOL buy within 30s');
  } else if (routeKnownCostAwareRows.length > 0) {
    verdict = 'REVIEW_CANDIDATES_EXIST';
    reasons.push('second-KOL <=30s rows include route-known cost-aware review candidates');
  } else if (routeProofRows.length === 0 && costAwareRows.length === 0) {
    verdict = 'BLOCKED_BY_ROUTE_PROOF_AND_COST_AWARE';
    reasons.push('second-KOL <=30s rows have neither route proof nor cost-aware shadow closes');
  } else if (routeProofRows.length === 0) {
    verdict = 'BLOCKED_BY_ROUTE_PROOF';
    reasons.push('second-KOL <=30s rows have cost-aware shadows but no route proof');
  } else if (routeKnownMissingCostAwareRows.length > 0 || costAwareRows.length === 0) {
    verdict = 'BLOCKED_BY_COST_AWARE';
    reasons.push('second-KOL <=30s route-known rows did not write cost-aware shadow closes');
  } else {
    reasons.push('second-KOL <=30s promotion blockers are mixed; keep collecting');
  }

  return {
    verdict,
    reasons,
    rows: rows.length,
    routeProofRows: routeProofRows.length,
    routeUnknownRows: rows.length - routeProofRows.length,
    costAwareRows: costAwareRows.length,
    routeKnownCostAwareRows: routeKnownCostAwareRows.length,
    routeKnownMissingCostAwareRows: routeKnownMissingCostAwareRows.length,
    costAwareRouteUnknownRows: costAwareRouteUnknownRows.length,
    candidateIdRows: rows.filter((row) => rowCandidateId(row)).length,
    participantTimestampRows: rows.filter((row) => rowParticipants(row).some((item) => item.timestampMs != null)).length,
    structuralBlockRows: recovery.structuralBlockRows,
    dataGapRows: recovery.dataGapRows,
    infraRetryRows: recovery.infraRetryRows,
    unknownRows: recovery.unknownRows,
    explicitNoSellRouteRows: recovery.explicitNoSellRouteRows,
    exitLiquidityUnknownRows: recovery.exitLiquidityUnknownRows,
    securityDataGapRows: recovery.securityDataGapRows,
    mixedExitLiquidityAndDataGapRows: recovery.mixedExitLiquidityAndDataGapRows,
    missingPositiveEvidenceRows: recovery.missingPositiveEvidenceRows,
    recoveryHint: recovery.recoveryHint,
    nextSprint: recovery.nextSprint,
    freshCutoffSource: freshCutoff.cutoffSource,
    freshSince: freshCutoff.cutoffMs == null ? null : new Date(freshCutoff.cutoffMs).toISOString(),
    freshRows: freshRows.length,
    staleRows: rows.length - freshRows.length,
    freshRouteProofRows: freshRouteProofRows.length,
    freshRouteUnknownRows: freshRows.length - freshRouteProofRows.length,
    freshCostAwareRows: freshCostAwareRows.length,
    freshRouteKnownCostAwareRows: freshRouteKnownCostAwareRows.length,
    freshExitQuoteEvidenceRows: freshExitQuoteEvidenceRows.length,
    freshNextSprint: routeProofFreshSecondKolNextSprint({
      rows: rows.length,
      freshRows: freshRows.length,
      freshRouteProofRows: freshRouteProofRows.length,
      freshCostAwareRows: freshCostAwareRows.length,
      freshRouteKnownCostAwareRows: freshRouteKnownCostAwareRows.length,
      freshExitQuoteEvidenceRows: freshExitQuoteEvidenceRows.length,
    }),
    medianSecondKolDelaySec: percentile(rowsWithCandidates.flatMap((item) => item.candidates.map((candidate) => candidate.delaySec)), 0.5),
    medianMfePct: percentile(mfeValues, 0.5),
    refundAdjustedNetSol: tokenOnlyValues.length > 0
      ? tokenOnlyValues.reduce((sum, value) => sum + value, 0) - rows.length * input.assumedNetworkFeeSol
      : null,
    topRouteUnknownReasons: countByLabel(rows.flatMap(routeUnknownReasonsForRow), 'reason').slice(0, 8) as Array<{ reason: string; count: number }>,
    topMissingCostAwareArms: countByLabel(routeKnownMissingCostAwareRows.map(rowArmName), 'arm').slice(0, 8) as Array<{ arm: string; count: number }>,
    topExitReasons: buildTopExitReasons(rows),
    topTokens,
  };
}

function maxLosingStreak(values: number[]): number {
  let current = 0;
  let max = 0;
  for (const value of values) {
    if (value <= 0) {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

function buildCompoundProfile(
  cohort: string,
  rows: JsonRow[],
  assumedAtaRentSol: number,
  assumedNetworkFeeSol: number
): RotationCompoundProfile {
  const walletDragSol = assumedAtaRentSol + assumedNetworkFeeSol;
  const ordered = [...rows].sort((a, b) =>
    (timeMs(a.closedAt) || timeMs(a.exitTimeSec) || 0) -
    (timeMs(b.closedAt) || timeMs(b.exitTimeSec) || 0)
  );
  const refundAdjustedValues = ordered.map((row) =>
    (num(row.netSolTokenOnly) ?? numberOrZero(row.netSol)) - assumedNetworkFeeSol
  );
  const walletDragValues = ordered.map((row) =>
    (num(row.netSolTokenOnly) ?? numberOrZero(row.netSol)) - walletDragSol
  );
  const winnerRows = ordered.filter((row) => str(row.exitReason) === 'winner_trailing_t1');
  const nonWinnerRows = ordered.filter((row) => str(row.exitReason) !== 'winner_trailing_t1');
  const refundAdjustedFor = (scoped: JsonRow[]) => scoped
    .map((row) => (num(row.netSolTokenOnly) ?? numberOrZero(row.netSol)) - assumedNetworkFeeSol)
    .reduce((sum, value) => sum + value, 0);
  const mfeValues = ordered.map(rowMfePct).filter((value): value is number => value != null);
  const holdSecValues = ordered.map((row) => num(row.holdSec)).filter((value): value is number => value != null);
  return {
    cohort,
    rows: ordered.length,
    refundAdjustedNetSol: refundAdjustedValues.reduce((sum, value) => sum + value, 0),
    walletDragStressSol: walletDragValues.reduce((sum, value) => sum + value, 0),
    postCostPositiveRate: ratio(refundAdjustedValues.filter((value) => value > 0).length, ordered.length),
    t1Rate: ratio(ordered.filter(rowHasT1).length, ordered.length),
    maxLosingStreak: maxLosingStreak(refundAdjustedValues),
    winnerRows: winnerRows.length,
    winnerRefundAdjustedNetSol: refundAdjustedFor(winnerRows),
    nonWinnerRows: nonWinnerRows.length,
    nonWinnerRefundAdjustedNetSol: refundAdjustedFor(nonWinnerRows),
    medianHoldSec: percentile(holdSecValues, 0.5),
    medianMfePct: percentile(mfeValues, 0.5),
  };
}

function buildCompoundProfiles(
  rows: JsonRow[],
  assumedAtaRentSol: number,
  assumedNetworkFeeSol: number
): RotationCompoundProfile[] {
  const underfillRows = rows.filter(isRotationUnderfillRow);
  const routeKnown2KolCostAwareRows = selectRouteKnown2KolCostAwareUnderfillRows(rows);
  return [
    buildCompoundProfile('underfill_all', underfillRows, assumedAtaRentSol, assumedNetworkFeeSol),
    buildCompoundProfile('underfill_cost_aware_all', underfillRows.filter(isCostAwareUnderfillRow), assumedAtaRentSol, assumedNetworkFeeSol),
    buildCompoundProfile('underfill_2plus_kol', underfillRows.filter(isTwoPlusKolRow), assumedAtaRentSol, assumedNetworkFeeSol),
    buildCompoundProfile('route_known_2kol_cost_aware', routeKnown2KolCostAwareRows, assumedAtaRentSol, assumedNetworkFeeSol),
  ];
}

function buildLiveEquivalenceDrilldownStats(
  liveEquivalenceRows: JsonRow[],
  paperRows: JsonRow[],
  assumedNetworkFeeSol: number,
  reviewCandidateIds: Set<string> = new Set()
): LiveEquivalenceDrilldownStats[] {
  const paperByCandidate = new Map<string, JsonRow[]>();
  for (const row of paperRows) {
    const candidateId = rowCandidateId(row);
    if (!candidateId) continue;
    paperByCandidate.set(candidateId, [...(paperByCandidate.get(candidateId) ?? []), row]);
  }
  const buckets = new Map<string, JsonRow[]>();
  for (const row of liveEquivalenceRows.filter(isRotationLiveEquivalenceRow)) {
    const reason = rowLiveWouldEnter(row) ? 'live_allowed' : rowLiveBlockReason(row);
    const bucket = `${rowDecisionStage(row)}:${reason || '(none)'}`;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), row]);
  }
  return [...buckets.entries()]
    .map(([bucket, scoped]) => {
      const uniqueRows = (rows: JsonRow[]) => {
        const seen = new Set<string>();
        return rows.filter((row) => {
          const key = rowPaperDedupeKey(row);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };
      const linkedPaper = uniqueRows(scoped.flatMap((row) => paperByCandidate.get(rowCandidateId(row)) ?? []));
      const refundAdjustedValues = linkedPaper.map((row) =>
        (num(row.netSolTokenOnly) ?? numberOrZero(row.netSol)) - assumedNetworkFeeSol
      );
      const blockedPaper = uniqueRows(scoped.filter((row) => !rowLiveWouldEnter(row)).flatMap((row) =>
        paperByCandidate.get(rowCandidateId(row)) ?? []
      ));
      const candidateRows = scoped.filter((row) => rowCandidateId(row));
      const unlinkedRows = candidateRows.filter((row) =>
        (paperByCandidate.get(rowCandidateId(row)) ?? []).length === 0
      );
      return {
        bucket,
        rows: scoped.length,
        candidateIdRows: candidateRows.length,
        missingCandidateIdRows: scoped.length - candidateRows.length,
        unlinkedRows: unlinkedRows.length,
        reviewCohortLinkedRows: candidateRows.filter((row) => reviewCandidateIds.has(rowCandidateId(row))).length,
        liveWouldEnterRows: scoped.filter(rowLiveWouldEnter).length,
        blockedRows: scoped.filter((row) => !rowLiveWouldEnter(row)).length,
        paperCloses: linkedPaper.length,
        paperWins: refundAdjustedValues.filter((value) => value > 0).length,
        paperRefundAdjustedNetSol: refundAdjustedValues.reduce((sum, value) => sum + value, 0),
        blockedPaperWinnerRows: blockedPaper.filter((row) =>
          (num(row.netSolTokenOnly) ?? numberOrZero(row.netSol)) - assumedNetworkFeeSol > 0
        ).length,
        medianPaperMfePct: percentile(linkedPaper.map(rowMfePct).filter((item): item is number => item != null), 0.5),
      };
    })
    .sort((a, b) => b.rows - a.rows || b.blockedPaperWinnerRows - a.blockedPaperWinnerRows || a.bucket.localeCompare(b.bucket));
}

function buildReviewCohortEvidenceStats(
  reviewRows: JsonRow[],
  liveEquivalenceRows: JsonRow[],
  markoutRows: JsonRow[],
  horizonsSec: number[],
  roundTripCostPct: number,
  assumedNetworkFeeSol: number
): ReviewCohortEvidenceStats {
  const cohort = 'route_known_2kol_cost_aware';
  const reviewCandidateIds = new Set(reviewRows.map(rowCandidateId).filter(Boolean));
  const reviewLiveEquivalenceRows = liveEquivalenceRows.filter((row) =>
    isMicroLiveReviewEquivalenceRow(row, reviewCandidateIds)
  );
  const linkedLiveRows = reviewLiveEquivalenceRows.filter((row) => {
    const candidateId = rowCandidateId(row);
    return candidateId && reviewCandidateIds.has(candidateId);
  });
  const candidateIdLiveRows = reviewLiveEquivalenceRows.filter((row) => rowCandidateId(row));
  const refundAdjustedValues = reviewRows.map((row) =>
    (num(row.netSolTokenOnly) ?? numberOrZero(row.netSol)) - assumedNetworkFeeSol
  );
  const coverageRows = buildRotationReadinessHorizonCoverage(reviewRows, markoutRows, horizonsSec, roundTripCostPct);
  const primaryPostCostRows = EVIDENCE_PRIMARY_HORIZONS_SEC
    .filter((horizonSec) => horizonsSec.includes(horizonSec))
    .map((horizonSec) => ({
      horizonSec,
      medianPostCostDeltaPct: coverageRows.find((row) => row.horizonSec === horizonSec)?.medianPostCostDeltaPct ?? null,
    }));
  return {
    cohort,
    closes: reviewRows.length,
    candidateIdRows: reviewRows.filter((row) => rowCandidateId(row)).length,
    liveEquivalenceRows: reviewLiveEquivalenceRows.length,
    linkedLiveEquivalenceRows: linkedLiveRows.length,
    missingCandidateIdLiveRows: reviewLiveEquivalenceRows.length - candidateIdLiveRows.length,
    unlinkedLiveEquivalenceRows: candidateIdLiveRows.length - linkedLiveRows.length,
    routeProofRows: reviewRows.filter((row) => routeTruthEvidenceSources(row).length > 0).length,
    timestampedSecondKolRows: reviewRows.filter((row) => secondKolDelaySec(row) != null).length,
    refundAdjustedNetSol: reviewRows.length > 0 ? refundAdjustedValues.reduce((sum, value) => sum + value, 0) : null,
    postCostPositiveRate: ratio(refundAdjustedValues.filter((value) => value > 0).length, reviewRows.length),
    t1Rate: ratio(reviewRows.filter(rowHasT1).length, reviewRows.length),
    minOkCoverage: minRequiredOkCoverage(coverageRows),
    primaryHorizonPostCost: primaryPostCostRows,
    routeProofSources: countByLabel(reviewRows.flatMap(routeTruthEvidenceSources), 'source') as Array<{ source: string; count: number }>,
    kolTimingBuckets: countByLabel(reviewRows.map(kolTimingBucket), 'bucket') as Array<{ bucket: string; count: number }>,
    liveBlockReasons: countByLabel(
      reviewLiveEquivalenceRows.map((row) => rowLiveWouldEnter(row) ? 'live_allowed' : rowLiveBlockReason(row)),
      'reason'
    ) as Array<{ reason: string; count: number }>,
  };
}

function selectPaperExitProxyCohorts(rows: JsonRow[]): Array<{ cohort: string; rows: JsonRow[] }> {
  const routeKnownCostAwareRows = rows
    .filter(isRotationUnderfillRow)
    .filter(isRouteKnownCostAwareUnderfillRow);
  const twoKolRows = routeKnownCostAwareRows.filter(isTwoPlusKolRow);
  return [
    { cohort: '1kol_route_known_cost_aware', rows: routeKnownCostAwareRows.filter(isSingleKolRow) },
    { cohort: '2kol_route_known_cost_aware', rows: twoKolRows },
    {
      cohort: '2kol_route_known_cost_aware_secondKOL<=15s',
      rows: twoKolRows.filter((row) => {
        const delay = secondKolDelaySec(row);
        return delay != null && delay <= 15;
      }),
    },
    {
      cohort: '2kol_route_known_cost_aware_secondKOL<=30s',
      rows: twoKolRows.filter((row) => {
        const delay = secondKolDelaySec(row);
        return delay != null && delay <= 30;
      }),
    },
    {
      cohort: '2kol_route_known_cost_aware_secondKOL_late',
      rows: twoKolRows.filter((row) => {
        const delay = secondKolDelaySec(row);
        return delay != null && delay > 30;
      }),
    },
  ];
}

function buyMarkoutsByPosition(rows: JsonRow[]): Map<string, JsonRow[]> {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows.filter((item) => str(item.anchorType) === 'buy')) {
    const positionId = rowPositionId(row);
    if (!positionId) continue;
    buckets.set(positionId, [...(buckets.get(positionId) ?? []), row]);
  }
  return buckets;
}

function nearestAvailableHorizon(horizonsSec: number[], targetSec: number): number | null {
  const lower = horizonsSec.filter((item) => item <= targetSec).sort((a, b) => b - a)[0];
  if (lower != null) return lower;
  return horizonsSec.filter((item) => item > targetSec).sort((a, b) => a - b)[0] ?? null;
}

function postCostDeltaAt(row: JsonRow, horizonSec: number, markoutsByPosition: Map<string, JsonRow[]>, roundTripCostPct: number): number | null {
  const markout = (markoutsByPosition.get(rowPositionId(row)) ?? [])
    .find((item) => rowHorizon(item) === horizonSec && isOk(item));
  const delta = markout ? rowDelta(markout) : null;
  return delta == null ? null : delta - roundTripCostPct;
}

function buildCurrentCloseExitProxy(
  cohort: string,
  rows: JsonRow[],
  assumedNetworkFeeSol: number
): PaperExitProxyStats {
  const refundAdjustedValues = rows.map((row) =>
    (num(row.netSolTokenOnly) ?? numberOrZero(row.netSol)) - assumedNetworkFeeSol
  );
  const holdSecValues = rows.map((row) => num(row.holdSec)).filter((item): item is number => item != null);
  return {
    cohort,
    exitProfile: 'current_close',
    rows: rows.length,
    observedRows: rows.length,
    proxyHorizonSec: null,
    targetPct: null,
    targetHitRows: null,
    positiveRows: refundAdjustedValues.filter((value) => value > 0).length,
    postCostPositiveRate: ratio(refundAdjustedValues.filter((value) => value > 0).length, rows.length),
    medianPostCostDeltaPct: null,
    p25PostCostDeltaPct: null,
    refundAdjustedNetSol: refundAdjustedValues.reduce((sum, value) => sum + value, 0),
    maxLosingStreak: maxLosingStreak(refundAdjustedValues),
    medianHoldSec: percentile(holdSecValues, 0.5),
  };
}

function buildMarkoutExitProxy(
  cohort: string,
  rows: JsonRow[],
  exitProfile: string,
  proxyHorizonSec: number | null,
  targetPct: number | null,
  markoutsByPosition: Map<string, JsonRow[]>,
  roundTripCostPct: number
): PaperExitProxyStats {
  const deltas = rows
    .map((row) => {
      if (exitProfile === 'cost_aware_t1_primary_proxy') {
        const primary = EVIDENCE_PRIMARY_HORIZONS_SEC
          .map((horizonSec) => postCostDeltaAt(row, horizonSec, markoutsByPosition, roundTripCostPct))
          .filter((item): item is number => item != null);
        return primary.length > 0 ? Math.max(...primary) : null;
      }
      return proxyHorizonSec == null
        ? null
        : postCostDeltaAt(row, proxyHorizonSec, markoutsByPosition, roundTripCostPct);
    })
    .filter((item): item is number => item != null);
  return {
    cohort,
    exitProfile,
    rows: rows.length,
    observedRows: deltas.length,
    proxyHorizonSec,
    targetPct,
    targetHitRows: targetPct == null ? null : deltas.filter((value) => value >= targetPct).length,
    positiveRows: deltas.filter((value) => value > 0).length,
    postCostPositiveRate: ratio(deltas.filter((value) => value > 0).length, deltas.length),
    medianPostCostDeltaPct: percentile(deltas, 0.5),
    p25PostCostDeltaPct: percentile(deltas, 0.25),
    refundAdjustedNetSol: null,
    maxLosingStreak: null,
    medianHoldSec: null,
  };
}

function buildPaperExitProxyStats(
  rows: JsonRow[],
  markoutRows: JsonRow[],
  horizonsSec: number[],
  roundTripCostPct: number,
  assumedNetworkFeeSol: number
): PaperExitProxyStats[] {
  const markoutsByPosition = buyMarkoutsByPosition(markoutRows);
  const cap45Horizon = nearestAvailableHorizon(horizonsSec, 45);
  return selectPaperExitProxyCohorts(rows).flatMap(({ cohort, rows: cohortRows }) => [
    buildCurrentCloseExitProxy(cohort, cohortRows, assumedNetworkFeeSol),
    buildMarkoutExitProxy(cohort, cohortRows, 'cost_aware_t1_primary_proxy', null, 0.12, markoutsByPosition, roundTripCostPct),
    buildMarkoutExitProxy(cohort, cohortRows, 'no_tail_quick_close_t15_proxy', 15, 0, markoutsByPosition, roundTripCostPct),
    buildMarkoutExitProxy(cohort, cohortRows, 'cap_45s_nearest_proxy', cap45Horizon, 0, markoutsByPosition, roundTripCostPct),
  ]);
}

function buildRotationCompoundFitnessGate(profiles: RotationCompoundProfile[]): RotationCompoundFitnessGate {
  const cohort = 'route_known_2kol_cost_aware';
  const profile = profiles.find((row) => row.cohort === cohort) ?? null;
  const reasons: string[] = [];
  if (!profile || profile.rows === 0) {
    return {
      cohort,
      verdict: 'COLLECT',
      score: 0,
      reasons: ['route-known 2+KOL cost-aware compound cohort missing'],
      closes: 0,
      minReviewCloses: ROTATION_COMPOUND_REVIEW_MIN_CLOSES,
      minDecisionCloses: ROTATION_COMPOUND_DECISION_MIN_CLOSES,
      refundAdjustedNetSol: null,
      postCostPositiveRate: null,
      t1Rate: null,
      maxLosingStreak: null,
      winnerCoversBleed: null,
    };
  }

  const winnerCoversBleed = profile.winnerRefundAdjustedNetSol + profile.nonWinnerRefundAdjustedNetSol > 0 &&
    profile.winnerRefundAdjustedNetSol > Math.abs(Math.min(0, profile.nonWinnerRefundAdjustedNetSol));
  let score = 0;
  if (profile.rows >= ROTATION_COMPOUND_REVIEW_MIN_CLOSES) score += 20;
  if (profile.rows >= ROTATION_COMPOUND_DECISION_MIN_CLOSES) score += 20;
  if (profile.refundAdjustedNetSol > 0) score += 20;
  if ((profile.postCostPositiveRate ?? 0) >= ROTATION_PAPER_COMPOUND_MIN_POST_COST_POSITIVE_RATE) score += 15;
  if (profile.maxLosingStreak <= ROTATION_COMPOUND_MAX_LOSING_STREAK) score += 10;
  if (winnerCoversBleed) score += 15;

  let verdict: CompoundFitnessVerdict = 'PASS';
  if (profile.rows < ROTATION_COMPOUND_REVIEW_MIN_CLOSES) {
    verdict = 'COLLECT';
    reasons.push(`sample ${profile.rows}/${ROTATION_COMPOUND_REVIEW_MIN_CLOSES}`);
  } else if (profile.rows < ROTATION_COMPOUND_DECISION_MIN_CLOSES) {
    verdict = 'WATCH';
    reasons.push(`review sample ${profile.rows}/${ROTATION_COMPOUND_DECISION_MIN_CLOSES}`);
  }
  if (profile.rows >= ROTATION_COMPOUND_DECISION_MIN_CLOSES) {
    if (profile.refundAdjustedNetSol <= 0) {
      verdict = 'REJECT';
      reasons.push(`refund-adjusted net ${formatSol(profile.refundAdjustedNetSol)} <= 0`);
    }
    if ((profile.postCostPositiveRate ?? 0) < ROTATION_PAPER_COMPOUND_MIN_POST_COST_POSITIVE_RATE) {
      verdict = 'REJECT';
      reasons.push(`post-cost positive ${formatPct(profile.postCostPositiveRate)} < ${formatPct(ROTATION_PAPER_COMPOUND_MIN_POST_COST_POSITIVE_RATE)}`);
    }
    if (profile.maxLosingStreak > ROTATION_COMPOUND_MAX_LOSING_STREAK) {
      verdict = 'REJECT';
      reasons.push(`max losing streak ${profile.maxLosingStreak} > ${ROTATION_COMPOUND_MAX_LOSING_STREAK}`);
    }
    if (!winnerCoversBleed) {
      verdict = 'REJECT';
      reasons.push('winner net does not cover non-winner bleed');
    }
  }
  if (verdict === 'PASS') reasons.push('compound fitness gate passed for manual review');

  return {
    cohort,
    verdict,
    score,
    reasons,
    closes: profile.rows,
    minReviewCloses: ROTATION_COMPOUND_REVIEW_MIN_CLOSES,
    minDecisionCloses: ROTATION_COMPOUND_DECISION_MIN_CLOSES,
    refundAdjustedNetSol: profile.refundAdjustedNetSol,
    postCostPositiveRate: profile.postCostPositiveRate,
    t1Rate: profile.t1Rate,
    maxLosingStreak: profile.maxLosingStreak,
    winnerCoversBleed,
  };
}

function buildReviewCohortDecision(
  rows: JsonRow[],
  markoutRows: JsonRow[],
  horizonsSec: number[],
  roundTripCostPct: number,
  assumedNetworkFeeSol: number
): ReviewCohortDecision {
  const cohort = 'route_known_2kol_cost_aware';
  const reviewRows = selectRouteKnown2KolCostAwareUnderfillRows(rows);
  const profile = buildCompoundProfile(cohort, reviewRows, 0, assumedNetworkFeeSol);
  const coverageRows = buildRotationReadinessHorizonCoverage(reviewRows, markoutRows, horizonsSec, roundTripCostPct);
  const primaryHorizonPostCost = EVIDENCE_PRIMARY_HORIZONS_SEC
    .filter((horizonSec) => horizonsSec.includes(horizonSec))
    .map((horizonSec) => ({
      horizonSec,
      medianPostCostDeltaPct: coverageRows.find((row) => row.horizonSec === horizonSec)?.medianPostCostDeltaPct ?? null,
    }));
  const primaryPresent = primaryHorizonPostCost.length === EVIDENCE_PRIMARY_HORIZONS_SEC.length &&
    primaryHorizonPostCost.every((row) => row.medianPostCostDeltaPct != null);
  const primaryBothNonPositive = primaryPresent &&
    primaryHorizonPostCost.every((row) => (row.medianPostCostDeltaPct ?? 0) <= 0);
  const earlyRejectSignals: string[] = [];
  if (profile.rows > 0 && profile.refundAdjustedNetSol < 0) {
    earlyRejectSignals.push(`refund-adjusted net ${formatSol(profile.refundAdjustedNetSol)} < 0`);
  }
  if (
    profile.postCostPositiveRate != null &&
    profile.postCostPositiveRate < ROTATION_COMPOUND_EARLY_MIN_POST_COST_POSITIVE_RATE
  ) {
    earlyRejectSignals.push(
      `post-cost positive ${formatPct(profile.postCostPositiveRate)} < ` +
      `${formatPct(ROTATION_COMPOUND_EARLY_MIN_POST_COST_POSITIVE_RATE)}`
    );
  }
  if (profile.maxLosingStreak > ROTATION_COMPOUND_MAX_LOSING_STREAK) {
    earlyRejectSignals.push(`max losing streak ${profile.maxLosingStreak} > ${ROTATION_COMPOUND_MAX_LOSING_STREAK}`);
  }
  if (primaryBothNonPositive) {
    earlyRejectSignals.push('T+15/T+30 primary post-cost medians are both non-positive');
  }

  const reasons: string[] = [];
  let verdict: ReviewCohortDecisionVerdict = 'COLLECT';
  if (profile.rows === 0) {
    reasons.push('review cohort missing');
  } else if (
    profile.rows >= ROTATION_COMPOUND_DECISION_MIN_CLOSES &&
    (
      profile.refundAdjustedNetSol <= 0 ||
      (profile.postCostPositiveRate ?? 0) < ROTATION_PAPER_COMPOUND_MIN_POST_COST_POSITIVE_RATE ||
      profile.maxLosingStreak > ROTATION_COMPOUND_MAX_LOSING_STREAK ||
      primaryBothNonPositive
    )
  ) {
    verdict = 'REJECT';
    reasons.push(...earlyRejectSignals);
    if ((profile.postCostPositiveRate ?? 0) < ROTATION_PAPER_COMPOUND_MIN_POST_COST_POSITIVE_RATE) {
      reasons.push(`decision post-cost positive ${formatPct(profile.postCostPositiveRate)} < ${formatPct(ROTATION_PAPER_COMPOUND_MIN_POST_COST_POSITIVE_RATE)}`);
    }
  } else if (profile.rows >= ROTATION_COMPOUND_DECISION_MIN_CLOSES) {
    verdict = 'PASS';
    reasons.push('50-close decision sample passed report-only review gate');
  } else if (
    profile.rows >= ROTATION_COMPOUND_EARLY_REJECT_MIN_CLOSES &&
    earlyRejectSignals.length >= 2
  ) {
    verdict = 'EARLY_REJECT';
    reasons.push(...earlyRejectSignals);
  } else if (profile.rows >= ROTATION_COMPOUND_REVIEW_MIN_CLOSES) {
    verdict = 'WATCH';
    reasons.push(`review sample ${profile.rows}/${ROTATION_COMPOUND_DECISION_MIN_CLOSES}`);
    if (earlyRejectSignals.length > 0) reasons.push(...earlyRejectSignals);
  } else {
    reasons.push(`collect sample ${profile.rows}/${ROTATION_COMPOUND_REVIEW_MIN_CLOSES}`);
    if (earlyRejectSignals.length > 0) reasons.push(...earlyRejectSignals);
  }

  return {
    cohort,
    verdict,
    closes: profile.rows,
    minEarlyRejectCloses: ROTATION_COMPOUND_EARLY_REJECT_MIN_CLOSES,
    minReviewCloses: ROTATION_COMPOUND_REVIEW_MIN_CLOSES,
    minDecisionCloses: ROTATION_COMPOUND_DECISION_MIN_CLOSES,
    refundAdjustedNetSol: profile.rows > 0 ? profile.refundAdjustedNetSol : null,
    postCostPositiveRate: profile.postCostPositiveRate,
    maxLosingStreak: profile.rows > 0 ? profile.maxLosingStreak : null,
    primaryHorizonPostCost,
    earlyRejectSignals,
    reasons,
  };
}

function liveEquivalenceBlockerRows(row: LiveEquivalenceSummary): number {
  return row.yellowZoneSingleKolRows + row.yellowZoneUnknownKolRows + row.routeUnknownFallbackRows;
}

function buildMicroLiveReviewPacket(
  paper: RotationPaperCompoundReadiness,
  live: RotationLiveReadiness,
  compound: RotationCompoundFitnessGate,
  reviewLiveEquivalence: LiveEquivalenceSummary,
  reviewEvidence: ReviewCohortEvidenceStats
): MicroLiveReviewPacket {
  const blockers = liveEquivalenceBlockerRows(reviewLiveEquivalence);
  const reasons: string[] = [];
  let verdict: MicroLiveReviewVerdict = 'READY_FOR_MICRO_LIVE_REVIEW';
  if (paper.verdict === 'COST_REJECT' || live.verdict === 'COST_REJECT' || compound.verdict === 'REJECT') {
    verdict = 'REJECT';
    reasons.push('one or more report-only gates rejected the cohort');
  } else if (paper.verdict !== 'PAPER_READY') {
    verdict = 'CONTINUE_COLLECT';
    reasons.push(`paper gate ${paper.verdict}`);
  } else if (live.verdict !== 'READY_FOR_MICRO_LIVE') {
    verdict = 'CONTINUE_COLLECT';
    reasons.push(`micro-live evidence ${live.verdict}`);
  } else if (compound.verdict !== 'PASS') {
    verdict = 'CONTINUE_COLLECT';
    reasons.push(`compound fitness ${compound.verdict}`);
  } else if (
    reviewEvidence.candidateIdRows < reviewEvidence.closes ||
    reviewEvidence.routeProofRows < reviewEvidence.closes ||
    reviewEvidence.timestampedSecondKolRows < reviewEvidence.closes
  ) {
    verdict = 'WAIT_REVIEW_COHORT_METADATA';
    reasons.push(
      `metadata incomplete candidateId=${reviewEvidence.candidateIdRows}/${reviewEvidence.closes}, ` +
      `routeProof=${reviewEvidence.routeProofRows}/${reviewEvidence.closes}, ` +
      `secondKolTimestamp=${reviewEvidence.timestampedSecondKolRows}/${reviewEvidence.closes}`
    );
  } else if (reviewLiveEquivalence.rotationRows === 0) {
    verdict = 'WAIT_LIVE_EQUIVALENCE_DATA';
    reasons.push('review-cohort live-equivalence rows missing for review window');
  } else if (blockers > 0) {
    verdict = 'WAIT_LIVE_EQUIVALENCE_CLEAR';
    reasons.push(`live-equivalence blockers ${blockers}`);
  } else if (reviewEvidence.linkedLiveEquivalenceRows === 0) {
    verdict = 'WAIT_LIVE_EQUIVALENCE_DATA';
    reasons.push('review-cohort linked live-equivalence rows missing');
  } else {
    reasons.push('manual micro-live review packet ready; report never enables live');
  }
  return {
    verdict,
    reasons,
    reviewCohort: paper.cohort,
    paperVerdict: paper.verdict,
    liveVerdict: live.verdict,
    compoundVerdict: compound.verdict,
    liveEquivalenceRows: reviewLiveEquivalence.rotationRows,
    liveEquivalenceBlockers: blockers,
    linkedLiveEquivalenceRows: reviewEvidence.linkedLiveEquivalenceRows,
    candidateIdRows: reviewEvidence.candidateIdRows,
    routeProofRows: reviewEvidence.routeProofRows,
    timestampedSecondKolRows: reviewEvidence.timestampedSecondKolRows,
    closes: paper.closes,
    plan: {
      ticketSol: MICRO_LIVE_REVIEW_TICKET_SOL,
      maxDailyAttempts: MICRO_LIVE_REVIEW_MAX_DAILY_ATTEMPTS,
      dailyLossCapSol: MICRO_LIVE_REVIEW_DAILY_LOSS_CAP_SOL,
      rollbackConditions: [
        'stop if wallet floor guard blocks or drift halt fires',
        'stop if any review trade records route-unknown fallback',
        'stop if daily refund-adjusted live net <= -0.03 SOL',
        'stop if first 3 linked live closes are refund-adjusted net negative',
      ],
    },
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function selectRouteKnown2KolCostAwareUnderfillRows(rows: JsonRow[]): JsonRow[] {
  return rows.filter((row) =>
    isRotationUnderfillRow(row) &&
    !isUnderfillRouteUnknown(row) &&
    isTwoPlusKolRow(row) &&
    isCostAwareUnderfillRow(row)
  );
}

function buildRotationReadinessHorizonCoverage(
  rows: JsonRow[],
  markoutRows: JsonRow[],
  horizonsSec: number[],
  roundTripCostPct: number
): RotationReadinessHorizonCoverage[] {
  const positionIds = new Set(rows.map(rowPositionId).filter(Boolean));
  const expectedRows = positionIds.size > 0 ? positionIds.size : rows.length;
  const scopedMarkouts = markoutRows.filter((row) => {
    const positionId = rowPositionId(row);
    return positionId !== '' && positionIds.has(positionId) && str(row.anchorType) === 'buy';
  });
  return EVIDENCE_REQUIRED_COVERAGE_HORIZONS_SEC
    .filter((horizonSec) => horizonsSec.includes(horizonSec))
    .map((horizonSec) => {
      const selected = scopedMarkouts.filter((row) => rowHorizon(row) === horizonSec);
      const ok = selected.filter(isOk);
      const observedPositionIds = new Set(selected.map(rowPositionId).filter(Boolean));
      const okPositionIds = new Set(ok.map(rowPositionId).filter(Boolean));
      const postCostDeltas = ok
        .map(rowDelta)
        .filter((value): value is number => value != null)
        .map((value) => value - roundTripCostPct);
      return {
        horizonSec,
        expectedRows,
        observedRows: observedPositionIds.size,
        okRows: okPositionIds.size,
        okCoverage: expectedRows > 0 ? okPositionIds.size / expectedRows : null,
        medianPostCostDeltaPct: percentile(postCostDeltas, 0.5),
      };
    });
}

function isRouteProofedUnderfillRow(row: JsonRow): boolean {
  return isRotationUnderfillRow(row) &&
    routeTruthEvidenceSources(row).length > 0 &&
    !isUnderfillRouteUnknown(row);
}

function rowCloseTimeMs(row: JsonRow): number {
  const candidates = [
    timeMs(row.closedAt),
    timeMs(row.exitTimeSec),
    timeMs(row.entryTimeSec),
    timeMs(row.createdAt),
    timeMs(row.recordedAt),
  ];
  return candidates.find((value) => Number.isFinite(value)) ?? NaN;
}

function latestIso(rows: JsonRow[]): string | null {
  const latest = Math.max(
    ...rows
      .map(rowCloseTimeMs)
      .filter((value) => Number.isFinite(value))
  );
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

function latestIsoBy(rows: JsonRow[], getTimeMs: (row: JsonRow) => number): string | null {
  const latest = Math.max(
    ...rows
      .map(getTimeMs)
      .filter((value) => Number.isFinite(value))
  );
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

function rowRuntimeEventTimeMs(row: JsonRow): number {
  const candidates = [
    timeMs(row.rejectedAt),
    timeMs(row.recordedAt),
    timeMs(row.generatedAt),
    timeMs(row.createdAt),
    timeMs(probe(row).firedAt),
  ];
  return candidates.find((value) => Number.isFinite(value)) ?? NaN;
}

function rowRuntimeEventKey(row: JsonRow, reason: string): string {
  return rowStringWithExtras(row, ['eventId', 'positionId', 'id']) ||
    [
      rowTokenMint(row),
      reason,
      latestIsoBy([row], rowRuntimeEventTimeMs) ?? '',
    ].join(':');
}

function rowNoTradeEventTimeMs(row: JsonRow): number {
  return rowRuntimeEventTimeMs(row);
}

function rowNoTradeEventKey(row: JsonRow): string {
  return rowRuntimeEventKey(row, rowNoTradeReason(row));
}

function rowNoTradeReason(row: JsonRow): string {
  const extras = obj(row.extras);
  return str(extras.noTradeReason) ||
    str(row.rejectReason) ||
    str(extras.eventType) ||
    '(unknown)';
}

function rowMissedAlphaEntryReason(row: JsonRow): string {
  const extras = obj(row.extras);
  return str(extras.entryReason) ||
    str(extras.eventType) ||
    str(row.signalSource) ||
    '(unknown)';
}

function rowMissedAlphaRejectReason(row: JsonRow): string {
  return str(row.rejectReason) ||
    str(obj(row.extras).noTradeReason) ||
    '(unknown)';
}

function rowPolicyEntryReason(row: JsonRow): string {
  const bucket = obj(row.bucket);
  const context = obj(row.context);
  return str(bucket.entryReason) ||
    str(context.entryReason) ||
    str(context.armName) ||
    str(row.eventKind) ||
    '(unknown)';
}

function rowPolicyRejectReason(row: JsonRow): string {
  const context = obj(row.context);
  const reasons = Array.isArray(row.reasons) ? row.reasons : [];
  return str(context.rejectReason) ||
    str(reasons[0]) ||
    str(row.eventKind) ||
    '(unknown)';
}

function isRotationPolicyDecision(row: JsonRow): boolean {
  const context = obj(row.context);
  return isRotationArmValue(rowPolicyEntryReason(row)) ||
    isRotationArmValue(str(context.armName)) ||
    str(context.entryReason) === 'rotation_v1';
}

function isNonRotationLaneRejectReason(reason: string): boolean {
  return reason.startsWith('smart_v3') ||
    reason.startsWith('pure_ws') ||
    reason.startsWith('capitulation') ||
    reason.startsWith('stalk_') ||
    reason.startsWith('dev_quality');
}

function isRotationPolicyAttributionDrift(row: JsonRow): boolean {
  return isRotationPolicyDecision(row) && isNonRotationLaneRejectReason(rowPolicyRejectReason(row));
}

function rowStringList(row: JsonRow, key: string): string[] {
  const value = row[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function rowPolicyAttributionSource(row: JsonRow): string {
  const context = obj(row.context);
  const source = str(context.source);
  if (source) return source;
  const reasons = rowStringList(row, 'reasons');
  if (
    str(row.eventKind) === 'reject' &&
    str(row.currentAction) === 'block' &&
    reasons.includes('reject_policy_observed') &&
    rowPolicyRejectReason(row).startsWith('smart_v3')
  ) {
    return 'legacy_reject_observer';
  }
  return '(unknown)';
}

function rowPolicyAttributionSurvivalReason(row: JsonRow): string {
  const context = obj(row.context);
  const survivalReason = str(context.survivalReason);
  if (survivalReason) return survivalReason;
  const flags = rowStringList(row, 'riskFlags');
  return flags[0] ?? '(unknown)';
}

function rowPolicyParameterVersion(row: JsonRow): string {
  const context = obj(row.context);
  const extras = obj(row.extras);
  return str(context.parameterVersion) ||
    str(row.parameterVersion) ||
    str(extras.parameterVersion) ||
    '(unknown)';
}

function rowPolicySignalSource(row: JsonRow): string {
  const context = obj(row.context);
  const extras = obj(row.extras);
  return str(context.signalSource) ||
    str(row.signalSource) ||
    str(extras.signalSource) ||
    str(context.armName) ||
    '(unknown)';
}

function rowPolicyBucketValue(row: JsonRow, key: string): string {
  const bucket = obj(row.bucket);
  return str(bucket[key]) || '(unknown)';
}

function rowPolicyMetric(row: JsonRow, key: string): number | null {
  return num(obj(row.metrics)[key]) ?? num(row[key]) ?? num(obj(row.extras)[key]);
}

function rowPolicyParticipants(row: JsonRow): RotationPolicyParticipantSummary[] {
  const context = obj(row.context);
  const extras = obj(row.extras);
  const raw =
    Array.isArray(context.participatingKols) ? context.participatingKols :
    Array.isArray(row.participatingKols) ? row.participatingKols :
    Array.isArray(extras.participatingKols) ? extras.participatingKols :
    Array.isArray(row.kols) ? row.kols :
    Array.isArray(extras.kols) ? extras.kols :
    [];
  return raw.flatMap((item) => {
    if (typeof item === 'string') {
      return [{ id: item, tier: '(unknown)', style: '(unknown)', timestampMs: null }];
    }
    const record = obj(item);
    const id = str(record.id) || str(record.kolId) || str(record.wallet) || str(record.address);
    if (!id) return [];
    const timestampMs = timeMs(record.timestamp) || timeMs(record.timestampMs) || timeMs(record.firstSeenAt) || timeMs(record.firstBuyAt);
    return [{
      id,
      tier: (str(record.tier) || str(record.kolTier) || '(unknown)').toUpperCase(),
      style: str(record.style) || str(record.tradingStyle) || '(unknown)',
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
    }];
  });
}

function isKolAlphaDecayLabel(value: string): boolean {
  return value.toLowerCase() === 'kol_alpha_decay';
}

function rowHasKolAlphaDecay(row: JsonRow): boolean {
  const extras = obj(row.extras);
  return isKolAlphaDecayLabel(rowPolicyAttributionSurvivalReason(row)) ||
    isKolAlphaDecayLabel(str(extras.survivalReason)) ||
    rowStringList(row, 'riskFlags').some(isKolAlphaDecayLabel) ||
    stringList(extras.survivalFlags).some(isKolAlphaDecayLabel) ||
    rowNoTradeReason(row).toLowerCase().includes('kol_alpha_decay') ||
    rowMissedAlphaRejectReason(row).toLowerCase().includes('kol_alpha_decay');
}

function isRotationDecayAttributionPolicy(row: JsonRow): boolean {
  return isRotationPolicyAttributionDrift(row) && rowHasKolAlphaDecay(row);
}

function isRotationDecayMissedAlphaRow(row: JsonRow): boolean {
  return rowHasKolAlphaDecay(row) && (
    isRotationNoTrade(row) ||
    isRotationArmValue(str(row.signalSource)) ||
    isRotationArmValue(rowArmName(row))
  );
}

function uniqueRuntimeEvents(rows: JsonRow[], reasonForRow: (row: JsonRow) => string): JsonRow[] {
  const seen = new Set<string>();
  const uniqueRows: JsonRow[] = [];
  for (const row of rows) {
    const key = rowRuntimeEventKey(row, reasonForRow(row));
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueRows.push(row);
  }
  return uniqueRows;
}

function uniqueNoTradeEvents(rows: JsonRow[]): JsonRow[] {
  return uniqueRuntimeEvents(rows, rowNoTradeReason);
}

function exitSellQuoteEvidenceForRow(row: JsonRow): JsonRow {
  const direct = obj(row.exitSellQuoteEvidence);
  if (Object.keys(direct).length > 0) return direct;
  return obj(obj(row.extras).exitSellQuoteEvidence);
}

function rowExitRouteProofSkipReason(row: JsonRow): string {
  return rowStringWithExtras(row, ['exitRouteProofSkipReason']);
}

function rowPaperCloseWriterSchemaVersion(row: JsonRow): string {
  return rowStringWithExtras(row, ['paperCloseWriterSchemaVersion']);
}

function rowRotationExitRouteProofSchemaVersion(row: JsonRow): string {
  return rowStringWithExtras(row, ['rotationExitRouteProofSchemaVersion']);
}

function hasExitRouteInstrumentation(row: JsonRow): boolean {
  const extras = obj(row.extras);
  if (Object.keys(exitSellQuoteEvidenceForRow(row)).length > 0) return true;
  if (rowExitRouteProofSkipReason(row)) return true;
  return boolValue(row.exitRouteFound) != null ||
    boolValue(extras.exitRouteFound) != null ||
    boolValue(row.exitSellRouteKnown) != null ||
    boolValue(extras.exitSellRouteKnown) != null;
}

function hasExitSellQuoteEvidence(row: JsonRow): boolean {
  return Object.keys(exitSellQuoteEvidenceForRow(row)).length > 0;
}

function exitRouteFoundValue(row: JsonRow): boolean | null {
  const extras = obj(row.extras);
  const evidence = exitSellQuoteEvidenceForRow(row);
  return boolValue(row.exitRouteFound) ??
    boolValue(extras.exitRouteFound) ??
    boolValue(row.exitSellRouteKnown) ??
    boolValue(extras.exitSellRouteKnown) ??
    boolValue(evidence.routeFound);
}

function exitRouteProofSkipReasonCounts(rows: JsonRow[]): Array<{ reason: string; count: number }> {
  return countByLabel(
    rows.map(rowExitRouteProofSkipReason).filter((reason): reason is string => reason.length > 0),
    'reason'
  ) as Array<{ reason: string; count: number }>;
}

function paperCloseWriterSchemaCounts(rows: JsonRow[]): Array<{ schema: string; count: number }> {
  return countByLabel(
    rows.map(rowPaperCloseWriterSchemaVersion).filter((schema): schema is string => schema.length > 0),
    'schema'
  ) as Array<{ schema: string; count: number }>;
}

function routeProofFreshCutoff(
  rows: JsonRow[],
  explicitFreshSinceMs?: number,
  currentSessionStartedAtMs?: number
): { cutoffMs: number | null; cutoffSource: RouteProofFreshnessStats['cutoffSource'] } {
  if (explicitFreshSinceMs != null) return { cutoffMs: explicitFreshSinceMs, cutoffSource: 'arg' };
  if (currentSessionStartedAtMs != null && Number.isFinite(currentSessionStartedAtMs)) {
    return { cutoffMs: currentSessionStartedAtMs, cutoffSource: 'current_session' };
  }
  const markerTimes = rows
    .filter(hasExitRouteInstrumentation)
    .map(rowCloseTimeMs)
    .filter((value) => Number.isFinite(value));
  if (markerTimes.length === 0) return { cutoffMs: null, cutoffSource: 'none' };
  return { cutoffMs: Math.min(...markerTimes), cutoffSource: 'first_exit_route_marker' };
}

function buildRouteProofFreshnessArmStats(rows: JsonRow[]): RouteProofFreshnessArmStats[] {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows) {
    const armName = rowArmName(row);
    buckets.set(armName, [...(buckets.get(armName) ?? []), row]);
  }
  return [...buckets.entries()]
    .map(([armName, scoped]) => {
      const evidenceRows = scoped.filter(hasExitSellQuoteEvidence);
      const skipReasonRows = scoped.filter((row) => rowExitRouteProofSkipReason(row));
      return {
        armName,
        rows: scoped.length,
        paperCloseWriterSchemaRows: scoped.filter((row) => rowPaperCloseWriterSchemaVersion(row)).length,
        rotationExitRouteProofSchemaRows: scoped.filter((row) => rowRotationExitRouteProofSchemaVersion(row)).length,
        exitRouteInstrumentedRows: scoped.filter(hasExitRouteInstrumentation).length,
        exitQuoteEvidenceRows: evidenceRows.length,
        exitRouteProofSkippedRows: skipReasonRows.length,
        missingEvidenceRows: scoped.filter((row) => !hasExitSellQuoteEvidence(row)).length,
        routeFoundTrueRows: scoped.filter((row) => exitRouteFoundValue(row) === true).length,
        routeFoundFalseRows: scoped.filter((row) => exitRouteFoundValue(row) === false).length,
        routeFoundNullRows: scoped.filter((row) => exitRouteFoundValue(row) == null).length,
        routeProofRows: scoped.filter(isRouteProofedUnderfillRow).length,
        latestCloseAt: latestIso(scoped),
        latestExitQuoteEvidenceAt: latestIso(evidenceRows),
        topExitRouteProofSkipReasons: exitRouteProofSkipReasonCounts(skipReasonRows).slice(0, 3),
        topPaperCloseWriterSchemas: paperCloseWriterSchemaCounts(scoped).slice(0, 3),
      };
    })
    .sort((a, b) =>
      b.rows - a.rows ||
      b.missingEvidenceRows - a.missingEvidenceRows ||
      a.armName.localeCompare(b.armName)
    );
}

function buildRouteProofFreshnessStats(
  rows: JsonRow[],
  explicitFreshSinceMs?: number,
  currentSessionStartedAtMs?: number,
  noTradeRows: JsonRow[] = [],
  missedAlphaRows: JsonRow[] = [],
  policyDecisionRows: JsonRow[] = []
): RouteProofFreshnessStats {
  const underfillRows = rows.filter(isRotationUnderfillRow);
  const cutoff = routeProofFreshCutoff(underfillRows, explicitFreshSinceMs, currentSessionStartedAtMs);
  const freshRows = cutoff.cutoffMs == null
    ? underfillRows
    : underfillRows.filter((row) => {
      const closeMs = rowCloseTimeMs(row);
      return Number.isFinite(closeMs) && closeMs >= (cutoff.cutoffMs ?? 0);
    });
  const freshNoTradeRows = cutoff.cutoffMs == null
    ? noTradeRows
    : noTradeRows.filter((row) => {
      const eventMs = rowNoTradeEventTimeMs(row);
      return Number.isFinite(eventMs) && eventMs >= (cutoff.cutoffMs ?? 0);
    });
  const freshNoTradeEvents = uniqueNoTradeEvents(freshNoTradeRows);
  const freshMissedAlphaRows = cutoff.cutoffMs == null
    ? missedAlphaRows
    : missedAlphaRows.filter((row) => {
      const eventMs = rowRuntimeEventTimeMs(row);
      return Number.isFinite(eventMs) && eventMs >= (cutoff.cutoffMs ?? 0);
    });
  const freshMissedAlphaEvents = uniqueRuntimeEvents(freshMissedAlphaRows, rowMissedAlphaRejectReason);
  const freshPolicyDecisionRows = cutoff.cutoffMs == null
    ? policyDecisionRows
    : policyDecisionRows.filter((row) => {
      const eventMs = rowRuntimeEventTimeMs(row);
      return Number.isFinite(eventMs) && eventMs >= (cutoff.cutoffMs ?? 0);
    });
  const freshRotationPolicyDecisionRows = freshPolicyDecisionRows.filter(isRotationPolicyDecision);
  const exitRouteInstrumentedRows = freshRows.filter(hasExitRouteInstrumentation).length;
  const paperCloseWriterSchemaRows = freshRows.filter((row) => rowPaperCloseWriterSchemaVersion(row)).length;
  const rotationExitRouteProofSchemaRows = freshRows.filter((row) => rowRotationExitRouteProofSchemaVersion(row)).length;
  const exitQuoteEvidenceRows = freshRows.filter(hasExitSellQuoteEvidence).length;
  const exitQuoteRouteFoundRows = freshRows.filter((row) => exitRouteFoundValue(row) === true).length;
  const exitQuoteNoRouteRows = freshRows.filter((row) => exitRouteFoundValue(row) === false).length;
  const exitRouteProofSkippedRows = freshRows.filter((row) => rowExitRouteProofSkipReason(row)).length;
  const exitQuoteUnknownRows = freshRows.filter((row) =>
    hasExitRouteInstrumentation(row) && !rowExitRouteProofSkipReason(row) && exitRouteFoundValue(row) == null
  ).length;
  const routeProofRows = freshRows.filter(isRouteProofedUnderfillRow).length;
  const routeUnknownRows = freshRows.filter(isUnderfillRouteUnknown).length;
  const routeProofedTwoPlusCostAwareRows = freshRows.filter((row) =>
    isRouteProofedUnderfillRow(row) &&
    isTwoPlusKolRow(row) &&
    isCostAwareUnderfillRow(row)
  );
  const reasonCounts = new Map<string, number>();
  for (const reason of freshRows.flatMap(routeUnknownReasonsForRow)) {
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const topRouteUnknownReasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 5);
  const topExitRouteProofSkipReasons = exitRouteProofSkipReasonCounts(freshRows).slice(0, 5);
  const topPaperCloseWriterSchemas = paperCloseWriterSchemaCounts(freshRows).slice(0, 5);
  const topNoTradeReasons = countByLabel(
    freshNoTradeEvents.map(rowNoTradeReason),
    'reason'
  ).slice(0, 5) as Array<{ reason: string; count: number }>;
  const topMissedAlphaEntryReasons = countByLabel(
    freshMissedAlphaEvents.map(rowMissedAlphaEntryReason),
    'reason'
  ).slice(0, 5) as Array<{ reason: string; count: number }>;
  const topMissedAlphaRejectReasons = countByLabel(
    freshMissedAlphaEvents.map(rowMissedAlphaRejectReason),
    'reason'
  ).slice(0, 5) as Array<{ reason: string; count: number }>;
  const topPolicyEntryReasons = countByLabel(
    freshPolicyDecisionRows.map(rowPolicyEntryReason),
    'reason'
  ).slice(0, 5) as Array<{ reason: string; count: number }>;
  const topPolicyRejectReasons = countByLabel(
    freshPolicyDecisionRows.map(rowPolicyRejectReason),
    'reason'
  ).slice(0, 5) as Array<{ reason: string; count: number }>;
  const minRequiredFreshRows = ROTATION_COMPOUND_REVIEW_MIN_CLOSES;
  const instrumentationMissingRows = freshRows.length - exitRouteInstrumentedRows;
  const reasons: string[] = [];
  let verdict: RouteProofFreshnessVerdict = 'READY_FOR_NARROW_REVIEW';

  if (freshRows.length === 0) {
    verdict = 'WAIT_FRESH_CLOSES';
    reasons.push(
      cutoff.cutoffSource === 'none'
        ? 'no underfill paper closes in the report window'
        : cutoff.cutoffSource === 'current_session'
          ? 'no underfill paper closes since current runtime session start'
          : 'no underfill paper closes in the fresh route-proof window yet'
    );
    if (cutoff.cutoffSource === 'current_session') {
      reasons.push(
        freshNoTradeEvents.length === 0
          ? 'no rotation no-trade candidates since current runtime session start'
          : `rotation no-trade candidates observed since current runtime session start ${freshNoTradeEvents.length}`
      );
      if (freshNoTradeEvents.length === 0) {
        reasons.push(
          freshMissedAlphaEvents.length > 0 || freshPolicyDecisionRows.length > 0
            ? `runtime active but no rotation candidates since current runtime session start; missedAlphaEvents=${freshMissedAlphaEvents.length}, policyDecisions=${freshPolicyDecisionRows.length}`
            : 'runtime activity sparse since current runtime session start'
        );
      }
    }
  } else if (cutoff.cutoffSource === 'none') {
    verdict = 'INSTRUMENTATION_GAP';
    if (rotationExitRouteProofSchemaRows === 0) {
      reasons.push(`no exit-route markers or route-proof writer schema across current report-window underfill closes ${freshRows.length}; deploy drift likely`);
    } else {
      reasons.push(`route-proof writer schema present but exit-route markers missing ${freshRows.length - exitRouteInstrumentedRows}/${freshRows.length}; write-path drift likely`);
    }
  } else if (instrumentationMissingRows > 0 || exitQuoteUnknownRows > 0) {
    verdict = 'INSTRUMENTATION_GAP';
    if (instrumentationMissingRows > 0) {
      reasons.push(`fresh rows missing exit-route instrumentation ${instrumentationMissingRows}/${freshRows.length}`);
    }
    if (exitQuoteUnknownRows > 0) {
      reasons.push(`exit-route evidence without routeFound true/false ${exitQuoteUnknownRows}/${freshRows.length}`);
    }
  } else if (routeProofRows === 0 && exitQuoteNoRouteRows > 0 && freshRows.length >= ROTATION_COMPOUND_EARLY_REJECT_MIN_CLOSES) {
    verdict = 'REJECT';
    reasons.push(`fresh exit-route probes found no sell route ${exitQuoteNoRouteRows}/${freshRows.length}`);
  } else if (routeProofRows === 0 && exitRouteProofSkippedRows > 0) {
    verdict = 'DATA_GAP';
    reasons.push(`fresh exit-route proof skipped or inconclusive ${exitRouteProofSkippedRows}/${freshRows.length}`);
  } else if (routeProofRows === 0) {
    verdict = 'INSTRUMENTATION_GAP';
    reasons.push('fresh rows exist but positive route proof is still zero');
  } else if (routeProofRows < freshRows.length) {
    verdict = 'DATA_GAP';
    reasons.push(`fresh route proof partial ${routeProofRows}/${freshRows.length}`);
  } else if (routeProofedTwoPlusCostAwareRows.length === 0) {
    verdict = 'ROUTE_PROOF_COLLECTING';
    reasons.push('route-proofed fresh rows exist, but 2+ KOL cost-aware slice is empty');
  } else if (routeProofedTwoPlusCostAwareRows.length < minRequiredFreshRows) {
    verdict = 'ROUTE_PROOF_COLLECTING';
    reasons.push(`route-proofed 2+KOL cost-aware fresh sample ${routeProofedTwoPlusCostAwareRows.length}/${minRequiredFreshRows}`);
  } else if (routeProofedTwoPlusCostAwareRows.some((row) => !rowCandidateId(row) || secondKolDelaySec(row) == null)) {
    verdict = 'DATA_GAP';
    reasons.push('fresh narrow sample still has candidateId or timestamped second-KOL gaps');
  } else {
    reasons.push('fresh route-proofed narrow sample is ready for the narrow cohort board');
  }

  return {
    verdict,
    reasons,
    cutoffSource: cutoff.cutoffSource,
    freshSince: cutoff.cutoffMs == null ? null : new Date(cutoff.cutoffMs).toISOString(),
    underfillRows: underfillRows.length,
    freshRows: freshRows.length,
    freshNoTradeRows: freshNoTradeRows.length,
    freshNoTradeEvents: freshNoTradeEvents.length,
    freshMissedAlphaRows: freshMissedAlphaRows.length,
    freshMissedAlphaEvents: freshMissedAlphaEvents.length,
    freshPolicyDecisionRows: freshPolicyDecisionRows.length,
    freshRotationPolicyDecisionRows: freshRotationPolicyDecisionRows.length,
    minRequiredFreshRows,
    latestUnderfillCloseAt: latestIso(underfillRows),
    latestCostAwareCloseAt: latestIso(underfillRows.filter(isCostAwareUnderfillRow)),
    latestExitQuoteEvidenceAt: latestIso(underfillRows.filter(hasExitSellQuoteEvidence)),
    latestNoTradeAt: latestIsoBy(freshNoTradeRows, rowNoTradeEventTimeMs),
    paperCloseWriterSchemaRows,
    rotationExitRouteProofSchemaRows,
    exitRouteInstrumentedRows,
    exitQuoteEvidenceRows,
    exitQuoteRouteFoundRows,
    exitQuoteNoRouteRows,
    exitQuoteUnknownRows,
    exitRouteProofSkippedRows,
    instrumentationMissingRows,
    routeProofRows,
    explicitNoRouteRows: freshRows.filter(hasExplicitNoSellRouteEvidence).length,
    routeUnknownRows,
    candidateIdRows: freshRows.filter((row) => rowCandidateId(row)).length,
    twoPlusKolRows: freshRows.filter(isTwoPlusKolRow).length,
    costAwareRows: freshRows.filter(isCostAwareUnderfillRow).length,
    routeProofedTwoPlusCostAwareRows: routeProofedTwoPlusCostAwareRows.length,
    routeProofedTwoPlusCostAwareTimestampedRows: routeProofedTwoPlusCostAwareRows
      .filter((row) => secondKolDelaySec(row) != null)
      .length,
    freshByArm: buildRouteProofFreshnessArmStats(freshRows),
    topNoTradeReasons,
    topMissedAlphaEntryReasons,
    topMissedAlphaRejectReasons,
    topPolicyEntryReasons,
    topPolicyRejectReasons,
    topRouteUnknownReasons,
    topExitRouteProofSkipReasons,
    topPaperCloseWriterSchemas,
  };
}

function buildRotationCandidateFunnelStats(input: {
  sinceMs: number;
  currentSessionStartedAtMs?: number;
  kolTxRows: JsonRow[];
  callFunnelRows: JsonRow[];
  noTradeRows: JsonRow[];
  policyDecisionRows: JsonRow[];
  rotationPaperRows: JsonRow[];
}): RotationCandidateFunnelStats {
  const cutoffMs = input.currentSessionStartedAtMs != null && Number.isFinite(input.currentSessionStartedAtMs)
    ? input.currentSessionStartedAtMs
    : input.sinceMs;
  const cutoffSource = input.currentSessionStartedAtMs != null && Number.isFinite(input.currentSessionStartedAtMs)
    ? 'current_session'
    : 'report_since';
  const kolTxRows = input.kolTxRows.filter((row) => {
    const t = rowKolTxTimeMs(row);
    return Number.isFinite(t) && t >= cutoffMs;
  });
  const kolBuyRows = kolTxRows.filter((row) => rowKolTxAction(row) === 'buy');
  const kolSellRows = kolTxRows.filter((row) => rowKolTxAction(row) === 'sell');
  const callFunnelRows = input.callFunnelRows.filter((row) => {
    const t = rowCallFunnelTimeMs(row);
    return Number.isFinite(t) && t >= cutoffMs;
  });
  const rotationCallFunnelRows = callFunnelRows.filter(isRotationCallFunnelRow);
  const rotationNoTradeRows = input.noTradeRows.filter((row) => {
    const t = rowNoTradeEventTimeMs(row);
    return Number.isFinite(t) && t >= cutoffMs;
  });
  const rotationNoTradeEvents = uniqueNoTradeEvents(rotationNoTradeRows);
  const policyDecisionRows = input.policyDecisionRows.filter((row) => {
    const t = rowRuntimeEventTimeMs(row);
    return Number.isFinite(t) && t >= cutoffMs;
  });
  const rotationPolicyDecisionRows = policyDecisionRows.filter(isRotationPolicyDecision);
  const rotationPaperCloseRows = input.rotationPaperRows.filter((row) => {
    const t = rowCloseTimeMs(row);
    return Number.isFinite(t) && t >= cutoffMs;
  });
  const distinctKols = new Set(kolTxRows.map(rowKolId).filter((value) => value !== '(unknown)')).size;
  const distinctTokens = new Set(kolTxRows.map(rowTokenMint).filter(Boolean)).size;
  const reasons: string[] = [];
  let verdict: RotationCandidateFunnelVerdict = 'COLLECT';

  if (kolTxRows.length === 0) {
    verdict = 'INPUT_IDLE';
    reasons.push('no KOL tx input since funnel cutoff');
  } else if (
    rotationCallFunnelRows.length === 0 &&
    rotationNoTradeEvents.length === 0 &&
    rotationPolicyDecisionRows.length === 0 &&
    rotationPaperCloseRows.length === 0
  ) {
    verdict = 'KOL_FLOW_ACTIVE_NO_ROTATION_PATTERN';
    reasons.push(`KOL tx active but no rotation candidate artifacts; kolTx=${kolTxRows.length}, buys=${kolBuyRows.length}, sells=${kolSellRows.length}`);
  } else if (rotationNoTradeEvents.length > 0 || rotationPolicyDecisionRows.length > 0) {
    verdict = 'ROTATION_PATTERN_BLOCKED';
    reasons.push(`rotation candidates reached block/policy path; noTradeEvents=${rotationNoTradeEvents.length}, rotationPolicy=${rotationPolicyDecisionRows.length}`);
  } else if (rotationCallFunnelRows.length > 0 && rotationNoTradeEvents.length === 0 && rotationPolicyDecisionRows.length === 0 && rotationPaperCloseRows.length === 0) {
    verdict = 'ROTATION_LEDGER_GAP';
    reasons.push(`rotation funnel rows exist without no-trade/policy/paper close artifacts; rotationFunnel=${rotationCallFunnelRows.length}`);
  } else {
    reasons.push(`rotation candidate artifacts collecting; paperCloses=${rotationPaperCloseRows.length}, noTradeEvents=${rotationNoTradeEvents.length}, rotationPolicy=${rotationPolicyDecisionRows.length}`);
  }

  return {
    verdict,
    reasons,
    cutoffSource,
    since: new Date(cutoffMs).toISOString(),
    kolTxRows: kolTxRows.length,
    kolBuyRows: kolBuyRows.length,
    kolSellRows: kolSellRows.length,
    kolShadowRows: kolTxRows.filter((row) => boolValue(row.isShadow) === true || boolValue(row.shadow) === true).length,
    distinctKols,
    distinctTokens,
    latestKolTxAt: latestIsoBy(kolTxRows, rowKolTxTimeMs),
    callFunnelRows: callFunnelRows.length,
    rotationCallFunnelRows: rotationCallFunnelRows.length,
    latestCallFunnelAt: latestIsoBy(callFunnelRows, rowCallFunnelTimeMs),
    rotationNoTradeEvents: rotationNoTradeEvents.length,
    rotationNoTradeRows: rotationNoTradeRows.length,
    rotationPolicyDecisionRows: rotationPolicyDecisionRows.length,
    rotationPaperCloseRows: rotationPaperCloseRows.length,
    topKolTxActions: countByLabel(kolTxRows.map(rowKolTxAction), 'action').slice(0, 5) as Array<{ action: string; count: number }>,
    topKolTxKols: countByLabel(kolTxRows.map(rowKolId), 'kol').slice(0, 5) as Array<{ kol: string; count: number }>,
    topBuyKols: countByLabel(kolBuyRows.map(rowKolId), 'kol').slice(0, 5) as Array<{ kol: string; count: number }>,
    topCallFunnelEventTypes: countByLabel(callFunnelRows.map(rowCallFunnelEventType), 'eventType').slice(0, 5) as Array<{ eventType: string; count: number }>,
    topRotationCallFunnelEventTypes: countByLabel(rotationCallFunnelRows.map(rowCallFunnelEventType), 'eventType').slice(0, 5) as Array<{ eventType: string; count: number }>,
    topNoTradeReasons: countByLabel(rotationNoTradeEvents.map(rowNoTradeReason), 'reason').slice(0, 5) as Array<{ reason: string; count: number }>,
    topPolicyEntryReasons: countByLabel(rotationPolicyDecisionRows.map(rowPolicyEntryReason), 'reason').slice(0, 5) as Array<{ reason: string; count: number }>,
  };
}

function rowKolTxSol(row: JsonRow): number {
  return num(row.solAmount) ?? num(row.amountSol) ?? num(row.sol) ?? 0;
}

function rowKolTxTier(row: JsonRow): string {
  return (str(row.tier) || str(row.kolTier) || str(obj(row.extras).tier)).toUpperCase();
}

function rowKolTxActionNormalized(row: JsonRow): string {
  return rowKolTxAction(row).toLowerCase();
}

function isUnderfillEligibleKolTx(row: JsonRow): boolean {
  const tier = rowKolTxTier(row);
  return tier === 'S' || tier === 'A';
}

function shortTokenMint(value: string): string {
  if (value.length <= 12) return value || '(unknown)';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function rotationReplayCutoff(input: {
  sinceMs: number;
  currentSessionStartedAtMs?: number;
}): { cutoffMs: number; cutoffSource: 'current_session' | 'report_since' } {
  const hasCurrentSession = input.currentSessionStartedAtMs != null &&
    Number.isFinite(input.currentSessionStartedAtMs);
  return {
    cutoffMs: hasCurrentSession ? input.currentSessionStartedAtMs as number : input.sinceMs,
    cutoffSource: hasCurrentSession ? 'current_session' : 'report_since',
  };
}

function buildRotationDetectorReplayTokenStats(
  tokenMint: string,
  rows: JsonRow[],
  nowMs: number
): RotationDetectorReplayTokenStats {
  const sorted = rows
    .filter((row) => Number.isFinite(rowKolTxTimeMs(row)))
    .sort((a, b) => rowKolTxTimeMs(a) - rowKolTxTimeMs(b));
  const buyRows = sorted.filter((row) => rowKolTxActionNormalized(row) === 'buy');
  const sellRows = sorted.filter((row) => rowKolTxActionNormalized(row) === 'sell');
  const firstBuyMs = buyRows.length > 0 ? rowKolTxTimeMs(buyRows[0]) : NaN;
  const lastBuyMs = buyRows.length > 0 ? rowKolTxTimeMs(buyRows[buyRows.length - 1]) : NaN;
  const latestSellMs = sellRows.length > 0 ? Math.max(...sellRows.map(rowKolTxTimeMs)) : NaN;
  const recentSellRows = Number.isFinite(lastBuyMs)
    ? sellRows.filter((row) => {
        const t = rowKolTxTimeMs(row);
        return Number.isFinite(t) &&
          t >= lastBuyMs - ROTATION_REPLAY_RECENT_SELL_SEC * 1000 &&
          t <= lastBuyMs + ROTATION_REPLAY_RECENT_SELL_SEC * 1000;
      })
    : sellRows;
  const grossBuySol = buyRows.reduce((sum, row) => sum + Math.max(0, rowKolTxSol(row)), 0);
  const smallBuyRows = buyRows.filter((row) => rowKolTxSol(row) <= ROTATION_REPLAY_SMALL_BUY_MAX_SOL).length;
  const eligibleUnderfillBuyRows = buyRows.filter(isUnderfillEligibleKolTx).length;
  const lastBuyAgeSec = Number.isFinite(lastBuyMs) && Number.isFinite(nowMs)
    ? Math.max(0, (nowMs - lastBuyMs) / 1000)
    : null;
  const vanillaBlockers: string[] = [];
  if (buyRows.length === 0) {
    vanillaBlockers.push('no_buy_rows');
  } else {
    if (buyRows.length < ROTATION_REPLAY_MIN_BUY_COUNT) vanillaBlockers.push('insufficient_buy_count');
    if (smallBuyRows < ROTATION_REPLAY_MIN_SMALL_BUY_COUNT) vanillaBlockers.push('insufficient_small_buys');
    if (grossBuySol < ROTATION_REPLAY_MIN_GROSS_BUY_SOL) vanillaBlockers.push('insufficient_gross_buy_sol');
    if (lastBuyAgeSec != null && lastBuyAgeSec > ROTATION_REPLAY_MAX_LAST_BUY_AGE_SEC) {
      vanillaBlockers.push('stale_last_buy');
    }
    if (recentSellRows.length > 0) vanillaBlockers.push('recent_same_mint_sell');
  }
  if (vanillaBlockers.length === 0) vanillaBlockers.push('needs_price_response');

  const underfillBlockers: string[] = [];
  if (buyRows.length === 0) {
    underfillBlockers.push('underfill_no_buy_rows');
  } else {
    if (eligibleUnderfillBuyRows === 0) underfillBlockers.push('underfill_no_s_or_a_buy');
    if (recentSellRows.length > 0) underfillBlockers.push('underfill_recent_same_mint_sell');
    if (lastBuyAgeSec != null && lastBuyAgeSec > ROTATION_UNDERFILL_REPLAY_MAX_LAST_BUY_AGE_SEC) {
      underfillBlockers.push('underfill_stale_last_buy');
    }
  }
  if (underfillBlockers.length === 0) underfillBlockers.push('underfill_needs_price_context');

  return {
    tokenMint,
    shortMint: shortTokenMint(tokenMint),
    txRows: sorted.length,
    buyRows: buyRows.length,
    sellRows: sellRows.length,
    grossBuySol,
    smallBuyRows,
    eligibleUnderfillBuyRows,
    distinctKols: new Set(sorted.map(rowKolId).filter((value) => value !== '(unknown)')).size,
    firstBuyAt: Number.isFinite(firstBuyMs) ? new Date(firstBuyMs).toISOString() : null,
    lastBuyAt: Number.isFinite(lastBuyMs) ? new Date(lastBuyMs).toISOString() : null,
    latestSellAt: Number.isFinite(latestSellMs) ? new Date(latestSellMs).toISOString() : null,
    lastBuyAgeSec,
    recentSellRows: recentSellRows.length,
    vanillaBlockers,
    underfillBlockers,
    topKols: countByLabel(sorted.map(rowKolId), 'kol').slice(0, 3) as Array<{ kol: string; count: number }>,
  };
}

interface RotationDetectorReplayBuild {
  cutoffMs: number;
  cutoffSource: 'current_session' | 'report_since';
  since: string;
  kolTxRows: JsonRow[];
  kolBuyRows: JsonRow[];
  kolSellRows: JsonRow[];
  allTokens: RotationDetectorReplayTokenStats[];
  topVanillaBlockers: Array<{ blocker: string; count: number }>;
  topUnderfillBlockers: Array<{ blocker: string; count: number }>;
}

function buildRotationDetectorReplay(input: {
  sinceMs: number;
  currentSessionStartedAtMs?: number;
  kolTxRows: JsonRow[];
}): RotationDetectorReplayBuild {
  const cutoff = rotationReplayCutoff(input);
  const kolTxRows = input.kolTxRows.filter((row) => {
    const t = rowKolTxTimeMs(row);
    return Number.isFinite(t) && t >= cutoff.cutoffMs;
  });
  const kolBuyRows = kolTxRows.filter((row) => rowKolTxActionNormalized(row) === 'buy');
  const kolSellRows = kolTxRows.filter((row) => rowKolTxActionNormalized(row) === 'sell');
  const byToken = new Map<string, JsonRow[]>();
  for (const row of kolTxRows) {
    const tokenMint = rowTokenMint(row);
    if (!tokenMint) continue;
    byToken.set(tokenMint, [...(byToken.get(tokenMint) ?? []), row]);
  }
  const allTokens = [...byToken.entries()]
    .map(([tokenMint, rows]) => {
      const rowTimes = rows.map(rowKolTxTimeMs).filter(Number.isFinite);
      const tokenNowMs = rowTimes.length > 0 ? Math.max(...rowTimes) : cutoff.cutoffMs;
      return buildRotationDetectorReplayTokenStats(tokenMint, rows, tokenNowMs);
    })
    .sort((a, b) => b.txRows - a.txRows || b.buyRows - a.buyRows || a.tokenMint.localeCompare(b.tokenMint));
  const vanillaBlockers = allTokens.flatMap((row) => row.vanillaBlockers);
  const underfillBlockers = allTokens.flatMap((row) => row.underfillBlockers);
  const topVanillaBlockers = countByLabel(vanillaBlockers, 'blocker').slice(0, 6) as Array<{ blocker: string; count: number }>;
  const topUnderfillBlockers = countByLabel(underfillBlockers, 'blocker').slice(0, 6) as Array<{ blocker: string; count: number }>;
  return {
    cutoffMs: cutoff.cutoffMs,
    cutoffSource: cutoff.cutoffSource,
    since: new Date(cutoff.cutoffMs).toISOString(),
    kolTxRows,
    kolBuyRows,
    kolSellRows,
    allTokens,
    topVanillaBlockers,
    topUnderfillBlockers,
  };
}

function buildRotationDetectorReplayStats(input: {
  sinceMs: number;
  currentSessionStartedAtMs?: number;
  kolTxRows: JsonRow[];
}): RotationDetectorReplayStats {
  const replay = buildRotationDetectorReplay(input);
  const scopeLabel = replay.cutoffSource === 'current_session' ? 'current-session' : 'report-window';
  const tokens = replay.allTokens.slice(0, 12);
  const vanillaBlockers = replay.allTokens.flatMap((row) => row.vanillaBlockers);
  const underfillBlockers = replay.allTokens.flatMap((row) => row.underfillBlockers);
  const reasons: string[] = [];
  let verdict: RotationDetectorReplayVerdict = 'COLLECT';
  if (replay.kolTxRows.length === 0) {
    verdict = 'NO_KOL_TX';
    reasons.push(`no ${scopeLabel} KOL tx rows to replay against rotation detector defaults`);
  } else if (
    vanillaBlockers.includes('recent_same_mint_sell') ||
    underfillBlockers.includes('underfill_recent_same_mint_sell')
  ) {
    verdict = 'BLOCKED_BY_RECENT_SELL';
    reasons.push(`${scopeLabel} KOL flow includes same-mint sell pressure inside the rotation replay window`);
  } else if (
    vanillaBlockers.includes('insufficient_buy_count') ||
    vanillaBlockers.includes('insufficient_small_buys') ||
    vanillaBlockers.includes('insufficient_gross_buy_sol') ||
    underfillBlockers.includes('underfill_no_buy_rows') ||
    underfillBlockers.includes('underfill_no_s_or_a_buy')
  ) {
    verdict = 'INSUFFICIENT_BUY_DEPTH';
    reasons.push(`${scopeLabel} buy depth does not satisfy rotation replay defaults`);
  } else if (
    vanillaBlockers.includes('needs_price_response') ||
    underfillBlockers.includes('underfill_needs_price_context')
  ) {
    verdict = 'NEEDS_PRICE_CONTEXT';
    reasons.push('detector shape reached the price-response or underfill discount check; report replay has no live price context');
  } else {
    reasons.push('rotation detector replay is collecting more current-session evidence');
  }

  return {
    verdict,
    reasons,
    cutoffSource: replay.cutoffSource,
    since: replay.since,
    tokenRows: replay.allTokens.length,
    kolTxRows: replay.kolTxRows.length,
    kolBuyRows: replay.kolBuyRows.length,
    kolSellRows: replay.kolSellRows.length,
    topVanillaBlockers: replay.topVanillaBlockers,
    topUnderfillBlockers: replay.topUnderfillBlockers,
    tokens,
  };
}

function isUnderfillPriceContextReplayToken(row: RotationDetectorReplayTokenStats): boolean {
  return row.underfillBlockers.length === 1 &&
    row.underfillBlockers[0] === 'underfill_needs_price_context';
}

function summarizeDetectorBlockerTokenMarkout(
  token: RotationDetectorReplayTokenStats,
  rows: JsonRow[],
  horizonsSec: number[],
  roundTripCostPct: number
): RotationDetectorBlockerTokenMarkoutStats {
  const horizonStats = summarize(rows, horizonsSec, roundTripCostPct);
  const primary = horizonStats.find((row) => row.horizonSec === 30) ?? horizonStats[0];
  const best = horizonStats
    .filter((row) => row.medianPostCostDeltaPct != null)
    .sort((a, b) => (b.medianPostCostDeltaPct ?? -Infinity) - (a.medianPostCostDeltaPct ?? -Infinity))[0];
  return {
    tokenMint: token.tokenMint,
    shortMint: token.shortMint,
    txRows: token.txRows,
    buyRows: token.buyRows,
    sellRows: token.sellRows,
    markoutRows: rows.length,
    primaryMedianPostCostDeltaPct: primary?.medianPostCostDeltaPct ?? null,
    bestHorizonSec: best?.horizonSec ?? null,
    bestMedianPostCostDeltaPct: best?.medianPostCostDeltaPct ?? null,
    topKols: token.topKols,
  };
}

function summarizeRotationDetectorBlockerBucket(input: {
  scope: 'underfill' | 'vanilla';
  blocker: string;
  tokens: RotationDetectorReplayTokenStats[];
  markoutsByMint: Map<string, JsonRow[]>;
  horizonsSec: number[];
  roundTripCostPct: number;
}): RotationDetectorBlockerMarkoutBucketStats {
  const markoutRows = input.tokens.flatMap((token) => input.markoutsByMint.get(token.tokenMint) ?? []);
  const markoutTokenRows = input.tokens.filter((token) => (input.markoutsByMint.get(token.tokenMint) ?? []).length > 0).length;
  const horizons = summarize(markoutRows, input.horizonsSec, input.roundTripCostPct);
  const okCoverages = horizons
    .filter((row) => row.rows > 0)
    .map((row) => row.okRows / row.rows);
  const minOkCoverage = okCoverages.length > 0 ? Math.min(...okCoverages) : null;
  const primary = horizons.find((row) => row.horizonSec === 30) ?? horizons[0];
  const primaryPostCostPositiveRate = primary && primary.okRows > 0
    ? primary.positivePostCostRows / primary.okRows
    : null;
  const tokenCoverage = ratio(markoutTokenRows, input.tokens.length);
  const reasons: string[] = [];
  let verdict: RotationDetectorBlockerMarkoutVerdict = 'COLLECT';

  if (markoutRows.length === 0) {
    verdict = 'NO_MARKOUT_COVERAGE';
    reasons.push('blocker has no report-window buy markout rows');
  } else if ((tokenCoverage ?? 0) < 0.2) {
    verdict = 'COLLECT';
    reasons.push(`token markout coverage ${formatPct(tokenCoverage)} < 20.00%`);
  } else if ((minOkCoverage ?? 0) < EVIDENCE_MIN_OK_COVERAGE) {
    verdict = 'COLLECT';
    reasons.push(`markout ok coverage ${formatPct(minOkCoverage)} < ${formatPct(EVIDENCE_MIN_OK_COVERAGE)}`);
  } else if ((primary?.medianPostCostDeltaPct ?? 0) <= 0 || (primaryPostCostPositiveRate ?? 0) < 0.5) {
    verdict = 'BLOCKER_PROTECTS';
    reasons.push(`T+${primary?.horizonSec ?? 'n/a'} post-cost median ${formatPct(primary?.medianPostCostDeltaPct ?? null)}, positive ${formatPct(primaryPostCostPositiveRate)}`);
  } else {
    verdict = 'BLOCKER_REVIEW_CANDIDATE';
    reasons.push(`covered blocker tokens show positive T+${primary.horizonSec}s post-cost markout; detector relaxation still requires paper-only route proof`);
  }

  const topTokens = input.tokens
    .map((token) => summarizeDetectorBlockerTokenMarkout(
      token,
      input.markoutsByMint.get(token.tokenMint) ?? [],
      input.horizonsSec,
      input.roundTripCostPct
    ))
    .sort((a, b) =>
      b.markoutRows - a.markoutRows ||
      (b.bestMedianPostCostDeltaPct ?? -Infinity) - (a.bestMedianPostCostDeltaPct ?? -Infinity) ||
      b.txRows - a.txRows ||
      a.tokenMint.localeCompare(b.tokenMint)
    )
    .slice(0, 8);

  return {
    scope: input.scope,
    blocker: input.blocker,
    verdict,
    reasons,
    tokenRows: input.tokens.length,
    markoutTokenRows,
    tokenCoverage,
    buyMarkoutRows: markoutRows.length,
    minOkCoverage,
    primaryHorizonSec: primary?.horizonSec ?? null,
    primaryMedianPostCostDeltaPct: primary?.medianPostCostDeltaPct ?? null,
    primaryPostCostPositiveRate,
    horizons,
    topKols: countByLabel(input.tokens.flatMap((token) =>
      token.topKols.map((item) => item.kol)
    ), 'kol').slice(0, 6) as Array<{ kol: string; count: number }>,
    topTokens,
  };
}

function buildRotationDetectorBlockerMarkouts(input: {
  sinceMs: number;
  kolTxRows: JsonRow[];
  tradeMarkoutRows: JsonRow[];
  horizonsSec: number[];
  roundTripCostPct: number;
}): RotationDetectorBlockerMarkoutStats {
  const replay = buildRotationDetectorReplay({
    sinceMs: input.sinceMs,
    kolTxRows: input.kolTxRows,
  });
  const buyMarkoutRows = input.tradeMarkoutRows.filter((row) => str(row.anchorType) === 'buy');
  const markoutsByMint = new Map<string, JsonRow[]>();
  for (const row of buyMarkoutRows) {
    const mint = rowTokenMintDeep(row);
    if (mint) markoutsByMint.set(mint, [...(markoutsByMint.get(mint) ?? []), row]);
  }
  const buckets = new Map<string, {
    scope: 'underfill' | 'vanilla';
    blocker: string;
    tokens: RotationDetectorReplayTokenStats[];
  }>();
  for (const token of replay.allTokens) {
    for (const blocker of token.underfillBlockers) {
      const key = `underfill:${blocker}`;
      const bucket = buckets.get(key) ?? { scope: 'underfill' as const, blocker, tokens: [] };
      bucket.tokens.push(token);
      buckets.set(key, bucket);
    }
    for (const blocker of token.vanillaBlockers) {
      const key = `vanilla:${blocker}`;
      const bucket = buckets.get(key) ?? { scope: 'vanilla' as const, blocker, tokens: [] };
      bucket.tokens.push(token);
      buckets.set(key, bucket);
    }
  }
  const topBuckets = [...buckets.values()]
    .map((bucket) => summarizeRotationDetectorBlockerBucket({
      scope: bucket.scope,
      blocker: bucket.blocker,
      tokens: bucket.tokens,
      markoutsByMint,
      horizonsSec: input.horizonsSec,
      roundTripCostPct: input.roundTripCostPct,
    }))
    .sort((a, b) =>
      (a.scope === 'underfill' ? 0 : 1) - (b.scope === 'underfill' ? 0 : 1) ||
      b.tokenRows - a.tokenRows ||
      b.buyMarkoutRows - a.buyMarkoutRows ||
      a.blocker.localeCompare(b.blocker)
    )
    .slice(0, 12);

  return {
    since: replay.since,
    cutoffSource: 'report_since',
    tokenRows: replay.allTokens.length,
    buyMarkoutRows: buyMarkoutRows.length,
    topBuckets,
  };
}

function staleBuyAgeBucket(token: RotationDetectorReplayTokenStats): string {
  const age = token.lastBuyAgeSec;
  if (age == null) return 'age_unknown';
  if (age <= 60) return 'age_45_60s';
  if (age <= 120) return 'age_60_120s';
  if (age <= 300) return 'age_120_300s';
  return 'age_300s_plus';
}

function staleBuyDepthBucket(token: RotationDetectorReplayTokenStats): string {
  const kolBucket = token.distinctKols >= 2 ? '2plus_kol' : '1kol';
  const grossBucket = token.grossBuySol >= ROTATION_REPLAY_MIN_GROSS_BUY_SOL ? 'gross_ok' : 'gross_low';
  return `${kolBucket}_${grossBucket}`;
}

function staleBuyReviewBucket(token: RotationDetectorReplayTokenStats): string {
  return `${staleBuyAgeBucket(token)}:${staleBuyDepthBucket(token)}`;
}

function isRotationStaleBuyPaperProbe(row: JsonRow): boolean {
  const extras = obj(row.extras);
  return str(row.lane) === 'kol_hunter' &&
    (str(extras.eventType) === 'rotation_underfill_no_trade' ||
      str(row.signalSource) === 'rotation_underfill_v1') &&
    (str(extras.noTradeReason) === 'underfill_stale_last_buy' ||
      str(row.rejectReason) === 'rotation_underfill_underfill_stale_last_buy');
}

function isKolPaperProbe(row: JsonRow): boolean {
  return str(row.lane) === 'kol_hunter' && (rowHorizon(row) ?? 0) > 0;
}

function summarizeStaleBuyMissingToken(token: RotationDetectorReplayTokenStats): RotationStaleBuyMissingTokenStats {
  return {
    tokenMint: token.tokenMint,
    shortMint: token.shortMint,
    txRows: token.txRows,
    buyRows: token.buyRows,
    sellRows: token.sellRows,
    lastBuyAgeSec: token.lastBuyAgeSec,
    grossBuySol: token.grossBuySol,
    distinctKols: token.distinctKols,
    topKols: token.topKols,
  };
}

function summarizeRotationStaleBuyBucket(input: {
  bucket: string;
  tokens: RotationDetectorReplayTokenStats[];
  markoutsByMint: Map<string, JsonRow[]>;
  paperProbesByMint: Map<string, JsonRow[]>;
  allPaperProbesByMint: Map<string, JsonRow[]>;
  horizonsSec: number[];
  roundTripCostPct: number;
}): RotationStaleBuyBucketStats {
  const markoutRows = input.tokens.flatMap((token) => input.markoutsByMint.get(token.tokenMint) ?? []);
  const markoutTokenRows = input.tokens.filter((token) => (input.markoutsByMint.get(token.tokenMint) ?? []).length > 0).length;
  const missingTokens = input.tokens.filter((token) => (input.markoutsByMint.get(token.tokenMint) ?? []).length === 0);
  const paperProbeRows = input.tokens.flatMap((token) => input.paperProbesByMint.get(token.tokenMint) ?? []);
  const paperProbeTokenRows = input.tokens.filter((token) => (input.paperProbesByMint.get(token.tokenMint) ?? []).length > 0).length;
  const unmeasuredTokens = input.tokens.filter((token) =>
    (input.markoutsByMint.get(token.tokenMint) ?? []).length === 0 &&
    (input.paperProbesByMint.get(token.tokenMint) ?? []).length === 0
  );
  const otherPaperProbeTokens = unmeasuredTokens.filter((token) =>
    (input.allPaperProbesByMint.get(token.tokenMint) ?? []).length > 0
  );
  const otherPaperProbeRows = otherPaperProbeTokens.flatMap((token) =>
    input.allPaperProbesByMint.get(token.tokenMint) ?? []
  );
  const darkTokens = unmeasuredTokens.filter((token) =>
    (input.allPaperProbesByMint.get(token.tokenMint) ?? []).length === 0
  );
  const horizons = summarize(markoutRows, input.horizonsSec, input.roundTripCostPct);
  const paperProbeHorizons = summarize(paperProbeRows, input.horizonsSec, input.roundTripCostPct);
  const okCoverages = horizons
    .filter((row) => row.rows > 0)
    .map((row) => row.okRows / row.rows);
  const minOkCoverage = okCoverages.length > 0 ? Math.min(...okCoverages) : null;
  const paperProbeOkCoverages = paperProbeHorizons
    .filter((row) => row.rows > 0)
    .map((row) => row.okRows / row.rows);
  const paperProbeMinOkCoverage = paperProbeOkCoverages.length > 0 ? Math.min(...paperProbeOkCoverages) : null;
  const primary = horizons.find((row) => row.horizonSec === 30) ?? horizons[0];
  const paperProbePrimary = paperProbeHorizons.find((row) => row.horizonSec === 30) ?? paperProbeHorizons[0];
  const primaryPostCostPositiveRate = primary && primary.okRows > 0
    ? primary.positivePostCostRows / primary.okRows
    : null;
  const paperProbePrimaryPostCostPositiveRate = paperProbePrimary && paperProbePrimary.okRows > 0
    ? paperProbePrimary.positivePostCostRows / paperProbePrimary.okRows
    : null;
  const tokenCoverage = ratio(markoutTokenRows, input.tokens.length);
  const reasons: string[] = [];
  let verdict: RotationStaleBuyReviewVerdict = 'COLLECT';

  if (markoutRows.length === 0) {
    verdict = 'COLLECT';
    reasons.push('stale-buy bucket has no buy markout coverage');
  } else if (input.tokens.length < 10) {
    verdict = 'COLLECT';
    reasons.push(`bucket tokens ${input.tokens.length} < 10`);
  } else if ((tokenCoverage ?? 0) < 0.2) {
    verdict = 'COLLECT';
    reasons.push(`token markout coverage ${formatPct(tokenCoverage)} < 20.00%`);
  } else if ((minOkCoverage ?? 0) < EVIDENCE_MIN_OK_COVERAGE) {
    verdict = 'COLLECT';
    reasons.push(`markout ok coverage ${formatPct(minOkCoverage)} < ${formatPct(EVIDENCE_MIN_OK_COVERAGE)}`);
  } else if ((primary?.medianPostCostDeltaPct ?? 0) <= 0 || (primaryPostCostPositiveRate ?? 0) < 0.55) {
    verdict = 'STALE_BUY_REJECT';
    reasons.push(`T+${primary?.horizonSec ?? 'n/a'} post-cost median ${formatPct(primary?.medianPostCostDeltaPct ?? null)}, positive ${formatPct(primaryPostCostPositiveRate)}`);
  } else {
    verdict = 'PAPER_STALE_REVIEW_CANDIDATE';
    reasons.push(`stale-buy bucket has positive T+${primary.horizonSec}s post-cost markout; paper-only route-proof review required`);
  }

  const topTokens = input.tokens
    .map((token) => summarizeDetectorBlockerTokenMarkout(
      token,
      input.markoutsByMint.get(token.tokenMint) ?? [],
      input.horizonsSec,
      input.roundTripCostPct
    ))
    .sort((a, b) =>
      b.markoutRows - a.markoutRows ||
      (b.bestMedianPostCostDeltaPct ?? -Infinity) - (a.bestMedianPostCostDeltaPct ?? -Infinity) ||
      b.txRows - a.txRows ||
      a.tokenMint.localeCompare(b.tokenMint)
    )
    .slice(0, 8);

  return {
    bucket: input.bucket,
    verdict,
    reasons,
    tokenRows: input.tokens.length,
    markoutTokenRows,
    missingMarkoutTokenRows: missingTokens.length,
    paperProbeTokenRows,
    paperProbeRows: paperProbeRows.length,
    paperProbeOkRows: paperProbeRows.filter(isOk).length,
    paperProbeMinOkCoverage,
    paperProbePrimaryMedianPostCostDeltaPct: paperProbePrimary?.medianPostCostDeltaPct ?? null,
    paperProbePrimaryPostCostPositiveRate,
    otherPaperProbeTokenRows: otherPaperProbeTokens.length,
    otherPaperProbeRows: otherPaperProbeRows.length,
    darkTokenRows: darkTokens.length,
    unmeasuredTokenRows: unmeasuredTokens.length,
    tokenCoverage,
    buyMarkoutRows: markoutRows.length,
    minOkCoverage,
    primaryHorizonSec: primary?.horizonSec ?? null,
    primaryMedianPostCostDeltaPct: primary?.medianPostCostDeltaPct ?? null,
    primaryPostCostPositiveRate,
    medianLastBuyAgeSec: percentile(input.tokens
      .map((token) => token.lastBuyAgeSec)
      .filter((value): value is number => value != null), 0.5),
    medianGrossBuySol: percentile(input.tokens.map((token) => token.grossBuySol), 0.5),
    topKols: countByLabel(input.tokens.flatMap((token) =>
      token.topKols.map((item) => item.kol)
    ), 'kol').slice(0, 6) as Array<{ kol: string; count: number }>,
    topMissingKols: countByLabel(missingTokens.flatMap((token) =>
      token.topKols.map((item) => item.kol)
    ), 'kol').slice(0, 6) as Array<{ kol: string; count: number }>,
    topUnmeasuredKols: countByLabel(unmeasuredTokens.flatMap((token) =>
      token.topKols.map((item) => item.kol)
    ), 'kol').slice(0, 6) as Array<{ kol: string; count: number }>,
    topDarkKols: countByLabel(darkTokens.flatMap((token) =>
      token.topKols.map((item) => item.kol)
    ), 'kol').slice(0, 6) as Array<{ kol: string; count: number }>,
    topOtherPaperProbeReasons: countByLabel(otherPaperProbeRows.map(rowMissedAlphaRejectReason), 'reason').slice(0, 6) as Array<{ reason: string; count: number }>,
    topTokens,
    topMissingTokens: missingTokens
      .map(summarizeStaleBuyMissingToken)
      .sort((a, b) =>
        b.txRows - a.txRows ||
        b.buyRows - a.buyRows ||
        b.grossBuySol - a.grossBuySol ||
        a.tokenMint.localeCompare(b.tokenMint)
      )
      .slice(0, 8),
    topUnmeasuredTokens: unmeasuredTokens
      .map(summarizeStaleBuyMissingToken)
      .sort((a, b) =>
        b.txRows - a.txRows ||
        b.buyRows - a.buyRows ||
        b.grossBuySol - a.grossBuySol ||
        a.tokenMint.localeCompare(b.tokenMint)
      )
      .slice(0, 8),
    topDarkTokens: darkTokens
      .map(summarizeStaleBuyMissingToken)
      .sort((a, b) =>
        b.txRows - a.txRows ||
        b.buyRows - a.buyRows ||
        b.grossBuySol - a.grossBuySol ||
        a.tokenMint.localeCompare(b.tokenMint)
      )
      .slice(0, 8),
  };
}

function buildRotationStaleBuyReview(input: {
  sinceMs: number;
  kolTxRows: JsonRow[];
  tradeMarkoutRows: JsonRow[];
  missedAlphaRows: JsonRow[];
  horizonsSec: number[];
  roundTripCostPct: number;
}): RotationStaleBuyReviewStats {
  const replay = buildRotationDetectorReplay({
    sinceMs: input.sinceMs,
    kolTxRows: input.kolTxRows,
  });
  const staleTokens = replay.allTokens.filter((token) =>
    token.underfillBlockers.includes('underfill_stale_last_buy')
  );
  const candidateTokens = staleTokens.filter((token) =>
    !token.underfillBlockers.includes('underfill_recent_same_mint_sell')
  );
  const buyMarkoutRows = input.tradeMarkoutRows.filter((row) => str(row.anchorType) === 'buy');
  const markoutsByMint = new Map<string, JsonRow[]>();
  for (const row of buyMarkoutRows) {
    const mint = rowTokenMintDeep(row);
    if (mint) markoutsByMint.set(mint, [...(markoutsByMint.get(mint) ?? []), row]);
  }
  const paperProbeRows = input.missedAlphaRows.filter(isRotationStaleBuyPaperProbe);
  const paperProbesByMint = new Map<string, JsonRow[]>();
  for (const row of paperProbeRows) {
    const mint = rowTokenMintDeep(row);
    if (mint) paperProbesByMint.set(mint, [...(paperProbesByMint.get(mint) ?? []), row]);
  }
  const allPaperProbeRows = input.missedAlphaRows.filter(isKolPaperProbe);
  const allPaperProbesByMint = new Map<string, JsonRow[]>();
  for (const row of allPaperProbeRows) {
    const mint = rowTokenMintDeep(row);
    if (mint) allPaperProbesByMint.set(mint, [...(allPaperProbesByMint.get(mint) ?? []), row]);
  }
  const byBucket = new Map<string, RotationDetectorReplayTokenStats[]>();
  for (const token of candidateTokens) {
    const bucket = staleBuyReviewBucket(token);
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), token]);
  }
  const buckets = [...byBucket.entries()]
    .map(([bucket, tokens]) => summarizeRotationStaleBuyBucket({
      bucket,
      tokens,
      markoutsByMint,
      paperProbesByMint,
      allPaperProbesByMint,
      horizonsSec: input.horizonsSec,
      roundTripCostPct: input.roundTripCostPct,
    }))
    .sort((a, b) =>
      b.tokenRows - a.tokenRows ||
      b.buyMarkoutRows - a.buyMarkoutRows ||
      (b.primaryMedianPostCostDeltaPct ?? -Infinity) - (a.primaryMedianPostCostDeltaPct ?? -Infinity) ||
      a.bucket.localeCompare(b.bucket)
    );

  return {
    since: replay.since,
    tokenRows: staleTokens.length,
    candidateTokenRows: candidateTokens.length,
    excludedRecentSellTokenRows: staleTokens.length - candidateTokens.length,
    buyMarkoutRows: buyMarkoutRows.length,
    paperProbeRows: paperProbeRows.length,
    buckets,
  };
}

function isKolHunterAdmissionSkipProbe(row: JsonRow): boolean {
  const extras = obj(row.extras);
  return str(row.lane) === 'kol_hunter' && (
    str(extras.eventType) === 'kol_hunter_admission_skip' ||
    str(row.signalSource) === 'kol_hunter_admission_skip' ||
    str(row.rejectReason) === 'kol_hunter_max_concurrent_skip'
  );
}

function rowMissedAlphaKolIds(row: JsonRow): string[] {
  const extras = obj(row.extras);
  const fromParticipants = rowPolicyParticipants(row).map((item) => item.id);
  const direct = [
    str(extras.kolId),
    str(row.kolId),
    str(extras.kol),
    str(row.kol),
  ].filter((value) => value.length > 0);
  const ids = [...fromParticipants, ...direct].filter((value) => value !== '(unknown)');
  return ids.length > 0 ? ids : ['(unknown)'];
}

function summarizeAdmissionSkipToken(input: {
  tokenMint: string;
  rows: JsonRow[];
  horizonsSec: number[];
  roundTripCostPct: number;
}): KolHunterAdmissionSkipTokenStats {
  const probeRows = input.rows.filter((row) => (rowHorizon(row) ?? 0) > 0);
  const horizons = summarize(probeRows, input.horizonsSec, input.roundTripCostPct);
  const best = horizons
    .filter((row) => row.medianPostCostDeltaPct != null)
    .sort((a, b) => (b.medianPostCostDeltaPct ?? -Infinity) - (a.medianPostCostDeltaPct ?? -Infinity))[0];
  return {
    tokenMint: input.tokenMint,
    shortMint: shortTokenMint(input.tokenMint),
    rows: input.rows.length,
    probeRows: probeRows.length,
    okRows: probeRows.filter(isOk).length,
    bestHorizonSec: best?.horizonSec ?? null,
    bestMedianPostCostDeltaPct: best?.medianPostCostDeltaPct ?? null,
    topKols: countByLabel(input.rows.flatMap(rowMissedAlphaKolIds), 'kol').slice(0, 5) as Array<{ kol: string; count: number }>,
  };
}

function buildKolHunterAdmissionSkipMarkouts(input: {
  sinceMs: number;
  missedAlphaRows: JsonRow[];
  horizonsSec: number[];
  roundTripCostPct: number;
}): KolHunterAdmissionSkipMarkoutStats {
  const rows = input.missedAlphaRows.filter(isKolHunterAdmissionSkipProbe);
  const probeRows = rows.filter((row) => (rowHorizon(row) ?? 0) > 0);
  const horizons = summarize(probeRows, input.horizonsSec, input.roundTripCostPct);
  const okCoverages = horizons
    .filter((row) => row.rows > 0)
    .map((row) => row.okRows / row.rows);
  const minOkCoverage = okCoverages.length > 0 ? Math.min(...okCoverages) : null;
  const primary = horizons.find((row) => row.horizonSec === 30) ?? horizons[0];
  const primaryPostCostPositiveRate = primary && primary.okRows > 0
    ? primary.positivePostCostRows / primary.okRows
    : null;
  const byMint = new Map<string, JsonRow[]>();
  for (const row of rows) {
    const mint = rowTokenMintDeep(row) || '(unknown)';
    byMint.set(mint, [...(byMint.get(mint) ?? []), row]);
  }
  const topTokens = [...byMint.entries()]
    .map(([tokenMint, scoped]) => summarizeAdmissionSkipToken({
      tokenMint,
      rows: scoped,
      horizonsSec: input.horizonsSec,
      roundTripCostPct: input.roundTripCostPct,
    }))
    .sort((a, b) =>
      b.probeRows - a.probeRows ||
      (b.bestMedianPostCostDeltaPct ?? -Infinity) - (a.bestMedianPostCostDeltaPct ?? -Infinity) ||
      a.tokenMint.localeCompare(b.tokenMint)
    )
    .slice(0, 8);

  const reasons: string[] = [];
  let verdict: KolHunterAdmissionSkipMarkoutVerdict = 'NO_ROWS';
  if (rows.length === 0) {
    reasons.push('no admission-skip paper probes in report window');
  } else if (probeRows.length < 10) {
    verdict = 'COLLECT';
    reasons.push(`admission-skip probe rows ${probeRows.length} < 10`);
  } else if ((minOkCoverage ?? 0) < EVIDENCE_MIN_OK_COVERAGE) {
    verdict = 'COLLECT';
    reasons.push(`probe ok coverage ${formatPct(minOkCoverage)} < ${formatPct(EVIDENCE_MIN_OK_COVERAGE)}`);
  } else if ((primary?.medianPostCostDeltaPct ?? 0) <= 0 || (primaryPostCostPositiveRate ?? 0) < 0.55) {
    verdict = 'NEGATIVE_AFTER_COST';
    reasons.push(`T+${primary?.horizonSec ?? 'n/a'} post-cost median ${formatPct(primary?.medianPostCostDeltaPct ?? null)}, positive ${formatPct(primaryPostCostPositiveRate)}`);
  } else {
    verdict = 'PAPER_REVIEW_CANDIDATE';
    reasons.push('admission-skip paper probes are positive after cost; review capacity policy separately before any live change');
  }

  return {
    since: new Date(input.sinceMs).toISOString(),
    verdict,
    reasons,
    rows: rows.length,
    probeRows: probeRows.length,
    okRows: probeRows.filter(isOk).length,
    tokenRows: byMint.size,
    maxConcurrentRows: rows.filter((row) => str(row.rejectReason) === 'kol_hunter_max_concurrent_skip').length,
    minOkCoverage,
    primaryHorizonSec: primary?.horizonSec ?? null,
    primaryMedianPostCostDeltaPct: primary?.medianPostCostDeltaPct ?? null,
    primaryPostCostPositiveRate,
    horizons,
    topKols: countByLabel(rows.flatMap(rowMissedAlphaKolIds), 'kol').slice(0, 8) as Array<{ kol: string; count: number }>,
    topReasons: countByLabel(rows.map(rowMissedAlphaRejectReason), 'reason').slice(0, 8) as Array<{ reason: string; count: number }>,
    topTokens,
  };
}

function summarizePriceContextTokenMarkouts(
  token: RotationDetectorReplayTokenStats,
  rows: JsonRow[],
  horizonsSec: number[],
  roundTripCostPct: number
): RotationPriceContextTokenMarkoutStats {
  const horizonStats = summarize(rows, horizonsSec, roundTripCostPct);
  const best = horizonStats
    .filter((row) => row.medianPostCostDeltaPct != null)
    .sort((a, b) => (b.medianPostCostDeltaPct ?? -Infinity) - (a.medianPostCostDeltaPct ?? -Infinity))[0];
  return {
    tokenMint: token.tokenMint,
    shortMint: token.shortMint,
    txRows: token.txRows,
    buyRows: token.buyRows,
    grossBuySol: token.grossBuySol,
    distinctKols: token.distinctKols,
    markoutRows: rows.length,
    okRows: rows.filter(isOk).length,
    bestHorizonSec: best?.horizonSec ?? null,
    bestMedianPostCostDeltaPct: best?.medianPostCostDeltaPct ?? null,
    topKols: token.topKols,
  };
}

function latestBuyAtForReplayToken(token: RotationDetectorReplayTokenStats): string | null {
  return token.lastBuyAt ?? token.firstBuyAt;
}

function gapReasonForPriceContextToken(input: {
  anyMarkoutRows: number;
  missedAlphaRows: number;
  rotationNoTradeRows: number;
  callFunnelRows: number;
  rotationCallFunnelRows: number;
  policyDecisionRows: number;
}): string {
  if (input.anyMarkoutRows > 0) return 'non_buy_markout_only';
  if (
    input.rotationNoTradeRows > 0 ||
    input.rotationCallFunnelRows > 0 ||
    input.policyDecisionRows > 0
  ) {
    return 'runtime_candidate_without_buy_markout';
  }
  if (input.missedAlphaRows > 0 || input.callFunnelRows > 0) {
    return 'non_rotation_runtime_seen_without_buy_markout';
  }
  return 'kol_tx_only_no_probe';
}

function summarizePriceContextCoverageGapToken(input: {
  token: RotationDetectorReplayTokenStats;
  tradeMarkoutRows: JsonRow[];
  missedAlphaRows: JsonRow[];
  callFunnelRows: JsonRow[];
  policyDecisionRows: JsonRow[];
}): RotationPriceContextCoverageGapTokenStats {
  const anyMarkoutRows = input.tradeMarkoutRows.length;
  const missedAlphaRows = input.missedAlphaRows.length;
  const rotationNoTrade = input.missedAlphaRows.filter(isRotationNoTrade);
  const rotationNoTradeRows = input.missedAlphaRows.filter(isRotationNoTrade).length;
  const callFunnelRows = input.callFunnelRows.length;
  const rotationCallFunnelRows = input.callFunnelRows.filter(isRotationCallFunnelRow).length;
  const policyDecisionRows = input.policyDecisionRows.length;
  const rotationPolicyDecisionRows = input.policyDecisionRows.filter(isRotationPolicyDecision);
  const rotationPolicyAttributionDriftRows = rotationPolicyDecisionRows.filter(isRotationPolicyAttributionDrift);
  const gapReason = gapReasonForPriceContextToken({
    anyMarkoutRows,
    missedAlphaRows,
    rotationNoTradeRows,
    callFunnelRows,
    rotationCallFunnelRows,
    policyDecisionRows: rotationPolicyDecisionRows.length,
  });
  return {
    tokenMint: input.token.tokenMint,
    shortMint: input.token.shortMint,
    gapReason,
    txRows: input.token.txRows,
    buyRows: input.token.buyRows,
    grossBuySol: input.token.grossBuySol,
    distinctKols: input.token.distinctKols,
    latestBuyAt: latestBuyAtForReplayToken(input.token),
    anyMarkoutRows,
    missedAlphaRows,
    rotationNoTradeRows,
    callFunnelRows,
    rotationCallFunnelRows,
    policyDecisionRows,
    rotationPolicyDecisionRows: rotationPolicyDecisionRows.length,
    rotationPolicyAttributionDriftRows: rotationPolicyAttributionDriftRows.length,
    topNoTradeReasons: countByLabel(rotationNoTrade.map(rowNoTradeReason), 'reason').slice(0, 3) as Array<{ reason: string; count: number }>,
    topPolicyEntryReasons: countByLabel(input.policyDecisionRows.map(rowPolicyEntryReason), 'reason').slice(0, 3) as Array<{ reason: string; count: number }>,
    topPolicyRejectReasons: countByLabel(input.policyDecisionRows.map(rowPolicyRejectReason), 'reason').slice(0, 3) as Array<{ reason: string; count: number }>,
    topRotationPolicyEntryReasons: countByLabel(rotationPolicyDecisionRows.map(rowPolicyEntryReason), 'reason').slice(0, 3) as Array<{ reason: string; count: number }>,
    topRotationPolicyRejectReasons: countByLabel(rotationPolicyDecisionRows.map(rowPolicyRejectReason), 'reason').slice(0, 3) as Array<{ reason: string; count: number }>,
    topRotationPolicyAttributionDriftReasons: countByLabel(rotationPolicyAttributionDriftRows.map(rowPolicyRejectReason), 'reason').slice(0, 3) as Array<{ reason: string; count: number }>,
    topRotationPolicyAttributionSources: countByLabel(rotationPolicyAttributionDriftRows.map(rowPolicyAttributionSource), 'source').slice(0, 3) as Array<{ source: string; count: number }>,
    topRotationPolicyAttributionSurvivalReasons: countByLabel(rotationPolicyAttributionDriftRows.map(rowPolicyAttributionSurvivalReason), 'reason').slice(0, 3) as Array<{ reason: string; count: number }>,
    topKols: input.token.topKols,
  };
}

function hasRotationSpecificGapEvidence(row: RotationPriceContextCoverageGapTokenStats): boolean {
  return row.rotationNoTradeRows > 0 ||
    row.rotationCallFunnelRows > 0 ||
    row.rotationPolicyDecisionRows > 0;
}

function buildRotationPriceContextCoverageGap(input: {
  candidates: RotationDetectorReplayTokenStats[];
  buyMarkoutRows: JsonRow[];
  tradeMarkoutRows: JsonRow[];
  missedAlphaRows: JsonRow[];
  callFunnelRows: JsonRow[];
  policyDecisionRows: JsonRow[];
}): RotationPriceContextCoverageGapStats {
  const coveredMints = new Set(input.buyMarkoutRows.map(rowTokenMintDeep).filter(Boolean));
  const missing = input.candidates.filter((row) => !coveredMints.has(row.tokenMint));
  const missingMints = new Set(missing.map((row) => row.tokenMint));
  const byMarkoutMint = new Map<string, JsonRow[]>();
  const byMissedAlphaMint = new Map<string, JsonRow[]>();
  const byCallFunnelMint = new Map<string, JsonRow[]>();
  const byPolicyMint = new Map<string, JsonRow[]>();
  for (const row of input.tradeMarkoutRows) {
    const mint = rowTokenMintDeep(row);
    if (mint) byMarkoutMint.set(mint, [...(byMarkoutMint.get(mint) ?? []), row]);
  }
  for (const row of input.missedAlphaRows) {
    const mint = rowTokenMintDeep(row);
    if (mint) byMissedAlphaMint.set(mint, [...(byMissedAlphaMint.get(mint) ?? []), row]);
  }
  for (const row of input.callFunnelRows) {
    const mint = rowTokenMintDeep(row);
    if (mint) byCallFunnelMint.set(mint, [...(byCallFunnelMint.get(mint) ?? []), row]);
  }
  for (const row of input.policyDecisionRows) {
    const mint = rowTokenMintDeep(row);
    if (mint) byPolicyMint.set(mint, [...(byPolicyMint.get(mint) ?? []), row]);
  }
  const topMissingTokens = missing
    .map((token) => summarizePriceContextCoverageGapToken({
      token,
      tradeMarkoutRows: byMarkoutMint.get(token.tokenMint) ?? [],
      missedAlphaRows: byMissedAlphaMint.get(token.tokenMint) ?? [],
      callFunnelRows: byCallFunnelMint.get(token.tokenMint) ?? [],
      policyDecisionRows: byPolicyMint.get(token.tokenMint) ?? [],
    }))
    .sort((a, b) =>
      b.anyMarkoutRows - a.anyMarkoutRows ||
      b.rotationNoTradeRows - a.rotationNoTradeRows ||
      b.txRows - a.txRows ||
      b.grossBuySol - a.grossBuySol ||
      a.tokenMint.localeCompare(b.tokenMint)
    );
  const rotationSpecificMissingTokens = topMissingTokens.filter(hasRotationSpecificGapEvidence);
  const missingRotationPolicyDecisionRows = input.policyDecisionRows
    .filter((row) => missingMints.has(rowTokenMintDeep(row)) && isRotationPolicyDecision(row));
  const missingRotationPolicyAttributionDriftRows = missingRotationPolicyDecisionRows
    .filter(isRotationPolicyAttributionDrift);
  const rotationPolicyAttributionDriftTokens = topMissingTokens
    .filter((row) => row.rotationPolicyAttributionDriftRows > 0);
  return {
    missingBuyMarkoutTokenRows: missing.length,
    missingBuyMarkoutKolTxRows: missing.reduce((sum, row) => sum + row.txRows, 0),
    rotationSpecificMissingTokenRows: rotationSpecificMissingTokens.length,
    rotationSpecificMissingKolTxRows: rotationSpecificMissingTokens.reduce((sum, row) => sum + row.txRows, 0),
    rotationPolicyAttributionDriftTokenRows: rotationPolicyAttributionDriftTokens.length,
    rotationPolicyAttributionDriftRows: missingRotationPolicyAttributionDriftRows.length,
    topMissingReasons: countByLabel(topMissingTokens.map((row) => row.gapReason), 'reason').slice(0, 6) as Array<{ reason: string; count: number }>,
    topMissingKols: countByLabel(missing.flatMap((row) => row.topKols.map((item) => item.kol)), 'kol').slice(0, 8) as Array<{ kol: string; count: number }>,
    topMissingNoTradeReasons: countByLabel(input.missedAlphaRows
      .filter((row) => missingMints.has(rowTokenMintDeep(row)) && isRotationNoTrade(row))
      .map(rowNoTradeReason), 'reason').slice(0, 8) as Array<{ reason: string; count: number }>,
    topMissingPolicyEntryReasons: countByLabel(input.policyDecisionRows
      .filter((row) => missingMints.has(rowTokenMintDeep(row)))
      .map(rowPolicyEntryReason), 'reason').slice(0, 8) as Array<{ reason: string; count: number }>,
    topMissingPolicyRejectReasons: countByLabel(input.policyDecisionRows
      .filter((row) => missingMints.has(rowTokenMintDeep(row)))
      .map(rowPolicyRejectReason), 'reason').slice(0, 8) as Array<{ reason: string; count: number }>,
    topMissingRotationPolicyEntryReasons: countByLabel(missingRotationPolicyDecisionRows
      .map(rowPolicyEntryReason), 'reason').slice(0, 8) as Array<{ reason: string; count: number }>,
    topMissingRotationPolicyRejectReasons: countByLabel(missingRotationPolicyDecisionRows
      .map(rowPolicyRejectReason), 'reason').slice(0, 8) as Array<{ reason: string; count: number }>,
    topMissingRotationPolicyAttributionDriftReasons: countByLabel(missingRotationPolicyAttributionDriftRows
      .map(rowPolicyRejectReason), 'reason').slice(0, 8) as Array<{ reason: string; count: number }>,
    topMissingRotationPolicyAttributionSources: countByLabel(missingRotationPolicyAttributionDriftRows
      .map(rowPolicyAttributionSource), 'source').slice(0, 8) as Array<{ source: string; count: number }>,
    topMissingRotationPolicyAttributionSurvivalReasons: countByLabel(missingRotationPolicyAttributionDriftRows
      .map(rowPolicyAttributionSurvivalReason), 'reason').slice(0, 8) as Array<{ reason: string; count: number }>,
    topMissingTokens: topMissingTokens.slice(0, 12),
  };
}

function buildRotationPriceContextMarkouts(input: {
  sinceMs: number;
  kolTxRows: JsonRow[];
  tradeMarkoutRows: JsonRow[];
  missedAlphaRows: JsonRow[];
  callFunnelRows: JsonRow[];
  policyDecisionRows: JsonRow[];
  horizonsSec: number[];
  roundTripCostPct: number;
}): RotationPriceContextMarkoutStats {
  const replay = buildRotationDetectorReplay({
    sinceMs: input.sinceMs,
    kolTxRows: input.kolTxRows,
  });
  const candidates = replay.allTokens.filter(isUnderfillPriceContextReplayToken);
  const candidateMints = new Set(candidates.map((row) => row.tokenMint));
  const candidateByMint = new Map(candidates.map((row) => [row.tokenMint, row]));
  const candidateKolTxRows = candidates.reduce((sum, row) => sum + row.txRows, 0);
  const buyMarkoutRows = input.tradeMarkoutRows.filter((row) =>
    str(row.anchorType) === 'buy' && candidateMints.has(rowTokenMint(row))
  );
  const markoutTokenRows = new Set(buyMarkoutRows.map(rowTokenMint).filter(Boolean)).size;
  const horizons = summarize(buyMarkoutRows, input.horizonsSec, input.roundTripCostPct);
  const okCoverages = horizons
    .filter((row) => row.rows > 0)
    .map((row) => row.okRows / row.rows);
  const minOkCoverage = okCoverages.length > 0 ? Math.min(...okCoverages) : null;
  const markoutTokenCoverage = ratio(markoutTokenRows, candidates.length);
  const primary = horizons.find((row) => row.horizonSec === 30) ?? horizons[0];
  const primaryPostCostPositiveRate = primary ? ratio(primary.positivePostCostRows, primary.okRows) : null;
  const reasons: string[] = [];
  let verdict: RotationPriceContextMarkoutVerdict = 'COLLECT';

  if (candidates.length === 0) {
    verdict = 'NO_PRICE_CONTEXT_CANDIDATES';
    reasons.push('no report-window underfill replay token reached the price-context check');
  } else if (buyMarkoutRows.length === 0) {
    verdict = 'NO_MARKOUT_COVERAGE';
    reasons.push(`price-context replay candidates exist but have no buy markout rows; tokens=${candidates.length}`);
  } else if ((markoutTokenCoverage ?? 0) < 0.5) {
    verdict = 'COLLECT';
    reasons.push(`token markout coverage ${formatPct(markoutTokenCoverage)} < 50.00%; covered=${markoutTokenRows}/${candidates.length}`);
  } else if ((minOkCoverage ?? 0) < EVIDENCE_MIN_OK_COVERAGE) {
    verdict = 'COLLECT';
    reasons.push(`markout ok coverage ${formatPct(minOkCoverage)} < ${formatPct(EVIDENCE_MIN_OK_COVERAGE)}`);
  } else if ((primary?.medianPostCostDeltaPct ?? 0) <= 0 || (primaryPostCostPositiveRate ?? 0) < 0.5) {
    verdict = 'NEGATIVE_AFTER_COST';
    reasons.push(`primary T+${primary?.horizonSec ?? 'n/a'} post-cost median ${formatPct(primary?.medianPostCostDeltaPct ?? null)}, positive ${formatPct(primaryPostCostPositiveRate)}`);
  } else {
    verdict = 'PAPER_OBSERVE_CANDIDATE';
    reasons.push(`covered price-context candidates show positive T+${primary.horizonSec}s post-cost markout; paper-only review required`);
  }

  const byToken = new Map<string, JsonRow[]>();
  for (const row of buyMarkoutRows) {
    const mint = rowTokenMint(row);
    if (!mint) continue;
    byToken.set(mint, [...(byToken.get(mint) ?? []), row]);
  }
  const topTokens = [...byToken.entries()]
    .map(([mint, rows]) => {
      const token = candidateByMint.get(mint);
      return token ? summarizePriceContextTokenMarkouts(token, rows, input.horizonsSec, input.roundTripCostPct) : null;
    })
    .filter((row): row is RotationPriceContextTokenMarkoutStats => row != null)
    .sort((a, b) =>
      b.markoutRows - a.markoutRows ||
      (b.bestMedianPostCostDeltaPct ?? -Infinity) - (a.bestMedianPostCostDeltaPct ?? -Infinity) ||
      a.tokenMint.localeCompare(b.tokenMint)
    )
    .slice(0, 10);
  const coverageGap = buildRotationPriceContextCoverageGap({
    candidates,
    buyMarkoutRows,
    tradeMarkoutRows: input.tradeMarkoutRows,
    missedAlphaRows: input.missedAlphaRows,
    callFunnelRows: input.callFunnelRows,
    policyDecisionRows: input.policyDecisionRows,
  });

  return {
    verdict,
    reasons,
    cutoffSource: 'report_since',
    since: replay.since,
    candidateTokenRows: candidates.length,
    candidateKolTxRows,
    markoutTokenRows,
    markoutTokenCoverage,
    buyMarkoutRows: buyMarkoutRows.length,
    minOkCoverage,
    horizons,
    topTokens,
    coverageGap,
  };
}

function summarizeRotationDecayBlockToken(input: {
  tokenMint: string;
  policyRows: JsonRow[];
  probeRows: JsonRow[];
  horizonsSec: number[];
  roundTripCostPct: number;
}): RotationDecayBlockTokenStats {
  const horizonStats = summarize(input.probeRows, input.horizonsSec, input.roundTripCostPct);
  const primary = horizonStats.find((row) => row.horizonSec === 30) ?? horizonStats[0];
  const decay = horizonStats.find((row) => row.horizonSec === EVIDENCE_DECAY_HORIZON_SEC) ?? null;
  const best = horizonStats
    .filter((row) => row.medianPostCostDeltaPct != null)
    .sort((a, b) => (b.medianPostCostDeltaPct ?? -Infinity) - (a.medianPostCostDeltaPct ?? -Infinity))[0];
  const primaryMedian = primary?.medianPostCostDeltaPct ?? null;
  const decayMedian = decay?.medianPostCostDeltaPct ?? null;
  const recoveryClass: RotationDecayRecoveryClass =
    primaryMedian == null
      ? 'insufficient_coverage'
      : primaryMedian > 0
        ? 'immediate_winner'
        : decayMedian != null && decayMedian > 0
          ? 'delayed_recovery'
          : decayMedian == null
            ? 'insufficient_coverage'
            : 'saved_loss';
  return {
    tokenMint: input.tokenMint,
    shortMint: shortTokenMint(input.tokenMint),
    policyRows: input.policyRows.length,
    probeRows: input.probeRows.length,
    okRows: input.probeRows.filter(isOk).length,
    recoveryClass,
    primaryHorizonSec: primary?.horizonSec ?? null,
    primaryMedianPostCostDeltaPct: primaryMedian,
    decayHorizonSec: decay?.horizonSec ?? null,
    decayMedianPostCostDeltaPct: decayMedian,
    recoveryDeltaPct: primaryMedian != null && decayMedian != null ? decayMedian - primaryMedian : null,
    bestHorizonSec: best?.horizonSec ?? null,
    bestMedianPostCostDeltaPct: best?.medianPostCostDeltaPct ?? null,
    topRejectReasons: countByLabel(input.policyRows.map(rowPolicyRejectReason), 'reason').slice(0, 3) as Array<{ reason: string; count: number }>,
    topSources: countByLabel(input.policyRows.map(rowPolicyAttributionSource), 'source').slice(0, 3) as Array<{ source: string; count: number }>,
    topSurvivalReasons: countByLabel(input.policyRows.map(rowPolicyAttributionSurvivalReason), 'reason').slice(0, 3) as Array<{ reason: string; count: number }>,
    topParameterVersions: countByLabel(input.policyRows.map(rowPolicyParameterVersion), 'version').slice(0, 3) as Array<{ version: string; count: number }>,
    topSignalSources: countByLabel(input.policyRows.map(rowPolicySignalSource), 'source').slice(0, 3) as Array<{ source: string; count: number }>,
    topStyleBuckets: countByLabel(input.policyRows.map((row) => rowPolicyBucketValue(row, 'style')), 'style').slice(0, 3) as Array<{ style: string; count: number }>,
    topIndependentBuckets: countByLabel(input.policyRows.map((row) => rowPolicyBucketValue(row, 'independentKolBucket')), 'bucket').slice(0, 3) as Array<{ bucket: string; count: number }>,
    topKolTiers: countByLabel(input.policyRows.flatMap((row) => rowPolicyParticipants(row).map((kol) => kol.tier)), 'tier').slice(0, 3) as Array<{ tier: string; count: number }>,
    topKols: countByLabel(input.policyRows.flatMap((row) => rowPolicyParticipants(row).map((kol) => kol.id)), 'kol').slice(0, 5) as Array<{ kol: string; count: number }>,
    medianPolicyKolScore: percentile(input.policyRows
      .map((row) => rowPolicyMetric(row, 'kolScore'))
      .filter((value): value is number => value != null), 0.5),
  };
}

function summarizeRotationDecayRecoveryProfile(
  recoveryClass: RotationDecayRecoveryClass,
  tokenStats: RotationDecayBlockTokenStats[],
  byPolicyMint: Map<string, JsonRow[]>
): RotationDecayRecoveryProfile {
  const scopedTokens = tokenStats.filter((row) => row.recoveryClass === recoveryClass);
  const policyRows = scopedTokens.flatMap((row) => byPolicyMint.get(row.tokenMint) ?? []);
  return {
    recoveryClass,
    tokenRows: scopedTokens.length,
    policyRows: policyRows.length,
    medianPolicyKolScore: percentile(policyRows
      .map((row) => rowPolicyMetric(row, 'kolScore'))
      .filter((value): value is number => value != null), 0.5),
    topParameterVersions: countByLabel(policyRows.map(rowPolicyParameterVersion), 'version').slice(0, 5) as Array<{ version: string; count: number }>,
    topSignalSources: countByLabel(policyRows.map(rowPolicySignalSource), 'source').slice(0, 5) as Array<{ source: string; count: number }>,
    topStyleBuckets: countByLabel(policyRows.map((row) => rowPolicyBucketValue(row, 'style')), 'style').slice(0, 5) as Array<{ style: string; count: number }>,
    topIndependentBuckets: countByLabel(policyRows.map((row) => rowPolicyBucketValue(row, 'independentKolBucket')), 'bucket').slice(0, 5) as Array<{ bucket: string; count: number }>,
    topLiquidityBuckets: countByLabel(policyRows.map((row) => rowPolicyBucketValue(row, 'liquidityBucket')), 'bucket').slice(0, 5) as Array<{ bucket: string; count: number }>,
    topSecurityBuckets: countByLabel(policyRows.map((row) => rowPolicyBucketValue(row, 'securityBucket')), 'bucket').slice(0, 5) as Array<{ bucket: string; count: number }>,
    topKolTiers: countByLabel(policyRows.flatMap((row) => rowPolicyParticipants(row).map((kol) => kol.tier)), 'tier').slice(0, 5) as Array<{ tier: string; count: number }>,
    topKols: countByLabel(policyRows.flatMap((row) => rowPolicyParticipants(row).map((kol) => kol.id)), 'kol').slice(0, 8) as Array<{ kol: string; count: number }>,
  };
}

function isRotationDecayGraceWatchlistPolicy(row: JsonRow): boolean {
  const participants = rowPolicyParticipants(row);
  return rowPolicyBucketValue(row, 'style') === 'scalper' &&
    (rowPolicyBucketValue(row, 'independentKolBucket') === 'single' ||
      rowPolicyBucketValue(row, 'independentKolBucket') === 'multi_2_3') &&
    rowPolicyBucketValue(row, 'liquidityBucket') === 'route_ok_or_unknown' &&
    rowPolicyBucketValue(row, 'securityBucket') === 'clean_or_unknown' &&
    participants.length > 0 &&
    participants.every((kol) => kol.tier === 'A');
}

function buildRotationDecayGraceWatchlist(input: {
  tokenStats: RotationDecayBlockTokenStats[];
  byPolicyMint: Map<string, JsonRow[]>;
  byProbeMint: Map<string, JsonRow[]>;
  horizonsSec: number[];
  roundTripCostPct: number;
}): RotationDecayGraceWatchlistStats {
  const topTokens = input.tokenStats.filter((token) => {
    const policyRows = input.byPolicyMint.get(token.tokenMint) ?? [];
    return policyRows.length > 0 && policyRows.every(isRotationDecayGraceWatchlistPolicy);
  });
  const probeRows = topTokens.flatMap((token) => input.byProbeMint.get(token.tokenMint) ?? []);
  const horizons = summarize(probeRows, input.horizonsSec, input.roundTripCostPct);
  const okCoverages = horizons
    .filter((row) => row.rows > 0)
    .map((row) => row.okRows / row.rows);
  const minOkCoverage = okCoverages.length > 0 ? Math.min(...okCoverages) : null;
  const decay = horizons.find((row) => row.horizonSec === EVIDENCE_DECAY_HORIZON_SEC) ?? null;
  const delayedRecoveryTokenRows = topTokens.filter((row) => row.recoveryClass === 'delayed_recovery').length;
  const savedLossTokenRows = topTokens.filter((row) => row.recoveryClass === 'saved_loss').length;
  const reasons: string[] = [];
  let verdict: RotationDecayGraceWatchlistVerdict = 'COLLECT';

  if (topTokens.length === 0) {
    verdict = 'NO_WATCHLIST_ROWS';
    reasons.push('no decay-block tokens match scalper A-tier single/2-3 KOL clean-route profile');
  } else if (topTokens.length < ROTATION_DECAY_GRACE_MIN_TOKENS) {
    verdict = 'COLLECT';
    reasons.push(`watchlist tokens ${topTokens.length} < ${ROTATION_DECAY_GRACE_MIN_TOKENS}`);
  } else if ((minOkCoverage ?? 0) < EVIDENCE_MIN_OK_COVERAGE) {
    verdict = 'COLLECT';
    reasons.push(`watchlist markout ok coverage ${formatPct(minOkCoverage)} < ${formatPct(EVIDENCE_MIN_OK_COVERAGE)}`);
  } else if (savedLossTokenRows >= delayedRecoveryTokenRows) {
    verdict = 'PAPER_GRACE_REJECT';
    reasons.push(`saved_loss tokens ${savedLossTokenRows} >= delayed_recovery tokens ${delayedRecoveryTokenRows}`);
  } else if ((decay?.medianPostCostDeltaPct ?? 0) <= 0) {
    verdict = 'PAPER_GRACE_REJECT';
    reasons.push(`T+${decay?.horizonSec ?? EVIDENCE_DECAY_HORIZON_SEC}s post-cost median ${formatPct(decay?.medianPostCostDeltaPct ?? null)} <= 0`);
  } else {
    verdict = 'PAPER_GRACE_CANDIDATE';
    reasons.push('watchlist delayed recovery beats saved loss with positive T+60 post-cost median; paper-only review required');
  }

  return {
    profile: 'scalper_a_single_or_2_3kol_clean_route',
    verdict,
    reasons,
    tokenRows: topTokens.length,
    policyRows: topTokens.reduce((sum, row) => sum + row.policyRows, 0),
    probeRows: probeRows.length,
    minOkCoverage,
    immediateWinnerTokenRows: topTokens.filter((row) => row.recoveryClass === 'immediate_winner').length,
    delayedRecoveryTokenRows,
    savedLossTokenRows,
    insufficientCoverageTokenRows: topTokens.filter((row) => row.recoveryClass === 'insufficient_coverage').length,
    horizons,
    topTokens: topTokens.slice(0, 12),
  };
}

function buildRotationDecayBlockMarkouts(input: {
  sinceMs: number;
  missedAlphaRows: JsonRow[];
  policyDecisionRows: JsonRow[];
  horizonsSec: number[];
  roundTripCostPct: number;
}): RotationDecayBlockMarkoutStats {
  const policyRows = input.policyDecisionRows.filter(isRotationDecayAttributionPolicy);
  const tokenMints = new Set(policyRows.map(rowTokenMintDeep).filter(Boolean));
  const probeRows = input.missedAlphaRows
    .filter((row) => tokenMints.has(rowTokenMintDeep(row)) && isRotationDecayMissedAlphaRow(row))
    .filter((row) => (rowHorizon(row) ?? 0) > 0);
  const probeTokenRows = new Set(probeRows.map(rowTokenMintDeep).filter(Boolean)).size;
  const horizons = summarize(probeRows, input.horizonsSec, input.roundTripCostPct);
  const okCoverages = horizons
    .filter((row) => row.rows > 0)
    .map((row) => row.okRows / row.rows);
  const minOkCoverage = okCoverages.length > 0 ? Math.min(...okCoverages) : null;
  const primary = horizons.find((row) => row.horizonSec === 30) ?? horizons[0];
  const primaryPositiveRate = primary && primary.okRows > 0
    ? primary.positivePostCostRows / primary.okRows
    : null;
  const byPolicyMint = new Map<string, JsonRow[]>();
  const byProbeMint = new Map<string, JsonRow[]>();
  for (const row of policyRows) {
    const mint = rowTokenMintDeep(row);
    if (mint) byPolicyMint.set(mint, [...(byPolicyMint.get(mint) ?? []), row]);
  }
  for (const row of probeRows) {
    const mint = rowTokenMintDeep(row);
    if (mint) byProbeMint.set(mint, [...(byProbeMint.get(mint) ?? []), row]);
  }
  const tokenStats = [...tokenMints]
    .map((tokenMint) => summarizeRotationDecayBlockToken({
      tokenMint,
      policyRows: byPolicyMint.get(tokenMint) ?? [],
      probeRows: byProbeMint.get(tokenMint) ?? [],
      horizonsSec: input.horizonsSec,
      roundTripCostPct: input.roundTripCostPct,
    }))
    .sort((a, b) =>
      b.probeRows - a.probeRows ||
      b.policyRows - a.policyRows ||
      (b.bestMedianPostCostDeltaPct ?? -Infinity) - (a.bestMedianPostCostDeltaPct ?? -Infinity) ||
      a.tokenMint.localeCompare(b.tokenMint)
    );
  const topDelayedRecoveryTokens = tokenStats
    .filter((row) => row.recoveryClass === 'delayed_recovery')
    .sort((a, b) =>
      (b.recoveryDeltaPct ?? -Infinity) - (a.recoveryDeltaPct ?? -Infinity) ||
      (b.decayMedianPostCostDeltaPct ?? -Infinity) - (a.decayMedianPostCostDeltaPct ?? -Infinity) ||
      b.policyRows - a.policyRows ||
      a.tokenMint.localeCompare(b.tokenMint)
    );
  const recoveryProfiles: RotationDecayRecoveryProfile[] = [
    'immediate_winner',
    'delayed_recovery',
    'saved_loss',
    'insufficient_coverage',
  ].map((recoveryClass) =>
    summarizeRotationDecayRecoveryProfile(recoveryClass as RotationDecayRecoveryClass, tokenStats, byPolicyMint)
  );
  const graceWatchlist = buildRotationDecayGraceWatchlist({
    tokenStats,
    byPolicyMint,
    byProbeMint,
    horizonsSec: input.horizonsSec,
    roundTripCostPct: input.roundTripCostPct,
  });

  const reasons: string[] = [];
  let verdict: RotationDecayBlockMarkoutVerdict = 'COLLECT';
  if (policyRows.length === 0) {
    verdict = 'NO_DECAY_BLOCKS';
    reasons.push('no rotation attribution-drift KOL alpha decay policy rows in report window');
  } else if (probeRows.length === 0) {
    verdict = 'NO_PROBE_COVERAGE';
    reasons.push('rotation decay blocks found but no rotation missed-alpha probe coverage');
  } else if ((primary?.medianPostCostDeltaPct ?? 0) > 0 && (primaryPositiveRate ?? 0) >= 0.5) {
    verdict = 'DECAY_KILLED_WINNERS';
    reasons.push(`T+${primary?.horizonSec ?? 'n/a'} post-cost median ${formatPct(primary?.medianPostCostDeltaPct ?? null)}, positive ${formatPct(primaryPositiveRate)}`);
  } else if ((primary?.medianPostCostDeltaPct ?? 0) <= 0 && primary?.okRows) {
    verdict = 'DECAY_SAVED_LOSS';
    reasons.push(`T+${primary.horizonSec}s post-cost median ${formatPct(primary.medianPostCostDeltaPct)}, positive ${formatPct(primaryPositiveRate)}`);
  } else {
    reasons.push('collect more decay block markout coverage before changing decay policy');
  }

  return {
    verdict,
    reasons,
    since: new Date(input.sinceMs).toISOString(),
    policyRows: policyRows.length,
    tokenRows: tokenMints.size,
    probeRows: probeRows.length,
    probeTokenRows,
    immediateWinnerTokenRows: tokenStats.filter((row) => row.recoveryClass === 'immediate_winner').length,
    delayedRecoveryTokenRows: tokenStats.filter((row) => row.recoveryClass === 'delayed_recovery').length,
    savedLossTokenRows: tokenStats.filter((row) => row.recoveryClass === 'saved_loss').length,
    insufficientCoverageTokenRows: tokenStats.filter((row) => row.recoveryClass === 'insufficient_coverage').length,
    minOkCoverage,
    horizons,
    topRejectReasons: countByLabel(policyRows.map(rowPolicyRejectReason), 'reason').slice(0, 8) as Array<{ reason: string; count: number }>,
    topSources: countByLabel(policyRows.map(rowPolicyAttributionSource), 'source').slice(0, 8) as Array<{ source: string; count: number }>,
    topSurvivalReasons: countByLabel(policyRows.map(rowPolicyAttributionSurvivalReason), 'reason').slice(0, 8) as Array<{ reason: string; count: number }>,
    recoveryProfiles,
    graceWatchlist,
    topTokens: tokenStats.slice(0, 12),
    topDelayedRecoveryTokens: topDelayedRecoveryTokens.slice(0, 12),
  };
}

function buildNarrowCohortPrimaryHorizonStats(
  rows: JsonRow[],
  markoutsByPosition: Map<string, JsonRow[]>,
  horizonsSec: number[],
  roundTripCostPct: number
): RotationNarrowCohortHorizonStats[] {
  return EVIDENCE_PRIMARY_HORIZONS_SEC
    .filter((horizonSec) => horizonsSec.includes(horizonSec))
    .map((horizonSec) => {
      const postCostDeltas = rows
        .map((row) => postCostDeltaAt(row, horizonSec, markoutsByPosition, roundTripCostPct))
        .filter((value): value is number => value != null);
      return {
        horizonSec,
        okRows: postCostDeltas.length,
        okCoverage: ratio(postCostDeltas.length, rows.length),
        postCostPositiveRate: ratio(postCostDeltas.filter((value) => value > 0).length, postCostDeltas.length),
        medianPostCostDeltaPct: percentile(postCostDeltas, 0.5),
      };
    });
}

function summarizeRotationNarrowCohort(
  cohort: string,
  rows: JsonRow[],
  markoutsByPosition: Map<string, JsonRow[]>,
  horizonsSec: number[],
  roundTripCostPct: number,
  assumedNetworkFeeSol: number
): RotationNarrowCohortStats {
  const minRequiredRows = ROTATION_PAPER_COMPOUND_MIN_CLOSES;
  const routeProofRows = rows.filter(isRouteProofedUnderfillRow).length;
  const candidateIdRows = rows.filter((row) => rowCandidateId(row)).length;
  const twoPlusKolRows = rows.filter(isTwoPlusKolRow).length;
  const costAwareRows = rows.filter(isCostAwareUnderfillRow).length;
  const timestampedSecondKolRows = rows.filter((row) => secondKolDelaySec(row) != null).length;
  const refundAdjustedValues = rows.map((row) =>
    (num(row.netSolTokenOnly) ?? numberOrZero(row.netSol)) - assumedNetworkFeeSol
  );
  const edgeRows = rows
    .map(rotationEdge)
    .filter((edge) => Object.keys(edge).length > 0);
  const primaryHorizonPostCost = buildNarrowCohortPrimaryHorizonStats(
    rows,
    markoutsByPosition,
    horizonsSec,
    roundTripCostPct
  );
  const minOkCoverage = minRequiredOkCoverage(primaryHorizonPostCost);
  const routeProofCoverage = ratio(routeProofRows, rows.length);
  const edgePassRate = ratio(edgeRows.filter((edge) => edgePassValue(edge) === true).length, edgeRows.length);
  const postCostPositiveRate = ratio(refundAdjustedValues.filter((value) => value > 0).length, rows.length);
  const t1Rate = ratio(rows.filter(rowHasT1).length, rows.length);
  const primaryMedians = primaryHorizonPostCost.map((row) => row.medianPostCostDeltaPct);
  const primaryPositiveRates = primaryHorizonPostCost.map((row) => row.postCostPositiveRate);
  const missingPrimaryHorizons = EVIDENCE_PRIMARY_HORIZONS_SEC.filter((horizonSec) =>
    !horizonsSec.includes(horizonSec)
  );
  const reasons: string[] = [];
  let verdict: RotationNarrowCohortVerdict = 'PAPER_READY';
  const canPaperReady = rows.length > 0 &&
    twoPlusKolRows === rows.length &&
    costAwareRows === rows.length;

  if (rows.length === 0) {
    verdict = 'DATA_GAP';
    reasons.push('route-proofed narrow sample missing');
  } else if (missingPrimaryHorizons.length > 0) {
    verdict = 'DATA_GAP';
    reasons.push(`primary horizons disabled: ${missingPrimaryHorizons.map((item) => `T+${item}s`).join(', ')}`);
  } else if ((routeProofCoverage ?? 0) < EVIDENCE_MIN_ROUTE_PROOF_COVERAGE) {
    verdict = 'DATA_GAP';
    reasons.push(`route proof ${formatPct(routeProofCoverage)} < ${formatPct(EVIDENCE_MIN_ROUTE_PROOF_COVERAGE)}`);
  } else if (minOkCoverage == null || minOkCoverage < EVIDENCE_MIN_OK_COVERAGE) {
    verdict = 'DATA_GAP';
    reasons.push(`T+15/T+30 markout coverage ${formatPct(minOkCoverage)} < ${formatPct(EVIDENCE_MIN_OK_COVERAGE)}`);
  } else if (cohort.includes('cost_aware') && edgePassRate == null) {
    verdict = 'DATA_GAP';
    reasons.push('cost-aware edge evidence missing');
  } else if (rows.length < ROTATION_COMPOUND_REVIEW_MIN_CLOSES) {
    verdict = 'COLLECT';
    reasons.push(`collect sample ${rows.length}/${ROTATION_COMPOUND_REVIEW_MIN_CLOSES}`);
  } else if (refundAdjustedValues.reduce((sum, value) => sum + value, 0) <= 0) {
    verdict = 'REJECT';
    reasons.push('refund-adjusted net <= 0');
  } else if ((postCostPositiveRate ?? 0) < ROTATION_PAPER_COMPOUND_MIN_POST_COST_POSITIVE_RATE) {
    verdict = rows.length >= minRequiredRows ? 'REJECT' : 'WATCH';
    reasons.push(
      `refund-adjusted positive ${formatPct(postCostPositiveRate)} < ` +
      `${formatPct(ROTATION_PAPER_COMPOUND_MIN_POST_COST_POSITIVE_RATE)}`
    );
  } else if (primaryMedians.some((value) => value == null || value <= 0)) {
    verdict = rows.length >= minRequiredRows ? 'REJECT' : 'WATCH';
    reasons.push('T+15/T+30 median post-cost continuation is non-positive');
  } else if (primaryPositiveRates.some((value) =>
    value == null || value < ROTATION_PAPER_COMPOUND_MIN_POST_COST_POSITIVE_RATE
  )) {
    verdict = rows.length >= minRequiredRows ? 'REJECT' : 'WATCH';
    reasons.push(
      `T+15/T+30 post-cost positive < ${formatPct(ROTATION_PAPER_COMPOUND_MIN_POST_COST_POSITIVE_RATE)}`
    );
  } else if (edgePassRate != null && edgePassRate < EVIDENCE_MIN_EDGE_PASS_RATE) {
    verdict = 'REJECT';
    reasons.push(`edge pass ${formatPct(edgePassRate)} < ${formatPct(EVIDENCE_MIN_EDGE_PASS_RATE)}`);
  } else if (!canPaperReady) {
    verdict = 'WATCH';
    reasons.push('diagnostic slice only; paper-ready requires every row to be 2+ KOL and cost-aware');
  } else if (rows.length < minRequiredRows) {
    verdict = 'WATCH';
    reasons.push(`review sample ${rows.length}/${minRequiredRows}`);
  } else if (candidateIdRows < rows.length) {
    verdict = 'DATA_GAP';
    reasons.push(`candidateId incomplete ${candidateIdRows}/${rows.length}`);
  } else if (timestampedSecondKolRows < rows.length) {
    verdict = 'DATA_GAP';
    reasons.push(`timestamped second-KOL incomplete ${timestampedSecondKolRows}/${rows.length}`);
  } else {
    reasons.push('route-proofed narrow paper cohort passed; live remains unchanged');
  }

  return {
    cohort,
    verdict,
    reasons,
    rows: rows.length,
    minRequiredRows,
    routeProofRows,
    routeProofCoverage,
    candidateIdRows,
    twoPlusKolRows,
    costAwareRows,
    timestampedSecondKolRows,
    refundAdjustedNetSol: rows.length > 0
      ? refundAdjustedValues.reduce((sum, value) => sum + value, 0)
      : null,
    postCostPositiveRate,
    edgePassRate,
    t1Rate,
    medianMfePct: percentile(rows.map(rowMfePct).filter((value): value is number => value != null), 0.5),
    medianHoldSec: percentile(rows.map((row) => num(row.holdSec)).filter((value): value is number => value != null), 0.5),
    minOkCoverage,
    primaryHorizonPostCost,
  };
}

function buildRotationNarrowCohortStats(
  rows: JsonRow[],
  markoutRows: JsonRow[],
  horizonsSec: number[],
  roundTripCostPct: number,
  assumedNetworkFeeSol: number
): RotationNarrowCohortStats[] {
  const markoutsByPosition = buyMarkoutsByPosition(markoutRows);
  const routeProofedRows = rows.filter(isRouteProofedUnderfillRow);
  const costAwareRows = routeProofedRows.filter(isCostAwareUnderfillRow);
  const twoPlusRows = routeProofedRows.filter(isTwoPlusKolRow);
  const twoPlusCostAwareRows = twoPlusRows.filter(isCostAwareUnderfillRow);
  return [
    { cohort: 'route_proofed_underfill', rows: routeProofedRows },
    { cohort: 'route_proofed_cost_aware', rows: costAwareRows },
    { cohort: 'route_proofed_2plus', rows: twoPlusRows },
    { cohort: 'route_proofed_2plus_cost_aware', rows: twoPlusCostAwareRows },
    {
      cohort: 'route_proofed_2plus_cost_aware_secondKOL<=15s',
      rows: twoPlusCostAwareRows.filter((row) => {
        const delay = secondKolDelaySec(row);
        return delay != null && delay <= 15;
      }),
    },
    {
      cohort: 'route_proofed_2plus_cost_aware_secondKOL<=30s',
      rows: twoPlusCostAwareRows.filter((row) => {
        const delay = secondKolDelaySec(row);
        return delay != null && delay <= 30;
      }),
    },
  ].map((item) => summarizeRotationNarrowCohort(
    item.cohort,
    item.rows,
    markoutsByPosition,
    horizonsSec,
    roundTripCostPct,
    assumedNetworkFeeSol
  ));
}

function buildRotationLiveReadiness(
  cohorts: UnderfillRouteCohortStats[],
  rows: JsonRow[],
  markoutRows: JsonRow[],
  horizonsSec: number[],
  roundTripCostPct: number,
  evidenceVerdicts: EvidenceVerdict[]
): RotationLiveReadiness {
  const cohortName = 'route_known_2kol_cost_aware';
  const cohort = cohorts.find((row) => row.cohort === cohortName) ??
    summarizeUnderfillRouteCohort(cohortName, [], 0);
  const readinessRows = selectRouteKnown2KolCostAwareUnderfillRows(rows);
  const coverageRows = buildRotationReadinessHorizonCoverage(readinessRows, markoutRows, horizonsSec, roundTripCostPct);
  const minOkCoverage = minRequiredOkCoverage(coverageRows);
  const primaryPostCostRows = EVIDENCE_PRIMARY_HORIZONS_SEC
    .filter((horizonSec) => horizonsSec.includes(horizonSec))
    .map((horizonSec) => ({
      horizonSec,
      medianPostCostDeltaPct: coverageRows.find((row) => row.horizonSec === horizonSec)?.medianPostCostDeltaPct ?? null,
    }));
  const evidence = evidenceVerdicts.find((row) => row.armName === ROTATION_LIVE_READINESS_ARM) ?? null;
  const edgeRows = cohort.edgePassRows + cohort.edgeFailRows;
  const postCostPositiveRate = ratio(cohort.refundAdjustedWinRows, cohort.rows);
  const edgePassRate = ratio(cohort.edgePassRows, edgeRows);
  const t1Rate = ratio(cohort.t1Rows, cohort.rows);
  const reasons: string[] = [];
  let verdict: RotationLiveReadinessVerdict = 'READY_FOR_MICRO_LIVE';

  if (cohort.rows === 0) {
    verdict = 'BLOCKED';
    reasons.push('route-known 2+KOL cost-aware underfill sample missing');
  } else if (cohort.rows < ROTATION_LIVE_READINESS_MIN_CLOSES) {
    verdict = 'COLLECT';
    reasons.push(`sample ${cohort.rows}/${ROTATION_LIVE_READINESS_MIN_CLOSES}`);
  } else if (minOkCoverage == null || minOkCoverage < EVIDENCE_MIN_OK_COVERAGE) {
    verdict = 'DATA_GAP';
    reasons.push(`cohort markout coverage ${formatPct(minOkCoverage)} < ${formatPct(EVIDENCE_MIN_OK_COVERAGE)}`);
  } else if (primaryPostCostRows.some((row) => row.medianPostCostDeltaPct == null)) {
    verdict = 'DATA_GAP';
    reasons.push('cohort primary post-cost markout missing');
  } else if (primaryPostCostRows.some((row) => (row.medianPostCostDeltaPct ?? 0) <= 0)) {
    verdict = 'COST_REJECT';
    reasons.push('cohort primary post-cost continuation is non-positive');
  }

  if (cohort.rows > 0 && cohort.refundAdjustedNetSol <= 0) {
    verdict = 'COST_REJECT';
    reasons.push(`refund-adjusted net ${formatSol(cohort.refundAdjustedNetSol)} <= 0`);
  }
  if (
    postCostPositiveRate != null &&
    postCostPositiveRate < ROTATION_LIVE_READINESS_MIN_POST_COST_POSITIVE_RATE
  ) {
    verdict = 'COST_REJECT';
    reasons.push(
      `post-cost positive ${formatPct(postCostPositiveRate)} < ` +
      `${formatPct(ROTATION_LIVE_READINESS_MIN_POST_COST_POSITIVE_RATE)}`
    );
  }
  if (edgePassRate != null && edgePassRate < EVIDENCE_MIN_EDGE_PASS_RATE) {
    verdict = 'COST_REJECT';
    reasons.push(`edge pass ${formatPct(edgePassRate)} < ${formatPct(EVIDENCE_MIN_EDGE_PASS_RATE)}`);
  }
  if (verdict === 'READY_FOR_MICRO_LIVE') {
    reasons.push('route-known 2+KOL cost-aware sample meets report-only micro-live gate');
  }

  return {
    armName: ROTATION_LIVE_READINESS_ARM,
    verdict,
    reasons,
    cohort: cohortName,
    closes: cohort.rows,
    minRequiredCloses: ROTATION_LIVE_READINESS_MIN_CLOSES,
    refundAdjustedNetSol: cohort.rows > 0 ? cohort.refundAdjustedNetSol : null,
    postCostPositiveRate,
    edgePassRate,
    t1Rate,
    medianMfePct: cohort.medianMfePct,
    minOkCoverage,
    requiredHorizonCoverage: coverageRows,
    primaryHorizonPostCost: primaryPostCostRows,
    evidenceVerdict: evidence?.verdict ?? null,
  };
}

function buildRotationPaperCompoundReadiness(
  cohorts: UnderfillRouteCohortStats[],
  rows: JsonRow[],
  markoutRows: JsonRow[],
  horizonsSec: number[],
  roundTripCostPct: number
): RotationPaperCompoundReadiness {
  const cohortName = 'route_known_2kol_cost_aware';
  const cohort = cohorts.find((row) => row.cohort === cohortName) ??
    summarizeUnderfillRouteCohort(cohortName, [], 0);
  const readinessRows = selectRouteKnown2KolCostAwareUnderfillRows(rows);
  const coverageRows = buildRotationReadinessHorizonCoverage(readinessRows, markoutRows, horizonsSec, roundTripCostPct);
  const minOkCoverage = minRequiredOkCoverage(coverageRows);
  const primaryPostCostRows = EVIDENCE_PRIMARY_HORIZONS_SEC
    .filter((horizonSec) => horizonsSec.includes(horizonSec))
    .map((horizonSec) => ({
      horizonSec,
      medianPostCostDeltaPct: coverageRows.find((row) => row.horizonSec === horizonSec)?.medianPostCostDeltaPct ?? null,
    }));
  const edgeRows = cohort.edgePassRows + cohort.edgeFailRows;
  const postCostPositiveRate = ratio(cohort.refundAdjustedWinRows, cohort.rows);
  const edgePassRate = ratio(cohort.edgePassRows, edgeRows);
  const t1Rate = ratio(cohort.t1Rows, cohort.rows);
  const reasons: string[] = [];
  let verdict: RotationPaperCompoundReadinessVerdict = 'PAPER_READY';

  if (cohort.rows === 0) {
    verdict = 'BLOCKED';
    reasons.push('live-equivalent route-known 2+KOL cost-aware paper sample missing');
  } else if (cohort.rows < ROTATION_PAPER_COMPOUND_MIN_CLOSES) {
    verdict = 'COLLECT';
    reasons.push(`sample ${cohort.rows}/${ROTATION_PAPER_COMPOUND_MIN_CLOSES}`);
  } else if (minOkCoverage == null || minOkCoverage < EVIDENCE_MIN_OK_COVERAGE) {
    verdict = 'DATA_GAP';
    reasons.push(`cohort markout coverage ${formatPct(minOkCoverage)} < ${formatPct(EVIDENCE_MIN_OK_COVERAGE)}`);
  } else if (primaryPostCostRows.some((row) => row.medianPostCostDeltaPct == null)) {
    verdict = 'DATA_GAP';
    reasons.push('cohort primary post-cost markout missing');
  } else if (primaryPostCostRows.some((row) => (row.medianPostCostDeltaPct ?? 0) <= 0)) {
    verdict = 'COST_REJECT';
    reasons.push('cohort primary post-cost continuation is non-positive');
  }

  if (cohort.rows > 0 && cohort.refundAdjustedNetSol <= 0) {
    verdict = 'COST_REJECT';
    reasons.push(`refund-adjusted net ${formatSol(cohort.refundAdjustedNetSol)} <= 0`);
  }
  if (
    postCostPositiveRate != null &&
    postCostPositiveRate < ROTATION_PAPER_COMPOUND_MIN_POST_COST_POSITIVE_RATE
  ) {
    verdict = 'COST_REJECT';
    reasons.push(
      `post-cost positive ${formatPct(postCostPositiveRate)} < ` +
      `${formatPct(ROTATION_PAPER_COMPOUND_MIN_POST_COST_POSITIVE_RATE)}`
    );
  }
  if (edgePassRate != null && edgePassRate < EVIDENCE_MIN_EDGE_PASS_RATE) {
    verdict = 'COST_REJECT';
    reasons.push(`edge pass ${formatPct(edgePassRate)} < ${formatPct(EVIDENCE_MIN_EDGE_PASS_RATE)}`);
  }
  if (verdict === 'PAPER_READY') {
    reasons.push('live-equivalent paper compound gate passed; keep live unchanged until separate review');
  }

  return {
    armName: ROTATION_LIVE_READINESS_ARM,
    verdict,
    reasons,
    cohort: cohortName,
    closes: cohort.rows,
    minRequiredCloses: ROTATION_PAPER_COMPOUND_MIN_CLOSES,
    refundAdjustedNetSol: cohort.rows > 0 ? cohort.refundAdjustedNetSol : null,
    postCostPositiveRate,
    edgePassRate,
    t1Rate,
    medianMfePct: cohort.medianMfePct,
    minOkCoverage,
    requiredHorizonCoverage: coverageRows,
    primaryHorizonPostCost: primaryPostCostRows,
  };
}

function hasHighRiskFlag(row: JsonRow): boolean {
  return rowSurvivalFlags(row).some((flag) =>
    flag.startsWith('UNCLEAN_TOKEN') ||
    flag.includes('NO_SECURITY_DATA') ||
    flag.includes('SEVERE') ||
    flag.includes('RUG') ||
    flag.includes('BLACKLIST')
  );
}

function hasUnknownQualityFlag(row: JsonRow): boolean {
  return rowSurvivalFlags(row).some((flag) =>
    flag === 'TOKEN_QUALITY_UNKNOWN' ||
    flag === 'EXIT_LIQUIDITY_UNKNOWN' ||
    flag === 'NO_HELIUS_PROVENANCE'
  );
}

function isHardCutTrade(row: JsonRow): boolean {
  const reason = str(row.exitReason);
  return reason === 'probe_hard_cut' ||
    reason === 'rotation_dead_on_arrival' ||
    reason === 'rotation_mae_fast_fail' ||
    reason === 'rotation_flow_residual_timeout' ||
    reason === 'quick_reject_classifier_exit';
}

function buildPaperArmStats(
  rows: JsonRow[],
  assumedAtaRentSol: number,
  assumedNetworkFeeSol: number
): PaperArmStats[] {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows) {
    const key = rowArmName(row);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  const assumedWalletDragSol = assumedAtaRentSol + assumedNetworkFeeSol;
  return [...buckets.entries()]
    .map(([armName, scoped]) => {
      const netSolValues = scoped.map((row) => numberOrZero(row.netSol));
      const tokenOnlyValues = scoped.map((row) => {
        const tokenOnly = num(row.netSolTokenOnly);
        return tokenOnly == null ? numberOrZero(row.netSol) : tokenOnly;
      });
      const holdSec = scoped.map((row) => num(row.holdSec)).filter((value): value is number => value != null);
      const edgeRows = scoped
        .map(rotationEdge)
        .filter((edge) => Object.keys(edge).length > 0);
      const edgeCostRatios = edgeRows
        .map(edgeCopyableCostRatio)
        .filter((value): value is number => value != null && Number.isFinite(value));
      const edgeWalletDragRatios = edgeRows
        .map(edgeWalletDragRatio)
        .filter((value): value is number => value != null && Number.isFinite(value));
      const edgeRequiredMoves = edgeRows
        .map(edgeRequiredGrossMovePct)
        .filter((value): value is number => value != null && Number.isFinite(value));
      const netSol = netSolValues.reduce((sum, value) => sum + value, 0);
      const netSolTokenOnly = tokenOnlyValues.reduce((sum, value) => sum + value, 0);
      const rowMetrics = scoped.map((row, index) => ({
        row,
        tokenOnlyNetSol: tokenOnlyValues[index],
        refundAdjustedNetSol: tokenOnlyValues[index] - assumedNetworkFeeSol,
      }));
      const maeWorstValues = scoped.map(rowMaeWorstPct).filter((value): value is number => value != null);
      const hardCutRows = scoped.filter(isHardCutTrade);
      const hardCutMaeValues = hardCutRows.map(rowHardCutMaePct).filter((value): value is number => value != null);
      return {
        armName,
        rows: scoped.length,
        wins: netSolValues.filter((value) => value > 0).length,
        losses: netSolValues.filter((value) => value <= 0).length,
        netSol,
        netSolTokenOnly,
        refundAdjustedNetSol: tokenOnlyValues
          .map((value) => value - assumedNetworkFeeSol)
          .reduce((sum, value) => sum + value, 0),
        rentAdjustedNetSol: tokenOnlyValues
          .map((value) => value - assumedWalletDragSol)
          .reduce((sum, value) => sum + value, 0),
        edgeRows: edgeRows.length,
        edgePassRows: edgeRows.filter((edge) => edgePassValue(edge) === true).length,
        edgeFailRows: edgeRows.filter((edge) => edgePassValue(edge) === false).length,
        routeProofRows: scoped.filter((row) => routeTruthEvidenceSources(row).length > 0).length,
        medianEdgeCostRatio: percentile(edgeCostRatios, 0.5),
        medianEdgeWalletDragRatio: percentile(edgeWalletDragRatios, 0.5),
        medianRequiredGrossMovePct: percentile(edgeRequiredMoves, 0.5),
        hardCutRows: hardCutRows.length,
        t1Rows: scoped.filter(rowHasT1).length,
        tokenOnlyWinnerRefundLoserRows: rowMetrics
          .filter(({ tokenOnlyNetSol, refundAdjustedNetSol }) => tokenOnlyNetSol > 0 && refundAdjustedNetSol <= 0)
          .length,
        mfe5RefundLoserRows: rowMetrics
          .filter(({ row, refundAdjustedNetSol }) => (rowMfePct(row) ?? 0) >= 0.05 && refundAdjustedNetSol <= 0)
          .length,
        mfe12RefundLoserRows: rowMetrics
          .filter(({ row, refundAdjustedNetSol }) => (rowMfePct(row) ?? 0) >= 0.12 && refundAdjustedNetSol <= 0)
          .length,
        mae5Within15Rows: scoped.filter((row) => {
          const maeAt5s = rowMaeAt5sPct(row);
          const maeAt15s = rowMaeAt15sPct(row);
          return (maeAt5s != null && maeAt5s <= -0.05) || (maeAt15s != null && maeAt15s <= -0.05);
        }).length,
        mae10BeforeT1Rows: scoped.filter((row) => {
          const maeWorst = rowMaeWorstPct(row);
          return maeWorst != null && maeWorst <= -0.10 && !rowHasT1(row);
        }).length,
        medianMaeWorstPct: percentile(maeWorstValues, 0.5),
        medianHardCutMaePct: percentile(hardCutMaeValues, 0.5),
        medianHoldSec: percentile(holdSec, 0.5),
        topExitReasons: buildTopExitReasons(scoped),
      };
    })
    .sort((a, b) => b.rows - a.rows || b.netSolTokenOnly - a.netSolTokenOnly || a.armName.localeCompare(b.armName));
}

function buildWinnerEntryPairingStats(
  rows: JsonRow[],
  assumedAtaRentSol: number,
  assumedNetworkFeeSol: number
): WinnerEntryPairingStats[] {
  const buckets = new Map<string, { armName: string; exitBucket: WinnerEntryPairingStats['exitBucket']; rows: JsonRow[] }>();
  const assumedWalletDragSol = assumedAtaRentSol + assumedNetworkFeeSol;
  for (const row of rows) {
    const armName = rowArmName(row);
    const exitBucket: WinnerEntryPairingStats['exitBucket'] =
      str(row.exitReason) === 'winner_trailing_t1' ? 'winner_trailing_t1' : 'other_exits';
    const key = `${armName}:${exitBucket}`;
    const bucket = buckets.get(key) ?? { armName, exitBucket, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map(({ armName, exitBucket, rows: scoped }) => {
      const netSolValues = scoped.map((row) => numberOrZero(row.netSol));
      const tokenOnlyValues = scoped.map((row) => {
        const tokenOnly = num(row.netSolTokenOnly);
        return tokenOnly == null ? numberOrZero(row.netSol) : tokenOnly;
      });
      const holds = scoped.map((row) => num(row.holdSec)).filter((value): value is number => value != null);
      const mfeValues = scoped.map(rowMfePct).filter((value): value is number => value != null);
      const maeValues = scoped.map(rowMaeWorstPct).filter((value): value is number => value != null);
      return {
        armName,
        exitBucket,
        rows: scoped.length,
        wins: netSolValues.filter((value) => value > 0).length,
        losses: netSolValues.filter((value) => value <= 0).length,
        netSol: netSolValues.reduce((sum, value) => sum + value, 0),
        netSolTokenOnly: tokenOnlyValues.reduce((sum, value) => sum + value, 0),
        refundAdjustedNetSol: tokenOnlyValues
          .map((value) => value - assumedNetworkFeeSol)
          .reduce((sum, value) => sum + value, 0),
        rentAdjustedNetSol: tokenOnlyValues
          .map((value) => value - assumedWalletDragSol)
          .reduce((sum, value) => sum + value, 0),
        medianMfePct: percentile(mfeValues, 0.5),
        medianMaePct: percentile(maeValues, 0.5),
        medianHoldSec: percentile(holds, 0.5),
      };
    })
    .sort((a, b) => {
      if (a.exitBucket !== b.exitBucket) return a.exitBucket === 'winner_trailing_t1' ? -1 : 1;
      return b.netSolTokenOnly - a.netSolTokenOnly || b.rows - a.rows || a.armName.localeCompare(b.armName);
    });
}

function buildWinnerEntryDiagnosticStats(rows: JsonRow[]): WinnerEntryDiagnosticStats[] {
  const buckets = new Map<string, { armName: string; exitBucket: WinnerEntryDiagnosticStats['exitBucket']; rows: JsonRow[] }>();
  for (const row of rows) {
    const armName = rowArmName(row);
    const exitBucket: WinnerEntryDiagnosticStats['exitBucket'] =
      str(row.exitReason) === 'winner_trailing_t1' ? 'winner_trailing_t1' : 'other_exits';
    const key = `${armName}:${exitBucket}`;
    const bucket = buckets.get(key) ?? { armName, exitBucket, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map(({ armName, exitBucket, rows: scoped }) => {
      const topupStrength = scoped
        .map((row) => num(rotationFlowMetrics(row).topupStrength))
        .filter((value): value is number => value != null);
      const sellPressure = scoped
        .map((row) => num(rotationFlowMetrics(row).sellPressure30))
        .filter((value): value is number => value != null);
      const anchorBuySol = scoped
        .map((row) => num(rotationFlowMetrics(row).anchorBuySolBeforeFirstSell))
        .filter((value): value is number => value != null);
      const freshTopups = scoped.filter((row) => rotationFlowMetrics(row).freshTopup === true).length;
      const highRisk = scoped.filter(hasHighRiskFlag).length;
      const unknownQuality = scoped.filter(hasUnknownQualityFlag).length;
      return {
        armName,
        exitBucket,
        rows: scoped.length,
        medianTopupStrength: percentile(topupStrength, 0.5),
        medianSellPressure30: percentile(sellPressure, 0.5),
        medianAnchorBuySol: percentile(anchorBuySol, 0.5),
        freshTopupRate: scoped.length > 0 ? freshTopups / scoped.length : null,
        highRiskFlagRate: scoped.length > 0 ? highRisk / scoped.length : null,
        unknownQualityRate: scoped.length > 0 ? unknownQuality / scoped.length : null,
      };
    })
    .sort((a, b) => {
      if (a.exitBucket !== b.exitBucket) return a.exitBucket === 'winner_trailing_t1' ? -1 : 1;
      return b.rows - a.rows || a.armName.localeCompare(b.armName);
    });
}

function horizonOkCoverage(row: HorizonStats | undefined): number | null {
  if (!row) return null;
  return row.rows > 0 ? row.okRows / row.rows : 0;
}

function requiredHorizonCoverage(markout: ArmHorizonStats | undefined): Array<{ horizonSec: number; okCoverage: number | null }> {
  return EVIDENCE_REQUIRED_COVERAGE_HORIZONS_SEC.map((horizonSec) => ({
    horizonSec,
    okCoverage: horizonOkCoverage(markout?.afterBuy.find((row) => row.horizonSec === horizonSec)),
  }));
}

function minRequiredOkCoverage(rows: Array<{ horizonSec: number; okCoverage: number | null }>): number | null {
  const coverages = rows.map((row) => row.okCoverage);
  if (coverages.some((value) => value == null || !Number.isFinite(value))) return null;
  return percentile(coverages as number[], 0);
}

function verdictReasonCoverage(value: number | null): string {
  return value == null ? 'ok coverage missing' : `ok coverage ${formatPct(value)} < ${formatPct(EVIDENCE_MIN_OK_COVERAGE)}`;
}

function verdictCoverageReasons(rows: Array<{ horizonSec: number; okCoverage: number | null }>): string[] {
  return rows.flatMap((row) => {
    if (row.okCoverage == null) return [`T+${row.horizonSec}s coverage missing`];
    if (row.okCoverage < EVIDENCE_MIN_OK_COVERAGE) {
      return [`T+${row.horizonSec}s ok coverage ${formatPct(row.okCoverage)} < ${formatPct(EVIDENCE_MIN_OK_COVERAGE)}`];
    }
    return [];
  });
}

function horizonBySec(markout: ArmHorizonStats | undefined, horizonSec: number): HorizonStats | null {
  return markout?.afterBuy.find((row) => row.horizonSec === horizonSec) ?? null;
}

function bestPrimaryHorizon(markout: ArmHorizonStats | undefined): HorizonStats | null {
  const candidates = EVIDENCE_PRIMARY_HORIZONS_SEC
    .map((horizonSec) => horizonBySec(markout, horizonSec))
    .filter((row): row is HorizonStats => row != null && row.rows > 0 && row.medianPostCostDeltaPct != null);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) =>
    (b.medianPostCostDeltaPct ?? -Infinity) - (a.medianPostCostDeltaPct ?? -Infinity) ||
    a.horizonSec - b.horizonSec
  )[0];
}

function primaryHorizonPostCost(markout: ArmHorizonStats | undefined): Array<{ horizonSec: number; medianPostCostDeltaPct: number | null }> {
  return EVIDENCE_PRIMARY_HORIZONS_SEC.map((horizonSec) => ({
    horizonSec,
    medianPostCostDeltaPct: horizonBySec(markout, horizonSec)?.medianPostCostDeltaPct ?? null,
  }));
}

function weakPrimaryPostCostReasons(rows: Array<{ horizonSec: number; medianPostCostDeltaPct: number | null }>): string[] {
  return rows.flatMap((row) => {
    if (row.medianPostCostDeltaPct == null) return [`T+${row.horizonSec}s median postCost missing`];
    if (row.medianPostCostDeltaPct <= 0) {
      return [`T+${row.horizonSec}s median postCost ${formatPct(row.medianPostCostDeltaPct)} <= 0`];
    }
    return [];
  });
}

function buildEvidenceVerdicts(
  paperArms: PaperArmStats[],
  armMarkouts: ArmHorizonStats[]
): EvidenceVerdict[] {
  const markoutsByArm = new Map(armMarkouts.map((row) => [row.armName, row]));
  const controlPrimaryMedianPostCostDeltaPct =
    bestPrimaryHorizon(markoutsByArm.get(ROTATION_CONTROL_ARM))?.medianPostCostDeltaPct ?? null;
  const controlT60MedianPostCostDeltaPct =
    horizonBySec(markoutsByArm.get(ROTATION_CONTROL_ARM), EVIDENCE_DECAY_HORIZON_SEC)?.medianPostCostDeltaPct ?? null;
  return paperArms.map((arm) => {
    const markout = markoutsByArm.get(arm.armName);
    const coverageRows = requiredHorizonCoverage(markout);
    const minOkCoverage = minRequiredOkCoverage(coverageRows);
    const primary = bestPrimaryHorizon(markout);
    const primaryPostCostRows = primaryHorizonPostCost(markout);
    const weakPrimaryPostCost = weakPrimaryPostCostReasons(primaryPostCostRows);
    const decay = horizonBySec(markout, EVIDENCE_DECAY_HORIZON_SEC);
    const primaryBeatDeltaPct =
      primary?.medianPostCostDeltaPct != null && controlPrimaryMedianPostCostDeltaPct != null
        ? primary.medianPostCostDeltaPct - controlPrimaryMedianPostCostDeltaPct
        : null;
    const controlBeatDeltaPct = primaryBeatDeltaPct;
    const decayBeatDeltaPct = decay?.medianPostCostDeltaPct != null && controlT60MedianPostCostDeltaPct != null
      ? decay.medianPostCostDeltaPct - controlT60MedianPostCostDeltaPct
      : null;
    const edgeCoverage = arm.rows > 0 ? arm.edgeRows / arm.rows : null;
    const edgePassRate = arm.edgeRows > 0 ? arm.edgePassRows / arm.edgeRows : null;
    const routeProofCoverage = arm.rows > 0 ? arm.routeProofRows / arm.rows : null;
    const reasons: string[] = [];
    let verdict: EvidenceVerdictStatus = 'PROMOTION_CANDIDATE';
    if (decay?.medianPostCostDeltaPct != null && decay.medianPostCostDeltaPct <= 0) {
      reasons.push(`T+${EVIDENCE_DECAY_HORIZON_SEC}s decay warning ${formatPct(decay.medianPostCostDeltaPct)} <= 0`);
    }

    if (arm.rows < EVIDENCE_MIN_CLOSES) {
      verdict = 'COLLECT';
      reasons.push(`sample ${arm.rows}/${EVIDENCE_MIN_CLOSES}`);
    } else if (
      minOkCoverage == null ||
      minOkCoverage < EVIDENCE_MIN_OK_COVERAGE ||
      primary == null ||
      primary.rows === 0 ||
      edgeCoverage == null ||
      edgeCoverage < EVIDENCE_MIN_EDGE_COVERAGE
    ) {
      verdict = 'DATA_GAP';
      reasons.push(...verdictCoverageReasons(coverageRows));
      if (minOkCoverage == null || minOkCoverage < EVIDENCE_MIN_OK_COVERAGE) {
        reasons.push(`min ${verdictReasonCoverage(minOkCoverage)}`);
      }
      if (primary == null || primary.rows === 0) {
        reasons.push(`T+${EVIDENCE_PRIMARY_HORIZONS_SEC.join('/')}s primary markout missing`);
      }
      if (edgeCoverage == null || edgeCoverage < EVIDENCE_MIN_EDGE_COVERAGE) {
        reasons.push(`edge coverage ${formatPct(edgeCoverage)} < ${formatPct(EVIDENCE_MIN_EDGE_COVERAGE)}`);
      }
    } else if (edgePassRate == null || edgePassRate < EVIDENCE_MIN_EDGE_PASS_RATE || arm.refundAdjustedNetSol <= 0) {
      verdict = 'COST_REJECT';
      if (edgePassRate == null) reasons.push('edge shadow rows missing');
      else if (edgePassRate < EVIDENCE_MIN_EDGE_PASS_RATE) {
        reasons.push(`edge pass ${formatPct(edgePassRate)} < ${formatPct(EVIDENCE_MIN_EDGE_PASS_RATE)}`);
      }
      if (arm.refundAdjustedNetSol <= 0) reasons.push(`refund-adjusted net ${formatSol(arm.refundAdjustedNetSol)} <= 0`);
    } else if (weakPrimaryPostCost.length > 0) {
      verdict = 'POST_COST_REJECT';
      reasons.push(...weakPrimaryPostCost);
    } else if (arm.armName !== ROTATION_CONTROL_ARM && controlPrimaryMedianPostCostDeltaPct == null) {
      verdict = 'WATCH';
      reasons.push(`control T+${EVIDENCE_PRIMARY_HORIZONS_SEC.join('/')}s baseline missing`);
    } else if (arm.armName !== ROTATION_CONTROL_ARM && primaryBeatDeltaPct != null && primaryBeatDeltaPct <= 0) {
      verdict = 'POST_COST_REJECT';
      reasons.push(`primary postCost ${formatPct(primary.medianPostCostDeltaPct)} <= control ${formatPct(controlPrimaryMedianPostCostDeltaPct)}`);
    } else if (arm.rows < EVIDENCE_PROMOTION_MIN_CLOSES) {
      verdict = 'WATCH';
      reasons.push(`sample ${arm.rows}/${EVIDENCE_PROMOTION_MIN_CLOSES}`);
    } else if (routeProofCoverage == null || routeProofCoverage < EVIDENCE_MIN_ROUTE_PROOF_COVERAGE) {
      verdict = 'DATA_GAP';
      reasons.push(
        `route proof ${arm.routeProofRows}/${arm.rows} ` +
        `${formatPct(routeProofCoverage)} < ${formatPct(EVIDENCE_MIN_ROUTE_PROOF_COVERAGE)}`
      );
    } else {
      reasons.push('promotion evidence threshold met');
    }

    return {
      armName: arm.armName,
      verdict,
      reasons,
      closes: arm.rows,
      minRequiredCloses: EVIDENCE_MIN_CLOSES,
      promotionRequiredCloses: EVIDENCE_PROMOTION_MIN_CLOSES,
      minOkCoverage,
      requiredHorizonCoverage: coverageRows,
      primaryHorizonPostCost: primaryPostCostRows,
      primaryHorizonSec: primary?.horizonSec ?? null,
      primaryMedianPostCostDeltaPct: primary?.medianPostCostDeltaPct ?? null,
      controlPrimaryMedianPostCostDeltaPct: arm.armName === ROTATION_CONTROL_ARM ? null : controlPrimaryMedianPostCostDeltaPct,
      primaryBeatDeltaPct: arm.armName === ROTATION_CONTROL_ARM ? null : primaryBeatDeltaPct,
      decayHorizonSec: EVIDENCE_DECAY_HORIZON_SEC,
      decayMedianPostCostDeltaPct: decay?.medianPostCostDeltaPct ?? null,
      t60MedianPostCostDeltaPct: decay?.medianPostCostDeltaPct ?? null,
      controlT60MedianPostCostDeltaPct: arm.armName === ROTATION_CONTROL_ARM ? null : controlT60MedianPostCostDeltaPct,
      controlBeatDeltaPct: arm.armName === ROTATION_CONTROL_ARM ? null : decayBeatDeltaPct,
      refundAdjustedNetSol: arm.refundAdjustedNetSol,
      rentAdjustedNetSol: arm.rentAdjustedNetSol,
      edgeCoverage,
      edgePassRate,
      routeProofRows: arm.routeProofRows,
      routeProofCoverage,
    };
  });
}

function anchorKey(row: JsonRow): string {
  const extras = obj(row.extras);
  const raw = extras.rotationAnchorKols;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((value) => String(value)).sort().join('+');
  }
  const nested = obj(extras.rotationV1).anchorKols;
  if (Array.isArray(nested) && nested.length > 0) {
    return nested.map((value) => String(value)).sort().join('+');
  }
  return '(unknown)';
}

interface QualityAttribution {
  tokenMint: string;
  positionId?: string;
  observedAtMs: number;
  creatorAddress?: string;
  devWallet?: string;
  firstLpProvider?: string;
  operatorDevStatus?: string;
}

interface QualityIndex {
  byPositionId: Map<string, QualityAttribution>;
  byTokenMint: Map<string, QualityAttribution>;
}

function buildQualityIndex(rows: JsonRow[]): QualityIndex {
  const byPositionId = new Map<string, QualityAttribution>();
  const byTokenMint = new Map<string, QualityAttribution>();
  for (const row of rows) {
    const tokenMint = str(row.tokenMint);
    if (!tokenMint) continue;
    const ctx = obj(row.observationContext);
    const attribution: QualityAttribution = {
      tokenMint,
      positionId: str(ctx.positionId) || undefined,
      observedAtMs: timeMs(row.observedAt),
      creatorAddress: str(row.creatorAddress) || undefined,
      devWallet: str(row.devWallet) || undefined,
      firstLpProvider: str(row.firstLpProvider) || undefined,
      operatorDevStatus: str(row.operatorDevStatus) || undefined,
    };
    if (attribution.positionId) {
      const prev = byPositionId.get(attribution.positionId);
      if (!prev || attribution.observedAtMs >= prev.observedAtMs) {
        byPositionId.set(attribution.positionId, attribution);
      }
    }
    const prevByMint = byTokenMint.get(tokenMint);
    if (!prevByMint || attribution.observedAtMs >= prevByMint.observedAtMs) {
      byTokenMint.set(tokenMint, attribution);
    }
  }
  return { byPositionId, byTokenMint };
}

function lookupQuality(row: JsonRow, index: QualityIndex): QualityAttribution | undefined {
  const positionId = rowPositionId(row);
  if (positionId) {
    const byPosition = index.byPositionId.get(positionId);
    if (byPosition) return byPosition;
  }
  const mint = rowTokenMint(row);
  return mint ? index.byTokenMint.get(mint) : undefined;
}

function devQualityBuckets(
  attribution: QualityAttribution | undefined,
  candidateIndex?: DevWalletCandidateIndex
): string[] {
  const buckets = new Set<string>();
  const status = attribution?.operatorDevStatus;
  if (status && status !== 'unknown') buckets.add(`DEV_STATUS_${status.toUpperCase()}`);

  const candidate = candidateIndex && attribution
    ? lookupDevWalletCandidate(attribution.devWallet, candidateIndex) ??
      lookupDevWalletCandidate(attribution.creatorAddress, candidateIndex) ??
      lookupDevWalletCandidate(attribution.firstLpProvider, candidateIndex)
    : undefined;
  if (candidate) {
    buckets.add('DEV_CANDIDATE_MATCHED');
    buckets.add(`DEV_CANDIDATE_RISK_${candidate.risk_class.toUpperCase()}`);
    buckets.add(`DEV_CANDIDATE_LANE_${candidate.lane.toUpperCase()}`);
    buckets.add(`DEV_CANDIDATE_STATUS_${candidate.status.toUpperCase()}`);
    buckets.add(`DEV_CANDIDATE_SOURCE_${candidate.source_tier.toUpperCase()}`);
  }
  if (buckets.size === 0) buckets.add('DEV_UNKNOWN');
  return [...buckets];
}

function buildAnchorStats(rows: JsonRow[], roundTripCostPct: number): RotationReport['byAnchor'] {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows.filter((item) => rowHorizon(item) === 60)) {
    const key = anchorKey(row);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return [...buckets.entries()]
    .map(([anchor, scoped]) => {
      const ok = scoped.filter(isOk);
      const deltas = ok.map(rowDelta).filter((value): value is number => value != null);
      const postCostDeltas = deltas.map((value) => value - roundTripCostPct);
      return {
        anchor,
        rows: scoped.length,
        okRows: ok.length,
        medianDeltaPct60s: percentile(deltas, 0.5),
        medianPostCostDeltaPct60s: percentile(postCostDeltas, 0.5),
        positive60s: deltas.filter((value) => value > 0).length,
        positivePostCost60s: postCostDeltas.filter((value) => value > 0).length,
      };
    })
    .sort((a, b) => b.okRows - a.okRows || b.positivePostCost60s - a.positivePostCost60s || a.anchor.localeCompare(b.anchor))
    .slice(0, 25);
}

function buildDevQualityStats(
  rows: JsonRow[],
  qualityIndex: QualityIndex,
  candidateIndex: DevWalletCandidateIndex | undefined,
  roundTripCostPct: number
): RotationReport['byDevQuality'] {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows.filter((item) => rowHorizon(item) === 60)) {
    const attribution = lookupQuality(row, qualityIndex);
    for (const bucket of devQualityBuckets(attribution, candidateIndex)) {
      buckets.set(bucket, [...(buckets.get(bucket) ?? []), row]);
    }
  }
  return [...buckets.entries()]
    .map(([bucket, scoped]) => {
      const ok = scoped.filter(isOk);
      const deltas = ok.map(rowDelta).filter((value): value is number => value != null);
      const postCostDeltas = deltas.map((value) => value - roundTripCostPct);
      return {
        bucket,
        rows: scoped.length,
        okRows: ok.length,
        medianDeltaPct60s: percentile(deltas, 0.5),
        medianPostCostDeltaPct60s: percentile(postCostDeltas, 0.5),
        positive60s: deltas.filter((value) => value > 0).length,
        positivePostCost60s: postCostDeltas.filter((value) => value > 0).length,
      };
    })
    .sort((a, b) => b.okRows - a.okRows || b.positivePostCost60s - a.positivePostCost60s || a.bucket.localeCompare(b.bucket))
    .slice(0, 50);
}

function buildReasonStats(rows: JsonRow[], roundTripCostPct: number): RotationReport['noTrade']['byReason'] {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows) {
    const key = str(obj(row.extras).noTradeReason) || str(row.rejectReason) || '(unknown)';
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return [...buckets.entries()]
    .map(([reason, scoped]) => {
      const ok = scoped.filter(isOk);
      const deltas = ok.map(rowDelta).filter((value): value is number => value != null);
      const postCostDeltas = deltas.map((value) => value - roundTripCostPct);
      return {
        reason,
        count: scoped.length,
        okRows: ok.length,
        positiveRows: deltas.filter((value) => value > 0).length,
        positivePostCostRows: postCostDeltas.filter((value) => value > 0).length,
        medianDeltaPct: percentile(deltas, 0.5),
        medianPostCostDeltaPct: percentile(postCostDeltas, 0.5),
      };
    })
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function formatPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function formatSol(value: number | null): string {
  return value == null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(6)}`;
}

function renderStatsTable(rows: HorizonStats[]): string {
  if (rows.length === 0) return '_No rows._';
  return [
    '| horizon | rows | ok | ok coverage | positive | postCost>0 | >=3% | >=12% | p25 | median | median postCostDelta | avg | avg postCostDelta |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.horizonSec}s | ${row.rows} | ${row.okRows} | ` +
      `${row.rows > 0 ? `${((row.okRows / row.rows) * 100).toFixed(1)}%` : 'n/a'} | ` +
      `${row.positiveRows} | ${row.positivePostCostRows} | ` +
      `${row.strongRows} | ${row.t1Rows} | ${formatPct(row.p25DeltaPct)} | ${formatPct(row.medianDeltaPct)} | ` +
      `${formatPct(row.medianPostCostDeltaPct)} | ${formatPct(row.avgDeltaPct)} | ${formatPct(row.avgPostCostDeltaPct)} |`
    ),
  ].join('\n');
}

function renderPaperArmTable(rows: PaperArmStats[]): string {
  if (rows.length === 0) return '_No rotation paper trade rows._';
  return [
    '| arm | closes | W/L | net SOL | token-only SOL | refund-adjusted SOL | wallet-drag stress SOL | edge pass/fail | median cost ratio | wallet drag ratio | required gross move | T1 hit | hardCut | tokenWinRefundLose | MFE>=5 refundLose | MFE>=12 refundLose | MAE<=-5 within15 | MAE<=-10 preT1 | med worst MAE | med hardCut MAE | median hold | top exits |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ...rows.map((row) =>
      `| ${row.armName} | ${row.rows} | ${row.wins}/${row.losses} | ${formatSol(row.netSol)} | ` +
      `${formatSol(row.netSolTokenOnly)} | ${formatSol(row.refundAdjustedNetSol)} | ${formatSol(row.rentAdjustedNetSol)} | ` +
      `${row.edgePassRows}/${row.edgeFailRows}${row.edgeRows === 0 ? ' (n/a)' : ''} | ` +
      `${formatPct(row.medianEdgeCostRatio)} | ${formatPct(row.medianEdgeWalletDragRatio)} | ${formatPct(row.medianRequiredGrossMovePct)} | ` +
      `${row.t1Rows}/${row.rows} | ${row.hardCutRows} | ${row.tokenOnlyWinnerRefundLoserRows} | ` +
      `${row.mfe5RefundLoserRows} | ${row.mfe12RefundLoserRows} | ${row.mae5Within15Rows} | ${row.mae10BeforeT1Rows} | ` +
      `${formatPct(row.medianMaeWorstPct)} | ${formatPct(row.medianHardCutMaePct)} | ` +
      `${row.medianHoldSec == null ? 'n/a' : `${row.medianHoldSec.toFixed(0)}s`} | ` +
      `${row.topExitReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} |`
    ),
  ].join('\n');
}

function renderWinnerEntryPairingTable(rows: WinnerEntryPairingStats[]): string {
  if (rows.length === 0) return '_No winner-entry pairing rows._';
  return [
    '| arm | exit bucket | closes | W/L | net SOL | token-only SOL | refund-adjusted SOL | wallet-drag stress SOL | med MFE | med MAE | median hold |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.armName} | ${row.exitBucket} | ${row.rows} | ${row.wins}/${row.losses} | ` +
      `${formatSol(row.netSol)} | ${formatSol(row.netSolTokenOnly)} | ${formatSol(row.refundAdjustedNetSol)} | ` +
      `${formatSol(row.rentAdjustedNetSol)} | ${formatPct(row.medianMfePct)} | ${formatPct(row.medianMaePct)} | ` +
      `${row.medianHoldSec == null ? 'n/a' : `${row.medianHoldSec.toFixed(0)}s`} |`
    ),
  ].join('\n');
}

function renderWinnerEntryDiagnosticsTable(rows: WinnerEntryDiagnosticStats[]): string {
  if (rows.length === 0) return '_No winner-entry diagnostic rows._';
  return [
    '| arm | exit bucket | closes | med topup | med sellPressure30 | med anchor buy SOL | fresh topup | high-risk flags | unknown-quality flags |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.armName} | ${row.exitBucket} | ${row.rows} | ${formatPct(row.medianTopupStrength)} | ` +
      `${formatPct(row.medianSellPressure30)} | ${row.medianAnchorBuySol == null ? 'n/a' : row.medianAnchorBuySol.toFixed(4)} | ` +
      `${formatPct(row.freshTopupRate)} | ${formatPct(row.highRiskFlagRate)} | ${formatPct(row.unknownQualityRate)} |`
    ),
  ].join('\n');
}

function renderUnderfillEntryQualityTable(rows: UnderfillEntryQualityStats[]): string {
  if (rows.length === 0) return '_No underfill entry-quality rows._';
  const lines = [
    '| scope | rows | reference rows | favorable/unfavorable | median entry vs KOL fill | p75 entry vs KOL fill |',
    '|---|---:|---:|---:|---:|---:|',
  ];
  for (const row of rows) {
    lines.push([
      row.scope,
      row.rows,
      row.referenceRows,
      `${row.favorableRows}/${row.unfavorableRows}`,
      formatPct(row.medianEntryVsKolFillPct),
      formatPct(row.p75EntryVsKolFillPct),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  return lines.join('\n');
}

function renderUnderfillRouteCohorts(rows: UnderfillRouteCohortStats[]): string {
  if (rows.length === 0) return '_No underfill route cohort rows._';
  return [
    '| cohort | closes | route known/unknown | 2+ KOL | unknown KOL | cost-aware | W/L | token-only SOL | refund-adjusted SOL | postCost>0 | edge pass/fail | T1 hit | med MFE | median hold |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.cohort} | ${row.rows} | ${row.routeKnownRows}/${row.routeUnknownRows} | ` +
      `${row.independentKol2Rows} | ${row.unknownKolRows} | ${row.costAwareRows} | ${row.wins}/${row.losses} | ` +
      `${formatSol(row.netSolTokenOnly)} | ${formatSol(row.refundAdjustedNetSol)} | ` +
      `${row.refundAdjustedWinRows}/${row.rows} | ${row.edgePassRows}/${row.edgeFailRows} | ${row.t1Rows}/${row.rows} | ` +
      `${formatPct(row.medianMfePct)} | ${row.medianHoldSec == null ? 'n/a' : `${row.medianHoldSec.toFixed(0)}s`} |`
    ),
  ].join('\n');
}

function renderRouteProofFreshness(row: RouteProofFreshnessStats): string {
  const byArm = row.freshByArm.length === 0
    ? '_No fresh arm rows._'
    : [
        '| arm | fresh closes | writer schema | route-proof schema | exit evidence | skipped | missing evidence | routeFound true/false/null | route proof | latest close | latest evidence | top writer schemas | top skip reasons |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|',
        ...row.freshByArm.map((item) =>
          `| ${item.armName} | ${item.rows} | ${item.paperCloseWriterSchemaRows}/${item.rows} | ` +
          `${item.rotationExitRouteProofSchemaRows}/${item.rows} | ${item.exitQuoteEvidenceRows}/${item.exitRouteInstrumentedRows} | ` +
          `${item.exitRouteProofSkippedRows} | ${item.missingEvidenceRows} | ` +
          `${item.routeFoundTrueRows}/${item.routeFoundFalseRows}/${item.routeFoundNullRows} | ` +
          `${item.routeProofRows}/${item.rows} | ${item.latestCloseAt ?? 'n/a'} | ${item.latestExitQuoteEvidenceAt ?? 'n/a'} | ` +
          `${item.topPaperCloseWriterSchemas.map((schema) => `${schema.schema}:${schema.count}`).join(', ') || 'n/a'} | ` +
          `${item.topExitRouteProofSkipReasons.map((reason) => `${reason.reason}:${reason.count}`).join(', ') || 'n/a'} |`
        ),
      ].join('\n');
  return [
    '| verdict | fresh since | cutoff | latest underfill | latest cost-aware | latest evidence | latest no-trade | underfill | fresh | no-trade events | writer schema | route-proof schema | exit evidence | skipped | routeFound true/false/null | missing instrumentation | route proof | route unknown | candidateId | 2+ KOL | cost-aware | narrow ready | reasons |',
    '|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    `| ${row.verdict} | ${row.freshSince ?? 'n/a'} | ${row.cutoffSource} | ` +
      `${row.latestUnderfillCloseAt ?? 'n/a'} | ${row.latestCostAwareCloseAt ?? 'n/a'} | ` +
      `${row.latestExitQuoteEvidenceAt ?? 'n/a'} | ${row.latestNoTradeAt ?? 'n/a'} | ` +
      `${row.underfillRows} | ${row.freshRows}/${row.minRequiredFreshRows} | ` +
      `${row.freshNoTradeEvents} (${row.freshNoTradeRows} rows) | ` +
      `${row.paperCloseWriterSchemaRows}/${row.freshRows} | ${row.rotationExitRouteProofSchemaRows}/${row.freshRows} | ` +
      `${row.exitQuoteEvidenceRows}/${row.exitRouteInstrumentedRows} | ${row.exitRouteProofSkippedRows} | ` +
      `${row.exitQuoteRouteFoundRows}/${row.exitQuoteNoRouteRows}/${row.exitQuoteUnknownRows} | ` +
      `${row.instrumentationMissingRows} | ${row.routeProofRows}/${row.freshRows} | ` +
      `${row.routeUnknownRows}/${row.freshRows} | ${row.candidateIdRows}/${row.freshRows} | ` +
      `${row.twoPlusKolRows}/${row.freshRows} | ${row.costAwareRows}/${row.freshRows} | ` +
      `${row.routeProofedTwoPlusCostAwareTimestampedRows}/${row.routeProofedTwoPlusCostAwareRows} | ` +
      `${row.reasons.join('; ') || 'n/a'} |`,
    '',
    `- explicit no-route: ${row.explicitNoRouteRows}/${row.freshRows}`,
    `- exit route proof skipped/inconclusive: ${row.exitRouteProofSkippedRows}/${row.freshRows}`,
    `- rotation no-trade candidates: ${row.freshNoTradeEvents} events / ${row.freshNoTradeRows} rows`,
    `- top rotation no-trade reasons: ${row.topNoTradeReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- runtime missed-alpha: ${row.freshMissedAlphaEvents} events / ${row.freshMissedAlphaRows} rows`,
    `- runtime policy decisions: ${row.freshPolicyDecisionRows} rows; rotation policy decisions: ${row.freshRotationPolicyDecisionRows}`,
    `- top missed-alpha entry reasons: ${row.topMissedAlphaEntryReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- top missed-alpha reject reasons: ${row.topMissedAlphaRejectReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- top policy entry reasons: ${row.topPolicyEntryReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- top policy reject reasons: ${row.topPolicyRejectReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- paper close writer schemas: ${row.topPaperCloseWriterSchemas.map((item) => `${item.schema}:${item.count}`).join(', ') || 'n/a'}`,
    `- top exit-route proof skip reasons: ${row.topExitRouteProofSkipReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- top route-unknown reasons: ${row.topRouteUnknownReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    '',
    '### Route Proof Freshness By Arm',
    byArm,
  ].join('\n');
}

function renderRotationCandidateFunnel(row: RotationCandidateFunnelStats): string {
  return [
    '| verdict | since | cutoff | KOL tx | buy/sell | distinct KOL/token | latest KOL tx | call funnel | rotation funnel | rotation no-trade | rotation policy | rotation closes | reasons |',
    '|---|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---|',
    `| ${row.verdict} | ${row.since} | ${row.cutoffSource} | ${row.kolTxRows} | ` +
      `${row.kolBuyRows}/${row.kolSellRows} | ${row.distinctKols}/${row.distinctTokens} | ` +
      `${row.latestKolTxAt ?? 'n/a'} | ${row.callFunnelRows} | ${row.rotationCallFunnelRows} | ` +
      `${row.rotationNoTradeEvents} (${row.rotationNoTradeRows} rows) | ${row.rotationPolicyDecisionRows} | ` +
      `${row.rotationPaperCloseRows} | ${row.reasons.join('; ') || 'n/a'} |`,
    '',
    `- shadow KOL tx rows: ${row.kolShadowRows}/${row.kolTxRows}`,
    `- top KOL tx actions: ${row.topKolTxActions.map((item) => `${item.action}:${item.count}`).join(', ') || 'n/a'}`,
    `- top KOL tx KOLs: ${row.topKolTxKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'}`,
    `- top buy KOLs: ${row.topBuyKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'}`,
    `- top call-funnel event types: ${row.topCallFunnelEventTypes.map((item) => `${item.eventType}:${item.count}`).join(', ') || 'n/a'}`,
    `- top rotation call-funnel event types: ${row.topRotationCallFunnelEventTypes.map((item) => `${item.eventType}:${item.count}`).join(', ') || 'n/a'}`,
    `- top rotation no-trade reasons: ${row.topNoTradeReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- top rotation policy entry reasons: ${row.topPolicyEntryReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
  ].join('\n');
}

function renderRotationDetectorReplay(row: RotationDetectorReplayStats): string {
  const tokenRows = row.tokens.length === 0
    ? '_No current-session token rows._'
    : [
        '| token | tx | buy/sell | gross buy SOL | small buys | S/A buys | KOLs | first/last buy | latest sell | replay age | recent sells | vanilla blockers | underfill blockers | top KOLs |',
        '|---|---:|---:|---:|---:|---:|---:|---|---|---:|---:|---|---|---|',
        ...row.tokens.map((token) =>
          `| ${token.shortMint} | ${token.txRows} | ${token.buyRows}/${token.sellRows} | ` +
          `${token.grossBuySol.toFixed(4)} | ${token.smallBuyRows} | ${token.eligibleUnderfillBuyRows} | ` +
          `${token.distinctKols} | ${(token.firstBuyAt ?? 'n/a')} / ${(token.lastBuyAt ?? 'n/a')} | ` +
          `${token.latestSellAt ?? 'n/a'} | ` +
          `${token.lastBuyAgeSec == null ? 'n/a' : token.lastBuyAgeSec.toFixed(1)}s | ` +
          `${token.recentSellRows} | ${token.vanillaBlockers.join(', ') || 'n/a'} | ` +
          `${token.underfillBlockers.join(', ') || 'n/a'} | ` +
          `${token.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} |`
        ),
      ].join('\n');
  return [
    '| verdict | since | cutoff | tokens | KOL tx | buy/sell | top vanilla blockers | top underfill blockers | reasons |',
    '|---|---|---|---:|---:|---:|---|---|---|',
    `| ${row.verdict} | ${row.since} | ${row.cutoffSource} | ${row.tokenRows} | ${row.kolTxRows} | ` +
      `${row.kolBuyRows}/${row.kolSellRows} | ` +
      `${row.topVanillaBlockers.map((item) => `${item.blocker}:${item.count}`).join(', ') || 'n/a'} | ` +
      `${row.topUnderfillBlockers.map((item) => `${item.blocker}:${item.count}`).join(', ') || 'n/a'} | ` +
      `${row.reasons.join('; ') || 'n/a'} |`,
    '',
    `- replay defaults: buyCount>=${ROTATION_REPLAY_MIN_BUY_COUNT}, ` +
      `smallBuys>=${ROTATION_REPLAY_MIN_SMALL_BUY_COUNT} <=${ROTATION_REPLAY_SMALL_BUY_MAX_SOL} SOL, ` +
      `grossBuy>=${ROTATION_REPLAY_MIN_GROSS_BUY_SOL} SOL, recentSellWindow=${ROTATION_REPLAY_RECENT_SELL_SEC}s`,
    `- underfill replay uses S/A KOL buys and stops at price-context checks; this section does not simulate live price discount.`,
    '',
    tokenRows,
  ].join('\n');
}

function renderRotationDetectorBlockerMarkouts(row: RotationDetectorBlockerMarkoutStats): string {
  const bucketRows = row.topBuckets.length === 0
    ? '_No detector blocker markout buckets._'
    : [
        '| scope | blocker | verdict | tokens | markout tokens | token coverage | buy markouts | min ok coverage | primary postCost | primary positive | top KOLs | reasons |',
        '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|',
        ...row.topBuckets.map((bucket) =>
          `| ${bucket.scope} | ${bucket.blocker} | ${bucket.verdict} | ${bucket.tokenRows} | ` +
          `${bucket.markoutTokenRows} | ${formatPct(bucket.tokenCoverage)} | ${bucket.buyMarkoutRows} | ` +
          `${formatPct(bucket.minOkCoverage)} | ${formatPct(bucket.primaryMedianPostCostDeltaPct)} | ` +
          `${formatPct(bucket.primaryPostCostPositiveRate)} | ` +
          `${bucket.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${bucket.reasons.join('; ') || 'n/a'} |`
        ),
      ].join('\n');
  const tokenRows = row.topBuckets.length === 0
    ? '_No detector blocker token rows._'
    : row.topBuckets.map((bucket) => {
        const rows = bucket.topTokens.length === 0
          ? '_No tokens._'
          : [
              '| token | tx | buy/sell | markouts | primary postCost | best horizon | best postCost | top KOLs |',
              '|---|---:|---:|---:|---:|---:|---:|---|',
              ...bucket.topTokens.map((token) =>
                `| ${token.shortMint} | ${token.txRows} | ${token.buyRows}/${token.sellRows} | ${token.markoutRows} | ` +
                `${formatPct(token.primaryMedianPostCostDeltaPct)} | ` +
                `${token.bestHorizonSec == null ? 'n/a' : `${token.bestHorizonSec}s`} | ` +
                `${formatPct(token.bestMedianPostCostDeltaPct)} | ` +
                `${token.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} |`
              ),
            ].join('\n');
        return [
          `### ${bucket.scope}:${bucket.blocker}`,
          rows,
        ].join('\n');
      }).join('\n\n');
  return [
    '| since | cutoff | replay tokens | buy markouts | buckets |',
    '|---|---|---:|---:|---:|',
    `| ${row.since} | ${row.cutoffSource} | ${row.tokenRows} | ${row.buyMarkoutRows} | ${row.topBuckets.length} |`,
    '',
    bucketRows,
    '',
    tokenRows,
  ].join('\n');
}

function renderRotationStaleBuyReview(row: RotationStaleBuyReviewStats): string {
  const bucketRows = row.buckets.length === 0
    ? '_No stale-buy review buckets._'
    : [
        '| bucket | verdict | tokens | markout tokens | missing tokens | paper probe tokens | unmeasured tokens | other probe tokens | dark tokens | token coverage | buy markouts | probe rows | other probe rows | min ok coverage | primary postCost | primary positive | paper postCost | paper positive | med age | med gross SOL | top KOLs | top missing KOLs | top unmeasured KOLs | top dark KOLs | other probe reasons | reasons |',
        '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|---|---|',
        ...row.buckets.map((bucket) =>
          `| ${bucket.bucket} | ${bucket.verdict} | ${bucket.tokenRows} | ${bucket.markoutTokenRows} | ` +
          `${bucket.missingMarkoutTokenRows} | ${bucket.paperProbeTokenRows} | ${bucket.unmeasuredTokenRows} | ` +
          `${bucket.otherPaperProbeTokenRows} | ${bucket.darkTokenRows} | ` +
          `${formatPct(bucket.tokenCoverage)} | ${bucket.buyMarkoutRows} | ${bucket.paperProbeRows} | ${bucket.otherPaperProbeRows} | ${formatPct(bucket.minOkCoverage)} | ` +
          `${formatPct(bucket.primaryMedianPostCostDeltaPct)} | ${formatPct(bucket.primaryPostCostPositiveRate)} | ` +
          `${formatPct(bucket.paperProbePrimaryMedianPostCostDeltaPct)} | ${formatPct(bucket.paperProbePrimaryPostCostPositiveRate)} | ` +
          `${bucket.medianLastBuyAgeSec == null ? 'n/a' : `${bucket.medianLastBuyAgeSec.toFixed(0)}s`} | ` +
          `${bucket.medianGrossBuySol == null ? 'n/a' : bucket.medianGrossBuySol.toFixed(4)} | ` +
          `${bucket.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${bucket.topMissingKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${bucket.topUnmeasuredKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${bucket.topDarkKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${bucket.topOtherPaperProbeReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${bucket.reasons.join('; ') || 'n/a'} |`
        ),
      ].join('\n');
  const tokenRows = row.buckets.length === 0
    ? '_No stale-buy token rows._'
    : row.buckets.map((bucket) => {
        const rows = bucket.topTokens.length === 0
          ? '_No tokens._'
          : [
              '| token | tx | buy/sell | markouts | primary postCost | best horizon | best postCost | top KOLs |',
              '|---|---:|---:|---:|---:|---:|---:|---|',
              ...bucket.topTokens.map((token) =>
                `| ${token.shortMint} | ${token.txRows} | ${token.buyRows}/${token.sellRows} | ${token.markoutRows} | ` +
                `${formatPct(token.primaryMedianPostCostDeltaPct)} | ` +
                `${token.bestHorizonSec == null ? 'n/a' : `${token.bestHorizonSec}s`} | ` +
                `${formatPct(token.bestMedianPostCostDeltaPct)} | ` +
                `${token.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} |`
              ),
            ].join('\n');
        return [
          `### ${bucket.bucket}`,
          rows,
          '',
          '#### Missing Markout Tokens',
          bucket.topMissingTokens.length === 0
            ? '_No missing markout tokens._'
            : [
                '| token | tx | buy/sell | age | gross SOL | KOLs | top KOLs |',
                '|---|---:|---:|---:|---:|---:|---|',
                ...bucket.topMissingTokens.map((token) =>
                  `| ${token.shortMint} | ${token.txRows} | ${token.buyRows}/${token.sellRows} | ` +
                  `${token.lastBuyAgeSec == null ? 'n/a' : `${token.lastBuyAgeSec.toFixed(0)}s`} | ` +
                  `${token.grossBuySol.toFixed(4)} | ${token.distinctKols} | ` +
                  `${token.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} |`
                ),
              ].join('\n'),
          '',
          '#### Unmeasured Tokens',
          bucket.topUnmeasuredTokens.length === 0
            ? '_No unmeasured tokens._'
            : [
                '| token | tx | buy/sell | age | gross SOL | KOLs | top KOLs |',
                '|---|---:|---:|---:|---:|---:|---|',
                ...bucket.topUnmeasuredTokens.map((token) =>
                  `| ${token.shortMint} | ${token.txRows} | ${token.buyRows}/${token.sellRows} | ` +
                  `${token.lastBuyAgeSec == null ? 'n/a' : `${token.lastBuyAgeSec.toFixed(0)}s`} | ` +
                  `${token.grossBuySol.toFixed(4)} | ${token.distinctKols} | ` +
                  `${token.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} |`
                ),
              ].join('\n'),
          '',
          '#### Dark Tokens',
          bucket.topDarkTokens.length === 0
            ? '_No dark tokens._'
            : [
                '| token | tx | buy/sell | age | gross SOL | KOLs | top KOLs |',
                '|---|---:|---:|---:|---:|---:|---|',
                ...bucket.topDarkTokens.map((token) =>
                  `| ${token.shortMint} | ${token.txRows} | ${token.buyRows}/${token.sellRows} | ` +
                  `${token.lastBuyAgeSec == null ? 'n/a' : `${token.lastBuyAgeSec.toFixed(0)}s`} | ` +
                  `${token.grossBuySol.toFixed(4)} | ${token.distinctKols} | ` +
                  `${token.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} |`
                ),
              ].join('\n'),
        ].join('\n');
      }).join('\n\n');
  return [
    '| since | stale tokens | review candidates | excluded recent-sell | buy markouts | paper probes | buckets |',
    '|---|---:|---:|---:|---:|---:|---:|',
    `| ${row.since} | ${row.tokenRows} | ${row.candidateTokenRows} | ${row.excludedRecentSellTokenRows} | ${row.buyMarkoutRows} | ${row.paperProbeRows} | ${row.buckets.length} |`,
    '',
    bucketRows,
    '',
    tokenRows,
  ].join('\n');
}

function renderKolHunterAdmissionSkipMarkouts(row: KolHunterAdmissionSkipMarkoutStats): string {
  const tokenRows = row.topTokens.length === 0
    ? '_No admission-skip token probes._'
    : [
        '| token | rows | probes | ok | best horizon | best postCost | top KOLs |',
        '|---|---:|---:|---:|---:|---:|---|',
        ...row.topTokens.map((token) =>
          `| ${token.shortMint} | ${token.rows} | ${token.probeRows} | ${token.okRows} | ` +
          `${token.bestHorizonSec == null ? 'n/a' : `${token.bestHorizonSec}s`} | ` +
          `${formatPct(token.bestMedianPostCostDeltaPct)} | ` +
          `${token.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} |`
        ),
      ].join('\n');
  return [
    '| verdict | since | rows | probes | ok | tokens | max-concurrent rows | min ok coverage | primary | primary postCost | primary positive | top KOLs | top reasons | reasons |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|',
    `| ${row.verdict} | ${row.since} | ${row.rows} | ${row.probeRows} | ${row.okRows} | ` +
      `${row.tokenRows} | ${row.maxConcurrentRows} | ${formatPct(row.minOkCoverage)} | ` +
      `${row.primaryHorizonSec == null ? 'n/a' : `${row.primaryHorizonSec}s`} | ` +
      `${formatPct(row.primaryMedianPostCostDeltaPct)} | ${formatPct(row.primaryPostCostPositiveRate)} | ` +
      `${row.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} | ` +
      `${row.topReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} | ` +
      `${row.reasons.join('; ') || 'n/a'} |`,
    '',
    '### Admission-Skip Horizons',
    renderStatsTable(row.horizons),
    '',
    '### Admission-Skip Tokens',
    tokenRows,
  ].join('\n');
}

function renderRotationPriceContextMarkouts(row: RotationPriceContextMarkoutStats): string {
  const tokenRows = row.topTokens.length === 0
    ? '_No covered price-context token markouts._'
    : [
        '| token | replay tx | buys | gross buy SOL | KOLs | markouts | ok | best horizon | best median postCost | top KOLs |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|',
        ...row.topTokens.map((token) =>
          `| ${token.shortMint} | ${token.txRows} | ${token.buyRows} | ${token.grossBuySol.toFixed(4)} | ` +
          `${token.distinctKols} | ${token.markoutRows} | ${token.okRows} | ` +
          `${token.bestHorizonSec == null ? 'n/a' : `${token.bestHorizonSec}s`} | ` +
          `${formatPct(token.bestMedianPostCostDeltaPct)} | ` +
          `${token.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} |`
        ),
      ].join('\n');
  const missingRows = row.coverageGap.topMissingTokens.length === 0
    ? '_No missing price-context candidate tokens._'
    : [
        '| token | gap reason | replay tx | buys | gross buy SOL | KOLs | latest buy | any markout | missed-alpha | rotation no-trade | policy | rotation policy | attr drift | top no-trade reasons | top rotation policy rejects | top attr drift rejects | top attr sources | top attr survival | top KOLs |',
        '|---|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---|---|---|---|---|---|',
        ...row.coverageGap.topMissingTokens.map((token) =>
          `| ${token.shortMint} | ${token.gapReason} | ${token.txRows} | ${token.buyRows} | ` +
          `${token.grossBuySol.toFixed(4)} | ${token.distinctKols} | ${token.latestBuyAt ?? 'n/a'} | ` +
          `${token.anyMarkoutRows} | ${token.missedAlphaRows} | ${token.rotationNoTradeRows} | ` +
          `${token.policyDecisionRows} | ${token.rotationPolicyDecisionRows} | ${token.rotationPolicyAttributionDriftRows} | ` +
          `${token.topNoTradeReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topRotationPolicyRejectReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topRotationPolicyAttributionDriftReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topRotationPolicyAttributionSources.map((item) => `${item.source}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topRotationPolicyAttributionSurvivalReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} |`
        ),
      ].join('\n');
  return [
    '| verdict | since | candidates | candidate KOL tx | markout tokens | token coverage | buy markouts | min ok coverage | reasons |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|',
    `| ${row.verdict} | ${row.since} | ${row.candidateTokenRows} | ${row.candidateKolTxRows} | ` +
      `${row.markoutTokenRows} | ${formatPct(row.markoutTokenCoverage)} | ${row.buyMarkoutRows} | ` +
      `${formatPct(row.minOkCoverage)} | ${row.reasons.join('; ') || 'n/a'} |`,
    '',
    '### Price-Context Markout Horizons',
    renderStatsTable(row.horizons),
    '',
    '### Covered Price-Context Tokens',
    tokenRows,
    '',
    '### Price-Context Coverage Gap',
    `- missing buy-markout tokens: ${row.coverageGap.missingBuyMarkoutTokenRows}/${row.candidateTokenRows}`,
    `- missing KOL tx rows: ${row.coverageGap.missingBuyMarkoutKolTxRows}/${row.candidateKolTxRows}`,
    `- rotation-specific missing tokens: ${row.coverageGap.rotationSpecificMissingTokenRows}/${row.coverageGap.missingBuyMarkoutTokenRows}`,
    `- rotation-specific missing KOL tx rows: ${row.coverageGap.rotationSpecificMissingKolTxRows}/${row.coverageGap.missingBuyMarkoutKolTxRows}`,
    `- rotation policy attribution drift tokens: ${row.coverageGap.rotationPolicyAttributionDriftTokenRows}/${row.coverageGap.rotationSpecificMissingTokenRows}`,
    `- rotation policy attribution drift rows: ${row.coverageGap.rotationPolicyAttributionDriftRows}`,
    `- top missing reasons: ${row.coverageGap.topMissingReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- top missing KOLs: ${row.coverageGap.topMissingKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'}`,
    `- top missing no-trade reasons: ${row.coverageGap.topMissingNoTradeReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- top missing policy entry reasons: ${row.coverageGap.topMissingPolicyEntryReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- top missing policy reject reasons: ${row.coverageGap.topMissingPolicyRejectReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- top missing rotation policy entry reasons: ${row.coverageGap.topMissingRotationPolicyEntryReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- top missing rotation policy reject reasons: ${row.coverageGap.topMissingRotationPolicyRejectReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- top missing rotation policy attribution drift reasons: ${row.coverageGap.topMissingRotationPolicyAttributionDriftReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- top missing rotation policy attribution sources: ${row.coverageGap.topMissingRotationPolicyAttributionSources.map((item) => `${item.source}:${item.count}`).join(', ') || 'n/a'}`,
    `- top missing rotation policy attribution survival reasons: ${row.coverageGap.topMissingRotationPolicyAttributionSurvivalReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    '',
    missingRows,
  ].join('\n');
}

function renderRotationDecayBlockMarkouts(row: RotationDecayBlockMarkoutStats): string {
  const tokenRows = row.topTokens.length === 0
    ? '_No rotation decay block token rows._'
    : [
        '| token | class | policy rows | probe rows | ok | primary postCost | T+60 postCost | recovery | best horizon | best median postCost | policy score | styles | independent | tiers | top KOLs | top rejects | top sources | top survival |',
        '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|---|---|---|',
        ...row.topTokens.map((token) =>
          `| ${token.shortMint} | ${token.recoveryClass} | ${token.policyRows} | ${token.probeRows} | ${token.okRows} | ` +
          `${formatPct(token.primaryMedianPostCostDeltaPct)} | ${formatPct(token.decayMedianPostCostDeltaPct)} | ` +
          `${formatPct(token.recoveryDeltaPct)} | ` +
          `${token.bestHorizonSec == null ? 'n/a' : `${token.bestHorizonSec}s`} | ` +
          `${formatPct(token.bestMedianPostCostDeltaPct)} | ` +
          `${token.medianPolicyKolScore == null ? 'n/a' : token.medianPolicyKolScore.toFixed(2)} | ` +
          `${token.topStyleBuckets.map((item) => `${item.style}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topIndependentBuckets.map((item) => `${item.bucket}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topKolTiers.map((item) => `${item.tier}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topRejectReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topSources.map((item) => `${item.source}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topSurvivalReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} |`
        ),
      ].join('\n');
  const watchlist = row.graceWatchlist;
  const watchlistRows = watchlist.topTokens.length === 0
    ? '_No rotation decay grace watchlist tokens._'
    : [
        '| token | class | policy rows | probe rows | primary postCost | T+60 postCost | recovery | policy score | styles | independent | tiers | top KOLs |',
        '|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---|',
        ...watchlist.topTokens.map((token) =>
          `| ${token.shortMint} | ${token.recoveryClass} | ${token.policyRows} | ${token.probeRows} | ` +
          `${formatPct(token.primaryMedianPostCostDeltaPct)} | ${formatPct(token.decayMedianPostCostDeltaPct)} | ` +
          `${formatPct(token.recoveryDeltaPct)} | ${token.medianPolicyKolScore == null ? 'n/a' : token.medianPolicyKolScore.toFixed(2)} | ` +
          `${token.topStyleBuckets.map((item) => `${item.style}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topIndependentBuckets.map((item) => `${item.bucket}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topKolTiers.map((item) => `${item.tier}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} |`
        ),
      ].join('\n');
  const delayedRows = row.topDelayedRecoveryTokens.length === 0
    ? '_No delayed recovery tokens._'
    : [
        '| token | policy rows | probe rows | primary postCost | T+60 postCost | recovery | policy score | styles | independent | tiers | top KOLs | versions | top sources |',
        '|---|---:|---:|---:|---:|---:|---:|---|---|---|---|---|---|',
        ...row.topDelayedRecoveryTokens.map((token) =>
          `| ${token.shortMint} | ${token.policyRows} | ${token.probeRows} | ` +
          `${formatPct(token.primaryMedianPostCostDeltaPct)} | ${formatPct(token.decayMedianPostCostDeltaPct)} | ` +
          `${formatPct(token.recoveryDeltaPct)} | ` +
          `${token.medianPolicyKolScore == null ? 'n/a' : token.medianPolicyKolScore.toFixed(2)} | ` +
          `${token.topStyleBuckets.map((item) => `${item.style}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topIndependentBuckets.map((item) => `${item.bucket}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topKolTiers.map((item) => `${item.tier}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topParameterVersions.map((item) => `${item.version}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${token.topSources.map((item) => `${item.source}:${item.count}`).join(', ') || 'n/a'} |`
        ),
      ].join('\n');
  const profileRows = row.recoveryProfiles.length === 0
    ? '_No rotation decay recovery profiles._'
    : [
        '| class | tokens | policy rows | med policy score | versions | signal sources | styles | independent | liquidity | security | tiers | top KOLs |',
        '|---|---:|---:|---:|---|---|---|---|---|---|---|---|',
        ...row.recoveryProfiles.map((profile) =>
          `| ${profile.recoveryClass} | ${profile.tokenRows} | ${profile.policyRows} | ` +
          `${profile.medianPolicyKolScore == null ? 'n/a' : profile.medianPolicyKolScore.toFixed(2)} | ` +
          `${profile.topParameterVersions.map((item) => `${item.version}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${profile.topSignalSources.map((item) => `${item.source}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${profile.topStyleBuckets.map((item) => `${item.style}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${profile.topIndependentBuckets.map((item) => `${item.bucket}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${profile.topLiquidityBuckets.map((item) => `${item.bucket}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${profile.topSecurityBuckets.map((item) => `${item.bucket}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${profile.topKolTiers.map((item) => `${item.tier}:${item.count}`).join(', ') || 'n/a'} | ` +
          `${profile.topKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} |`
        ),
      ].join('\n');
  return [
    '| verdict | since | policy rows | tokens | immediate winner | delayed recovery | saved loss | insufficient | probe tokens | probe rows | min ok coverage | reasons |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    `| ${row.verdict} | ${row.since} | ${row.policyRows} | ${row.tokenRows} | ` +
      `${row.immediateWinnerTokenRows} | ${row.delayedRecoveryTokenRows} | ${row.savedLossTokenRows} | ` +
      `${row.insufficientCoverageTokenRows} | ${row.probeTokenRows} | ${row.probeRows} | ${formatPct(row.minOkCoverage)} | ` +
      `${row.reasons.join('; ') || 'n/a'} |`,
    '',
    `- top reject reasons: ${row.topRejectReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- top sources: ${row.topSources.map((item) => `${item.source}:${item.count}`).join(', ') || 'n/a'}`,
    `- top survival reasons: ${row.topSurvivalReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
    `- recovery classes: immediate_winner=${row.immediateWinnerTokenRows}, delayed_recovery=${row.delayedRecoveryTokenRows}, saved_loss=${row.savedLossTokenRows}, insufficient_coverage=${row.insufficientCoverageTokenRows}`,
    '',
    '### Rotation Decay Block Horizons',
    renderStatsTable(row.horizons),
    '',
    '### Rotation Decay Recovery Profiles',
    profileRows,
    '',
    '### Rotation Decay Paper-Grace Watchlist',
    '| profile | verdict | tokens | policy rows | immediate | delayed | saved | insufficient | probe rows | min ok coverage | reasons |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    `| ${watchlist.profile} | ${watchlist.verdict} | ${watchlist.tokenRows} | ${watchlist.policyRows} | ` +
      `${watchlist.immediateWinnerTokenRows} | ${watchlist.delayedRecoveryTokenRows} | ${watchlist.savedLossTokenRows} | ` +
      `${watchlist.insufficientCoverageTokenRows} | ${watchlist.probeRows} | ${formatPct(watchlist.minOkCoverage)} | ` +
      `${watchlist.reasons.join('; ') || 'n/a'} |`,
    '',
    renderStatsTable(watchlist.horizons),
    '',
    watchlistRows,
    '',
    '### Rotation Delayed-Recovery Tokens',
    delayedRows,
    '',
    '### Rotation Decay Block Tokens',
    tokenRows,
  ].join('\n');
}

function renderRotationNarrowCohorts(rows: RotationNarrowCohortStats[]): string {
  if (rows.length === 0) return '_No rotation narrow cohort rows._';
  return [
    '| cohort | verdict | closes | route proof | candidateId | 2+ KOL | cost-aware | timestamped 2nd KOL | refund-adjusted | close postCost>0 | edge pass | T1 | min T+ coverage | primary postCost | med MFE | median hold | reasons |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---|',
    ...rows.map((row) =>
      `| ${row.cohort} | ${row.verdict} | ${row.rows}/${row.minRequiredRows} | ` +
      `${row.routeProofRows}/${row.rows} (${formatPct(row.routeProofCoverage)}) | ` +
      `${row.candidateIdRows}/${row.rows} | ${row.twoPlusKolRows}/${row.rows} | ` +
      `${row.costAwareRows}/${row.rows} | ${row.timestampedSecondKolRows}/${row.rows} | ` +
      `${formatSol(row.refundAdjustedNetSol)} | ${formatPct(row.postCostPositiveRate)} | ` +
      `${formatPct(row.edgePassRate)} | ${formatPct(row.t1Rate)} | ${formatPct(row.minOkCoverage)} | ` +
      `${row.primaryHorizonPostCost.map((item) =>
        `T+${item.horizonSec}s ${formatPct(item.medianPostCostDeltaPct)} ` +
        `pos=${formatPct(item.postCostPositiveRate)} cov=${formatPct(item.okCoverage)}`
      ).join(', ') || 'n/a'} | ` +
      `${formatPct(row.medianMfePct)} | ${row.medianHoldSec == null ? 'n/a' : `${row.medianHoldSec.toFixed(0)}s`} | ` +
      `${row.reasons.join('; ') || 'n/a'} |`
    ),
  ].join('\n');
}

function renderLiveEquivalenceBucketTable(rows: LiveEquivalenceBucketStats[]): string {
  if (rows.length === 0) return '_No live-equivalence rows._';
  return [
    '| bucket | rows | liveWould | attempted | blocked | 1-KOL | 2+ KOL | unknown KOL |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.bucket} | ${row.rows} | ${row.liveWouldEnterRows} | ${row.liveAttemptedRows} | ` +
      `${row.blockedRows} | ${row.singleKolRows} | ${row.twoPlusKolRows} | ${row.unknownKolRows} |`
    ),
  ].join('\n');
}

function renderLiveEquivalenceSummary(row: LiveEquivalenceSummary): string {
  return [
    `- total rows: ${row.rotationRows}/${row.totalRows}`,
    `- live would/attempted/blocked: ${row.liveWouldEnterRows}/${row.liveAttemptedRows}/${row.blockedRows}`,
    `- yellow-zone rows: ${row.yellowZoneRows} · 1-KOL=${row.yellowZoneSingleKolRows} · 2+KOL=${row.yellowZoneTwoPlusKolRows} · unknownKOL=${row.yellowZoneUnknownKolRows}`,
    `- route-unknown fallback rows: ${row.routeUnknownFallbackRows}`,
    '',
    '### By Decision Stage',
    renderLiveEquivalenceBucketTable(row.byStage),
    '',
    '### By Live Block Reason',
    renderLiveEquivalenceBucketTable(row.byBlockReason),
  ].join('\n');
}

function renderRouteUnknownReasons(rows: RouteUnknownReasonStats[]): string {
  if (rows.length === 0) return '_No route-unknown reason rows._';
  return [
    '| reason | rows | W/L | refund-adjusted SOL | T1 hit | med MFE | median hold |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.reason} | ${row.rows} | ${row.wins}/${row.losses} | ` +
      `${formatSol(row.refundAdjustedNetSol)} | ${row.t1Rows}/${row.rows} | ` +
      `${formatPct(row.medianMfePct)} | ${row.medianHoldSec == null ? 'n/a' : `${row.medianHoldSec.toFixed(0)}s`} |`
    ),
  ].join('\n');
}

function renderRouteTruthAudit(rows: RouteTruthAuditStats[]): string {
  if (rows.length === 0) return '_No route-truth audit rows._';
  return [
    '| bucket | rows | known/unknown | recovery | W/L | refund-adjusted SOL | med MFE | top reasons/evidence |',
    '|---|---:|---:|---|---:|---:|---:|---|',
    ...rows.map((row) =>
      `| ${row.bucket} | ${row.rows} | ${row.routeKnownRows}/${row.routeUnknownRows} | ${row.recoverability} | ` +
      `${row.wins}/${row.losses} | ${formatSol(row.refundAdjustedNetSol)} | ${formatPct(row.medianMfePct)} | ` +
      `${row.topReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} |`
    ),
  ].join('\n');
}

function renderKolTimingStats(rows: KolTimingStats[]): string {
  if (rows.length === 0) return '_No KOL timing rows._';
  return [
    '| bucket | rows | route known | cost-aware | refund-adjusted SOL | T1 hit | median second KOL delay |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.bucket} | ${row.rows} | ${row.routeKnownRows} | ${row.costAwareRows} | ` +
      `${formatSol(row.refundAdjustedNetSol)} | ${row.t1Rows}/${row.rows} | ` +
      `${row.medianSecondKolDelaySec == null ? 'n/a' : `${row.medianSecondKolDelaySec.toFixed(1)}s`} |`
    ),
  ].join('\n');
}

function renderPosthocSecondKolStats(rows: PosthocSecondKolStats[]): string {
  if (rows.length === 0) return '_No posthoc second-KOL rows._';
  return [
    '| cohort | rows | route known | cost-aware | W/L | refund-adjusted SOL | T1 hit | med MFE | median second KOL delay |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.cohort} | ${row.rows} | ${row.routeKnownRows} | ${row.costAwareRows} | ` +
      `${row.wins}/${row.losses} | ${formatSol(row.refundAdjustedNetSol)} | ${row.t1Rows}/${row.rows} | ` +
      `${formatPct(row.medianMfePct)} | ` +
      `${row.medianSecondKolDelaySec == null ? 'n/a' : `${row.medianSecondKolDelaySec.toFixed(1)}s`} |`
    ),
  ].join('\n');
}

function renderPosthocSecondKolWaitProxies(rows: PosthocSecondKolWaitProxyStats[]): string {
  if (rows.length === 0) return '_No posthoc second-KOL wait proxy rows._';
  return [
    '| cohort | wait profile | rows | observed | current refund-adjusted | current postCost>0 | wait entry favorable | med wait entry move | wait postCost>0 | med wait postCost | p25 wait postCost |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.cohort} | ${row.exitProfile} | ${row.rows} | ${row.observedRows} | ` +
      `${formatSol(row.currentRefundAdjustedNetSol)} | ${formatPct(row.currentPostCostPositiveRate)} | ` +
      `${row.waitEntryFavorableRows}/${row.observedRows} | ${formatPct(row.medianWaitEntryDeltaPct)} | ` +
      `${row.positiveRows}/${row.observedRows} (${formatPct(row.postCostPositiveRate)}) | ` +
      `${formatPct(row.medianPostCostDeltaPct)} | ${formatPct(row.p25PostCostDeltaPct)} |`
    ),
  ].join('\n');
}

function renderPosthocSecondKolCandidateDecisions(rows: PosthocSecondKolCandidateDecision[]): string {
  if (rows.length === 0) return '_No posthoc second-KOL candidate decision rows._';
  return [
    '| cohort | verdict | observed | postCost>0 | med postCost | p25 postCost | current refund-adjusted | reasons |',
    '|---|---|---:|---:|---:|---:|---:|---|',
    ...rows.map((row) =>
      `| ${row.cohort} | ${row.verdict} | ${row.observedRows}/${row.minDecisionObserved} | ` +
      `${formatPct(row.postCostPositiveRate)} | ${formatPct(row.medianPostCostDeltaPct)} | ` +
      `${formatPct(row.p25PostCostDeltaPct)} | ${formatSol(row.currentRefundAdjustedNetSol)} | ` +
      `${row.reasons.join('; ') || 'n/a'} |`
    ),
    '',
    `- thresholds: COLLECT<${POSTHOC_SECOND_KOL_REVIEW_MIN_OBSERVED}, ` +
      `WATCH ${POSTHOC_SECOND_KOL_REVIEW_MIN_OBSERVED}-${POSTHOC_SECOND_KOL_DECISION_MIN_OBSERVED - 1}, ` +
      `PAPER_CANDIDATE>=${POSTHOC_SECOND_KOL_DECISION_MIN_OBSERVED} with postCost>0>=` +
      `${formatPct(POSTHOC_SECOND_KOL_MIN_POSITIVE_RATE)}, median>0, p25>0`,
  ].join('\n');
}

function renderPosthocSecondKolSyntheticPaperArms(rows: PosthocSecondKolSyntheticPaperArm[]): string {
  if (rows.length === 0) return '_No posthoc second-KOL synthetic paper arm rows._';
  return [
    '| synthetic arm | source cohort | verdict | observed | postCost>0 | med/p25 postCost | current refund-adjusted | scope | reasons |',
    '|---|---|---|---:|---:|---:|---:|---|---|',
    ...rows.map((row) =>
      `| ${row.armName} | ${row.sourceCohort} | ${row.verdict} | ` +
      `${row.observedRows}/${row.minDecisionObserved} | ${formatPct(row.postCostPositiveRate)} | ` +
      `${formatPct(row.medianPostCostDeltaPct)} / ${formatPct(row.p25PostCostDeltaPct)} | ` +
      `${formatSol(row.currentRefundAdjustedNetSol)} | ` +
      `${row.proxyOnly ? 'proxy-only' : 'ledger'} / ${row.liveEquivalent ? 'live-equivalent' : 'not-live-equivalent'} | ` +
      `${row.reasons.join('; ') || 'n/a'} |`
    ),
  ].join('\n');
}

function renderPosthocSecondKolRouteProofGates(rows: PosthocSecondKolRouteProofGate[]): string {
  if (rows.length === 0) return '_No posthoc second-KOL route proof gate rows._';
  return [
    '| cohort | verdict | rows | candidateId | route known/proof | route unknown | blocker diagnosis | recovery hint | cost-aware | refund-adjusted | top blockers/evidence | reasons |',
    '|---|---|---:|---:|---:|---:|---:|---|---:|---:|---|---|',
    ...rows.map((row) =>
      `| ${row.cohort} | ${row.verdict} | ${row.rows} | ${row.candidateIdRows}/${row.rows} | ` +
      `${row.routeKnownRows}/${row.routeProofRows} | ${row.routeUnknownRows} | ` +
      `noRoute=${row.explicitNoSellRouteRows}, exitUnknown=${row.exitLiquidityUnknownRows}, ` +
      `securityGap=${row.securityDataGapRows}, mixed=${row.mixedExitLiquidityAndDataGapRows}, ` +
      `missingProof=${row.missingPositiveEvidenceRows} | ${row.recoveryHint} | ${row.costAwareRows}/${row.rows} | ` +
      `${formatSol(row.refundAdjustedNetSol)} | ` +
      `${row.topReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} | ` +
      `${row.reasons.join('; ') || 'n/a'} |`
    ),
  ].join('\n');
}

function renderPosthocSecondKolRecoveryBacklog(rows: PosthocSecondKolRecoveryBacklogItem[]): string {
  if (rows.length === 0) return '_No posthoc second-KOL recovery backlog items._';
  return [
    '| cohort | priority | status | next sprint | evidence gap | required before live | live stance |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((row) =>
      `| ${row.cohort} | ${row.priority} | ${row.status} | ${row.nextSprint} | ` +
      `${row.evidenceGap} | ${row.requiredBeforeLive} | ${row.liveStance} |`
    ),
  ].join('\n');
}

function renderPaperCohortValidity(rows: PaperCohortValidityStats[]): string {
  if (rows.length === 0) return '_No paper cohort validity rows._';
  return [
    '| cohort | rows | candidateId | independent KOL | participants | timestamped participants | route proof | cost-aware | unknown 2+KOL timing |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.cohort} | ${row.rows} | ${row.candidateIdRows}/${row.rows} (${formatPct(row.candidateIdCoverage)}) | ` +
      `${row.independentKolRows}/${row.rows} | ${row.participantRows}/${row.rows} | ` +
      `${row.participantTimestampRows}/${row.rows} | ${row.routeProofRows}/${row.rows} | ` +
      `${row.costAwareRows}/${row.rows} | ${row.unknownTimingRows} |`
    ),
  ].join('\n');
}

function renderReviewCohortGenerationAudit(row: ReviewCohortGenerationAuditStats): string {
  return [
    '| cohort | underfill | route-known | cost-aware | 2+ KOL | route-known 2+ | route-known cost-aware | review closes | missing route proof | missing candidateId | missing timestamps | primary 2+ without cost-aware clone |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    `| ${row.cohort} | ${row.underfillRows} | ${row.routeKnownRows} | ${row.costAwareRows} | ` +
      `${row.twoPlusKolRows} | ${row.routeKnownTwoPlusRows} | ${row.routeKnownCostAwareRows} | ` +
      `${row.reviewRows} | ${row.missingRouteProofRows} | ${row.missingCandidateIdRows} | ` +
      `${row.missingParticipantTimestampRows} | ` +
      `${row.primaryRouteKnownTwoPlusWithoutCostAwareCloneRows}/${row.primaryRouteKnownTwoPlusRows} |`,
    '',
    `- diagnosis: ${row.diagnosis}`,
    `- next action: ${row.nextAction}`,
    `- single-KOL route-known cost-aware rows: ${row.singleKolRouteKnownCostAwareRows}/${row.routeKnownCostAwareRows}`,
    `- review metadata gaps: candidateId ${row.reviewMissingCandidateIdRows}/${row.reviewRows}, ` +
      `participant timestamps ${row.reviewMissingParticipantTimestampRows}/${row.reviewRows}`,
    `- blockers: ${row.blockerReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
  ].join('\n');
}

function renderRotationSecondKolOpportunityFunnel(row: RotationSecondKolOpportunityFunnelStats): string {
  const tokens = row.topTokens.length === 0
    ? '_No single-KOL token rows._'
    : [
        '| token | rows | second KOL | <=30s | route-known cost-aware | route-known cost-aware <=30s | median delay | top second KOLs |',
        '|---|---:|---:|---:|---:|---:|---:|---|',
        ...row.topTokens.map((token) =>
          `| ${token.shortMint} | ${token.rows} | ${token.secondKolRows} | ${token.secondKolWithin30Rows} | ` +
          `${token.routeKnownCostAwareRows} | ${token.routeKnownCostAwareSecondWithin30Rows} | ` +
          `${token.medianSecondKolDelaySec == null ? 'n/a' : `${token.medianSecondKolDelaySec.toFixed(0)}s`} | ` +
          `${token.topSecondKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} |`
        ),
      ].join('\n');
  return [
    '| verdict | underfill | single KOL | token | entry time | tx coverage | route-known cost-aware single | second seen | <=15s | <=30s | <=60s | late<=180s | route-known cost-aware <=30s | potential review | true single | fresh cutoff | fresh underfill | fresh single | fresh tx coverage | fresh second <=30s | fresh route-known cost-aware <=30s | fresh next | top second KOLs | reasons |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---|---|---|',
    `| ${row.verdict} | ${row.underfillRows} | ${row.singleKolRows} | ${row.rowsWithToken} | ` +
      `${row.rowsWithEntryTime} | ${row.rowsWithTxCoverage} | ${row.routeKnownCostAwareSingleRows} | ` +
      `${row.secondKolSeenRows} | ${row.secondKolWithin15Rows} | ${row.secondKolWithin30Rows} | ` +
      `${row.secondKolWithin60Rows} | ${row.secondKolLate180Rows} | ${row.routeKnownCostAwareSecondWithin30Rows} | ` +
      `${row.potentialReviewRows} | ${row.trueSingleRows} | ` +
      `${row.freshSince ?? 'n/a'} (${row.freshCutoffSource}) | ${row.freshUnderfillRows} | ` +
      `${row.freshSingleKolRows} | ${row.freshRowsWithTxCoverage}/${row.freshSingleKolRows} | ` +
      `${row.freshSecondKolWithin30Rows} | ${row.freshRouteKnownCostAwareSecondWithin30Rows} | ` +
      `${row.freshNextSprint} | ` +
      `${row.topSecondKols.map((item) => `${item.kol}:${item.count}`).join(', ') || 'n/a'} | ` +
      `${row.reasons.join('; ') || 'n/a'} |`,
    '',
    '### 2nd-KOL Opportunity Tokens',
    tokens,
  ].join('\n');
}

function renderRotationSecondKolPromotionGap(row: RotationSecondKolPromotionGapStats): string {
  const tokens = row.topTokens.length === 0
    ? '_No second-KOL <=30s token rows._'
    : [
        '| token | rows | route proof | cost-aware | route-known cost-aware | median delay | route unknown reasons |',
        '|---|---:|---:|---:|---:|---:|---|',
        ...row.topTokens.map((token) =>
          `| ${token.shortMint} | ${token.rows} | ${token.routeProofRows} | ${token.costAwareRows} | ` +
          `${token.routeKnownCostAwareRows} | ` +
          `${token.medianSecondKolDelaySec == null ? 'n/a' : `${token.medianSecondKolDelaySec.toFixed(0)}s`} | ` +
          `${token.topRouteUnknownReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} |`
        ),
      ].join('\n');
  return [
    '| verdict | rows | route proof | route unknown | cost-aware | route-known cost-aware | route-known missing cost-aware | cost-aware route unknown | route diagnosis | recovery hint | historical next | fresh cutoff | fresh rows | fresh route proof | fresh cost-aware | fresh route-known cost-aware | fresh exit evidence | fresh next | candidateId | participant timestamps | median 2nd delay | med MFE | refund-adjusted | top route unknown | top missing cost-aware arms | top exits | reasons |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---|---|---|---|',
    `| ${row.verdict} | ${row.rows} | ${row.routeProofRows} | ${row.routeUnknownRows} | ` +
      `${row.costAwareRows} | ${row.routeKnownCostAwareRows} | ${row.routeKnownMissingCostAwareRows} | ` +
      `${row.costAwareRouteUnknownRows} | ` +
      `structural=${row.structuralBlockRows}, dataGap=${row.dataGapRows}, infra=${row.infraRetryRows}, ` +
      `unknown=${row.unknownRows}, exitUnknown=${row.exitLiquidityUnknownRows}, ` +
      `securityGap=${row.securityDataGapRows}, mixed=${row.mixedExitLiquidityAndDataGapRows}, ` +
      `missingProof=${row.missingPositiveEvidenceRows} | ${row.recoveryHint} | ${row.nextSprint} | ` +
      `${row.freshSince ?? 'n/a'} (${row.freshCutoffSource}) | ` +
      `${row.freshRows}/${row.rows} stale=${row.staleRows} | ` +
      `${row.freshRouteProofRows}/${row.freshRows} | ${row.freshCostAwareRows}/${row.freshRows} | ` +
      `${row.freshRouteKnownCostAwareRows}/${row.freshRows} | ${row.freshExitQuoteEvidenceRows}/${row.freshRows} | ` +
      `${row.freshNextSprint} | ` +
      `${row.candidateIdRows}/${row.rows} | ` +
      `${row.participantTimestampRows}/${row.rows} | ` +
      `${row.medianSecondKolDelaySec == null ? 'n/a' : `${row.medianSecondKolDelaySec.toFixed(0)}s`} | ` +
      `${formatPct(row.medianMfePct)} | ${formatSol(row.refundAdjustedNetSol)} | ` +
      `${row.topRouteUnknownReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} | ` +
      `${row.topMissingCostAwareArms.map((item) => `${item.arm}:${item.count}`).join(', ') || 'n/a'} | ` +
      `${row.topExitReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'} | ` +
      `${row.reasons.join('; ') || 'n/a'} |`,
    '',
    '### 2nd-KOL Promotion Gap Tokens',
    tokens,
  ].join('\n');
}

function renderLiveEquivalenceDrilldown(rows: LiveEquivalenceDrilldownStats[]): string {
  if (rows.length === 0) return '_No live-equivalence drilldown rows._';
  return [
    '| stage/reason | rows | candidateId/missing | unlinked | review linked | liveWould | blocked | linked paper closes | paper W/L | paper refund-adjusted | blocked paper winners | med paper MFE |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.bucket} | ${row.rows} | ${row.candidateIdRows}/${row.missingCandidateIdRows} | ` +
      `${row.unlinkedRows} | ${row.reviewCohortLinkedRows} | ${row.liveWouldEnterRows} | ${row.blockedRows} | ` +
      `${row.paperCloses} | ${row.paperWins}/${Math.max(0, row.paperCloses - row.paperWins)} | ` +
      `${formatSol(row.paperRefundAdjustedNetSol)} | ${row.blockedPaperWinnerRows} | ${formatPct(row.medianPaperMfePct)} |`
    ),
  ].join('\n');
}

function renderReviewCohortEvidence(row: ReviewCohortEvidenceStats): string {
  return [
    '| cohort | closes | candidateId | live-eq linked/rows | live-eq missing/unlinked | route proof | timestamped 2nd KOL | refund-adjusted | postCost>0 | T1 rate | min coverage | primary postCost |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    `| ${row.cohort} | ${row.closes} | ${row.candidateIdRows}/${row.closes} | ` +
      `${row.linkedLiveEquivalenceRows}/${row.liveEquivalenceRows} | ` +
      `${row.missingCandidateIdLiveRows}/${row.unlinkedLiveEquivalenceRows} | ` +
      `${row.routeProofRows}/${row.closes} | ${row.timestampedSecondKolRows}/${row.closes} | ` +
      `${formatSol(row.refundAdjustedNetSol)} | ${formatPct(row.postCostPositiveRate)} | ` +
      `${formatPct(row.t1Rate)} | ${formatPct(row.minOkCoverage)} | ` +
      `${row.primaryHorizonPostCost.map((item) => `T+${item.horizonSec}s ${formatPct(item.medianPostCostDeltaPct)}`).join(', ') || 'n/a'} |`,
    '',
    `- route proof: ${row.routeProofSources.map((item) => `${item.source}:${item.count}`).join(', ') || 'n/a'}`,
    `- KOL timing: ${row.kolTimingBuckets.map((item) => `${item.bucket}:${item.count}`).join(', ') || 'n/a'}`,
    `- live block reasons: ${row.liveBlockReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
  ].join('\n');
}

function renderPaperExitProxies(rows: PaperExitProxyStats[]): string {
  if (rows.length === 0) return '_No paper exit proxy rows._';
  return [
    '| cohort | exit profile | rows | observed | target hit | postCost>0 | med postCost | p25 postCost | refund-adjusted SOL | max loss streak | median hold |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.cohort} | ${row.exitProfile}${row.proxyHorizonSec == null ? '' : ` T+${row.proxyHorizonSec}s`} | ` +
      `${row.rows} | ${row.observedRows} | ` +
      `${row.targetHitRows == null ? 'n/a' : `${row.targetHitRows}/${row.observedRows} @ ${formatPct(row.targetPct)}`} | ` +
      `${row.positiveRows}/${row.observedRows} (${formatPct(row.postCostPositiveRate)}) | ` +
      `${formatPct(row.medianPostCostDeltaPct)} | ${formatPct(row.p25PostCostDeltaPct)} | ` +
      `${formatSol(row.refundAdjustedNetSol)} | ${row.maxLosingStreak ?? 'n/a'} | ` +
      `${row.medianHoldSec == null ? 'n/a' : `${row.medianHoldSec.toFixed(0)}s`} |`
    ),
  ].join('\n');
}

function renderCompoundProfiles(rows: RotationCompoundProfile[]): string {
  if (rows.length === 0) return '_No compound profile rows._';
  return [
    '| cohort | closes | refund-adjusted SOL | wallet-drag stress SOL | postCost>0 | T1 rate | max loss streak | winner net | non-winner net | med MFE | median hold |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) =>
      `| ${row.cohort} | ${row.rows} | ${formatSol(row.refundAdjustedNetSol)} | ` +
      `${formatSol(row.walletDragStressSol)} | ${formatPct(row.postCostPositiveRate)} | ${formatPct(row.t1Rate)} | ` +
      `${row.maxLosingStreak} | ${row.winnerRows}:${formatSol(row.winnerRefundAdjustedNetSol)} | ` +
      `${row.nonWinnerRows}:${formatSol(row.nonWinnerRefundAdjustedNetSol)} | ${formatPct(row.medianMfePct)} | ` +
      `${row.medianHoldSec == null ? 'n/a' : `${row.medianHoldSec.toFixed(0)}s`} |`
    ),
  ].join('\n');
}

function renderCompoundFitnessGate(row: RotationCompoundFitnessGate): string {
  return [
    '| cohort | verdict | score | closes | refund-adjusted | postCost>0 | T1 rate | max loss streak | winner covers bleed | reasons |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|---|',
    `| ${row.cohort} | ${row.verdict} | ${row.score} | ${row.closes}/${row.minDecisionCloses} | ` +
      `${formatSol(row.refundAdjustedNetSol)} | ${formatPct(row.postCostPositiveRate)} | ${formatPct(row.t1Rate)} | ` +
      `${row.maxLosingStreak ?? 'n/a'} | ${row.winnerCoversBleed == null ? 'n/a' : row.winnerCoversBleed ? 'yes' : 'no'} | ` +
      `${row.reasons.join('; ') || 'n/a'} |`,
  ].join('\n');
}

function renderReviewCohortDecision(row: ReviewCohortDecision): string {
  return [
    '| verdict | cohort | closes | refund-adjusted | postCost>0 | max loss streak | primary postCost | signals | reasons |',
    '|---|---|---:|---:|---:|---:|---|---|---|',
    `| ${row.verdict} | ${row.cohort} | ${row.closes}/${row.minDecisionCloses} | ` +
      `${formatSol(row.refundAdjustedNetSol)} | ${formatPct(row.postCostPositiveRate)} | ` +
      `${row.maxLosingStreak ?? 'n/a'} | ` +
      `${row.primaryHorizonPostCost.map((item) => `T+${item.horizonSec}s ${formatPct(item.medianPostCostDeltaPct)}`).join(', ') || 'n/a'} | ` +
      `${row.earlyRejectSignals.join('; ') || 'none'} | ${row.reasons.join('; ') || 'n/a'} |`,
    '',
    `- thresholds: earlyReject>=${row.minEarlyRejectCloses} closes, WATCH>=${row.minReviewCloses}, PASS/REJECT>=${row.minDecisionCloses}`,
  ].join('\n');
}

function renderMicroLiveReviewPacket(row: MicroLiveReviewPacket): string {
  return [
    '| verdict | cohort | closes | paper | micro-live | compound | metadata | live-eq linked/rows | live-eq blockers | reasons |',
    '|---|---|---:|---|---|---|---|---:|---:|---|',
    `| ${row.verdict} | ${row.reviewCohort} | ${row.closes} | ${row.paperVerdict} | ${row.liveVerdict} | ` +
      `${row.compoundVerdict} | candidateId=${row.candidateIdRows}/${row.closes}, route=${row.routeProofRows}/${row.closes}, ` +
      `2ndKOLts=${row.timestampedSecondKolRows}/${row.closes} | ` +
      `${row.linkedLiveEquivalenceRows}/${row.liveEquivalenceRows} | ${row.liveEquivalenceBlockers} | ` +
      `${row.reasons.join('; ') || 'n/a'} |`,
    '',
    `- micro-live plan: ticket=${row.plan.ticketSol.toFixed(3)} SOL, maxDailyAttempts=${row.plan.maxDailyAttempts}, dailyLossCap=${formatSol(-row.plan.dailyLossCapSol)}`,
    `- rollback: ${row.plan.rollbackConditions.join('; ')}`,
  ].join('\n');
}

function renderRotationLiveReadiness(row: RotationLiveReadiness): string {
  return [
    '| arm | verdict | cohort | closes | min markout coverage | primary postCost | refund-adjusted | postCost>0 | edge pass | T1 rate | med MFE | evidence | reasons |',
    '|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---|---|',
    `| ${row.armName} | ${row.verdict} | ${row.cohort} | ${row.closes}/${row.minRequiredCloses} | ` +
      `${formatPct(row.minOkCoverage)} | ` +
      `${row.primaryHorizonPostCost.map((item) => `T+${item.horizonSec}s ${formatPct(item.medianPostCostDeltaPct)}`).join(', ') || 'n/a'} | ` +
      `${formatSol(row.refundAdjustedNetSol)} | ${formatPct(row.postCostPositiveRate)} | ` +
      `${formatPct(row.edgePassRate)} | ${formatPct(row.t1Rate)} | ${formatPct(row.medianMfePct)} | ` +
      `${row.evidenceVerdict ?? 'n/a'} | ${row.reasons.join('; ') || 'n/a'} |`,
  ].join('\n');
}

function renderRotationPaperCompoundReadiness(row: RotationPaperCompoundReadiness): string {
  return [
    '| arm | verdict | cohort | closes | min markout coverage | primary postCost | refund-adjusted | postCost>0 | edge pass | T1 rate | med MFE | reasons |',
    '|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---|',
    `| ${row.armName} | ${row.verdict} | ${row.cohort} | ${row.closes}/${row.minRequiredCloses} | ` +
      `${formatPct(row.minOkCoverage)} | ` +
      `${row.primaryHorizonPostCost.map((item) => `T+${item.horizonSec}s ${formatPct(item.medianPostCostDeltaPct)}`).join(', ') || 'n/a'} | ` +
      `${formatSol(row.refundAdjustedNetSol)} | ${formatPct(row.postCostPositiveRate)} | ` +
      `${formatPct(row.edgePassRate)} | ${formatPct(row.t1Rate)} | ${formatPct(row.medianMfePct)} | ` +
      `${row.reasons.join('; ') || 'n/a'} |`,
  ].join('\n');
}

function renderRotationLiveSyncChecklist(report: RotationReport): string {
  const paperReady = report.rotationPaperCompoundReadiness.verdict === 'PAPER_READY';
  const liveReady = report.rotationLiveReadiness.verdict === 'READY_FOR_MICRO_LIVE';
  const packetReady = report.microLiveReviewPacket.verdict === 'READY_FOR_MICRO_LIVE_REVIEW';
  const nextAction = paperReady && liveReady && packetReady
    ? 'MANUAL_REVIEW_ONLY'
    : paperReady && liveReady
      ? report.microLiveReviewPacket.verdict
      : paperReady
      ? 'WAIT_MICRO_LIVE_EVIDENCE'
      : report.rotationPaperCompoundReadiness.closes === 0
      ? 'WAIT_ROUTE_KNOWN_2KOL_COST_AWARE'
      : 'WAIT_PAPER_EVIDENCE';
  return [
    '| gate | current | required before live sync |',
    '|---|---|---|',
    `| paper compound | ${report.rotationPaperCompoundReadiness.verdict} | PAPER_READY |`,
    `| micro-live evidence | ${report.rotationLiveReadiness.verdict} | READY_FOR_MICRO_LIVE |`,
    `| review metadata | candidateId=${report.microLiveReviewPacket.candidateIdRows}/${report.microLiveReviewPacket.closes}, route=${report.microLiveReviewPacket.routeProofRows}/${report.microLiveReviewPacket.closes}, 2ndKOLts=${report.microLiveReviewPacket.timestampedSecondKolRows}/${report.microLiveReviewPacket.closes} | all complete |`,
    `| review live-equivalence | linked=${report.microLiveReviewPacket.linkedLiveEquivalenceRows}/${report.microLiveReviewPacket.liveEquivalenceRows}, blockers=${report.microLiveReviewPacket.liveEquivalenceBlockers} | linked rows >0 and blockers 0 |`,
    '| guardrail | live unchanged | ticket/floor/caps/concurrency unchanged |',
    '| first live sample | not started by report | 30 closes divergence check before any scale-up |',
    `| next action | ${nextAction} | manual review only; report never enables live |`,
  ].join('\n');
}

function renderEvidenceVerdicts(rows: EvidenceVerdict[]): string {
  if (rows.length === 0) return '_No rotation paper arm evidence yet._';
  return [
    '| arm | verdict | closes | route proof | min ok coverage | edge coverage | edge pass | refund-adjusted | wallet-drag stress | primary postCost | best primary | vs control | T+60 decay | reasons |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---|',
    ...rows.map((row) =>
      `| ${row.armName} | ${row.verdict} | ${row.closes}/${row.promotionRequiredCloses} | ` +
      `${row.routeProofRows}/${row.closes} (${formatPct(row.routeProofCoverage)}) | ` +
      `${formatPct(row.minOkCoverage)} | ${formatPct(row.edgeCoverage)} | ${formatPct(row.edgePassRate)} | ` +
      `${formatSol(row.refundAdjustedNetSol)} | ${formatSol(row.rentAdjustedNetSol)} | ` +
      `${row.primaryHorizonPostCost.map((item) => `T+${item.horizonSec}s ${formatPct(item.medianPostCostDeltaPct)}`).join(', ') || 'n/a'} | ` +
      `${row.primaryHorizonSec == null ? 'n/a' : `T+${row.primaryHorizonSec}s ${formatPct(row.primaryMedianPostCostDeltaPct)}`} | ` +
      `${formatPct(row.primaryBeatDeltaPct)} | ${formatPct(row.decayMedianPostCostDeltaPct)} | ${row.reasons.join('; ') || 'n/a'} |`
    ),
  ].join('\n');
}

function renderKolTransferPosteriorTable(report: RotationReport['kolTransferPosterior']): string {
  if (report.rows === 0 || report.topRotationFit.length === 0) {
    return `_No KOL transfer posterior rows. Run \`npm run kol:transfer-backfill\` first. Input: ${report.input}_`;
  }
  return [
    '| KOL | tier | role | style | tx | buy | sell | reentry | sell/buy | med buy SOL | med hold | quick sell | rotation | smart-v3 | net SOL flow |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.topRotationFit.map((row) =>
      `| ${row.kolId} | ${row.kolTier ?? '-'} | ${row.laneRole ?? '-'} | ${row.tradingStyle ?? '-'} | ` +
      `${row.txGroups} | ${row.buyCandidates} | ${row.sellCandidates} | ${formatPct(row.sameMintReentryRatio)} | ` +
      `${formatPct(row.sellToBuyRatio)} | ${row.medianBuySol == null ? 'n/a' : row.medianBuySol.toFixed(4)} | ` +
      `${row.medianHoldSec == null ? 'n/a' : `${row.medianHoldSec.toFixed(0)}s`} | ${formatPct(row.quickSellRatio)} | ` +
      `${row.rotationFitScore.toFixed(2)} | ${row.smartV3FitScore.toFixed(2)} | ${formatSol(row.netSolFlow)} |`
    ),
  ].join('\n');
}

function renderKolTransferCoverageTable(report: RotationReport['kolTransferPosterior']): string {
  if (report.coverageLoadStatus === 'load_failed') {
    return `_Coverage load failed for \`${report.kolDbPath ?? 'unknown'}\`: ${report.coverageLoadError ?? 'unknown error'}_`;
  }
  if (report.coverageLoadStatus === 'disabled') {
    return '_Coverage disabled. Pass `--kol-db data/kol/wallets.json` to enable._';
  }
  if (!report.coverageSummary) return '_Coverage unavailable._';
  const visibleCoverage = (report.coverage ?? [])
    .filter((row) => row.rotationCandidate || row.status !== 'ok')
    .slice(0, 30);
  return [
    `- active targets: ${report.coverageSummary.targets} · ok=${report.coverageSummary.ok} · stale=${report.coverageSummary.stale} · missing=${report.coverageSummary.missing}`,
    `- rotation candidates: ${report.coverageSummary.rotationTargets} · ok=${report.coverageSummary.rotationOk} · stale=${report.coverageSummary.rotationStale} · missing=${report.coverageSummary.rotationMissing}`,
    '',
    '| KOL | tier | role | style | rotation? | status | rows all | rows since | candidates since | last transfer | age h |',
    '|---|---|---|---|---:|---|---:|---:|---:|---|---:|',
    ...(visibleCoverage.length > 0
      ? visibleCoverage.map((row) => [
          row.kolId,
          row.kolTier ?? '-',
          row.laneRole ?? '-',
          row.tradingStyle ?? '-',
          row.rotationCandidate ? 'yes' : 'no',
          row.status,
          String(row.rowsAll),
          String(row.rowsSince),
          String(row.candidatesSince),
          row.lastTransferAt ?? '-',
          row.lastAgeHours == null ? '-' : row.lastAgeHours.toFixed(1),
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
      : ['| n/a | - | - | - | - | ok | 0 | 0 | 0 | - | - |']),
  ].join('\n');
}

function renderArmMarkouts(rows: ArmHorizonStats[]): string {
  if (rows.length === 0) return '_No rotation arm markout rows._';
  return rows.map((row) => [
    `### ${row.armName}`,
    '',
    '**After Buy**',
    renderStatsTable(row.afterBuy),
    '',
    '**After Sell**',
    renderStatsTable(row.afterSell),
  ].join('\n')).join('\n\n');
}

function renderReport(report: RotationReport): string {
  const reasons = report.noTrade.byReason.length === 0
    ? '_No no-trade rows._'
    : [
        '| reason | rows | ok | ok coverage | positive | postCost>0 | median | median postCostDelta |',
        '|---|---:|---:|---:|---:|---:|---:|---:|',
        ...report.noTrade.byReason.map((row) =>
          `| ${row.reason} | ${row.count} | ${row.okRows} | ` +
          `${row.count > 0 ? `${((row.okRows / row.count) * 100).toFixed(1)}%` : 'n/a'} | ` +
          `${row.positiveRows} | ${row.positivePostCostRows} | ` +
          `${formatPct(row.medianDeltaPct)} | ${formatPct(row.medianPostCostDeltaPct)} |`
        ),
      ].join('\n');
  const anchors = report.byAnchor.length === 0
    ? '_No anchor rows._'
    : [
        '| anchor | T+60 rows | ok | positive | postCost>0 | median T+60 | median postCostDelta T+60 |',
        '|---|---:|---:|---:|---:|---:|---:|',
        ...report.byAnchor.map((row) =>
          `| ${row.anchor} | ${row.rows} | ${row.okRows} | ${row.positive60s} | ${row.positivePostCost60s} | ` +
          `${formatPct(row.medianDeltaPct60s)} | ${formatPct(row.medianPostCostDeltaPct60s)} |`
        ),
      ].join('\n');
  const devQuality = report.byDevQuality.length === 0
    ? '_No dev-quality rows._'
    : [
        '| dev bucket | T+60 rows | ok | positive | postCost>0 | median T+60 | median postCostDelta T+60 |',
        '|---|---:|---:|---:|---:|---:|---:|',
        ...report.byDevQuality.map((row) =>
          `| ${row.bucket} | ${row.rows} | ${row.okRows} | ${row.positive60s} | ${row.positivePostCost60s} | ` +
          `${formatPct(row.medianDeltaPct60s)} | ${formatPct(row.medianPostCostDeltaPct60s)} |`
        ),
      ].join('\n');
  return [
    '# KOL Hunter Rotation Lane Report',
    '',
    `Generated: ${report.generatedAt}`,
    `Since: ${report.since}`,
    `Realtime dir: ${report.realtimeDir}`,
    `Horizons: ${report.horizonsSec.map((horizon) => `T+${horizon}s`).join(', ')}`,
    `Round-trip cost assumption: ${formatPct(report.roundTripCostPct)}`,
    `Paper refund-adjusted assumption: network ${formatSol(report.assumedNetworkFeeSol)} SOL is irreversible; ATA rent ${formatSol(report.assumedAtaRentSol)} SOL is recoverable wallet drag`,
    '',
    `Rotation trade markout rows: ${report.tradeMarkouts.rotationRows}/${report.tradeMarkouts.totalRows}`,
    `Rotation paper close rows: ${report.paperTrades.rotationRows}/${report.paperTrades.totalRows}`,
    `Rotation live close rows: ${report.liveTrades.rotationRows}/${report.liveTrades.totalRows}`,
    `Rotation no-trade probe rows: ${report.noTrade.probeRows}/${report.noTrade.totalRows}`,
    '',
    '## KOL Transfer Posterior — Rotation Fit',
    '> Diagnostic only. Transfer candidates are not precise swap PnL. Use signature drill-down before policy changes.',
    '',
    '### Coverage',
    renderKolTransferCoverageTable(report.kolTransferPosterior),
    '',
    '### Top Rotation Fit',
    renderKolTransferPosteriorTable(report.kolTransferPosterior),
    '',
    '## Paper Trades By Arm',
    renderPaperArmTable(report.paperTrades.byArm),
    '',
    '## Winner Entry Pairing',
    '> `winner_trailing_t1` is an exit state after T1 promotion, so this table checks which entry arms most often reach that exit bucket.',
    renderWinnerEntryPairingTable(report.paperTrades.winnerEntryPairings),
    '',
    '## Winner Entry Diagnostics',
    '> Splits winner vs non-winner exits by flow/risk features. This is report-only and must not be used as a live allowlist.',
    renderWinnerEntryDiagnosticsTable(report.paperTrades.winnerEntryDiagnostics),
    '',
    '## Underfill Entry Quality',
    '> Entry/KOL-fill diff is the canary equivalence check. Negative values mean our entry was below the S/A KOL weighted fill.',
    renderUnderfillEntryQualityTable(report.underfillEntryQuality),
    '',
    '## Underfill Route Cohorts',
    '> Report-only. Route-known requires explicit positive route/exit-liquidity evidence; missing evidence is treated as route-unknown.',
    renderUnderfillRouteCohorts(report.underfillRouteCohorts),
    '',
    '## Underfill KOL Cohorts',
    '> Report-only. Separates 1-KOL paper edge from 2+ KOL evidence before any live sync review.',
    renderUnderfillRouteCohorts(report.underfillKolCohorts),
    '',
    '## Underfill KOL Timing',
    '> Report-only. Splits 2+ KOL evidence by second-KOL arrival timing. Unknown timing cannot justify live sync.',
    renderKolTimingStats(report.underfillKolTiming),
    '',
    '## Posthoc Second-KOL Audit',
    '> Report-only. Finds 1-KOL underfill entries that later received a second KOL in the ledger. This is paper evidence only, not live-equivalent 2+ KOL proof.',
    renderPosthocSecondKolStats(report.posthocSecondKol),
    '',
    '## Posthoc Second-KOL Wait Proxy',
    '> Report-only. Re-bases markouts from the first available horizon after the second KOL to test whether waiting still leaves post-cost continuation. Proxy rows are not simulated fills.',
    renderPosthocSecondKolWaitProxies(report.posthocSecondKolWaitProxies),
    '',
    '## Posthoc Second-KOL Candidate Decision',
    '> Report-only. Separates paper-only candidates from live-equivalent 2+ KOL. A candidate verdict never enables live routing.',
    renderPosthocSecondKolCandidateDecisions(report.posthocSecondKolCandidateDecisions),
    '',
    '## Posthoc Second-KOL Synthetic Paper Arm',
    '> Report-only. Arm-like isolation for paper-first review; this is not a runtime ledger arm and never changes live routing.',
    renderPosthocSecondKolSyntheticPaperArms(report.posthocSecondKolSyntheticPaperArms),
    '',
    '## Posthoc Second-KOL Route Proof Gate',
    '> Report-only. Splits the synthetic paper candidate by route-known proof before any live sync review. Good proxy PnL without route proof is still blocked.',
    renderPosthocSecondKolRouteProofGates(report.posthocSecondKolRouteProofGates),
    '',
    '## Posthoc Second-KOL Recovery Backlog',
    '> Report-only. Converts the route-proof gate into the next implementation backlog. This section never enables live routing.',
    renderPosthocSecondKolRecoveryBacklog(report.posthocSecondKolRecoveryBacklog),
    '',
    '## Paper Cohort Validity',
    '> Report-only. Shows whether paper rows have the IDs, KOL counts, participant timestamps, and route proof needed for live-equivalence review.',
    renderPaperCohortValidity(report.paperCohortValidity),
    '',
    '## Review Cohort Generation Audit',
    '> Report-only. Separates no opportunity from missing recording/proof before route_known_2kol_cost_aware can be trusted.',
    renderReviewCohortGenerationAudit(report.reviewCohortGenerationAudit),
    '',
    '## Rotation 2nd-KOL Opportunity Funnel',
    '> Report-only. Joins single-KOL underfill closes with same-token KOL buy flow to separate true single-KOL from second-KOL linkage gaps.',
    renderRotationSecondKolOpportunityFunnel(report.rotationSecondKolOpportunityFunnel),
    '',
    '## Rotation 2nd-KOL Promotion Gap',
    '> Report-only. Explains why second-KOL <=30s paper opportunities still fail the route-known cost-aware review cohort.',
    renderRotationSecondKolPromotionGap(report.rotationSecondKolPromotionGap),
    '',
    '## Route Unknown Reasons',
    '> Report-only. Splits route-unknown paper winners from missing/unsafe exit-route evidence. Reasons are non-exclusive; one close can appear in multiple reason rows.',
    renderRouteUnknownReasons(report.routeUnknownReasons),
    '',
    '## Route Truth Audit',
    '> Report-only. Separates route-known proof from structural no-route, data gaps, and transient infra retry candidates.',
    renderRouteTruthAudit(report.routeTruthAudit),
    '',
    '## Route Proof Freshness',
    '> Report-only. Separates old paper edge from post-R1.41 exit-route instrumentation. WAIT_FRESH_CLOSES means collect fresh paper before interpreting route-proofed cohorts.',
    renderRouteProofFreshness(report.routeProofFreshness),
    '',
    '## Rotation Candidate Funnel Since Session',
    '> Report-only. Splits current-session KOL input, rotation candidate formation, no-trade/policy ledgers, and paper closes. Live routing is unchanged.',
    renderRotationCandidateFunnel(report.rotationCandidateFunnel),
    '',
    '## KOL Admission-Skip Markouts',
    '> Report-only. Measures KOL buys skipped by live admission/capacity gates as paper probes. This section never changes live routing.',
    renderKolHunterAdmissionSkipMarkouts(report.kolHunterAdmissionSkipMarkouts),
    '',
    '## Rotation Detector Replay Since Session',
    '> Report-only. Replays current-session KOL tx against rotation detector defaults to explain detector-side starvation before any live or paper policy change.',
    renderRotationDetectorReplay(report.rotationDetectorReplay),
    '',
    '## Rotation Detector Replay Report Window',
    '> Report-only. Uses the full report `--since` window, not just the current runtime session, to show whether detector blockers are persistent or one-off.',
    renderRotationDetectorReplay(report.rotationDetectorReplayWindow),
    '',
    '## Rotation Detector Blocker Markouts',
    '> Report-only. Joins report-window detector blockers to buy markouts so blocker relaxation is not considered without post-cost evidence.',
    renderRotationDetectorBlockerMarkouts(report.rotationDetectorBlockerMarkouts),
    '',
    '## Rotation Stale-Buy Review',
    '> Report-only. Narrows `underfill_stale_last_buy` by age and KOL-depth before any paper-only detector relaxation.',
    renderRotationStaleBuyReview(report.rotationStaleBuyReview),
    '',
    '## Rotation Price-Context Candidate Markouts',
    '> Report-only. Token-level join from underfill replay candidates that reached price-context checks to available buy markouts. This is not a simulated fill and never enables live routing.',
    renderRotationPriceContextMarkouts(report.rotationPriceContextMarkouts),
    '',
    '## Rotation KOL-Decay Block Markouts',
    '> Report-only. Joins rotation attribution-drift KOL alpha decay blocks to missed-alpha probes to test whether decay saved losses or killed winners. This never changes live routing.',
    renderRotationDecayBlockMarkouts(report.rotationDecayBlockMarkouts),
    '',
    '## Rotation Narrow Cohort Board',
    '> Report-only. Narrows paper evidence to sellable, cost-aware, 2+ KOL slices before any live sync review. Live canary routing is unchanged.',
    renderRotationNarrowCohorts(report.rotationNarrowCohorts),
    '',
    '## Live-Equivalence Gate Review',
    '> Report-only. Shows why paper candidates were not live-routed; this must stay strict while wallet is near floor.',
    renderLiveEquivalenceSummary(report.liveEquivalence),
    '',
    '## Live-Equivalence Candidate Drilldown',
    '> Report-only. Joins live-equivalence candidate IDs back to paper closes so blocked paper winners are visible by reason.',
    renderLiveEquivalenceDrilldown(report.liveEquivalenceDrilldown),
    '',
    '## Review Cohort Evidence',
    '> Report-only. Daily packet for route_known_2kol_cost_aware before any manual micro-live review.',
    renderReviewCohortEvidence(report.reviewCohortEvidence),
    '',
    '## Paper Exit Proxy Comparison',
    '> Report-only. Compares current close against markout-based exit proxies; proxy rows are not simulated fills.',
    renderPaperExitProxies(report.paperExitProxies),
    '',
    '## Rotation Compound Profile',
    '> Report-only. Wallet-first read for slow compounding: winner net must pay for non-winner bleed and wallet-drag stress.',
    renderCompoundProfiles(report.compoundProfiles),
    '',
    '## Rotation Compound Fitness Gate',
    '> Report-only. Slow-compound gate for the route-known 2+KOL cost-aware cohort; this never enables live automatically.',
    renderCompoundFitnessGate(report.rotationCompoundFitness),
    '',
    '## Review Cohort Decision',
    '> Report-only. Compresses collect/watch/reject/pass for the route-known 2+KOL cost-aware paper cohort; live routing remains unchanged.',
    renderReviewCohortDecision(report.reviewCohortDecision),
    '',
    '## Rotation Paper Compound Readiness',
    '> Report-only. This is the paper-first gate for slow compounding; live routing remains unchanged.',
    '> Criteria: sample >=50, route-known, 2+ KOL, cost-aware, refund-adjusted net >0, postCost>0 >=55%, T+15/T+30 post-cost >0, markout coverage >=80%, edge pass >=50%.',
    renderRotationPaperCompoundReadiness(report.rotationPaperCompoundReadiness),
    '',
    '## Rotation Live Readiness',
    '> Report-only. This does not enable live; it states whether cost-aware underfill has enough route-known evidence to request micro-live.',
    renderRotationLiveReadiness(report.rotationLiveReadiness),
    '',
    '## Rotation Live Sync Checklist',
    '> Report-only. Live canary logic is unchanged; this checklist only states whether a later manual sync review is justified.',
    renderRotationLiveSyncChecklist(report),
    '',
    '## Micro Live Review Packet',
    '> Report-only. A READY verdict only means manual review is justified; no live setting is changed by this report.',
    renderMicroLiveReviewPacket(report.microLiveReviewPacket),
    '',
    '## Live Trades By Arm',
    renderPaperArmTable(report.liveTrades.byArm),
    '',
    '## Evidence Verdict By Arm',
    renderEvidenceVerdicts(report.evidenceVerdicts),
    '',
    '## After Buy',
    renderStatsTable(report.tradeMarkouts.afterBuy),
    '',
    '## After Sell',
    renderStatsTable(report.tradeMarkouts.afterSell),
    '',
    '## After Sell — Final Close Only',
    renderStatsTable(report.tradeMarkouts.afterSellFinal),
    '',
    '## After Sell — Partial/Reduce Only',
    renderStatsTable(report.tradeMarkouts.afterSellPartial),
    '',
    '## After Sell — Hard Cut Cohort',
    renderStatsTable(report.tradeMarkouts.afterSellHardCut),
    '',
    '## After Sell — MAE Fast-Fail Cohort',
    renderStatsTable(report.tradeMarkouts.afterSellMaeFastFail),
    '',
    '## Markouts By Arm',
    renderArmMarkouts(report.tradeMarkouts.byArm),
    '',
    '## No-Trade Markouts',
    renderStatsTable(report.noTrade.byHorizon),
    '',
    '## No-Trade By Reason',
    reasons,
    '',
    '## Anchor T+60',
    anchors,
    '',
    '## Dev Quality T+60',
    '_Buckets are non-exclusive labels joined from token-quality observations and the paper-only dev candidate file._',
    devQuality,
    '',
  ].join('\n');
}

export async function buildRotationLaneReport(args: Args): Promise<RotationReport> {
  const paperTradesFileName = args.paperTradesFileName ?? ROTATION_PAPER_TRADES_FILE;
  const assumedAtaRentSol = args.assumedAtaRentSol ?? 0.00207408;
  const assumedNetworkFeeSol = args.assumedNetworkFeeSol ?? 0.000105;
  const kolTransferInput = args.kolTransferInput ?? path.resolve(process.cwd(), 'data/research', KOL_TRANSFER_INPUT_FILE);
  const [tradeMarkouts, missedAlpha, tokenQuality, projectedPaperTrades, projectedLiveTrades, liveEquivalenceRows, kolPolicyRows, kolTxRows, kolCallFunnelRows, kolTransferRows, currentSession] = await Promise.all([
    readJsonl(path.join(args.realtimeDir, 'trade-markouts.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'missed-alpha.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'token-quality-observations.jsonl')),
    readJsonl(path.join(args.realtimeDir, paperTradesFileName)),
    readJsonl(path.join(args.realtimeDir, ROTATION_LIVE_TRADES_FILE)),
    readJsonl(path.join(args.realtimeDir, KOL_LIVE_EQUIVALENCE_FILE)),
    readJsonl(path.join(args.realtimeDir, KOL_POLICY_DECISIONS_FILE)),
    readJsonl(path.join(args.realtimeDir, KOL_TX_FILE)),
    readJsonl(path.join(args.realtimeDir, KOL_CALL_FUNNEL_FILE)),
    readJsonl(kolTransferInput),
    readJsonFile(path.join(args.realtimeDir, 'current-session.json')),
  ]);
  const currentSessionStartedAtMs = timeMs(currentSession.startedAt);
  const paperTrades = projectedPaperTrades.length > 0 || paperTradesFileName !== ROTATION_PAPER_TRADES_FILE
    ? projectedPaperTrades
    : await readJsonl(path.join(args.realtimeDir, KOL_PAPER_TRADES_FILE));
  const candidateIndex = args.candidateFile
    ? await loadDevWalletCandidateIndex(args.candidateFile)
    : undefined;
  const qualityIndex = buildQualityIndex(tokenQuality);
  const recentTradeRows = tradeMarkouts.filter((row) => {
    const t = timeMs(row.recordedAt) || timeMs(row.firedAt);
    return Number.isFinite(t) && t >= args.sinceMs;
  });
  const rotationRows = recentTradeRows.filter(isRotationTradeMarkout);
  const rotationSellRows = rotationRows.filter((row) => str(row.anchorType) === 'sell');
  const recentPaperRows = paperTrades.filter((row) => {
    const t = timeMs(row.closedAt) || timeMs(row.exitTimeSec) || timeMs(row.entryTimeSec);
    return Number.isFinite(t) && t >= args.sinceMs;
  });
  const rotationPaperRows = recentPaperRows.filter(isRotationPaperTrade);
  const recentLiveRows = projectedLiveTrades.filter((row) => {
    const t = timeMs(row.closedAt) || timeMs(row.exitTimeSec) || timeMs(row.entryTimeSec);
    return Number.isFinite(t) && t >= args.sinceMs;
  });
  const rotationLiveRows = recentLiveRows.filter(isRotationPaperTrade);
  const recentMissedAlphaRows = missedAlpha.filter((row) => {
    const t = timeMs(probe(row).firedAt) || timeMs(row.rejectedAt);
    return Number.isFinite(t) && t >= args.sinceMs;
  });
  const recentNoTradeRows = recentMissedAlphaRows.filter(isRotationNoTrade);
  const recentPolicyDecisionRows = kolPolicyRows.filter((row) => {
    const t = timeMs(row.generatedAt) || timeMs(row.recordedAt) || timeMs(row.createdAt);
    return Number.isFinite(t) && t >= args.sinceMs;
  });
  const recentLiveEquivalenceRows = liveEquivalenceRows.filter((row) => {
    const t = timeMs(row.generatedAt) || timeMs(row.recordedAt) || timeMs(row.createdAt);
    return Number.isFinite(t) && t >= args.sinceMs;
  });
  const noTradeProbeRows = recentNoTradeRows.filter((row) => (rowHorizon(row) ?? 0) > 0);
  const armMarkouts = buildArmHorizonStats(rotationRows, args.horizonsSec, args.roundTripCostPct);
  const paperArmStats = buildPaperArmStats(rotationPaperRows, assumedAtaRentSol, assumedNetworkFeeSol);
  const winnerEntryPairings = buildWinnerEntryPairingStats(rotationPaperRows, assumedAtaRentSol, assumedNetworkFeeSol);
  const winnerEntryDiagnostics = buildWinnerEntryDiagnosticStats(rotationPaperRows);
  const evidenceVerdicts = buildEvidenceVerdicts(paperArmStats, armMarkouts);
  const underfillRouteCohorts = buildUnderfillRouteCohorts(rotationPaperRows, assumedNetworkFeeSol);
  const liveEquivalence = buildLiveEquivalenceSummary(recentLiveEquivalenceRows);
  const routeUnknownReasons = buildRouteUnknownReasonStats(rotationPaperRows, assumedNetworkFeeSol);
  const routeTruthAudit = buildRouteTruthAuditStats(rotationPaperRows, assumedNetworkFeeSol);
  const routeProofFreshness = buildRouteProofFreshnessStats(
    rotationPaperRows,
    args.routeProofFreshSinceMs,
    Number.isFinite(currentSessionStartedAtMs) ? currentSessionStartedAtMs : undefined,
    recentNoTradeRows,
    recentMissedAlphaRows,
    recentPolicyDecisionRows
  );
  const rotationCandidateFunnel = buildRotationCandidateFunnelStats({
    sinceMs: args.sinceMs,
    currentSessionStartedAtMs: Number.isFinite(currentSessionStartedAtMs) ? currentSessionStartedAtMs : undefined,
    kolTxRows,
    callFunnelRows: kolCallFunnelRows,
    noTradeRows: recentNoTradeRows,
    policyDecisionRows: recentPolicyDecisionRows,
    rotationPaperRows,
  });
  const kolHunterAdmissionSkipMarkouts = buildKolHunterAdmissionSkipMarkouts({
    sinceMs: args.sinceMs,
    missedAlphaRows: recentMissedAlphaRows,
    horizonsSec: args.horizonsSec,
    roundTripCostPct: args.roundTripCostPct,
  });
  const rotationDetectorReplay = buildRotationDetectorReplayStats({
    sinceMs: args.sinceMs,
    currentSessionStartedAtMs: Number.isFinite(currentSessionStartedAtMs) ? currentSessionStartedAtMs : undefined,
    kolTxRows,
  });
  const rotationDetectorReplayWindow = buildRotationDetectorReplayStats({
    sinceMs: args.sinceMs,
    kolTxRows,
  });
  const rotationDetectorBlockerMarkouts = buildRotationDetectorBlockerMarkouts({
    sinceMs: args.sinceMs,
    kolTxRows,
    tradeMarkoutRows: recentTradeRows,
    horizonsSec: args.horizonsSec,
    roundTripCostPct: args.roundTripCostPct,
  });
  const rotationStaleBuyReview = buildRotationStaleBuyReview({
    sinceMs: args.sinceMs,
    kolTxRows,
    tradeMarkoutRows: recentTradeRows,
    missedAlphaRows: recentMissedAlphaRows,
    horizonsSec: args.horizonsSec,
    roundTripCostPct: args.roundTripCostPct,
  });
  const rotationPriceContextMarkouts = buildRotationPriceContextMarkouts({
    sinceMs: args.sinceMs,
    kolTxRows,
    tradeMarkoutRows: recentTradeRows,
    missedAlphaRows: recentMissedAlphaRows,
    callFunnelRows: kolCallFunnelRows,
    policyDecisionRows: recentPolicyDecisionRows,
    horizonsSec: args.horizonsSec,
    roundTripCostPct: args.roundTripCostPct,
  });
  const rotationDecayBlockMarkouts = buildRotationDecayBlockMarkouts({
    sinceMs: args.sinceMs,
    missedAlphaRows: recentMissedAlphaRows,
    policyDecisionRows: recentPolicyDecisionRows,
    horizonsSec: args.horizonsSec,
    roundTripCostPct: args.roundTripCostPct,
  });
  const rotationNarrowCohorts = buildRotationNarrowCohortStats(
    rotationPaperRows,
    rotationRows,
    args.horizonsSec,
    args.roundTripCostPct,
    assumedNetworkFeeSol
  );
  const underfillKolCohorts = buildUnderfillKolCohorts(rotationPaperRows, assumedNetworkFeeSol);
  const underfillKolTiming = buildKolTimingStats(rotationPaperRows, assumedNetworkFeeSol);
  const posthocSecondKol = buildPosthocSecondKolStats(rotationPaperRows, assumedNetworkFeeSol);
  const posthocSecondKolWaitProxies = buildPosthocSecondKolWaitProxyStats(
    rotationPaperRows,
    rotationRows,
    args.horizonsSec,
    args.roundTripCostPct,
    assumedNetworkFeeSol
  );
  const posthocSecondKolCandidateDecisions = buildPosthocSecondKolCandidateDecisions(
    posthocSecondKolWaitProxies
  );
  const posthocSecondKolSyntheticPaperArms = buildPosthocSecondKolSyntheticPaperArms(
    posthocSecondKolCandidateDecisions
  );
  const posthocSecondKolRouteProofGates = buildPosthocSecondKolRouteProofGates(
    rotationPaperRows,
    assumedNetworkFeeSol
  );
  const posthocSecondKolRecoveryBacklog = buildPosthocSecondKolRecoveryBacklog(
    posthocSecondKolRouteProofGates,
    routeProofFreshness
  );
  const paperCohortValidity = buildPaperCohortValidityStats(rotationPaperRows);
  const reviewCohortGenerationAudit = buildReviewCohortGenerationAuditStats(rotationPaperRows);
  const rotationSecondKolOpportunityFunnel = buildRotationSecondKolOpportunityFunnelStats({
    rotationPaperRows,
    kolTxRows,
    routeProofFreshSinceMs: args.routeProofFreshSinceMs,
    currentSessionStartedAtMs: Number.isFinite(currentSessionStartedAtMs) ? currentSessionStartedAtMs : undefined,
  });
  const rotationSecondKolPromotionGap = buildRotationSecondKolPromotionGapStats({
    rotationPaperRows,
    kolTxRows,
    assumedNetworkFeeSol,
    routeProofFreshSinceMs: args.routeProofFreshSinceMs,
    currentSessionStartedAtMs: Number.isFinite(currentSessionStartedAtMs) ? currentSessionStartedAtMs : undefined,
  });
  const reviewRows = selectRouteKnown2KolCostAwareUnderfillRows(rotationPaperRows);
  const reviewCandidateIds = new Set(
    reviewRows
      .map(rowCandidateId)
      .filter(Boolean)
  );
  const liveEquivalenceDrilldown = buildLiveEquivalenceDrilldownStats(
    recentLiveEquivalenceRows,
    rotationPaperRows,
    assumedNetworkFeeSol,
    reviewCandidateIds
  );
  const reviewCohortEvidence = buildReviewCohortEvidenceStats(
    reviewRows,
    recentLiveEquivalenceRows,
    rotationRows,
    args.horizonsSec,
    args.roundTripCostPct,
    assumedNetworkFeeSol
  );
  const paperExitProxies = buildPaperExitProxyStats(
    rotationPaperRows,
    rotationRows,
    args.horizonsSec,
    args.roundTripCostPct,
    assumedNetworkFeeSol
  );
  const compoundProfiles = buildCompoundProfiles(rotationPaperRows, assumedAtaRentSol, assumedNetworkFeeSol);
  const rotationCompoundFitness = buildRotationCompoundFitnessGate(compoundProfiles);
  const reviewCohortDecision = buildReviewCohortDecision(
    rotationPaperRows,
    rotationRows,
    args.horizonsSec,
    args.roundTripCostPct,
    assumedNetworkFeeSol
  );
  const rotationPaperCompoundReadiness = buildRotationPaperCompoundReadiness(
    underfillRouteCohorts,
    rotationPaperRows,
    rotationRows,
    args.horizonsSec,
    args.roundTripCostPct
  );
  const rotationLiveReadiness = buildRotationLiveReadiness(
    underfillRouteCohorts,
    rotationPaperRows,
    rotationRows,
    args.horizonsSec,
    args.roundTripCostPct,
    evidenceVerdicts
  );
  const reviewLiveEquivalence = buildLiveEquivalenceSummary(
    recentLiveEquivalenceRows.filter((row) => isMicroLiveReviewEquivalenceRow(row, reviewCandidateIds))
  );
  const microLiveReviewPacket = buildMicroLiveReviewPacket(
    rotationPaperCompoundReadiness,
    rotationLiveReadiness,
    rotationCompoundFitness,
    reviewLiveEquivalence,
    reviewCohortEvidence
  );
  const coverageLoad: {
    status: KolPosteriorCoverageLoadStatus;
    targets: KolPosteriorCoverageTarget[];
    error?: string;
  } = args.kolDbPath
    ? await loadKolPosteriorCoverageTargetsWithStatus(args.kolDbPath)
    : { status: 'disabled', targets: [] };
  const kolTransferPosterior = buildKolTransferPosteriorReport(kolTransferRows as unknown as KolTransferRow[], {
    input: kolTransferInput,
    kolDbPath: args.kolDbPath,
    sinceSec: Math.floor(args.sinceMs / 1000),
    coverageTargets: coverageLoad.status === 'loaded' ? coverageLoad.targets : undefined,
    coverageLoadStatus: coverageLoad.status,
    coverageLoadError: coverageLoad.error,
  });
  return {
    generatedAt: new Date().toISOString(),
    realtimeDir: args.realtimeDir,
    since: new Date(args.sinceMs).toISOString(),
    horizonsSec: args.horizonsSec,
    roundTripCostPct: args.roundTripCostPct,
    assumedAtaRentSol,
    assumedNetworkFeeSol,
    tradeMarkouts: {
      totalRows: recentTradeRows.length,
      rotationRows: rotationRows.length,
      afterBuy: summarize(rotationRows.filter((row) => str(row.anchorType) === 'buy'), args.horizonsSec, args.roundTripCostPct),
      afterSell: summarize(rotationSellRows, args.horizonsSec, args.roundTripCostPct),
      afterSellFinal: summarize(rotationSellRows.filter(isFinalSellMarkout), args.horizonsSec, args.roundTripCostPct),
      afterSellPartial: summarize(rotationSellRows.filter(isPartialSellMarkout), args.horizonsSec, args.roundTripCostPct),
      afterSellHardCut: summarize(rotationSellRows.filter(isHardCutSellMarkout), args.horizonsSec, args.roundTripCostPct),
      afterSellMaeFastFail: summarize(rotationSellRows.filter(isMaeFastFailSellMarkout), args.horizonsSec, args.roundTripCostPct),
      byArm: armMarkouts,
    },
    paperTrades: {
      totalRows: recentPaperRows.length,
      rotationRows: rotationPaperRows.length,
      byArm: paperArmStats,
      winnerEntryPairings,
      winnerEntryDiagnostics,
    },
    liveTrades: {
      totalRows: recentLiveRows.length,
      rotationRows: rotationLiveRows.length,
      byArm: buildPaperArmStats(rotationLiveRows, assumedAtaRentSol, assumedNetworkFeeSol),
    },
    underfillEntryQuality: [
      buildUnderfillEntryQualityStats('paper', rotationPaperRows),
      buildUnderfillEntryQualityStats('live', rotationLiveRows),
    ],
    underfillRouteCohorts,
    liveEquivalence,
    routeUnknownReasons,
    routeTruthAudit,
    routeProofFreshness,
    rotationCandidateFunnel,
    kolHunterAdmissionSkipMarkouts,
    rotationDetectorReplay,
    rotationDetectorReplayWindow,
    rotationDetectorBlockerMarkouts,
    rotationStaleBuyReview,
    rotationPriceContextMarkouts,
    rotationDecayBlockMarkouts,
    rotationNarrowCohorts,
    underfillKolCohorts,
    underfillKolTiming,
    posthocSecondKol,
    posthocSecondKolWaitProxies,
    posthocSecondKolCandidateDecisions,
    posthocSecondKolSyntheticPaperArms,
    posthocSecondKolRouteProofGates,
    posthocSecondKolRecoveryBacklog,
    paperCohortValidity,
    reviewCohortGenerationAudit,
    rotationSecondKolOpportunityFunnel,
    rotationSecondKolPromotionGap,
    liveEquivalenceDrilldown,
    reviewCohortEvidence,
    paperExitProxies,
    compoundProfiles,
    rotationCompoundFitness,
    reviewCohortDecision,
    microLiveReviewPacket,
    rotationPaperCompoundReadiness,
    rotationLiveReadiness,
    evidenceVerdicts,
    noTrade: {
      totalRows: recentNoTradeRows.length,
      probeRows: noTradeProbeRows.length,
      byHorizon: summarize(noTradeProbeRows, args.horizonsSec, args.roundTripCostPct),
      byReason: buildReasonStats(noTradeProbeRows, args.roundTripCostPct),
    },
    byAnchor: buildAnchorStats(rotationRows.filter((row) => str(row.anchorType) === 'buy'), args.roundTripCostPct),
    byDevQuality: buildDevQualityStats(
      rotationRows.filter((row) => str(row.anchorType) === 'buy'),
      qualityIndex,
      candidateIndex,
      args.roundTripCostPct
    ),
    kolTransferPosterior: {
      input: kolTransferInput,
      kolDbPath: kolTransferPosterior.kolDbPath,
      coverageLoadStatus: kolTransferPosterior.coverageLoadStatus,
      coverageLoadError: kolTransferPosterior.coverageLoadError,
      rows: kolTransferPosterior.rows,
      candidates: kolTransferPosterior.candidates,
      coverageSummary: kolTransferPosterior.coverageSummary,
      coverage: kolTransferPosterior.coverage,
      topRotationFit: kolTransferPosterior.metrics
        .slice()
        .sort((a, b) => b.rotationFitScore - a.rotationFitScore || b.buyCandidates - a.buyCandidates)
        .slice(0, 12),
    },
  };
}

export function renderRotationLaneReportMarkdown(report: RotationReport): string {
  return renderReport(report);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildRotationLaneReport(args);
  const markdown = renderReport(report);
  if (args.mdOut) {
    await mkdir(path.dirname(args.mdOut), { recursive: true });
    await writeFile(args.mdOut, markdown, 'utf8');
  }
  if (args.jsonOut) {
    await mkdir(path.dirname(args.jsonOut), { recursive: true });
    await writeFile(args.jsonOut, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  if (!args.mdOut && !args.jsonOut) process.stdout.write(markdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
