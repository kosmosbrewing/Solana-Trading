import path from 'path';
import {
  DEFAULT_CARRY_HORIZON_SEC,
  DEFAULT_CONFIRM_HORIZON_SEC,
  DEFAULT_CONFIRM_THRESHOLD_PCT,
  DEFAULT_ROUND_TRIP_COST_PCT,
  DEFAULT_TARGET_HORIZON_SEC,
  type AdmissionEdgeArgs,
} from './admissionEdgeTypes';

export function parseArgs(argv: string[]): AdmissionEdgeArgs {
  const args: AdmissionEdgeArgs = {
    realtimeDir: path.resolve(process.cwd(), 'data/realtime'),
    confirmHorizonSec: DEFAULT_CONFIRM_HORIZON_SEC,
    targetHorizonSec: DEFAULT_TARGET_HORIZON_SEC,
    carryHorizonSec: DEFAULT_CARRY_HORIZON_SEC,
    confirmThresholdPct: DEFAULT_CONFIRM_THRESHOLD_PCT,
    roundTripCostPct: DEFAULT_ROUND_TRIP_COST_PCT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--realtime-dir') args.realtimeDir = path.resolve(argv[++i]);
    else if (arg === '--confirm-horizon-sec') args.confirmHorizonSec = parsePositiveInteger(argv[++i], arg);
    else if (arg === '--target-horizon-sec') args.targetHorizonSec = parsePositiveInteger(argv[++i], arg);
    else if (arg === '--carry-horizon-sec') args.carryHorizonSec = parsePositiveInteger(argv[++i], arg);
    else if (arg === '--confirm-threshold-pct') args.confirmThresholdPct = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--round-trip-cost-pct') args.roundTripCostPct = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--md') args.mdOut = path.resolve(argv[++i]);
    else if (arg === '--json') args.jsonOut = path.resolve(argv[++i]);
  }
  return args;
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
