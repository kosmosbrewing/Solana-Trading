import fs from 'fs';
import path from 'path';
import { shortenAddress } from '../notifier/formatting';
import type { Cohort } from '../scanner/cohort';
import { COHORT_ORDER, createCohortRecord } from '../scanner/cohort';

interface CurrentSession {
  datasetDir: string;
  startedAt: string;
}

/**
 * Internal shape of the diagnostic events consumed by the sparse summary.
 * Why: Exposed as a type-only export so downstream tests can construct fixtures
 *      without importing the full RuntimeDiagnosticEvent union from the tracker.
 */
export interface SparseOpsDiagnosticEvent {
  type: string;
  timestampMs?: number;
  tokenMint?: string;
  detail?: string;
  reason?: string;
  source?: string;
  // Phase 1 instrumentation — optional cohort label attached to funnel events
  cohort?: Cohort;
}

// Kept as an alias so existing call-sites continue to resolve the local name.
type RuntimeDiagnosticEvent = SparseOpsDiagnosticEvent;

interface RealtimeSignalRecord {
  id?: string;
  timestamp?: string;
  signalTimestamp?: string;
  pairAddress?: string;
  strategy?: string;
  status?: string;
  processing?: {
    status?: string;
  };
}

interface ParsedTriggerStats {
  evaluations?: number;
  signals?: number;
  sparseSignals?: number;
  boostedSignals?: number;
  sparseInsufficient?: number;
  idlePairSkipped?: number;
  activePairCount?: number;
  sparseDominantPairCount?: number;
}

export interface CohortFunnelBreakdown {
  candidateSeen: number;
  preWatchlistReject: number;
  admissionSkip: number;
  candidateEvicted: number;
  riskRejection: number;
}

export interface FreshnessSummary {
  idleSkipDelta: number;
  uniqueSignaledTickers: number;
  candidateSeen: number;
  candidateEvicted: number;
  idleEvicted: number;
  admissionSkip: number;
  admissionSkipByReason: Array<{ reason: string; count: number }>;
  topIdleOffenders: Array<{ pair: string; count: number }>;
  topIdleEvictedTickers: Array<{ tokenMint: string; count: number }>;
  /**
   * Phase 1 instrumentation — cohort × funnel 단계 카운트.
   * 24h 관찰 데이터로 fresh cohort 가 어느 funnel 단계에서 떨어지는지 판정한다.
   */
  byCohort: Record<Cohort, CohortFunnelBreakdown>;
}

export interface SparseOpsSummary {
  windowHours: number;
  totalSignals: number;
  executedLiveSignals: number;
  diagnosticEvents: number;
  latestTriggerStats?: ParsedTriggerStats;
  latestCupseyFunnel?: string;
  aliasMissTop: Array<{ label: string; count: number }>;
  freshness?: FreshnessSummary;
}

export function loadSparseOpsSummary(realtimeRoot: string, windowHours: number, topN = 3): SparseOpsSummary | undefined {
  const currentSessionPath = path.join(realtimeRoot, 'current-session.json');
  const runtimeDiagnosticsPath = path.join(realtimeRoot, 'runtime-diagnostics.json');
  if (!fs.existsSync(currentSessionPath) || !fs.existsSync(runtimeDiagnosticsPath)) {
    return undefined;
  }

  const current = readJson<CurrentSession>(currentSessionPath);
  const runtime = readJson<{ events?: RuntimeDiagnosticEvent[] }>(runtimeDiagnosticsPath);
  const events = runtime.events ?? [];
  const sessionDir = resolveSessionDir(realtimeRoot, current.datasetDir);
  const latestMs = Math.max(
    events.reduce((max, event) => Math.max(max, event.timestampMs ?? 0), 0),
    new Date(current.startedAt).getTime(),
  );
  const cutoffMs = latestMs - windowHours * 3_600_000;
  const signals = loadSignals(sessionDir).filter((signal) => resolveSignalTimestampMs(signal) >= cutoffMs);
  const recentEvents = events.filter((event) => (event.timestampMs ?? 0) >= cutoffMs);
  const latestTrigger = recentEvents.filter((event) => event.type === 'trigger_stats').at(-1)?.detail;
  const latestCupseyFunnel = recentEvents.filter((event) => event.type === 'cupsey_funnel').at(-1)?.detail;
  const aliasMiss = countBy(
    recentEvents.filter((event) => event.type === 'alias_miss'),
    (event) => event.reason || event.detail || event.source || 'unknown',
  );

  // ─── Freshness telemetry ───
  const candidateSeen = recentEvents.filter((e) => e.type === 'realtime_candidate_seen').length;
  const candidateEvictions = recentEvents.filter((e) => e.type === 'candidate_evicted');
  const candidateEvicted = candidateEvictions.length;
  const idleEvictedEvents = candidateEvictions.filter((e) => e.reason === 'idle');
  const admissionSkips = recentEvents.filter((e) => e.type === 'admission_skip');
  const admissionSkipByReason = Object.entries(
    countBy(admissionSkips, (e) => e.reason ?? e.detail ?? 'unknown')
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([reason, count]) => ({ reason, count }));

  // idleSkip delta: 첫 trigger_stats와 마지막 trigger_stats의 차이
  const triggerStatsEvents = recentEvents.filter((e) => e.type === 'trigger_stats');
  const firstTrigger = parseTriggerStats(triggerStatsEvents.at(0)?.detail);
  const lastTrigger = parseTriggerStats(triggerStatsEvents.at(-1)?.detail);
  const idleSkipDelta = (lastTrigger?.idlePairSkipped ?? 0) - (firstTrigger?.idlePairSkipped ?? 0);

  // unique signaled tickers: 시그널이 발생한 고유 pair 수
  const signaledPairs = new Set(signals.map((s) => s.pairAddress ?? s.id?.split(':')[1] ?? '').filter(Boolean));

  // per-pair idleSkip top offenders from trigger logs
  const topIdleOffenders = extractTopIdleOffenders(recentEvents, topN);
  const topIdleEvictedTickers = Object.entries(
    countBy(idleEvictedEvents, (e) => e.tokenMint ?? 'unknown')
  )
    .filter(([tokenMint]) => tokenMint !== 'unknown')
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([tokenMint, count]) => ({ tokenMint, count }));

  const byCohort = buildCohortFunnelBreakdown(recentEvents);

  return {
    windowHours,
    totalSignals: signals.length,
    executedLiveSignals: signals.filter((signal) => (signal.processing?.status || signal.status) === 'executed_live').length,
    diagnosticEvents: recentEvents.length,
    latestTriggerStats: parseTriggerStats(latestTrigger),
    latestCupseyFunnel,
    aliasMissTop: Object.entries(aliasMiss)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, topN)
      .map(([label, count]) => ({ label, count })),
    freshness: {
      idleSkipDelta,
      uniqueSignaledTickers: signaledPairs.size,
      candidateSeen,
      candidateEvicted,
      idleEvicted: idleEvictedEvents.length,
      admissionSkip: admissionSkips.length,
      admissionSkipByReason,
      topIdleOffenders,
      topIdleEvictedTickers,
      byCohort,
    },
  };
}

/**
 * Phase 1: cohort × funnel 단계별 count.
 * byCohort.fresh 가 꾸준히 0 이면 신생 pair 가 파이프라인에 전혀 닿지 못하고 있는 것.
 *
 * Exported (test only): 직접 단위 테스트 용.
 */
export function buildCohortFunnelBreakdown(
  events: RuntimeDiagnosticEvent[]
): Record<Cohort, CohortFunnelBreakdown> {
  const result = createCohortRecord<CohortFunnelBreakdown>(() => ({
    candidateSeen: 0,
    preWatchlistReject: 0,
    admissionSkip: 0,
    candidateEvicted: 0,
    riskRejection: 0,
  }));
  for (const event of events) {
    const bucket = result[event.cohort ?? 'unknown'];
    switch (event.type) {
      case 'realtime_candidate_seen':
        bucket.candidateSeen++;
        break;
      case 'pre_watchlist_reject':
        bucket.preWatchlistReject++;
        break;
      case 'admission_skip':
        bucket.admissionSkip++;
        break;
      case 'candidate_evicted':
        bucket.candidateEvicted++;
        break;
      case 'risk_rejection':
        bucket.riskRejection++;
        break;
      default:
        break;
    }
  }
  return result;
}

export function buildSparseOpsSummaryMessage(summary: SparseOpsSummary | undefined): string | undefined {
  if (!summary) return undefined;

  const lines = [
    `희박 거래 점검 (${summary.windowHours}h)`,
    `- 신호 ${summary.totalSignals}건 | 실제 진입 ${summary.executedLiveSignals}건 | 진단 이벤트 ${summary.diagnosticEvents}건`,
  ];

  if (summary.latestTriggerStats) {
    const trigger = summary.latestTriggerStats;
    const parts = [
      typeof trigger.evaluations === 'number' ? `평가 ${trigger.evaluations}회` : '',
      typeof trigger.signals === 'number' ? `신호 ${trigger.signals}건` : '',
      typeof trigger.sparseInsufficient === 'number' ? `희박 데이터 부족 ${trigger.sparseInsufficient}회` : '',
      typeof trigger.sparseSignals === 'number' ? `sparse 신호 ${trigger.sparseSignals}건` : '',
      typeof trigger.boostedSignals === 'number' ? `부스트 ${trigger.boostedSignals}건` : '',
      typeof trigger.idlePairSkipped === 'number' ? `idle skip ${trigger.idlePairSkipped}회` : '',
    ].filter(Boolean);
    if (parts.length > 0) {
      lines.push(`- 트리거: ${parts.join(' | ')}`);
    }
    if (typeof trigger.activePairCount === 'number' || typeof trigger.sparseDominantPairCount === 'number') {
      lines.push(`- 활성 pair ${trigger.activePairCount ?? '?'}개 | sparse 지배 pair ${trigger.sparseDominantPairCount ?? '?'}개`);
    }
    const diagnosis = diagnoseSparseState(trigger);
    if (diagnosis) {
      lines.push(`- 판단: ${diagnosis}`);
    }
  }

  if (summary.latestCupseyFunnel) {
    lines.push(`- cupsey funnel: ${summary.latestCupseyFunnel}`);
  }

  if (summary.aliasMissTop.length > 0) {
    const aliasSummary = summary.aliasMissTop
      .map((entry) => `${shortenAddress(normalizeAliasLabel(entry.label))} ${entry.count}건`)
      .join(', ');
    lines.push(`- alias miss 상위: ${aliasSummary}`);
  }

  // ─── Freshness 블록 ───
  if (summary.freshness) {
    const f = summary.freshness;
    lines.push('');
    lines.push(`Freshness (${summary.windowHours}h)`);
    lines.push(`- idleSkip delta: ${f.idleSkipDelta.toLocaleString()} | unique signaled tickers: ${f.uniqueSignaledTickers}`);
    lines.push(`- candidate turnover: seen=${f.candidateSeen} evicted=${f.candidateEvicted} idle_evicted=${f.idleEvicted} | admission_skip=${f.admissionSkip}`);
    if (f.admissionSkipByReason.length > 0) {
      const reasons = f.admissionSkipByReason.map((r) => `${r.reason}=${r.count}`).join(', ');
      lines.push(`- admission skip 사유: ${reasons}`);
    }
    if (f.topIdleEvictedTickers.length > 0) {
      const evicted = f.topIdleEvictedTickers
        .map((o) => `${shortenAddress(o.tokenMint)} ${o.count}건`)
        .join(', ');
      lines.push(`- top idle-evicted tickers: ${evicted}`);
    }
    if (f.topIdleOffenders.length > 0) {
      const offenders = f.topIdleOffenders.map((o) => `${shortenAddress(o.pair)} ${o.count.toLocaleString()}회`).join(', ');
      lines.push(`- top idle offenders: ${offenders}`);
    }
    // Phase 1: cohort breakdown block (fresh / mid / mature / unknown)
    const cohortLines = formatCohortBreakdownLines(f.byCohort);
    if (cohortLines.length > 0) {
      lines.push('');
      lines.push(`Cohort funnel (${summary.windowHours}h)`);
      lines.push(...cohortLines);
    }
  }

  return lines.join('\n');
}

function formatCohortBreakdownLines(
  byCohort: Record<Cohort, CohortFunnelBreakdown>
): string[] {
  const lines: string[] = [];
  for (const cohort of COHORT_ORDER) {
    const bucket = byCohort[cohort];
    const total =
      bucket.candidateSeen +
      bucket.preWatchlistReject +
      bucket.admissionSkip +
      bucket.candidateEvicted +
      bucket.riskRejection;
    if (total === 0) continue;
    lines.push(
      `- ${cohort}: seen=${bucket.candidateSeen} ` +
        `preRej=${bucket.preWatchlistReject} ` +
        `admSkip=${bucket.admissionSkip} ` +
        `evict=${bucket.candidateEvicted} ` +
        `riskRej=${bucket.riskRejection}`
    );
  }
  return lines;
}

function diagnoseSparseState(stats: ParsedTriggerStats): string | undefined {
  if (
    typeof stats.evaluations === 'number' &&
    stats.evaluations > 0 &&
    typeof stats.sparseInsufficient === 'number' &&
    stats.sparseInsufficient / stats.evaluations >= 0.7
  ) {
    return '희박 거래 데이터 부족이 우세함';
  }
  if (typeof stats.signals === 'number' && stats.signals === 0 && typeof stats.evaluations === 'number' && stats.evaluations > 0) {
    return '신호 부재 상태, trigger 조건 점검 필요';
  }
  if (typeof stats.sparseSignals === 'number' && stats.sparseSignals > 0) {
    return '희박 거래에서도 일부 신호는 유지 중';
  }
  return undefined;
}

function parseTriggerStats(detail?: string): ParsedTriggerStats | undefined {
  if (!detail) return undefined;
  return {
    evaluations: parseTriggerStat(detail, /evals=(\d+)/),
    signals: parseTriggerStat(detail, /signals=(\d+)/),
    sparseSignals: parseTriggerStat(detail, /sparse=(\d+)/),
    boostedSignals: parseTriggerStat(detail, /boosted=(\d+)/),
    sparseInsufficient: parseTriggerStat(detail, /sparseInsuf=(\d+)/),
    idlePairSkipped: parseTriggerStat(detail, /idleSkip=(\d+)/),
    activePairCount: parseTriggerStat(detail, /activePairs=(\d+)/),
    sparseDominantPairCount: parseTriggerStat(detail, /sparsePairs=(\d+)/),
  };
}

function parseTriggerStat(detail: string, pattern: RegExp): number | undefined {
  const match = detail.match(pattern);
  return match ? Number(match[1]) : undefined;
}

function normalizeAliasLabel(label: string): string {
  return label.startsWith('pool=') ? label.slice(5) : label;
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function loadSignals(sessionDir: string): RealtimeSignalRecord[] {
  const completed = loadJsonl(path.join(sessionDir, 'realtime-signals.jsonl'));
  const intents = loadJsonl(path.join(sessionDir, 'signal-intents.jsonl'));

  // Why: completed signals는 horizon 완료 후 기록 → 최근 ~300s 신호 누락.
  // signal-intents.jsonl에서 아직 completed에 없는 최근 intent를 병합.
  const completedIds = new Set(completed.map((signal) => signal.id ?? ''));
  const pendingIntents = intents.filter((intent) => !completedIds.has(intent.id ?? ''));
  return [...completed, ...pendingIntents];
}

function loadJsonl(filePath: string): RealtimeSignalRecord[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RealtimeSignalRecord);
}

function resolveSignalTimestampMs(signal: RealtimeSignalRecord): number {
  const raw = signal.signalTimestamp ?? signal.timestamp;
  return raw ? new Date(raw).getTime() : 0;
}

function resolveSessionDir(realtimeRoot: string, datasetDir: string): string {
  if (fs.existsSync(datasetDir)) return datasetDir;
  return path.join(realtimeRoot, 'sessions', path.basename(datasetDir));
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

/** trigger_stats 로그에서 per-pair idle offender 정보 추출 (topIdleSkip: ... 형태) */
function extractTopIdleOffenders(events: RuntimeDiagnosticEvent[], topN: number): Array<{ pair: string; count: number }> {
  // Why: trigger_stats 로그의 detail 필드에 topIdleSkip이 포함될 수 있음
  // 없으면 빈 배열 반환 — 이전 버전 호환
  const lastPerPairLog = events
    .filter((e) => e.type === 'trigger_stats' && e.detail?.includes('topIdleSkip'))
    .at(-1);
  if (!lastPerPairLog?.detail) return [];

  const match = lastPerPairLog.detail.match(/topIdleSkip:\s*([^\s]+)/);
  if (!match) return [];

  return match[1]
    .split(',')
    .map((entry) => {
      const [pair, countStr] = entry.split('=');
      return { pair: pair ?? '', count: Number(countStr) || 0 };
    })
    .filter((e) => e.pair && e.count > 0)
    .slice(0, topN);
}
