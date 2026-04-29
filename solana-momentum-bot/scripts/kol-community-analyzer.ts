#!/usr/bin/env ts-node
/**
 * KOL Community Analyzer (Option 5, 2026-04-29)
 *
 * 목적
 *   현재 KOL universe 의 co-buy graph 를 빌드하고 community 를 markdown / dot 으로 dump.
 *   운영자가 "어느 KOL 들이 같은 community 인가?" 를 review 하기 위함.
 *
 * 사용
 *   ts-node scripts/kol-community-analyzer.ts \
 *     --since 2026-04-25T00:00:00Z \
 *     --window 300000 \
 *     --min-weight 3 \
 *     --md reports/kol_communities_$(date +%Y_%m_%d).md \
 *     --dot reports/kol_communities.dot
 *
 * 입력: data/realtime/kol-tx.jsonl
 * 출력: markdown 요약 + (옵션) graphviz dot
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { buildCoBuyGraph, DEFAULT_COBUY_GRAPH_CONFIG } from '../src/kol/coBuyGraph';
import type { KolTx } from '../src/kol/types';

interface CliArgs {
  logPath: string;
  sinceMs: number;
  untilMs: number;
  windowMs: number;
  minEdgeWeight: number;
  mdOut: string | null;
  dotOut: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    logPath: path.resolve(process.cwd(), 'data/realtime/kol-tx.jsonl'),
    sinceMs: 0,
    untilMs: Date.now(),
    windowMs: DEFAULT_COBUY_GRAPH_CONFIG.windowMs,
    minEdgeWeight: DEFAULT_COBUY_GRAPH_CONFIG.minEdgeWeight,
    mdOut: null,
    dotOut: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = (): string => {
      i += 1;
      return argv[i];
    };
    switch (a) {
      case '--log':
        args.logPath = path.resolve(process.cwd(), next());
        break;
      case '--since':
        args.sinceMs = Date.parse(next());
        break;
      case '--until':
        args.untilMs = Date.parse(next());
        break;
      case '--window':
        args.windowMs = Number(next());
        break;
      case '--min-weight':
        args.minEdgeWeight = Number(next());
        break;
      case '--md':
        args.mdOut = path.resolve(process.cwd(), next());
        break;
      case '--dot':
        args.dotOut = path.resolve(process.cwd(), next());
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (a.startsWith('--')) {
          console.warn(`unknown flag: ${a}`);
        }
    }
  }
  if (!Number.isFinite(args.sinceMs) || !Number.isFinite(args.untilMs)) {
    throw new Error('invalid --since/--until (must be ISO date)');
  }
  return args;
}

function printHelp(): void {
  console.log(`KOL Community Analyzer

Usage:
  ts-node scripts/kol-community-analyzer.ts [options]

Options:
  --log <path>       kol-tx.jsonl path (default: data/realtime/kol-tx.jsonl)
  --since <iso>      filter tx >= this timestamp
  --until <iso>      filter tx <= this timestamp (default: now)
  --window <ms>      co-buy window (default: 300000 = 5min)
  --min-weight <n>   edge threshold (default: 3)
  --md <path>        write markdown summary
  --dot <path>       write graphviz dot
  -h, --help         this message
`);
}

async function readKolTxs(logPath: string): Promise<KolTx[]> {
  const raw = await readFile(logPath, 'utf8').catch((err) => {
    throw new Error(`failed to read ${logPath}: ${String(err)}`);
  });
  const lines = raw.split('\n').filter(Boolean);
  const result: KolTx[] = [];
  let bad = 0;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as KolTx;
      if (!obj.kolId || !obj.tokenMint || typeof obj.timestamp !== 'number') {
        bad += 1;
        continue;
      }
      result.push(obj);
    } catch {
      bad += 1;
    }
  }
  if (bad > 0) {
    console.warn(`skipped ${bad} malformed lines`);
  }
  return result;
}

function renderMarkdown(args: CliArgs, txs: KolTx[]): string {
  const filtered = txs.filter((t) => t.timestamp >= args.sinceMs && t.timestamp <= args.untilMs);
  const buys = filtered.filter((t) => t.action === 'buy');
  const uniqueKols = new Set(filtered.map((t) => t.kolId));
  const uniqueMints = new Set(buys.map((t) => t.tokenMint));

  const { edges, communities } = buildCoBuyGraph(filtered, {
    windowMs: args.windowMs,
    minEdgeWeight: args.minEdgeWeight,
  });

  const lines: string[] = [];
  lines.push(`# KOL Community Analysis`);
  lines.push('');
  lines.push(`- generated: ${new Date().toISOString()}`);
  lines.push(`- window: ${(args.windowMs / 1000).toFixed(0)}s`);
  lines.push(`- min edge weight: ${args.minEdgeWeight}`);
  lines.push(
    `- range: ${args.sinceMs ? new Date(args.sinceMs).toISOString() : '(all)'} ~ ${new Date(
      args.untilMs
    ).toISOString()}`
  );
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`- total tx: ${filtered.length}`);
  lines.push(`- buy tx: ${buys.length}`);
  lines.push(`- unique KOLs: ${uniqueKols.size}`);
  lines.push(`- unique mints (buys): ${uniqueMints.size}`);
  lines.push(`- edges (≥ threshold): ${edges.length}`);
  lines.push(`- communities: ${communities.length}`);
  lines.push('');

  if (communities.length > 0) {
    lines.push(`## Communities`);
    lines.push('');
    lines.push('| # | community_id | size | members |');
    lines.push('|---|---|---|---|');
    communities
      .slice()
      .sort((a, b) => b.members.length - a.members.length)
      .forEach((c, i) => {
        lines.push(`| ${i + 1} | ${c.communityId} | ${c.members.length} | ${c.members.join(', ')} |`);
      });
    lines.push('');
  }

  if (edges.length > 0) {
    lines.push(`## Top Edges (by weight)`);
    lines.push('');
    lines.push('| rank | kolA | kolB | weight |');
    lines.push('|---|---|---|---|');
    edges.slice(0, 50).forEach((e, i) => {
      lines.push(`| ${i + 1} | ${e.kolA} | ${e.kolB} | ${e.weight} |`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

function renderDot(args: CliArgs, txs: KolTx[]): string {
  const { edges, communities } = buildCoBuyGraph(
    txs.filter((t) => t.timestamp >= args.sinceMs && t.timestamp <= args.untilMs),
    { windowMs: args.windowMs, minEdgeWeight: args.minEdgeWeight }
  );

  const lines: string[] = [];
  lines.push('graph KolCoBuy {');
  lines.push('  graph [layout=neato, overlap=false, splines=true];');
  lines.push('  node [shape=ellipse, style=filled, fillcolor="#e8f0fe"];');
  // group nodes by community via subgraph cluster — visual hint only.
  communities.forEach((c, idx) => {
    lines.push(`  subgraph cluster_${idx} {`);
    lines.push(`    label="${escapeDot(c.communityId)} (size ${c.members.length})";`);
    for (const m of c.members) {
      lines.push(`    "${escapeDot(m)}";`);
    }
    lines.push('  }');
  });
  for (const e of edges) {
    lines.push(`  "${escapeDot(e.kolA)}" -- "${escapeDot(e.kolB)}" [label="${e.weight}"];`);
  }
  lines.push('}');
  return lines.join('\n');
}

function escapeDot(s: string): string {
  return s.replace(/"/g, '\\"');
}

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`reading ${args.logPath} ...`);
  const txs = await readKolTxs(args.logPath);
  console.log(`loaded ${txs.length} kol-tx records`);

  const md = renderMarkdown(args, txs);
  if (args.mdOut) {
    await ensureDir(args.mdOut);
    await writeFile(args.mdOut, md, 'utf8');
    console.log(`wrote ${args.mdOut}`);
  } else {
    console.log('\n' + md);
  }

  if (args.dotOut) {
    const dot = renderDot(args, txs);
    await ensureDir(args.dotOut);
    await writeFile(args.dotOut, dot, 'utf8');
    console.log(`wrote ${args.dotOut}`);
  }
}

main().catch((err) => {
  console.error(`kol-community-analyzer failed: ${String(err && (err as Error).stack ? (err as Error).stack : err)}`);
  process.exit(1);
});
