/**
 * Ruin Probability Monte Carlo (DEX_TRADE Phase 3, 2026-04-18)
 *
 * Why: DEX_TRADE.md Section 11 Required Additions — `ruin simulation`. canary 승격 전
 * "이 전략으로 wallet 이 0.3 SOL 아래 떨어질 확률이 몇인가" 수치로 검증한다.
 *
 * 방법:
 *   1) executed-buys.jsonl + executed-sells.jsonl FIFO pair 로 paired PnL 분포 추출
 *   2) 분포에서 **block bootstrap** sampling — 연속 trade 상관 보존
 *   3) N_runs (default 10,000) 시뮬 → 각 run 에서 startWallet 부터 순차 PnL 적용
 *   4) ruin 판정: 동일 run 에서 wallet 이 `ruinThresholdSol` 아래 도달 → ruin
 *   5) 집계: ruin probability, median ending wallet, 5-95 percentile
 *
 * 실행:
 *   npx ts-node scripts/ruinProbability.ts [--start-sol 1.07] [--ruin-threshold 0.3] [--runs 10000] [--trades-per-run 200]
 *                                           [--strategy pure_ws_breakout] [--since 2026-04-18T00:00:00Z] [--md out.md]
 */
import { readFile, writeFile } from 'fs/promises';
import path from 'path';

interface LedgerBuy {
  strategy?: string;
  txSignature?: string;
  actualEntryPrice?: number;
  actualQuantity?: number;
  recordedAt?: string;
  signalTimeSec?: number;
}

interface LedgerSell {
  strategy?: string;
  txSignature?: string;
  entryTxSignature?: string;
  receivedSol?: number;
  entryPrice?: number;
  actualExitPrice?: number;
  recordedAt?: string;
  holdSec?: number;
}

interface CliArgs {
  ledgerDir: string;
  startSol: number;
  ruinThresholdSol: number;
  runs: number;
  tradesPerRun: number;
  strategy?: string;
  since?: Date;
  md?: string;
  json?: string;
  blockSize: number;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    ledgerDir: get('--ledger-dir') ?? path.resolve(process.cwd(), 'data/realtime'),
    startSol: Number(get('--start-sol') ?? '1.07'),
    ruinThresholdSol: Number(get('--ruin-threshold') ?? '0.3'),
    runs: Number(get('--runs') ?? '10000'),
    tradesPerRun: Number(get('--trades-per-run') ?? '200'),
    strategy: get('--strategy'),
    since: get('--since') ? new Date(get('--since')!) : undefined,
    md: get('--md'),
    json: get('--json'),
    blockSize: Number(get('--block-size') ?? '5'),
  };
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const text = await readFile(file, 'utf8');
    const out: T[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as T); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

function fifoPair(
  buys: LedgerBuy[],
  sells: LedgerSell[],
  strategyFilter?: string,
  since?: Date
): number[] {
  const buyByStrategyAndTx = new Map<string, Map<string, LedgerBuy>>();
  const within = (recordedAt?: string) =>
    !since || (recordedAt ? new Date(recordedAt).getTime() >= since.getTime() : true);
  for (const b of buys) {
    if (!within(b.recordedAt)) continue;
    if (!b.strategy || !b.txSignature) continue;
    if (strategyFilter && b.strategy !== strategyFilter) continue;
    let m = buyByStrategyAndTx.get(b.strategy);
    if (!m) { m = new Map(); buyByStrategyAndTx.set(b.strategy, m); }
    m.set(b.txSignature, b);
  }
  const pnls: number[] = [];
  for (const s of sells) {
    if (!within(s.recordedAt)) continue;
    if (!s.strategy || !s.entryTxSignature) continue;
    if (strategyFilter && s.strategy !== strategyFilter) continue;
    const buy = buyByStrategyAndTx.get(s.strategy)?.get(s.entryTxSignature);
    if (!buy) continue;
    const solSpent = (buy.actualEntryPrice ?? 0) * (buy.actualQuantity ?? 0);
    const solReceived = s.receivedSol ?? 0;
    pnls.push(solReceived - solSpent);
  }
  return pnls;
}

function blockBootstrap(pnls: number[], tradesPerRun: number, blockSize: number): number[] {
  const result: number[] = [];
  if (pnls.length === 0) return result;
  while (result.length < tradesPerRun) {
    const start = Math.floor(Math.random() * Math.max(pnls.length - blockSize + 1, 1));
    for (let i = 0; i < blockSize && result.length < tradesPerRun; i++) {
      result.push(pnls[(start + i) % pnls.length]);
    }
  }
  return result;
}

interface RunResult {
  endingWallet: number;
  ruined: boolean;
  ruinTradeIdx: number | null;
  maxDrawdown: number;
}

function runSingle(pnls: number[], cfg: { startSol: number; ruinSol: number; tradesPerRun: number; blockSize: number }): RunResult {
  const sequence = blockBootstrap(pnls, cfg.tradesPerRun, cfg.blockSize);
  let wallet = cfg.startSol;
  let peak = wallet;
  let maxDd = 0;
  let ruinTradeIdx: number | null = null;
  for (let i = 0; i < sequence.length; i++) {
    wallet += sequence[i];
    if (wallet > peak) peak = wallet;
    const dd = peak - wallet;
    if (dd > maxDd) maxDd = dd;
    if (wallet <= cfg.ruinSol && ruinTradeIdx === null) {
      ruinTradeIdx = i;
    }
  }
  return { endingWallet: wallet, ruined: ruinTradeIdx !== null, ruinTradeIdx, maxDrawdown: maxDd };
}

function quantile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(Math.floor(p * s.length), s.length - 1);
  return s[i];
}

interface MonteCarloReport {
  sampleCount: number;
  tradeMean: number;
  tradeMedian: number;
  tradeP5: number;
  tradeP95: number;
  ruinProbability: number;
  medianEndingWallet: number;
  p5EndingWallet: number;
  p95EndingWallet: number;
  meanMaxDrawdown: number;
  p95MaxDrawdown: number;
}

function simulate(pnls: number[], args: CliArgs): MonteCarloReport {
  const runs: RunResult[] = [];
  for (let r = 0; r < args.runs; r++) {
    runs.push(runSingle(pnls, {
      startSol: args.startSol,
      ruinSol: args.ruinThresholdSol,
      tradesPerRun: args.tradesPerRun,
      blockSize: args.blockSize,
    }));
  }
  const endings = runs.map((r) => r.endingWallet);
  const dds = runs.map((r) => r.maxDrawdown);
  const ruined = runs.filter((r) => r.ruined).length;

  return {
    sampleCount: pnls.length,
    tradeMean: pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0,
    tradeMedian: quantile(pnls, 0.5),
    tradeP5: quantile(pnls, 0.05),
    tradeP95: quantile(pnls, 0.95),
    ruinProbability: args.runs > 0 ? ruined / args.runs : 0,
    medianEndingWallet: quantile(endings, 0.5),
    p5EndingWallet: quantile(endings, 0.05),
    p95EndingWallet: quantile(endings, 0.95),
    meanMaxDrawdown: dds.reduce((a, b) => a + b, 0) / Math.max(dds.length, 1),
    p95MaxDrawdown: quantile(dds, 0.95),
  };
}

function toMarkdown(report: MonteCarloReport, args: CliArgs, pnls: number[]): string {
  const lines: string[] = [];
  lines.push('# Ruin Probability Monte Carlo');
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Strategy filter: \`${args.strategy ?? 'ALL'}\``);
  lines.push(`- Since: ${args.since ? args.since.toISOString() : 'all time'}`);
  lines.push(`- Start wallet: ${args.startSol.toFixed(4)} SOL`);
  lines.push(`- Ruin threshold: ${args.ruinThresholdSol.toFixed(4)} SOL`);
  lines.push(`- Runs: ${args.runs} × ${args.tradesPerRun} trades (block size ${args.blockSize})`);
  lines.push(`- Sample PnL count (historical paired trades): ${pnls.length}`);
  lines.push('');
  lines.push('## Historical PnL distribution (SOL)');
  lines.push('');
  lines.push(`- mean: ${report.tradeMean.toFixed(6)}`);
  lines.push(`- median: ${report.tradeMedian.toFixed(6)}`);
  lines.push(`- p5 (worst 5%): ${report.tradeP5.toFixed(6)}`);
  lines.push(`- p95 (best 5%): ${report.tradeP95.toFixed(6)}`);
  lines.push('');
  lines.push('## Monte Carlo result');
  lines.push('');
  lines.push(`- **Ruin probability (≤ ${args.ruinThresholdSol} SOL)**: **${(report.ruinProbability * 100).toFixed(3)}%**`);
  lines.push(`- Median ending wallet: ${report.medianEndingWallet.toFixed(4)} SOL`);
  lines.push(`- p5 ending wallet: ${report.p5EndingWallet.toFixed(4)} SOL`);
  lines.push(`- p95 ending wallet: ${report.p95EndingWallet.toFixed(4)} SOL`);
  lines.push(`- Mean max drawdown per run: ${report.meanMaxDrawdown.toFixed(4)} SOL`);
  lines.push(`- p95 max drawdown: ${report.p95MaxDrawdown.toFixed(4)} SOL`);
  lines.push('');
  lines.push('## Interpretation');
  lines.push('');
  lines.push('- **Ruin probability < 5%** 이면 DEX_TRADE Section 11 승격 기준 충족.');
  lines.push('- **> 10%** 이면 canary 중단 / threshold 재튜닝 / 전략 재검토.');
  lines.push('- **p5 ending wallet ≤ ruin threshold** 이면 5% 이상이 아슬아슬한 경로 — 경계.');
  lines.push('- 표본 `< 50` 이면 본 수치는 참고용이며 canary 평가 도구는 아님.');
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs();
  const buys = await readJsonl<LedgerBuy>(path.join(args.ledgerDir, 'executed-buys.jsonl'));
  const sells = await readJsonl<LedgerSell>(path.join(args.ledgerDir, 'executed-sells.jsonl'));
  console.log(`[ruin] loaded ${buys.length} buys + ${sells.length} sells from ${args.ledgerDir}`);
  const pnls = fifoPair(buys, sells, args.strategy, args.since);
  console.log(`[ruin] paired ${pnls.length} trades`);

  if (pnls.length === 0) {
    console.error('No paired trades — cannot simulate.');
    process.exit(1);
  }

  const report = simulate(pnls, args);
  console.log('');
  console.log(`ruin_prob=${(report.ruinProbability * 100).toFixed(3)}%  median_end=${report.medianEndingWallet.toFixed(4)} SOL`);
  console.log(`p5_end=${report.p5EndingWallet.toFixed(4)}  p95_end=${report.p95EndingWallet.toFixed(4)}`);
  console.log(`trade_mean=${report.tradeMean.toFixed(6)}  p5=${report.tradeP5.toFixed(6)}  p95=${report.tradeP95.toFixed(6)}`);
  console.log(`max_dd_mean=${report.meanMaxDrawdown.toFixed(4)}  p95=${report.p95MaxDrawdown.toFixed(4)}`);

  if (args.json) {
    await writeFile(args.json, JSON.stringify({ report, args: { ...args, since: args.since?.toISOString() } }, null, 2));
    console.log(`wrote JSON → ${args.json}`);
  }
  if (args.md) {
    await writeFile(args.md, toMarkdown(report, args, pnls));
    console.log(`wrote Markdown → ${args.md}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { fifoPair, blockBootstrap, runSingle, simulate };
