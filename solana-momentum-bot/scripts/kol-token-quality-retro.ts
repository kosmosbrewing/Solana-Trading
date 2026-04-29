#!/usr/bin/env ts-node
/**
 * Track 2A — Token Quality Retro 분석
 *
 * Roadmap: docs/exec-plans/active/kol-bigloss-roadmap-2026-04-29.md
 *
 * 목적: 기존 securityGate flag (CLEAN_TOKEN / UNCLEAN_TOKEN / TOKEN_QUALITY_UNKNOWN /
 *   TOKEN_2022 / EXIT_LIQUIDITY_UNKNOWN) 가 entry-time predictor 로 작동하는지 paper
 *   n=438 retrospective 검증. 외부 API (RugCheck / Solana Tracker) 도입 가치를 정량
 *   결정하기 위한 baseline.
 *
 * 측정 대상 (per flag cohort):
 *   - n (cohort size)
 *   - mfe<1% rate (mfePctPeak < 0.01)
 *   - big-loss rate (netPct ≤ -0.20)
 *   - cum_net_sol
 *   - 5x winner count (mfePctPeak ≥ 4.0)
 *   - lift vs all (mfe<1% rate 의 baseline 대비 차이)
 *
 * 사용:
 *   npx ts-node scripts/kol-token-quality-retro.ts \
 *     --in data/realtime/kol-paper-trades.jsonl \
 *     --md docs/exec-plans/active/kol-token-quality-retro-2026-04-29.md
 */
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

interface PaperTrade {
  positionId: string;
  tokenMint: string;
  netPct?: number;
  netSol?: number;
  mfePctPeak?: number;
  maePct?: number;
  holdSec?: number;
  exitReason?: string;
  survivalFlags?: string[];
  isShadowArm?: boolean;
  isShadowKol?: boolean;
  parentPositionId?: string | null;
  closedAt?: string;
}

interface CohortStat {
  flag: string;
  n: number;
  mfeUnder1pctRate: number;
  bigLossRate: number;
  cumNetSol: number;
  fiveXWinnerCount: number;
  avgMfePct: number;
  avgNetPct: number;
}

const MFE_UNDER_THRESHOLD = 0.01;
const BIG_LOSS_THRESHOLD = -0.20;
const FIVEX_MFE_THRESHOLD = 4.0;

function parseArgs(argv: string[]): { inputFile: string; mdOut?: string } {
  const args: { inputFile: string; mdOut?: string } = {
    inputFile: 'data/realtime/kol-paper-trades.jsonl',
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--in' && argv[i + 1]) {
      args.inputFile = argv[++i];
    } else if (arg === '--md' && argv[i + 1]) {
      args.mdOut = argv[++i];
    }
  }
  return args;
}

async function readTrades(filePath: string): Promise<PaperTrade[]> {
  const raw = await readFile(filePath, 'utf-8');
  const trades: PaperTrade[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      trades.push(JSON.parse(line) as PaperTrade);
    } catch {
      // skip malformed
    }
  }
  return trades;
}

function computeCohortStat(flag: string, trades: PaperTrade[]): CohortStat {
  const n = trades.length;
  if (n === 0) {
    return {
      flag,
      n: 0,
      mfeUnder1pctRate: 0,
      bigLossRate: 0,
      cumNetSol: 0,
      fiveXWinnerCount: 0,
      avgMfePct: 0,
      avgNetPct: 0,
    };
  }
  let mfeUnder = 0;
  let bigLoss = 0;
  let cumNet = 0;
  let fiveX = 0;
  let mfeSum = 0;
  let netSum = 0;
  for (const t of trades) {
    const mfe = t.mfePctPeak ?? 0;
    const net = t.netPct ?? 0;
    const netSol = t.netSol ?? 0;
    if (mfe < MFE_UNDER_THRESHOLD) mfeUnder++;
    if (net <= BIG_LOSS_THRESHOLD) bigLoss++;
    if (mfe >= FIVEX_MFE_THRESHOLD) fiveX++;
    cumNet += netSol;
    mfeSum += mfe;
    netSum += net;
  }
  return {
    flag,
    n,
    mfeUnder1pctRate: mfeUnder / n,
    bigLossRate: bigLoss / n,
    cumNetSol: cumNet,
    fiveXWinnerCount: fiveX,
    avgMfePct: mfeSum / n,
    avgNetPct: netSum / n,
  };
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtSol(x: number): string {
  const sign = x >= 0 ? '+' : '';
  return `${sign}${x.toFixed(4)}`;
}

function buildMarkdown(
  baseline: CohortStat,
  cohorts: CohortStat[],
  filtered: PaperTrade[],
  generatedAt: string,
): string {
  const lines: string[] = [];
  lines.push('# Track 2A — Token Quality Flag Retro 분석');
  lines.push('');
  lines.push(`> Generated: ${generatedAt}`);
  lines.push(`> Source: paper trades (active arm only, shadow excluded)`);
  lines.push(`> Roadmap: \`docs/exec-plans/active/kol-bigloss-roadmap-2026-04-29.md\``);
  lines.push('');
  lines.push('## 1. Baseline (전체 active paper trades)');
  lines.push('');
  lines.push(`| 지표 | 값 |`);
  lines.push(`|------|-----|`);
  lines.push(`| n (active arm trades) | ${baseline.n} |`);
  lines.push(`| cum_net_sol | ${fmtSol(baseline.cumNetSol)} |`);
  lines.push(`| mfe<1% rate | ${fmtPct(baseline.mfeUnder1pctRate)} |`);
  lines.push(`| big-loss rate (netPct ≤ -20%) | ${fmtPct(baseline.bigLossRate)} |`);
  lines.push(`| 5x winner (mfe ≥ +400%) | ${baseline.fiveXWinnerCount} |`);
  lines.push(`| avg mfe | ${fmtPct(baseline.avgMfePct)} |`);
  lines.push(`| avg net | ${fmtPct(baseline.avgNetPct)} |`);
  lines.push('');
  lines.push('## 2. Per-flag cohort (entry-time predictor 검증)');
  lines.push('');
  lines.push(
    `| Flag | n | mfe<1% rate | Δ baseline | big-loss rate | cum_net | 5x | avg_mfe |`,
  );
  lines.push(
    `|------|---|-------------|------------|---------------|---------|-----|---------|`,
  );
  for (const c of cohorts) {
    if (c.n === 0) continue;
    const lift = c.mfeUnder1pctRate - baseline.mfeUnder1pctRate;
    const liftStr = (lift >= 0 ? '+' : '') + fmtPct(lift);
    lines.push(
      `| ${c.flag} | ${c.n} | ${fmtPct(c.mfeUnder1pctRate)} | ${liftStr} | ` +
        `${fmtPct(c.bigLossRate)} | ${fmtSol(c.cumNetSol)} | ${c.fiveXWinnerCount} | ` +
        `${fmtPct(c.avgMfePct)} |`,
    );
  }
  lines.push('');
  lines.push('## 3. 판정 기준');
  lines.push('');
  lines.push(
    '- **strong predictor**: |Δ baseline| ≥ 10% 이고 n ≥ 30 — entry filter 도입 가치 있음.',
  );
  lines.push(
    '- **weak predictor**: |Δ baseline| 5-10% 또는 n 10-30 — 외부 API 보완 필요.',
  );
  lines.push(
    '- **no signal**: |Δ baseline| < 5% — 해당 flag 단독 reject 무의미. 외부 데이터 dimension 필요.',
  );
  lines.push('');
  lines.push('## 4. Action items (분석 결과 따라 결정)');
  lines.push('');
  lines.push(
    '| 결과 | 권고 |',
  );
  lines.push(
    `|------|------|`,
  );
  lines.push(
    `| strong predictor 1+ flag | (B) 즉시 entry-time reject 도입, 외부 API 미필요 |`,
  );
  lines.push(
    `| weak predictor only | (C) RugCheck (무료) + Solana Tracker (free tier) 평가 후 도입 |`,
  );
  lines.push(
    `| no signal | (D) Track 2 자체 재설계 — entry-time gate 무력화, hold-time / exit policy 로 회귀 |`,
  );
  lines.push('');
  lines.push(`## 5. 분석 무결성 체크`);
  lines.push('');
  lines.push(`- shadow arm 제외: ${filtered.length} active trades`);
  lines.push(`- mfe<1% threshold: ${fmtPct(MFE_UNDER_THRESHOLD)}`);
  lines.push(`- big-loss threshold: ${fmtPct(BIG_LOSS_THRESHOLD)}`);
  lines.push(`- 5x winner threshold: mfe ≥ ${fmtPct(FIVEX_MFE_THRESHOLD)}`);
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(process.cwd(), args.inputFile);
  const trades = await readTrades(inputPath);

  // Active arm only (shadow 제외 — 분포 정합성).
  const filtered = trades.filter((t) => !t.isShadowArm && !t.isShadowKol);

  const baseline = computeCohortStat('ALL', filtered);

  // Flag universe: securityGate 가 stamp 하는 flag 들 + 운영 데이터에 등장한 token 분류.
  const flagUniverse = new Set<string>();
  for (const t of filtered) {
    for (const f of t.survivalFlags ?? []) {
      flagUniverse.add(f);
      // UNCLEAN_TOKEN:reason1,reason2 같은 composite flag → prefix 와 reason 양쪽 누적
      if (f.startsWith('UNCLEAN_TOKEN:')) flagUniverse.add('UNCLEAN_TOKEN');
    }
  }

  const cohorts: CohortStat[] = [];
  const sortedFlags = [...flagUniverse].sort();
  for (const flag of sortedFlags) {
    const cohort = filtered.filter((t) => {
      if (flag === 'UNCLEAN_TOKEN') {
        return (t.survivalFlags ?? []).some((f) => f.startsWith('UNCLEAN_TOKEN:'));
      }
      return (t.survivalFlags ?? []).includes(flag);
    });
    cohorts.push(computeCohortStat(flag, cohort));
  }

  // Sort by n desc for readability
  cohorts.sort((a, b) => b.n - a.n);

  const generatedAt = new Date().toISOString();
  const md = buildMarkdown(baseline, cohorts, filtered, generatedAt);
  console.log(md);

  if (args.mdOut) {
    const outPath = path.resolve(process.cwd(), args.mdOut);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, md, 'utf-8');
    console.error(`\n[retro] wrote ${outPath}`);
  }
}

main().catch((err) => {
  console.error('[retro] failed:', err);
  process.exit(1);
});
