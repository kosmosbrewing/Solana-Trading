import fs from 'fs';
import path from 'path';
import { shortenAddress } from '../notifier/formatting';

interface CurrentSession {
  datasetDir: string;
  startedAt: string;
}

interface RuntimeDiagnosticEvent {
  type: string;
  timestampMs?: number;
  detail?: string;
  reason?: string;
  source?: string;
}

interface RealtimeSignalRecord {
  id?: string;
  timestamp?: string;
  signalTimestamp?: string;
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

export interface SparseOpsSummary {
  windowHours: number;
  totalSignals: number;
  executedLiveSignals: number;
  diagnosticEvents: number;
  latestTriggerStats?: ParsedTriggerStats;
  aliasMissTop: Array<{ label: string; count: number }>;
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
  const aliasMiss = countBy(
    recentEvents.filter((event) => event.type === 'alias_miss'),
    (event) => event.reason || event.detail || event.source || 'unknown',
  );

  return {
    windowHours,
    totalSignals: signals.length,
    executedLiveSignals: signals.filter((signal) => (signal.processing?.status || signal.status) === 'executed_live').length,
    diagnosticEvents: recentEvents.length,
    latestTriggerStats: parseTriggerStats(latestTrigger),
    aliasMissTop: Object.entries(aliasMiss)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, topN)
      .map(([label, count]) => ({ label, count })),
  };
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

  if (summary.aliasMissTop.length > 0) {
    const aliasSummary = summary.aliasMissTop
      .map((entry) => `${shortenAddress(normalizeAliasLabel(entry.label))} ${entry.count}건`)
      .join(', ');
    lines.push(`- alias miss 상위: ${aliasSummary}`);
  }

  return lines.join('\n');
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
