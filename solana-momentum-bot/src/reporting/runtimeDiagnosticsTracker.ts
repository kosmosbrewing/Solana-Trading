export interface RuntimeDiagnosticsSummary {
  hours: number;
  admissionSkipCounts: Array<{ reason: string; count: number }>;
  admissionSkipDetailCounts: Array<{ label: string; count: number }>;
  preWatchlistRejectCounts: Array<{ reason: string; count: number }>;
  preWatchlistRejectDetailCounts: Array<{ label: string; count: number }>;
  rateLimitCounts: Array<{ source: string; count: number }>;
  pollFailureCounts: Array<{ source: string; count: number }>;
  realtimeCandidateAcceptance: {
    accepted: number;
    prefiltered: number;
    acceptanceRate: number;
  };
}

interface RuntimeDiagnosticEvent {
  key: string;
  timestampMs: number;
}

interface RuntimeDecisionEvent {
  reason: string;
  source?: string;
  dexId?: string;
  timestampMs: number;
}

export class RuntimeDiagnosticsTracker {
  private readonly admissionSkips: RuntimeDecisionEvent[] = [];
  private readonly preWatchlistRejects: RuntimeDecisionEvent[] = [];
  private readonly realtimeCandidateAccepts: RuntimeDiagnosticEvent[] = [];
  private readonly rateLimits: RuntimeDiagnosticEvent[] = [];
  private readonly pollFailures: RuntimeDiagnosticEvent[] = [];

  recordAdmissionSkip(input: { reason: string; source?: string; dexId?: string }): void {
    this.admissionSkips.push({ ...input, timestampMs: Date.now() });
    this.prune();
  }

  recordPreWatchlistReject(input: { reason: string; source?: string; dexId?: string }): void {
    this.preWatchlistRejects.push({ ...input, timestampMs: Date.now() });
    this.prune();
  }

  recordRealtimeCandidateAccepted(source: string): void {
    this.realtimeCandidateAccepts.push({ key: source, timestampMs: Date.now() });
    this.prune();
  }

  recordRateLimit(source: string): void {
    this.rateLimits.push({ key: source, timestampMs: Date.now() });
    this.prune();
  }

  recordPollFailure(source: string): void {
    this.pollFailures.push({ key: source, timestampMs: Date.now() });
    this.prune();
  }

  buildSummary(hours: number): RuntimeDiagnosticsSummary {
    const cutoffMs = Date.now() - hours * 3_600_000;
    const accepted = countEvents(this.realtimeCandidateAccepts, cutoffMs);
    const prefiltered = countDecisionEvents(this.preWatchlistRejects, cutoffMs);
    return {
      hours,
      admissionSkipCounts: summarizeDecisionReasons(this.admissionSkips, cutoffMs),
      admissionSkipDetailCounts: summarizeDecisionDetails(this.admissionSkips, cutoffMs),
      preWatchlistRejectCounts: summarizeDecisionReasons(this.preWatchlistRejects, cutoffMs),
      preWatchlistRejectDetailCounts: summarizeDecisionDetails(this.preWatchlistRejects, cutoffMs),
      rateLimitCounts: summarizeEvents(this.rateLimits, cutoffMs, 'source'),
      pollFailureCounts: summarizeEvents(this.pollFailures, cutoffMs, 'source'),
      realtimeCandidateAcceptance: {
        accepted,
        prefiltered,
        acceptanceRate: accepted + prefiltered > 0 ? accepted / (accepted + prefiltered) : 0,
      },
    };
  }

  private prune(): void {
    const cutoffMs = Date.now() - 48 * 3_600_000;
    pruneDecisionEvents(this.admissionSkips, cutoffMs);
    pruneDecisionEvents(this.preWatchlistRejects, cutoffMs);
    pruneEvents(this.realtimeCandidateAccepts, cutoffMs);
    pruneEvents(this.rateLimits, cutoffMs);
    pruneEvents(this.pollFailures, cutoffMs);
  }
}

function summarizeEvents(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number,
  keyName: 'reason'
): Array<{ reason: string; count: number }>;
function summarizeEvents(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number,
  keyName: 'source'
): Array<{ source: string; count: number }>;
function summarizeEvents(
  events: RuntimeDiagnosticEvent[],
  cutoffMs: number,
  keyName: 'reason' | 'source'
): Array<{ reason?: string; source?: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.timestampMs < cutoffMs) continue;
    counts.set(event.key, (counts.get(event.key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => (keyName === 'reason' ? { reason: key, count } : { source: key, count }))
    .sort((left, right) => {
      const leftKey = keyName === 'reason' ? left.reason ?? '' : left.source ?? '';
      const rightKey = keyName === 'reason' ? right.reason ?? '' : right.source ?? '';
      return right.count - left.count || leftKey.localeCompare(rightKey);
    });
}

function summarizeDecisionReasons(
  events: RuntimeDecisionEvent[],
  cutoffMs: number
): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.timestampMs < cutoffMs) continue;
    counts.set(event.reason, (counts.get(event.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function summarizeDecisionDetails(
  events: RuntimeDecisionEvent[],
  cutoffMs: number
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.timestampMs < cutoffMs) continue;
    const label = formatDecisionLabel(event);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function formatDecisionLabel(event: RuntimeDecisionEvent): string {
  const parts = [event.reason];
  if (event.source) parts.push(`source=${event.source}`);
  if (event.dexId) parts.push(`dex=${event.dexId}`);
  return parts.join(' ');
}

function countEvents(events: RuntimeDiagnosticEvent[], cutoffMs: number): number {
  return events.filter((event) => event.timestampMs >= cutoffMs).length;
}

function countDecisionEvents(events: RuntimeDecisionEvent[], cutoffMs: number): number {
  return events.filter((event) => event.timestampMs >= cutoffMs).length;
}

function pruneEvents(events: RuntimeDiagnosticEvent[], cutoffMs: number): void {
  while (events.length > 0 && events[0].timestampMs < cutoffMs) {
    events.shift();
  }
}

function pruneDecisionEvents(events: RuntimeDecisionEvent[], cutoffMs: number): void {
  while (events.length > 0 && events[0].timestampMs < cutoffMs) {
    events.shift();
  }
}
