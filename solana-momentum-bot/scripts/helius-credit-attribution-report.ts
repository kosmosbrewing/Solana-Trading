import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

interface Args {
  input: string;
  output?: string;
  sinceDays: number;
}

interface Row {
  timestamp?: string;
  method?: string;
  estimatedCredits?: number;
  requestCount?: number;
  purpose?: string;
  feature?: string;
  lane?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    input: 'data/realtime/helius-credit-usage.jsonl',
    sinceDays: 9,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input') args.input = requireValue(argv[++i], a);
    else if (a === '--output') args.output = requireValue(argv[++i], a);
    else if (a === '--since-days') args.sinceDays = parsePositive(requireValue(argv[++i], a), a);
  }
  return args;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositive(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be positive`);
  return n;
}

function add(map: Map<string, { credits: number; requests: number; rows: number }>, key: string, row: Row): void {
  const current = map.get(key) ?? { credits: 0, requests: 0, rows: 0 };
  current.credits += Number(row.estimatedCredits ?? 0);
  current.requests += Number(row.requestCount ?? 0);
  current.rows += 1;
  map.set(key, current);
}

function renderTable(title: string, map: Map<string, { credits: number; requests: number; rows: number }>): string {
  const rows = [...map.entries()]
    .sort((a, b) => b[1].credits - a[1].credits)
    .slice(0, 30);
  const lines = [`## ${title}`, '', '| key | credits | requests | rows |', '|---|---:|---:|---:|'];
  for (const [key, v] of rows) {
    lines.push(`| ${key} | ${v.credits.toFixed(0)} | ${v.requests.toFixed(0)} | ${v.rows} |`);
  }
  if (rows.length === 0) lines.push('| n/a | 0 | 0 | 0 |');
  return lines.join('\n');
}

async function loadRows(input: string, sinceDays: number): Promise<Row[]> {
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const content = await readFile(input, 'utf8').catch(() => '');
  if (!content.trim()) return [];
  return content.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Row)
    .filter((row) => {
      if (!row.timestamp) return true;
      const ts = Date.parse(row.timestamp);
      return !Number.isFinite(ts) || ts >= cutoff;
    });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows = await loadRows(args.input, args.sinceDays);
  const byMethod = new Map<string, { credits: number; requests: number; rows: number }>();
  const byFeature = new Map<string, { credits: number; requests: number; rows: number }>();
  const byPurpose = new Map<string, { credits: number; requests: number; rows: number }>();
  const byLane = new Map<string, { credits: number; requests: number; rows: number }>();

  for (const row of rows) {
    add(byMethod, row.method ?? 'unknown', row);
    add(byFeature, row.feature ?? 'unknown', row);
    add(byPurpose, row.purpose ?? 'unknown', row);
    add(byLane, row.lane ?? 'unknown', row);
  }

  const totalCredits = rows.reduce((sum, row) => sum + Number(row.estimatedCredits ?? 0), 0);
  const md = [
    `# Helius Credit Attribution`,
    '',
    `- input: \`${args.input}\``,
    `- window: ${args.sinceDays}d`,
    `- rows: ${rows.length}`,
    `- estimated credits: ${totalCredits.toFixed(0)}`,
    '',
    renderTable('By Method', byMethod),
    '',
    renderTable('By Feature', byFeature),
    '',
    renderTable('By Purpose', byPurpose),
    '',
    renderTable('By Lane', byLane),
    '',
  ].join('\n');

  if (args.output) {
    await mkdir(path.dirname(args.output), { recursive: true });
    await writeFile(args.output, md, 'utf8');
  } else {
    console.log(md);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

