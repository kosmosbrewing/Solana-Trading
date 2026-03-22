import path from 'path';
import dotenv from 'dotenv';
import { replayRealtimeDataset } from '../src/backtest/microReplayEngine';
import { RealtimeReplayStore } from '../src/realtime';
import { MomentumTriggerConfig } from '../src/strategy';
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
  if (!['off', 'stored'].includes(gateMode)) {
    throw new Error(`Invalid --gate-mode: ${gateMode}`);
  }

  const horizonsSec = parseNumList(getArg(args, '--horizons')) || [30, 60, 180, 300];
  const horizonSec = numArg(args, '--horizon', horizonsSec.includes(180) ? 180 : horizonsSec[0]);
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

  const store = new RealtimeReplayStore(path.resolve(datasetDir));
  const [swaps, storedSignals] = await Promise.all([
    store.loadSwaps(path.join(path.resolve(datasetDir), 'raw-swaps.jsonl')),
    store.loadSignals(path.join(path.resolve(datasetDir), 'realtime-signals.jsonl')),
  ]);

  const result = await replayRealtimeDataset(swaps, {
    triggerConfig,
    horizonsSec,
    gateMode,
    storedSignals,
    estimatedCostPct: numArg(args, '--estimated-cost-pct', 0),
  });

  const summary = summarizeRealtimeSignals(result.records, horizonSec);
  const output = {
    datasetDir: path.resolve(datasetDir),
    dataset: result.dataset,
    config: {
      triggerConfig,
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
  };

  if (args.includes('--json')) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log('\nMicro Replay Backtest');
  console.log('='.repeat(72));
  console.log(`Dataset: ${output.datasetDir}`);
  console.log(`Swaps: ${result.dataset.swapCount} | Signals: ${summary.totalSignals} | Gate mode: ${gateMode}`);
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

function printHelp() {
  console.log(`
Usage:
  npx ts-node scripts/micro-backtest.ts --dataset <PATH> [options]

Options:
  --dataset <path>            Realtime dataset directory
  --gate-mode <off|stored>    Use trigger-only replay or stored gate outcomes (default: off)
  --horizons <csv>            Horizon list in seconds (default: 30,60,180,300)
  --horizon <sec>             Primary horizon for printed summary (default: 180)
  --primary-interval <sec>    Trigger primary interval (default: 15)
  --confirm-interval <sec>    Trigger confirm interval (default: 60)
  --volume-lookback <n>       Volume surge lookback (default: 20)
  --volume-multiplier <n>     Volume surge multiplier (default: 3.0)
  --breakout-lookback <n>     Breakout lookback (default: 20)
  --confirm-bars <n>          Confirmation bullish bars (default: 3)
  --confirm-change-pct <n>    Confirmation change pct (default: 0.02)
  --cooldown-sec <n>          Cooldown seconds (default: 300)
  --estimated-cost-pct <n>    Fallback cost pct if stored signal cost is absent
  --json                      Print JSON output
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
