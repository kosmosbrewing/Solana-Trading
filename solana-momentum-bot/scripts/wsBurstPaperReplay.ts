/**
 * WS Burst Paper Replay (DEX_TRADE Phase 1.2, 2026-04-18)
 *
 * Why: Phase 1.1 에서 구현한 `evaluateWsBurst` 의 weight / floor / threshold 를 실거래 적용 전
 * **paper replay 로 검증 / tuning** 한다. hard-coded guess 로 live 에 던지지 않는다.
 *
 * 입력:
 *   - `data/realtime/sessions/<session>/micro-candles.jsonl`
 *
 * 동작:
 *   1) session 의 candles 를 pair 별로 재구성
 *   2) intervalSec filter (기본 10s)
 *   3) pair 마다 sliding window (recent + baseline) 를 만들어 `evaluateWsBurst` 호출
 *   4) 결과 집계: pass rate, score histogram, factor percentiles, reject reason breakdown
 *   5) threshold sweep → optimal pass rate tradeoff 판정
 *
 * 실행:
 *   npx ts-node scripts/wsBurstPaperReplay.ts --session <session-dir> [--interval 10] [--json out.json] [--md out.md]
 *   npx ts-node scripts/wsBurstPaperReplay.ts --all
 */
import { readFile, writeFile, readdir } from 'fs/promises';
import path from 'path';
import { evaluateWsBurst, DEFAULT_WS_BURST_CONFIG } from '../src/strategy/wsBurstDetector';
import type { WsBurstDetectorConfig } from '../src/strategy/wsBurstDetector';
import type { Candle } from '../src/utils/types';

interface CliArgs {
  sessions: string[];
  intervalSec: number;
  json?: string;
  md?: string;
  quiet: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string) => argv.includes(flag);
  const session = get('--session');
  const useAll = has('--all');
  return {
    sessions: useAll ? [] : session ? [session] : [],
    intervalSec: Number(get('--interval') ?? '10'),
    json: get('--json'),
    md: get('--md'),
    quiet: has('--quiet'),
  };
}

async function listLiveSessions(): Promise<string[]> {
  const dir = path.resolve(process.cwd(), 'data/realtime/sessions');
  const entries = await readdir(dir);
  return entries
    .filter((name) => name.endsWith('-live') && !name.startsWith('legacy-'))
    .map((name) => path.join(dir, name));
}

interface RawCandle extends Candle {
  tokenMint?: string;
}

async function loadSessionCandles(sessionDir: string, intervalSec: number): Promise<Map<string, Candle[]>> {
  const file = path.join(sessionDir, 'micro-candles.jsonl');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return new Map();
  }
  const byPair = new Map<string, Candle[]>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line) as RawCandle;
      if (c.intervalSec !== intervalSec) continue;
      const candle: Candle = {
        pairAddress: c.pairAddress,
        timestamp: new Date(c.timestamp),
        intervalSec: c.intervalSec,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        buyVolume: c.buyVolume,
        sellVolume: c.sellVolume,
        tradeCount: c.tradeCount,
      };
      const arr = byPair.get(candle.pairAddress) ?? [];
      arr.push(candle);
      byPair.set(candle.pairAddress, arr);
    } catch {
      // skip malformed
    }
  }
  for (const [, candles] of byPair) {
    candles.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
  return byPair;
}

interface ReplayStats {
  totalEvaluations: number;
  passCount: number;
  passRate: number;
  rejectReasons: Record<string, number>;
  scoreBuckets: Record<string, number>;
  factorPercentiles: Record<string, { p50: number; p75: number; p90: number; p95: number; p99: number; max: number }>;
  passCountByPair: Array<{ pair: string; passes: number; evaluations: number }>;
}

function quantile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const i = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
  return sorted[i];
}

function percentiles(xs: number[]) {
  // Why: `Math.max(...xs)` spread throws RangeError for huge arrays. Use reduce.
  let mx = 0;
  for (const x of xs) if (x > mx) mx = x;
  return {
    p50: quantile(xs, 0.5),
    p75: quantile(xs, 0.75),
    p90: quantile(xs, 0.9),
    p95: quantile(xs, 0.95),
    p99: quantile(xs, 0.99),
    max: xs.length > 0 ? mx : 0,
  };
}

function replaySession(byPair: Map<string, Candle[]>, config: WsBurstDetectorConfig): ReplayStats {
  const stats: ReplayStats = {
    totalEvaluations: 0,
    passCount: 0,
    passRate: 0,
    rejectReasons: {},
    scoreBuckets: {},
    factorPercentiles: {},
    passCountByPair: [],
  };

  const factorsVol: number[] = [];
  const factorsBuy: number[] = [];
  const factorsTx: number[] = [];
  const factorsPrice: number[] = [];
  const rawBuyRatios: number[] = [];
  const rawTxCounts: number[] = [];

  for (const [pair, candles] of byPair) {
    const required = config.nRecent + config.nBaseline;
    if (candles.length < required) continue;

    let pairPasses = 0;
    let pairEvals = 0;

    for (let i = required; i <= candles.length; i++) {
      const window = candles.slice(i - required, i);
      const result = evaluateWsBurst(window, config);
      stats.totalEvaluations++;
      pairEvals++;

      if (result.pass) {
        stats.passCount++;
        pairPasses++;
      } else if (result.rejectReason) {
        stats.rejectReasons[result.rejectReason] = (stats.rejectReasons[result.rejectReason] ?? 0) + 1;
      }

      const bucket = `${Math.floor(result.score / 10) * 10}-${Math.floor(result.score / 10) * 10 + 10}`;
      stats.scoreBuckets[bucket] = (stats.scoreBuckets[bucket] ?? 0) + 1;

      factorsVol.push(result.factors.volumeAccelZ);
      factorsBuy.push(result.factors.buyPressureZ);
      factorsTx.push(result.factors.txDensityZ);
      factorsPrice.push(result.factors.priceAccel);
      rawBuyRatios.push(result.factors.rawBuyRatioRecent);
      rawTxCounts.push(result.factors.rawTxCountRecent);
    }

    if (pairPasses > 0) {
      stats.passCountByPair.push({ pair, passes: pairPasses, evaluations: pairEvals });
    }
  }

  stats.passRate = stats.totalEvaluations > 0 ? stats.passCount / stats.totalEvaluations : 0;
  stats.factorPercentiles.volumeAccelZ = percentiles(factorsVol);
  stats.factorPercentiles.buyPressureZ = percentiles(factorsBuy);
  stats.factorPercentiles.txDensityZ = percentiles(factorsTx);
  stats.factorPercentiles.priceAccel = percentiles(factorsPrice);
  stats.factorPercentiles.rawBuyRatioRecent = percentiles(rawBuyRatios);
  stats.factorPercentiles.rawTxCountRecent = percentiles(rawTxCounts);

  stats.passCountByPair.sort((a, b) => b.passes - a.passes);
  stats.passCountByPair = stats.passCountByPair.slice(0, 20);
  return stats;
}

async function aggregateSessions(sessionDirs: string[], intervalSec: number, config: WsBurstDetectorConfig): Promise<ReplayStats> {
  const allByPair = new Map<string, Candle[]>();
  for (const dir of sessionDirs) {
    const byPair = await loadSessionCandles(dir, intervalSec);
    for (const [pair, candles] of byPair) {
      const existing = allByPair.get(pair) ?? [];
      // Why: spread 로 push 하면 huge array 시 RangeError. 순회 append.
      for (const c of candles) existing.push(c);
      allByPair.set(pair, existing);
    }
  }
  for (const [, candles] of allByPair) {
    candles.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
  return replaySession(allByPair, config);
}

function sweepThresholds(baseStats: ReplayStats): Array<{ minPassScore: number; estimatedPasses: number; passRate: number }> {
  const bucketTotals: Record<number, number> = {};
  for (const [bucket, count] of Object.entries(baseStats.scoreBuckets)) {
    const lower = Number(bucket.split('-')[0]);
    bucketTotals[lower] = count;
  }
  const thresholds = [30, 40, 50, 55, 60, 65, 70, 75, 80, 90];
  const results: Array<{ minPassScore: number; estimatedPasses: number; passRate: number }> = [];
  for (const t of thresholds) {
    let passes = 0;
    for (let b = t; b < 100; b += 10) {
      passes += bucketTotals[b] ?? 0;
    }
    results.push({
      minPassScore: t,
      estimatedPasses: passes,
      passRate: baseStats.totalEvaluations > 0 ? passes / baseStats.totalEvaluations : 0,
    });
  }
  return results;
}

function toMarkdown(stats: ReplayStats, thresholdSweep: ReturnType<typeof sweepThresholds>, sessions: string[], config: WsBurstDetectorConfig): string {
  const lines: string[] = [];
  lines.push('# WS Burst Detector Calibration (Paper Replay)');
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Sessions (${sessions.length}): ${sessions.map((s) => path.basename(s)).join(', ')}`);
  lines.push(`- Config: nRecent=${config.nRecent} (${config.nRecent * 10}s), nBaseline=${config.nBaseline} (${config.nBaseline * 10}s), minPassScore=${config.minPassScore}`);
  lines.push(`- Weights: vol=${config.wVolume} buy=${config.wBuy} density=${config.wDensity} price=${config.wPrice} reverse=${config.wReverse}`);
  lines.push(`- Floors: vol=${config.floorVol} buy_z=${config.floorBuy} tx_z=${config.floorTx} price=${config.floorPrice} buy_ratio_abs=${config.buyRatioAbsoluteFloor} tx_count_abs=${config.txCountAbsoluteFloor}`);
  lines.push('');

  lines.push('## Overall');
  lines.push('');
  lines.push(`- Total evaluations: **${stats.totalEvaluations}**`);
  lines.push(`- Passes: **${stats.passCount}** (rate: **${(stats.passRate * 100).toFixed(3)}%**)`);
  lines.push('');

  lines.push('## Reject Reasons');
  lines.push('');
  lines.push('| reason | count | share |');
  lines.push('|---|---:|---:|');
  const sortedReasons = Object.entries(stats.rejectReasons).sort((a, b) => b[1] - a[1]);
  const totalRejects = sortedReasons.reduce((sum, [, c]) => sum + c, 0);
  for (const [reason, count] of sortedReasons) {
    lines.push(`| ${reason} | ${count} | ${totalRejects > 0 ? ((count / totalRejects) * 100).toFixed(2) : 0}% |`);
  }
  lines.push('');

  lines.push('## Score Distribution');
  lines.push('');
  lines.push('| bucket | count |');
  lines.push('|---|---:|');
  for (let b = 0; b < 100; b += 10) {
    const key = `${b}-${b + 10}`;
    const count = stats.scoreBuckets[key] ?? 0;
    lines.push(`| ${key} | ${count} |`);
  }
  lines.push('');

  lines.push('## Factor Percentiles (normalized [0, 1])');
  lines.push('');
  lines.push('| factor | p50 | p75 | p90 | p95 | p99 | max |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  const fmt = (x: number) => x.toFixed(3);
  for (const name of ['volumeAccelZ', 'buyPressureZ', 'txDensityZ', 'priceAccel']) {
    const p = stats.factorPercentiles[name];
    if (p) {
      lines.push(`| ${name} | ${fmt(p.p50)} | ${fmt(p.p75)} | ${fmt(p.p90)} | ${fmt(p.p95)} | ${fmt(p.p99)} | ${fmt(p.max)} |`);
    }
  }
  lines.push('');
  lines.push('Raw factor percentiles:');
  lines.push('');
  lines.push('| factor | p50 | p75 | p90 | p95 | p99 | max |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const name of ['rawBuyRatioRecent', 'rawTxCountRecent']) {
    const p = stats.factorPercentiles[name];
    if (p) {
      lines.push(`| ${name} | ${fmt(p.p50)} | ${fmt(p.p75)} | ${fmt(p.p90)} | ${fmt(p.p95)} | ${fmt(p.p99)} | ${fmt(p.max)} |`);
    }
  }
  lines.push('');

  lines.push('## Threshold Sweep');
  lines.push('');
  lines.push('| minPassScore | estimated passes | pass rate |');
  lines.push('|---:|---:|---:|');
  for (const row of thresholdSweep) {
    lines.push(`| ${row.minPassScore} | ${row.estimatedPasses} | ${(row.passRate * 100).toFixed(3)}% |`);
  }
  lines.push('');
  lines.push('**Note**: threshold sweep 은 floor rejection 무관. 실제 pass rate 는 floor + threshold 동시 통과 기준.');
  lines.push('');

  lines.push('## Top Pairs by Pass Count');
  lines.push('');
  lines.push('| pair | passes | evaluations | rate |');
  lines.push('|---|---:|---:|---:|');
  for (const row of stats.passCountByPair) {
    const rate = row.evaluations > 0 ? (row.passes / row.evaluations) * 100 : 0;
    lines.push(`| ${row.pair.slice(0, 16)}... | ${row.passes} | ${row.evaluations} | ${rate.toFixed(2)}% |`);
  }
  lines.push('');

  lines.push('## Interpretation Guide');
  lines.push('');
  lines.push('- **Pass rate 너무 높음 (>5%)**: threshold 또는 floor 상향 고려');
  lines.push('- **Pass rate 너무 낮음 (<0.1%)**: threshold 완화 또는 baseline window 조정 고려');
  lines.push('- **Factor p95 가 1.0 saturate**: saturation 상한 상향 고려');
  lines.push('- **특정 reject reason 편중 (>50%)**: 해당 floor 재검토');
  lines.push('- **Top pairs 쏠림**: outlier pair 가 대부분 pass → per-pair cooldown 필요');
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs();
  const sessionDirs = args.sessions.length > 0 ? args.sessions : await listLiveSessions();
  if (sessionDirs.length === 0) {
    console.error('No sessions found. Use --session <dir> or --all.');
    process.exit(1);
  }

  if (!args.quiet) {
    console.log(`[replay] sessions=${sessionDirs.length} interval=${args.intervalSec}s minPassScore=${DEFAULT_WS_BURST_CONFIG.minPassScore}`);
  }

  const stats = await aggregateSessions(sessionDirs, args.intervalSec, DEFAULT_WS_BURST_CONFIG);
  const sweep = sweepThresholds(stats);

  console.log('');
  console.log(`total_eval=${stats.totalEvaluations} passes=${stats.passCount} rate=${(stats.passRate * 100).toFixed(3)}%`);
  console.log(`top reject reasons:`);
  const sortedReasons = Object.entries(stats.rejectReasons).sort((a, b) => b[1] - a[1]);
  for (const [r, c] of sortedReasons.slice(0, 5)) {
    console.log(`  ${r}: ${c}`);
  }
  console.log(`threshold sweep:`);
  for (const row of sweep) {
    console.log(`  score >= ${row.minPassScore}: ${row.estimatedPasses} (${(row.passRate * 100).toFixed(3)}%)`);
  }

  if (args.json) {
    await writeFile(args.json, JSON.stringify({ stats, sweep, sessions: sessionDirs.map((d) => path.basename(d)), config: DEFAULT_WS_BURST_CONFIG }, null, 2));
    console.log(`wrote JSON → ${args.json}`);
  }
  if (args.md) {
    await writeFile(args.md, toMarkdown(stats, sweep, sessionDirs, DEFAULT_WS_BURST_CONFIG));
    console.log(`wrote Markdown → ${args.md}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { replaySession, sweepThresholds, quantile, loadSessionCandles };
