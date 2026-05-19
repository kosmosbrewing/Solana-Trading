#!/usr/bin/env ts-node
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import type { RotationPromotionGateStatus } from './rotation-promotion-gatekeeper';

export type ReadinessTrendVerdict = 'NO_SAMPLE' | 'IMPROVING' | 'FLAT' | 'DETERIORATING';

interface Args {
  historyFile: string;
  limit: number;
  primaryWindowHours: number;
  jsonOut?: string;
  mdOut?: string;
}

interface HistoryWindow {
  windowHours: number | null;
  status: RotationPromotionGateStatus;
  currentUniqueCandidates: number;
  neededUniqueCandidates: number;
  currentActiveDays: number;
  neededActiveDays: number;
  currentPositiveDays: number;
  neededPositiveDays: number;
  walletStressSol: number;
  topWinnerShare: number | null;
  parentChildDeltaWalletStressSol: number;
  blockerDisposition?: string;
  dominantBlocker?: string | null;
  safeBridgeRows?: number;
  safeBridgeUniqueCandidates?: number;
  missingMetadataRows?: number;
}

export interface ReadinessHistoryRow {
  recordedAt: string;
  fingerprint?: string;
  status: RotationPromotionGateStatus;
  primaryWindowHours: number;
  nextAction: string;
  reasons: string[];
  blockerDisposition?: string;
  windows: HistoryWindow[];
}

export interface RotationPromotionReadinessTrendReport {
  generatedAt: string;
  verdict: ReadinessTrendVerdict;
  nextAction: string;
  primaryWindowHours: number;
  samples: number;
  firstRecordedAt: string | null;
  latestRecordedAt: string | null;
  first: HistoryWindow | null;
  latest: HistoryWindow | null;
  deltaNeededUniqueCandidates: number | null;
  deltaWalletStressSol: number | null;
  deltaTopWinnerShare: number | null;
  deltaParentChildWalletStressSol: number | null;
  topWinnerShareWorsened: boolean;
  parentChildDeltaMaintained: boolean;
  reasons: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    historyFile: path.join('data', 'research', 'rotation-promotion-readiness-history.jsonl'),
    limit: 20,
    primaryWindowHours: 168,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--history-file' && next) {
      args.historyFile = next;
      i += 1;
    } else if (arg.startsWith('--history-file=')) {
      args.historyFile = arg.slice('--history-file='.length);
    } else if (arg === '--limit' && next) {
      args.limit = Number(next);
      i += 1;
    } else if (arg.startsWith('--limit=')) {
      args.limit = Number(arg.slice('--limit='.length));
    } else if (arg === '--primary-window-hours' && next) {
      args.primaryWindowHours = Number(next);
      i += 1;
    } else if (arg.startsWith('--primary-window-hours=')) {
      args.primaryWindowHours = Number(arg.slice('--primary-window-hours='.length));
    } else if (arg === '--json-out' && next) {
      args.jsonOut = next;
      i += 1;
    } else if (arg.startsWith('--json-out=')) {
      args.jsonOut = arg.slice('--json-out='.length);
    } else if (arg === '--md-out' && next) {
      args.mdOut = next;
      i += 1;
    } else if (arg.startsWith('--md-out=')) {
      args.mdOut = arg.slice('--md-out='.length);
    }
  }
  return args;
}

function parseJsonl(text: string): ReadinessHistoryRow[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as ReadinessHistoryRow;
      } catch {
        return null;
      }
    })
    .filter((row): row is ReadinessHistoryRow => row != null && Array.isArray(row.windows));
}

async function readHistory(file: string): Promise<ReadinessHistoryRow[]> {
  try {
    return parseJsonl(await readFile(file, 'utf8'));
  } catch {
    return [];
  }
}

function primaryWindow(row: ReadinessHistoryRow, primaryWindowHours: number): HistoryWindow | null {
  return row.windows.find((window) => window.windowHours === primaryWindowHours) ??
    row.windows[row.windows.length - 1] ??
    null;
}

function roundForFingerprint(value: number | null | undefined): number | null {
  return value == null ? null : Number(value.toFixed(9));
}

export function readinessHistoryFingerprint(
  row: ReadinessHistoryRow,
  primaryWindowHours = 168
): string {
  const window = primaryWindow(row, primaryWindowHours);
  return JSON.stringify({
    primaryWindowHours: row.primaryWindowHours,
    window: window == null ? null : {
      windowHours: window.windowHours,
      currentUniqueCandidates: window.currentUniqueCandidates,
      neededUniqueCandidates: window.neededUniqueCandidates,
      currentActiveDays: window.currentActiveDays,
      neededActiveDays: window.neededActiveDays,
      currentPositiveDays: window.currentPositiveDays,
      neededPositiveDays: window.neededPositiveDays,
      walletStressSol: roundForFingerprint(window.walletStressSol),
      topWinnerShare: roundForFingerprint(window.topWinnerShare),
      parentChildDeltaWalletStressSol: roundForFingerprint(window.parentChildDeltaWalletStressSol),
    },
  });
}

export function dedupeReadinessHistoryRows(
  rows: ReadinessHistoryRow[],
  primaryWindowHours = 168
): ReadinessHistoryRow[] {
  const deduped: ReadinessHistoryRow[] = [];
  let previousFingerprint: string | null = null;
  for (const row of rows) {
    const fingerprint = readinessHistoryFingerprint(row, primaryWindowHours);
    if (fingerprint === previousFingerprint) continue;
    deduped.push(row);
    previousFingerprint = fingerprint;
  }
  return deduped;
}

function fmtDelta(value: number | null, digits = 6): string {
  if (value == null) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function fmtPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function buildRotationPromotionReadinessTrendReport(
  rows: ReadinessHistoryRow[],
  primaryWindowHours = 168,
  limit = 20
): RotationPromotionReadinessTrendReport {
  const distinctRows = dedupeReadinessHistoryRows(rows, primaryWindowHours);
  const scoped = distinctRows
    .slice(-Math.max(1, limit))
    .map((row) => ({ row, window: primaryWindow(row, primaryWindowHours) }))
    .filter((item): item is { row: ReadinessHistoryRow; window: HistoryWindow } => item.window != null);
  if (scoped.length < 2) {
    return {
      generatedAt: new Date().toISOString(),
      verdict: 'NO_SAMPLE',
      nextAction: 'collect at least two readiness history samples',
      primaryWindowHours,
      samples: scoped.length,
      firstRecordedAt: scoped[0]?.row.recordedAt ?? null,
      latestRecordedAt: scoped[0]?.row.recordedAt ?? null,
      first: scoped[0]?.window ?? null,
      latest: scoped[0]?.window ?? null,
      deltaNeededUniqueCandidates: null,
      deltaWalletStressSol: null,
      deltaTopWinnerShare: null,
      deltaParentChildWalletStressSol: null,
      topWinnerShareWorsened: false,
      parentChildDeltaMaintained: false,
      reasons: ['need at least two samples for trend'],
    };
  }

  const first = scoped[0];
  const latest = scoped[scoped.length - 1];
  const deltaNeeded = latest.window.neededUniqueCandidates - first.window.neededUniqueCandidates;
  const deltaWallet = latest.window.walletStressSol - first.window.walletStressSol;
  const deltaTopWinner = latest.window.topWinnerShare == null || first.window.topWinnerShare == null
    ? null
    : latest.window.topWinnerShare - first.window.topWinnerShare;
  const deltaParent = latest.window.parentChildDeltaWalletStressSol - first.window.parentChildDeltaWalletStressSol;
  const topWinnerShareWorsened = deltaTopWinner != null && deltaTopWinner > 0.02;
  const parentChildDeltaMaintained = latest.window.parentChildDeltaWalletStressSol > 0;
  const reasons: string[] = [];

  if (deltaNeeded < 0) reasons.push(`needed candidates improved by ${Math.abs(deltaNeeded)}`);
  if (deltaNeeded > 0) reasons.push(`needed candidates worsened by ${deltaNeeded}`);
  if (deltaWallet > 0) reasons.push(`wallet stress improved ${fmtDelta(deltaWallet)}`);
  if (deltaWallet < 0) reasons.push(`wallet stress weakened ${fmtDelta(deltaWallet)}`);
  if (topWinnerShareWorsened) reasons.push(`top winner share worsened ${fmtDelta(deltaTopWinner, 4)}`);
  if (!parentChildDeltaMaintained) reasons.push('parent-child wallet delta is non-positive');

  const verdict: ReadinessTrendVerdict = latest.window.status === 'REJECT' ||
    deltaNeeded > 0 ||
    latest.window.walletStressSol <= 0 ||
    topWinnerShareWorsened ||
    !parentChildDeltaMaintained
    ? 'DETERIORATING'
    : deltaNeeded < 0 || deltaWallet > 0.005 || deltaParent > 0.002
      ? 'IMPROVING'
      : 'FLAT';

  const nextAction = verdict === 'IMPROVING'
    ? 'keep live unchanged; continue collecting until gatekeeper reaches READY'
    : verdict === 'DETERIORATING'
      ? 'pause promotion expectation; inspect blocker/cohort drift before collecting more'
      : 'keep live unchanged; trend is flat, wait for more distinct bridge candidates';

  return {
    generatedAt: new Date().toISOString(),
    verdict,
    nextAction,
    primaryWindowHours,
    samples: scoped.length,
    firstRecordedAt: first.row.recordedAt,
    latestRecordedAt: latest.row.recordedAt,
    first: first.window,
    latest: latest.window,
    deltaNeededUniqueCandidates: deltaNeeded,
    deltaWalletStressSol: deltaWallet,
    deltaTopWinnerShare: deltaTopWinner,
    deltaParentChildWalletStressSol: deltaParent,
    topWinnerShareWorsened,
    parentChildDeltaMaintained,
    reasons: reasons.length > 0 ? reasons : ['no material readiness movement'],
  };
}

export function renderRotationPromotionReadinessTrendReport(
  report: RotationPromotionReadinessTrendReport
): string {
  const lines: string[] = [];
  lines.push('# Rotation Promotion Readiness Trend');
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- verdict: ${report.verdict}`);
  lines.push(`- primaryWindowHours: ${report.primaryWindowHours}`);
  lines.push(`- samples: ${report.samples}`);
  lines.push(`- nextAction: ${report.nextAction}`);
  lines.push(`- reasons: ${report.reasons.join('; ')}`);
  lines.push('');
  lines.push('| metric | first | latest | delta |');
  lines.push('|---|---:|---:|---:|');
  lines.push(`| neededUniqueCandidates | ${report.first?.neededUniqueCandidates ?? 'n/a'} | ` +
    `${report.latest?.neededUniqueCandidates ?? 'n/a'} | ${fmtDelta(report.deltaNeededUniqueCandidates, 0)} |`);
  lines.push(`| walletStressSol | ${report.first?.walletStressSol.toFixed(6) ?? 'n/a'} | ` +
    `${report.latest?.walletStressSol.toFixed(6) ?? 'n/a'} | ${fmtDelta(report.deltaWalletStressSol)} |`);
  lines.push(`| topWinnerShare | ${fmtPct(report.first?.topWinnerShare ?? null)} | ` +
    `${fmtPct(report.latest?.topWinnerShare ?? null)} | ${fmtDelta(report.deltaTopWinnerShare, 4)} |`);
  lines.push(`| parentChildDeltaWalletStressSol | ${report.first?.parentChildDeltaWalletStressSol.toFixed(6) ?? 'n/a'} | ` +
    `${report.latest?.parentChildDeltaWalletStressSol.toFixed(6) ?? 'n/a'} | ` +
    `${fmtDelta(report.deltaParentChildWalletStressSol)} |`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows = await readHistory(args.historyFile);
  const report = buildRotationPromotionReadinessTrendReport(rows, args.primaryWindowHours, args.limit);
  const md = renderRotationPromotionReadinessTrendReport(report);
  if (args.mdOut) {
    await mkdir(path.dirname(args.mdOut), { recursive: true });
    await writeFile(args.mdOut, md, 'utf8');
  }
  if (args.jsonOut) {
    await mkdir(path.dirname(args.jsonOut), { recursive: true });
    await writeFile(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (!args.mdOut) process.stdout.write(md);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
