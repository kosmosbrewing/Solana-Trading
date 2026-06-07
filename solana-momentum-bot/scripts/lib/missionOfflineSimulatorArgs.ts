import path from 'path';

export interface MissionOfflineSimulatorArgs {
  realtimeDir: string;
  reportsDir: string;
  jsonOut?: string;
  mdOut?: string;
  minRows: number;
  minActiveDays: number;
  stressCostPct: number;
  minStressCostSol: number;
  top5WinnerShareCap: number;
  top10WinnerShareCap: number;
  sleeveLossCapSol: number;
  microCanaryCloseTarget: number;
}

export function parseMissionOfflineSimulatorArgs(argv: string[]): MissionOfflineSimulatorArgs {
  const args: MissionOfflineSimulatorArgs = {
    realtimeDir: path.resolve(process.cwd(), 'data/realtime'),
    reportsDir: path.resolve(process.cwd(), 'reports'),
    minRows: 100,
    minActiveDays: 5,
    stressCostPct: 0.005,
    minStressCostSol: 0.0001,
    top5WinnerShareCap: 0.35,
    top10WinnerShareCap: 0.5,
    sleeveLossCapSol: 0.02,
    microCanaryCloseTarget: 30,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--realtime-dir') args.realtimeDir = path.resolve(requireValue(argv[++i], arg));
    else if (arg === '--reports-dir') args.reportsDir = path.resolve(requireValue(argv[++i], arg));
    else if (arg === '--json') args.jsonOut = path.resolve(requireValue(argv[++i], arg));
    else if (arg === '--md') args.mdOut = path.resolve(requireValue(argv[++i], arg));
    else if (arg === '--min-rows') args.minRows = parsePositiveInteger(requireValue(argv[++i], arg), arg);
    else if (arg === '--min-active-days') args.minActiveDays = parsePositiveInteger(requireValue(argv[++i], arg), arg);
    else if (arg === '--stress-cost-pct') args.stressCostPct = parseNonNegativeNumber(requireValue(argv[++i], arg), arg);
    else if (arg === '--min-stress-cost-sol') args.minStressCostSol = parseNonNegativeNumber(requireValue(argv[++i], arg), arg);
    else if (arg === '--top5-winner-share-cap') args.top5WinnerShareCap = parseNonNegativeNumber(requireValue(argv[++i], arg), arg);
    else if (arg === '--top10-winner-share-cap') args.top10WinnerShareCap = parseNonNegativeNumber(requireValue(argv[++i], arg), arg);
    else if (arg === '--sleeve-loss-cap-sol') args.sleeveLossCapSol = parsePositiveNumber(requireValue(argv[++i], arg), arg);
    else if (arg === '--micro-canary-close-target') args.microCanaryCloseTarget = parsePositiveInteger(requireValue(argv[++i], arg), arg);
  }

  return args;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInteger(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}

function parsePositiveNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be positive`);
  return value;
}

function parseNonNegativeNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} must be non-negative`);
  return value;
}
