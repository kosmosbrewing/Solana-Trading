/* eslint-disable no-console */

/**
 * Cupsey State Machine Backtest CLI
 *
 * Why: micro-backtest 의 horizon-based outcome 대신 cupsey STALK→PROBE→WINNER
 * state machine 을 실제 replay 하여 파라미터 최적화/grid sweep 수행.
 * micro-backtest.ts 패턴을 그대로 따름.
 */

import path from 'path';
import dotenv from 'dotenv';
import { replayCupseyStream } from '../src/backtest/cupseyReplayEngine';
import { defaultCupseyReplayConfig, CupseyReplayConfig } from '../src/backtest/cupseyStateMachine';
import { RealtimeReplayStore } from '../src/realtime';
import { VolumeMcapSpikeTriggerConfig, BootstrapRejectStats } from '../src/strategy';
import { CupseySignalGateConfig } from '../src/strategy/cupseySignalGate';
import { tradingParams } from '../src/utils/tradingParams';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const datasetDir = getArg(args, '--dataset') || process.env.REALTIME_DATA_DIR || './data/realtime';
  const resolvedDatasetRoot = path.resolve(datasetDir);
  const store = new RealtimeReplayStore(resolvedDatasetRoot);
  const resolvedDatasetDir = store.datasetDir;
  const candlesPath = path.join(resolvedDatasetDir, 'micro-candles.jsonl');

  if (!(await store.hasCandles(candlesPath))) {
    throw new Error(`No micro-candles.jsonl found at ${resolvedDatasetDir}. Candle data required for cupsey replay.`);
  }

  // ─── Bootstrap Trigger Config ───
  const bootstrapTriggerConfig: VolumeMcapSpikeTriggerConfig = {
    primaryIntervalSec: numArg(args, '--primary-interval', 10),
    volumeSurgeLookback: numArg(args, '--volume-lookback', 20),
    volumeSurgeMultiplier: numArg(args, '--volume-multiplier', 1.3),
    cooldownSec: numArg(args, '--cooldown-sec', 300),
    minBuyRatio: numArg(args, '--min-buy-ratio', 0.50),
    atrPeriod: numArg(args, '--atr-period', 14),
    volumeMcapBoostThreshold: numArg(args, '--volume-mcap-boost-threshold', 0.005),
    volumeMcapBoostMultiplier: numArg(args, '--volume-mcap-boost-multiplier', 1.5),
    minActiveCandles: numArg(args, '--min-active-candles', 2),
    sparseVolumeLookback: numArg(args, '--sparse-volume-lookback', 120),
  };

  // ─── Cupsey State Machine Config ───
  const defaults = defaultCupseyReplayConfig();
  const cupseyConfig: CupseyReplayConfig = {
    stalkWindowSec: numArg(args, '--stalk-window', defaults.stalkWindowSec),
    stalkDropPct: numArg(args, '--stalk-drop', defaults.stalkDropPct),
    stalkMaxDropPct: numArg(args, '--stalk-max-drop', defaults.stalkMaxDropPct),
    probeWindowSec: numArg(args, '--probe-window', defaults.probeWindowSec),
    probeMfeThreshold: numArg(args, '--probe-mfe', defaults.probeMfeThreshold),
    probeHardCutPct: numArg(args, '--probe-hard-cut', defaults.probeHardCutPct),
    winnerMaxHoldSec: numArg(args, '--winner-max-hold', defaults.winnerMaxHoldSec),
    winnerTrailingPct: numArg(args, '--winner-trailing', defaults.winnerTrailingPct),
    winnerBreakevenPct: numArg(args, '--winner-breakeven', defaults.winnerBreakevenPct),
    maxConcurrent: numArg(args, '--max-concurrent', defaults.maxConcurrent),
    roundTripCostPct: numArg(args, '--round-trip-cost', defaults.roundTripCostPct),
  };

  // ─── Signal Quality Gate Config ───
  const gateDefaults = tradingParams.cupseyGate;
  const gateEnabled = !args.includes('--no-gate');
  const gateConfig: CupseySignalGateConfig | undefined = gateEnabled ? {
    enabled: true,
    minVolumeAccelRatio: numArg(args, '--gate-vol-accel', gateDefaults.cupseyGateMinVolumeAccelRatio),
    minPriceChangePct: numArg(args, '--gate-price-change', gateDefaults.cupseyGateMinPriceChangePct),
    minAvgBuyRatio: numArg(args, '--gate-buy-ratio', gateDefaults.cupseyGateMinAvgBuyRatio),
    minTradeCountRatio: numArg(args, '--gate-trade-count', gateDefaults.cupseyGateMinTradeCountRatio),
    lookbackBars: numArg(args, '--gate-lookback', gateDefaults.cupseyGateLookbackBars),
    recentBars: numArg(args, '--gate-recent', gateDefaults.cupseyGateRecentBars),
  } : undefined;

  // ─── Replay ───
  const result = await replayCupseyStream(
    store.streamCandles(candlesPath),
    { bootstrapTriggerConfig, cupseyConfig, gateConfig }
  );

  const s = result.summary;
  const rs = result.rejectStats;

  // ─── Output ───
  const output = {
    datasetRoot: resolvedDatasetRoot,
    datasetDir: resolvedDatasetDir,
    dataset: result.dataset,
    config: {
      bootstrapTriggerConfig,
      cupseyConfig,
      gateConfig: gateConfig ?? null,
    },
    summary: s,
    rejectStats: stripMaps(rs),
    trades: args.includes('--include-trades') ? result.trades : undefined,
  };

  if (args.includes('--json')) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // ─── Human-readable ───
  const datasetLabel = path.basename(resolvedDatasetDir);
  console.log(`\nCupsey Replay | Dataset: ${datasetLabel} | Candles: ${result.dataset.keptCandleCount}`);
  console.log(`Trigger: bootstrap | Signals: ${s.totalSignals}`);
  console.log('─'.repeat(50));
  console.log(`STALK: ${s.stalkEntries}/${s.totalSignals} entered (${pct(s.stalkSuccessRate)})`);
  console.log(`PROBE: ${s.probeWinners}/${s.stalkEntries} → WINNER (${pct(s.probeToWinnerRate)})`);
  console.log('─'.repeat(50));
  console.log(
    `WR: ${pct(s.winRate)} | Avg PnL: ${sign(s.avgNetPnlPct * 100)}% | ` +
    `Total: ${sign(s.totalNetPnlPct * 100)}%`
  );
  console.log(
    `Hold: ${s.avgHoldSec.toFixed(0)}s avg | ` +
    `MFE: ${sign(s.avgMfePct * 100)}% | MAE: ${sign(s.avgMaePct * 100)}%`
  );
  console.log('─'.repeat(50));

  // Exit reason breakdown
  const reasons = s.exitReasonBreakdown;
  const reasonLines = Object.entries(reasons)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ');
  console.log(reasonLines);

  // Trigger stats
  console.log('─'.repeat(50));
  console.log(
    `Trigger evals: ${rs.evaluations} | ` +
    `vol_insuf: ${rs.volumeInsufficient} | low_buy: ${rs.lowBuyRatio} | ` +
    `cooldown: ${rs.cooldown} | sparse: ${rs.sparseDataInsufficient}`
  );

  // Gate stats
  if (gateConfig) {
    console.log(
      `Gate: ${s.gateRejects} rejected / ${s.totalSignals} signals (pass rate: ${pct(s.gatePassRate)})`
    );
  } else {
    console.log('Gate: disabled (--no-gate)');
  }

  if (s.maxConcurrentUsed > 0) {
    console.log(`Max concurrent positions: ${s.maxConcurrentUsed}`);
  }
}

// ─── Helpers ───

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function sign(val: number): string {
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}`;
}

function stripMaps(rs: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rs)) {
    if (!(v instanceof Map)) out[k] = v;
  }
  return out;
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

function printHelp() {
  console.log(`
Usage:
  npx ts-node scripts/cupsey-backtest.ts --dataset <PATH> [options]

Options:
  --dataset <path>            Realtime dataset directory (micro-candles.jsonl required)

  Bootstrap trigger:
  --primary-interval <sec>    Primary candle interval (default: 10)
  --volume-lookback <n>       Volume surge lookback (default: 20)
  --volume-multiplier <n>     Volume surge multiplier (default: 1.3)
  --min-buy-ratio <n>         Min buy ratio (default: 0.50)
  --cooldown-sec <n>          Cooldown seconds (default: 300)
  --atr-period <n>            ATR period (default: 14)
  --volume-mcap-boost-threshold <n>   (default: 0.005)
  --volume-mcap-boost-multiplier <n>  (default: 1.5)
  --min-active-candles <n>    Sparse min active candles (default: 2)
  --sparse-volume-lookback <n> Sparse volume lookback (default: 120)

  Cupsey state machine:
  --stalk-window <sec>        STALK pullback window (default: 20)
  --stalk-drop <pct>          STALK entry drop threshold (default: 0.005)
  --stalk-max-drop <pct>      STALK crash threshold (default: 0.015)
  --probe-window <sec>        PROBE observation window (default: 45)
  --probe-mfe <pct>           PROBE → WINNER MFE threshold (default: 0.020)
  --probe-hard-cut <pct>      PROBE hard cut MAE (default: 0.008)
  --winner-max-hold <sec>     WINNER max hold (default: 720)
  --winner-trailing <pct>     WINNER trailing stop distance (default: 0.040)
  --winner-breakeven <pct>    WINNER breakeven buffer (default: 0.005)
  --max-concurrent <n>        Max concurrent positions (default: 5)
  --round-trip-cost <pct>     Round-trip cost estimate (default: 0.0045)

  Signal quality gate:
  --no-gate                     Disable signal quality gate
  --gate-vol-accel <n>          Min volume acceleration ratio (default: 1.5)
  --gate-price-change <n>       Min price change pct (default: 0.001)
  --gate-buy-ratio <n>          Min avg buy ratio (default: 0.55)
  --gate-trade-count <n>        Min trade count ratio (default: 1.5)
  --gate-lookback <n>           Gate baseline lookback bars (default: 20)
  --gate-recent <n>             Gate recent momentum bars (default: 3)

  Output:
  --json                      JSON output (grid sweep compatible)
  --include-trades            Include per-trade ledger in output
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
