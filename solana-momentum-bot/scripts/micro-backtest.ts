/* eslint-disable no-console */

import path from 'path';
import dotenv from 'dotenv';
import { replayRealtimeCandlesStream, replayRealtimeDataset, ReplayTriggerType } from '../src/backtest/microReplayEngine';
import { RealtimeReplayStore } from '../src/realtime';
import { MomentumTriggerConfig, VolumeMcapSpikeTriggerConfig, BootstrapRejectStats } from '../src/strategy';
import { summarizeRealtimeSignals } from '../src/reporting';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const datasetDir = getArg(args, '--dataset') || process.env.REALTIME_DATA_DIR || './data/realtime';
  const gateMode = (getArg(args, '--gate-mode') || 'off') as 'off' | 'stored';
  const inputMode = (getArg(args, '--input-mode') || 'auto') as 'auto' | 'swaps' | 'candles';
  if (!['off', 'stored'].includes(gateMode)) {
    throw new Error(`Invalid --gate-mode: ${gateMode}`);
  }
  if (!['auto', 'swaps', 'candles'].includes(inputMode)) {
    throw new Error(`Invalid --input-mode: ${inputMode}`);
  }

  const horizonsSec = parseNumList(getArg(args, '--horizons')) || [30, 60, 180, 300];
  const horizonSec = numArg(args, '--horizon', horizonsSec.includes(180) ? 180 : horizonsSec[0]);
  const triggerType = (getArg(args, '--trigger-type') || 'momentum') as ReplayTriggerType;
  if (!['momentum', 'bootstrap'].includes(triggerType)) {
    throw new Error(`Invalid --trigger-type: ${triggerType}. Use 'momentum' or 'bootstrap'.`);
  }

  const triggerConfig: MomentumTriggerConfig = {
    primaryIntervalSec: numArg(args, '--primary-interval', 15),
    confirmIntervalSec: numArg(args, '--confirm-interval', 60),
    volumeSurgeLookback: numArg(args, '--volume-lookback', 20),
    volumeSurgeMultiplier: numArg(args, '--volume-multiplier', 3.0),
    priceBreakoutLookback: numArg(args, '--breakout-lookback', 20),
    confirmMinBars: numArg(args, '--confirm-bars', 3),
    confirmMinPriceChangePct: numArg(args, '--confirm-change-pct', 0.02),
    cooldownSec: numArg(args, '--cooldown-sec', 300),
  };

  const bootstrapTriggerConfig: VolumeMcapSpikeTriggerConfig | undefined = triggerType === 'bootstrap' ? {
    primaryIntervalSec: numArg(args, '--primary-interval', 10),
    volumeSurgeLookback: numArg(args, '--volume-lookback', 20),
    volumeSurgeMultiplier: numArg(args, '--volume-multiplier', 2.5),
    cooldownSec: numArg(args, '--cooldown-sec', 300),
    minBuyRatio: numArg(args, '--min-buy-ratio', 0.55),
    atrPeriod: numArg(args, '--atr-period', 14),
    volumeMcapBoostThreshold: numArg(args, '--volume-mcap-boost-threshold', 0.01),
    volumeMcapBoostMultiplier: numArg(args, '--volume-mcap-boost-multiplier', 1.5),
    minActiveCandles: numArg(args, '--min-active-candles', 3),
    sparseVolumeLookback: numArg(args, '--sparse-volume-lookback', 120),
  } : undefined;

  const resolvedDatasetRoot = path.resolve(datasetDir);
  const store = new RealtimeReplayStore(resolvedDatasetRoot);
  const resolvedDatasetDir = store.datasetDir;
  const storedSignals = await store.loadSignals(path.join(resolvedDatasetDir, 'realtime-signals.jsonl'));
  const resolvedInputMode = await resolveInputMode(store, inputMode, resolvedDatasetDir);
  const replayOptions = {
    triggerType,
    triggerConfig,
    bootstrapTriggerConfig,
    horizonsSec,
    gateMode,
    storedSignals,
    estimatedCostPct: numArg(args, '--estimated-cost-pct', 0),
  };
  const result = resolvedInputMode === 'candles'
    ? await replayRealtimeCandlesStream(store.streamCandles(path.join(resolvedDatasetDir, 'micro-candles.jsonl')), replayOptions)
    : await replayRealtimeDataset(await store.loadSwaps(path.join(resolvedDatasetDir, 'raw-swaps.jsonl')), replayOptions);

  const summary = summarizeRealtimeSignals(result.records, horizonSec);
  const rs = result.rejectStats;
  const showPerPair = args.includes('--per-pair-summary');
  const perPairStats = showPerPair && triggerType === 'bootstrap'
    ? buildPerPairStats(rs as BootstrapRejectStats)
    : undefined;

  const output = {
    datasetRoot: resolvedDatasetRoot,
    datasetDir: resolvedDatasetDir,
    dataset: result.dataset,
    config: {
      inputMode: resolvedInputMode,
      triggerType,
      triggerConfig: triggerType === 'bootstrap' ? bootstrapTriggerConfig : triggerConfig,
      gateMode,
      horizonsSec,
      selectedHorizonSec: horizonSec,
    },
    summary: {
      totalSignals: summary.totalSignals,
      executedSignals: summary.executedSignals,
      gateRejectedSignals: summary.gateRejectedSignals,
      avgReturnPct: summary.avgReturnPct,
      avgAdjustedReturnPct: summary.avgAdjustedReturnPct,
      avgMfePct: summary.avgMfePct,
      avgMaePct: summary.avgMaePct,
      avgGateLatencyMs: summary.avgGateLatencyMs,
      avgSignalToFillLatencyMs: summary.avgSignalToFillLatencyMs,
      edgeScore: summary.assessment.edgeScore,
      stageScore: summary.assessment.stageScore,
      stageDecision: summary.assessment.decision,
      edgeGateStatus: summary.assessment.gateStatus,
      edgeGateReasons: summary.assessment.gateReasons,
    },
    // Why: rejectStats의 perPair* Map은 JSON.stringify가 {} 로 직렬화하므로 제거
    rejectStats: stripMapsFromStats(rs),
    perPairStats,
    records: args.includes('--include-records') ? result.records : undefined,
  };

  if (args.includes('--json')) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log('\nMicro Replay Backtest');
  console.log('='.repeat(72));
  console.log(`Dataset: ${output.datasetDir}`);
  const datasetSummary = result.dataset.inputMode === 'candles'
    ? `Candles: ${result.dataset.keptCandleCount}/${result.dataset.candleCount} (dropped ${result.dataset.droppedCandleCount})`
    : `Swaps: ${result.dataset.keptSwapCount}/${result.dataset.swapCount} (dropped ${result.dataset.droppedSwapCount})`;
  console.log(`${datasetSummary} | Signals: ${summary.totalSignals} | Gate mode: ${gateMode}`);
  console.log(`Avg Return (${horizonSec}s): ${(summary.avgReturnPct * 100).toFixed(2)}%`);
  console.log(`Avg Adjusted Return (${horizonSec}s): ${(summary.avgAdjustedReturnPct * 100).toFixed(2)}%`);
  console.log(`Avg MFE: ${(summary.avgMfePct * 100).toFixed(2)}% | Avg MAE: ${(summary.avgMaePct * 100).toFixed(2)}%`);
  console.log(`Gate latency avg=${summary.avgGateLatencyMs.toFixed(1)}ms p50=${summary.p50GateLatencyMs.toFixed(1)}ms p95=${summary.p95GateLatencyMs.toFixed(1)}ms`);
  console.log(`Signal->fill avg=${summary.avgSignalToFillLatencyMs.toFixed(1)}ms p50=${summary.p50SignalToFillLatencyMs.toFixed(1)}ms p95=${summary.p95SignalToFillLatencyMs.toFixed(1)}ms`);
  console.log(`Edge Score: ${summary.assessment.edgeScore.toFixed(1)} | Stage Score: ${summary.assessment.stageScore.toFixed(1)}`);
  console.log(`Decision: ${summary.assessment.decision} | Gate: ${summary.assessment.gateStatus}`);
  if (summary.assessment.gateReasons.length > 0) {
    console.log(`Gate reasons: ${summary.assessment.gateReasons.join(', ')}`);
  }

  // Trigger reject reason breakdown
  console.log('─'.repeat(72));
  const idleSkipped = (rs as BootstrapRejectStats).idlePairSkipped ?? 0;
  const skipDetail = [
    `${rs.insufficientCandles} candle history`,
    idleSkipped > 0 ? `${idleSkipped} idle pair` : '',
  ].filter(Boolean).join(', ');
  console.log(`Trigger: ${triggerType} | evaluations: ${rs.evaluations} (+${skipDetail} skipped)`);
  if (rs.evaluations > 0) {
    const pct = (n: number) => `${n} (${((n / rs.evaluations) * 100).toFixed(1)}%)`;

    if (triggerType === 'bootstrap') {
      const brs = rs as import('../src/strategy').BootstrapRejectStats;
      const cfg = bootstrapTriggerConfig!;
      console.log(`  volume_insufficient : ${pct(brs.volumeInsufficient)}  [vm=${cfg.volumeSurgeMultiplier}x, boost=${cfg.volumeMcapBoostMultiplier ?? 1.5}x @${((cfg.volumeMcapBoostThreshold ?? 0.01) * 100).toFixed(0)}% vol/mcap]`);
      console.log(`  low_buy_ratio       : ${pct(brs.lowBuyRatio)}  [min=${cfg.minBuyRatio}]`);
      console.log(`  cooldown            : ${pct(brs.cooldown)}  [${cfg.cooldownSec}s]`);
      console.log(`  signals_fired       : ${brs.signals} (boosted=${brs.volumeMcapBoosted})`);
    } else {
      const volumeOk = rs.evaluations - rs.volumeInsufficient;
      console.log(`  volume_ok       : ${pct(volumeOk)}  [vm=${triggerConfig.volumeSurgeMultiplier}x threshold]`);
      console.log(`  no_breakout     : ${pct((rs as any).noBreakout)}  [close <= ${triggerConfig.priceBreakoutLookback}-bar high]`);
      console.log(`  confirm_fail    : ${pct((rs as any).confirmFail)}  [<${triggerConfig.confirmMinBars} bullish ${triggerConfig.confirmIntervalSec}s bars or <${(triggerConfig.confirmMinPriceChangePct * 100).toFixed(1)}% chg]`);
      console.log(`  cooldown        : ${pct(rs.cooldown)}  [${triggerConfig.cooldownSec}s cooldown not elapsed]`);
      console.log(`  signals_fired   : ${rs.signals}`);

      const bottleneck = ([
        ['volume_insufficient', rs.volumeInsufficient],
        ['no_breakout', (rs as any).noBreakout],
        ['confirm_fail', (rs as any).confirmFail],
        ['cooldown', rs.cooldown],
      ] as [string, number][]).sort((a, b) => b[1] - a[1])[0];
      if (rs.signals === 0 && rs.evaluations > 0) {
        console.log(`  >> 0 signals: top bottleneck = ${bottleneck[0]} (${bottleneck[1]}/${rs.evaluations} evals blocked)`);
      }
    }
  } else {
    console.log('  (no primary-interval candles evaluated — check dataset or --primary-interval setting)');
  }

  if (perPairStats && perPairStats.length > 0) {
    console.log('─'.repeat(72));
    console.log('Per-Pair Breakdown:');
    for (const p of perPairStats) {
      console.log(`  ${p.pair.slice(0, 8)}... : evals=${p.evals} signals=${p.signals} sparseInsuf=${p.sparseInsuf}`);
    }
  }
}

function stripMapsFromStats(rs: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rs)) {
    if (!(v instanceof Map)) out[k] = v;
  }
  return out;
}

interface PerPairStatEntry {
  pair: string;
  evals: number;
  signals: number;
  sparseInsuf: number;
}

function buildPerPairStats(rs: BootstrapRejectStats): PerPairStatEntry[] {
  const allPairs = new Set<string>();
  if (rs.perPairEvaluations) for (const k of rs.perPairEvaluations.keys()) allPairs.add(k);
  if (rs.perPairSparseInsuf) for (const k of rs.perPairSparseInsuf.keys()) allPairs.add(k);
  if (rs.perPairSignals) for (const k of rs.perPairSignals.keys()) allPairs.add(k);

  return [...allPairs]
    .map((pair) => ({
      pair,
      evals: rs.perPairEvaluations?.get(pair) ?? 0,
      signals: rs.perPairSignals?.get(pair) ?? 0,
      sparseInsuf: rs.perPairSparseInsuf?.get(pair) ?? 0,
    }))
    .sort((a, b) => b.evals - a.evals);
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function numArg(args: string[], flag: string, fallback: number): number {
  const raw = getArg(args, flag);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${flag}: "${raw}"`);
  }
  return parsed;
}

function parseNumList(raw?: string): number[] | undefined {
  if (!raw) return undefined;
  const parsed = raw
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
  return parsed.length > 0 ? parsed : undefined;
}

async function resolveInputMode(
  store: RealtimeReplayStore,
  requested: 'auto' | 'swaps' | 'candles',
  datasetDir: string
): Promise<'swaps' | 'candles'> {
  if (requested === 'swaps' || requested === 'candles') {
    return requested;
  }
  if (await store.hasCandles(path.join(datasetDir, 'micro-candles.jsonl'))) return 'candles';
  return 'swaps';
}

function printHelp() {
  console.log(`
Usage:
  npx ts-node scripts/micro-backtest.ts --dataset <PATH> [options]

Options:
  --dataset <path>            Realtime dataset directory
  --trigger-type <type>       momentum | bootstrap (default: momentum)
  --input-mode <mode>         auto | swaps | candles (default: auto, prefers candles)
  --gate-mode <off|stored>    Use trigger-only replay or stored gate outcomes (default: off)
  --horizons <csv>            Horizon list in seconds (default: 30,60,180,300)
  --horizon <sec>             Primary horizon for printed summary (default: 180)

  Momentum trigger options:
  --primary-interval <sec>    Trigger primary interval (default: 15)
  --confirm-interval <sec>    Trigger confirm interval (default: 60)
  --volume-lookback <n>       Volume surge lookback (default: 20)
  --volume-multiplier <n>     Volume surge multiplier (default: 3.0)
  --breakout-lookback <n>     Breakout lookback (default: 20)
  --confirm-bars <n>          Confirmation bullish bars (default: 3)
  --confirm-change-pct <n>    Confirmation change pct (default: 0.02)
  --cooldown-sec <n>          Cooldown seconds (default: 300)

  Bootstrap trigger options:
  --primary-interval <sec>    Trigger primary interval (default: 10)
  --volume-lookback <n>       Volume surge lookback (default: 20)
  --volume-multiplier <n>     Volume surge multiplier (default: 2.5)
  --min-buy-ratio <n>         Min buy ratio soft gate (default: 0.55)
  --atr-period <n>            ATR period (default: 14)
  --cooldown-sec <n>          Cooldown seconds (default: 300)
  --volume-mcap-boost-threshold <n>  Volume/mcap ratio to activate boost (default: 0.01)
  --volume-mcap-boost-multiplier <n> Boosted volume multiplier (default: 1.5)

  --estimated-cost-pct <n>    Fallback cost pct if stored signal cost is absent
  --per-pair-summary          Show per-pair evaluation/signal breakdown (bootstrap only)
  --json                      Print JSON output
  --include-records           Include per-signal replay records in JSON output
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
