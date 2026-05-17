import path from 'path';
import {
  DEFAULT_LIVE_MIRROR_EXECUTION_DRAG_RATE,
  DEFAULT_LIVE_MIRROR_MIN_PAIRS,
  DEFAULT_LIVE_MIRROR_STRATEGY_LOSS_RATE,
  type KolLiveMirrorArgs,
} from './kolLiveMirrorTypes';

export function parseKolLiveMirrorArgs(argv: string[]): KolLiveMirrorArgs {
  const args: KolLiveMirrorArgs = {
    realtimeDir: path.resolve(process.cwd(), 'data/realtime'),
    sinceMs: Date.now() - 24 * 3600_000,
    minPairs: DEFAULT_LIVE_MIRROR_MIN_PAIRS,
    executionDragRate: DEFAULT_LIVE_MIRROR_EXECUTION_DRAG_RATE,
    strategyLossRate: DEFAULT_LIVE_MIRROR_STRATEGY_LOSS_RATE,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--realtime-dir') args.realtimeDir = path.resolve(argv[++i]);
    else if (arg === '--since') args.sinceMs = parseSince(argv[++i]);
    else if (arg === '--min-pairs') args.minPairs = parsePositiveInteger(argv[++i], arg);
    else if (arg === '--execution-drag-rate') args.executionDragRate = parseRate(argv[++i], arg);
    else if (arg === '--strategy-loss-rate') args.strategyLossRate = parseRate(argv[++i], arg);
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

function parseRate(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`invalid ${name}: ${raw}`);
  return value;
}
