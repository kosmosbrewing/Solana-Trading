#!/usr/bin/env ts-node
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import type { KolPolicyDecision } from '../src/kol/policyTypes';

interface CliArgs {
  inputPath: string;
  windowHours: number;
  md?: string;
  json?: string;
}

export interface PolicyBucketStats {
  bucket: string;
  total: number;
  divergences: number;
  highConfidenceDivergences: number;
}

export interface PolicyReport {
  generatedAt: string;
  inputPath: string;
  windowHours: number;
  total: number;
  divergences: number;
  highConfidenceDivergences: number;
  byEvent: PolicyBucketStats[];
  byRecommendedAction: PolicyBucketStats[];
  byStyleEntry: PolicyBucketStats[];
  bySecurityLiquidity: PolicyBucketStats[];
  byEntryAdvantage: PolicyBucketStats[];
  topReasons: Array<{ key: string; count: number }>;
  topRiskFlags: Array<{ key: string; count: number }>;
  highConfidenceSamples: Array<{
    generatedAt: string;
    tokenMint: string;
    eventKind: string;
    currentAction: string;
    recommendedAction: string;
    reasons: string[];
    bucket: string;
  }>;
}

function parseArgs(argv: string[]): CliArgs {
  let inputPath = path.resolve(process.cwd(), 'data/realtime/kol-policy-decisions.jsonl');
  let windowHours = 24;
  let md: string | undefined;
  let json: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--input' || token === '--in') inputPath = argv[++i];
    else if (token === '--md') md = argv[++i];
    else if (token === '--json') json = argv[++i];
    else if (token.startsWith('--window-hours=')) windowHours = Number(token.split('=')[1]);
  }
  if (!Number.isFinite(windowHours) || windowHours <= 0) windowHours = 24;
  return { inputPath, windowHours, md, json };
}

export function parsePolicyDecisionRows(raw: string): KolPolicyDecision[] {
  const rows: KolPolicyDecision[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<KolPolicyDecision>;
      if (parsed.schemaVersion === 'kol-policy-shadow/v1' && parsed.tokenMint && parsed.bucket) {
        rows.push(parsed as KolPolicyDecision);
      }
    } catch {
      // skip corrupt jsonl row
    }
  }
  return rows;
}

function countBy(decisions: KolPolicyDecision[], keyFn: (d: KolPolicyDecision) => string): PolicyBucketStats[] {
  const map = new Map<string, PolicyBucketStats>();
  for (const d of decisions) {
    const key = keyFn(d);
    const cur = map.get(key) ?? { bucket: key, total: 0, divergences: 0, highConfidenceDivergences: 0 };
    cur.total += 1;
    if (d.divergence) cur.divergences += 1;
    if (d.divergence && d.confidence === 'high') cur.highConfidenceDivergences += 1;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.highConfidenceDivergences - a.highConfidenceDivergences || b.divergences - a.divergences || b.total - a.total);
}

function topCounts(values: string[], limit = 10): Array<{ key: string; count: number }> {
  const map = new Map<string, number>();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function entryAdvantageBucket(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  if (value <= -0.05) return 'favorable<=-5%';
  if (value < 0.05) return 'neutral_-5..5%';
  if (value < 0.2) return 'adverse_5..20%';
  return 'adverse>=20%';
}

export function buildKolPolicyReport(
  decisions: KolPolicyDecision[],
  opts: { inputPath?: string; windowHours?: number; nowMs?: number } = {}
): PolicyReport {
  const nowMs = opts.nowMs ?? Date.now();
  const windowHours = opts.windowHours ?? 24;
  const cutoffMs = nowMs - windowHours * 60 * 60 * 1000;
  const filtered = decisions.filter((d) => {
    const t = Date.parse(d.generatedAt);
    return Number.isFinite(t) && t >= cutoffMs && t <= nowMs + 60_000;
  });
  const highConfidenceSamples = filtered
    .filter((d) => d.divergence && d.confidence === 'high')
    .slice(-10)
    .reverse()
    .map((d) => ({
      generatedAt: d.generatedAt,
      tokenMint: d.tokenMint,
      eventKind: d.eventKind,
      currentAction: d.currentAction,
      recommendedAction: d.recommendedAction,
      reasons: d.reasons,
      bucket: `${d.bucket.style}/${d.bucket.entryReason}/${d.bucket.independentKolBucket}/${d.bucket.securityBucket}/${d.bucket.liquidityBucket}`,
    }));
  return {
    generatedAt: new Date(nowMs).toISOString(),
    inputPath: opts.inputPath ?? '',
    windowHours,
    total: filtered.length,
    divergences: filtered.filter((d) => d.divergence).length,
    highConfidenceDivergences: filtered.filter((d) => d.divergence && d.confidence === 'high').length,
    byEvent: countBy(filtered, (d) => d.eventKind),
    byRecommendedAction: countBy(filtered, (d) => d.recommendedAction),
    byStyleEntry: countBy(filtered, (d) => `${d.bucket.style}/${d.bucket.entryReason}/${d.bucket.independentKolBucket}`),
    bySecurityLiquidity: countBy(filtered, (d) => `${d.bucket.securityBucket}/${d.bucket.liquidityBucket}`),
    byEntryAdvantage: countBy(filtered, (d) => `${d.eventKind}/${entryAdvantageBucket(d.metrics.entryAdvantagePct)}`),
    topReasons: topCounts(filtered.flatMap((d) => d.reasons)),
    topRiskFlags: topCounts(filtered.flatMap((d) => d.riskFlags)),
    highConfidenceSamples,
  };
}

function renderTable(rows: PolicyBucketStats[]): string {
  if (rows.length === 0) return '_No rows._';
  const lines = ['| bucket | total | divergence | high-conf divergence |', '|---|---:|---:|---:|'];
  for (const r of rows.slice(0, 20)) {
    lines.push(`| ${r.bucket} | ${r.total} | ${r.divergences} | ${r.highConfidenceDivergences} |`);
  }
  return lines.join('\n');
}

function renderTop(rows: Array<{ key: string; count: number }>): string {
  if (rows.length === 0) return '_No rows._';
  return rows.map((r) => `- ${r.key}: ${r.count}`).join('\n');
}

export function renderKolPolicyReportMarkdown(report: PolicyReport): string {
  const divergenceRate = report.total > 0 ? report.divergences / report.total : 0;
  const highRate = report.total > 0 ? report.highConfidenceDivergences / report.total : 0;
  const samples = report.highConfidenceSamples.length === 0
    ? '_No high-confidence divergence samples._'
    : report.highConfidenceSamples
      .map((s) => `- ${s.generatedAt} ${s.tokenMint.slice(0, 8)} ${s.eventKind} ${s.currentAction}->${s.recommendedAction} ${s.bucket} reasons=${s.reasons.join(',')}`)
      .join('\n');
  return [
    '# KOL Policy Shadow Report',
    '',
    `Generated: ${report.generatedAt}`,
    `Window: ${report.windowHours}h`,
    `Input: ${report.inputPath || '(in-memory)'}`,
    '',
    `Total decisions: ${report.total}`,
    `Divergences: ${report.divergences} (${(divergenceRate * 100).toFixed(2)}%)`,
    `High-confidence divergences: ${report.highConfidenceDivergences} (${(highRate * 100).toFixed(2)}%)`,
    '',
    '## By Event',
    renderTable(report.byEvent),
    '',
    '## By Recommended Action',
    renderTable(report.byRecommendedAction),
    '',
    '## By Style / Entry / Independence',
    renderTable(report.byStyleEntry),
    '',
    '## By Security / Liquidity',
    renderTable(report.bySecurityLiquidity),
    '',
    '## By Entry Advantage',
    renderTable(report.byEntryAdvantage),
    '',
    '## Top Reasons',
    renderTop(report.topReasons),
    '',
    '## Top Risk Flags',
    renderTop(report.topRiskFlags),
    '',
    '## High-Confidence Samples',
    samples,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readFile(args.inputPath, 'utf8').catch((err) => {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') return '';
    throw err;
  });
  const report = buildKolPolicyReport(parsePolicyDecisionRows(raw), {
    inputPath: args.inputPath,
    windowHours: args.windowHours,
  });
  const md = renderKolPolicyReportMarkdown(report);
  if (args.md) {
    await mkdir(path.dirname(args.md), { recursive: true });
    await writeFile(args.md, md, 'utf8');
  }
  if (args.json) {
    await mkdir(path.dirname(args.json), { recursive: true });
    await writeFile(args.json, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  if (!args.md && !args.json) process.stdout.write(md);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
