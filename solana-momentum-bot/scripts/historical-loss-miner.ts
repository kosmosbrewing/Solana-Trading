import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

type JsonRow = Record<string, any>;

interface Args {
  realtimeDir: string;
  sinceMs?: number;
  nowMs?: number;
  freshWindowSpecs: string[];
  minRows: number;
  maxP90Mfe: number;
  mdOut?: string;
  jsonOut?: string;
}

interface LedgerSpec {
  name: string;
  fileName: string;
  mode: 'paper' | 'live';
  lane: 'rotation' | 'smart_v3' | 'kol';
}

interface BucketStats {
  bucketType: string;
  label: string;
  rows: number;
  tokenWins: number;
  walletWins: number;
  walletNetSol: number;
  tokenNetSol: number;
  avgWalletNetSol: number;
  zeroMfeRows: number;
  p50MfePct: number | null;
  p90MfePct: number | null;
  actual5xRows: number;
  killedWalletWinners: number;
  avoidableWalletLossSol: number;
  recommendedAction: string;
}

interface HistoricalLossReport {
  generatedAt: string;
  since: string | null;
  criteria: {
    minRows: number;
    maxP90MfePct: number;
  };
  ledgers: BucketStats[];
  missionCompoundingBoard: MissionCompoundingBoard;
  counterfactuals: BucketStats[];
  paperShadowGateQueue: PaperShadowGateQueueItem[];
  paperShadowBlockCounters: PaperShadowBlockCounter[];
  conjunctiveProxySplits: ConjunctiveProxySplit[];
  freshSplitReadiness: FreshSplitReadiness[];
  freshSplitValidations: FreshSplitValidation[];
  preEntryProxyCandidates: BucketStats[];
  postCloseDiagnosticCandidates: BucketStats[];
  diagnosticProxyCandidates: DiagnosticProxyCandidate[];
  smartV3AdmissionCandidates: SmartV3AdmissionCandidate[];
  paperShadowDecisionLedger: PaperShadowDecisionLedgerItem[];
  promotionWatchlist: PromotionWatchlist;
  promotionPackets: PromotionPacketItem[];
  paperShadowFreshReadiness: PaperShadowFreshReadiness[];
  paperShadowFreshCounters: PaperShadowFreshCounter[];
  cutCandidates: BucketStats[];
  exitBuckets: BucketStats[];
  armExitBuckets: BucketStats[];
  flagBuckets: BucketStats[];
}

type MissionCompoundingBoardVerdict =
  | 'LIVE_COHORT_PROVEN'
  | 'PAPER_COHORT_FOUND'
  | 'WAIT_SAMPLE'
  | 'NO_COMPOUNDING_COHORT';

type MissionCompoundingCohortVerdict =
  | 'READY_FOR_MICRO_LIVE_REVIEW'
  | 'PAPER_MIRROR_CANDIDATE'
  | 'WAIT_SAMPLE'
  | 'RESEARCH_ONLY'
  | 'REJECT_POLICY_DEMOTED'
  | 'REJECT_EXECUTION_GAP'
  | 'REJECT_WALLET_NEGATIVE'
  | 'REJECT_LOW_WIN_RATE'
  | 'REJECT_LOSS_STREAK'
  | 'REJECT_WALLET_DRAG';

interface MissionCompoundingBoard {
  verdict: MissionCompoundingBoardVerdict;
  requiredRows: number;
  minTrackingRows: number;
  minWalletWinRate: number;
  maxLossStreak: number;
  maxWalletDragRate: number;
  primaryAction: string;
  blockerSummary: MissionCompoundingBlockerSummary[];
  executionGapSummary: MissionExecutionGapSummary[];
  candidates: MissionCompoundingCohort[];
}

type MissionCompoundingBlocker =
  | 'research_only'
  | 'demoted_policy'
  | 'execution_gap'
  | 'thin_sample'
  | 'wallet_negative'
  | 'low_win_rate'
  | 'loss_streak'
  | 'wallet_drag'
  | 'other';

interface MissionCompoundingBlockerSummary {
  blocker: MissionCompoundingBlocker;
  cohorts: number;
  rows: number;
  comparableRows: number;
  liveRows: number;
  paperRows: number;
  researchRows: number;
  walletNetSol: number;
  topLabels: string[];
  nextAction: string;
}

type MissionExecutionGapKind =
  | 'exit_liquidity_unknown'
  | 'route_unknown'
  | 'security_unknown'
  | 'token_quality_unknown'
  | 'venue_unknown'
  | 'other_execution_gap';

interface MissionExecutionGapBreakdown {
  kind: MissionExecutionGapKind;
  rows: number;
}

interface MissionExecutionGapSummary {
  kind: MissionExecutionGapKind;
  cohorts: number;
  rows: number;
  uniqueRows: number;
  liveRows: number;
  paperRows: number;
  researchRows: number;
  walletNetSol: number;
  topLabels: string[];
  nextAction: string;
}

interface MissionCompoundingCohort {
  rank: number;
  label: string;
  lane: string;
  evidenceRole: 'live_wallet' | 'paper_mirror' | 'paper_mixed' | 'research_only';
  verdict: MissionCompoundingCohortVerdict;
  rows: number;
  comparableRows: number;
  liveRows: number;
  paperRows: number;
  researchRows: number;
  paperOnlyPolicyRows: number;
  paperOnlyPolicyRate: number | null;
  executionGapRows: number;
  executionGapRate: number | null;
  executionGapBreakdown: MissionExecutionGapBreakdown[];
  walletWins: number;
  walletLosses: number;
  walletWinRate: number | null;
  walletNetSol: number;
  avgWalletNetSol: number;
  tokenOnlyWinnerWalletLoserRows: number;
  tokenOnlyWinnerWalletLoserRate: number | null;
  actual5xRows: number;
  p50MfePct: number | null;
  p90MfePct: number | null;
  medianHoldSec: number | null;
  maxLossStreak: number;
  worstLossSol: number;
  blockers: string[];
  nextAction: string;
}

interface PaperShadowGateQueueItem {
  rank: number;
  label: string;
  lane: string;
  historicalRows: number;
  historicalWalletNetSol: number;
  historicalAvoidableLossSol: number;
  historicalWalletWins: number;
  historicalActual5xRows: number;
  historicalP90MfePct: number | null;
  shadowGate: string;
  freshValidationGate: string;
  verdict: 'READY_FOR_FRESH_SHADOW' | 'REVIEW_FALSE_POSITIVES';
  nextAction: string;
}

interface PaperShadowBlockCounter {
  rank: number;
  label: string;
  lane: string;
  shadowBlockedRows: number;
  blockedWalletNetSol: number;
  savedLossSol: number;
  missedWinnerRows: number;
  missedWinnerSol: number;
  missedActual5xRows: number;
  shadowNetImpactSol: number;
  verdict: 'WAIT_FRESH_ROWS' | 'PASS_FRESH_SHADOW_REVIEW' | 'REJECT_FALSE_POSITIVES' | 'REJECT_NO_SAVED_LOSS';
  nextAction: string;
}

interface ConjunctiveProxySplit {
  parentLabel: string;
  conjunctiveLabel: string;
  label: string;
  lane: string;
  rows: number;
  walletNetSol: number;
  savedLossSol: number;
  missedWinnerRows: number;
  missedWinnerSol: number;
  missedActual5xRows: number;
  p90MfePct: number | null;
  verdict: 'READY_FOR_FRESH_SHADOW' | 'WAIT_SPLIT_SAMPLE';
  nextAction: string;
}

interface FreshSplitValidation {
  window: string;
  since: string;
  label: string;
  lane: string;
  rows: number;
  walletNetSol: number;
  savedLossSol: number;
  missedWinnerRows: number;
  missedWinnerSol: number;
  missedActual5xRows: number;
  p90MfePct: number | null;
  verdict: 'READY' | 'WAIT_FRESH_ROWS' | 'REJECT_FALSE_POSITIVES' | 'REJECT_NO_SAVED_LOSS';
  nextAction: string;
}

interface FreshSplitReadiness {
  label: string;
  lane: string;
  requiredRows: number;
  bestWindow: string | null;
  bestWindowRows: number;
  rowsRemaining: number;
  walletNetSol: number;
  savedLossSol: number;
  missedWinnerRows: number;
  missedActual5xRows: number;
  verdict: 'READY' | 'WAIT_FRESH_ROWS' | 'STALE_NO_24H_ROWS' | 'REJECT_FALSE_POSITIVES' | 'REJECT_NO_SAVED_LOSS';
  nextAction: string;
}

interface DiagnosticProxyCandidate {
  rank: number;
  diagnosticLabel: string;
  diagnosticBucketType: string;
  lane: string;
  proxyLabel: string;
  diagnosticRows: number;
  proxyRows: number;
  targetProxyRows: number;
  diagnosticCoveragePct: number;
  walletNetSol: number;
  savedLossSol: number;
  missedWinnerRows: number;
  missedWinnerSol: number;
  missedActual5xRows: number;
  p90MfePct: number | null;
  verdict:
    | 'READY_FOR_FRESH_SHADOW'
    | 'WAIT_PROXY_SAMPLE'
    | 'REJECT_FALSE_POSITIVES'
    | 'REJECT_TAIL_KILL'
    | 'REJECT_HIGH_MFE'
    | 'REJECT_NO_SAVED_LOSS';
  nextAction: string;
}

interface SmartV3AdmissionCandidate {
  rank: number;
  proxyLabel: string;
  targetRows: number;
  proxyRows: number;
  targetProxyRows: number;
  targetCoveragePct: number;
  walletNetSol: number;
  savedLossSol: number;
  missedWinnerRows: number;
  missedWinnerSol: number;
  missedT2Rows: number;
  missedActual5xRows: number;
  p90MfePct: number | null;
  verdict:
    | 'READY_FOR_FRESH_SHADOW'
    | 'WAIT_PROXY_SAMPLE'
    | 'REJECT_FALSE_POSITIVES'
    | 'REJECT_TAIL_KILL'
    | 'REJECT_HIGH_MFE'
    | 'REJECT_NO_SAVED_LOSS';
  nextAction: string;
}

interface PaperShadowDecisionLedgerItem {
  rank: number;
  kind: 'pre_entry_proxy' | 'conjunctive_split' | 'diagnostic_proxy' | 'smart_v3_admission';
  label: string;
  lane: string;
  rows: number;
  walletNetSol: number;
  savedLossSol: number;
  missedWinnerRows: number;
  missedWinnerSol: number;
  missedT2Rows: number;
  missedActual5xRows: number;
  netImpactSol: number;
  state: 'READY_FOR_REVIEW' | 'PAPER_SHADOW_ONLY' | 'WAIT_FRESH' | 'REJECT';
  sourceVerdict: string;
  nextAction: string;
}

interface PromotionPacketItem {
  rank: number;
  kind: PaperShadowDecisionLedgerItem['kind'];
  label: string;
  lane: string;
  verdict: 'READY_FOR_LIVE_REVIEW' | 'PAPER_SHADOW_ONLY' | 'WAIT_FRESH_ROWS' | 'REJECTED';
  rows: number;
  netImpactSol: number;
  savedLossSol: number;
  missedWinnerRows: number;
  missedT2Rows: number;
  missedActual5xRows: number;
  blockers: string[];
  liveReviewGate: string;
  nextAction: string;
}

interface PromotionWatchlist {
  readyForLiveReview: number;
  paperShadowOnly: number;
  waitFreshRows: number;
  rejected: number;
  primaryAction: string;
  rows: PromotionWatchlistItem[];
}

interface PromotionWatchlistItem {
  rank: number;
  queue: 'live_review' | 'paper_shadow' | 'wait_fresh' | 'rejected';
  kind: PromotionPacketItem['kind'];
  label: string;
  lane: string;
  verdict: PromotionPacketItem['verdict'];
  rows: number;
  netImpactSol: number;
  savedLossSol: number;
  blockers: string[];
  nextAction: string;
}

interface PaperShadowFreshCounter {
  window: string;
  since: string;
  kind: PromotionPacketItem['kind'];
  label: string;
  lane: string;
  rows: number;
  requiredRows: number;
  rowsRemaining: number;
  walletNetSol: number;
  savedLossSol: number;
  missedWinnerRows: number;
  missedWinnerSol: number;
  missedT2Rows: number;
  missedActual5xRows: number;
  netImpactSol: number;
  verdict:
    | 'READY_FRESH_REVIEW'
    | 'WAIT_FRESH_ROWS'
    | 'REJECT_FALSE_POSITIVES'
    | 'REJECT_TAIL_KILL'
    | 'REJECT_NO_SAVED_LOSS';
  nextAction: string;
}

interface PaperShadowFreshReadiness {
  kind: PromotionPacketItem['kind'];
  label: string;
  lane: string;
  bestWindow: string | null;
  rows: number;
  requiredRows: number;
  rowsRemaining: number;
  netImpactSol: number;
  savedLossSol: number;
  missedWinnerRows: number;
  missedT2Rows: number;
  missedActual5xRows: number;
  verdict:
    | 'READY_FRESH_REVIEW'
    | 'WAIT_FRESH_ROWS'
    | 'STALE_NO_24H_ROWS'
    | 'REJECT_FALSE_POSITIVES'
    | 'REJECT_TAIL_KILL'
    | 'REJECT_NO_SAVED_LOSS';
  nextAction: string;
}

const LEDGERS: LedgerSpec[] = [
  { name: 'rotation_paper', fileName: 'rotation-v1-paper-trades.jsonl', mode: 'paper', lane: 'rotation' },
  { name: 'rotation_live', fileName: 'rotation-v1-live-trades.jsonl', mode: 'live', lane: 'rotation' },
  { name: 'smart_v3_paper', fileName: 'smart-v3-paper-trades.jsonl', mode: 'paper', lane: 'smart_v3' },
  { name: 'smart_v3_live', fileName: 'smart-v3-live-trades.jsonl', mode: 'live', lane: 'smart_v3' },
  { name: 'kol_live', fileName: 'kol-live-trades.jsonl', mode: 'live', lane: 'kol' },
];

const DEMOTED_OR_PAPER_ONLY_ARMS = new Set([
  'rotation_chase_topup_v1',
]);

function parseArgs(argv: string[]): Args {
  const args: Args = {
    realtimeDir: path.resolve(process.cwd(), 'data/realtime'),
    freshWindowSpecs: ['24h', '3d', '7d'],
    minRows: 20,
    maxP90Mfe: 0.03,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--realtime-dir') args.realtimeDir = path.resolve(argv[++i]);
    else if (arg === '--since') args.sinceMs = parseSince(argv[++i]);
    else if (arg === '--now') args.nowMs = parseSince(argv[++i]);
    else if (arg === '--fresh-windows') args.freshWindowSpecs = argv[++i].split(',').map((item) => item.trim()).filter(Boolean);
    else if (arg === '--min-rows') args.minRows = parseNumber(argv[++i], arg);
    else if (arg === '--max-p90-mfe') args.maxP90Mfe = parseNumber(argv[++i], arg);
    else if (arg === '--md') args.mdOut = path.resolve(argv[++i]);
    else if (arg === '--json') args.jsonOut = path.resolve(argv[++i]);
  }
  return args;
}

function parseSince(raw: string): number {
  const relative = raw.match(/^(\d+)(h|d)$/);
  if (relative) {
    const count = Number(relative[1]);
    return Date.now() - count * (relative[2] === 'h' ? 3600_000 : 24 * 3600_000);
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`invalid --since: ${raw}`);
  return parsed;
}

function freshWindowStart(raw: string, nowMs: number): number {
  const relative = raw.match(/^(\d+)(h|d)$/);
  if (!relative) {
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) throw new Error(`invalid fresh window: ${raw}`);
    return parsed;
  }
  const count = Number(relative[1]);
  return nowMs - count * (relative[2] === 'h' ? 3600_000 : 24 * 3600_000);
}

function parseNumber(raw: string, label: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid ${label}: ${raw}`);
  return parsed;
}

async function readJsonl(filePath: string): Promise<JsonRow[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
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

function num(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function str(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return 'unknown';
}

function boolValue(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return null;
}

function timeMs(row: JsonRow): number {
  return Date.parse(str(row.closedAt, row.exitTimeIso, row.openedAt)) ||
    (num(row.exitTimeSec) ?? num(row.entryTimeSec) ?? 0) * 1000;
}

function walletNetSol(row: JsonRow): number {
  return num(row.netSol, row.walletNetSol, row.netSolWallet) ?? 0;
}

function tokenNetSol(row: JsonRow): number {
  return num(row.netSolTokenOnly, row.tokenOnlyNetSol, row.netSol) ?? 0;
}

function mfePct(row: JsonRow): number {
  return num(row.mfePctPeak, row.mfePct, row.maxMfePct) ?? 0;
}

function holdSec(row: JsonRow): number | null {
  return num(row.holdSec, row.holdSeconds, row.durationSec);
}

function percentile(values: number[], p: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor((sorted.length - 1) * p)];
}

function flags(row: JsonRow): string[] {
  const extras = row.extras && typeof row.extras === 'object' ? row.extras : {};
  return [...new Set([
    ...(Array.isArray(row.survivalFlags) ? row.survivalFlags : []),
    ...(Array.isArray(row.riskFlags) ? row.riskFlags : []),
    ...(Array.isArray(row.smartV3LiveBlockFlags) ? row.smartV3LiveBlockFlags : []),
    ...(Array.isArray(extras.survivalFlags) ? extras.survivalFlags : []),
  ].map(String))];
}

function isActionableFlag(flag: string): boolean {
  return flag !== 'DECIMALS_SECURITY_CLIENT' &&
    !flag.startsWith('LIVE_DECIMALS_') &&
    !flag.startsWith('SELL_DECIMALS_');
}

function isPreEntryProxyFlag(flag: string): boolean {
  if (!isActionableFlag(flag)) return false;
  if (flag.includes('LIVE_CANARY')) return false;
  if (flag.startsWith('LIVE_GATE_')) return false;
  if (flag.includes('_ENABLED') || flag.includes('_DISABLED')) return false;
  if (flag.startsWith('ROTATION_FLOW_REASON_')) return false;
  if (flag.startsWith('ROTATION_FLOW_CLOSE_')) return false;
  if (flag.startsWith('ROTATION_FLOW_LIVE_CLOSE_')) return false;
  if (flag.startsWith('ROTATION_FLOW_REDUCE_')) return false;
  return true;
}

function isConjunctiveSplitFlag(flag: string): boolean {
  if (!isPreEntryProxyFlag(flag)) return false;
  if (flag.includes('PAPER')) return false;
  if (flag.includes('SHADOW')) return false;
  if (flag.includes('LIVE_DISABLED')) return false;
  if (flag.includes('_GROSS_BUY_SOL_')) return false;
  if (flag.includes('_RESPONSE_PCT_')) return false;
  if (flag.startsWith('EXIT_')) return false;
  if (flag.startsWith('EXT_')) return false;
  if (flag.startsWith('UNCLEAN_TOKEN:top10_')) return false;
  return true;
}

function isDiagnosticProxyFlag(flag: string): boolean {
  if (!isConjunctiveSplitFlag(flag)) return false;
  return ![
    'ROTATION_UNDERFILL_KOLS_1',
    'ROTATION_UNDERFILL_REF_KOL_WEIGHTED_FILL',
    'ROTATION_UNDERFILL_SA_ONLY',
    'ROTATION_UNDERFILL_V1',
  ].includes(flag);
}

function summarize(bucketType: string, label: string, rows: JsonRow[]): BucketStats {
  const wallet = rows.reduce((sum, row) => sum + walletNetSol(row), 0);
  const token = rows.reduce((sum, row) => sum + tokenNetSol(row), 0);
  const mfes = rows.map(mfePct);
  const walletLoss = rows.filter((row) => walletNetSol(row) < 0);
  return {
    bucketType,
    label,
    rows: rows.length,
    tokenWins: rows.filter((row) => tokenNetSol(row) > 0).length,
    walletWins: rows.filter((row) => walletNetSol(row) > 0).length,
    walletNetSol: round(wallet),
    tokenNetSol: round(token),
    avgWalletNetSol: round(wallet / Math.max(1, rows.length)),
    zeroMfeRows: rows.filter((row) => mfePct(row) === 0).length,
    p50MfePct: percentile(mfes, 0.5),
    p90MfePct: percentile(mfes, 0.9),
    actual5xRows: rows.filter((row) => mfePct(row) >= 4).length,
    killedWalletWinners: rows.filter((row) => walletNetSol(row) > 0).length,
    avoidableWalletLossSol: round(walletLoss.reduce((sum, row) => sum - walletNetSol(row), 0)),
    recommendedAction: 'review',
  };
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function groups(rows: JsonRow[], bucketType: string, labelsFor: (row: JsonRow) => string[]): BucketStats[] {
  const buckets = new Map<string, JsonRow[]>();
  for (const row of rows) {
    for (const label of labelsFor(row)) {
      buckets.set(label, [...(buckets.get(label) ?? []), row]);
    }
  }
  return [...buckets.entries()]
    .map(([label, scoped]) => summarize(bucketType, label, scoped))
    .sort((a, b) => a.walletNetSol - b.walletNetSol || b.rows - a.rows);
}

function candidateAction(bucket: BucketStats): string {
  if (bucket.bucketType === 'flag') return 'paper_shadow_pre_entry_proxy_gate';
  if (bucket.label.includes('rotation_dead_on_arrival')) return 'rotation_pre_entry_doa_block_or_paper_fallback';
  if (bucket.label.includes('entry_advantage_emergency_exit')) return 'rotation_entry_advantage_pretrade_block';
  if (bucket.label.includes('probe_hard_cut')) return 'tighten_pre_entry_or_hardcut_admission';
  if (bucket.label.includes('mae_fast_fail')) return 'convert_repeated_mae_fast_fail_to_no_trade';
  return 'counterfactual_before_live_policy';
}

function withAction(bucket: BucketStats): BucketStats {
  return { ...bucket, recommendedAction: candidateAction(bucket) };
}

function cutCandidates(buckets: BucketStats[], args: Args): BucketStats[] {
  return buckets
    .filter((bucket) =>
      bucket.rows >= args.minRows &&
      bucket.walletNetSol < 0 &&
      (bucket.p90MfePct ?? 0) <= args.maxP90Mfe &&
      bucket.actual5xRows === 0
    )
    .map(withAction)
    .sort((a, b) =>
      b.avoidableWalletLossSol - a.avoidableWalletLossSol ||
      a.killedWalletWinners - b.killedWalletWinners ||
      a.label.localeCompare(b.label)
    );
}

function isLane(row: JsonRow, lane: string): boolean {
  return row.__lane === lane || str(row.armName, row.profileArm, row.entryReason).includes(lane);
}

function laneFromFlag(label: string): string {
  if (label.startsWith('SMART_V3_')) return 'smart_v3';
  if (label.startsWith('ROTATION_')) return 'rotation';
  return 'mixed';
}

function buildPaperShadowGateQueue(
  buckets: BucketStats[],
  args: Args
): PaperShadowGateQueueItem[] {
  const requiredFreshRows = Math.max(30, args.minRows);
  return buckets.map((bucket, index) => {
    const verdict = bucket.walletWins > 0
      ? 'REVIEW_FALSE_POSITIVES'
      : 'READY_FOR_FRESH_SHADOW';
    return {
      rank: index + 1,
      label: bucket.label,
      lane: laneFromFlag(bucket.label),
      historicalRows: bucket.rows,
      historicalWalletNetSol: bucket.walletNetSol,
      historicalAvoidableLossSol: bucket.avoidableWalletLossSol,
      historicalWalletWins: bucket.walletWins,
      historicalActual5xRows: bucket.actual5xRows,
      historicalP90MfePct: bucket.p90MfePct,
      shadowGate: `if pre-entry flags contain ${bucket.label}, mark paperShadowBlocked=true`,
      freshValidationGate:
        `require >=${requiredFreshRows} fresh rows, walletNet<0, actual5x=0, walletWins=0 before live review`,
      verdict,
      nextAction: verdict === 'READY_FOR_FRESH_SHADOW'
        ? 'add report-only paper shadow block counter and compare saved loss vs missed winner'
        : 'split with an extra conjunctive filter before any paper shadow block',
    };
  });
}

function buildPaperShadowBlockCounters(
  queue: PaperShadowGateQueueItem[],
  rows: JsonRow[],
  args: Args
): PaperShadowBlockCounter[] {
  const requiredFreshRows = Math.max(30, args.minRows);
  return queue.map((item) => {
    const blockedRows = rows.filter((row) => flags(row).includes(item.label));
    const blockedWalletNetSol = round(blockedRows.reduce((sum, row) => sum + walletNetSol(row), 0));
    const savedLossSol = round(blockedRows
      .filter((row) => walletNetSol(row) < 0)
      .reduce((sum, row) => sum - walletNetSol(row), 0));
    const missedWinnerRows = blockedRows.filter((row) => walletNetSol(row) > 0).length;
    const missedWinnerSol = round(blockedRows
      .filter((row) => walletNetSol(row) > 0)
      .reduce((sum, row) => sum + walletNetSol(row), 0));
    const missedActual5xRows = blockedRows.filter((row) => mfePct(row) >= 4).length;
    const shadowNetImpactSol = round(-blockedWalletNetSol);
    const verdict = shadowBlockVerdict({
      rows: blockedRows.length,
      requiredFreshRows,
      missedWinnerRows,
      missedActual5xRows,
      shadowNetImpactSol,
    });
    return {
      rank: item.rank,
      label: item.label,
      lane: item.lane,
      shadowBlockedRows: blockedRows.length,
      blockedWalletNetSol,
      savedLossSol,
      missedWinnerRows,
      missedWinnerSol,
      missedActual5xRows,
      shadowNetImpactSol,
      verdict,
      nextAction: shadowBlockNextAction(verdict),
    };
  });
}

function shadowBlockVerdict(input: {
  rows: number;
  requiredFreshRows: number;
  missedWinnerRows: number;
  missedActual5xRows: number;
  shadowNetImpactSol: number;
}): PaperShadowBlockCounter['verdict'] {
  if (input.missedWinnerRows > 0 || input.missedActual5xRows > 0) return 'REJECT_FALSE_POSITIVES';
  if (input.rows < input.requiredFreshRows) return 'WAIT_FRESH_ROWS';
  if (input.shadowNetImpactSol <= 0) return 'REJECT_NO_SAVED_LOSS';
  return 'PASS_FRESH_SHADOW_REVIEW';
}

function shadowBlockNextAction(verdict: PaperShadowBlockCounter['verdict']): string {
  if (verdict === 'PASS_FRESH_SHADOW_REVIEW') return 'promote to paper-only admission block review';
  if (verdict === 'WAIT_FRESH_ROWS') return 'keep collecting fresh paper shadow rows';
  if (verdict === 'REJECT_FALSE_POSITIVES') return 'split or discard before any block';
  return 'discard unless a narrower conjunctive proxy is found';
}

function buildConjunctiveProxySplits(
  counters: PaperShadowBlockCounter[],
  rows: JsonRow[],
  args: Args
): ConjunctiveProxySplit[] {
  const splitMinRows = Math.max(2, Math.ceil(args.minRows / 2));
  const splits: ConjunctiveProxySplit[] = [];
  for (const counter of counters.filter((item) => item.verdict === 'REJECT_FALSE_POSITIVES')) {
    const parentRows = rows.filter((row) => flags(row).includes(counter.label));
    const coFlags = [...new Set(parentRows.flatMap((row) => flags(row)))]
      .filter((flag) => flag !== counter.label && isConjunctiveSplitFlag(flag));
    for (const coFlag of coFlags) {
      const splitRows = parentRows.filter((row) => flags(row).includes(coFlag));
      const item = buildConjunctiveProxySplit(counter, coFlag, splitRows, splitMinRows);
      if (
        item.verdict === 'READY_FOR_FRESH_SHADOW' &&
        item.walletNetSol < 0 &&
        item.missedWinnerRows === 0 &&
        item.missedActual5xRows === 0 &&
        (item.p90MfePct ?? 0) <= args.maxP90Mfe
      ) {
        splits.push(item);
      }
    }
  }
  return splits
    .sort((a, b) => b.savedLossSol - a.savedLossSol || b.rows - a.rows || a.label.localeCompare(b.label))
    .slice(0, 25);
}

function buildConjunctiveProxySplit(
  parent: PaperShadowBlockCounter,
  conjunctiveLabel: string,
  rows: JsonRow[],
  splitMinRows: number
): ConjunctiveProxySplit {
  const walletNetSolValue = round(rows.reduce((sum, row) => sum + walletNetSol(row), 0));
  const savedLossSol = round(rows
    .filter((row) => walletNetSol(row) < 0)
    .reduce((sum, row) => sum - walletNetSol(row), 0));
  const missedWinnerRows = rows.filter((row) => walletNetSol(row) > 0).length;
  const missedWinnerSol = round(rows
    .filter((row) => walletNetSol(row) > 0)
    .reduce((sum, row) => sum + walletNetSol(row), 0));
  const missedActual5xRows = rows.filter((row) => mfePct(row) >= 4).length;
  const verdict = rows.length >= splitMinRows
    ? 'READY_FOR_FRESH_SHADOW'
    : 'WAIT_SPLIT_SAMPLE';
  return {
    parentLabel: parent.label,
    conjunctiveLabel,
    label: `${parent.label} + ${conjunctiveLabel}`,
    lane: parent.lane,
    rows: rows.length,
    walletNetSol: walletNetSolValue,
    savedLossSol,
    missedWinnerRows,
    missedWinnerSol,
    missedActual5xRows,
    p90MfePct: percentile(rows.map(mfePct), 0.9),
    verdict,
    nextAction: verdict === 'READY_FOR_FRESH_SHADOW'
      ? 'track conjunctive paper shadow block counter'
      : 'keep collecting split sample before review',
  };
}

function buildDiagnosticProxyCandidates(
  diagnostics: BucketStats[],
  rows: JsonRow[],
  args: Args
): DiagnosticProxyCandidate[] {
  const proxyMinRows = Math.max(2, Math.ceil(args.minRows / 2));
  const candidates = diagnostics
    .slice(0, 25)
    .flatMap((diagnostic) =>
      buildDiagnosticProxyCandidatesForTarget(diagnostic, rows, proxyMinRows, args.maxP90Mfe)
        .sort(compareDiagnosticProxyCandidates)
        .slice(0, 5)
    )
    .sort(compareDiagnosticProxyCandidates)
    .slice(0, 50);
  return candidates.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function buildDiagnosticProxyCandidatesForTarget(
  diagnostic: BucketStats,
  rows: JsonRow[],
  proxyMinRows: number,
  maxP90Mfe: number
): DiagnosticProxyCandidate[] {
  const targetRows = rows.filter((row) => matchesDiagnosticBucket(row, diagnostic));
  if (targetRows.length === 0) return [];
  const targetLabels = new Set(diagnosticProxyLabels(targetRows));
  const buckets = new Map<string, { proxyRows: JsonRow[]; targetProxyRows: JsonRow[] }>();
  for (const row of rows) {
    const isTargetRow = matchesDiagnosticBucket(row, diagnostic);
    for (const label of diagnosticProxyLabelsForFlags(flags(row).filter(isDiagnosticProxyFlag).sort())) {
      if (!targetLabels.has(label)) continue;
      const bucket = buckets.get(label) ?? { proxyRows: [], targetProxyRows: [] };
      bucket.proxyRows.push(row);
      if (isTargetRow) bucket.targetProxyRows.push(row);
      buckets.set(label, bucket);
    }
  }
  return [...buckets.entries()].flatMap(([proxyLabel, bucket]) => {
    const { proxyRows, targetProxyRows } = bucket;
    if (targetProxyRows.length < proxyMinRows) return [];
    return [buildDiagnosticProxyCandidate({
      diagnostic,
      proxyLabel,
      targetRows,
      proxyRows,
      targetProxyRows,
      proxyMinRows,
      maxP90Mfe,
    })];
  });
}

function diagnosticProxyLabels(rows: JsonRow[]): string[] {
  const labels = new Set<string>();
  for (const row of rows) {
    for (const label of diagnosticProxyLabelsForFlags(flags(row).filter(isDiagnosticProxyFlag).sort())) labels.add(label);
  }
  return [...labels];
}

function diagnosticProxyLabelsForFlags(rowFlags: string[]): string[] {
  const labels: string[] = [];
  for (const flag of rowFlags) labels.push(flag);
  for (let i = 0; i < rowFlags.length; i += 1) {
    for (let j = i + 1; j < rowFlags.length; j += 1) {
      labels.push(`${rowFlags[i]} + ${rowFlags[j]}`);
    }
  }
  return labels;
}

function buildDiagnosticProxyCandidate(input: {
  diagnostic: BucketStats;
  proxyLabel: string;
  targetRows: JsonRow[];
  proxyRows: JsonRow[];
  targetProxyRows: JsonRow[];
  proxyMinRows: number;
  maxP90Mfe: number;
}): DiagnosticProxyCandidate {
  const walletNetSolValue = round(input.proxyRows.reduce((sum, row) => sum + walletNetSol(row), 0));
  const savedLossSol = round(input.proxyRows
    .filter((row) => walletNetSol(row) < 0)
    .reduce((sum, row) => sum - walletNetSol(row), 0));
  const missedWinnerRows = input.proxyRows.filter((row) => walletNetSol(row) > 0).length;
  const missedWinnerSol = round(input.proxyRows
    .filter((row) => walletNetSol(row) > 0)
    .reduce((sum, row) => sum + walletNetSol(row), 0));
  const missedActual5xRows = input.proxyRows.filter((row) => mfePct(row) >= 4).length;
  const p90MfePct = percentile(input.proxyRows.map(mfePct), 0.9);
  const verdict = diagnosticProxyVerdict({
    proxyRows: input.proxyRows.length,
    proxyMinRows: input.proxyMinRows,
    walletNetSol: walletNetSolValue,
    savedLossSol,
    missedWinnerRows,
    missedActual5xRows,
    p90MfePct,
    maxP90Mfe: input.maxP90Mfe,
  });
  return {
    rank: 0,
    diagnosticLabel: input.diagnostic.label,
    diagnosticBucketType: input.diagnostic.bucketType,
    lane: majorityLane(input.targetRows),
    proxyLabel: input.proxyLabel,
    diagnosticRows: input.targetRows.length,
    proxyRows: input.proxyRows.length,
    targetProxyRows: input.targetProxyRows.length,
    diagnosticCoveragePct: round(input.targetProxyRows.length / Math.max(1, input.targetRows.length)),
    walletNetSol: walletNetSolValue,
    savedLossSol,
    missedWinnerRows,
    missedWinnerSol,
    missedActual5xRows,
    p90MfePct,
    verdict,
    nextAction: diagnosticProxyNextAction(verdict),
  };
}

function matchesDiagnosticBucket(row: JsonRow, bucket: BucketStats): boolean {
  if (bucket.bucketType === 'exit') return str(row.exitReason, row.closeReason) === bucket.label;
  if (bucket.bucketType === 'arm_exit') {
    return `${str(row.profileArm, row.armName, row.__lane)}::${str(row.exitReason, row.closeReason)}` === bucket.label;
  }
  return false;
}

function majorityLane(rows: JsonRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const lane = strategyLane(row);
    counts.set(lane, (counts.get(lane) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'unknown';
}

function strategyLane(row: JsonRow): string {
  const raw = str(row.profileArm, row.armName, row.entryReason, row.__lane);
  if (raw.includes('smart_v3')) return 'smart_v3';
  if (raw.includes('rotation')) return 'rotation';
  return str(row.__lane, raw);
}

function armIdentity(row: JsonRow): string {
  return str(row.profileArm, row.armName, row.entryArm, row.kolEntryReason, row.__lane);
}

function isResearchOnlyRow(row: JsonRow): boolean {
  const extras = row.extras && typeof row.extras === 'object' ? row.extras : {};
  const role = str(row.paperRole, extras.paperRole, '');
  if (role === 'research_arm' || role === 'shadow' || role === 'no_trade_counterfactual') return true;
  if (boolValue(row.isShadowArm) === true || boolValue(extras.isShadowArm) === true) return true;
  return false;
}

function isPaperOnlyPolicyRow(row: JsonRow): boolean {
  if (DEMOTED_OR_PAPER_ONLY_ARMS.has(armIdentity(row))) return true;
  return flags(row).some((flag) => flag.includes('PAPER_ONLY') || flag.includes('LIVE_DISABLED'));
}

function isExecutionEvidenceGapRow(row: JsonRow): boolean {
  if (boolValue(row.routeFound) === false || boolValue(row.sellRouteFound) === false || boolValue(row.exitRouteFound) === false) {
    return true;
  }
  return flags(row).some((flag) =>
    flag.includes('EXIT_LIQUIDITY_UNKNOWN') ||
    flag.includes('ROUTE_UNKNOWN') ||
    flag.includes('NO_ROUTE') ||
    flag.includes('ROUTE_PROOF_GAP') ||
    flag.includes('VENUE_UNKNOWN') ||
    flag.includes('TOKEN_QUALITY_UNKNOWN') ||
    flag.includes('UNCLEAN_TOKEN') ||
    flag.includes('NO_SECURITY_DATA') ||
    flag.includes('NO_SECURITY_CLIENT') ||
    flag.includes('SECURITY_UNKNOWN')
  );
}

function executionGapKinds(row: JsonRow): MissionExecutionGapKind[] {
  const rowFlags = flags(row);
  const kinds = new Set<MissionExecutionGapKind>();
  if (rowFlags.some((flag) => flag.includes('EXIT_LIQUIDITY_UNKNOWN'))) kinds.add('exit_liquidity_unknown');
  if (
    boolValue(row.routeFound) === false ||
    boolValue(row.sellRouteFound) === false ||
    boolValue(row.exitRouteFound) === false ||
    rowFlags.some((flag) =>
      flag.includes('ROUTE_UNKNOWN') ||
      flag.includes('NO_ROUTE') ||
      flag.includes('ROUTE_PROOF_GAP')
    )
  ) {
    kinds.add('route_unknown');
  }
  if (rowFlags.some((flag) =>
    flag.includes('NO_SECURITY_DATA') ||
    flag.includes('NO_SECURITY_CLIENT') ||
    flag.includes('SECURITY_UNKNOWN')
  )) {
    kinds.add('security_unknown');
  }
  if (rowFlags.some((flag) =>
    flag.includes('TOKEN_QUALITY_UNKNOWN') ||
    flag.includes('UNCLEAN_TOKEN')
  )) {
    kinds.add('token_quality_unknown');
  }
  if (rowFlags.some((flag) => flag.includes('VENUE_UNKNOWN'))) kinds.add('venue_unknown');
  if (kinds.size === 0 && isExecutionEvidenceGapRow(row)) kinds.add('other_execution_gap');
  return [...kinds];
}

function missionRowKey(row: JsonRow): string {
  const extras = row.extras && typeof row.extras === 'object' ? row.extras : {};
  const directId = str(
    row.positionId,
    extras.positionId,
    row.dbTradeId,
    extras.dbTradeId,
    row.entryTxSignature,
    row.exitTxSignature,
    row.signature,
    row.txSignature
  );
  if (directId !== 'unknown') return `${str(row.__ledger)}:${directId}`;
  return [
    str(row.__ledger),
    str(row.tokenMint, extras.tokenMint, row.mint),
    str(row.closedAt, row.exitTimeIso, row.openedAt),
    str(row.exitReason, row.closeReason),
    walletNetSol(row).toFixed(9),
  ].join(':');
}

function isRouteKnownRow(row: JsonRow): boolean {
  const extras = row.extras && typeof row.extras === 'object' ? row.extras : {};
  return boolValue(row.routeFound) === true ||
    boolValue(row.sellRouteFound) === true ||
    boolValue(row.exitRouteFound) === true ||
    boolValue(extras.routeFound) === true ||
    boolValue(extras.sellRouteFound) === true ||
    boolValue(extras.exitRouteFound) === true;
}

function isCostAwareRow(row: JsonRow): boolean {
  const raw = `${armIdentity(row)} ${str(row.parameterVersion)}`;
  return raw.includes('cost_aware') ||
    raw.includes('cost-aware') ||
    raw.includes('second_kol_wait') ||
    flags(row).includes('ROTATION_COST_AWARE_EXIT_V2');
}

function independentKolCount(row: JsonRow): number | null {
  const direct = num(row.independentKolCount, row.kolCount);
  if (direct != null) return direct;
  if (Array.isArray(row.kols)) return row.kols.length;
  const flagCount = flags(row).reduce<number | null>((max, flag) => {
    const match = flag.match(/(?:KOLS|FRESH_KOLS|UNDERFILL_KOLS)_(\d+)/);
    if (!match) return max;
    const parsed = Number(match[1]);
    return max == null ? parsed : Math.max(max, parsed);
  }, null);
  return flagCount;
}

function secondKolDelaySec(row: JsonRow): number | null {
  const direct = num(row.secondKolDelaySec);
  if (direct != null) return direct;
  if (!Array.isArray(row.kols) || row.kols.length < 2) return null;
  const times = row.kols
    .map((kol) => Date.parse(str(kol?.timestamp, kol?.time, kol?.blockTime)))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (times.length < 2) return null;
  return (times[1] - times[0]) / 1000;
}

function missionFeatureFlags(row: JsonRow): string[] {
  return flags(row)
    .filter(isConjunctiveSplitFlag)
    .filter((flag) =>
      flag.startsWith('SMART_V3_') ||
      flag.startsWith('ROTATION_')
    )
    .slice(0, 8);
}

function missionCohortLabels(row: JsonRow): string[] {
  const labels = new Set<string>();
  const lane = strategyLane(row);
  const arm = armIdentity(row);
  labels.add(`${lane}|arm:${arm}`);

  const routeKnown = isRouteKnownRow(row);
  const costAware = isCostAwareRow(row);
  const kolCount = independentKolCount(row);
  const secondDelay = secondKolDelaySec(row);

  if (lane === 'rotation') {
    labels.add('rotation|underfill_all');
    if (routeKnown) labels.add('rotation|route_known');
    if (costAware) labels.add('rotation|cost_aware');
    if ((kolCount ?? 0) >= 2) labels.add('rotation|2plus_kol');
    if (routeKnown && costAware && (kolCount ?? 0) >= 2) labels.add('rotation|route_known|2plus|cost_aware');
    if (routeKnown && costAware && (kolCount ?? 0) >= 2 && secondDelay != null && secondDelay <= 15) {
      labels.add('rotation|route_known|2plus|cost_aware|secondKOL<=15s');
    }
    if (routeKnown && costAware && (kolCount ?? 0) >= 2 && secondDelay != null && secondDelay <= 30) {
      labels.add('rotation|route_known|2plus|cost_aware|secondKOL<=30s');
    }
    if (arm.includes('second_kol_wait')) labels.add('rotation|runtime_second_kol_wait');
  }

  if (lane === 'smart_v3') {
    labels.add('smart_v3|all');
    if ((kolCount ?? 0) >= 2 || flags(row).includes('SMART_V3_FRESH_KOLS_2')) labels.add('smart_v3|fresh_2plus_kol');
    if (routeKnown) labels.add('smart_v3|route_known');
  }

  const featureFlags = missionFeatureFlags(row);
  for (const flag of featureFlags) labels.add(`${lane}|flag:${flag}`);
  for (let i = 0; i < featureFlags.length; i += 1) {
    for (let j = i + 1; j < featureFlags.length; j += 1) {
      labels.add(`${lane}|flags:${featureFlags[i]} + ${featureFlags[j]}`);
    }
  }
  return [...labels];
}

function diagnosticProxyVerdict(input: {
  proxyRows: number;
  proxyMinRows: number;
  walletNetSol: number;
  savedLossSol: number;
  missedWinnerRows: number;
  missedActual5xRows: number;
  p90MfePct: number | null;
  maxP90Mfe: number;
}): DiagnosticProxyCandidate['verdict'] {
  if (input.missedActual5xRows > 0) return 'REJECT_TAIL_KILL';
  if (input.missedWinnerRows > 0) return 'REJECT_FALSE_POSITIVES';
  if (input.proxyRows < input.proxyMinRows) return 'WAIT_PROXY_SAMPLE';
  if (input.walletNetSol >= 0 || input.savedLossSol <= 0) return 'REJECT_NO_SAVED_LOSS';
  if ((input.p90MfePct ?? 0) > input.maxP90Mfe) return 'REJECT_HIGH_MFE';
  return 'READY_FOR_FRESH_SHADOW';
}

function diagnosticProxyNextAction(verdict: DiagnosticProxyCandidate['verdict']): string {
  if (verdict === 'READY_FOR_FRESH_SHADOW') return 'track as paper-shadow diagnostic proxy; require fresh rows before live review';
  if (verdict === 'WAIT_PROXY_SAMPLE') return 'keep collecting proxy sample';
  if (verdict === 'REJECT_TAIL_KILL') return 'discard; proxy blocks actual 5x rows';
  if (verdict === 'REJECT_FALSE_POSITIVES') return 'split again; proxy blocks wallet winners';
  if (verdict === 'REJECT_HIGH_MFE') return 'do not block; proxy still has meaningful MFE';
  return 'discard unless saved-loss evidence returns';
}

function compareDiagnosticProxyCandidates(a: DiagnosticProxyCandidate, b: DiagnosticProxyCandidate): number {
  return diagnosticProxyRank(a.verdict) - diagnosticProxyRank(b.verdict) ||
    b.savedLossSol - a.savedLossSol ||
    b.targetProxyRows - a.targetProxyRows ||
    a.diagnosticLabel.localeCompare(b.diagnosticLabel) ||
    a.proxyLabel.localeCompare(b.proxyLabel);
}

function diagnosticProxyRank(verdict: DiagnosticProxyCandidate['verdict']): number {
  if (verdict === 'READY_FOR_FRESH_SHADOW') return 0;
  if (verdict === 'WAIT_PROXY_SAMPLE') return 1;
  if (verdict === 'REJECT_HIGH_MFE') return 2;
  if (verdict === 'REJECT_FALSE_POSITIVES') return 3;
  if (verdict === 'REJECT_TAIL_KILL') return 4;
  return 5;
}

function buildSmartV3AdmissionCandidates(rows: JsonRow[], args: Args): SmartV3AdmissionCandidate[] {
  const targetRows = rows.filter((row) => isSmartV3LoserAdmissionTarget(row, args.maxP90Mfe));
  const proxyMinRows = Math.max(2, Math.ceil(args.minRows / 2));
  if (targetRows.length === 0) return [];
  const targetLabels = new Set(diagnosticProxyLabels(targetRows));
  const buckets = new Map<string, { proxyRows: JsonRow[]; targetProxyRows: JsonRow[] }>();
  for (const row of rows.filter((item) => isLane(item, 'smart_v3'))) {
    const isTargetRow = isSmartV3LoserAdmissionTarget(row, args.maxP90Mfe);
    for (const label of diagnosticProxyLabelsForFlags(flags(row).filter(isDiagnosticProxyFlag).sort())) {
      if (!targetLabels.has(label)) continue;
      const bucket = buckets.get(label) ?? { proxyRows: [], targetProxyRows: [] };
      bucket.proxyRows.push(row);
      if (isTargetRow) bucket.targetProxyRows.push(row);
      buckets.set(label, bucket);
    }
  }
  return [...buckets.entries()]
    .flatMap(([proxyLabel, bucket]) => {
      if (bucket.targetProxyRows.length < proxyMinRows) return [];
      return [buildSmartV3AdmissionCandidate(proxyLabel, targetRows, bucket.proxyRows, bucket.targetProxyRows, proxyMinRows, args.maxP90Mfe)];
    })
    .sort(compareSmartV3AdmissionCandidates)
    .slice(0, 25)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function isSmartV3LoserAdmissionTarget(row: JsonRow, lowMfeThreshold: number): boolean {
  const exitReason = str(row.exitReason, row.closeReason);
  if (!isLane(row, 'smart_v3') || walletNetSol(row) >= 0) return false;
  if (exitReason === 'smart_v3_mae_fast_fail') return true;
  return exitReason === 'probe_hard_cut' && mfePct(row) <= lowMfeThreshold;
}

function buildSmartV3AdmissionCandidate(
  proxyLabel: string,
  targetRows: JsonRow[],
  proxyRows: JsonRow[],
  targetProxyRows: JsonRow[],
  proxyMinRows: number,
  maxP90Mfe: number
): SmartV3AdmissionCandidate {
  const walletNetSolValue = round(proxyRows.reduce((sum, row) => sum + walletNetSol(row), 0));
  const savedLossSol = round(proxyRows
    .filter((row) => walletNetSol(row) < 0)
    .reduce((sum, row) => sum - walletNetSol(row), 0));
  const missedWinnerRows = proxyRows.filter((row) => walletNetSol(row) > 0).length;
  const missedWinnerSol = round(proxyRows
    .filter((row) => walletNetSol(row) > 0)
    .reduce((sum, row) => sum + walletNetSol(row), 0));
  const missedT2Rows = proxyRows.filter((row) => mfePct(row) >= 1).length;
  const missedActual5xRows = proxyRows.filter((row) => mfePct(row) >= 4).length;
  const p90MfePct = percentile(proxyRows.map(mfePct), 0.9);
  const verdict = smartV3AdmissionVerdict({
    proxyRows: proxyRows.length,
    proxyMinRows,
    walletNetSol: walletNetSolValue,
    savedLossSol,
    missedWinnerRows,
    missedT2Rows,
    missedActual5xRows,
    p90MfePct,
    maxP90Mfe,
  });
  return {
    rank: 0,
    proxyLabel,
    targetRows: targetRows.length,
    proxyRows: proxyRows.length,
    targetProxyRows: targetProxyRows.length,
    targetCoveragePct: round(targetProxyRows.length / Math.max(1, targetRows.length)),
    walletNetSol: walletNetSolValue,
    savedLossSol,
    missedWinnerRows,
    missedWinnerSol,
    missedT2Rows,
    missedActual5xRows,
    p90MfePct,
    verdict,
    nextAction: smartV3AdmissionNextAction(verdict),
  };
}

function smartV3AdmissionVerdict(input: {
  proxyRows: number;
  proxyMinRows: number;
  walletNetSol: number;
  savedLossSol: number;
  missedWinnerRows: number;
  missedT2Rows: number;
  missedActual5xRows: number;
  p90MfePct: number | null;
  maxP90Mfe: number;
}): SmartV3AdmissionCandidate['verdict'] {
  if (input.missedActual5xRows > 0 || input.missedT2Rows > 0) return 'REJECT_TAIL_KILL';
  if (input.missedWinnerRows > 0) return 'REJECT_FALSE_POSITIVES';
  if (input.proxyRows < input.proxyMinRows) return 'WAIT_PROXY_SAMPLE';
  if (input.walletNetSol >= 0 || input.savedLossSol <= 0) return 'REJECT_NO_SAVED_LOSS';
  if ((input.p90MfePct ?? 0) > input.maxP90Mfe) return 'REJECT_HIGH_MFE';
  return 'READY_FOR_FRESH_SHADOW';
}

function smartV3AdmissionNextAction(verdict: SmartV3AdmissionCandidate['verdict']): string {
  if (verdict === 'READY_FOR_FRESH_SHADOW') return 'track as smart-v3 paper-only no-trade shadow; require fresh rows before live review';
  if (verdict === 'WAIT_PROXY_SAMPLE') return 'keep collecting smart-v3 loser proxy sample';
  if (verdict === 'REJECT_TAIL_KILL') return 'discard; proxy blocks T2 or actual 5x rows';
  if (verdict === 'REJECT_FALSE_POSITIVES') return 'split again; proxy blocks wallet winners';
  if (verdict === 'REJECT_HIGH_MFE') return 'do not block; smart-v3 proxy still has meaningful MFE';
  return 'discard unless saved-loss evidence returns';
}

function compareSmartV3AdmissionCandidates(a: SmartV3AdmissionCandidate, b: SmartV3AdmissionCandidate): number {
  return smartV3AdmissionRank(a.verdict) - smartV3AdmissionRank(b.verdict) ||
    b.savedLossSol - a.savedLossSol ||
    b.targetProxyRows - a.targetProxyRows ||
    a.proxyLabel.localeCompare(b.proxyLabel);
}

function smartV3AdmissionRank(verdict: SmartV3AdmissionCandidate['verdict']): number {
  if (verdict === 'READY_FOR_FRESH_SHADOW') return 0;
  if (verdict === 'WAIT_PROXY_SAMPLE') return 1;
  if (verdict === 'REJECT_HIGH_MFE') return 2;
  if (verdict === 'REJECT_FALSE_POSITIVES') return 3;
  if (verdict === 'REJECT_TAIL_KILL') return 4;
  return 5;
}

function buildPaperShadowDecisionLedger(input: {
  blockCounters: PaperShadowBlockCounter[];
  splitReadiness: FreshSplitReadiness[];
  diagnosticProxies: DiagnosticProxyCandidate[];
  smartV3Candidates: SmartV3AdmissionCandidate[];
}): PaperShadowDecisionLedgerItem[] {
  const rows: PaperShadowDecisionLedgerItem[] = [
    ...input.blockCounters.map((item) => paperShadowLedgerFromBlockCounter(item)),
    ...input.splitReadiness.map((item) => paperShadowLedgerFromSplitReadiness(item)),
    ...input.diagnosticProxies.map((item) => paperShadowLedgerFromDiagnosticProxy(item)),
    ...input.smartV3Candidates.map((item) => paperShadowLedgerFromSmartV3Admission(item)),
  ];
  return rows
    .sort((a, b) =>
      paperShadowStateRank(a.state) - paperShadowStateRank(b.state) ||
      b.netImpactSol - a.netImpactSol ||
      b.savedLossSol - a.savedLossSol ||
      a.label.localeCompare(b.label)
    )
    .slice(0, 75)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function paperShadowLedgerFromBlockCounter(item: PaperShadowBlockCounter): PaperShadowDecisionLedgerItem {
  return {
    rank: 0,
    kind: 'pre_entry_proxy',
    label: item.label,
    lane: item.lane,
    rows: item.shadowBlockedRows,
    walletNetSol: item.blockedWalletNetSol,
    savedLossSol: item.savedLossSol,
    missedWinnerRows: item.missedWinnerRows,
    missedWinnerSol: item.missedWinnerSol,
    missedT2Rows: 0,
    missedActual5xRows: item.missedActual5xRows,
    netImpactSol: round(item.savedLossSol - item.missedWinnerSol),
    state: paperShadowStateFromBlockVerdict(item.verdict),
    sourceVerdict: item.verdict,
    nextAction: item.nextAction,
  };
}

function paperShadowLedgerFromSplitReadiness(item: FreshSplitReadiness): PaperShadowDecisionLedgerItem {
  return {
    rank: 0,
    kind: 'conjunctive_split',
    label: item.label,
    lane: item.lane,
    rows: item.bestWindowRows,
    walletNetSol: item.walletNetSol,
    savedLossSol: item.savedLossSol,
    missedWinnerRows: item.missedWinnerRows,
    missedWinnerSol: 0,
    missedT2Rows: 0,
    missedActual5xRows: item.missedActual5xRows,
    netImpactSol: item.savedLossSol,
    state: paperShadowStateFromFreshVerdict(item.verdict),
    sourceVerdict: item.verdict,
    nextAction: item.nextAction,
  };
}

function paperShadowLedgerFromDiagnosticProxy(item: DiagnosticProxyCandidate): PaperShadowDecisionLedgerItem {
  return {
    rank: 0,
    kind: 'diagnostic_proxy',
    label: `${item.diagnosticBucketType}:${item.diagnosticLabel} -> ${item.proxyLabel}`,
    lane: item.lane,
    rows: item.proxyRows,
    walletNetSol: item.walletNetSol,
    savedLossSol: item.savedLossSol,
    missedWinnerRows: item.missedWinnerRows,
    missedWinnerSol: item.missedWinnerSol,
    missedT2Rows: 0,
    missedActual5xRows: item.missedActual5xRows,
    netImpactSol: round(item.savedLossSol - item.missedWinnerSol),
    state: paperShadowStateFromProxyVerdict(item.verdict),
    sourceVerdict: item.verdict,
    nextAction: item.nextAction,
  };
}

function paperShadowLedgerFromSmartV3Admission(item: SmartV3AdmissionCandidate): PaperShadowDecisionLedgerItem {
  return {
    rank: 0,
    kind: 'smart_v3_admission',
    label: item.proxyLabel,
    lane: 'smart_v3',
    rows: item.proxyRows,
    walletNetSol: item.walletNetSol,
    savedLossSol: item.savedLossSol,
    missedWinnerRows: item.missedWinnerRows,
    missedWinnerSol: item.missedWinnerSol,
    missedT2Rows: item.missedT2Rows,
    missedActual5xRows: item.missedActual5xRows,
    netImpactSol: round(item.savedLossSol - item.missedWinnerSol),
    state: paperShadowStateFromProxyVerdict(item.verdict),
    sourceVerdict: item.verdict,
    nextAction: item.nextAction,
  };
}

function paperShadowStateFromBlockVerdict(verdict: PaperShadowBlockCounter['verdict']): PaperShadowDecisionLedgerItem['state'] {
  if (verdict === 'PASS_FRESH_SHADOW_REVIEW') return 'READY_FOR_REVIEW';
  if (verdict === 'WAIT_FRESH_ROWS') return 'WAIT_FRESH';
  return 'REJECT';
}

function paperShadowStateFromFreshVerdict(verdict: FreshSplitReadiness['verdict']): PaperShadowDecisionLedgerItem['state'] {
  if (verdict === 'READY') return 'READY_FOR_REVIEW';
  if (verdict === 'WAIT_FRESH_ROWS' || verdict === 'STALE_NO_24H_ROWS') return 'WAIT_FRESH';
  return 'REJECT';
}

function paperShadowStateFromProxyVerdict(
  verdict: DiagnosticProxyCandidate['verdict'] | SmartV3AdmissionCandidate['verdict']
): PaperShadowDecisionLedgerItem['state'] {
  if (verdict === 'READY_FOR_FRESH_SHADOW') return 'PAPER_SHADOW_ONLY';
  if (verdict === 'WAIT_PROXY_SAMPLE') return 'WAIT_FRESH';
  return 'REJECT';
}

function paperShadowStateRank(state: PaperShadowDecisionLedgerItem['state']): number {
  if (state === 'READY_FOR_REVIEW') return 0;
  if (state === 'PAPER_SHADOW_ONLY') return 1;
  if (state === 'WAIT_FRESH') return 2;
  return 3;
}

function buildPromotionPackets(ledger: PaperShadowDecisionLedgerItem[]): PromotionPacketItem[] {
  return ledger
    .map((item) => buildPromotionPacket(item))
    .sort((a, b) =>
      promotionVerdictRank(a.verdict) - promotionVerdictRank(b.verdict) ||
      b.netImpactSol - a.netImpactSol ||
      a.label.localeCompare(b.label)
    )
    .slice(0, 25)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function buildPromotionPacket(item: PaperShadowDecisionLedgerItem): PromotionPacketItem {
  const blockers = promotionBlockers(item);
  return {
    rank: 0,
    kind: item.kind,
    label: item.label,
    lane: item.lane,
    verdict: promotionVerdict(item, blockers),
    rows: item.rows,
    netImpactSol: item.netImpactSol,
    savedLossSol: item.savedLossSol,
    missedWinnerRows: item.missedWinnerRows,
    missedT2Rows: item.missedT2Rows,
    missedActual5xRows: item.missedActual5xRows,
    blockers,
    liveReviewGate: 'fresh>=30; walletNet<0; netImpact>0; missedWinner=0; missedT2=0; missed5x=0',
    nextAction: promotionNextAction(item, blockers),
  };
}

function promotionBlockers(item: PaperShadowDecisionLedgerItem): string[] {
  const blockers: string[] = [];
  if (item.state === 'PAPER_SHADOW_ONLY') blockers.push('fresh validation required');
  if (item.state === 'WAIT_FRESH') blockers.push('fresh rows required');
  if (item.state === 'REJECT') blockers.push(`source rejected: ${item.sourceVerdict}`);
  if (item.netImpactSol <= 0) blockers.push('net impact <= 0');
  if (item.missedWinnerRows > 0) blockers.push('missed wallet winners');
  if (item.missedT2Rows > 0) blockers.push('missed T2 rows');
  if (item.missedActual5xRows > 0) blockers.push('missed actual 5x rows');
  return blockers;
}

function promotionVerdict(
  item: PaperShadowDecisionLedgerItem,
  blockers: string[]
): PromotionPacketItem['verdict'] {
  if (item.state === 'READY_FOR_REVIEW' && blockers.length === 0) return 'READY_FOR_LIVE_REVIEW';
  if (item.state === 'PAPER_SHADOW_ONLY') return 'PAPER_SHADOW_ONLY';
  if (item.state === 'WAIT_FRESH') return 'WAIT_FRESH_ROWS';
  return 'REJECTED';
}

function promotionNextAction(item: PaperShadowDecisionLedgerItem, blockers: string[]): string {
  const verdict = promotionVerdict(item, blockers);
  if (verdict === 'READY_FOR_LIVE_REVIEW') return 'manual live review packet is ready';
  if (verdict === 'PAPER_SHADOW_ONLY') return 'keep report-only paper shadow and collect fresh validation rows';
  if (verdict === 'WAIT_FRESH_ROWS') return 'do not promote; wait for fresh/current-session rows';
  return 'do not promote';
}

function promotionVerdictRank(verdict: PromotionPacketItem['verdict']): number {
  if (verdict === 'READY_FOR_LIVE_REVIEW') return 0;
  if (verdict === 'PAPER_SHADOW_ONLY') return 1;
  if (verdict === 'WAIT_FRESH_ROWS') return 2;
  return 3;
}

function buildPromotionWatchlist(packets: PromotionPacketItem[]): PromotionWatchlist {
  const ready = packets.filter((item) => item.verdict === 'READY_FOR_LIVE_REVIEW');
  const paperShadow = packets.filter((item) => item.verdict === 'PAPER_SHADOW_ONLY');
  const waitFresh = packets.filter((item) => item.verdict === 'WAIT_FRESH_ROWS');
  const rejected = packets.filter((item) => item.verdict === 'REJECTED');
  return {
    readyForLiveReview: ready.length,
    paperShadowOnly: paperShadow.length,
    waitFreshRows: waitFresh.length,
    rejected: rejected.length,
    primaryAction: promotionWatchlistPrimaryAction({ ready, paperShadow, waitFresh }),
    rows: [
      ...ready.slice(0, 5),
      ...paperShadow.slice(0, 5),
      ...waitFresh.slice(0, 5),
      ...rejected.slice(0, 5),
    ].map((item, index) => ({
      rank: index + 1,
      queue: promotionWatchlistQueue(item.verdict),
      kind: item.kind,
      label: item.label,
      lane: item.lane,
      verdict: item.verdict,
      rows: item.rows,
      netImpactSol: item.netImpactSol,
      savedLossSol: item.savedLossSol,
      blockers: item.blockers,
      nextAction: item.nextAction,
    })),
  };
}

function promotionWatchlistPrimaryAction(input: {
  ready: PromotionPacketItem[];
  paperShadow: PromotionPacketItem[];
  waitFresh: PromotionPacketItem[];
}): string {
  if (input.ready.length > 0) return 'manual review required before any live change';
  if (input.paperShadow.length > 0) return 'keep paper-shadow only; collect fresh validation rows';
  if (input.waitFresh.length > 0) return 'no live change; wait for fresh/current-session rows';
  return 'no promotable watchlist candidates';
}

function promotionWatchlistQueue(verdict: PromotionPacketItem['verdict']): PromotionWatchlistItem['queue'] {
  if (verdict === 'READY_FOR_LIVE_REVIEW') return 'live_review';
  if (verdict === 'PAPER_SHADOW_ONLY') return 'paper_shadow';
  if (verdict === 'WAIT_FRESH_ROWS') return 'wait_fresh';
  return 'rejected';
}

function buildPaperShadowFreshCounters(
  packets: PromotionPacketItem[],
  rows: JsonRow[],
  args: Args
): PaperShadowFreshCounter[] {
  const requiredRows = Math.max(30, args.minRows);
  const nowMs = args.nowMs ?? Date.now();
  const activePackets = packets.filter((packet) => packet.verdict !== 'REJECTED');
  return args.freshWindowSpecs.flatMap((window) => {
    const sinceMs = freshWindowStart(window, nowMs);
    const freshRows = rows.filter((row) => timeMs(row) >= sinceMs);
    return activePackets.map((packet) => {
      const matchedRows = freshRows.filter((row) => matchesPromotionPacket(row, packet));
      return buildPaperShadowFreshCounter(window, sinceMs, packet, matchedRows, requiredRows);
    });
  }).sort((a, b) =>
    paperShadowFreshVerdictRank(a.verdict) - paperShadowFreshVerdictRank(b.verdict) ||
    b.rows - a.rows ||
    a.label.localeCompare(b.label)
  );
}

function matchesPromotionPacket(row: JsonRow, packet: PromotionPacketItem): boolean {
  if (packet.lane !== 'mixed' && strategyLane(row) !== packet.lane) return false;
  const requiredFlags = promotionPacketRequiredFlags(packet);
  if (requiredFlags.length === 0) return false;
  const rowFlags = flags(row);
  return requiredFlags.every((flag) => rowFlags.includes(flag));
}

function promotionPacketRequiredFlags(packet: PromotionPacketItem): string[] {
  const proxyLabel = packet.kind === 'diagnostic_proxy'
    ? packet.label.split(' -> ').at(-1) ?? packet.label
    : packet.label;
  return proxyLabel.split(' + ').map((item) => item.trim()).filter(Boolean);
}

function buildPaperShadowFreshCounter(
  window: string,
  sinceMs: number,
  packet: PromotionPacketItem,
  rows: JsonRow[],
  requiredRows: number
): PaperShadowFreshCounter {
  const walletNetSolValue = round(rows.reduce((sum, row) => sum + walletNetSol(row), 0));
  const savedLossSol = round(rows
    .filter((row) => walletNetSol(row) < 0)
    .reduce((sum, row) => sum - walletNetSol(row), 0));
  const missedWinnerRows = rows.filter((row) => walletNetSol(row) > 0).length;
  const missedWinnerSol = round(rows
    .filter((row) => walletNetSol(row) > 0)
    .reduce((sum, row) => sum + walletNetSol(row), 0));
  const missedT2Rows = rows.filter((row) => mfePct(row) >= 1).length;
  const missedActual5xRows = rows.filter((row) => mfePct(row) >= 4).length;
  const netImpactSol = round(savedLossSol - missedWinnerSol);
  const verdict = paperShadowFreshVerdict({
    rows: rows.length,
    requiredRows,
    netImpactSol,
    missedWinnerRows,
    missedT2Rows,
    missedActual5xRows,
  });
  return {
    window,
    since: new Date(sinceMs).toISOString(),
    kind: packet.kind,
    label: packet.label,
    lane: packet.lane,
    rows: rows.length,
    requiredRows,
    rowsRemaining: Math.max(0, requiredRows - rows.length),
    walletNetSol: walletNetSolValue,
    savedLossSol,
    missedWinnerRows,
    missedWinnerSol,
    missedT2Rows,
    missedActual5xRows,
    netImpactSol,
    verdict,
    nextAction: paperShadowFreshNextAction(verdict),
  };
}

function paperShadowFreshVerdict(input: {
  rows: number;
  requiredRows: number;
  netImpactSol: number;
  missedWinnerRows: number;
  missedT2Rows: number;
  missedActual5xRows: number;
}): PaperShadowFreshCounter['verdict'] {
  if (input.missedActual5xRows > 0 || input.missedT2Rows > 0) return 'REJECT_TAIL_KILL';
  if (input.missedWinnerRows > 0) return 'REJECT_FALSE_POSITIVES';
  if (input.rows < input.requiredRows) return 'WAIT_FRESH_ROWS';
  if (input.netImpactSol <= 0) return 'REJECT_NO_SAVED_LOSS';
  return 'READY_FRESH_REVIEW';
}

function paperShadowFreshNextAction(verdict: PaperShadowFreshCounter['verdict']): string {
  if (verdict === 'READY_FRESH_REVIEW') return 'eligible for manual live-review packet';
  if (verdict === 'WAIT_FRESH_ROWS') return 'keep paper-shadow only; collect fresh rows';
  if (verdict === 'REJECT_FALSE_POSITIVES') return 'discard or split; fresh rows block wallet winners';
  if (verdict === 'REJECT_TAIL_KILL') return 'discard; fresh rows block T2 or actual 5x';
  return 'discard unless fresh saved-loss evidence returns';
}

function paperShadowFreshVerdictRank(verdict: PaperShadowFreshCounter['verdict']): number {
  if (verdict === 'READY_FRESH_REVIEW') return 0;
  if (verdict === 'WAIT_FRESH_ROWS') return 1;
  return 2;
}

function buildPaperShadowFreshReadiness(counters: PaperShadowFreshCounter[]): PaperShadowFreshReadiness[] {
  const byCandidate = new Map<string, PaperShadowFreshCounter[]>();
  for (const counter of counters) {
    const key = `${counter.kind}|${counter.lane}|${counter.label}`;
    byCandidate.set(key, [...(byCandidate.get(key) ?? []), counter]);
  }
  return [...byCandidate.values()]
    .map(buildPaperShadowFreshReadinessItem)
    .sort((a, b) =>
      paperShadowFreshReadinessRank(a.verdict) - paperShadowFreshReadinessRank(b.verdict) ||
      b.rows - a.rows ||
      b.netImpactSol - a.netImpactSol ||
      a.label.localeCompare(b.label)
    );
}

function buildPaperShadowFreshReadinessItem(counters: PaperShadowFreshCounter[]): PaperShadowFreshReadiness {
  const best = counters.reduce<PaperShadowFreshCounter | null>((current, counter) => {
    if (!current) return counter;
    if (counter.rows > current.rows) return counter;
    if (counter.rows === current.rows && freshWindowRank(counter.window) < freshWindowRank(current.window)) return counter;
    return current;
  }, null);
  const window24h = counters.find((counter) => counter.window === '24h');
  const verdict = paperShadowFreshReadinessVerdict(counters, best, window24h);
  return {
    kind: best?.kind ?? 'pre_entry_proxy',
    label: best?.label ?? 'unknown',
    lane: best?.lane ?? 'unknown',
    bestWindow: best?.window ?? null,
    rows: best?.rows ?? 0,
    requiredRows: best?.requiredRows ?? 0,
    rowsRemaining: best?.rowsRemaining ?? 0,
    netImpactSol: best?.netImpactSol ?? 0,
    savedLossSol: best?.savedLossSol ?? 0,
    missedWinnerRows: best?.missedWinnerRows ?? 0,
    missedT2Rows: best?.missedT2Rows ?? 0,
    missedActual5xRows: best?.missedActual5xRows ?? 0,
    verdict,
    nextAction: paperShadowFreshReadinessNextAction(verdict),
  };
}

function freshWindowRank(window: string): number {
  if (window === '24h') return 0;
  if (window === '3d') return 1;
  if (window === '7d') return 2;
  return 3;
}

function paperShadowFreshReadinessVerdict(
  counters: PaperShadowFreshCounter[],
  best: PaperShadowFreshCounter | null,
  window24h?: PaperShadowFreshCounter
): PaperShadowFreshReadiness['verdict'] {
  if (counters.some((counter) => counter.verdict === 'REJECT_TAIL_KILL')) return 'REJECT_TAIL_KILL';
  if (counters.some((counter) => counter.verdict === 'REJECT_FALSE_POSITIVES')) return 'REJECT_FALSE_POSITIVES';
  if (counters.some((counter) => counter.verdict === 'REJECT_NO_SAVED_LOSS')) return 'REJECT_NO_SAVED_LOSS';
  if (counters.some((counter) => counter.verdict === 'READY_FRESH_REVIEW')) return 'READY_FRESH_REVIEW';
  if ((window24h?.rows ?? 0) === 0 && (best?.rows ?? 0) > 0) return 'STALE_NO_24H_ROWS';
  return 'WAIT_FRESH_ROWS';
}

function paperShadowFreshReadinessNextAction(verdict: PaperShadowFreshReadiness['verdict']): string {
  if (verdict === 'READY_FRESH_REVIEW') return 'prepare manual live-review packet';
  if (verdict === 'STALE_NO_24H_ROWS') return 'do not promote; wait for current-session rows';
  if (verdict === 'WAIT_FRESH_ROWS') return 'keep paper-shadow only; collect fresh rows';
  if (verdict === 'REJECT_FALSE_POSITIVES') return 'discard or split; fresh rows block wallet winners';
  if (verdict === 'REJECT_TAIL_KILL') return 'discard; fresh rows block T2 or actual 5x';
  return 'discard unless fresh saved-loss evidence returns';
}

function paperShadowFreshReadinessRank(verdict: PaperShadowFreshReadiness['verdict']): number {
  if (verdict === 'READY_FRESH_REVIEW') return 0;
  if (verdict === 'WAIT_FRESH_ROWS') return 1;
  if (verdict === 'STALE_NO_24H_ROWS') return 2;
  return 3;
}

function buildFreshSplitValidations(
  splits: ConjunctiveProxySplit[],
  rows: JsonRow[],
  args: Args
): FreshSplitValidation[] {
  const requiredFreshRows = Math.max(30, args.minRows);
  const nowMs = args.nowMs ?? Date.now();
  return args.freshWindowSpecs.flatMap((window) => {
    const sinceMs = freshWindowStart(window, nowMs);
    const freshRows = rows.filter((row) => timeMs(row) >= sinceMs);
    return splits.map((split) => {
      const splitRows = freshRows.filter((row) => {
        const rowFlags = flags(row);
        return rowFlags.includes(split.parentLabel) && rowFlags.includes(split.conjunctiveLabel);
      });
      return buildFreshSplitValidation(window, sinceMs, split, splitRows, requiredFreshRows);
    });
  });
}

function buildFreshSplitValidation(
  window: string,
  sinceMs: number,
  split: ConjunctiveProxySplit,
  rows: JsonRow[],
  requiredFreshRows: number
): FreshSplitValidation {
  const walletNetSolValue = round(rows.reduce((sum, row) => sum + walletNetSol(row), 0));
  const savedLossSol = round(rows
    .filter((row) => walletNetSol(row) < 0)
    .reduce((sum, row) => sum - walletNetSol(row), 0));
  const missedWinnerRows = rows.filter((row) => walletNetSol(row) > 0).length;
  const missedWinnerSol = round(rows
    .filter((row) => walletNetSol(row) > 0)
    .reduce((sum, row) => sum + walletNetSol(row), 0));
  const missedActual5xRows = rows.filter((row) => mfePct(row) >= 4).length;
  const shadowNetImpactSol = round(-walletNetSolValue);
  const verdict = freshSplitVerdict({
    rows: rows.length,
    requiredFreshRows,
    missedWinnerRows,
    missedActual5xRows,
    shadowNetImpactSol,
  });
  return {
    window,
    since: new Date(sinceMs).toISOString(),
    label: split.label,
    lane: split.lane,
    rows: rows.length,
    walletNetSol: walletNetSolValue,
    savedLossSol,
    missedWinnerRows,
    missedWinnerSol,
    missedActual5xRows,
    p90MfePct: percentile(rows.map(mfePct), 0.9),
    verdict,
    nextAction: freshSplitNextAction(verdict),
  };
}

function freshSplitVerdict(input: {
  rows: number;
  requiredFreshRows: number;
  missedWinnerRows: number;
  missedActual5xRows: number;
  shadowNetImpactSol: number;
}): FreshSplitValidation['verdict'] {
  if (input.missedWinnerRows > 0 || input.missedActual5xRows > 0) return 'REJECT_FALSE_POSITIVES';
  if (input.rows < input.requiredFreshRows) return 'WAIT_FRESH_ROWS';
  if (input.shadowNetImpactSol <= 0) return 'REJECT_NO_SAVED_LOSS';
  return 'READY';
}

function freshSplitNextAction(verdict: FreshSplitValidation['verdict']): string {
  if (verdict === 'READY') return 'eligible for paper-only admission block review';
  if (verdict === 'WAIT_FRESH_ROWS') return 'keep collecting fresh split rows';
  if (verdict === 'REJECT_FALSE_POSITIVES') return 'reject or split again before any block';
  return 'discard unless narrower fresh-positive split is found';
}

function buildFreshSplitReadiness(
  validations: FreshSplitValidation[],
  args: Args
): FreshSplitReadiness[] {
  const requiredRows = Math.max(30, args.minRows);
  const byLabel = new Map<string, FreshSplitValidation[]>();
  for (const validation of validations) {
    byLabel.set(validation.label, [...(byLabel.get(validation.label) ?? []), validation]);
  }
  return [...byLabel.values()]
    .map((rows) => buildFreshSplitReadinessItem(rows, requiredRows))
    .sort((a, b) =>
      readinessRank(a.verdict) - readinessRank(b.verdict) ||
      b.bestWindowRows - a.bestWindowRows ||
      a.label.localeCompare(b.label)
    );
}

function buildFreshSplitReadinessItem(
  rows: FreshSplitValidation[],
  requiredRows: number
): FreshSplitReadiness {
  const best = rows.reduce<FreshSplitValidation | null>((current, row) => {
    if (!current || row.rows > current.rows) return row;
    return current;
  }, null);
  const rejects = rows.find((row) => row.verdict === 'REJECT_FALSE_POSITIVES' || row.verdict === 'REJECT_NO_SAVED_LOSS');
  const ready = rows.find((row) => row.verdict === 'READY');
  const window24h = rows.find((row) => row.window === '24h');
  const verdict = readinessVerdict({ rejects, ready, best, window24h });
  return {
    label: best?.label ?? 'unknown',
    lane: best?.lane ?? 'unknown',
    requiredRows,
    bestWindow: best?.window ?? null,
    bestWindowRows: best?.rows ?? 0,
    rowsRemaining: Math.max(0, requiredRows - (best?.rows ?? 0)),
    walletNetSol: best?.walletNetSol ?? 0,
    savedLossSol: best?.savedLossSol ?? 0,
    missedWinnerRows: best?.missedWinnerRows ?? 0,
    missedActual5xRows: best?.missedActual5xRows ?? 0,
    verdict,
    nextAction: readinessNextAction(verdict),
  };
}

function readinessVerdict(input: {
  rejects?: FreshSplitValidation;
  ready?: FreshSplitValidation;
  best: FreshSplitValidation | null;
  window24h?: FreshSplitValidation;
}): FreshSplitReadiness['verdict'] {
  if (input.rejects?.verdict === 'REJECT_FALSE_POSITIVES') return 'REJECT_FALSE_POSITIVES';
  if (input.rejects?.verdict === 'REJECT_NO_SAVED_LOSS') return 'REJECT_NO_SAVED_LOSS';
  if (input.ready) return 'READY';
  if ((input.window24h?.rows ?? 0) === 0 && (input.best?.rows ?? 0) > 0) return 'STALE_NO_24H_ROWS';
  return 'WAIT_FRESH_ROWS';
}

function readinessRank(verdict: FreshSplitReadiness['verdict']): number {
  if (verdict === 'READY') return 0;
  if (verdict === 'WAIT_FRESH_ROWS') return 1;
  if (verdict === 'STALE_NO_24H_ROWS') return 2;
  return 3;
}

function readinessNextAction(verdict: FreshSplitReadiness['verdict']): string {
  if (verdict === 'READY') return 'review paper-only admission block';
  if (verdict === 'WAIT_FRESH_ROWS') return 'continue collecting fresh rows';
  if (verdict === 'STALE_NO_24H_ROWS') return 'do not promote; wait for current-session rows';
  if (verdict === 'REJECT_FALSE_POSITIVES') return 'reject or split again';
  return 'discard unless fresh saved-loss evidence returns';
}

function counterfactuals(rows: JsonRow[]): BucketStats[] {
  const specs: Array<{ label: string; predicate: (row: JsonRow) => boolean }> = [
    {
      label: 'counterfactual:zero_mfe_wallet_loss',
      predicate: (row) => mfePct(row) === 0 && walletNetSol(row) < 0,
    },
    {
      label: 'counterfactual:rotation_dead_on_arrival',
      predicate: (row) => str(row.exitReason, row.closeReason) === 'rotation_dead_on_arrival',
    },
    {
      label: 'counterfactual:rotation_entry_advantage_emergency_exit',
      predicate: (row) => str(row.exitReason, row.closeReason) === 'entry_advantage_emergency_exit',
    },
    {
      label: 'counterfactual:rotation_mae_fast_fail',
      predicate: (row) => str(row.exitReason, row.closeReason) === 'rotation_mae_fast_fail',
    },
    {
      label: 'counterfactual:smart_v3_mae_fast_fail',
      predicate: (row) => str(row.exitReason, row.closeReason) === 'smart_v3_mae_fast_fail',
    },
    {
      label: 'counterfactual:smart_v3_low_mfe_probe_hard_cut',
      predicate: (row) =>
        isLane(row, 'smart_v3') &&
        str(row.exitReason, row.closeReason) === 'probe_hard_cut' &&
        mfePct(row) <= 0.03,
    },
  ];
  return specs
    .map((spec) => withAction(summarize('counterfactual', spec.label, rows.filter(spec.predicate))))
    .filter((bucket) => bucket.rows > 0)
    .sort((a, b) => b.avoidableWalletLossSol - a.avoidableWalletLossSol);
}

function buildMissionCompoundingBoard(rows: JsonRow[], args: Args): MissionCompoundingBoard {
  const requiredRows = Math.max(30, args.minRows);
  const minTrackingRows = Math.max(2, Math.ceil(requiredRows / 2));
  const minWalletWinRate = 0.55;
  const maxLossStreak = 5;
  const maxWalletDragRate = 0.25;
  const grouped = new Map<string, JsonRow[]>();
  for (const row of rows) {
    for (const label of missionCohortLabels(row)) {
      grouped.set(label, [...(grouped.get(label) ?? []), row]);
    }
  }
  const trackedCandidates = [...grouped.entries()]
    .map(([label, scoped]) =>
      buildMissionCompoundingCohort(label, scoped, {
        requiredRows,
        minWalletWinRate,
        maxLossStreak,
        maxWalletDragRate,
      })
    )
    .filter((candidate) =>
      candidate.comparableRows >= minTrackingRows ||
      candidate.researchRows >= minTrackingRows
    )
    .sort(compareMissionCompoundingCohorts);
  const candidates = trackedCandidates
    .slice(0, 30)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const verdict = missionCompoundingBoardVerdict(trackedCandidates);
  return {
    verdict,
    requiredRows,
    minTrackingRows,
    minWalletWinRate,
    maxLossStreak,
    maxWalletDragRate,
    primaryAction: missionCompoundingBoardAction(verdict),
    blockerSummary: buildMissionCompoundingBlockerSummary(trackedCandidates),
    executionGapSummary: buildMissionExecutionGapSummary(trackedCandidates, grouped),
    candidates,
  };
}

function buildMissionCompoundingCohort(
  label: string,
  rows: JsonRow[],
  criteria: {
    requiredRows: number;
    minWalletWinRate: number;
    maxLossStreak: number;
    maxWalletDragRate: number;
  }
): MissionCompoundingCohort {
  const researchRows = rows.filter(isResearchOnlyRow);
  const comparableRows = rows.filter((row) => !isResearchOnlyRow(row));
  const liveRows = comparableRows.filter((row) => row.__mode === 'live');
  const paperRows = comparableRows.filter((row) => row.__mode === 'paper');
  const paperOnlyPolicyRows = comparableRows.filter(isPaperOnlyPolicyRow).length;
  const executionGapRows = comparableRows.filter(isExecutionEvidenceGapRow).length;
  const executionGapBreakdown = buildExecutionGapBreakdown(comparableRows);
  const walletWins = comparableRows.filter((row) => walletNetSol(row) > 0).length;
  const walletLosses = comparableRows.filter((row) => walletNetSol(row) <= 0).length;
  const walletNetSolValue = round(comparableRows.reduce((sum, row) => sum + walletNetSol(row), 0));
  const tokenOnlyWinnerWalletLoserRows = comparableRows.filter((row) =>
    tokenNetSol(row) > 0 && walletNetSol(row) <= 0
  ).length;
  const sortedRows = [...comparableRows].sort((a, b) => timeMs(a) - timeMs(b));
  const maxLossStreak = maxConsecutiveLosses(sortedRows);
  const blockers = missionCompoundingBlockers({
    rows,
    comparableRows,
    walletWins,
    walletNetSol: walletNetSolValue,
    walletWinRate: ratio(walletWins, comparableRows.length),
    tokenOnlyWinnerWalletLoserRate: ratio(tokenOnlyWinnerWalletLoserRows, comparableRows.length),
    paperOnlyPolicyRate: ratio(paperOnlyPolicyRows, comparableRows.length),
    executionGapRate: ratio(executionGapRows, comparableRows.length),
    maxLossStreak,
    criteria,
  });
  const verdict = missionCompoundingVerdict({
    liveRows: liveRows.length,
    requiredRows: criteria.requiredRows,
    blockers,
  });
  return {
    rank: 0,
    label,
    lane: majorityLane(rows),
    evidenceRole: missionEvidenceRole({ comparableRows: comparableRows.length, liveRows: liveRows.length, paperRows: paperRows.length, researchRows: researchRows.length }),
    verdict,
    rows: rows.length,
    comparableRows: comparableRows.length,
    liveRows: liveRows.length,
    paperRows: paperRows.length,
    researchRows: researchRows.length,
    paperOnlyPolicyRows,
    paperOnlyPolicyRate: ratio(paperOnlyPolicyRows, comparableRows.length),
    executionGapRows,
    executionGapRate: ratio(executionGapRows, comparableRows.length),
    executionGapBreakdown,
    walletWins,
    walletLosses,
    walletWinRate: ratio(walletWins, comparableRows.length),
    walletNetSol: walletNetSolValue,
    avgWalletNetSol: round(walletNetSolValue / Math.max(1, comparableRows.length)),
    tokenOnlyWinnerWalletLoserRows,
    tokenOnlyWinnerWalletLoserRate: ratio(tokenOnlyWinnerWalletLoserRows, comparableRows.length),
    actual5xRows: comparableRows.filter((row) => mfePct(row) >= 4).length,
    p50MfePct: percentile(comparableRows.map(mfePct), 0.5),
    p90MfePct: percentile(comparableRows.map(mfePct), 0.9),
    medianHoldSec: percentile(comparableRows.map(holdSec).filter((value): value is number => value != null), 0.5),
    maxLossStreak,
    worstLossSol: round(Math.min(0, ...comparableRows.map(walletNetSol))),
    blockers,
    nextAction: missionCompoundingNextAction(verdict),
  };
}

function missionEvidenceRole(input: {
  comparableRows: number;
  liveRows: number;
  paperRows: number;
  researchRows: number;
}): MissionCompoundingCohort['evidenceRole'] {
  if (input.comparableRows === 0 && input.researchRows > 0) return 'research_only';
  if (input.liveRows > 0 && input.paperRows === 0) return 'live_wallet';
  if (input.liveRows > 0 && input.paperRows > 0) return 'paper_mixed';
  return 'paper_mirror';
}

function maxConsecutiveLosses(rows: JsonRow[]): number {
  let current = 0;
  let max = 0;
  for (const row of rows) {
    if (walletNetSol(row) <= 0) {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

function buildExecutionGapBreakdown(rows: JsonRow[]): MissionExecutionGapBreakdown[] {
  const counts = new Map<MissionExecutionGapKind, number>();
  for (const row of rows) {
    for (const kind of executionGapKinds(row)) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, rows: count }))
    .sort((a, b) => b.rows - a.rows || executionGapKindRank(a.kind) - executionGapKindRank(b.kind));
}

function executionGapKindRank(kind: MissionExecutionGapKind): number {
  if (kind === 'exit_liquidity_unknown') return 0;
  if (kind === 'route_unknown') return 1;
  if (kind === 'venue_unknown') return 2;
  if (kind === 'security_unknown') return 3;
  if (kind === 'token_quality_unknown') return 4;
  return 5;
}

function missionCompoundingBlockers(input: {
  rows: JsonRow[];
  comparableRows: JsonRow[];
  walletWins: number;
  walletNetSol: number;
  walletWinRate: number | null;
  tokenOnlyWinnerWalletLoserRate: number | null;
  paperOnlyPolicyRate: number | null;
  executionGapRate: number | null;
  maxLossStreak: number;
  criteria: {
    requiredRows: number;
    minWalletWinRate: number;
    maxLossStreak: number;
    maxWalletDragRate: number;
  };
}): string[] {
  const blockers: string[] = [];
  if (input.rows.length > 0 && input.comparableRows.length === 0) blockers.push('research-only rows are not live-equivalent');
  if ((input.paperOnlyPolicyRate ?? 0) >= 0.8) {
    blockers.push(`paper-only/demoted policy rows ${formatRate(input.paperOnlyPolicyRate)} >= 80.0%`);
  }
  if ((input.executionGapRate ?? 0) >= 0.8) {
    blockers.push(`execution evidence gap rows ${formatRate(input.executionGapRate)} >= 80.0%`);
  }
  if (input.comparableRows.length < input.criteria.requiredRows) {
    const remainingRows = input.criteria.requiredRows - input.comparableRows.length;
    const maxReachableWinRate = (input.walletWins + remainingRows) / input.criteria.requiredRows;
    if (maxReachableWinRate < input.criteria.minWalletWinRate) {
      blockers.push(
        `wallet win rate cannot reach ${formatRate(input.criteria.minWalletWinRate)} by ` +
        `${input.criteria.requiredRows} rows (max ${formatRate(maxReachableWinRate)})`
      );
    }
  }
  if (input.comparableRows.length < input.criteria.requiredRows) {
    blockers.push(`sample ${input.comparableRows.length}/${input.criteria.requiredRows}`);
  }
  if (input.walletNetSol <= 0) blockers.push(`wallet net ${input.walletNetSol.toFixed(6)} <= 0`);
  if ((input.walletWinRate ?? 0) < input.criteria.minWalletWinRate) {
    blockers.push(`wallet win rate ${formatRate(input.walletWinRate)} < ${formatRate(input.criteria.minWalletWinRate)}`);
  }
  if (input.maxLossStreak > input.criteria.maxLossStreak) {
    blockers.push(`max loss streak ${input.maxLossStreak} > ${input.criteria.maxLossStreak}`);
  }
  if ((input.tokenOnlyWinnerWalletLoserRate ?? 0) > input.criteria.maxWalletDragRate) {
    blockers.push(`wallet-drag rate ${formatRate(input.tokenOnlyWinnerWalletLoserRate)} > ${formatRate(input.criteria.maxWalletDragRate)}`);
  }
  return blockers;
}

function missionCompoundingVerdict(input: {
  liveRows: number;
  requiredRows: number;
  blockers: string[];
}): MissionCompoundingCohortVerdict {
  if (input.blockers.some((blocker) => blocker.includes('research-only'))) return 'RESEARCH_ONLY';
  if (input.blockers.some((blocker) => blocker.startsWith('paper-only/demoted'))) return 'REJECT_POLICY_DEMOTED';
  if (input.blockers.some((blocker) => blocker.startsWith('execution evidence gap'))) return 'REJECT_EXECUTION_GAP';
  if (input.blockers.some((blocker) => blocker.startsWith('wallet win rate cannot reach'))) return 'REJECT_LOW_WIN_RATE';
  if (input.blockers.some((blocker) => blocker.startsWith('sample '))) return 'WAIT_SAMPLE';
  if (input.blockers.some((blocker) => blocker.startsWith('wallet net'))) return 'REJECT_WALLET_NEGATIVE';
  if (input.blockers.some((blocker) => blocker.startsWith('wallet win rate'))) return 'REJECT_LOW_WIN_RATE';
  if (input.blockers.some((blocker) => blocker.startsWith('max loss streak'))) return 'REJECT_LOSS_STREAK';
  if (input.blockers.some((blocker) => blocker.startsWith('wallet-drag rate'))) return 'REJECT_WALLET_DRAG';
  return input.liveRows >= input.requiredRows ? 'READY_FOR_MICRO_LIVE_REVIEW' : 'PAPER_MIRROR_CANDIDATE';
}

function missionCompoundingNextAction(verdict: MissionCompoundingCohortVerdict): string {
  if (verdict === 'READY_FOR_MICRO_LIVE_REVIEW') return 'prepare manual micro-live review; keep ticket/floor unchanged';
  if (verdict === 'PAPER_MIRROR_CANDIDATE') return 'keep as paper mirror candidate; require live-equivalence before micro-live';
  if (verdict === 'WAIT_SAMPLE') return 'continue collecting this exact cohort';
  if (verdict === 'RESEARCH_ONLY') return 'do not promote; first create comparable paper mirror rows';
  if (verdict === 'REJECT_POLICY_DEMOTED') return 'keep diagnostic only; do not use demoted/paper-only policy as compounding proof';
  if (verdict === 'REJECT_EXECUTION_GAP') return 'fix route/exit-liquidity evidence before treating this as compounding proof';
  if (verdict === 'REJECT_WALLET_NEGATIVE') return 'remove from compounding candidate set';
  if (verdict === 'REJECT_LOW_WIN_RATE') return 'narrow entry gate or reject cohort';
  if (verdict === 'REJECT_LOSS_STREAK') return 'add loss-streak blocker or reject cohort';
  return 'fix wallet drag before considering promotion';
}

function compareMissionCompoundingCohorts(a: MissionCompoundingCohort, b: MissionCompoundingCohort): number {
  return missionCompoundingRank(a.verdict) - missionCompoundingRank(b.verdict) ||
    b.comparableRows - a.comparableRows ||
    b.walletNetSol - a.walletNetSol ||
    (b.walletWinRate ?? 0) - (a.walletWinRate ?? 0) ||
    a.label.localeCompare(b.label);
}

function missionCompoundingRank(verdict: MissionCompoundingCohortVerdict): number {
  if (verdict === 'READY_FOR_MICRO_LIVE_REVIEW') return 0;
  if (verdict === 'PAPER_MIRROR_CANDIDATE') return 1;
  if (verdict === 'WAIT_SAMPLE') return 2;
  if (verdict === 'RESEARCH_ONLY') return 3;
  if (verdict === 'REJECT_POLICY_DEMOTED') return 4;
  if (verdict === 'REJECT_EXECUTION_GAP') return 5;
  return 6;
}

function missionCompoundingBoardVerdict(candidates: MissionCompoundingCohort[]): MissionCompoundingBoardVerdict {
  if (candidates.some((candidate) => candidate.verdict === 'READY_FOR_MICRO_LIVE_REVIEW')) return 'LIVE_COHORT_PROVEN';
  if (candidates.some((candidate) => candidate.verdict === 'PAPER_MIRROR_CANDIDATE')) return 'PAPER_COHORT_FOUND';
  if (candidates.some((candidate) => candidate.verdict === 'WAIT_SAMPLE')) return 'WAIT_SAMPLE';
  return 'NO_COMPOUNDING_COHORT';
}

function missionCompoundingBoardAction(verdict: MissionCompoundingBoardVerdict): string {
  if (verdict === 'LIVE_COHORT_PROVEN') return 'manual micro-live review only; no size increase';
  if (verdict === 'PAPER_COHORT_FOUND') return 'lock the cohort as paper mirror and collect live-equivalence rows';
  if (verdict === 'WAIT_SAMPLE') return 'do not change live; keep collecting exact narrow cohort rows';
  return 'no compounding cohort; keep loss-mining and reject weak cohorts';
}

function buildMissionCompoundingBlockerSummary(
  candidates: MissionCompoundingCohort[]
): MissionCompoundingBlockerSummary[] {
  const buckets = new Map<MissionCompoundingBlocker, MissionCompoundingCohort[]>();
  for (const candidate of candidates) {
    const blocker = missionCompoundingPrimaryBlocker(candidate);
    buckets.set(blocker, [...(buckets.get(blocker) ?? []), candidate]);
  }
  return [...buckets.entries()]
    .map(([blocker, scoped]) => ({
      blocker,
      cohorts: scoped.length,
      rows: scoped.reduce((sum, row) => sum + row.rows, 0),
      comparableRows: scoped.reduce((sum, row) => sum + row.comparableRows, 0),
      liveRows: scoped.reduce((sum, row) => sum + row.liveRows, 0),
      paperRows: scoped.reduce((sum, row) => sum + row.paperRows, 0),
      researchRows: scoped.reduce((sum, row) => sum + row.researchRows, 0),
      walletNetSol: round(scoped.reduce((sum, row) => sum + row.walletNetSol, 0)),
      topLabels: scoped.slice(0, 5).map((row) => row.label),
      nextAction: missionCompoundingBlockerNextAction(blocker),
    }))
    .sort((a, b) =>
      missionCompoundingBlockerRank(a.blocker) - missionCompoundingBlockerRank(b.blocker) ||
      b.rows - a.rows ||
      a.blocker.localeCompare(b.blocker)
    );
}

function buildMissionExecutionGapSummary(
  candidates: MissionCompoundingCohort[],
  groupedRows: Map<string, JsonRow[]>
): MissionExecutionGapSummary[] {
  const buckets = new Map<
    MissionExecutionGapKind,
    { rows: number; rowKeys: Set<string>; candidates: MissionCompoundingCohort[] }
  >();
  for (const candidate of candidates) {
    if (missionCompoundingPrimaryBlocker(candidate) !== 'execution_gap') continue;
    for (const item of candidate.executionGapBreakdown) {
      const bucket = buckets.get(item.kind) ?? { rows: 0, rowKeys: new Set<string>(), candidates: [] };
      bucket.rows += item.rows;
      bucket.candidates.push(candidate);
      for (const row of groupedRows.get(candidate.label) ?? []) {
        if (isResearchOnlyRow(row)) continue;
        if (executionGapKinds(row).includes(item.kind)) bucket.rowKeys.add(missionRowKey(row));
      }
      buckets.set(item.kind, bucket);
    }
  }
  return [...buckets.entries()]
    .map(([kind, bucket]) => {
      const uniqueCandidates = uniqueByLabel(bucket.candidates);
      return {
        kind,
        cohorts: uniqueCandidates.length,
        rows: bucket.rows,
        uniqueRows: bucket.rowKeys.size,
        liveRows: uniqueCandidates.reduce((sum, row) => sum + row.liveRows, 0),
        paperRows: uniqueCandidates.reduce((sum, row) => sum + row.paperRows, 0),
        researchRows: uniqueCandidates.reduce((sum, row) => sum + row.researchRows, 0),
        walletNetSol: round(uniqueCandidates.reduce((sum, row) => sum + row.walletNetSol, 0)),
        topLabels: uniqueCandidates.slice(0, 5).map((row) => row.label),
        nextAction: missionExecutionGapNextAction(kind),
      };
    })
    .sort((a, b) =>
      executionGapKindRank(a.kind) - executionGapKindRank(b.kind) ||
      b.rows - a.rows ||
      a.kind.localeCompare(b.kind)
    );
}

function uniqueByLabel(candidates: MissionCompoundingCohort[]): MissionCompoundingCohort[] {
  const seen = new Set<string>();
  const unique: MissionCompoundingCohort[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.label)) continue;
    seen.add(candidate.label);
    unique.push(candidate);
  }
  return unique;
}

function missionExecutionGapNextAction(kind: MissionExecutionGapKind): string {
  if (kind === 'exit_liquidity_unknown') return 'persist sell quote and exit-liquidity proof before interpreting PnL';
  if (kind === 'route_unknown') return 'fix routeFound/sellRouteFound writer coverage or route-proof join';
  if (kind === 'venue_unknown') return 'persist venue/DEX proof before candidate review';
  if (kind === 'security_unknown') return 'refresh security evidence writer before candidate review';
  if (kind === 'token_quality_unknown') return 'persist token-quality observation before candidate review';
  return 'inspect execution evidence writer for uncategorized gaps';
}

function missionCompoundingPrimaryBlocker(candidate: MissionCompoundingCohort): MissionCompoundingBlocker {
  if (candidate.verdict === 'RESEARCH_ONLY') return 'research_only';
  if (candidate.verdict === 'REJECT_POLICY_DEMOTED') return 'demoted_policy';
  if (candidate.verdict === 'REJECT_EXECUTION_GAP') return 'execution_gap';
  if (candidate.blockers.some((blocker) => blocker.startsWith('sample '))) return 'thin_sample';
  if (candidate.blockers.some((blocker) => blocker.startsWith('wallet net'))) return 'wallet_negative';
  if (candidate.blockers.some((blocker) => blocker.startsWith('wallet win rate'))) return 'low_win_rate';
  if (candidate.blockers.some((blocker) => blocker.startsWith('max loss streak'))) return 'loss_streak';
  if (candidate.blockers.some((blocker) => blocker.startsWith('wallet-drag rate'))) return 'wallet_drag';
  return 'other';
}

function missionCompoundingBlockerRank(blocker: MissionCompoundingBlocker): number {
  if (blocker === 'research_only') return 0;
  if (blocker === 'demoted_policy') return 1;
  if (blocker === 'execution_gap') return 2;
  if (blocker === 'thin_sample') return 3;
  if (blocker === 'wallet_negative') return 4;
  if (blocker === 'low_win_rate') return 5;
  if (blocker === 'loss_streak') return 6;
  if (blocker === 'wallet_drag') return 7;
  return 8;
}

function missionCompoundingBlockerNextAction(blocker: MissionCompoundingBlocker): string {
  if (blocker === 'research_only') return 'convert only the most promising research arms into comparable paper mirror rows';
  if (blocker === 'demoted_policy') return 'keep demoted/paper-only cohorts diagnostic; do not re-enable live without new ADR evidence';
  if (blocker === 'execution_gap') return 'fix route/exit/security proof before collecting more PnL evidence';
  if (blocker === 'thin_sample') return 'collect exact comparable rows until minTracking/required sample is reached';
  if (blocker === 'wallet_negative') return 'reject or tighten entry; wallet economics are negative';
  if (blocker === 'low_win_rate') return 'narrow the cohort or discard; win rate cannot support daily compounding';
  if (blocker === 'loss_streak') return 'add loss-streak guard before any review';
  if (blocker === 'wallet_drag') return 'fix cost/rent/slippage drag before review';
  return 'manual review';
}

function formatRate(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export async function buildHistoricalLossReport(args: Args): Promise<HistoricalLossReport> {
  const rowsByLedger = await Promise.all(LEDGERS.map(async (spec) => {
    const rows = await readJsonl(path.join(args.realtimeDir, spec.fileName));
    const recentRows = args.sinceMs == null ? rows : rows.filter((row) => timeMs(row) >= (args.sinceMs ?? 0));
    return { spec, rows: recentRows.map((row) => ({ ...row, __ledger: spec.name, __mode: spec.mode, __lane: spec.lane })) };
  }));
  const allRows = rowsByLedger.flatMap((item) => item.rows);
  const ledgers = rowsByLedger.map((item) => summarize('ledger', item.spec.name, item.rows));
  const exitBuckets = groups(allRows, 'exit', (row) => [str(row.exitReason, row.closeReason)]);
  const armExitBuckets = groups(allRows, 'arm_exit', (row) => [
    `${str(row.profileArm, row.armName, row.__lane)}::${str(row.exitReason, row.closeReason)}`,
  ]);
  const flagBuckets = groups(allRows, 'flag', (row) => flags(row).filter(isActionableFlag));
  const postCloseDiagnosticCandidates = cutCandidates([...exitBuckets, ...armExitBuckets], args);
  const preEntryProxyCandidates = cutCandidates(
    flagBuckets.filter((bucket) => isPreEntryProxyFlag(bucket.label)),
    args
  );
  const diagnosticProxyCandidates = buildDiagnosticProxyCandidates(postCloseDiagnosticCandidates, allRows, args);
  const paperShadowGateQueue = buildPaperShadowGateQueue(preEntryProxyCandidates, args);
  const paperShadowBlockCounters = buildPaperShadowBlockCounters(paperShadowGateQueue, allRows, args);
  const conjunctiveProxySplits = buildConjunctiveProxySplits(paperShadowBlockCounters, allRows, args);
  const freshSplitValidations = buildFreshSplitValidations(conjunctiveProxySplits, allRows, args);
  const freshSplitReadiness = buildFreshSplitReadiness(freshSplitValidations, args);
  const smartV3AdmissionCandidates = buildSmartV3AdmissionCandidates(allRows, args);
  const paperShadowDecisionLedger = buildPaperShadowDecisionLedger({
    blockCounters: paperShadowBlockCounters,
    splitReadiness: freshSplitReadiness,
    diagnosticProxies: diagnosticProxyCandidates,
    smartV3Candidates: smartV3AdmissionCandidates,
  });
  const promotionPackets = buildPromotionPackets(paperShadowDecisionLedger);
  const paperShadowFreshCounters = buildPaperShadowFreshCounters(promotionPackets, allRows, args);
  return {
    generatedAt: new Date().toISOString(),
    since: args.sinceMs == null ? null : new Date(args.sinceMs).toISOString(),
    criteria: { minRows: args.minRows, maxP90MfePct: args.maxP90Mfe },
    ledgers,
    missionCompoundingBoard: buildMissionCompoundingBoard(allRows, args),
    counterfactuals: counterfactuals(allRows),
    paperShadowGateQueue,
    paperShadowBlockCounters,
    conjunctiveProxySplits,
    freshSplitReadiness,
    freshSplitValidations,
    preEntryProxyCandidates,
    postCloseDiagnosticCandidates,
    diagnosticProxyCandidates,
    smartV3AdmissionCandidates,
    paperShadowDecisionLedger,
    promotionWatchlist: buildPromotionWatchlist(promotionPackets),
    promotionPackets,
    paperShadowFreshReadiness: buildPaperShadowFreshReadiness(paperShadowFreshCounters),
    paperShadowFreshCounters,
    cutCandidates: cutCandidates([...exitBuckets, ...armExitBuckets, ...flagBuckets], args),
    exitBuckets: exitBuckets.slice(0, 20),
    armExitBuckets: armExitBuckets.slice(0, 30),
    flagBuckets: flagBuckets.slice(0, 30),
  };
}

function renderTable(rows: BucketStats[]): string {
  if (rows.length === 0) return '_No rows._';
  return [
    '| bucket | label | rows | W/L wallet | wallet SOL | token SOL | avg wallet | zero MFE | p90 MFE | 5x | killed wallet winners | avoidable loss | action |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ...rows.map((row) =>
      `| ${row.bucketType} | ${row.label} | ${row.rows} | ${row.walletWins}/${row.rows - row.walletWins} | ` +
      `${row.walletNetSol.toFixed(6)} | ${row.tokenNetSol.toFixed(6)} | ${row.avgWalletNetSol.toFixed(6)} | ` +
      `${row.zeroMfeRows} | ${row.p90MfePct == null ? 'n/a' : (row.p90MfePct * 100).toFixed(2) + '%'} | ` +
      `${row.actual5xRows} | ${row.killedWalletWinners} | ${row.avoidableWalletLossSol.toFixed(6)} | ${row.recommendedAction} |`
    ),
  ].join('\n');
}

function renderMissionCompoundingBoard(board: MissionCompoundingBoard): string {
  const summary = [
    `Verdict: ${board.verdict}`,
    `Primary action: ${board.primaryAction}`,
    `Criteria: requiredRows>=${board.requiredRows}, minTrackingRows>=${board.minTrackingRows}, walletWinRate>=${formatRate(board.minWalletWinRate)}, ` +
      `maxLossStreak<=${board.maxLossStreak}, walletDrag<=${formatRate(board.maxWalletDragRate)}`,
  ].join('\n\n');
  const blockerSummary = renderMissionCompoundingBlockerSummary(board.blockerSummary);
  const executionGapSummary = renderMissionExecutionGapSummary(board.executionGapSummary);
  if (board.candidates.length === 0) return `${summary}\n\n${blockerSummary}\n\n${executionGapSummary}\n\n_No mission compounding candidates._`;
  return [
    summary,
    '',
    blockerSummary,
    '',
    executionGapSummary,
    '',
    '| rank | label | lane | role | verdict | rows | comparable | live/paper/research | paper-only policy | execution gap | W/L | wallet win | wallet SOL | avg SOL | wallet-drag | 5x | p90 MFE | hold | loss streak | worst loss | blockers | next action |',
    '|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|',
    ...board.candidates.map((row) =>
      `| ${row.rank} | ${row.label} | ${row.lane} | ${row.evidenceRole} | ${row.verdict} | ` +
      `${row.rows} | ${row.comparableRows} | ${row.liveRows}/${row.paperRows}/${row.researchRows} | ` +
      `${row.paperOnlyPolicyRows} (${formatRate(row.paperOnlyPolicyRate)}) | ` +
      `${row.executionGapRows} (${formatRate(row.executionGapRate)}) | ` +
      `${row.walletWins}/${row.walletLosses} | ${formatRate(row.walletWinRate)} | ${row.walletNetSol.toFixed(6)} | ` +
      `${row.avgWalletNetSol.toFixed(6)} | ${row.tokenOnlyWinnerWalletLoserRows} (${formatRate(row.tokenOnlyWinnerWalletLoserRate)}) | ` +
      `${row.actual5xRows} | ${row.p90MfePct == null ? 'n/a' : (row.p90MfePct * 100).toFixed(2) + '%'} | ` +
      `${row.medianHoldSec == null ? 'n/a' : row.medianHoldSec.toFixed(1) + 's'} | ${row.maxLossStreak} | ` +
      `${row.worstLossSol.toFixed(6)} | ${row.blockers.length === 0 ? 'none' : row.blockers.join('; ')} | ${row.nextAction} |`
    ),
  ].join('\n');
}

function renderMissionCompoundingBlockerSummary(rows: MissionCompoundingBlockerSummary[]): string {
  if (rows.length === 0) return '_No mission compounding blocker summary rows._';
  return [
    'Blocker decomposition:',
    '',
    '| blocker | cohorts | rows | comparable | live/paper/research | wallet SOL | top labels | next action |',
    '|---|---:|---:|---:|---:|---:|---|---|',
    ...rows.map((row) =>
      `| ${row.blocker} | ${row.cohorts} | ${row.rows} | ${row.comparableRows} | ` +
      `${row.liveRows}/${row.paperRows}/${row.researchRows} | ${row.walletNetSol.toFixed(6)} | ` +
      `${row.topLabels.join('<br>')} | ${row.nextAction} |`
    ),
  ].join('\n');
}

function renderMissionExecutionGapSummary(rows: MissionExecutionGapSummary[]): string {
  if (rows.length === 0) return '_No mission execution gap summary rows._';
  return [
    'Execution gap decomposition:',
    '',
    '| kind | cohorts | row refs | unique rows | live/paper/research | wallet SOL | top labels | next action |',
    '|---|---:|---:|---:|---:|---:|---|---|',
    ...rows.map((row) =>
      `| ${row.kind} | ${row.cohorts} | ${row.rows} | ${row.uniqueRows} | ${row.liveRows}/${row.paperRows}/${row.researchRows} | ` +
      `${row.walletNetSol.toFixed(6)} | ${row.topLabels.join('<br>')} | ${row.nextAction} |`
    ),
  ].join('\n');
}

function renderPaperShadowGateQueue(rows: PaperShadowGateQueueItem[]): string {
  if (rows.length === 0) return '_No paper shadow gate candidates._';
  return [
    '| rank | label | lane | historical rows | wallet SOL | avoidable loss | W wins | 5x | p90 MFE | verdict | fresh validation | next action |',
    '|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|---|',
    ...rows.map((row) =>
      `| ${row.rank} | ${row.label} | ${row.lane} | ${row.historicalRows} | ` +
      `${row.historicalWalletNetSol.toFixed(6)} | ${row.historicalAvoidableLossSol.toFixed(6)} | ` +
      `${row.historicalWalletWins} | ${row.historicalActual5xRows} | ` +
      `${row.historicalP90MfePct == null ? 'n/a' : (row.historicalP90MfePct * 100).toFixed(2) + '%'} | ` +
      `${row.verdict} | ${row.freshValidationGate} | ${row.nextAction} |`
    ),
  ].join('\n');
}

function renderPaperShadowBlockCounters(rows: PaperShadowBlockCounter[]): string {
  if (rows.length === 0) return '_No paper shadow block counters._';
  return [
    '| rank | label | lane | shadow blocked rows | blocked wallet SOL | saved loss | missed winners | missed winner SOL | missed 5x | net impact | verdict | next action |',
    '|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|',
    ...rows.map((row) =>
      `| ${row.rank} | ${row.label} | ${row.lane} | ${row.shadowBlockedRows} | ` +
      `${row.blockedWalletNetSol.toFixed(6)} | ${row.savedLossSol.toFixed(6)} | ` +
      `${row.missedWinnerRows} | ${row.missedWinnerSol.toFixed(6)} | ${row.missedActual5xRows} | ` +
      `${row.shadowNetImpactSol.toFixed(6)} | ${row.verdict} | ${row.nextAction} |`
    ),
  ].join('\n');
}

function renderConjunctiveProxySplits(rows: ConjunctiveProxySplit[]): string {
  if (rows.length === 0) return '_No conjunctive proxy splits._';
  return [
    '| label | lane | rows | wallet SOL | saved loss | missed winners | missed winner SOL | missed 5x | p90 MFE | verdict | next action |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|',
    ...rows.map((row) =>
      `| ${row.label} | ${row.lane} | ${row.rows} | ${row.walletNetSol.toFixed(6)} | ` +
      `${row.savedLossSol.toFixed(6)} | ${row.missedWinnerRows} | ${row.missedWinnerSol.toFixed(6)} | ` +
      `${row.missedActual5xRows} | ${row.p90MfePct == null ? 'n/a' : (row.p90MfePct * 100).toFixed(2) + '%'} | ` +
      `${row.verdict} | ${row.nextAction} |`
    ),
  ].join('\n');
}

function renderFreshSplitValidations(rows: FreshSplitValidation[]): string {
  if (rows.length === 0) return '_No fresh split validations._';
  return [
    '| window | since | label | lane | rows | wallet SOL | saved loss | missed winners | missed winner SOL | missed 5x | p90 MFE | verdict | next action |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|',
    ...rows.map((row) =>
      `| ${row.window} | ${row.since} | ${row.label} | ${row.lane} | ${row.rows} | ` +
      `${row.walletNetSol.toFixed(6)} | ${row.savedLossSol.toFixed(6)} | ${row.missedWinnerRows} | ` +
      `${row.missedWinnerSol.toFixed(6)} | ${row.missedActual5xRows} | ` +
      `${row.p90MfePct == null ? 'n/a' : (row.p90MfePct * 100).toFixed(2) + '%'} | ` +
      `${row.verdict} | ${row.nextAction} |`
    ),
  ].join('\n');
}

function renderFreshSplitReadiness(rows: FreshSplitReadiness[]): string {
  if (rows.length === 0) return '_No fresh split readiness rows._';
  return [
    '| label | lane | verdict | best window | rows | required | remaining | wallet SOL | saved loss | missed winners | missed 5x | next action |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
    ...rows.map((row) =>
      `| ${row.label} | ${row.lane} | ${row.verdict} | ${row.bestWindow ?? 'n/a'} | ` +
      `${row.bestWindowRows} | ${row.requiredRows} | ${row.rowsRemaining} | ` +
      `${row.walletNetSol.toFixed(6)} | ${row.savedLossSol.toFixed(6)} | ` +
      `${row.missedWinnerRows} | ${row.missedActual5xRows} | ${row.nextAction} |`
    ),
  ].join('\n');
}

function renderDiagnosticProxyCandidates(rows: DiagnosticProxyCandidate[]): string {
  if (rows.length === 0) return '_No diagnostic-to-pre-entry proxy candidates._';
  return [
    '| rank | diagnostic | proxy | lane | diagnostic rows | proxy rows | target rows | coverage | wallet SOL | saved loss | missed winners | missed 5x | p90 MFE | verdict | next action |',
    '|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|',
    ...rows.map((row) =>
      `| ${row.rank} | ${row.diagnosticBucketType}:${row.diagnosticLabel} | ${row.proxyLabel} | ${row.lane} | ` +
      `${row.diagnosticRows} | ${row.proxyRows} | ${row.targetProxyRows} | ${(row.diagnosticCoveragePct * 100).toFixed(2)}% | ` +
      `${row.walletNetSol.toFixed(6)} | ${row.savedLossSol.toFixed(6)} | ` +
      `${row.missedWinnerRows} | ${row.missedActual5xRows} | ` +
      `${row.p90MfePct == null ? 'n/a' : (row.p90MfePct * 100).toFixed(2) + '%'} | ` +
      `${row.verdict} | ${row.nextAction} |`
    ),
  ].join('\n');
}

function renderSmartV3AdmissionCandidates(rows: SmartV3AdmissionCandidate[]): string {
  if (rows.length === 0) return '_No smart-v3 loser admission candidates._';
  return [
    '| rank | proxy | target rows | proxy rows | target matched | coverage | wallet SOL | saved loss | missed winners | missed T2 | missed 5x | p90 MFE | verdict | next action |',
    '|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|',
    ...rows.map((row) =>
      `| ${row.rank} | ${row.proxyLabel} | ${row.targetRows} | ${row.proxyRows} | ${row.targetProxyRows} | ` +
      `${(row.targetCoveragePct * 100).toFixed(2)}% | ${row.walletNetSol.toFixed(6)} | ` +
      `${row.savedLossSol.toFixed(6)} | ${row.missedWinnerRows} | ${row.missedT2Rows} | ${row.missedActual5xRows} | ` +
      `${row.p90MfePct == null ? 'n/a' : (row.p90MfePct * 100).toFixed(2) + '%'} | ` +
      `${row.verdict} | ${row.nextAction} |`
    ),
  ].join('\n');
}

function renderPaperShadowDecisionLedger(rows: PaperShadowDecisionLedgerItem[]): string {
  if (rows.length === 0) return '_No paper shadow decision ledger rows._';
  return [
    '| rank | kind | label | lane | state | rows | wallet SOL | saved loss | missed winners | missed T2 | missed 5x | net impact | source verdict | next action |',
    '|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|',
    ...rows.map((row) =>
      `| ${row.rank} | ${row.kind} | ${row.label} | ${row.lane} | ${row.state} | ${row.rows} | ` +
      `${row.walletNetSol.toFixed(6)} | ${row.savedLossSol.toFixed(6)} | ${row.missedWinnerRows} | ` +
      `${row.missedT2Rows} | ${row.missedActual5xRows} | ${row.netImpactSol.toFixed(6)} | ` +
      `${row.sourceVerdict} | ${row.nextAction} |`
    ),
  ].join('\n');
}

function renderPromotionPackets(rows: PromotionPacketItem[]): string {
  if (rows.length === 0) return '_No promotion packets._';
  return [
    '| rank | kind | label | lane | verdict | rows | net impact | saved loss | missed winners | missed T2 | missed 5x | blockers | next action |',
    '|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|',
    ...rows.map((row) =>
      `| ${row.rank} | ${row.kind} | ${row.label} | ${row.lane} | ${row.verdict} | ${row.rows} | ` +
      `${row.netImpactSol.toFixed(6)} | ${row.savedLossSol.toFixed(6)} | ${row.missedWinnerRows} | ` +
      `${row.missedT2Rows} | ${row.missedActual5xRows} | ${row.blockers.length === 0 ? 'none' : row.blockers.join('; ')} | ` +
      `${row.nextAction} |`
    ),
  ].join('\n');
}

function renderPromotionWatchlist(watchlist: PromotionWatchlist): string {
  const summary = [
    `Primary action: ${watchlist.primaryAction}`,
    `Counts: liveReview=${watchlist.readyForLiveReview}, paperShadow=${watchlist.paperShadowOnly}, ` +
      `waitFresh=${watchlist.waitFreshRows}, rejected=${watchlist.rejected}`,
  ].join('\n\n');
  if (watchlist.rows.length === 0) return `${summary}\n\n_No promotion watchlist rows._`;
  return [
    summary,
    '',
    '| rank | queue | kind | label | lane | verdict | rows | net impact | saved loss | blockers | next action |',
    '|---:|---|---|---|---|---|---:|---:|---:|---|---|',
    ...watchlist.rows.map((row) =>
      `| ${row.rank} | ${row.queue} | ${row.kind} | ${row.label} | ${row.lane} | ${row.verdict} | ${row.rows} | ` +
      `${row.netImpactSol.toFixed(6)} | ${row.savedLossSol.toFixed(6)} | ` +
      `${row.blockers.length === 0 ? 'none' : row.blockers.join('; ')} | ${row.nextAction} |`
    ),
  ].join('\n');
}

function renderPaperShadowFreshCounters(rows: PaperShadowFreshCounter[]): string {
  if (rows.length === 0) return '_No paper-shadow fresh counters._';
  return [
    '| window | kind | label | lane | rows | required | remaining | net impact | saved loss | missed winners | missed T2 | missed 5x | verdict | next action |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|',
    ...rows.map((row) =>
      `| ${row.window} | ${row.kind} | ${row.label} | ${row.lane} | ${row.rows} | ` +
      `${row.requiredRows} | ${row.rowsRemaining} | ${row.netImpactSol.toFixed(6)} | ` +
      `${row.savedLossSol.toFixed(6)} | ${row.missedWinnerRows} | ${row.missedT2Rows} | ` +
      `${row.missedActual5xRows} | ${row.verdict} | ${row.nextAction} |`
    ),
  ].join('\n');
}

function renderPaperShadowFreshReadiness(rows: PaperShadowFreshReadiness[]): string {
  if (rows.length === 0) return '_No paper-shadow fresh readiness rows._';
  return [
    '| kind | label | lane | verdict | best window | rows | required | remaining | net impact | saved loss | missed winners | missed T2 | missed 5x | next action |',
    '|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ...rows.map((row) =>
      `| ${row.kind} | ${row.label} | ${row.lane} | ${row.verdict} | ${row.bestWindow ?? 'n/a'} | ` +
      `${row.rows} | ${row.requiredRows} | ${row.rowsRemaining} | ${row.netImpactSol.toFixed(6)} | ` +
      `${row.savedLossSol.toFixed(6)} | ${row.missedWinnerRows} | ${row.missedT2Rows} | ` +
      `${row.missedActual5xRows} | ${row.nextAction} |`
    ),
  ].join('\n');
}

export function renderHistoricalLossReport(report: HistoricalLossReport): string {
  return [
    `# Historical Loss Miner (${report.generatedAt})`,
    '',
    `Since: ${report.since ?? 'all data'}`,
    `Criteria: minRows=${report.criteria.minRows}, p90Mfe<=${(report.criteria.maxP90MfePct * 100).toFixed(2)}%, actual5x=0, walletNet<0`,
    'Policy note: pre-entry proxy candidates are the leakage-safe paper-shadow targets. Post-close diagnostics explain loss modes, but are not direct live entry gates.',
    '',
    '## Mission Compounding Cohort Board',
    'Root-cause read: this board asks whether any narrow, comparable cohort is wallet-positive enough for slow compounding. Research/shadow rows cannot prove live readiness.',
    renderMissionCompoundingBoard(report.missionCompoundingBoard),
    '',
    '## Paper Shadow Gate Queue',
    renderPaperShadowGateQueue(report.paperShadowGateQueue),
    '',
    '## Paper Shadow Block Counters',
    renderPaperShadowBlockCounters(report.paperShadowBlockCounters),
    '',
    '## Conjunctive Proxy Splits',
    renderConjunctiveProxySplits(report.conjunctiveProxySplits),
    '',
    '## Fresh Split Validation',
    renderFreshSplitValidations(report.freshSplitValidations),
    '',
    '## Fresh Split Readiness',
    renderFreshSplitReadiness(report.freshSplitReadiness),
    '',
    '## Pre-Entry Proxy Candidates',
    renderTable(report.preEntryProxyCandidates.slice(0, 25)),
    '',
    '## Post-Close Diagnostic Candidates',
    renderTable(report.postCloseDiagnosticCandidates.slice(0, 25)),
    '',
    '## Diagnostic To Pre-Entry Proxy Candidates',
    renderDiagnosticProxyCandidates(report.diagnosticProxyCandidates.slice(0, 25)),
    '',
    '## Smart V3 Loser Admission Candidates',
    renderSmartV3AdmissionCandidates(report.smartV3AdmissionCandidates.slice(0, 25)),
    '',
    '## Paper Shadow Decision Ledger',
    renderPaperShadowDecisionLedger(report.paperShadowDecisionLedger.slice(0, 25)),
    '',
    '## Promotion Watchlist',
    renderPromotionWatchlist(report.promotionWatchlist),
    '',
    '## Paper Shadow Fresh Readiness',
    renderPaperShadowFreshReadiness(report.paperShadowFreshReadiness.slice(0, 25)),
    '',
    '## Paper Shadow Fresh Counters',
    renderPaperShadowFreshCounters(report.paperShadowFreshCounters.slice(0, 25)),
    '',
    '## Promotion Packets',
    renderPromotionPackets(report.promotionPackets.slice(0, 25)),
    '',
    '## Cut Candidates',
    renderTable(report.cutCandidates.slice(0, 25)),
    '',
    '## Counterfactual Sets',
    renderTable(report.counterfactuals),
    '',
    '## Ledger Summary',
    renderTable(report.ledgers),
    '',
    '## Exit Buckets',
    renderTable(report.exitBuckets),
    '',
    '## Arm Exit Buckets',
    renderTable(report.armExitBuckets),
    '',
    '## Actionable Flag Buckets',
    renderTable(report.flagBuckets),
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildHistoricalLossReport(args);
  const markdown = renderHistoricalLossReport(report);
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
