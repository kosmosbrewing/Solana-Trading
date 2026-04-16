/* eslint-disable no-console */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

type RuntimeDiagnosticEvent = {
  type: string;
  timestampMs?: number;
  reason?: string;
  source?: string;
  dexId?: string;
  detail?: string;
};

type CurrentSession = {
  datasetDir: string;
  startedAt: string;
  tradingMode: string;
};

type RealtimeSignalRecord = {
  timestamp?: string;
  signalTimestamp?: string;
  pairAddress?: string;
  status?: string;
  filterReason?: string;
  processing?: {
    status?: string;
    filterReason?: string;
  };
};

async function main() {
  const args = process.argv.slice(2);
  const hours = Math.max(1, Number(getArg(args, '--hours') ?? '2'));
  const topN = Math.max(1, Number(getArg(args, '--top') ?? '10'));
  const realtimeRoot = path.resolve(getArg(args, '--data-dir') ?? process.env.REALTIME_DATA_DIR ?? 'data/realtime');
  const sessionPointer = readJson<CurrentSession>(path.join(realtimeRoot, 'current-session.json'));
  const runtimeDiagnostics = readJson<{
    updatedAt?: string;
    events?: RuntimeDiagnosticEvent[];
    capSuppress?: { utcDay?: number; stats?: Record<string, number> };
  }>(path.join(realtimeRoot, 'runtime-diagnostics.json'));

  const sessionDir = resolveSessionDir(realtimeRoot, sessionPointer.datasetDir);
  const signals = loadSignalsAcrossSessions(realtimeRoot);
  const events = runtimeDiagnostics.events ?? [];
  const latestObservedMs = resolveLatestObservedMs(events, signals, sessionPointer.startedAt);
  const cutoffMs = latestObservedMs - hours * 3_600_000;

  console.log('Realtime Ops Check');
  console.log('='.repeat(72));
  console.log(`Realtime root : ${realtimeRoot}`);
  console.log(`Session dir    : ${sessionDir}`);
  console.log(`Signal scope   : ${path.join(realtimeRoot, 'sessions')}/*/realtime-signals.jsonl`);
  console.log(`Mode           : ${sessionPointer.tradingMode}`);
  console.log(`Started at     : ${sessionPointer.startedAt}`);
  console.log(`Latest data    : ${new Date(latestObservedMs).toISOString()}`);
  console.log(`Window         : last ${hours}h`);

  printEvalSuppress(runtimeDiagnostics.capSuppress, topN);
  printRuntimeDiagnostics(events, cutoffMs, topN);
  printSignals(signals, cutoffMs, topN);
}

function printEvalSuppress(
  capSuppress: { utcDay?: number; stats?: Record<string, number> } | undefined,
  topN: number
) {
  const stats = capSuppress?.stats ?? {};
  const totalPairs = Object.keys(stats).length;
  const totalCandles = Object.values(stats).reduce((sum, count) => sum + count, 0);

  console.log('\nToday UTC Ops');
  console.log(`- eval suppress: ${totalPairs} pairs / ${totalCandles} candles skipped`);
  for (const [pair, count] of sortEntries(stats).slice(0, topN)) {
    console.log(`  ${pair} ${count}`);
  }
}

function printRuntimeDiagnostics(events: RuntimeDiagnosticEvent[], cutoffMs: number, topN: number) {
  const recent = events.filter((event) => (event.timestampMs ?? 0) >= cutoffMs);
  const aliasMiss = countBy(recent.filter((event) => event.type === 'alias_miss'), (event) =>
    event.reason || event.detail || event.source || 'unknown'
  );
  const preWatchlistReject = countBy(
    recent.filter((event) => event.type === 'pre_watchlist_reject'),
    (event) => [event.reason, event.source, event.dexId].filter(Boolean).join('|') || 'unknown'
  );
  const capacity = countBy(
    recent.filter((event) => event.type === 'capacity'),
    (event) => [event.source, event.reason].filter(Boolean).join('|') || 'unknown'
  );

  console.log('\nRuntime Diagnostics');
  console.log(`- events in window: ${recent.length}`);
  const latestCupseyFunnel = recent.filter((event) => event.type === 'cupsey_funnel').at(-1)?.detail;
  if (latestCupseyFunnel) {
    console.log(`- cupsey funnel: ${latestCupseyFunnel}`);
  }
  printCountSection('alias_miss top', aliasMiss, topN);
  printCountSection('pre_watchlist_reject top', preWatchlistReject, topN);
  printCountSection('capacity top', capacity, topN);
}

function printSignals(signals: RealtimeSignalRecord[], cutoffMs: number, topN: number) {
  const recent = signals.filter((signal) => {
    const timestampMs = resolveSignalTimestampMs(signal);
    return timestampMs >= cutoffMs;
  });
  const statusCounts = countBy(recent, (signal) => signal.processing?.status || signal.status || 'unknown');
  const topPairs = countBy(recent, (signal) => signal.pairAddress || 'unknown');
  const riskRejectReasons = countBy(
    recent.filter((signal) => (signal.processing?.status || signal.status) === 'risk_rejected'),
    (signal) => signal.processing?.filterReason || signal.filterReason || 'unknown'
  );

  console.log('\nRealtime Signals');
  console.log(`- signals in window: ${recent.length}`);
  printCountSection('status counts', statusCounts, topN);
  printCountSection('top signal pairs', topPairs, topN);
  printCountSection('risk reject reasons', riskRejectReasons, topN);
}

function printCountSection(title: string, counts: Record<string, number>, topN: number) {
  console.log(`- ${title}`);
  const sorted = sortEntries(counts);
  if (sorted.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const [label, count] of sorted.slice(0, topN)) {
    console.log(`  ${count} ${label}`);
  }
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function sortEntries(counts: Record<string, number>): Array<[string, number]> {
  return Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function resolveLatestObservedMs(
  events: RuntimeDiagnosticEvent[],
  signals: RealtimeSignalRecord[],
  startedAt: string
): number {
  const latestEventMs = events.reduce((max, event) => Math.max(max, event.timestampMs ?? 0), 0);
  const latestSignalMs = signals.reduce((max, signal) => {
    const timestampMs = resolveSignalTimestampMs(signal);
    return Math.max(max, timestampMs);
  }, 0);
  return Math.max(latestEventMs, latestSignalMs, new Date(startedAt).getTime());
}

function resolveSessionDir(realtimeRoot: string, datasetDir: string): string {
  if (fs.existsSync(datasetDir)) return datasetDir;
  return path.join(realtimeRoot, 'sessions', path.basename(datasetDir));
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function readJsonLines<T>(filePath: string): T[] {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function loadSignalsAcrossSessions(realtimeRoot: string): RealtimeSignalRecord[] {
  const sessionsRoot = path.join(realtimeRoot, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return [];
  const sessionDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(sessionsRoot, entry.name));

  const signals: RealtimeSignalRecord[] = [];
  for (const dir of sessionDirs) {
    const signalPath = path.join(dir, 'realtime-signals.jsonl');
    if (!fs.existsSync(signalPath)) continue;
    signals.push(...readJsonLines<RealtimeSignalRecord>(signalPath));
  }
  return signals;
}

function getArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function resolveSignalTimestampMs(signal: RealtimeSignalRecord): number {
  const raw = signal.signalTimestamp ?? signal.timestamp;
  return raw ? new Date(raw).getTime() : 0;
}

main().catch((error) => {
  console.error(`ops-realtime-check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
