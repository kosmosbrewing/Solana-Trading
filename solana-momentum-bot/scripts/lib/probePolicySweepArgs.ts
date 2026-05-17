import path from 'path';
import {
  DEFAULT_PROBE_CONFIRM_HORIZONS_SEC,
  DEFAULT_PROBE_CONFIRM_THRESHOLDS_PCT,
  DEFAULT_PROBE_ROUND_TRIP_COST_PCT,
  DEFAULT_PROBE_SWEEP_MAX_TAIL_KILL_RATE,
  DEFAULT_PROBE_SWEEP_MIN_MEDIAN_LOSS_REDUCTION,
  DEFAULT_PROBE_SWEEP_MIN_ROWS,
  DEFAULT_PROBE_TARGET_HORIZONS_SEC,
  type ProbePolicySweepArgs,
} from './probePolicySweepTypes';

export function parseProbePolicySweepArgs(argv: string[]): ProbePolicySweepArgs {
  const args: ProbePolicySweepArgs = {
    realtimeDir: path.resolve(process.cwd(), 'data/realtime'),
    confirmHorizonsSec: DEFAULT_PROBE_CONFIRM_HORIZONS_SEC,
    confirmThresholdsPct: DEFAULT_PROBE_CONFIRM_THRESHOLDS_PCT,
    targetHorizonsSec: DEFAULT_PROBE_TARGET_HORIZONS_SEC,
    roundTripCostPct: DEFAULT_PROBE_ROUND_TRIP_COST_PCT,
    minRows: DEFAULT_PROBE_SWEEP_MIN_ROWS,
    maxTailKillRate: DEFAULT_PROBE_SWEEP_MAX_TAIL_KILL_RATE,
    minMedianLossReduction: DEFAULT_PROBE_SWEEP_MIN_MEDIAN_LOSS_REDUCTION,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--realtime-dir') args.realtimeDir = path.resolve(argv[++i]);
    else if (arg === '--confirm-horizons-sec') args.confirmHorizonsSec = parsePositiveIntegerList(argv[++i], arg);
    else if (arg === '--confirm-thresholds-pct') args.confirmThresholdsPct = parseNonNegativeNumberList(argv[++i], arg);
    else if (arg === '--target-horizons-sec') args.targetHorizonsSec = parsePositiveIntegerList(argv[++i], arg);
    else if (arg === '--round-trip-cost-pct') args.roundTripCostPct = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--min-rows') args.minRows = parsePositiveInteger(argv[++i], arg);
    else if (arg === '--max-tail-kill-rate') args.maxTailKillRate = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--min-median-loss-reduction') args.minMedianLossReduction = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--md') args.mdOut = path.resolve(argv[++i]);
    else if (arg === '--json') args.jsonOut = path.resolve(argv[++i]);
  }
  return args;
}

function parsePositiveIntegerList(raw: string, name: string): number[] {
  const values = raw.split(',').filter(Boolean).map((value) => parsePositiveInteger(value, name));
  if (values.length === 0) throw new Error(`invalid ${name}: ${raw}`);
  return values;
}

function parseNonNegativeNumberList(raw: string, name: string): number[] {
  const values = raw.split(',').filter(Boolean).map((value) => parseNonNegativeNumber(value, name));
  if (values.length === 0) throw new Error(`invalid ${name}: ${raw}`);
  return values;
}

function parsePositiveInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid ${name}: ${raw}`);
  return value;
}

function parseNonNegativeNumber(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${name}: ${raw}`);
  return value;
}
