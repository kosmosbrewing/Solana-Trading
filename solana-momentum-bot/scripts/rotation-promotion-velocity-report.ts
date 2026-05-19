#!/usr/bin/env ts-node
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

type VelocityVerdict = 'READY' | 'COLLECTING' | 'SLOW' | 'STALLED' | 'NO_SAMPLE';

interface Args {
  candidateReport: string;
  jsonOut?: string;
  mdOut?: string;
}

interface CandidateRow {
  closedAt?: string;
  candidateId?: string;
  tokenMint?: string;
  walletStressSol?: number;
}

interface NextNeededPacket {
  targetUniqueCandidates?: number;
  currentUniqueCandidates?: number;
  neededUniqueCandidates?: number;
}

interface CandidateReportInput {
  generatedAt?: string;
  sinceHours?: number | null;
  primaryBridgeNextNeededPacket?: NextNeededPacket;
  primaryBridgeRoster?: CandidateRow[];
}

export interface RotationPromotionVelocityReport {
  generatedAt: string;
  verdict: VelocityVerdict;
  nextAction: string;
  sourceGeneratedAt: string | null;
  sourceWindowHours: number | null;
  targetUniqueCandidates: number;
  currentUniqueCandidates: number;
  neededUniqueCandidates: number;
  firstCandidateAt: string | null;
  latestCandidateAt: string | null;
  activeDays: number;
  recent24hCandidates: number;
  reportRatePerDay: number;
  activeDayRatePerDay: number;
  recentRatePerDay: number;
  etaDays: number | null;
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

function timeMs(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function kstDay(valueMs: number): string {
  const kst = new Date(valueMs + 9 * 3600_000);
  return kst.toISOString().slice(0, 10);
}

function uniqueRoster(rows: CandidateRow[]): CandidateRow[] {
  const seen = new Set<string>();
  const out: CandidateRow[] = [];
  for (const row of rows) {
    const key = row.candidateId || row.tokenMint || row.closedAt;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

export function buildRotationPromotionVelocityReport(
  input: CandidateReportInput | null
): RotationPromotionVelocityReport {
  if (!input) {
    return {
      generatedAt: new Date().toISOString(),
      verdict: 'NO_SAMPLE',
      nextAction: 'generate rotation promotion candidate report first',
      sourceGeneratedAt: null,
      sourceWindowHours: null,
      targetUniqueCandidates: 30,
      currentUniqueCandidates: 0,
      neededUniqueCandidates: 30,
      firstCandidateAt: null,
      latestCandidateAt: null,
      activeDays: 0,
      recent24hCandidates: 0,
      reportRatePerDay: 0,
      activeDayRatePerDay: 0,
      recentRatePerDay: 0,
      etaDays: null,
      reasons: ['candidate report missing or invalid'],
    };
  }

  const roster = uniqueRoster(input.primaryBridgeRoster ?? [])
    .filter((row) => Number.isFinite(timeMs(row.closedAt)))
    .sort((a, b) => timeMs(a.closedAt) - timeMs(b.closedAt));
  const packet = input.primaryBridgeNextNeededPacket ?? {};
  const target = packet.targetUniqueCandidates ?? 30;
  const current = packet.currentUniqueCandidates ?? roster.length;
  const needed = Math.max(0, packet.neededUniqueCandidates ?? target - current);
  const times = roster.map((row) => timeMs(row.closedAt));
  const latestMs = times[times.length - 1];
  const firstMs = times[0];
  const activeDays = new Set(times.map(kstDay)).size;
  const sourceWindowHours = typeof input.sinceHours === 'number' ? input.sinceHours : null;
  const windowDays = sourceWindowHours != null && sourceWindowHours > 0 ? sourceWindowHours / 24 : Math.max(1, activeDays);
  const recent24hCandidates = Number.isFinite(latestMs)
    ? times.filter((value) => value >= latestMs - 24 * 3600_000).length
    : 0;
  const reportRatePerDay = current > 0 ? current / Math.max(1, windowDays) : 0;
  const activeDayRatePerDay = current > 0 ? current / Math.max(1, activeDays) : 0;
  const recentRatePerDay = recent24hCandidates;
  const etaRate = recentRatePerDay > 0 ? recentRatePerDay : activeDayRatePerDay > 0 ? activeDayRatePerDay : reportRatePerDay;
  const etaDays = needed === 0 ? 0 : etaRate > 0 ? needed / etaRate : null;
  const reasons: string[] = [];
  if (needed === 0) reasons.push('unique candidate target reached');
  else reasons.push(`need +${needed} unique bridge candidates`);
  if (recent24hCandidates === 0 && needed > 0) reasons.push('no candidate in latest roster-relative 24h');
  if (etaDays != null && etaDays > 7) reasons.push(`eta ${etaDays.toFixed(1)}d exceeds 7d`);
  if (activeDays < 3 && needed > 0) reasons.push(`active days ${activeDays} < 3`);

  const verdict: VelocityVerdict = current === 0
    ? 'NO_SAMPLE'
    : needed === 0
      ? 'READY'
      : recent24hCandidates === 0
        ? 'STALLED'
        : etaDays != null && etaDays > 7
          ? 'SLOW'
          : 'COLLECTING';
  const nextAction = verdict === 'READY'
    ? 'run gatekeeper and micro-canary preflight review; do not auto-enable live'
    : verdict === 'COLLECTING'
      ? 'keep live unchanged; candidate flow is collecting toward gate target'
      : verdict === 'SLOW'
        ? 'keep live unchanged; review whether gate is too narrow if velocity stays slow'
        : verdict === 'STALLED'
          ? 'keep live unchanged; inspect why safe bridge candidates stopped appearing'
          : 'keep live unchanged; no bridge sample exists';

  return {
    generatedAt: new Date().toISOString(),
    verdict,
    nextAction,
    sourceGeneratedAt: input.generatedAt ?? null,
    sourceWindowHours,
    targetUniqueCandidates: target,
    currentUniqueCandidates: current,
    neededUniqueCandidates: needed,
    firstCandidateAt: Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : null,
    latestCandidateAt: Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null,
    activeDays,
    recent24hCandidates,
    reportRatePerDay: round(reportRatePerDay),
    activeDayRatePerDay: round(activeDayRatePerDay),
    recentRatePerDay: round(recentRatePerDay),
    etaDays: etaDays == null ? null : round(etaDays),
    reasons,
  };
}

function fmt(value: number | null): string {
  return value == null ? 'n/a' : value.toFixed(2);
}

export function renderRotationPromotionVelocityReport(report: RotationPromotionVelocityReport): string {
  const lines: string[] = [];
  lines.push('# Rotation Promotion Candidate Velocity');
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- verdict: ${report.verdict}`);
  lines.push(`- nextAction: ${report.nextAction}`);
  lines.push(`- reasons: ${report.reasons.join('; ')}`);
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---:|');
  lines.push(`| unique candidates | ${report.currentUniqueCandidates}/${report.targetUniqueCandidates} |`);
  lines.push(`| needed unique candidates | ${report.neededUniqueCandidates} |`);
  lines.push(`| active days | ${report.activeDays} |`);
  lines.push(`| recent24h candidates | ${report.recent24hCandidates} |`);
  lines.push(`| report rate / day | ${report.reportRatePerDay.toFixed(2)} |`);
  lines.push(`| active-day rate / day | ${report.activeDayRatePerDay.toFixed(2)} |`);
  lines.push(`| recent rate / day | ${report.recentRatePerDay.toFixed(2)} |`);
  lines.push(`| ETA days | ${fmt(report.etaDays)} |`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const input = await readCandidateReport(args.candidateReport);
  const report = buildRotationPromotionVelocityReport(input);
  const md = renderRotationPromotionVelocityReport(report);
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
