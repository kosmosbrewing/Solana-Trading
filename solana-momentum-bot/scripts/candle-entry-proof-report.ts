#!/usr/bin/env ts-node
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import {
  DEFAULT_CANDLE_PROOF_HORIZONS_SEC,
  DEFAULT_CANDLE_PROOF_MIN_ROWS,
  DEFAULT_CANDLE_PROOF_PRE_WINDOWS_SEC,
  DEFAULT_CANDLE_PROOF_ROUND_TRIP_COST_PCT,
  type CandleEntryProofArgs,
} from './lib/candleEntryProofTypes';
import { buildCandleEntryProofReport } from './lib/candleEntryProofReport';
import { renderCandleEntryProofReport } from './lib/candleEntryProofReportRenderer';

function parseNumberList(raw: string, name: string): number[] {
  const values = raw.split(',').map((part) => Number(part.trim())).filter((value) => Number.isFinite(value));
  if (values.length === 0 || values.some((value) => value <= 0)) throw new Error(`invalid ${name}: ${raw}`);
  return values;
}

function parseArgs(argv: string[]): CandleEntryProofArgs {
  const realtimeDirDefault = path.resolve('data/realtime');
  const args: CandleEntryProofArgs = {
    realtimeDir: realtimeDirDefault,
    sessionsDir: path.join(realtimeDirDefault, 'sessions'),
    horizonsSec: [...DEFAULT_CANDLE_PROOF_HORIZONS_SEC],
    preWindowsSec: [...DEFAULT_CANDLE_PROOF_PRE_WINDOWS_SEC],
    roundTripCostPct: DEFAULT_CANDLE_PROOF_ROUND_TRIP_COST_PCT,
    minRows: DEFAULT_CANDLE_PROOF_MIN_ROWS,
  };
  for (const token of argv) {
    if (token.startsWith('--realtime-dir=')) {
      args.realtimeDir = path.resolve(token.split('=')[1]);
      if (args.sessionsDir === path.join(realtimeDirDefault, 'sessions')) {
        args.sessionsDir = path.join(args.realtimeDir, 'sessions');
      }
    } else if (token.startsWith('--sessions-dir=')) args.sessionsDir = path.resolve(token.split('=')[1]);
    else if (token.startsWith('--horizons-sec=')) args.horizonsSec = parseNumberList(token.split('=')[1], 'horizons-sec');
    else if (token.startsWith('--pre-windows-sec=')) args.preWindowsSec = parseNumberList(token.split('=')[1], 'pre-windows-sec');
    else if (token.startsWith('--round-trip-cost-pct=')) args.roundTripCostPct = Number(token.split('=')[1]);
    else if (token.startsWith('--min-rows=')) args.minRows = Number(token.split('=')[1]);
    else if (token.startsWith('--md-out=')) args.mdOut = path.resolve(token.split('=')[1]);
    else if (token.startsWith('--json-out=')) args.jsonOut = path.resolve(token.split('=')[1]);
    else if (token.startsWith('--mart-dir=')) args.martDir = path.resolve(token.split('=')[1]);
    else if (token.startsWith('--max-candles=')) args.maxCandles = Number(token.split('=')[1]);
    else throw new Error(`unknown argument: ${token}`);
  }
  if (!Number.isFinite(args.roundTripCostPct) || args.roundTripCostPct < 0) {
    throw new Error(`invalid round-trip-cost-pct: ${args.roundTripCostPct}`);
  }
  if (!Number.isFinite(args.minRows) || args.minRows <= 0) throw new Error(`invalid min-rows: ${args.minRows}`);
  return args;
}

async function writeOutput(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildCandleEntryProofReport(args);
  const markdown = renderCandleEntryProofReport(report);
  if (args.jsonOut) await writeOutput(args.jsonOut, JSON.stringify(report, null, 2) + '\n');
  if (args.mdOut) await writeOutput(args.mdOut, markdown);
  if (!args.jsonOut && !args.mdOut) process.stdout.write(markdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
