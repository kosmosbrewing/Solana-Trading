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
const KOL_TRANSFER_INPUT_FILE = 'kol-transfers.jsonl';
const EVIDENCE_MIN_CLOSES = 50;
const EVIDENCE_PROMOTION_MIN_CLOSES = 100;
const EVIDENCE_MIN_OK_COVERAGE = 0.8;
const EVIDENCE_MIN_EDGE_COVERAGE = 0.8;
const EVIDENCE_MIN_EDGE_PASS_RATE = 0.5;
const EVIDENCE_PRIMARY_HORIZONS_SEC = [15, 30];
const EVIDENCE_DECAY_HORIZON_SEC = 60;
const EVIDENCE_REQUIRED_COVERAGE_HORIZONS_SEC = EVIDENCE_PRIMARY_HORIZONS_SEC;
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
const MICRO_LIVE_REVIEW_TICKET_SOL = 0.02;
const MICRO_LIVE_REVIEW_MAX_DAILY_ATTEMPTS = 3;
const MICRO_LIVE_REVIEW_DAILY_LOSS_CAP_SOL = 0.03;

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
  underfillRows: number;
  routeKnownRows: number;
  costAwareRows: number;
  twoPlusKolRows: number;
  routeKnownTwoPlusRows: number;
  routeKnownCostAwareRows: number;
  reviewRows: number;
  missingRouteProofRows: number;
  missingCandidateIdRows: number;
  missingParticipantTimestampRows: number;
  primaryRouteKnownTwoPlusRows: number;
  primaryRouteKnownTwoPlusWithoutCostAwareCloneRows: number;
  blockerReasons: Array<{ reason: string; count: number }>;
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
  underfillKolCohorts: UnderfillRouteCohortStats[];
  underfillKolTiming: KolTimingStats[];
  paperCohortValidity: PaperCohortValidityStats[];
  reviewCohortGenerationAudit: ReviewCohortGenerationAuditStats;
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
  if (rowSurvivalFlags(row).some((flag) =>
    flag === 'EXIT_LIQUIDITY_UNKNOWN' ||
    flag === 'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN' ||
    flag === 'NO_SELL_ROUTE' ||
    flag === 'SELL_NO_ROUTE' ||
    flag === 'NO_ROUTE' ||
    flag.includes('NO_SELL_ROUTE')
  )) {
    return true;
  }
  return !hasUnderfillRoutePositiveEvidence(row);
}

function routeUnknownReasonsForRow(row: JsonRow): string[] {
  if (!isUnderfillRouteUnknown(row)) return [];
  const flags = rowSurvivalFlags(row);
  const reasons = new Set<string>();
  for (const flag of flags) {
    if (flag === 'EXIT_LIQUIDITY_UNKNOWN') reasons.add('EXIT_LIQUIDITY_UNKNOWN');
    else if (flag === 'NO_SELL_ROUTE' || flag === 'SELL_NO_ROUTE' || flag === 'NO_ROUTE' || flag.includes('NO_SELL_ROUTE')) {
      reasons.add('NO_SELL_ROUTE');
    } else if (flag === 'DECIMALS_SECURITY_CLIENT') reasons.add('DECIMALS_SECURITY_CLIENT');
    else if (flag === 'TOKEN_QUALITY_UNKNOWN') reasons.add('TOKEN_QUALITY_UNKNOWN');
    else if (flag === 'NO_SECURITY_DATA' || flag === 'NO_SECURITY_CLIENT') reasons.add(flag);
    else if (flag.includes('JUPITER_429')) reasons.add('JUPITER_429');
    else if (flag.includes('SECURITY_CLIENT')) reasons.add('SECURITY_CLIENT');
    else if (flag === 'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN') reasons.add('ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN');
  }
  if (reasons.size === 0) reasons.add('MISSING_POSITIVE_ROUTE_EVIDENCE');
  return [...reasons].sort();
}

function routeTruthEvidenceSources(row: JsonRow): string[] {
  const extras = obj(row.extras);
  const sources = new Set<string>();
  if (row.routeFound === true || extras.routeFound === true) sources.add('routeFound');
  if (row.sellRouteKnown === true || extras.sellRouteKnown === true) sources.add('sellRouteKnown');
  if (row.exitLiquidityKnown === true || extras.exitLiquidityKnown === true) sources.add('exitLiquidityKnown');
  if ((num(row.exitLiquidityUsd) ?? 0) > 0 || (num(extras.exitLiquidityUsd) ?? 0) > 0) sources.add('exitLiquidityUsd');
  if (Object.keys(obj(row.exitLiquidityData)).length > 0 || Object.keys(obj(extras.exitLiquidityData)).length > 0) {
    sources.add('exitLiquidityData');
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
  if (reasons.some((reason) => reason === 'JUPITER_429')) {
    return { bucket: 'route_unknown:infra_retry', recoverability: 'infra_retry' };
  }
  if (reasons.some((reason) => reason === 'NO_SELL_ROUTE' || reason === 'EXIT_LIQUIDITY_UNKNOWN' || reason === 'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN')) {
    return { bucket: 'route_unknown:structural_exit_route', recoverability: 'structural_block' };
  }
  if (reasons.some((reason) =>
    reason === 'DECIMALS_SECURITY_CLIENT' ||
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
  const extras = obj(row.extras);
  if (row.routeFound === true || extras.routeFound === true) return true;
  if (row.sellRouteKnown === true || extras.sellRouteKnown === true) return true;
  if (row.exitLiquidityKnown === true || extras.exitLiquidityKnown === true) return true;
  if (num(row.exitLiquidityUsd) != null && (num(row.exitLiquidityUsd) ?? 0) > 0) return true;
  if (num(extras.exitLiquidityUsd) != null && (num(extras.exitLiquidityUsd) ?? 0) > 0) return true;
  if (Object.keys(obj(row.exitLiquidityData)).length > 0) return true;
  if (Object.keys(obj(extras.exitLiquidityData)).length > 0) return true;
  return rowSurvivalFlags(row).some((flag) =>
    flag === 'SELL_ROUTE_OK' ||
    flag === 'EXIT_LIQUIDITY_KNOWN' ||
    flag === 'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_KNOWN'
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

function buildReviewCohortGenerationAuditStats(rows: JsonRow[]): ReviewCohortGenerationAuditStats {
  const cohort = 'route_known_2kol_cost_aware';
  const underfillRows = rows.filter(isRotationUnderfillRow);
  const routeKnownRows = underfillRows.filter((row) => !isUnderfillRouteUnknown(row));
  const costAwareRows = underfillRows.filter(isCostAwareUnderfillRow);
  const twoPlusKolRows = underfillRows.filter(isTwoPlusKolRow);
  const routeKnownTwoPlusRows = routeKnownRows.filter(isTwoPlusKolRow);
  const routeKnownCostAwareRows = routeKnownRows.filter(isCostAwareUnderfillRow);
  const reviewRows = selectRouteKnown2KolCostAwareUnderfillRows(rows);
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
  return {
    cohort,
    underfillRows: underfillRows.length,
    routeKnownRows: routeKnownRows.length,
    costAwareRows: costAwareRows.length,
    twoPlusKolRows: twoPlusKolRows.length,
    routeKnownTwoPlusRows: routeKnownTwoPlusRows.length,
    routeKnownCostAwareRows: routeKnownCostAwareRows.length,
    reviewRows: reviewRows.length,
    missingRouteProofRows: underfillRows.length - routeKnownRows.length,
    missingCandidateIdRows: underfillRows.filter((row) => !rowCandidateId(row)).length,
    missingParticipantTimestampRows: underfillRows.filter((row) =>
      !rowParticipants(row).some((item) => item.timestampMs != null)
    ).length,
    primaryRouteKnownTwoPlusRows: primaryRouteKnownTwoPlusRows.length,
    primaryRouteKnownTwoPlusWithoutCostAwareCloneRows: primaryRouteKnownTwoPlusWithoutCostAwareCloneRows.length,
    blockerReasons,
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
    `- blockers: ${row.blockerReasons.map((item) => `${item.reason}:${item.count}`).join(', ') || 'n/a'}`,
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
    '| arm | verdict | closes | min ok coverage | edge coverage | edge pass | refund-adjusted | wallet-drag stress | primary postCost | best primary | vs control | T+60 decay | reasons |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---|',
    ...rows.map((row) =>
      `| ${row.armName} | ${row.verdict} | ${row.closes}/${row.promotionRequiredCloses} | ` +
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
    '## Paper Cohort Validity',
    '> Report-only. Shows whether paper rows have the IDs, KOL counts, participant timestamps, and route proof needed for live-equivalence review.',
    renderPaperCohortValidity(report.paperCohortValidity),
    '',
    '## Review Cohort Generation Audit',
    '> Report-only. Separates no opportunity from missing recording/proof before route_known_2kol_cost_aware can be trusted.',
    renderReviewCohortGenerationAudit(report.reviewCohortGenerationAudit),
    '',
    '## Route Unknown Reasons',
    '> Report-only. Splits route-unknown paper winners from missing/unsafe exit-route evidence. Reasons are non-exclusive; one close can appear in multiple reason rows.',
    renderRouteUnknownReasons(report.routeUnknownReasons),
    '',
    '## Route Truth Audit',
    '> Report-only. Separates route-known proof from structural no-route, data gaps, and transient infra retry candidates.',
    renderRouteTruthAudit(report.routeTruthAudit),
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
  const [tradeMarkouts, missedAlpha, tokenQuality, projectedPaperTrades, projectedLiveTrades, liveEquivalenceRows, kolTransferRows] = await Promise.all([
    readJsonl(path.join(args.realtimeDir, 'trade-markouts.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'missed-alpha.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'token-quality-observations.jsonl')),
    readJsonl(path.join(args.realtimeDir, paperTradesFileName)),
    readJsonl(path.join(args.realtimeDir, ROTATION_LIVE_TRADES_FILE)),
    readJsonl(path.join(args.realtimeDir, KOL_LIVE_EQUIVALENCE_FILE)),
    readJsonl(kolTransferInput),
  ]);
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
  const recentNoTradeRows = missedAlpha.filter((row) => {
    const t = timeMs(probe(row).firedAt) || timeMs(row.rejectedAt);
    return Number.isFinite(t) && t >= args.sinceMs && isRotationNoTrade(row);
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
  const underfillKolCohorts = buildUnderfillKolCohorts(rotationPaperRows, assumedNetworkFeeSol);
  const underfillKolTiming = buildKolTimingStats(rotationPaperRows, assumedNetworkFeeSol);
  const paperCohortValidity = buildPaperCohortValidityStats(rotationPaperRows);
  const reviewCohortGenerationAudit = buildReviewCohortGenerationAuditStats(rotationPaperRows);
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
    underfillKolCohorts,
    underfillKolTiming,
    paperCohortValidity,
    reviewCohortGenerationAudit,
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
