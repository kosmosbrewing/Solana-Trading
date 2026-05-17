import path from 'path';
import {
  DEFAULT_PROBE_POLICY_SHADOW_MAX_TAIL_KILL_RATE,
  DEFAULT_PROBE_POLICY_SHADOW_MIN_CLOSES,
  type ProbePolicyShadowArgs,
} from './probePolicyShadowTypes';

export function parseProbePolicyShadowArgs(argv: string[]): ProbePolicyShadowArgs {
  const args: ProbePolicyShadowArgs = {
    realtimeDir: path.resolve(process.cwd(), 'data/realtime'),
    sinceMs: Date.now() - 24 * 3600_000,
    minCloses: DEFAULT_PROBE_POLICY_SHADOW_MIN_CLOSES,
    maxTailKillRate: DEFAULT_PROBE_POLICY_SHADOW_MAX_TAIL_KILL_RATE,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--realtime-dir') args.realtimeDir = path.resolve(argv[++i]);
    else if (arg === '--since') args.sinceMs = parseSince(argv[++i]);
    else if (arg === '--min-closes') args.minCloses = parsePositiveInteger(argv[++i], arg);
    else if (arg === '--max-tail-kill-rate') args.maxTailKillRate = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--md') args.mdOut = path.resolve(argv[++i]);
    else if (arg === '--json') args.jsonOut = path.resolve(argv[++i]);
  }
  return args;
}

function parseSince(raw: string): number {
  if (/^\d+h$/.test(raw)) return Date.now() - Number(raw.slice(0, -1)) * 3600_000;
  if (/^\d+d$/.test(raw)) return Date.now() - Number(raw.slice(0, -1)) * 86400_000;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`invalid --since: ${raw}`);
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
