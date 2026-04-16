import { RuntimeDiagnosticsStore, CapSuppressSnapshot } from './runtimeDiagnosticsStore';
import type { Cohort } from '../scanner/cohort';
import { createCohortRecord } from '../scanner/cohort';

export interface RuntimeDiagnosticsSummary {
  hours: number;
  admissionSkipCounts: Array<{ reason: string; count: number }>;
  admissionSkipDetailCounts: Array<{ label: string; count: number }>;
  aliasMissCounts: Array<{ pool: string; count: number }>;
  candidateEvictedCount: number;
  candidateReaddedWithinGraceCount: number;
  signalNotInWatchlistCount: number;
  signalNotInWatchlistRecentlyEvictedCount: number;
  missedTokens: Array<{
    tokenMint: string;
    evicted: number;
    readded: number;
    notInWatchlist: number;
    recentlyEvicted: number;
    admissionBlocked: number;
  }>;
  capacityCounts: Array<{ label: string; count: number }>;
  triggerStatsCounts: Array<{ label: string; count: number }>;
  latestTriggerStats?: { source: string; detail: string };
  bootstrapBoostedSignalCount: number;
  preWatchlistRejectCounts: Array<{ reason: string; count: number }>;
  preWatchlistRejectDetailCounts: Array<{ label: string; count: number }>;
  rateLimitCounts: Array<{ source: string; count: number }>;
  pollFailureCounts: Array<{ source: string; count: number }>;
  riskRejectionCounts: Array<{ reason: string; count: number }>;
  realtimeCandidateReadiness: {
    totalCandidates: number;
    prefiltered: number;
    admissionSkipped: number;
    ready: number;
    readinessRate: number;
  };
  /**
   * Phase 1 fresh-cohort instrumentation:
   *   funnel 단계별 (event_type) × cohort 이벤트 카운트.
   *   buildSummary 호출 시 cutoff 내 이벤트를 순회해 일괄 집계한다.
   */
  cohortCounts: Record<Cohort, Record<string, number>>;
}

export interface TodayUtcOperationalSummary {
  capSuppressedPairs: number;
  capSuppressedCandles: number;
}

export interface RuntimeDiagnosticEvent {
  type:
    | 'admission_skip'
    | 'pre_watchlist_reject'
    | 'realtime_candidate_seen'
    | 'rate_limit'
    | 'poll_failure'
    | 'capacity'
    | 'trigger_stats'
    | 'alias_miss'
    | 'candidate_evicted'
    | 'candidate_readded'
    | 'signal_not_in_watchlist'
    | 'risk_rejection'
    | 'cupsey_funnel';
  timestampMs: number;
  tokenMint?: string;
  reason?: string;
  source?: string;
  dexId?: string;
  detail?: string;
  /**
   * Phase 1 fresh-cohort instrumentation (optional).
   * Absent on legacy events; absent on events where cohort 판정이 불가능할 때는
   * 'unknown' 으로 명시하거나 생략할 수 있다.
   */
  cohort?: Cohort;
}

type RuntimeDecisionType = 'admission_skip' | 'pre_watchlist_reject';

export class RuntimeDiagnosticsTracker {
  private readonly events: RuntimeDiagnosticEvent[];
  private saveChain: Promise<void> = Promise.resolve();
  private lastPersistMs = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PERSIST_THROTTLE_MS = 30_000;
  private static readonly MAX_CAPACITY_EVENTS = 500;
  private static readonly MAX_EVENTS = 10_000;

  // Why: cap suppress는 이벤트 시스템과 분리 — UTC day scoped, store persist 포함
  private capSuppressStats = new Map<string, number>(); // pair → candle count
  private capSuppressUtcDay = -1;

  constructor(
    private readonly store?: RuntimeDiagnosticsStore,
    initialEvents: RuntimeDiagnosticEvent[] = [],
    initialCapSuppress?: CapSuppressSnapshot
  ) {
    this.events = [...initialEvents].sort((left, right) => left.timestampMs - right.timestampMs);
    this.prune();
    // restore: same UTC day면 복원, 아니면 무시 (day rollover)
    if (initialCapSuppress) {
      const todayUtcDay = Math.floor(Date.now() / 86_400_000);
      if (initialCapSuppress.utcDay === todayUtcDay) {
        this.capSuppressUtcDay = initialCapSuppress.utcDay;
        for (const [pair, count] of Object.entries(initialCapSuppress.stats)) {
          this.capSuppressStats.set(pair, count);
        }
      }
    }
  }

  recordAdmissionSkip(input: { tokenMint: string; reason: string; detail?: string; source?: string; dexId?: string; cohort?: Cohort }): void {
    this.pushEvent({
      type: 'admission_skip',
      timestampMs: Date.now(),
      tokenMint: input.tokenMint,
      reason: input.reason,
      detail: input.detail,
      source: input.source,
      dexId: input.dexId,
      cohort: input.cohort,
    });
  }

  recordPreWatchlistReject(input: { tokenMint: string; reason: string; detail?: string; source?: string; dexId?: string; cohort?: Cohort }): void {
    this.pushEvent({
      type: 'pre_watchlist_reject',
      timestampMs: Date.now(),
      tokenMint: input.tokenMint,
      reason: input.reason,
      detail: input.detail,
      source: input.source,
      dexId: input.dexId,
      cohort: input.cohort,
    });
  }

  recordRealtimeCandidateSeen(input: { tokenMint: string; source?: string; cohort?: Cohort }): void {
    this.pushEvent({
      type: 'realtime_candidate_seen',
      timestampMs: Date.now(),
      tokenMint: input.tokenMint,
      source: input.source,
      cohort: input.cohort,
    });
  }

  recordRateLimit(source: string): void {
    this.pushEvent({
      type: 'rate_limit',
      timestampMs: Date.now(),
      source,
    });
  }

  recordPollFailure(source: string): void {
    this.pushEvent({
      type: 'poll_failure',
      timestampMs: Date.now(),
      source,
    });
  }

  recordCapacity(input: { source: string; reason: string; detail?: string }): void {
    this.pushEvent({
      type: 'capacity',
      timestampMs: Date.now(),
      source: input.source,
      reason: input.reason,
      detail: input.detail,
    });
  }

  recordAliasMiss(pool: string): void {
    this.pushEvent({
      type: 'alias_miss',
      timestampMs: Date.now(),
      source: 'swap_handler',
      detail: `pool=${pool}`,
    });
  }

  recordCandidateEvicted(input: string | { tokenMint: string; reason?: string; detail?: string; cohort?: Cohort }): void {
    // Why: string overload 는 legacy 호출자용. 이 경로에서는 reason/detail/cohort 가 모두 부재하므로
    //      object literal 로 normalize 후 그대로 펼치면 cohort 는 자연스럽게 undefined 가 된다.
    const normalized: { tokenMint: string; reason?: string; detail?: string; cohort?: Cohort } =
      typeof input === 'string' ? { tokenMint: input } : input;
    this.pushEvent({
      type: 'candidate_evicted',
      timestampMs: Date.now(),
      tokenMint: normalized.tokenMint,
      reason: normalized.reason,
      detail: normalized.detail,
      cohort: normalized.cohort,
    });
  }

  recordCandidateReadded(tokenMint: string, detail?: string, cohort?: Cohort): void {
    this.pushEvent({
      type: 'candidate_readded',
      timestampMs: Date.now(),
      tokenMint,
      detail,
      cohort,
    });
  }

  recordSignalNotInWatchlist(tokenMint: string, detail?: string, cohort?: Cohort): void {
    this.pushEvent({
      type: 'signal_not_in_watchlist',
      timestampMs: Date.now(),
      tokenMint,
      detail,
      cohort,
    });
  }

  recordTriggerStats(detail: string, source = 'momentum_trigger'): void {
    this.pushEvent({
      type: 'trigger_stats',
      timestampMs: Date.now(),
      source,
      detail,
    });
  }

  recordRiskRejection(reason: string, detail?: string, cohort?: Cohort): void {
    this.pushEvent({
      type: 'risk_rejection',
      timestampMs: Date.now(),
      reason,
      detail,
      cohort,
    });
  }

  recordCupseyFunnel(detail: string): void {
    this.pushEvent({
      type: 'cupsey_funnel',
      timestampMs: Date.now(),
      source: 'cupsey_lane',
      detail,
    });
  }

  recordCapSuppressed(pairAddress: string): void {
    this.syncCapSuppressDay();
    this.capSuppressStats.set(pairAddress, (this.capSuppressStats.get(pairAddress) ?? 0) + 1);
    this.schedulePersist();
  }

  buildSummary(hours: number): RuntimeDiagnosticsSummary {
    const cutoffMs = Date.now() - hours * 3_600_000;
    const candidateTokens = distinctTokenSet(this.events, cutoffMs, 'realtime_candidate_seen');
    const prefilteredTokens = distinctTokenSet(this.events, cutoffMs, 'pre_watchlist_reject');
    const admissionSkippedTokens = distinctTokenSet(this.events, cutoffMs, 'admission_skip');
    const readyTokens = new Set(candidateTokens);
    for (const tokenMint of admissionSkippedTokens) {
      readyTokens.delete(tokenMint);
    }
    const totalCandidateTokens = new Set([
      ...candidateTokens,
      ...prefilteredTokens,
      ...admissionSkippedTokens,
    ]);

    return {
      hours,
      admissionSkipCounts: summarizeDecisionReasons(this.events, cutoffMs, 'admission_skip'),
      admissionSkipDetailCounts: summarizeDecisionDetails(this.events, cutoffMs, 'admission_skip'),
      aliasMissCounts: summarizeAliasMissCounts(this.events, cutoffMs),
      candidateEvictedCount: summarizeTokenEventCount(this.events, cutoffMs, 'candidate_evicted'),
      candidateReaddedWithinGraceCount: summarizeDetailEventCount(
        this.events,
        cutoffMs,
        'candidate_readded',
        'within_grace'
      ),
      signalNotInWatchlistCount: summarizeTokenEventCount(this.events, cutoffMs, 'signal_not_in_watchlist'),
      signalNotInWatchlistRecentlyEvictedCount: summarizeDetailEventCount(
        this.events,
        cutoffMs,
        'signal_not_in_watchlist',
        'recently_evicted'
      ),
      missedTokens: summarizeMissedTokens(this.events, cutoffMs),
      capacityCounts: summarizeHighFreqLabels(this.events, cutoffMs, 'capacity'),
      triggerStatsCounts: summarizeHighFreqLabels(this.events, cutoffMs, 'trigger_stats'),
      latestTriggerStats: findLatestTriggerStats(this.events, cutoffMs),
      bootstrapBoostedSignalCount: findLatestBootstrapBoostedSignalCount(this.events, cutoffMs),
      preWatchlistRejectCounts: summarizeDecisionReasons(this.events, cutoffMs, 'pre_watchlist_reject'),
      preWatchlistRejectDetailCounts: summarizeDecisionDetails(this.events, cutoffMs, 'pre_watchlist_reject'),
      rateLimitCounts: summarizeEventSources(this.events, cutoffMs, 'rate_limit'),
      pollFailureCounts: summarizeEventSources(this.events, cutoffMs, 'poll_failure'),
      riskRejectionCounts: summarizeRiskRejectionCounts(this.events, cutoffMs),
      realtimeCandidateReadiness: {
        totalCandidates: totalCandidateTokens.size,
        prefiltered: prefilteredTokens.size,
        admissionSkipped: admissionSkippedTokens.size,
        ready: readyTokens.size,
        readinessRate: totalCandidateTokens.size > 0 ? readyTokens.size / totalCandidateTokens.size : 0,
      },
      cohortCounts: summarizeCohortCounts(this.events, cutoffMs),
    };
  }

  buildTodayUtcOperationalSummary(): TodayUtcOperationalSummary {
    this.syncCapSuppressDay();
    return {
      capSuppressedPairs: this.capSuppressStats.size,
      capSuppressedCandles: [...this.capSuppressStats.values()].reduce((sum, n) => sum + n, 0),
    };
  }

  async flush(): Promise<void> {
    this.syncCapSuppressDay();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.lastPersistMs = Date.now();
    await this.persist();
  }

  private pushEvent(event: RuntimeDiagnosticEvent): void {
    this.events.push(event);
    this.prune();
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (!this.store) return;
    const now = Date.now();
    const elapsed = now - this.lastPersistMs;
    if (elapsed >= RuntimeDiagnosticsTracker.PERSIST_THROTTLE_MS) {
      this.lastPersistMs = now;
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      void this.persist();
    } else if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        this.lastPersistMs = Date.now();
        void this.persist();
      }, RuntimeDiagnosticsTracker.PERSIST_THROTTLE_MS - elapsed);
    }
  }

  private syncCapSuppressDay(nowMs = Date.now()): void {
    const utcDay = Math.floor(nowMs / 86_400_000);
    if (utcDay !== this.capSuppressUtcDay) {
      this.capSuppressStats.clear();
      this.capSuppressUtcDay = utcDay;
    }
  }

  private async persist(): Promise<void> {
    if (!this.store) return;
    const snapshot = [...this.events];
    const capSnapshot: CapSuppressSnapshot | undefined =
      this.capSuppressStats.size > 0
        ? { utcDay: this.capSuppressUtcDay, stats: Object.fromEntries(this.capSuppressStats) }
        : undefined;
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        await this.store?.save(snapshot, capSnapshot);
      });
    await this.saveChain;
  }

  private prune(): void {
    const cutoffMs = Date.now() - 48 * 3_600_000;
    // O(n) splice 대신 O(n²) shift 루프 제거
    let cutoffIndex = 0;
    while (cutoffIndex < this.events.length && this.events[cutoffIndex].timestampMs < cutoffMs) {
      cutoffIndex++;
    }
    if (cutoffIndex > 0) {
      this.events.splice(0, cutoffIndex);
    }
    // high-frequency 이벤트(capacity, trigger_stats, alias_miss) 과다 축적 방지
    const highFreqTypes: RuntimeDiagnosticEvent['type'][] = ['capacity', 'trigger_stats', 'alias_miss'];
    for (const hfType of highFreqTypes) {
      let count = 0;
      for (let i = this.events.length - 1; i >= 0; i--) {
        if (this.events[i].type === hfType) {
          count++;
          if (count > RuntimeDiagnosticsTracker.MAX_CAPACITY_EVENTS) {
            this.events.splice(i, 1);
          }
        }
      }
    }
    // 전체 이벤트 수 상한
    if (this.events.length > RuntimeDiagnosticsTracker.MAX_EVENTS) {
      this.events.splice(0, this.events.length - RuntimeDiagnosticsTracker.MAX_EVENTS);
    }
  }
}

function distinctTokenSet(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number,
  type: RuntimeDiagnosticEvent['type']
): Set<string> {
  const tokens = new Set<string>();
  for (const event of events) {
    if (event.type !== type || event.timestampMs < cutoffMs || !event.tokenMint) continue;
    tokens.add(event.tokenMint);
  }
  return tokens;
}

function summarizeEventSources(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number,
  type: 'rate_limit' | 'poll_failure'
): Array<{ source: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== type || event.timestampMs < cutoffMs || !event.source) continue;
    counts.set(event.source, (counts.get(event.source) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((left, right) => right.count - left.count || left.source.localeCompare(right.source));
}

function summarizeDecisionReasons(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number,
  type: RuntimeDecisionType
): Array<{ reason: string; count: number }> {
  const tokensByReason = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.type !== type || event.timestampMs < cutoffMs || !event.reason || !event.tokenMint) continue;
    const bucket = tokensByReason.get(event.reason) ?? new Set<string>();
    bucket.add(event.tokenMint);
    tokensByReason.set(event.reason, bucket);
  }
  return [...tokensByReason.entries()]
    .map(([reason, tokens]) => ({ reason, count: tokens.size }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function summarizeDecisionDetails(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number,
  type: RuntimeDecisionType
): Array<{ label: string; count: number }> {
  const tokensByLabel = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.type !== type || event.timestampMs < cutoffMs || !event.reason || !event.tokenMint) continue;
    const label = formatDecisionLabel(event);
    const bucket = tokensByLabel.get(label) ?? new Set<string>();
    bucket.add(event.tokenMint);
    tokensByLabel.set(label, bucket);
  }
  return [...tokensByLabel.entries()]
    .map(([label, tokens]) => ({ label, count: tokens.size }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function formatDecisionLabel(event: RuntimeDiagnosticEvent): string {
  const parts = [event.reason ?? 'unknown'];
  if (event.detail) parts.push(`detail=${event.detail}`);
  if (event.source) parts.push(`source=${event.source}`);
  if (event.dexId) parts.push(`dex=${event.dexId}`);
  return parts.join(' ');
}

function summarizeHighFreqLabels(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number,
  type: 'capacity' | 'trigger_stats'
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== type || event.timestampMs < cutoffMs) continue;
    const label = formatCapacityLabel(event);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function formatCapacityLabel(event: RuntimeDiagnosticEvent): string {
  const parts = [event.source ?? 'unknown'];
  if (event.reason) parts.push(`reason=${event.reason}`);
  if (event.detail) parts.push(`detail=${event.detail}`);
  return parts.join(' ');
}

function findLatestTriggerStats(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number
): { source: string; detail: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'trigger_stats' && event.timestampMs >= cutoffMs) {
      return { source: event.source ?? 'unknown', detail: event.detail ?? '' };
    }
  }
  return undefined;
}

function findLatestBootstrapBoostedSignalCount(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number
): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (
      event.type === 'trigger_stats' &&
      event.timestampMs >= cutoffMs &&
      event.source === 'bootstrap_trigger'
    ) {
      return parseBoostedSignalCount(event.detail);
    }
  }
  return 0;
}

function summarizeAliasMissCounts(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number
): Array<{ pool: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'alias_miss' || event.timestampMs < cutoffMs) continue;
    // detail format: "pool=<address>"
    const pool = event.detail?.replace(/^pool=/, '') ?? 'unknown';
    counts.set(pool, (counts.get(pool) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([pool, count]) => ({ pool, count }))
    .sort((left, right) => right.count - left.count);
}

function summarizeTokenEventCount(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number,
  type: 'candidate_evicted' | 'candidate_readded' | 'signal_not_in_watchlist'
): number {
  let count = 0;
  for (const event of events) {
    if (event.type !== type || event.timestampMs < cutoffMs || !event.tokenMint) continue;
    count++;
  }
  return count;
}

function summarizeDetailEventCount(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number,
  type: 'candidate_readded' | 'signal_not_in_watchlist',
  detail: string
): number {
  let count = 0;
  for (const event of events) {
    if (event.type !== type || event.timestampMs < cutoffMs || event.detail !== detail) continue;
    count++;
  }
  return count;
}

function summarizeMissedTokens(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number
): Array<{
  tokenMint: string;
  evicted: number;
  readded: number;
  notInWatchlist: number;
  recentlyEvicted: number;
  admissionBlocked: number;
}> {
  const counts = new Map<string, {
    tokenMint: string;
    evicted: number;
    readded: number;
    notInWatchlist: number;
    recentlyEvicted: number;
    admissionBlocked: number;
  }>();

  for (const event of events) {
    if (event.timestampMs < cutoffMs || !event.tokenMint) continue;
    const bucket = counts.get(event.tokenMint) ?? {
      tokenMint: event.tokenMint,
      evicted: 0,
      readded: 0,
      notInWatchlist: 0,
      recentlyEvicted: 0,
      admissionBlocked: 0,
    };
    if (event.type === 'candidate_evicted') {
      bucket.evicted++;
    } else if (event.type === 'candidate_readded') {
      bucket.readded++;
    } else if (event.type === 'signal_not_in_watchlist') {
      bucket.notInWatchlist++;
      if (event.detail === 'recently_evicted') {
        bucket.recentlyEvicted++;
      }
    } else if (event.type === 'admission_skip' && event.detail?.includes('all_pairs_blocked')) {
      bucket.admissionBlocked++;
    } else {
      continue;
    }
    counts.set(event.tokenMint, bucket);
  }

  return [...counts.values()]
    .filter((item) => item.notInWatchlist > 0 || item.admissionBlocked > 0)
    .sort((left, right) =>
      (right.notInWatchlist + right.admissionBlocked) - (left.notInWatchlist + left.admissionBlocked) ||
      right.recentlyEvicted - left.recentlyEvicted ||
      right.evicted - left.evicted ||
      left.tokenMint.localeCompare(right.tokenMint)
    )
    .slice(0, 5);
}

function parseBoostedSignalCount(detail?: string): number {
  if (!detail) return 0;
  const match = detail.match(/boosted=(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function summarizeRiskRejectionCounts(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number
): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'risk_rejection' || event.timestampMs < cutoffMs || !event.reason) continue;
    counts.set(event.reason, (counts.get(event.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

/**
 * Phase 1: cohort × event_type 카운트 집계.
 * - cohort 가 event 에 없으면 'unknown' 버킷으로 분류한다.
 * - 모든 cohort key 는 반드시 0 으로라도 초기화해 다운스트림 리포트가
 *   optional chain 없이 바로 읽을 수 있게 한다.
 */
function summarizeCohortCounts(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number
): Record<Cohort, Record<string, number>> {
  const result = createCohortRecord<Record<string, number>>(() => ({}));
  for (const event of events) {
    if (event.timestampMs < cutoffMs) continue;
    const cohort: Cohort = event.cohort ?? 'unknown';
    const bucket = result[cohort];
    bucket[event.type] = (bucket[event.type] ?? 0) + 1;
  }
  return result;
}
