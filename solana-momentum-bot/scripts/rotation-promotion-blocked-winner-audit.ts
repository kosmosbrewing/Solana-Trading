#!/usr/bin/env ts-node
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

type BlockedWinnerVerdict = 'NO_BLOCKED_WINNERS' | 'CONCENTRATED_BLOCK_REASON' | 'DIVERSE_BLOCK_REASONS';

interface Args {
  candidateReport: string;
  jsonOut?: string;
  mdOut?: string;
}

interface CandidateRow {
  decisionId?: string;
  candidateId?: string;
  tokenMint?: string;
  exitReason?: string;
  refundAdjustedNetSol?: number;
  walletStressSol?: number;
}

interface CandidateReportInput {
  generatedAt?: string;
  sinceHours?: number | null;
  primaryBridgeRoster?: CandidateRow[];
}

interface BlockReasonRow {
  reason: string;
  rows: number;
  uniqueCandidates: number;
  refundAdjustedNetSol: number;
  walletStressSol: number;
  topExitReason: string | null;
}

export interface RotationPromotionBlockedWinnerAuditReport {
  generatedAt: string;
  verdict: BlockedWinnerVerdict;
  nextAction: string;
  sourceGeneratedAt: string | null;
  sourceWindowHours: number | null;
  rosterRows: number;
  positiveWalletRows: number;
  topReasonShare: number | null;
  reasonRows: BlockReasonRow[];
  reasons: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    candidateReport: path.join('reports', `rotation-promotion-candidates-7d-${new Date().toISOString().slice(0, 10)}.json`),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--candidate-report' && next) {
      args.candidateReport = next;
      i += 1;
    } else if (arg.startsWith('--candidate-report=')) {
      args.candidateReport = arg.slice('--candidate-report='.length);
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

async function readCandidateReport(file: string): Promise<CandidateReportInput | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CandidateReportInput;
  } catch {
    return null;
  }
}

function normalizedBlockReason(decisionId: string | undefined): string {
  if (!decisionId) return 'unknown';
  const marker = ':block:';
  const index = decisionId.indexOf(marker);
  const raw = index >= 0 ? decisionId.slice(index + marker.length) : decisionId;
  return raw
    .replace(/wallet_[0-9_]+_/g, 'wallet_*_')
    .replace(/[0-9]+\.[0-9]+/g, '*')
    .toLowerCase();
}

function uniqueKey(row: CandidateRow): string {
  return row.candidateId || row.tokenMint || row.decisionId || '';
}

function topExitReason(rows: CandidateRow[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const reason = row.exitReason || 'unknown';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return top?.[0] ?? null;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

export function buildRotationPromotionBlockedWinnerAuditReport(
  input: CandidateReportInput | null
): RotationPromotionBlockedWinnerAuditReport {
  const roster = input?.primaryBridgeRoster ?? [];
  const positiveRows = roster.filter((row) => (row.walletStressSol ?? 0) > 0);
  const byReason = new Map<string, CandidateRow[]>();
  for (const row of positiveRows) {
    const reason = normalizedBlockReason(row.decisionId);
    const current = byReason.get(reason) ?? [];
    current.push(row);
    byReason.set(reason, current);
  }
  const reasonRows = [...byReason.entries()]
    .map(([reason, rows]) => ({
      reason,
      rows: rows.length,
      uniqueCandidates: new Set(rows.map(uniqueKey).filter(Boolean)).size,
      refundAdjustedNetSol: round(rows.reduce((sum, row) => sum + (row.refundAdjustedNetSol ?? 0), 0)),
      walletStressSol: round(rows.reduce((sum, row) => sum + (row.walletStressSol ?? 0), 0)),
      topExitReason: topExitReason(rows),
    }))
    .sort((a, b) => b.rows - a.rows || b.walletStressSol - a.walletStressSol || a.reason.localeCompare(b.reason));
  const topReasonShare = positiveRows.length > 0 ? reasonRows[0].rows / positiveRows.length : null;
  const verdict: BlockedWinnerVerdict = positiveRows.length === 0
    ? 'NO_BLOCKED_WINNERS'
    : (topReasonShare ?? 0) >= 0.6
      ? 'CONCENTRATED_BLOCK_REASON'
      : 'DIVERSE_BLOCK_REASONS';
  const reasons = positiveRows.length === 0
    ? ['no positive wallet-stress blocked bridge rows']
    : [
      `${positiveRows.length} positive wallet-stress bridge rows were blocked before live`,
      `top reason share ${((topReasonShare ?? 0) * 100).toFixed(1)}%`,
    ];
  const topReason = reasonRows[0]?.reason ?? 'n/a';
  const nextAction = verdict === 'CONCENTRATED_BLOCK_REASON'
    ? `review targeted proof for block reason "${topReason}"; do not blanket loosen the gate`
    : verdict === 'DIVERSE_BLOCK_REASONS'
      ? 'keep collecting; blocked winners are not concentrated enough for a single gate change'
      : 'keep live unchanged; no blocked winner evidence exists';
  return {
    generatedAt: new Date().toISOString(),
    verdict,
    nextAction,
    sourceGeneratedAt: input?.generatedAt ?? null,
    sourceWindowHours: typeof input?.sinceHours === 'number' ? input.sinceHours : null,
    rosterRows: roster.length,
    positiveWalletRows: positiveRows.length,
    topReasonShare: topReasonShare == null ? null : round(topReasonShare),
    reasonRows,
    reasons,
  };
}

function fmtSol(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(6)}`;
}

function fmtPct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function renderRotationPromotionBlockedWinnerAuditReport(
  report: RotationPromotionBlockedWinnerAuditReport
): string {
  const lines: string[] = [];
  lines.push('# Rotation Promotion Blocked Winner Audit');
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- verdict: ${report.verdict}`);
  lines.push(`- nextAction: ${report.nextAction}`);
  lines.push(`- reasons: ${report.reasons.join('; ')}`);
  lines.push(`- topReasonShare: ${fmtPct(report.topReasonShare)}`);
  lines.push('');
  lines.push('| reason | rows | unique | walletStress | refund | topExit |');
  lines.push('|---|---:|---:|---:|---:|---|');
  for (const row of report.reasonRows) {
    lines.push(`| ${row.reason} | ${row.rows} | ${row.uniqueCandidates} | ` +
      `${fmtSol(row.walletStressSol)} | ${fmtSol(row.refundAdjustedNetSol)} | ${row.topExitReason ?? 'n/a'} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const input = await readCandidateReport(args.candidateReport);
  const report = buildRotationPromotionBlockedWinnerAuditReport(input);
  const md = renderRotationPromotionBlockedWinnerAuditReport(report);
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
