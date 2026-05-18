#!/usr/bin/env ts-node
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

type JsonRecord = Record<string, unknown>;

interface Args {
  realtimeDir: string;
  sinceMs: number;
  sinceLabel: string;
  md?: string;
  json?: string;
}

interface Bucket {
  rows: number;
  buys: number;
  sells: number;
  withPool: number;
  withDex: number;
  routeKnown: number;
  heuristic: number;
  direct: number;
  uniqueTokens: Set<string>;
}

interface RenderBucket {
  rows: number;
  buys: number;
  sells: number;
  withPool: number;
  withDex: number;
  routeKnown: number;
  heuristic: number;
  direct: number;
  uniqueTokens: number;
  poolCoverage: number;
  routeKnownCoverage: number;
}

interface TopMissingToken {
  tokenMint: string;
  rows: number;
  buys: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

interface Report {
  generatedAt: string;
  inputFile: string;
  since: string;
  verdict: 'OK' | 'WATCH' | 'BLOCKED';
  summary: RenderBucket;
  parseSource: Array<{ key: string; bucket: RenderBucket }>;
  routeKind: Array<{ key: string; bucket: RenderBucket }>;
  topMissingTokens: TopMissingToken[];
  notes: string[];
}

function parseArgs(argv: string[]): Args {
  let realtimeDir = 'data/realtime';
  let sinceLabel = '24h';
  let md: string | undefined;
  let json: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--realtime-dir' && next) {
      realtimeDir = next;
      i += 1;
    } else if (arg === '--since' && next) {
      sinceLabel = next;
      i += 1;
    } else if (arg === '--md' && next) {
      md = next;
      i += 1;
    } else if (arg === '--json' && next) {
      json = next;
      i += 1;
    }
  }
  return {
    realtimeDir,
    sinceLabel,
    sinceMs: parseSinceMs(sinceLabel),
    md,
    json,
  };
}

function parseSinceMs(value: string, nowMs = Date.now()): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([mhd])$/i);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`invalid --since: ${value}`);
    const durationMs =
      unit === 'm' ? amount * 60 * 1000 :
      unit === 'h' ? amount * 60 * 60 * 1000 :
      amount * 24 * 60 * 60 * 1000;
    return nowMs - durationMs;
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`invalid --since: ${value}`);
}

async function readJsonl(file: string): Promise<JsonRecord[]> {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === 'object' ? parsed as JsonRecord : null;
        } catch {
          return null;
        }
      })
      .filter((row): row is JsonRecord => row !== null);
  } catch {
    return [];
  }
}

function rowTimeMs(row: JsonRecord): number {
  const timestamp = Number(row.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 1_000_000_000_000) return timestamp;
  const blockTime = Number(row.blockTime);
  if (Number.isFinite(blockTime) && blockTime > 1_000_000_000) return blockTime * 1000;
  const recordedAt = typeof row.recordedAt === 'string' ? Date.parse(row.recordedAt) : NaN;
  if (Number.isFinite(recordedAt)) return recordedAt;
  return 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function newBucket(): Bucket {
  return {
    rows: 0,
    buys: 0,
    sells: 0,
    withPool: 0,
    withDex: 0,
    routeKnown: 0,
    heuristic: 0,
    direct: 0,
    uniqueTokens: new Set<string>(),
  };
}

function addRow(bucket: Bucket, row: JsonRecord): void {
  bucket.rows += 1;
  const action = stringValue(row.action);
  if (action === 'buy') bucket.buys += 1;
  if (action === 'sell') bucket.sells += 1;
  if (stringValue(row.poolAddress)) bucket.withPool += 1;
  if (stringValue(row.dexId) || stringValue(row.dexProgram)) bucket.withDex += 1;
  const routeKind = stringValue(row.routeKind);
  const parseSource = stringValue(row.parseSource);
  if (routeKind && routeKind !== 'unknown') bucket.routeKnown += 1;
  if (parseSource === 'heuristic') bucket.heuristic += 1;
  if (parseSource && parseSource !== 'heuristic') bucket.direct += 1;
  const tokenMint = stringValue(row.tokenMint);
  if (tokenMint) bucket.uniqueTokens.add(tokenMint);
}

function renderBucket(bucket: Bucket): RenderBucket {
  return {
    rows: bucket.rows,
    buys: bucket.buys,
    sells: bucket.sells,
    withPool: bucket.withPool,
    withDex: bucket.withDex,
    routeKnown: bucket.routeKnown,
    heuristic: bucket.heuristic,
    direct: bucket.direct,
    uniqueTokens: bucket.uniqueTokens.size,
    poolCoverage: bucket.rows > 0 ? bucket.withPool / bucket.rows : 0,
    routeKnownCoverage: bucket.rows > 0 ? bucket.routeKnown / bucket.rows : 0,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function buildReport(rows: JsonRecord[], inputFile: string, sinceLabel: string): Report {
  const summary = newBucket();
  const byParseSource = new Map<string, Bucket>();
  const byRouteKind = new Map<string, Bucket>();
  const missingTokens = new Map<string, { rows: number; buys: number; firstMs: number; lastMs: number }>();

  for (const row of rows) {
    addRow(summary, row);
    const parseSource = stringValue(row.parseSource) ?? 'unknown';
    const routeKind = stringValue(row.routeKind) ?? 'unknown';
    const tokenMint = stringValue(row.tokenMint);
    const action = stringValue(row.action);
    const hasPool = Boolean(stringValue(row.poolAddress));

    const parseBucket = byParseSource.get(parseSource) ?? newBucket();
    addRow(parseBucket, row);
    byParseSource.set(parseSource, parseBucket);

    const routeBucket = byRouteKind.get(routeKind) ?? newBucket();
    addRow(routeBucket, row);
    byRouteKind.set(routeKind, routeBucket);

    if (tokenMint && !hasPool) {
      const timeMs = rowTimeMs(row);
      const existing = missingTokens.get(tokenMint) ?? { rows: 0, buys: 0, firstMs: timeMs, lastMs: timeMs };
      existing.rows += 1;
      if (action === 'buy') existing.buys += 1;
      if (timeMs > 0) {
        existing.firstMs = existing.firstMs > 0 ? Math.min(existing.firstMs, timeMs) : timeMs;
        existing.lastMs = Math.max(existing.lastMs, timeMs);
      }
      missingTokens.set(tokenMint, existing);
    }
  }

  const renderedSummary = renderBucket(summary);
  const verdict =
    renderedSummary.poolCoverage >= 0.9 ? 'OK' :
    renderedSummary.poolCoverage >= 0.5 ? 'WATCH' :
    'BLOCKED';
  const toRows = (map: Map<string, Bucket>) => [...map.entries()]
    .map(([key, bucket]) => ({ key, bucket: renderBucket(bucket) }))
    .sort((a, b) => b.bucket.rows - a.bucket.rows || a.key.localeCompare(b.key));
  const topMissingTokens = [...missingTokens.entries()]
    .map(([tokenMint, value]) => ({
      tokenMint,
      rows: value.rows,
      buys: value.buys,
      firstSeen: value.firstMs > 0 ? new Date(value.firstMs).toISOString() : null,
      lastSeen: value.lastMs > 0 ? new Date(value.lastMs).toISOString() : null,
    }))
    .sort((a, b) => b.rows - a.rows || b.buys - a.buys)
    .slice(0, 20);

  const notes = [
    'poolCoverage가 낮으면 KOL tx만으로는 micro-candle 구독 pool을 특정하지 못한다.',
    'BLOCKED는 전략 폐기가 아니라 candle admission proof 전제 데이터가 부족하다는 의미다.',
    'token_pair_resolver fallback이 동작하면 KOL_CANDLE_COVERAGE source=token_pair_resolver 로그가 늘어야 한다.',
  ];

  return {
    generatedAt: new Date().toISOString(),
    inputFile,
    since: sinceLabel,
    verdict,
    summary: renderedSummary,
    parseSource: toRows(byParseSource),
    routeKind: toRows(byRouteKind),
    topMissingTokens,
    notes,
  };
}

function renderReport(report: Report): string {
  const lines: string[] = [];
  lines.push(`# KOL TX Pool Evidence Report`);
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- input: \`${report.inputFile}\``);
  lines.push(`- since: \`${report.since}\``);
  lines.push(`- verdict: **${report.verdict}**`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push('| rows | buys | sells | uniqueTokens | poolCoverage | routeKnown | heuristic | direct |');
  lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|');
  lines.push([
    report.summary.rows,
    report.summary.buys,
    report.summary.sells,
    report.summary.uniqueTokens,
    pct(report.summary.poolCoverage),
    pct(report.summary.routeKnownCoverage),
    report.summary.heuristic,
    report.summary.direct,
  ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  lines.push('');
  lines.push(`## Parse Source`);
  lines.push('');
  lines.push('| source | rows | poolCoverage | routeKnown | buys | sells |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const row of report.parseSource) {
    lines.push(`| ${row.key} | ${row.bucket.rows} | ${pct(row.bucket.poolCoverage)} | ${pct(row.bucket.routeKnownCoverage)} | ${row.bucket.buys} | ${row.bucket.sells} |`);
  }
  lines.push('');
  lines.push(`## Route Kind`);
  lines.push('');
  lines.push('| routeKind | rows | poolCoverage | routeKnown | buys | sells |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const row of report.routeKind) {
    lines.push(`| ${row.key} | ${row.bucket.rows} | ${pct(row.bucket.poolCoverage)} | ${pct(row.bucket.routeKnownCoverage)} | ${row.bucket.buys} | ${row.bucket.sells} |`);
  }
  lines.push('');
  lines.push(`## Top Missing Pool Tokens`);
  lines.push('');
  lines.push('| token | rows | buys | firstSeen | lastSeen |');
  lines.push('|---|---:|---:|---|---|');
  for (const row of report.topMissingTokens) {
    lines.push(`| \`${row.tokenMint}\` | ${row.rows} | ${row.buys} | ${row.firstSeen ?? '-'} | ${row.lastSeen ?? '-'} |`);
  }
  lines.push('');
  lines.push(`## Notes`);
  lines.push('');
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function writeOutput(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputFile = path.join(args.realtimeDir, 'kol-tx.jsonl');
  const rows = (await readJsonl(inputFile)).filter((row) => rowTimeMs(row) >= args.sinceMs);
  const report = buildReport(rows, inputFile, args.sinceLabel);
  const markdown = renderReport(report);
  if (args.json) await writeOutput(args.json, `${JSON.stringify(report, null, 2)}\n`);
  if (args.md) await writeOutput(args.md, markdown);
  if (!args.json && !args.md) process.stdout.write(markdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
