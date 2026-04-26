#!/usr/bin/env ts-node
/**
 * KOL Paper Arm Report
 *
 * Reads `kol-paper-trades.jsonl` directly. This is intentionally separate from
 * Lane Edge Controller P1, because P1 is wallet-truth/live-reconciled and must
 * not treat paper-only outcomes as Kelly-eligible.
 */
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

interface CliArgs {
  inputFile: string;
  mdOut?: string;
  jsonOut?: string;
  sinceMs?: number;
}

interface PaperTradeRecord {
  positionId: string;
  tokenMint: string;
  armName?: string;
  parameterVersion?: string;
  kolEntryReason?: string;
  kolConvictionLevel?: string;
  isShadowArm?: boolean;
  parentPositionId?: string | null;
  netSol?: number;
  netPct?: number;
  mfePctPeak?: number;
  maePct?: number;
  holdSec?: number;
  exitReason?: string;
  t1VisitAtSec?: number | null;
  t2VisitAtSec?: number | null;
  t3VisitAtSec?: number | null;
  closedAt?: string;
}

interface ArmSummary {
  armName: string;
  parameterVersions: string[];
  trades: number;
  shadowTrades: number;
  netSol: number;
  avgNetPct: number;
  winRate: number;
  t1Visits: number;
  t2Visits: number;
  t3Visits: number;
  avgMfePct: number;
  p90MfePct: number;
  avgMaePct: number;
  medianHoldSec: number;
  exitReasons: Record<string, number>;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const since = get('--since');
  const today = new Date().toISOString().slice(0, 10);
  return {
    inputFile: get('--in') ?? path.resolve(process.cwd(), 'data/realtime/kol-paper-trades.jsonl'),
    mdOut: get('--md') ?? path.resolve(process.cwd(), `reports/kol-paper-arms-${today}.md`),
    jsonOut: get('--json') ?? path.resolve(process.cwd(), `reports/kol-paper-arms-${today}.json`),
    sinceMs: since ? new Date(since).getTime() : undefined,
  };
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const raw = await readFile(file, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l) as T; } catch { return null; }
      })
      .filter((x): x is T => x !== null);
  } catch {
    return [];
  }
}

function armNameOf(row: PaperTradeRecord): string {
  const arm = row.armName ?? row.parameterVersion ?? 'unknown';
  if (!row.kolEntryReason) return arm;
  return `${arm}/${row.kolEntryReason}/${row.kolConvictionLevel ?? 'UNKNOWN'}`;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function mean(xs: number[]): number {
  return xs.length > 0 ? sum(xs) / xs.length : 0;
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[idx];
}

function summarizeArm(armName: string, rows: PaperTradeRecord[]): ArmSummary {
  const pnls = rows.map((r) => r.netSol).filter((v): v is number => typeof v === 'number');
  const decisive = pnls.filter((p) => p !== 0);
  const exitReasons: Record<string, number> = {};
  for (const r of rows) {
    const reason = r.exitReason ?? 'unknown';
    exitReasons[reason] = (exitReasons[reason] ?? 0) + 1;
  }
  return {
    armName,
    parameterVersions: [...new Set(rows.map((r) => r.parameterVersion).filter((v): v is string => !!v))].sort(),
    trades: rows.length,
    shadowTrades: rows.filter((r) => r.isShadowArm).length,
    netSol: sum(pnls),
    avgNetPct: mean(rows.map((r) => r.netPct ?? 0)),
    winRate: decisive.length > 0 ? decisive.filter((p) => p > 0).length / decisive.length : 0,
    t1Visits: rows.filter((r) => r.t1VisitAtSec != null).length,
    t2Visits: rows.filter((r) => r.t2VisitAtSec != null).length,
    t3Visits: rows.filter((r) => r.t3VisitAtSec != null).length,
    avgMfePct: mean(rows.map((r) => r.mfePctPeak ?? 0)),
    p90MfePct: quantile(rows.map((r) => r.mfePctPeak ?? 0), 0.9),
    avgMaePct: mean(rows.map((r) => r.maePct ?? 0)),
    medianHoldSec: quantile(rows.map((r) => r.holdSec ?? 0), 0.5),
    exitReasons,
  };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function sol(v: number): string {
  return v.toFixed(6);
}

function formatMarkdown(rows: PaperTradeRecord[], summaries: ArmSummary[]): string {
  const lines: string[] = [];
  lines.push(`# KOL Paper Arm Report - ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('> Paper-only arm comparison. This does not unlock Kelly, sizing, or live throttle.');
  lines.push('');
  lines.push(`- Total paper closes: ${rows.length}`);
  lines.push(`- Arms: ${summaries.length}`);
  lines.push('');
  lines.push('| Arm | Trades | Shadow | Net SOL | Win Rate | Avg Net | T1 | T2 | T3 | Avg MFE | P90 MFE | Avg MAE | Median Hold |');
  lines.push('|-----|--------|--------|---------|----------|---------|----|----|----|---------|---------|---------|-------------|');
  for (const s of summaries) {
    lines.push(
      `| ${s.armName} | ${s.trades} | ${s.shadowTrades} | ${sol(s.netSol)} | ${pct(s.winRate)} | ` +
      `${pct(s.avgNetPct)} | ${s.t1Visits} | ${s.t2Visits} | ${s.t3Visits} | ${pct(s.avgMfePct)} | ` +
      `${pct(s.p90MfePct)} | ${pct(s.avgMaePct)} | ${s.medianHoldSec.toFixed(0)}s |`
    );
  }
  lines.push('');
  lines.push('## Exit Reasons');
  lines.push('');
  for (const s of summaries) {
    const reasons = Object.entries(s.exitReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason}=${n}`)
      .join(', ');
    lines.push(`- ${s.armName}: ${reasons || 'n/a'}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs();
  const loaded = await readJsonl<PaperTradeRecord>(args.inputFile);
  const rows = args.sinceMs
    ? loaded.filter((r) => r.closedAt && new Date(r.closedAt).getTime() >= args.sinceMs!)
    : loaded;
  const groups = new Map<string, PaperTradeRecord[]>();
  for (const row of rows) {
    const key = armNameOf(row);
    const arr = groups.get(key) ?? [];
    arr.push(row);
    groups.set(key, arr);
  }
  const summaries = [...groups.entries()]
    .map(([armName, armRows]) => summarizeArm(armName, armRows))
    .sort((a, b) => b.netSol - a.netSol || a.armName.localeCompare(b.armName));

  if (args.mdOut) {
    await mkdir(path.dirname(args.mdOut), { recursive: true });
    await writeFile(args.mdOut, formatMarkdown(rows, summaries), 'utf8');
  }
  if (args.jsonOut) {
    await mkdir(path.dirname(args.jsonOut), { recursive: true });
    await writeFile(args.jsonOut, JSON.stringify({ generatedAt: new Date().toISOString(), rows: rows.length, summaries }, null, 2), 'utf8');
  }

  console.log(`[kol-paper-arm-report] rows=${rows.length} arms=${summaries.length}`);
  for (const s of summaries) {
    console.log(`[${s.armName}] n=${s.trades} shadow=${s.shadowTrades} net=${sol(s.netSol)}SOL T2=${s.t2Visits}`);
  }
}

void main().catch((err) => {
  console.error(`[kol-paper-arm-report] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
