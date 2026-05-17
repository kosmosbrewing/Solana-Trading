import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

const LIVE_CANDIDATE_LINK_MIN_COVERAGE = 0.9;
const LIVE_FALLBACK_ATTRIBUTION_WINDOW_MS = 5 * 60 * 1000;
const DECISION_ATTRIBUTION_MIN_COVERAGE = 0.9;

type JsonRecord = Record<string, unknown>;

type LiveAttributionStatus = 'exact' | 'fallback' | 'ambiguous' | 'no_candidate' | 'missing_fields';
type PaperRole = 'mirror' | 'fallback_execution_safety' | 'research_arm' | 'shadow' | 'no_trade_counterfactual';

interface LiveAttribution {
  row: JsonRecord;
  status: LiveAttributionStatus;
  candidateId: string | null;
  reason: string;
  matchCount: number;
  missingFields: string[];
}

interface Args {
  realtimeDir: string;
  sinceMs: number;
  md?: string;
  json?: string;
}

interface SummaryBucket {
  rows: number;
  liveWouldEnter: number;
  liveAttempted: number;
  blocked: number;
  paperCloses: number;
  paperWins: number;
  paperNetSol: number;
  paperNetSolTokenOnly: number;
  paperAvgMfePct: number | null;
  liveCloses: number;
  liveNetSol: number;
}

interface PaperRoleBucket {
  closes: number;
  wins: number;
  netSol: number;
  netSolTokenOnly: number;
  avgMfePct: number | null;
}

interface DecisionGapBucket {
  decisions: number;
  comparablePaperCloses: number;
  researchPaperCloses: number;
  shadowPaperCloses: number;
  liveCloses: number;
  comparablePaperNetSol: number;
  researchPaperNetSol: number;
  liveNetSol: number;
}

interface ExecutionGuardBucket {
  rows: number;
  paperRows: number;
  liveRows: number;
  fallbackPaperRows: number;
  rejectRows: number;
  deferRows: number;
}

function parseArgs(argv: string[]): Args {
  let realtimeDir = 'data/realtime';
  let since = '24h';
  let md: string | undefined;
  let json: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--realtime-dir' && next) {
      realtimeDir = next;
      i += 1;
    } else if (arg === '--since' && next) {
      since = next;
      i += 1;
    } else if (arg === '--md' && next) {
      md = next;
      i += 1;
    } else if (arg === '--json' && next) {
      json = next;
      i += 1;
    }
  }
  return {
    realtimeDir,
    sinceMs: parseSinceMs(since),
    md,
    json,
  };
}

function parseSinceMs(value: string, nowMs = Date.now()): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([mhd])$/i);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`invalid --since: ${value}`);
    const durationMs =
      unit === 'm' ? amount * 60 * 1000 :
      unit === 'h' ? amount * 60 * 60 * 1000 :
      amount * 24 * 60 * 60 * 1000;
    return nowMs - durationMs;
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`invalid --since: ${value}`);
}

async function readJsonl(file: string): Promise<JsonRecord[]> {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === 'object' ? parsed as JsonRecord : null;
        } catch {
          return null;
        }
      })
      .filter((row): row is JsonRecord => row !== null);
  } catch {
    return [];
  }
}

function rowTimeMs(row: JsonRecord): number {
  const candidates = [
    row.generatedAt,
    row.closedAt,
    row.openedAt,
    row.entryAt,
    row.createdAt,
  ];
  for (const value of candidates) {
    if (typeof value === 'string') {
      const ts = Date.parse(value);
      if (Number.isFinite(ts)) return ts;
    }
  }
  if (typeof row.exitTimeSec === 'number') return row.exitTimeSec * 1000;
  if (typeof row.entryTimeSec === 'number') return row.entryTimeSec * 1000;
  return 0;
}

function str(row: JsonRecord, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(row: JsonRecord, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(row: JsonRecord, key: string): boolean {
  return row[key] === true;
}

function obj(row: JsonRecord, key: string): JsonRecord | null {
  const value = row[key];
  return typeof value === 'object' && value != null ? value as JsonRecord : null;
}

function armKey(row: JsonRecord): string {
  return str(row, 'profileArm') ?? str(row, 'armName') ?? 'unknown';
}

function tokenMint(row: JsonRecord): string | null {
  return str(row, 'tokenMint') ?? str(row, 'pairAddress');
}

function rowArmSet(row: JsonRecord): Set<string> {
  return new Set([
    str(row, 'profileArm'),
    str(row, 'entryArm'),
    str(row, 'armName'),
  ]
    .filter((value): value is string => value != null)
    .map((value) => value.toLowerCase()));
}

function rowHasArm(row: JsonRecord): boolean {
  return rowArmSet(row).size > 0;
}

function armsCompatible(a: JsonRecord, b: JsonRecord): boolean {
  const aArms = rowArmSet(a);
  const bArms = rowArmSet(b);
  if (aArms.size === 0 || bArms.size === 0) return false;
  for (const arm of aArms) {
    if (bArms.has(arm)) return true;
  }
  return false;
}

function liveEntryTimeMs(row: JsonRecord): number | null {
  const numericCandidates = [
    num(row, 'entryOpenedAtMs'),
    num(row, 'buyCompletedAtMs'),
    num(row, 'entryAtMs'),
  ];
  for (const value of numericCandidates) {
    if (value != null && value > 0) return value;
  }
  const stringCandidates = [
    str(row, 'openedAt'),
    str(row, 'entryAt'),
    str(row, 'createdAt'),
  ];
  for (const value of stringCandidates) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const entryTimeSec = num(row, 'entryTimeSec');
  if (entryTimeSec != null && entryTimeSec > 0) return entryTimeSec * 1000;
  const closedMs = rowTimeMs(row);
  const holdSec = num(row, 'holdSecReal') ?? num(row, 'holdSec');
  if (closedMs > 0 && holdSec != null && holdSec >= 0) {
    return closedMs - holdSec * 1000;
  }
  return null;
}

function candidateTimeMs(row: JsonRecord): number | null {
  const candidateId = str(row, 'candidateId');
  if (candidateId) {
    const suffix = candidateId.split(':').at(-1);
    const parsedSuffix = suffix ? Number(suffix) : NaN;
    if (Number.isFinite(parsedSuffix) && parsedSuffix > 0) return parsedSuffix;
  }
  const generatedAt = str(row, 'generatedAt');
  if (generatedAt) {
    const parsed = Date.parse(generatedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function attributeLiveRow(row: JsonRecord, candidates: JsonRecord[]): LiveAttribution {
  const exact = str(row, 'liveEquivalenceCandidateId');
  if (exact) {
    return {
      row,
      status: 'exact',
      candidateId: exact,
      reason: 'exact_candidate_id',
      matchCount: 1,
      missingFields: [],
    };
  }

  const missingFields: string[] = [];
  const mint = tokenMint(row);
  const entryMs = liveEntryTimeMs(row);
  if (!mint) missingFields.push('tokenMint');
  if (!rowHasArm(row)) missingFields.push('arm');
  if (entryMs == null) missingFields.push('entryTime');
  if (missingFields.length > 0) {
    return {
      row,
      status: 'missing_fields',
      candidateId: null,
      reason: `missing_${missingFields.join('_')}`,
      matchCount: 0,
      missingFields,
    };
  }
  const resolvedMint = mint;
  const resolvedEntryMs = entryMs;
  if (!resolvedMint || resolvedEntryMs == null) {
    return {
      row,
      status: 'missing_fields',
      candidateId: null,
      reason: 'missing_required_attribution_fields',
      matchCount: 0,
      missingFields: ['required'],
    };
  }

  const matches = candidates.filter((candidate) => {
    const candidateId = str(candidate, 'candidateId');
    const candidateMint = tokenMint(candidate);
    const candidateMs = candidateTimeMs(candidate);
    if (!candidateId || !candidateMint || candidateMs == null) return false;
    return candidateMint === resolvedMint &&
      armsCompatible(row, candidate) &&
      Math.abs(resolvedEntryMs - candidateMs) <= LIVE_FALLBACK_ATTRIBUTION_WINDOW_MS;
  });

  if (matches.length === 1) {
    return {
      row,
      status: 'fallback',
      candidateId: str(matches[0], 'candidateId'),
      reason: 'token_arm_entry_time_fallback',
      matchCount: 1,
      missingFields: [],
    };
  }
  if (matches.length > 1) {
    return {
      row,
      status: 'ambiguous',
      candidateId: null,
      reason: 'ambiguous_token_arm_entry_time',
      matchCount: matches.length,
      missingFields: [],
    };
  }
  return {
    row,
    status: 'no_candidate',
    candidateId: null,
    reason: 'no_candidate_in_entry_window',
    matchCount: 0,
    missingFields: [],
  };
}

function countBy(rows: JsonRecord[], key: string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = str(row, key) ?? String(row[key] ?? 'unknown');
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function dedupeTradeRows(rows: JsonRecord[]): JsonRecord[] {
  const seen = new Set<string>();
  const out: JsonRecord[] = [];
  for (const row of rows) {
    const key = str(row, 'positionId') ?? `${str(row, 'tokenMint') ?? 'unknown'}:${rowTimeMs(row)}:${str(row, 'exitReason') ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function addOutcome(bucket: SummaryBucket, row: JsonRecord, mode: 'paper' | 'live'): void {
  const netSol = num(row, 'netSol') ?? 0;
  if (mode === 'paper') {
    bucket.paperCloses += 1;
    bucket.paperNetSol += netSol;
    bucket.paperNetSolTokenOnly += num(row, 'netSolTokenOnly') ?? netSol;
    if (netSol > 0) bucket.paperWins += 1;
  } else {
    bucket.liveCloses += 1;
    bucket.liveNetSol += netSol;
  }
}

function emptyBucket(): SummaryBucket {
  return {
    rows: 0,
    liveWouldEnter: 0,
    liveAttempted: 0,
    blocked: 0,
    paperCloses: 0,
    paperWins: 0,
    paperNetSol: 0,
    paperNetSolTokenOnly: 0,
    paperAvgMfePct: null,
    liveCloses: 0,
    liveNetSol: 0,
  };
}

function emptyPaperRoleBucket(): PaperRoleBucket {
  return {
    closes: 0,
    wins: 0,
    netSol: 0,
    netSolTokenOnly: 0,
    avgMfePct: null,
  };
}

function emptyDecisionGapBucket(): DecisionGapBucket {
  return {
    decisions: 0,
    comparablePaperCloses: 0,
    researchPaperCloses: 0,
    shadowPaperCloses: 0,
    liveCloses: 0,
    comparablePaperNetSol: 0,
    researchPaperNetSol: 0,
    liveNetSol: 0,
  };
}

function emptyExecutionGuardBucket(): ExecutionGuardBucket {
  return {
    rows: 0,
    paperRows: 0,
    liveRows: 0,
    fallbackPaperRows: 0,
    rejectRows: 0,
    deferRows: 0,
  };
}

function pct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function sol(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}

function isPaperRole(value: string | null): value is PaperRole {
  return value === 'mirror' ||
    value === 'fallback_execution_safety' ||
    value === 'research_arm' ||
    value === 'shadow' ||
    value === 'no_trade_counterfactual';
}

function explicitPaperRole(row: JsonRecord): PaperRole | null {
  const role = str(row, 'paperRole');
  return isPaperRole(role) ? role : null;
}

function inferPaperRole(row: JsonRecord, equivalenceByCandidate: Map<string, JsonRecord>): PaperRole | null {
  const explicit = explicitPaperRole(row);
  if (explicit) return explicit;
  if (bool(row, 'isShadowArm')) return 'shadow';

  const candidateId = str(row, 'liveEquivalenceCandidateId');
  if (!candidateId) return null;

  const equivalence = equivalenceByCandidate.get(candidateId);
  if (!equivalence) return null;

  const stage = str(equivalence, 'decisionStage');
  if (bool(equivalence, 'liveWouldEnter')) return 'mirror';
  if (stage === 'paper_only' || stage === 'default_paper') return 'research_arm';
  return 'fallback_execution_safety';
}

function comparablePaperRole(role: PaperRole | null): boolean {
  return role === 'mirror' || role === 'fallback_execution_safety';
}

function comparablePaperRow(row: JsonRecord, equivalenceByCandidate: Map<string, JsonRecord>): boolean {
  return comparablePaperRole(inferPaperRole(row, equivalenceByCandidate));
}

function executionGuardOf(row: JsonRecord): JsonRecord | null {
  const direct = obj(row, 'executionGuard');
  if (direct) return direct;
  const plan = obj(row, 'executionPlanSnapshot');
  return plan ? obj(plan, 'executionGuard') : null;
}

function addExecutionGuard(
  buckets: Map<string, ExecutionGuardBucket>,
  row: JsonRecord
): void {
  const guard = executionGuardOf(row);
  if (!guard) return;
  const name = str(guard, 'guard') ?? 'unknown';
  const action = str(guard, 'action') ?? 'unknown';
  const mode = str(row, 'mode') ?? (bool(row, 'isLive') ? 'live' : 'paper');
  const bucket = buckets.get(name) ?? emptyExecutionGuardBucket();
  bucket.rows += 1;
  if (mode === 'live') bucket.liveRows += 1;
  if (mode === 'paper') bucket.paperRows += 1;
  if (action === 'fallback_paper') bucket.fallbackPaperRows += 1;
  if (action === 'reject') bucket.rejectRows += 1;
  if (action === 'defer') bucket.deferRows += 1;
  buckets.set(name, bucket);
}

function netSolSum(rows: JsonRecord[]): number {
  return rows.reduce((sum, row) => sum + (num(row, 'netSol') ?? 0), 0);
}

function addDecisionGap(
  buckets: Map<string, DecisionGapBucket>,
  name: string,
  input: {
    comparablePaperRows: JsonRecord[];
    researchPaperRows: JsonRecord[];
    shadowPaperRows: JsonRecord[];
    liveRows: JsonRecord[];
  }
): void {
  const bucket = buckets.get(name) ?? emptyDecisionGapBucket();
  bucket.decisions += 1;
  bucket.comparablePaperCloses += input.comparablePaperRows.length;
  bucket.researchPaperCloses += input.researchPaperRows.length;
  bucket.shadowPaperCloses += input.shadowPaperRows.length;
  bucket.liveCloses += input.liveRows.length;
  bucket.comparablePaperNetSol += netSolSum(input.comparablePaperRows);
  bucket.researchPaperNetSol += netSolSum(input.researchPaperRows);
  bucket.liveNetSol += netSolSum(input.liveRows);
  buckets.set(name, bucket);
}

function decisionGapName(input: {
  equivalence: JsonRecord;
  comparablePaperRows: JsonRecord[];
  researchPaperRows: JsonRecord[];
  shadowPaperRows: JsonRecord[];
  liveRows: JsonRecord[];
}): string {
  const liveNet = netSolSum(input.liveRows);
  const comparablePaperNet = netSolSum(input.comparablePaperRows);
  const hasResearchOnly =
    input.comparablePaperRows.length === 0 &&
    (input.researchPaperRows.length > 0 || input.shadowPaperRows.length > 0);

  if (bool(input.equivalence, 'liveAttempted')) {
    if (input.liveRows.length === 0) return 'live_attempt_without_close_link';
    if (liveNet < 0 && hasResearchOnly) return 'live_loss_only_research_or_shadow_paper';
    if (liveNet < 0 && input.comparablePaperRows.length === 0) return 'live_loss_without_comparable_paper';
    if (liveNet < 0 && comparablePaperNet > 0) return 'live_loss_comparable_paper_win';
    if (liveNet < 0) return 'live_loss_comparable_paper_non_positive';
    return 'live_attempt_linked_non_loss';
  }

  if (bool(input.equivalence, 'liveWouldEnter')) {
    return 'live_would_enter_but_not_attempted';
  }

  if (input.comparablePaperRows.length > 0) {
    return comparablePaperNet > 0
      ? 'blocked_with_comparable_paper_win'
      : 'blocked_with_comparable_paper_non_positive';
  }
  if (hasResearchOnly) return 'blocked_research_or_shadow_only';
  return 'blocked_no_close';
}

async function buildReport(args: Args): Promise<{ md: string; json: JsonRecord }> {
  const realtimeDir = args.realtimeDir;
  const equivalence = (await readJsonl(path.join(realtimeDir, 'kol-live-equivalence.jsonl')))
    .filter((row) => rowTimeMs(row) >= args.sinceMs);
  const paperFiles = [
    'kol-paper-trades.jsonl',
    'smart-v3-paper-trades.jsonl',
    'rotation-v1-paper-trades.jsonl',
    'capitulation-rebound-paper-trades.jsonl',
  ];
  const liveFiles = [
    'kol-live-trades.jsonl',
    'smart-v3-live-trades.jsonl',
    'rotation-v1-live-trades.jsonl',
  ];
  const executionGuardRows = (await readJsonl(path.join(realtimeDir, 'kol-execution-guards.jsonl')))
    .filter((row) => rowTimeMs(row) >= args.sinceMs);
  const paperRows = dedupeTradeRows(
    (await Promise.all(paperFiles.map((file) => readJsonl(path.join(realtimeDir, file)))))
      .flat()
      .filter((row) => rowTimeMs(row) >= args.sinceMs)
  );
  const liveRows = dedupeTradeRows(
    (await Promise.all(liveFiles.map((file) => readJsonl(path.join(realtimeDir, file)))))
      .flat()
      .filter((row) => rowTimeMs(row) >= args.sinceMs)
  );
  const equivalenceByCandidate = new Map<string, JsonRecord>();
  for (const row of equivalence) {
    const candidateId = str(row, 'candidateId');
    if (candidateId) equivalenceByCandidate.set(candidateId, row);
  }

  const byPaperRole = new Map<string, PaperRoleBucket>();
  const mfeByPaperRole = new Map<string, number[]>();
  for (const row of paperRows) {
    const role = inferPaperRole(row, equivalenceByCandidate);
    if (!role) continue;
    const bucket = byPaperRole.get(role) ?? emptyPaperRoleBucket();
    const netSol = num(row, 'netSol') ?? 0;
    const netSolTokenOnly = num(row, 'netSolTokenOnly') ?? netSol;
    bucket.closes += 1;
    if (netSol > 0) bucket.wins += 1;
    bucket.netSol += netSol;
    bucket.netSolTokenOnly += netSolTokenOnly;
    const mfe = num(row, 'mfePctPeakTokenOnly') ?? num(row, 'mfePct') ?? null;
    if (mfe != null) {
      const values = mfeByPaperRole.get(role) ?? [];
      values.push(mfe);
      mfeByPaperRole.set(role, values);
    }
    byPaperRole.set(role, bucket);
  }
  for (const [role, values] of mfeByPaperRole.entries()) {
    const bucket = byPaperRole.get(role);
    if (!bucket || values.length === 0) continue;
    bucket.avgMfePct = values.reduce((sum, v) => sum + v, 0) / values.length;
  }
  const liveAttributionCandidates = equivalence.filter((row) => bool(row, 'liveAttempted'));
  const liveAttributions = liveRows.map((row) => attributeLiveRow(row, liveAttributionCandidates));
  const tradeRowsWithExecutionGuard = [...paperRows, ...liveRows].filter((row) => executionGuardOf(row) != null);
  const executionGuardEventRows = executionGuardRows.length > 0
    ? executionGuardRows
    : tradeRowsWithExecutionGuard;
  const executionGuardBuckets = new Map<string, ExecutionGuardBucket>();
  for (const row of executionGuardEventRows) {
    addExecutionGuard(executionGuardBuckets, row);
  }

  const paperByCandidate = new Map<string, JsonRecord[]>();
  const paperByDecision = new Map<string, JsonRecord[]>();
  for (const row of paperRows) {
    const candidateId = str(row, 'liveEquivalenceCandidateId');
    if (candidateId) {
      const rows = paperByCandidate.get(candidateId) ?? [];
      rows.push(row);
      paperByCandidate.set(candidateId, rows);
    }
    const decisionId = str(row, 'liveEquivalenceDecisionId');
    if (decisionId) {
      const rows = paperByDecision.get(decisionId) ?? [];
      rows.push(row);
      paperByDecision.set(decisionId, rows);
    }
  }
  const liveByCandidate = new Map<string, JsonRecord[]>();
  const liveByDecision = new Map<string, JsonRecord[]>();
  for (const attribution of liveAttributions) {
    const candidateId = attribution.candidateId;
    if (candidateId) {
      const rows = liveByCandidate.get(candidateId) ?? [];
      rows.push(attribution.row);
      liveByCandidate.set(candidateId, rows);
    }
    const decisionId = str(attribution.row, 'liveEquivalenceDecisionId');
    if (decisionId) {
      const rows = liveByDecision.get(decisionId) ?? [];
      rows.push(attribution.row);
      liveByDecision.set(decisionId, rows);
    }
  }

  const byArm = new Map<string, SummaryBucket>();
  const mfeByArm = new Map<string, number[]>();
  const decisionGapBuckets = new Map<string, DecisionGapBucket>();
  for (const row of equivalence) {
    const arm = armKey(row);
    const bucket = byArm.get(arm) ?? emptyBucket();
    bucket.rows += 1;
    if (bool(row, 'liveWouldEnter')) bucket.liveWouldEnter += 1;
    if (bool(row, 'liveAttempted')) bucket.liveAttempted += 1;
    if (!bool(row, 'liveWouldEnter')) bucket.blocked += 1;
    const candidateId = str(row, 'candidateId');
    const decisionId = str(row, 'decisionId');
    const paperMatches = decisionId
      ? paperByDecision.get(decisionId) ?? []
      : candidateId
        ? paperByCandidate.get(candidateId) ?? []
        : [];
    const liveMatchesByDecision = decisionId ? liveByDecision.get(decisionId) ?? [] : [];
    const liveMatches = liveMatchesByDecision.length > 0
      ? liveMatchesByDecision
      : candidateId
        ? liveByCandidate.get(candidateId) ?? []
        : [];
    const comparablePaperRows = paperMatches.filter((paper) =>
      comparablePaperRow(paper, equivalenceByCandidate)
    );
    const researchPaperRows = paperMatches.filter((paper) => {
      const role = inferPaperRole(paper, equivalenceByCandidate);
      return role === 'research_arm' || role === 'no_trade_counterfactual';
    });
    const shadowPaperRows = paperMatches.filter((paper) =>
      inferPaperRole(paper, equivalenceByCandidate) === 'shadow'
    );
    addDecisionGap(
      decisionGapBuckets,
      decisionGapName({
        equivalence: row,
        comparablePaperRows,
        researchPaperRows,
        shadowPaperRows,
        liveRows: liveMatches,
      }),
      {
        comparablePaperRows,
        researchPaperRows,
        shadowPaperRows,
        liveRows: liveMatches,
      }
    );
    if (candidateId || decisionId) {
      for (const paper of comparablePaperRows) {
        addOutcome(bucket, paper, 'paper');
        const mfe = num(paper, 'mfePctPeakTokenOnly') ?? num(paper, 'mfePct') ?? null;
        if (mfe != null) {
          const arr = mfeByArm.get(arm) ?? [];
          arr.push(mfe);
          mfeByArm.set(arm, arr);
        }
      }
      for (const live of liveMatches) {
        addOutcome(bucket, live, 'live');
      }
    }
    byArm.set(arm, bucket);
  }
  for (const [arm, values] of mfeByArm.entries()) {
    const bucket = byArm.get(arm);
    if (!bucket || values.length === 0) continue;
    bucket.paperAvgMfePct = values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  const liveAttemptedRows = equivalence.filter((row) => bool(row, 'liveAttempted')).length;
  const paperRowsWithCandidateId = paperRows.filter((row) => str(row, 'liveEquivalenceCandidateId')).length;
  const equivalenceRowsWithDecisionId = equivalence.filter((row) => str(row, 'decisionId')).length;
  const paperRowsWithDecisionId = paperRows.filter((row) => str(row, 'liveEquivalenceDecisionId')).length;
  const paperRowsWithPaperRole = paperRows.filter((row) => str(row, 'paperRole')).length;
  const paperRowsWithInferredRole = paperRows.filter((row) => inferPaperRole(row, equivalenceByCandidate) != null);
  const paperRowsWithInferredPaperRole = paperRowsWithInferredRole.length;
  const paperRowsWithoutInferredPaperRole = paperRows.length - paperRowsWithInferredPaperRole;
  const paperRowsWithExecutionPlan = paperRows.filter((row) => row.executionPlanSnapshot != null).length;
  const paperAttributedRowsWithExecutionPlan =
    paperRowsWithInferredRole.filter((row) => row.executionPlanSnapshot != null).length;
  const liveRowsWithCandidateId = liveAttributions.filter((row) => row.status === 'exact').length;
  const liveRowsWithDecisionId = liveRows.filter((row) => str(row, 'liveEquivalenceDecisionId')).length;
  const liveRowsWithExecutionPlan = liveRows.filter((row) => row.executionPlanSnapshot != null).length;
  const liveRowsLinkedByFallback = liveAttributions.filter((row) => row.status === 'fallback').length;
  const liveRowsAmbiguous = liveAttributions.filter((row) => row.status === 'ambiguous').length;
  const liveRowsNoCandidateFound = liveAttributions.filter((row) => row.status === 'no_candidate').length;
  const liveRowsMissingAttributionFields = liveAttributions.filter((row) => row.status === 'missing_fields').length;
  const liveRowsLinkedTotal = liveRowsWithCandidateId + liveRowsLinkedByFallback;
  const liveLinkedRowsWithDecisionId = liveAttributions.filter((row) =>
    (row.status === 'exact' || row.status === 'fallback') &&
    str(row.row, 'liveEquivalenceDecisionId')
  ).length;
  const liveLinkedRowsWithExecutionPlan = liveAttributions.filter((row) =>
    (row.status === 'exact' || row.status === 'fallback') &&
    row.row.executionPlanSnapshot != null
  ).length;
  const unlinkedLiveRows = liveRows.length - liveRowsLinkedTotal;
  const liveCandidateLinkCoverage = liveRows.length > 0 ? liveRowsLinkedTotal / liveRows.length : null;
  const equivalenceDecisionIdCoverage =
    equivalence.length > 0 ? equivalenceRowsWithDecisionId / equivalence.length : null;
  const paperDecisionIdCoverage =
    paperRowsWithCandidateId > 0 ? paperRowsWithDecisionId / paperRowsWithCandidateId : null;
  const paperRoleCoverage =
    paperRows.length > 0 ? paperRowsWithInferredPaperRole / paperRows.length : null;
  const paperExecutionPlanCoverage =
    paperRows.length > 0 ? paperRowsWithExecutionPlan / paperRows.length : null;
  const paperAttributedExecutionPlanCoverage =
    paperRowsWithInferredPaperRole > 0 ? paperAttributedRowsWithExecutionPlan / paperRowsWithInferredPaperRole : null;
  const liveDecisionIdCoverage =
    liveRowsLinkedTotal > 0 ? liveLinkedRowsWithDecisionId / liveRowsLinkedTotal : null;
  const liveExecutionPlanCoverage =
    liveRows.length > 0 ? liveRowsWithExecutionPlan / liveRows.length : null;
  const liveLinkedExecutionPlanCoverage =
    liveRowsLinkedTotal > 0 ? liveLinkedRowsWithExecutionPlan / liveRowsLinkedTotal : null;
  const liveAttributionBreakdown = {
    exact: liveRowsWithCandidateId,
    fallback: liveRowsLinkedByFallback,
    ambiguous: liveRowsAmbiguous,
    noCandidateFound: liveRowsNoCandidateFound,
    missingFields: liveRowsMissingAttributionFields,
  };
  const decisionAttributionWarnings = [
    ...(equivalence.length > 0 && (equivalenceDecisionIdCoverage ?? 0) < DECISION_ATTRIBUTION_MIN_COVERAGE
      ? [`equivalence decisionId coverage ${pct(equivalenceDecisionIdCoverage)} < ${pct(DECISION_ATTRIBUTION_MIN_COVERAGE)}`]
      : []),
    ...(paperRowsWithCandidateId > 0 && (paperDecisionIdCoverage ?? 0) < DECISION_ATTRIBUTION_MIN_COVERAGE
      ? [`paper candidate-linked decisionId coverage ${pct(paperDecisionIdCoverage)} < ${pct(DECISION_ATTRIBUTION_MIN_COVERAGE)}`]
      : []),
    ...(paperRows.length > 0 && (paperRoleCoverage ?? 0) < DECISION_ATTRIBUTION_MIN_COVERAGE
      ? [`paperRole coverage ${pct(paperRoleCoverage)} < ${pct(DECISION_ATTRIBUTION_MIN_COVERAGE)}`]
      : []),
    ...(liveRowsLinkedTotal > 0 && (liveDecisionIdCoverage ?? 0) < DECISION_ATTRIBUTION_MIN_COVERAGE
      ? [`live linked decisionId coverage ${pct(liveDecisionIdCoverage)} < ${pct(DECISION_ATTRIBUTION_MIN_COVERAGE)}`]
      : []),
    ...(paperRowsWithInferredPaperRole > 0 && (paperAttributedExecutionPlanCoverage ?? 0) < DECISION_ATTRIBUTION_MIN_COVERAGE
      ? [`paper attributed executionPlan coverage ${pct(paperAttributedExecutionPlanCoverage)} < ${pct(DECISION_ATTRIBUTION_MIN_COVERAGE)}`]
      : []),
    ...(liveRowsLinkedTotal > 0 && (liveLinkedExecutionPlanCoverage ?? 0) < DECISION_ATTRIBUTION_MIN_COVERAGE
      ? [`live linked executionPlan coverage ${pct(liveLinkedExecutionPlanCoverage)} < ${pct(DECISION_ATTRIBUTION_MIN_COVERAGE)}`]
      : []),
  ];
  const liveCandidateLinkGap =
    liveAttemptedRows > 0 &&
    liveRows.length > 0 &&
    (liveCandidateLinkCoverage ?? 0) < LIVE_CANDIDATE_LINK_MIN_COVERAGE;
  const verdict =
    equivalence.length === 0 && paperRows.length > 0
      ? 'INVESTIGATE'
      : equivalence.length === 0
        ? 'WATCH'
        : liveCandidateLinkGap
          ? 'DATA_GAP'
        : 'OK';
  const verdictReasons = [
    ...(liveCandidateLinkGap
      ? [
        `live candidateId link coverage ${pct(liveCandidateLinkCoverage)} < ${pct(LIVE_CANDIDATE_LINK_MIN_COVERAGE)} ` +
        `(${liveRowsLinkedTotal}/${liveRows.length}; exact=${liveRowsWithCandidateId}, fallback=${liveRowsLinkedByFallback}, ` +
        `ambiguous=${liveRowsAmbiguous}, noCandidate=${liveRowsNoCandidateFound}, missingFields=${liveRowsMissingAttributionFields})`,
      ]
      : []),
  ];

  const armRows = [...byArm.entries()]
    .sort((a, b) => b[1].rows - a[1].rows || a[0].localeCompare(b[0]));
  const paperRoleRows = [...byPaperRole.entries()]
    .sort((a, b) => b[1].closes - a[1].closes || a[0].localeCompare(b[0]));
  const decisionGapRows = [...decisionGapBuckets.entries()]
    .sort((a, b) => b[1].decisions - a[1].decisions || a[0].localeCompare(b[0]));
  const executionGuardBreakdownRows = [...executionGuardBuckets.entries()]
    .sort((a, b) => b[1].rows - a[1].rows || a[0].localeCompare(b[0]));
  const lines = [
    `# KOL Live Equivalence Report`,
    '',
    `- verdict: ${verdict}`,
    `- generatedAt: ${new Date().toISOString()}`,
    `- since: ${new Date(args.sinceMs).toISOString()}`,
    `- equivalence rows: ${equivalence.length}`,
    `- paper closes with candidateId: ${paperRowsWithCandidateId}`,
    `- equivalence rows with decisionId: ${equivalenceRowsWithDecisionId}`,
    `- paper closes with decisionId: ${paperRowsWithDecisionId}`,
    `- paper closes with paperRole: ${paperRowsWithPaperRole}`,
    `- paper closes with inferred paperRole: ${paperRowsWithInferredPaperRole}`,
    `- paper closes without inferred paperRole: ${paperRowsWithoutInferredPaperRole}`,
    `- paper closes with executionPlan: ${paperRowsWithExecutionPlan}`,
    `- paper attributed closes with executionPlan: ${paperAttributedRowsWithExecutionPlan}`,
    `- live closes: ${liveRows.length}`,
    `- live closes with candidateId: ${liveRowsWithCandidateId}`,
    `- live closes with decisionId: ${liveRowsWithDecisionId}`,
    `- live linked closes with decisionId: ${liveLinkedRowsWithDecisionId}`,
    `- live closes with executionPlan: ${liveRowsWithExecutionPlan}`,
    `- live linked closes with executionPlan: ${liveLinkedRowsWithExecutionPlan}`,
    `- live fallback-linked closes: ${liveRowsLinkedByFallback}`,
    `- live linked closes total: ${liveRowsLinkedTotal}`,
    `- unlinked live closes: ${unlinkedLiveRows}`,
    `- live candidateId link coverage: ${pct(liveCandidateLinkCoverage)}`,
    `- equivalence decisionId coverage: ${pct(equivalenceDecisionIdCoverage)}`,
    `- paper candidate-linked decisionId coverage: ${pct(paperDecisionIdCoverage)}`,
    `- paperRole coverage: ${pct(paperRoleCoverage)}`,
    `- paper executionPlan coverage: ${pct(paperExecutionPlanCoverage)}`,
    `- paper attributed executionPlan coverage: ${pct(paperAttributedExecutionPlanCoverage)}`,
    `- live linked decisionId coverage: ${pct(liveDecisionIdCoverage)}`,
    `- live executionPlan coverage: ${pct(liveExecutionPlanCoverage)}`,
    `- live linked executionPlan coverage: ${pct(liveLinkedExecutionPlanCoverage)}`,
    `- live attempted equivalence rows: ${liveAttemptedRows}`,
    `- execution guard sidecar rows: ${executionGuardRows.length}`,
    `- trade rows with executionGuard: ${tradeRowsWithExecutionGuard.length}`,
    `- reasons: ${verdictReasons.join('; ') || 'n/a'}`,
    `- attribution warnings: ${decisionAttributionWarnings.join('; ') || 'n/a'}`,
    '',
    '## Decision Stages',
    '',
    '| stage | count |',
    '|---|---:|',
    ...countBy(equivalence, 'decisionStage').slice(0, 20).map(([key, count]) => `| ${key} | ${count} |`),
    '',
    '## Decision Gap Drilldown',
    '',
    '| bucket | decisions | comparable paper closes | research closes | shadow closes | live closes | comparable paper net | research net | live net |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...decisionGapRows.map(([bucketName, bucket]) =>
      `| ${bucketName} | ${bucket.decisions} | ${bucket.comparablePaperCloses} | ${bucket.researchPaperCloses} | ${bucket.shadowPaperCloses} | ${bucket.liveCloses} | ${sol(bucket.comparablePaperNetSol)} | ${sol(bucket.researchPaperNetSol)} | ${sol(bucket.liveNetSol)} |`
    ),
    '',
    '## Execution Guard Breakdown',
    '',
    '| guard | rows | paper | live | fallback paper | reject | defer |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...executionGuardBreakdownRows.map(([guard, bucket]) =>
      `| ${guard} | ${bucket.rows} | ${bucket.paperRows} | ${bucket.liveRows} | ${bucket.fallbackPaperRows} | ${bucket.rejectRows} | ${bucket.deferRows} |`
    ),
    '',
    '## Paper Role Counts',
    '',
    '| role | paper closes |',
    '|---|---:|',
    ...paperRoleRows.map(([role, bucket]) => `| ${role} | ${bucket.closes} |`),
    '',
    '## Paper Role Outcomes',
    '',
    '| role | closes | W/L | net | token-only net | avg MFE |',
    '|---|---:|---:|---:|---:|---:|',
    ...paperRoleRows.map(([role, bucket]) => {
      const losses = bucket.closes - bucket.wins;
      return `| ${role} | ${bucket.closes} | ${bucket.wins}/${losses} | ${sol(bucket.netSol)} | ${sol(bucket.netSolTokenOnly)} | ${pct(bucket.avgMfePct)} |`;
    }),
    '',
    '## Live Block Reasons',
    '',
    '| reason | count |',
    '|---|---:|',
    ...countBy(equivalence.filter((row) => !bool(row, 'liveWouldEnter')), 'liveBlockReason')
      .slice(0, 20)
      .map(([key, count]) => `| ${key} | ${count} |`),
    '',
    '## Arm Summary',
    '',
    '| arm | rows | liveWould | attempted | blocked | paper W/L | paper net | token-only net | avg MFE | live closes | live net |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...armRows.map(([arm, bucket]) => {
      const losses = bucket.paperCloses - bucket.paperWins;
      return `| ${arm} | ${bucket.rows} | ${bucket.liveWouldEnter} | ${bucket.liveAttempted} | ${bucket.blocked} | ${bucket.paperWins}/${losses} | ${sol(bucket.paperNetSol)} | ${sol(bucket.paperNetSolTokenOnly)} | ${pct(bucket.paperAvgMfePct)} | ${bucket.liveCloses} | ${sol(bucket.liveNetSol)} |`;
    }),
    '',
  ];

  return {
    md: lines.join('\n'),
    json: {
      verdict,
      generatedAt: new Date().toISOString(),
      since: new Date(args.sinceMs).toISOString(),
      equivalenceRows: equivalence.length,
      paperRowsWithCandidateId,
      equivalenceRowsWithDecisionId,
      paperRowsWithDecisionId,
      paperRowsWithPaperRole,
      paperRowsWithInferredPaperRole,
      paperRowsWithoutInferredPaperRole,
      paperRowsWithExecutionPlan,
      paperAttributedRowsWithExecutionPlan,
      liveRows: liveRows.length,
      liveRowsWithCandidateId,
      liveRowsWithDecisionId,
      liveLinkedRowsWithDecisionId,
      liveRowsWithExecutionPlan,
      liveLinkedRowsWithExecutionPlan,
      liveRowsLinkedByFallback,
      liveRowsLinkedTotal,
      unlinkedLiveRows,
      liveCandidateLinkCoverage,
      equivalenceDecisionIdCoverage,
      paperDecisionIdCoverage,
      paperRoleCoverage,
      paperExecutionPlanCoverage,
      paperAttributedExecutionPlanCoverage,
      liveDecisionIdCoverage,
      liveExecutionPlanCoverage,
      liveLinkedExecutionPlanCoverage,
      liveAttributionBreakdown,
      executionGuardRows: executionGuardRows.length,
      tradeRowsWithExecutionGuard: tradeRowsWithExecutionGuard.length,
      executionGuardBreakdown: Object.fromEntries(executionGuardBreakdownRows),
      decisionAttributionWarnings,
      liveAttemptedRows,
      verdictReasons,
      decisionStages: Object.fromEntries(countBy(equivalence, 'decisionStage')),
      decisionGapDrilldown: Object.fromEntries(decisionGapRows),
      paperRoles: Object.fromEntries(paperRoleRows.map(([role, bucket]) => [role, bucket.closes])),
      paperRoleOutcomes: Object.fromEntries(paperRoleRows),
      liveBlockReasons: Object.fromEntries(countBy(equivalence.filter((row) => !bool(row, 'liveWouldEnter')), 'liveBlockReason')),
      arms: Object.fromEntries(armRows),
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildReport(args);
  if (args.md) {
    await mkdir(path.dirname(args.md), { recursive: true });
    await writeFile(args.md, report.md, 'utf8');
  }
  if (args.json) {
    await mkdir(path.dirname(args.json), { recursive: true });
    await writeFile(args.json, JSON.stringify(report.json, null, 2) + '\n', 'utf8');
  }
  if (!args.md && !args.json) {
    process.stdout.write(report.md + '\n');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export { buildReport, parseArgs };
