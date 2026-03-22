#!/usr/bin/env ts-node

import fs from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { spawn } from 'child_process';
import { Notifier } from '../src/notifier/notifier';
import { buildRealtimeShadowReport } from '../src/reporting';
import { RealtimeReplayStore } from '../src/realtime';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const ROOT_DIR = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const datasetDir = path.resolve(
    getArg(args, '--dataset-dir') || path.join(ROOT_DIR, 'data/realtime-sessions', timestamp)
  );
  const exportDir = path.resolve(
    getArg(args, '--export-dir') || path.join(datasetDir, 'export')
  );
  const admissionSnapshotPath = path.resolve(
    getArg(args, '--admission-file') || path.join(ROOT_DIR, 'data/realtime-admission.json')
  );
  const runMinutes = numArg(args, '--run-minutes', 0);
  const signalTarget = numArg(args, '--signal-target', 0);
  const pollSec = numArg(args, '--poll-sec', 5);
  const horizonSec = numArg(args, '--horizon', 30);
  const json = args.includes('--json');
  const telegram = args.includes('--telegram');
  const verboseRuntime = args.includes('--verbose-runtime');

  await mkdir(datasetDir, { recursive: true });

  const session = (runMinutes > 0 || signalTarget > 0)
    ? await runRealtimeSession({
        datasetDir,
        runMs: runMinutes > 0 ? runMinutes * 60_000 : 0,
        signalTarget,
        pollMs: Math.max(1, pollSec) * 1000,
        verboseRuntime,
        env: buildRuntimeEnv(args, datasetDir),
      })
    : null;

  const store = new RealtimeReplayStore(datasetDir);
  const manifest = await store.exportRange(exportDir, {});
  const report = await buildRealtimeShadowReport({
    datasetDir,
    horizonSec,
    admissionSnapshotPath,
  });
  const output = {
    session,
    exportManifest: manifest,
    report,
  };

  await writeFile(
    path.join(exportDir, 'shadow-summary.json'),
    JSON.stringify(output, null, 2),
    'utf8'
  );

  if (telegram) {
    const notifier = new Notifier(
      process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '',
      process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || ''
    );
    await notifier.sendRealtimeShadowSummary(report);
  }

  if (json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  printReport(report, exportDir, session);
}

async function runRealtimeSession(options: {
  datasetDir: string;
  runMs: number;
  signalTarget: number;
  pollMs: number;
  verboseRuntime: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<{
  startedAt: string;
  endedAt: string;
  runtimeLogPath: string;
  stopReason: 'duration' | 'signal_target' | 'process_exit';
  observedSignalCount: number;
}> {
  const runtimeLogPath = path.join(options.datasetDir, 'runtime.log');
  const logStream = fs.createWriteStream(runtimeLogPath, { flags: 'a' });
  const startedAt = new Date().toISOString();
  const child = spawn('npm', ['start'], {
    cwd: ROOT_DIR,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let exited = false;
  let stopReason: 'duration' | 'signal_target' | 'process_exit' = 'duration';

  child.stdout.on('data', (chunk: Buffer | string) => {
    const text = chunk.toString();
    logStream.write(text);
    if (options.verboseRuntime) process.stdout.write(text);
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    const text = chunk.toString();
    logStream.write(text);
    if (options.verboseRuntime) process.stderr.write(text);
  });
  child.on('exit', () => {
    exited = true;
  });

  const deadline = options.runMs > 0 ? Date.now() + options.runMs : Number.POSITIVE_INFINITY;
  let observedSignalCount = 0;

  while (true) {
    await sleep(options.pollMs);
    observedSignalCount = await countJsonLines(path.join(options.datasetDir, 'realtime-signals.jsonl'));

    if (options.signalTarget > 0 && observedSignalCount >= options.signalTarget) {
      stopReason = 'signal_target';
      break;
    }
    if (Date.now() >= deadline) {
      stopReason = 'duration';
      break;
    }
    if (exited) {
      stopReason = 'process_exit';
      break;
    }
  }

  if (!exited) {
    await stopChild(child);
  }

  logStream.end();

  return {
    startedAt,
    endedAt: new Date().toISOString(),
    runtimeLogPath,
    stopReason,
    observedSignalCount,
  };
}

function buildRuntimeEnv(args: string[], datasetDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REALTIME_ENABLED: 'true',
    TRADING_MODE: 'paper',
    REALTIME_PERSISTENCE_ENABLED: 'true',
    REALTIME_DATA_DIR: datasetDir,
  };

  const mappings: Array<[string, string]> = [
    ['--outcome-horizons', 'REALTIME_OUTCOME_HORIZONS_SEC'],
    ['--primary-interval', 'REALTIME_PRIMARY_INTERVAL_SEC'],
    ['--confirm-interval', 'REALTIME_CONFIRM_INTERVAL_SEC'],
    ['--volume-lookback', 'REALTIME_VOLUME_SURGE_LOOKBACK'],
    ['--volume-multiplier', 'REALTIME_VOLUME_SURGE_MULTIPLIER'],
    ['--breakout-lookback', 'REALTIME_PRICE_BREAKOUT_LOOKBACK'],
    ['--confirm-bars', 'REALTIME_CONFIRM_MIN_BARS'],
    ['--confirm-change-pct', 'REALTIME_CONFIRM_MIN_CHANGE_PCT'],
    ['--cooldown-sec', 'REALTIME_COOLDOWN_SEC'],
  ];

  for (const [flag, key] of mappings) {
    const value = getArg(args, flag);
    if (value) env[key] = value;
  }

  return env;
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  child.kill('SIGINT');
  const exited = await waitForExit(child, 15_000);
  if (!exited) {
    child.kill('SIGKILL');
    await waitForExit(child, 5_000);
  }
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    child.once('exit', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}

async function countJsonLines(filePath: string): Promise<number> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return raw.split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function printReport(
  report: Awaited<ReturnType<typeof buildRealtimeShadowReport>>,
  exportDir: string,
  session: {
    startedAt: string;
    endedAt: string;
    runtimeLogPath: string;
    stopReason: string;
    observedSignalCount: number;
  } | null
): void {
  console.log('\nRealtime Shadow Runner');
  console.log('='.repeat(72));
  console.log(`Dataset: ${report.datasetDir}`);
  console.log(`Export:  ${exportDir}`);
  if (session) {
    console.log(`Session: ${session.startedAt} -> ${session.endedAt}`);
    console.log(`Stop:    ${session.stopReason} | observed signals=${session.observedSignalCount}`);
    console.log(`Log:     ${session.runtimeLogPath}`);
  }
  console.log(`Counts:  swaps=${report.counts.swaps} candles=${report.counts.candles} signals=${report.counts.signals}`);
  console.log(
    `H${report.horizonSec}s: avg=${formatPct(report.summary.avgAdjustedReturnPct)} ` +
    `MFE=${formatPct(report.summary.avgMfePct)} MAE=${formatPct(report.summary.avgMaePct)}`
  );
  console.log(
    `Decision: ${report.summary.assessment.decision} | Edge ${report.summary.assessment.edgeScore.toFixed(1)} | ` +
    `Gate ${report.summary.assessment.gateStatus}`
  );
  console.log(
    `Gate latency: avg=${report.summary.avgGateLatencyMs.toFixed(1)}ms ` +
    `p95=${report.summary.p95GateLatencyMs.toFixed(1)}ms`
  );
  if (report.statusCounts.length > 0) {
    console.log(`Statuses: ${report.statusCounts.map((item) => `${item.status}=${item.count}`).join(', ')}`);
  }
  if (report.reasonCounts.length > 0) {
    console.log(`Reasons:  ${report.reasonCounts.slice(0, 3).map((item) => `${item.reason}=${item.count}`).join(', ')}`);
  }
  if (report.admission) {
    console.log(
      `Admission: tracked=${report.admission.trackedPools} allowed=${report.admission.allowedPools} ` +
      `blocked=${report.admission.blockedPools}`
    );
  }
}

function formatPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp(): void {
  console.log(`
Usage:
  npx ts-node scripts/realtime-shadow-runner.ts [options]

Options:
  --dataset-dir <path>       Dataset directory for raw swaps / candles / signals
  --export-dir <path>        Export directory for replay bundle and summary JSON
  --run-minutes <n>          Run paper realtime session for N minutes before summarizing
  --signal-target <n>        Stop early after N persisted realtime signals
  --poll-sec <n>             Poll interval while session is running (default: 5)
  --horizon <sec>            Summary horizon in seconds (default: 30)
  --admission-file <path>    Admission snapshot JSON path (default: ./data/realtime-admission.json)
  --outcome-horizons <csv>   Override REALTIME_OUTCOME_HORIZONS_SEC
  --primary-interval <sec>   Override REALTIME_PRIMARY_INTERVAL_SEC
  --confirm-interval <sec>   Override REALTIME_CONFIRM_INTERVAL_SEC
  --volume-lookback <n>      Override REALTIME_VOLUME_SURGE_LOOKBACK
  --volume-multiplier <n>    Override REALTIME_VOLUME_SURGE_MULTIPLIER
  --breakout-lookback <n>    Override REALTIME_PRICE_BREAKOUT_LOOKBACK
  --confirm-bars <n>         Override REALTIME_CONFIRM_MIN_BARS
  --confirm-change-pct <n>   Override REALTIME_CONFIRM_MIN_CHANGE_PCT
  --cooldown-sec <n>         Override REALTIME_COOLDOWN_SEC
  --verbose-runtime          Stream child runtime log to stdout/stderr
  --telegram                 Send summary to Telegram via configured notifier
  --json                     Print machine-readable output
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
