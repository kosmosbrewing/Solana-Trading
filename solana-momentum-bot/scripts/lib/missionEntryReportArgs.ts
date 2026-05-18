import path from 'path';
import {
  DEFAULT_MISSION_ENTRY_BLEED_SHARE_THRESHOLD,
  DEFAULT_MISSION_ENTRY_HORIZONS_SEC,
  DEFAULT_MISSION_ENTRY_MIN_ROWS,
  DEFAULT_MISSION_ENTRY_ROUND_TRIP_COST_PCT,
  type MissionEntryArgs,
} from './missionEntryReportTypes';

export function parseMissionEntryArgs(argv: string[]): MissionEntryArgs {
  const args: MissionEntryArgs = {
    realtimeDir: path.resolve(process.cwd(), 'data/realtime'),
    horizonsSec: [...DEFAULT_MISSION_ENTRY_HORIZONS_SEC],
    roundTripCostPct: DEFAULT_MISSION_ENTRY_ROUND_TRIP_COST_PCT,
    minRows: DEFAULT_MISSION_ENTRY_MIN_ROWS,
    bleedShareThreshold: DEFAULT_MISSION_ENTRY_BLEED_SHARE_THRESHOLD,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--realtime-dir') args.realtimeDir = path.resolve(argv[++i]);
    else if (arg === '--horizons-sec') args.horizonsSec = parseIntegerList(argv[++i], arg);
    else if (arg === '--round-trip-cost-pct') args.roundTripCostPct = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--min-rows') args.minRows = parsePositiveInteger(argv[++i], arg);
    else if (arg === '--bleed-share-threshold') args.bleedShareThreshold = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--md') args.mdOut = path.resolve(argv[++i]);
    else if (arg === '--json') args.jsonOut = path.resolve(argv[++i]);
  }

  return args;
}

function parseIntegerList(raw: string, name: string): number[] {
  const values = raw.split(',').map((part) => parsePositiveInteger(part.trim(), name));
  if (values.length === 0) throw new Error(`invalid ${name}: ${raw}`);
  return [...new Set(values)].sort((a, b) => a - b);
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
