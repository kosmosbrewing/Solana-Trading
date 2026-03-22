import path from 'path';
import { readFile } from 'fs/promises';
import { RealtimeReplayStore } from '../realtime';
import { RealtimeAdmissionSnapshotEntry } from '../realtime/realtimeAdmissionTracker';
import { RealtimeMeasurementSummary, RealtimeSignalRecord, summarizeRealtimeSignals } from './realtimeMeasurement';

export interface RealtimeShadowStatusCount {
  status: string;
  count: number;
}

export interface RealtimeShadowReasonCount {
  reason: string;
  count: number;
}

export interface RealtimeShadowLatestSignal {
  id: string;
  pairAddress: string;
  signalTimestamp: string;
  completedAt: string;
  status: string;
  filterReason?: string;
  adjustedReturnPct?: number;
}

export interface RealtimeShadowAdmissionSummary {
  trackedPools: number;
  allowedPools: number;
  blockedPools: number;
  blockedDetails: Array<{
    pool: string;
    observedNotifications: number;
    parseRatePct: number;
    skippedRatePct: number;
  }>;
}

export interface RealtimeShadowReport {
  generatedAt: string;
  datasetDir: string;
  horizonSec: number;
  counts: {
    swaps: number;
    candles: number;
    signals: number;
  };
  summary: RealtimeMeasurementSummary;
  statusCounts: RealtimeShadowStatusCount[];
  reasonCounts: RealtimeShadowReasonCount[];
  latestSignal?: RealtimeShadowLatestSignal;
  admission?: RealtimeShadowAdmissionSummary;
}

export async function buildRealtimeShadowReport(options: {
  datasetDir: string;
  horizonSec?: number;
  admissionSnapshotPath?: string;
}): Promise<RealtimeShadowReport> {
  const datasetDir = path.resolve(options.datasetDir);
  const horizonSec = options.horizonSec ?? 180;
  const store = new RealtimeReplayStore(datasetDir);

  const [swaps, candles, signals, admission] = await Promise.all([
    store.loadSwaps(),
    store.loadCandles(),
    store.loadSignals(),
    loadAdmissionSummary(options.admissionSnapshotPath),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    datasetDir,
    horizonSec,
    counts: {
      swaps: swaps.length,
      candles: candles.length,
      signals: signals.length,
    },
    summary: summarizeRealtimeSignals(signals, horizonSec),
    statusCounts: buildStatusCounts(signals),
    reasonCounts: buildReasonCounts(signals),
    latestSignal: buildLatestSignal(signals, horizonSec),
    admission,
  };
}

async function loadAdmissionSummary(filePath?: string): Promise<RealtimeShadowAdmissionSummary | undefined> {
  if (!filePath) return undefined;

  try {
    const raw = await readFile(path.resolve(filePath), 'utf8');
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return undefined;

    const entries = parsed.entries.filter(isSnapshotEntry);
    const blocked = entries
      .filter((entry) => entry.blocked)
      .map((entry) => ({
        pool: entry.pool,
        observedNotifications: entry.observedNotifications,
        parseRatePct: entry.observedNotifications > 0
          ? Number((((entry.logParsed + (entry.fallbackParsed ?? 0)) / entry.observedNotifications) * 100).toFixed(2))
          : 0,
        skippedRatePct: entry.observedNotifications > 0
          ? Number(((entry.fallbackSkipped / entry.observedNotifications) * 100).toFixed(2))
          : 0,
      }))
      .sort((left, right) => right.observedNotifications - left.observedNotifications);

    return {
      trackedPools: entries.length,
      allowedPools: entries.filter((entry) => !entry.blocked).length,
      blockedPools: blocked.length,
      blockedDetails: blocked.slice(0, 5),
    };
  } catch {
    return undefined;
  }
}

function buildStatusCounts(signals: RealtimeSignalRecord[]): RealtimeShadowStatusCount[] {
  const counts = new Map<string, number>();
  for (const signal of signals) {
    counts.set(signal.processing.status, (counts.get(signal.processing.status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((left, right) => right.count - left.count || left.status.localeCompare(right.status));
}

function buildReasonCounts(signals: RealtimeSignalRecord[]): RealtimeShadowReasonCount[] {
  const counts = new Map<string, number>();
  for (const signal of signals) {
    const reason = signal.processing.filterReason || signal.gate.filterReason;
    if (!reason) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function buildLatestSignal(
  signals: RealtimeSignalRecord[],
  horizonSec: number
): RealtimeShadowLatestSignal | undefined {
  if (signals.length === 0) return undefined;
  const latest = [...signals].sort(
    (left, right) => Date.parse(right.summary.completedAt) - Date.parse(left.summary.completedAt)
  )[0];
  const horizon = latest.horizons.find((item) => item.horizonSec === horizonSec)
    ?? latest.horizons[latest.horizons.length - 1];
  return {
    id: latest.id,
    pairAddress: latest.pairAddress,
    signalTimestamp: latest.signalTimestamp,
    completedAt: latest.summary.completedAt,
    status: latest.processing.status,
    filterReason: latest.processing.filterReason || latest.gate.filterReason,
    adjustedReturnPct: horizon?.adjustedReturnPct,
  };
}

function isSnapshotEntry(value: unknown): value is RealtimeAdmissionSnapshotEntry {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.pool === 'string'
    && typeof row.observedNotifications === 'number'
    && typeof row.logParsed === 'number'
    && typeof row.fallbackSkipped === 'number'
    && typeof row.blocked === 'boolean';
}
