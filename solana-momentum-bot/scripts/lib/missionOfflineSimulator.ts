import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import {
  compactReturns,
  loadMarkoutCandidates,
  num,
  readJsonl,
  rounded,
  str,
} from './markoutCandidateStore';
import type { MissionOfflineSimulatorArgs } from './missionOfflineSimulatorArgs';
import type {
  AdmissionVetoRow,
  AdmissionVetoCombinationRow,
  ApiCostSummary,
  ApiCostActionRow,
  ApiCostSummaryRow,
  BaselineReplaySummary,
  ChronologicalSliceSummary,
  DataFileSummary,
  EvidenceRole,
  FinalDecisionRow,
  JoinMethod,
  JoinSummary,
  MicroCanaryRuinSummary,
  MissionDecisionState,
  MissionOfflineSimulatorReport,
  NetSource,
  ProbeFirstSummary,
  RoleSummary,
  RotationBridgeSummary,
  RotationCandidateCohortSummary,
  SmartV3QuarantineSummary,
} from './missionOfflineSimulatorTypes';

type JsonRow = Record<string, unknown>;

interface TradeRow {
  sourceFile: string;
  role: EvidenceRole;
  joinMethod: JoinMethod;
  positionId: string;
  parentPositionId: string;
  tokenMint: string;
  armName: string;
  exitReason: string;
  closedAt: string;
  ticketSol: number;
  postCostNetSol: number;
  postCostSource: NetSource;
  refundAdjustedNetSol: number;
  walletStressNetSol: number;
  stressSource: string;
  hasExecutionPlanHash: boolean;
  hasRouteProof: boolean;
  hasCostAware: boolean;
  kolIds: string[];
  mfePct: number | null;
  isLive: boolean;
}

interface CreditAccumulator {
  rows: number;
  credits: number;
  requests: number;
  byFeature: Map<string, ApiCostSummaryRow>;
  byPurpose: Map<string, ApiCostSummaryRow>;
}

const LIVE_TRADE_FILES = [
  'kol-live-trades.jsonl',
  'smart-v3-live-trades.jsonl',
  'rotation-v1-live-trades.jsonl',
  'pure-ws-live-trades.jsonl',
];

const PAPER_TRADE_FILES = [
  'kol-paper-trades.jsonl',
  'smart-v3-paper-trades.jsonl',
  'rotation-v1-paper-trades.jsonl',
  'pure-ws-paper-trades.jsonl',
  'capitulation-rebound-paper-trades.jsonl',
];

const BLEED_EXIT_REASONS = [
  'probe_hard_cut',
  'entry_advantage_emergency_exit',
  'rotation_dead_on_arrival',
  'smart_v3_mae_fast_fail',
];

const JOIN_METHODS: JoinMethod[] = [
  'decision_execution_plan',
  'candidate_id',
  'position_id',
  'parent_position_id',
  'tx_signature',
  'token_time',
  'unjoined',
];

function extrasOf(row: JsonRow): JsonRow {
  return typeof row.extras === 'object' && row.extras != null ? row.extras as JsonRow : {};
}

function valueStr(row: JsonRow, key: string): string {
  return str(row[key]) || str(extrasOf(row)[key]);
}

function valueNum(row: JsonRow, key: string): number | null {
  return num(row[key]) ?? num(extrasOf(row)[key]);
}

function valueBool(row: JsonRow, key: string): boolean | null {
  const value = row[key] ?? extrasOf(row)[key];
  return typeof value === 'boolean' ? value : null;
}

function isClosed(row: JsonRow): boolean {
  return valueStr(row, 'status') !== 'open';
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function rate(values: number[], predicate: (value: number) => boolean): number | null {
  return values.length === 0 ? null : rounded(values.filter(predicate).length / values.length);
}

function roleOf(row: JsonRow, sourceFile: string): EvidenceRole {
  if (sourceFile.includes('-live-') || valueBool(row, 'isLive') === true) return 'live';
  const paperRole = valueStr(row, 'paperRole');
  const armName = valueStr(row, 'armName');
  if (paperRole === 'mirror' || paperRole === 'paper_mirror' || paperRole === 'live_mirror') return 'paper_mirror';
  if (paperRole === 'fallback_execution_safety') return 'fallback_execution_safety';
  if (paperRole === 'research_arm' || armName.includes('chase_topup') || armName.includes('capitulation')) return 'research_arm';
  if (paperRole === 'paper_research') return 'paper_research';
  if (paperRole === 'no_trade_markout') return 'no_trade_markout';
  if (paperRole === 'diagnostic_only') return 'diagnostic_only';
  if (valueBool(row, 'isShadowArm') === true || armName.includes('shadow')) return 'shadow';
  return 'unknown_role';
}

function joinMethodOf(row: JsonRow): JoinMethod {
  if (valueStr(row, 'decisionId') && valueStr(row, 'executionPlanHash')) return 'decision_execution_plan';
  if (valueStr(row, 'candidateId')) return 'candidate_id';
  if (valueStr(row, 'positionId')) return 'position_id';
  if (valueStr(row, 'parentPositionId')) return 'parent_position_id';
  if (valueStr(row, 'entryTxSignature') || valueStr(row, 'exitTxSignature')) return 'tx_signature';
  if (valueStr(row, 'tokenMint') && (valueStr(row, 'closedAt') || valueNum(row, 'rotationEntryAtMs') != null)) return 'token_time';
  return 'unjoined';
}

function mfePctOf(row: JsonRow): number | null {
  return valueNum(row, 'actualMfePct') ??
    valueNum(row, 'mfePctPeakWalletBased') ??
    valueNum(row, 'mfePctPeakTokenOnly') ??
    valueNum(row, 'mfePctPeak') ??
    valueNum(row, 'mfePct');
}

function refundAdjustedNetOf(row: JsonRow): number {
  return valueNum(row, 'refundAdjustedNetSol') ??
    valueNum(row, 'refundAdjustedSol') ??
    valueNum(row, 'netSol') ??
    0;
}

function postCostNetOf(row: JsonRow, role: EvidenceRole): { value: number; source: NetSource } {
  if (role === 'live') {
    return {
      value: valueNum(row, 'walletDeltaSol') ?? valueNum(row, 'actualWalletNetSol') ?? valueNum(row, 'netSol') ?? 0,
      source: 'wallet_truth',
    };
  }
  if (valueNum(row, 'refundAdjustedNetSol') != null || valueNum(row, 'refundAdjustedSol') != null) {
    return {
      value: refundAdjustedNetOf(row),
      source: 'refund_adjusted',
    };
  }
  return {
    value: valueNum(row, 'netSol') ?? 0,
    source: 'paper_net',
  };
}

function walletStressOf(row: JsonRow, refundAdjustedNetSol: number, args: MissionOfflineSimulatorArgs): { value: number; source: string } {
  const reportStress = valueNum(row, 'walletDragStressSol') ?? valueNum(row, 'walletStressSol');
  if (reportStress != null) return { value: reportStress, source: 'report' };
  const ticketSol = valueNum(row, 'ticketSol') ?? 0.02;
  const stressCost = Math.max(args.minStressCostSol, ticketSol * args.stressCostPct);
  return {
    value: refundAdjustedNetSol - stressCost,
    source: `simulated_${args.stressCostPct}_min_${args.minStressCostSol}`,
  };
}

function tradeTime(row: JsonRow): string {
  return valueStr(row, 'closedAt') || valueStr(row, 'entryAt') || valueStr(row, 'createdAt');
}

function normalizeTradeRow(row: JsonRow, sourceFile: string, args: MissionOfflineSimulatorArgs): TradeRow {
  const role = roleOf(row, sourceFile);
  const postCost = postCostNetOf(row, role);
  const refundAdjustedNetSol = refundAdjustedNetOf(row);
  const stress = walletStressOf(row, refundAdjustedNetSol, args);
  return {
    sourceFile,
    role,
    joinMethod: joinMethodOf(row),
    positionId: valueStr(row, 'positionId'),
    parentPositionId: valueStr(row, 'parentPositionId'),
    tokenMint: valueStr(row, 'tokenMint'),
    armName: valueStr(row, 'armName'),
    exitReason: valueStr(row, 'exitReason'),
    closedAt: tradeTime(row),
    ticketSol: valueNum(row, 'ticketSol') ?? 0.02,
    postCostNetSol: postCost.value,
    postCostSource: postCost.source,
    refundAdjustedNetSol,
    walletStressNetSol: stress.value,
    stressSource: stress.source,
    hasExecutionPlanHash: Boolean(valueStr(row, 'executionPlanHash')),
    hasRouteProof: hasRouteProof(row),
    hasCostAware: hasCostAware(row),
    kolIds: kolIds(row),
    mfePct: mfePctOf(row),
    isLive: role === 'live',
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function survivalFlags(row: JsonRow): string[] {
  return [...stringArray(row.survivalFlags), ...stringArray(extrasOf(row).survivalFlags)];
}

function kolIds(row: JsonRow): string[] {
  const raw: unknown[] = Array.isArray(row.kols) ? row.kols : Array.isArray(extrasOf(row).kols) ? extrasOf(row).kols as unknown[] : [];
  const fromKols = raw.flatMap((item: unknown) => {
    if (typeof item === 'string') return [item];
    if (typeof item === 'object' && item != null) {
      const id = (item as JsonRow).id;
      return typeof id === 'string' && id ? [id] : [];
    }
    return [];
  });
  const anchors = stringArray(row.rotationAnchorKols ?? extrasOf(row).rotationAnchorKols);
  return [...new Set([...fromKols, ...anchors])];
}

function hasRouteProof(row: JsonRow): boolean {
  if (valueBool(row, 'routeProof') === true || valueBool(row, 'routeFound') === true || valueBool(row, 'sellRouteFound') === true) return true;
  if (valueStr(row, 'routeProof') || valueStr(row, 'entryRouteFound') || valueStr(row, 'sellRouteStatus') === 'ok') return true;
  return survivalFlags(row).some((flag) => flag.includes('ROUTE') && !flag.includes('NO_ROUTE') && !flag.includes('UNKNOWN'));
}

function hasCostAware(row: JsonRow): boolean {
  if (valueBool(row, 'costAware') === true || valueNum(row, 'roundTripCostSol') != null || valueNum(row, 'ataRentSol') != null) return true;
  const armName = valueStr(row, 'armName');
  const parameterVersion = valueStr(row, 'parameterVersion');
  return armName.includes('cost_aware') || parameterVersion.includes('cost-aware');
}

// 왜: lane projection ledger (smart-v3-*/rotation-v1-*)는 aggregate ledger
// (kol-live-trades/kol-paper-trades)의 positionId 부분집합을 같은 row 로 복제한다
// (lane-operating-refactor-2026-05-03). 단순 합산하면 동일 trade 의 net/승률/streak 이
// 이중 계상된다 (2026-06-10 edge audit M1: live 596 rows/-1.565 SOL → 실제 325/-0.803).
// first-wins dedup 이므로 입력 순서가 곧 우선순위다: aggregate 파일을 먼저 넣어
// aggregate row 를 보존하고, projection row 는 aggregate 에 없는 positionId 만 채운다.
// 같은 파일 안의 재기록 (kol-live 328 rows / 325 unique) 도 동일하게 한 번만 남는다.
export function dedupByPositionId<T extends { positionId: string; armName: string; isLive?: boolean }>(rows: T[]): T[] {
  const keptById = new Map<string, T>();
  const result: T[] = [];
  for (const row of rows) {
    if (!row.positionId) {
      // positionId 가 없으면 dedup 키가 없으므로 그대로 보존한다 (계상 누락 방지).
      result.push(row);
      continue;
    }
    // live/paper 는 별도 namespace — 이론상 cross-mode positionId 충돌이 생겨도
    // 한쪽 mode 의 정당한 row 를 떨어뜨리지 않도록 mode 를 키에 포함한다.
    const key = `${row.isLive === true ? 'L' : 'P'}:${row.positionId}`;
    const kept = keptById.get(key);
    if (kept == null) {
      keptById.set(key, row);
      result.push(row);
      continue;
    }
    // duplicate 는 net 계상에서 제외하되, 보존된 row 에 armName 이 비어 있으면
    // projection row 의 lane 정보로만 보강한다 (enrichment, 이중 계상 없음).
    if (!kept.armName && row.armName) kept.armName = row.armName;
  }
  return result;
}

async function loadTradeRows(args: MissionOfflineSimulatorArgs): Promise<{ rows: TradeRow[]; files: DataFileSummary[] }> {
  const files = [...LIVE_TRADE_FILES, ...PAPER_TRADE_FILES];
  const chunks = await Promise.all(files.map(async (file) => {
    const rows = (await readJsonl(path.join(args.realtimeDir, file))).filter(isClosed);
    return rows.map((row) => normalizeTradeRow(row, file, args));
  }));
  // Promise.all 은 files 선언 순서를 보존하므로 aggregate ledger 가 projection 보다
  // 먼저 dedup 에 들어간다 (first-wins = aggregate-우선).
  const rows = dedupByPositionId(chunks.flat());
  const dedupCountByFile = new Map<string, number>();
  for (const row of rows) dedupCountByFile.set(row.sourceFile, (dedupCountByFile.get(row.sourceFile) ?? 0) + 1);
  // rows = 실제 계상에 들어간 (dedup 후) row 수 — rawRows 와 동일 값 중복 표기를 피한다.
  const summaries: DataFileSummary[] = files.map((file, index) => ({
    file: `data/realtime/${file}`,
    rows: dedupCountByFile.get(file) ?? 0,
    rawRows: chunks[index].length,
    dedupRows: dedupCountByFile.get(file) ?? 0,
  }));
  return {
    rows,
    files: summaries.sort((a, b) => a.file.localeCompare(b.file)),
  };
}

function topWinnerShare(rows: TradeRow[], topN: number): number | null {
  const positives = rows.map((row) => row.postCostNetSol).filter((value) => value > 0).sort((a, b) => b - a);
  const grossPositive = sum(positives);
  if (grossPositive <= 0) return null;
  return rounded(sum(positives.slice(0, topN)) / grossPositive);
}

function maxDrawdown(rows: TradeRow[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const row of sortByTime(rows)) {
    equity += row.postCostNetSol;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity - peak);
  }
  return rounded(maxDd) ?? 0;
}

function maxLossStreak(rows: TradeRow[]): number {
  let current = 0;
  let max = 0;
  for (const row of sortByTime(rows)) {
    if (row.postCostNetSol <= 0) current += 1;
    else current = 0;
    max = Math.max(max, current);
  }
  return max;
}

function sortByTime(rows: TradeRow[]): TradeRow[] {
  return [...rows].sort((a, b) => Date.parse(a.closedAt || '') - Date.parse(b.closedAt || ''));
}

function activeDays(rows: TradeRow[]): number {
  return new Set(rows.map((row) => row.closedAt.slice(0, 10)).filter(Boolean)).size;
}

function buildJoinSummary(rows: TradeRow[]): JoinSummary {
  const counts = Object.fromEntries(JOIN_METHODS.map((method) => [method, 0])) as Record<JoinMethod, number>;
  for (const row of rows) counts[row.joinMethod] += 1;
  const joined = rows.filter((row) => row.joinMethod !== 'unjoined').length;
  const promotionGrade = rows.filter((row) => ['decision_execution_plan', 'candidate_id', 'position_id', 'parent_position_id'].includes(row.joinMethod)).length;
  return {
    inputRows: rows.length,
    eligibleRows: rows.length,
    joinedRows: joined,
    unjoinedRows: rows.length - joined,
    joinCoveragePct: rows.length > 0 ? rounded(joined / rows.length) : null,
    promotionGradeJoinCoveragePct: rows.length > 0 ? rounded(promotionGrade / rows.length) : null,
    joinMethodCounts: counts,
  };
}

function buildRoleSummaries(rows: TradeRow[]): RoleSummary[] {
  const map = new Map<EvidenceRole, TradeRow[]>();
  for (const row of rows) map.set(row.role, [...(map.get(row.role) ?? []), row]);
  return [...map.entries()]
    .map(([role, roleRows]) => ({
      role,
      rows: roleRows.length,
      netSol: rounded(sum(roleRows.map((row) => row.postCostNetSol))) ?? 0,
    }))
    .sort((a, b) => b.rows - a.rows);
}

function buildBaseline(rows: TradeRow[]): BaselineReplaySummary {
  const liveRows = rows.filter((row) => row.role === 'live');
  const paperRows = rows.filter((row) => row.role !== 'live');
  return {
    liveRows: liveRows.length,
    liveNetSol: rounded(sum(liveRows.map((row) => row.postCostNetSol))) ?? 0,
    paperRows: paperRows.length,
    paperNetSol: rounded(sum(paperRows.map((row) => row.postCostNetSol))) ?? 0,
    winRate: rate(rows.map((row) => row.postCostNetSol), (value) => value > 0),
    maxDrawdownSol: maxDrawdown(rows),
    maxLossStreak: maxLossStreak(rows),
    top5WinnerShare: topWinnerShare(rows, 5),
    top10WinnerShare: topWinnerShare(rows, 10),
    roleSummaries: buildRoleSummaries(rows),
    joinSummary: buildJoinSummary(rows),
  };
}

function buildAdmissionVeto(rows: TradeRow[]): AdmissionVetoRow[] {
  const baselineLiveNet = sum(rows.filter((row) => row.role === 'live').map((row) => row.postCostNetSol));
  return BLEED_EXIT_REASONS.map((reason) => {
    const vetoRows = rows.filter((row) => row.role === 'live' && row.exitReason === reason);
    const removedNet = sum(vetoRows.map((row) => row.postCostNetSol));
    const missed5x = vetoRows.filter((row) => (row.mfePct ?? 0) >= 4).length;
    const missed50 = vetoRows.filter((row) => (row.mfePct ?? 0) >= 0.5).length;
    return {
      reason,
      rows: vetoRows.length,
      removedNetSol: rounded(removedNet) ?? 0,
      savedLossSol: rounded(sum(vetoRows.map((row) => Math.max(0, -row.postCostNetSol)))) ?? 0,
      missedRunner50Count: missed50,
      missedRunner5xCount: missed5x,
      falseNegativeRate: vetoRows.length > 0 ? rounded(missed5x / vetoRows.length) : null,
      netAfterVetoSol: rounded(baselineLiveNet - removedNet) ?? 0,
    };
  }).filter((row) => row.rows > 0);
}

function combinations<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let mask = 1; mask < (1 << items.length); mask += 1) {
    const combo: T[] = [];
    for (let i = 0; i < items.length; i += 1) {
      if ((mask & (1 << i)) !== 0) combo.push(items[i]);
    }
    result.push(combo);
  }
  return result;
}

function buildAdmissionVetoCombinations(rows: TradeRow[]): AdmissionVetoCombinationRow[] {
  const liveRows = rows.filter((row) => row.role === 'live');
  const baselineLiveNet = sum(liveRows.map((row) => row.postCostNetSol));
  return combinations(BLEED_EXIT_REASONS)
    .map((reasons) => {
      const reasonSet = new Set(reasons);
      const vetoRows = liveRows.filter((row) => reasonSet.has(row.exitReason));
      const keptRows = liveRows.filter((row) => !reasonSet.has(row.exitReason));
      const removedNet = sum(vetoRows.map((row) => row.postCostNetSol));
      const missed5x = vetoRows.filter((row) => (row.mfePct ?? 0) >= 4).length;
      const missed50 = vetoRows.filter((row) => (row.mfePct ?? 0) >= 0.5).length;
      const netAfterVeto = baselineLiveNet - removedNet;
      const decisionReasons: string[] = [];
      if (vetoRows.length === 0) decisionReasons.push('no matching live rows');
      if (missed5x > 0) decisionReasons.push(`misses ${missed5x} 5x runners`);
      if (netAfterVeto <= 0) decisionReasons.push(`live net after veto ${netAfterVeto.toFixed(6)} <= 0`);
      if (maxLossStreak(keptRows) > 20) decisionReasons.push(`remaining max loss streak ${maxLossStreak(keptRows)} > 20`);
      const decision: MissionDecisionState = decisionReasons.length === 0 ? 'MICRO_CANARY_READY' : 'QUARANTINE';
      return {
        reason: reasons.join('+'),
        reasons,
        rows: vetoRows.length,
        removedNetSol: rounded(removedNet) ?? 0,
        savedLossSol: rounded(sum(vetoRows.map((row) => Math.max(0, -row.postCostNetSol)))) ?? 0,
        missedRunner50Count: missed50,
        missedRunner5xCount: missed5x,
        falseNegativeRate: vetoRows.length > 0 ? rounded(missed5x / vetoRows.length) : null,
        netAfterVetoSol: rounded(netAfterVeto) ?? 0,
        maxLossStreakAfterVeto: maxLossStreak(keptRows),
        decision,
        decisionReasons: decisionReasons.length > 0 ? decisionReasons : ['veto combination is historically wallet-positive without 5x leakage'],
      };
    })
    .filter((row) => row.rows > 0)
    .sort((a, b) => b.netAfterVetoSol - a.netAfterVetoSol)
    .slice(0, 10);
}

function buildProbeFirst(candidates: Awaited<ReturnType<typeof loadMarkoutCandidates>>['candidates'], stressCostPct: number): ProbeFirstSummary {
  const usable = candidates.filter((candidate) => candidate.deltas.has(15) && candidate.deltas.has(30) && candidate.deltas.has(300));
  const baseline = compactReturns(usable.map((candidate) => {
    const value = candidate.deltas.get(300);
    return value == null ? null : value - stressCostPct;
  }));
  const simulated = compactReturns(usable.map((candidate) => {
    const t15 = candidate.deltas.get(15);
    const t30 = candidate.deltas.get(30);
    const t300 = candidate.deltas.get(300);
    if (t15 == null || t30 == null || t300 == null) return null;
    if (t15 <= 0 && t30 <= 0) return t15 - stressCostPct;
    if (t30 >= 0.02 && t30 > 0) return t300 - stressCostPct;
    return t30 - stressCostPct;
  }));
  return {
    rows: usable.length,
    baselineMedianT300Pct: rounded(median(baseline)),
    simulatedMedianPct: rounded(median(simulated)),
    baselinePositiveRate: rate(baseline, (value) => value > 0),
    simulatedPositiveRate: rate(simulated, (value) => value > 0),
    fail15Rows: usable.filter((candidate) => (candidate.deltas.get(15) ?? 0) <= 0 && (candidate.deltas.get(30) ?? 0) <= 0).length,
    pass30Rows: usable.filter((candidate) => (candidate.deltas.get(30) ?? 0) >= 0.02).length,
    leakageVerdict: 'PASS',
  };
}

function buildRotationBridge(rows: TradeRow[], args: MissionOfflineSimulatorArgs): RotationBridgeSummary {
  const cohort = rows.filter((row) => row.armName === 'rotation_underfill_cost_aware_exit_v2');
  const postCostPositiveRatio = rate(cohort.map((row) => row.walletStressNetSol), (value) => value > 0);
  const top5 = topWinnerShare(cohort, 5);
  const top10 = topWinnerShare(cohort, 10);
  const reasons: string[] = [];
  const join = buildJoinSummary(cohort);
  const roleUnknownRate = cohort.length === 0 ? 0 : cohort.filter((row) => row.role === 'unknown_role').length / cohort.length;
  const executionPlanHashCoverage = cohort.length > 0 ? rounded(cohort.filter((row) => row.hasExecutionPlanHash).length / cohort.length) : null;
  const routeProofCoverage = cohort.length > 0 ? rounded(cohort.filter((row) => row.hasRouteProof).length / cohort.length) : null;
  const costAwareCoverage = cohort.length > 0 ? rounded(cohort.filter((row) => row.hasCostAware).length / cohort.length) : null;
  const comparableRoleCoverage = cohort.length > 0
    ? rounded(cohort.filter((row) => ['paper_mirror', 'fallback_execution_safety', 'live'].includes(row.role)).length / cohort.length)
    : null;
  const stressNet = rounded(sum(cohort.map((row) => row.walletStressNetSol))) ?? 0;
  if (cohort.length < args.minRows) reasons.push(`rows ${cohort.length} < ${args.minRows}`);
  if (activeDays(cohort) < args.minActiveDays) reasons.push(`active days ${activeDays(cohort)} < ${args.minActiveDays}`);
  if (stressNet <= 0) reasons.push(`wallet stress net ${stressNet.toFixed(6)} <= 0`);
  if ((postCostPositiveRatio ?? 0) < 0.52) reasons.push(`post-cost positive ratio ${((postCostPositiveRatio ?? 0) * 100).toFixed(1)}% < 52%`);
  if ((top5 ?? 0) > args.top5WinnerShareCap) reasons.push(`top5 winner share ${((top5 ?? 0) * 100).toFixed(1)}% > ${(args.top5WinnerShareCap * 100).toFixed(1)}%`);
  if (maxLossStreak(cohort) > 10) reasons.push(`max loss streak ${maxLossStreak(cohort)} > 10`);
  if ((join.promotionGradeJoinCoveragePct ?? 0) < 0.95) reasons.push(`promotion-grade join coverage ${((join.promotionGradeJoinCoveragePct ?? 0) * 100).toFixed(1)}% < 95%`);
  if (roleUnknownRate > 0.05) reasons.push(`unknown role ${(roleUnknownRate * 100).toFixed(1)}% > 5%`);
  if ((executionPlanHashCoverage ?? 0) < 0.95) reasons.push(`executionPlanHash coverage ${(((executionPlanHashCoverage ?? 0) * 100)).toFixed(1)}% < 95%`);
  if ((routeProofCoverage ?? 0) < 0.95) reasons.push(`route proof coverage ${(((routeProofCoverage ?? 0) * 100)).toFixed(1)}% < 95%`);
  if ((costAwareCoverage ?? 0) < 0.95) reasons.push(`cost-aware coverage ${(((costAwareCoverage ?? 0) * 100)).toFixed(1)}% < 95%`);
  if ((comparableRoleCoverage ?? 0) < 0.95) reasons.push(`comparable role coverage ${(((comparableRoleCoverage ?? 0) * 100)).toFixed(1)}% < 95%`);
  const chronologicalSlices = buildChronologicalSlices(cohort, args);
  const failingSlices = chronologicalSlices.filter((slice) => slice.verdict === 'FAIL').length;
  const candidateCohorts = buildRotationCandidateCohorts(cohort, args);
  if (failingSlices > 0) reasons.push(`chronological slices failed ${failingSlices}/${chronologicalSlices.length}`);
  return {
    rows: cohort.length,
    activeDays: activeDays(cohort),
    refundAdjustedNetSol: rounded(sum(cohort.map((row) => row.refundAdjustedNetSol))) ?? 0,
    walletStressNetSol: stressNet,
    postCostPositiveRatio,
    maxLossStreak: maxLossStreak(cohort),
    top5WinnerShare: top5,
    top10WinnerShare: top10,
    executionPlanHashCoveragePct: executionPlanHashCoverage,
    routeProofCoveragePct: routeProofCoverage,
    costAwareCoveragePct: costAwareCoverage,
    comparableRoleCoveragePct: comparableRoleCoverage,
    chronologicalSlices,
    candidateCohorts,
    stressSource: [...new Set(cohort.map((row) => row.stressSource))].join(',') || 'none',
    decision: reasons.length === 0 ? 'MICRO_CANARY_READY' : (cohort.length === 0 ? 'COLLECT_OFFLINE' : 'QUARANTINE'),
    reasons: reasons.length > 0 ? reasons : ['passes first-pass offline promotion contract'],
  };
}

function summarizeRotationCandidate(
  cohort: string,
  rows: TradeRow[],
  args: MissionOfflineSimulatorArgs,
  leakageVerdict: 'PASS' | 'FAIL'
): RotationCandidateCohortSummary {
  const postCostPositiveRatio = rate(rows.map((row) => row.walletStressNetSol), (value) => value > 0);
  const top5 = topWinnerShare(rows, 5);
  const top10 = topWinnerShare(rows, 10);
  const chronologicalSlices = buildChronologicalSlices(rows, args);
  const failedChronologicalSlices = chronologicalSlices.filter((slice) => slice.verdict === 'FAIL').length;
  const comparableRoleCoverage = rows.length > 0
    ? rounded(rows.filter((row) => ['paper_mirror', 'fallback_execution_safety', 'live'].includes(row.role)).length / rows.length)
    : null;
  const executionPlanHashCoverage = rows.length > 0 ? rounded(rows.filter((row) => row.hasExecutionPlanHash).length / rows.length) : null;
  const routeProofCoverage = rows.length > 0 ? rounded(rows.filter((row) => row.hasRouteProof).length / rows.length) : null;
  const costAwareCoverage = rows.length > 0 ? rounded(rows.filter((row) => row.hasCostAware).length / rows.length) : null;
  const stressNet = rounded(sum(rows.map((row) => row.walletStressNetSol))) ?? 0;
  const reasons: string[] = [];
  if (rows.length < args.minRows) reasons.push(`rows ${rows.length} < ${args.minRows}`);
  if (activeDays(rows) < args.minActiveDays) reasons.push(`active days ${activeDays(rows)} < ${args.minActiveDays}`);
  if (stressNet <= 0) reasons.push(`wallet stress net ${stressNet.toFixed(6)} <= 0`);
  if ((postCostPositiveRatio ?? 0) < 0.52) reasons.push(`positive ratio ${(((postCostPositiveRatio ?? 0) * 100)).toFixed(1)}% < 52%`);
  if (maxLossStreak(rows) > 10) reasons.push(`max loss streak ${maxLossStreak(rows)} > 10`);
  if ((top5 ?? 0) > args.top5WinnerShareCap) reasons.push(`top5 winner share ${(((top5 ?? 0) * 100)).toFixed(1)}% > ${(args.top5WinnerShareCap * 100).toFixed(1)}%`);
  if ((executionPlanHashCoverage ?? 0) < 0.95) reasons.push(`executionPlanHash coverage ${(((executionPlanHashCoverage ?? 0) * 100)).toFixed(1)}% < 95%`);
  if ((routeProofCoverage ?? 0) < 0.95) reasons.push(`route proof coverage ${(((routeProofCoverage ?? 0) * 100)).toFixed(1)}% < 95%`);
  if ((costAwareCoverage ?? 0) < 0.95) reasons.push(`cost-aware coverage ${(((costAwareCoverage ?? 0) * 100)).toFixed(1)}% < 95%`);
  if ((comparableRoleCoverage ?? 0) < 0.95) reasons.push(`comparable role coverage ${(((comparableRoleCoverage ?? 0) * 100)).toFixed(1)}% < 95%`);
  if (failedChronologicalSlices > 0) reasons.push(`chronological slices failed ${failedChronologicalSlices}/${chronologicalSlices.length}`);
  if (leakageVerdict === 'FAIL') reasons.push('leakage verdict FAIL: hypothesis-only cohort');
  return {
    cohort,
    rows: rows.length,
    activeDays: activeDays(rows),
    refundAdjustedNetSol: rounded(sum(rows.map((row) => row.refundAdjustedNetSol))) ?? 0,
    walletStressNetSol: stressNet,
    postCostPositiveRatio,
    maxLossStreak: maxLossStreak(rows),
    top5WinnerShare: top5,
    top10WinnerShare: top10,
    executionPlanHashCoveragePct: executionPlanHashCoverage,
    routeProofCoveragePct: routeProofCoverage,
    costAwareCoveragePct: costAwareCoverage,
    comparableRoleCoveragePct: comparableRoleCoverage,
    failedChronologicalSlices,
    leakageVerdict,
    decision: reasons.length === 0 ? 'MICRO_CANARY_READY' : (leakageVerdict === 'FAIL' ? 'RESEARCH_ONLY' : 'QUARANTINE'),
    reasons: reasons.length > 0 ? reasons : ['cohort passes offline candidate contract'],
  };
}

function buildRotationCandidateCohorts(cohort: TradeRow[], args: MissionOfflineSimulatorArgs): RotationCandidateCohortSummary[] {
  const comparableRoles = new Set<EvidenceRole>(['paper_mirror', 'fallback_execution_safety', 'live']);
  const candidates: Array<[string, TradeRow[], 'PASS' | 'FAIL']> = [
    ['v2_all', cohort, 'PASS'],
    ['v2_route_proof', cohort.filter((row) => row.hasRouteProof), 'PASS'],
    ['v2_comparable_role', cohort.filter((row) => comparableRoles.has(row.role)), 'PASS'],
    ['v2_route_cost_comparable', cohort.filter((row) => row.hasRouteProof && row.hasCostAware && comparableRoles.has(row.role)), 'PASS'],
    ['v2_kadenox_hypothesis', cohort.filter((row) => row.kolIds.includes('kadenox')), 'FAIL'],
  ];
  return candidates
    .map(([name, rows, leakage]) => summarizeRotationCandidate(name, rows, args, leakage))
    .sort((a, b) => {
      if (a.decision !== b.decision) return a.decision.localeCompare(b.decision);
      return b.walletStressNetSol - a.walletStressNetSol;
    });
}

function buildChronologicalSlices(rows: TradeRow[], args: MissionOfflineSimulatorArgs): ChronologicalSliceSummary[] {
  const sorted = sortByTime(rows).filter((row) => row.closedAt);
  if (sorted.length === 0) return [];
  const sliceCount = Math.min(4, sorted.length);
  const slices: ChronologicalSliceSummary[] = [];
  for (let i = 0; i < sliceCount; i += 1) {
    const startIdx = Math.floor((sorted.length * i) / sliceCount);
    const endIdx = Math.floor((sorted.length * (i + 1)) / sliceCount);
    const sliceRows = sorted.slice(startIdx, endIdx);
    const stressNet = rounded(sum(sliceRows.map((row) => row.walletStressNetSol))) ?? 0;
    const positiveRatio = rate(sliceRows.map((row) => row.walletStressNetSol), (value) => value > 0);
    const reasons: string[] = [];
    if (sliceRows.length < Math.max(1, Math.floor(args.minRows / 4))) reasons.push(`rows ${sliceRows.length} below slice minimum`);
    if (stressNet <= 0) reasons.push(`wallet stress net ${stressNet.toFixed(6)} <= 0`);
    if ((positiveRatio ?? 0) < 0.52) reasons.push(`positive ratio ${(((positiveRatio ?? 0) * 100)).toFixed(1)}% < 52%`);
    slices.push({
      slice: `Q${i + 1}`,
      start: sliceRows[0]?.closedAt ?? '',
      end: sliceRows[sliceRows.length - 1]?.closedAt ?? '',
      rows: sliceRows.length,
      activeDays: activeDays(sliceRows),
      walletStressNetSol: stressNet,
      postCostPositiveRatio: positiveRatio,
      maxLossStreak: maxLossStreak(sliceRows),
      verdict: sliceRows.length === 0 ? 'DATA_GAP' : (reasons.length === 0 ? 'PASS' : 'FAIL'),
      reasons: reasons.length > 0 ? reasons : ['slice is wallet-stress positive with acceptable positive ratio'],
    });
  }
  return slices;
}

function buildSmartV3(rows: TradeRow[]): SmartV3QuarantineSummary {
  const cohort = rows.filter((row) => row.armName.includes('smart_v3'));
  const liveRows = cohort.filter((row) => row.role === 'live');
  const net = rounded(sum(cohort.map((row) => row.postCostNetSol))) ?? 0;
  const runner5x = cohort.filter((row) => (row.mfePct ?? 0) >= 4).length;
  const reasons: string[] = [];
  if (net <= 0) reasons.push(`net ${net.toFixed(6)} <= 0`);
  if (liveRows.length > 0 && sum(liveRows.map((row) => row.postCostNetSol)) <= 0) reasons.push('live subset is not wallet-positive');
  if (runner5x === 0) reasons.push('no 5x MFE rows');
  return {
    rows: cohort.length,
    liveRows: liveRows.length,
    netSol: net,
    runner50Count: cohort.filter((row) => (row.mfePct ?? 0) >= 0.5).length,
    runner5xCount: runner5x,
    maxLossStreak: maxLossStreak(cohort),
    lossPer5xSol: runner5x > 0 ? rounded(Math.abs(Math.min(0, net)) / runner5x) : null,
    decision: reasons.length === 0 ? 'RESEARCH_ONLY' : 'QUARANTINE',
    reasons: reasons.length > 0 ? reasons : ['tail exists, but keep as research until paired wallet proof exists'],
  };
}

function addCost(map: Map<string, ApiCostSummaryRow>, key: string, credits: number, requests: number): void {
  const current = map.get(key) ?? { key, credits: 0, requests: 0, rows: 0 };
  current.credits += credits;
  current.requests += requests;
  current.rows += 1;
  map.set(key, current);
}

async function buildApiCost(realtimeDir: string): Promise<ApiCostSummary> {
  const acc: CreditAccumulator = {
    rows: 0,
    credits: 0,
    requests: 0,
    byFeature: new Map(),
    byPurpose: new Map(),
  };
  const file = path.join(realtimeDir, 'helius-credit-usage.jsonl');
  try {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as JsonRow;
        const credits = valueNum(row, 'estimatedCredits') ?? 0;
        const requests = valueNum(row, 'requestCount') ?? 0;
        acc.rows += 1;
        acc.credits += credits;
        acc.requests += requests;
        addCost(acc.byFeature, valueStr(row, 'feature') || 'unknown', credits, requests);
        addCost(acc.byPurpose, valueStr(row, 'purpose') || 'unknown', credits, requests);
      } catch {
        // Ignore malformed historical rows; report row count only for usable JSON.
      }
    }
  } catch {
    // Missing credit ledger is a data gap, not a script failure.
  }
  const top = (map: Map<string, ApiCostSummaryRow>) => [...map.values()].sort((a, b) => b.credits - a.credits).slice(0, 10)
    .map((row) => ({ ...row, credits: Math.round(row.credits), requests: Math.round(row.requests) }));
  const byFeature = top(acc.byFeature);
  const reasons: string[] = [];
  if (acc.rows === 0) reasons.push('no helius credit ledger rows');
  const dominant = byFeature[0];
  if (dominant && acc.credits > 0 && dominant.credits / acc.credits > 0.5) {
    reasons.push(`dominant feature ${dominant.key} consumes ${((dominant.credits / acc.credits) * 100).toFixed(1)}% of credits`);
  }
  return {
    rows: acc.rows,
    estimatedCredits: Math.round(acc.credits),
    byFeature,
    byPurpose: top(acc.byPurpose),
    actions: byFeature.map((row) => apiCostAction(row, acc.credits)),
    decision: reasons.length > 0 ? 'QUARANTINE' : 'RESEARCH_ONLY',
    reasons: reasons.length > 0 ? reasons : ['credit attribution available; compare against decision impact before re-enabling paid paths'],
  };
}

function apiCostAction(row: ApiCostSummaryRow, totalCredits: number): ApiCostActionRow {
  const share = totalCredits > 0 ? rounded(row.credits / totalCredits) : null;
  if (row.key === 'helius_ws_fallback_single') {
    return {
      feature: row.key,
      credits: row.credits,
      sharePct: share,
      action: 'disable_or_hard_cap',
      decision: 'KILL',
      reason: 'dominant fallback burn; not allowed to keep running without promotion-grade decision impact',
    };
  }
  if (row.key === 'executor_get_balance' || row.key === 'wallet_manager') {
    return {
      feature: row.key,
      credits: row.credits,
      sharePct: share,
      action: 'coalesce_or_cache',
      decision: 'QUARANTINE',
      reason: 'balance checks must be event-driven or cooldown-batched while live is paused',
    };
  }
  if (row.key === 'token_symbol_resolver') {
    return {
      feature: row.key,
      credits: row.credits,
      sharePct: share,
      action: 'coalesce_or_cache',
      decision: 'QUARANTINE',
      reason: 'symbol lookup is not promotion evidence; cache or skip in trading path',
    };
  }
  if (row.key === 'kol_wallet_tracker') {
    return {
      feature: row.key,
      credits: row.credits,
      sharePct: share,
      action: 'budget_queue',
      decision: 'RESEARCH_ONLY',
      reason: 'KOL enrichment is useful only as bounded offline/research input until a live cohort exists',
    };
  }
  if ((share ?? 0) >= 0.05) {
    return {
      feature: row.key,
      credits: row.credits,
      sharePct: share,
      action: 'budget_queue',
      decision: 'QUARANTINE',
      reason: 'large credit consumer requires explicit budget before paid collection resumes',
    };
  }
  return {
    feature: row.key,
    credits: row.credits,
    sharePct: share,
    action: 'keep_with_metering',
    decision: 'RESEARCH_ONLY',
    reason: 'small enough to keep metered, but still not live-promotion evidence by itself',
  };
}

function buildMicroCanary(rows: TradeRow[], args: MissionOfflineSimulatorArgs): MicroCanaryRuinSummary {
  const source = rows.filter((row) => row.armName === 'rotation_underfill_cost_aware_exit_v2');
  const sorted = sortByTime(source);
  const windowSize = args.microCanaryCloseTarget;
  const windows: number[] = [];
  for (let i = 0; i + windowSize <= sorted.length; i += 1) {
    windows.push(sum(sorted.slice(i, i + windowSize).map((row) => row.walletStressNetSol)));
  }
  const reasons: string[] = [];
  if (source.length < windowSize) reasons.push(`rows ${source.length} < window size ${windowSize}`);
  const ruinRate = windows.length > 0 ? rounded(windows.filter((value) => value <= -args.sleeveLossCapSol).length / windows.length) : null;
  const positiveRate = rate(windows, (value) => value > 0);
  if ((ruinRate ?? 1) > 0) reasons.push(`sleeve ruin rate ${(((ruinRate ?? 0) * 100)).toFixed(1)}% > 0%`);
  if ((positiveRate ?? 0) < 0.5) reasons.push(`positive window rate ${(((positiveRate ?? 0) * 100)).toFixed(1)}% < 50%`);
  return {
    sourceCohort: 'rotation_underfill_cost_aware_exit_v2',
    rows: source.length,
    windowSize,
    windows: windows.length,
    positiveWindowRate: positiveRate,
    sleeveRuinRate: ruinRate,
    worstWindowNetSol: windows.length > 0 ? rounded(Math.min(...windows)) : null,
    expectedWindowNetSol: rounded(median(windows)),
    decision: reasons.length === 0 ? 'MICRO_CANARY_READY' : (source.length === 0 ? 'COLLECT_OFFLINE' : 'QUARANTINE'),
    reasons: reasons.length > 0 ? reasons : ['historical windows stay within sleeve cap'],
  };
}

function finalDecisions(
  baseline: BaselineReplaySummary,
  rotationBridge: RotationBridgeSummary,
  smartV3: SmartV3QuarantineSummary,
  apiCost: ApiCostSummary,
  microCanary: MicroCanaryRuinSummary
): FinalDecisionRow[] {
  return [
    {
      cohort: 'broad_live_canary',
      decision: baseline.liveNetSol < 0 ? 'KILL' : 'QUARANTINE',
      reasons: baseline.liveNetSol < 0 ? [`live wallet-truth net ${baseline.liveNetSol.toFixed(6)} < 0`] : ['not enough paired proof for broad compounding'],
    },
    {
      cohort: 'rotation_underfill_cost_aware_exit_v2',
      decision: rotationBridge.decision,
      reasons: rotationBridge.reasons,
    },
    {
      cohort: 'smart_v3',
      decision: smartV3.decision,
      reasons: smartV3.reasons,
    },
    {
      cohort: 'helius_paid_collection',
      decision: apiCost.decision,
      reasons: apiCost.reasons,
    },
    {
      cohort: 'rotation_micro_canary',
      decision: microCanary.decision,
      reasons: microCanary.reasons,
    },
  ];
}

export async function buildMissionOfflineSimulatorReport(args: MissionOfflineSimulatorArgs): Promise<MissionOfflineSimulatorReport> {
  const [{ rows, files }, markout, apiCost] = await Promise.all([
    loadTradeRows(args),
    loadMarkoutCandidates(args.realtimeDir),
    buildApiCost(args.realtimeDir),
  ]);
  files.push(
    { file: 'data/realtime/trade-markout-anchors.jsonl', rows: markout.anchorRows.length },
    { file: 'data/realtime/trade-markouts.jsonl', rows: markout.markoutRows.length },
    { file: 'data/realtime/helius-credit-usage.jsonl', rows: apiCost.rows }
  );
  const baseline = buildBaseline(rows);
  const admissionVeto = buildAdmissionVeto(rows);
  const admissionVetoCombinations = buildAdmissionVetoCombinations(rows);
  const probeFirst = buildProbeFirst(markout.candidates, args.stressCostPct);
  const rotationBridge = buildRotationBridge(rows, args);
  const smartV3 = buildSmartV3(rows);
  const microCanary = buildMicroCanary(rows, args);
  return {
    generatedAt: new Date().toISOString(),
    realtimeDir: args.realtimeDir,
    reportsDir: args.reportsDir,
    protocol: 'docs/exec-plans/active/mission-reassessment-protocol-2026-05-22.md',
    dataFiles: files.sort((a, b) => a.file.localeCompare(b.file)),
    baseline,
    admissionVeto,
    admissionVetoCombinations,
    probeFirst,
    rotationBridge,
    smartV3,
    apiCost,
    microCanary,
    finalDecisions: finalDecisions(baseline, rotationBridge, smartV3, apiCost, microCanary),
  };
}
