import path from 'path';
import dotenv from 'dotenv';
import { RealtimeReplayStore } from '../src/realtime';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const sourceDir = getArg(args, '--source-dir') || process.env.REALTIME_DATA_DIR || './data/realtime';
  const outputDir = getArg(args, '--output-dir') || path.join(sourceDir, 'exports', new Date().toISOString().replace(/[:.]/g, '-'));
  const start = getDateArg(args, '--start');
  const end = getDateArg(args, '--end');

  const store = new RealtimeReplayStore(path.resolve(sourceDir));
  const manifest = await store.exportRange(path.resolve(outputDir), { start, end });
  console.log(JSON.stringify({
    sourceDatasetDir: store.datasetDir,
    outputDir: path.resolve(outputDir),
    ...manifest,
  }, null, 2));
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function getDateArg(args: string[], flag: string): Date | undefined {
  const raw = getArg(args, flag);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date for ${flag}: "${raw}"`);
  }
  return parsed;
}

function printHelp() {
  console.log(`
Usage:
  npx ts-node scripts/export-realtime-replay.ts [options]

Options:
  --source-dir <path>   Source realtime data directory (default: REALTIME_DATA_DIR or ./data/realtime)
  --output-dir <path>   Output dataset directory
  --start <ISO>         Inclusive start timestamp
  --end <ISO>           Inclusive end timestamp
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
