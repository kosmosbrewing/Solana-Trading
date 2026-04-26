/* eslint-disable no-console */
/**
 * Pure WS Breakout Backtest CLI
 *
 * Why: LANE_20260422 Path B — pure_ws 의 T1/T2/T3 tiered runner 를 candle replay 로 검증.
 * cupsey-backtest.ts 패턴을 그대로 따르되 STALK 제거 + immediate PROBE + tiered runner.
 * Entry-price idealization: signal price = entry price (결과는 upper bound).
 *
 * 사용:
 *   npx ts-node scripts/pure-ws-backtest.ts --dataset <PATH> [options]
 */

import path from 'path';
import dotenv from 'dotenv';
import { replayPureWsStream } from '../src/backtest/pureWsReplayEngine';
import {
  defaultPureWsReplayConfig,
  PureWsReplayConfig,
} from '../src/backtest/pureWsStateMachine';
import { RealtimeReplayStore } from '../src/realtime';
import { VolumeMcapSpikeTriggerConfig } from '../src/strategy';
import { CupseySignalGateConfig } from '../src/strategy/cupseySignalGate';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const datasetDir =
    getArg(args, '--dataset') || process.env.REALTIME_DATA_DIR || './data/realtime';
  const resolvedDatasetRoot = path.resolve(datasetDir);
  const store = new RealtimeReplayStore(resolvedDatasetRoot);
  const resolvedDatasetDir = store.datasetDir;
  const candlesPath = path.join(resolvedDatasetDir, 'micro-candles.jsonl');

  if (!(await store.hasCandles(candlesPath))) {
    throw new Error(
      `No micro-candles.jsonl found at ${resolvedDatasetDir}. Candle data required for pure_ws replay.`
    );
  }

  // ─── Bootstrap Trigger Config ───
  // pure_ws 는 V2 wsBurst 또는 V1 bootstrap trigger 로부터 signal 수신 가능.
  // backtest 단계에서는 V1 bootstrap 을 signal source 로 사용 (V2 는 별도 CLI 후보).
  const bootstrapTriggerConfig: VolumeMcapSpikeTriggerConfig = {
    primaryIntervalSec: numArg(args, '--primary-interval', 10),
    volumeSurgeLookback: numArg(args, '--volume-lookback', 20),
    volumeSurgeMultiplier: numArg(args, '--volume-multiplier', 1.3),
    cooldownSec: numArg(args, '--cooldown-sec', 300),
    minBuyRatio: numArg(args, '--min-buy-ratio', 0.5),
    atrPeriod: numArg(args, '--atr-period', 14),
    volumeMcapBoostThreshold: numArg(args, '--volume-mcap-boost-threshold', 0.005),
    volumeMcapBoostMultiplier: numArg(args, '--volume-mcap-boost-multiplier', 1.5),
    minActiveCandles: numArg(args, '--min-active-candles', 2),
    sparseVolumeLookback: numArg(args, '--sparse-volume-lookback', 120),
  };

  // ─── Pure WS State Machine Config ───
  const defaults = defaultPureWsReplayConfig();
  const pureWsConfig: PureWsReplayConfig = {
    probeWindowSec: numArg(args, '--probe-window', defaults.probeWindowSec),
    probeHardCutPct: numArg(args, '--probe-hard-cut', defaults.probeHardCutPct),
    probeFlatBandPct: numArg(args, '--probe-flat-band', defaults.probeFlatBandPct),
    probeTrailingPct: numArg(args, '--probe-trail', defaults.probeTrailingPct),
    t1MfeThreshold: numArg(args, '--t1-mfe', defaults.t1MfeThreshold),
    t1TrailingPct: numArg(args, '--t1-trail', defaults.t1TrailingPct),
    t2MfeThreshold: numArg(args, '--t2-mfe', defaults.t2MfeThreshold),
    t2TrailingPct: numArg(args, '--t2-trail', defaults.t2TrailingPct),
    t2BreakevenLockMultiplier: numArg(
      args,
      '--t2-lock',
      defaults.t2BreakevenLockMultiplier
    ),
    t3MfeThreshold: numArg(args, '--t3-mfe', defaults.t3MfeThreshold),
    t3TrailingPct: numArg(args, '--t3-trail', defaults.t3TrailingPct),
    maxConcurrent: numArg(args, '--max-concurrent', defaults.maxConcurrent),
    maxPeakMultiplier: numArg(args, '--max-peak-mult', defaults.maxPeakMultiplier),
    roundTripCostPct: numArg(args, '--round-trip-cost', defaults.roundTripCostPct),
  };

  // ─── Signal Gate (relaxed per STRATEGY.md) ───
  const gateEnabled = !args.includes('--no-gate');
  const gateConfig: CupseySignalGateConfig | undefined = gateEnabled
    ? {
        enabled: true,
        lookbackBars: numArg(args, '--gate-lookback', 20),
        recentBars: numArg(args, '--gate-recent', 3),
        minVolumeAccelRatio: numArg(args, '--gate-vol-accel', 1.0),
        minPriceChangePct: numArg(args, '--gate-price-change', -0.005),
        minAvgBuyRatio: numArg(args, '--gate-buy-ratio', 0.45),
        minTradeCountRatio: numArg(args, '--gate-trade-count', 0.8),
      }
    : undefined;

  const includeTrades = args.includes('--include-trades');
  const jsonOut = args.includes('--json');

  const candleStream = store.streamCandles();
  const result = await replayPureWsStream(candleStream, {
    bootstrapTriggerConfig,
    pureWsConfig,
    gateConfig,
  });

  const output: Record<string, unknown> = {
    datasetRoot: resolvedDatasetRoot,
    datasetDir: resolvedDatasetDir,
    dataset: result.dataset,
    config: { bootstrapTriggerConfig, pureWsConfig, gateConfig: gateConfig ?? null },
    summary: result.summary,
    rejectStats: result.rejectStats,
  };
  if (includeTrades) {
    output.trades = result.trades;
  }

  if (jsonOut) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    printHuman(result, resolvedDatasetDir);
  }
}

function printHuman(
  result: Awaited<ReturnType<typeof replayPureWsStream>>,
  datasetDir: string
): void {
  const s = result.summary;
  const line = '──────────────────────────────────────────────────';
  console.log(`\nPure WS Replay | Dataset: ${path.basename(datasetDir)} | Candles: ${result.dataset.candleCount}`);
  console.log(`Signals: ${s.totalSignals} (gate rejects: ${s.gateRejects}, pass rate: ${(s.gatePassRate * 100).toFixed(1)}%)`);
  console.log(line);
  console.log(`Entries:         ${s.entries}`);
  console.log(`PROBE hardcuts:  ${s.probeHardCuts}`);
  console.log(`PROBE rejects:   ${s.probeRejectTimeouts} (flat cuts: ${s.probeFlatCuts}, trails: ${s.probeTrails})`);
  console.log(line);
  console.log(`T1 visits: ${s.t1Visits} | T2 visits: ${s.t2Visits} | T3 visits: ${s.t3Visits}`);
  console.log(`T1 trail exits: ${s.t1TrailExits} | T2: ${s.t2TrailExits} | T3: ${s.t3TrailExits}`);
  console.log(line);
  console.log(`WR: ${(s.winRate * 100).toFixed(1)}% | avg Net: ${(s.avgNetPnlPct * 100).toFixed(2)}% | sum Net: ${(s.totalNetPnlPct * 100).toFixed(2)}%`);
  console.log(`avg MFE: ${(s.avgMfePct * 100).toFixed(2)}% | avg MAE: ${(s.avgMaePct * 100).toFixed(2)}% | avg hold: ${s.avgHoldSec.toFixed(0)}s`);
  console.log(`MAX MFE: ${(s.maxMfePct * 100).toFixed(1)}% | MAX Net: ${(s.maxNetPnlPct * 100).toFixed(1)}%`);
  console.log(`Winners 2x+: ${s.winners2xNet} | 5x+: ${s.winners5xNet} | 10x+: ${s.winners10xNet}`);
  console.log(line);
  const exits = Object.entries(s.exitReasonBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' | ');
  console.log(`Exit: ${exits}`);
  console.log(`Close state: ${Object.entries(s.closeStateBreakdown).map(([k, v]) => `${k}:${v}`).join(' | ')}`);
  console.log(`Max concurrent used: ${s.maxConcurrentUsed}`);
}

function printHelp() {
  console.log(`Usage:
  npx ts-node scripts/pure-ws-backtest.ts --dataset <PATH> [options]

Options:
  --dataset <path>            Realtime dataset directory (micro-candles.jsonl required)

  Bootstrap trigger (signal source):
  --primary-interval <sec>    Default 10
  --volume-lookback <n>       Default 20
  --volume-multiplier <n>     Default 1.3
  --min-buy-ratio <n>         Default 0.5
  --cooldown-sec <n>          Default 300
  --atr-period <n>            Default 14

  Signal gate (default enabled with pure_ws relaxed values):
  --no-gate                   Disable gate
  --gate-vol-accel <n>        Default 1.0 (cupsey 1.2)
  --gate-price-change <n>     Default -0.005 (cupsey 0)
  --gate-buy-ratio <n>        Default 0.45 (cupsey 0.50)
  --gate-trade-count <n>      Default 0.8 (cupsey 1.0)
  --gate-lookback <n>         Default 20
  --gate-recent <n>           Default 3

  Pure WS state machine:
  --probe-window <sec>        Default 30
  --probe-hard-cut <pct>      Default 0.03 (-3% MAE)
  --probe-flat-band <pct>     Default 0.10 (±10% window)
  --probe-trail <pct>         Default 0.03
  --t1-mfe <pct>              Default 1.0 (+100%)
  --t1-trail <pct>            Default 0.07
  --t2-mfe <pct>              Default 4.0 (+400%)
  --t2-trail <pct>            Default 0.15
  --t2-lock <mult>            Default 3.0 (entry × 3 never-close-below)
  --t3-mfe <pct>              Default 9.0 (+900%)
  --t3-trail <pct>            Default 0.25
  --max-concurrent <n>        Default 3
  --max-peak-mult <mult>      Default 15 (HWM sanity)
  --round-trip-cost <pct>     Default 0.0045

  Output:
  --json                      JSON output
  --include-trades            Include per-trade ledger in output
`);
}

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function numArg(args: string[], flag: string, fallback: number): number {
  const raw = getArg(args, flag);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
