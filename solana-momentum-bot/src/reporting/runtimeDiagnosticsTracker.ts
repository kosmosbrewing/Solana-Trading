import { RuntimeDiagnosticsStore } from './runtimeDiagnosticsStore';

export interface RuntimeDiagnosticsSummary {
  hours: number;
  admissionSkipCounts: Array<{ reason: string; count: number }>;
  admissionSkipDetailCounts: Array<{ label: string; count: number }>;
  capacityCounts: Array<{ label: string; count: number }>;
  preWatchlistRejectCounts: Array<{ reason: string; count: number }>;
  preWatchlistRejectDetailCounts: Array<{ label: string; count: number }>;
  rateLimitCounts: Array<{ source: string; count: number }>;
  pollFailureCounts: Array<{ source: string; count: number }>;
  realtimeCandidateReadiness: {
    totalCandidates: number;
    prefiltered: number;
    admissionSkipped: number;
    ready: number;
    readinessRate: number;
  };
}

export interface RuntimeDiagnosticEvent {
  type: 'admission_skip' | 'pre_watchlist_reject' | 'realtime_candidate_seen' | 'rate_limit' | 'poll_failure' | 'capacity';
  timestampMs: number;
  tokenMint?: string;
  reason?: string;
  source?: string;
  dexId?: string;
  detail?: string;
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

  constructor(
    private readonly store?: RuntimeDiagnosticsStore,
    initialEvents: RuntimeDiagnosticEvent[] = []
  ) {
    this.events = [...initialEvents].sort((left, right) => left.timestampMs - right.timestampMs);
    this.prune();
  }

  recordAdmissionSkip(input: { tokenMint: string; reason: string; detail?: string; source?: string; dexId?: string }): void {
    this.pushEvent({
      type: 'admission_skip',
      timestampMs: Date.now(),
      tokenMint: input.tokenMint,
      reason: input.reason,
      detail: input.detail,
      source: input.source,
      dexId: input.dexId,
    });
  }

  recordPreWatchlistReject(input: { tokenMint: string; reason: string; detail?: string; source?: string; dexId?: string }): void {
    this.pushEvent({
      type: 'pre_watchlist_reject',
      timestampMs: Date.now(),
      tokenMint: input.tokenMint,
      reason: input.reason,
      detail: input.detail,
      source: input.source,
      dexId: input.dexId,
    });
  }

  recordRealtimeCandidateSeen(input: { tokenMint: string; source?: string }): void {
    this.pushEvent({
      type: 'realtime_candidate_seen',
      timestampMs: Date.now(),
      tokenMint: input.tokenMint,
      source: input.source,
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
      capacityCounts: summarizeCapacityLabels(this.events, cutoffMs),
      preWatchlistRejectCounts: summarizeDecisionReasons(this.events, cutoffMs, 'pre_watchlist_reject'),
      preWatchlistRejectDetailCounts: summarizeDecisionDetails(this.events, cutoffMs, 'pre_watchlist_reject'),
      rateLimitCounts: summarizeEventSources(this.events, cutoffMs, 'rate_limit'),
      pollFailureCounts: summarizeEventSources(this.events, cutoffMs, 'poll_failure'),
      realtimeCandidateReadiness: {
        totalCandidates: totalCandidateTokens.size,
        prefiltered: prefilteredTokens.size,
        admissionSkipped: admissionSkippedTokens.size,
        ready: readyTokens.size,
        readinessRate: totalCandidateTokens.size > 0 ? readyTokens.size / totalCandidateTokens.size : 0,
      },
    };
  }

  async flush(): Promise<void> {
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

  private async persist(): Promise<void> {
    if (!this.store) return;
    const snapshot = [...this.events];
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        await this.store?.save(snapshot);
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
    // capacity 이벤트 과다 축적 방지
    let capacityCount = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === 'capacity') {
        capacityCount++;
        if (capacityCount > RuntimeDiagnosticsTracker.MAX_CAPACITY_EVENTS) {
          this.events.splice(i, 1);
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

function summarizeCapacityLabels(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'capacity' || event.timestampMs < cutoffMs) continue;
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
