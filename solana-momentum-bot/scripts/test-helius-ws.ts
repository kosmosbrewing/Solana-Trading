import path from 'path';
import dotenv from 'dotenv';
import { HeliusWSIngester } from '../src/realtime';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface CliOptions {
  pools: string[];
  durationSec: number;
  rpcHttpUrl: string;
  rpcWsUrl: string;
  maxSubscriptions: number;
  fallbackConcurrency: number;
  fallbackRequestsPerSecond: number;
  fallbackBatchSize: number;
  maxFallbackQueue: number;
  verbose: boolean;
  dexId?: string;
  baseMint?: string;
  quoteMint?: string;
  baseDecimals?: number;
  quoteDecimals?: number;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const seen = new Set<string>();
  let observedNotifications = 0;
  let parsedSwaps = 0;
  let logParsed = 0;
  let txFallback = 0;
  let errors = 0;
  let fallbackQueued = 0;
  let fallbackSkipped = 0;
  let fallbackDropped = 0;
  let fallbackErrors = 0;
  let fallbackUnparsed = 0;

  const ingester = new HeliusWSIngester({
    rpcHttpUrl: options.rpcHttpUrl,
    rpcWsUrl: options.rpcWsUrl,
    maxSubscriptions: options.maxSubscriptions,
    fallbackConcurrency: options.fallbackConcurrency,
    fallbackRequestsPerSecond: options.fallbackRequestsPerSecond,
    fallbackBatchSize: options.fallbackBatchSize,
    maxFallbackQueue: options.maxFallbackQueue,
  });
  if (options.dexId && options.baseMint && options.quoteMint) {
    for (const pool of options.pools) {
      ingester.setPoolMetadata(pool, {
        dexId: options.dexId,
        baseMint: options.baseMint,
        quoteMint: options.quoteMint,
        baseDecimals: options.baseDecimals,
        quoteDecimals: options.quoteDecimals,
      });
    }
  }

  ingester.on('connected', () => {
    console.log(`connected pools=${options.pools.length} duration=${options.durationSec}s`);
  });
  ingester.on('swap', (swap) => {
    const key = `${swap.pool}:${swap.signature}`;
    if (seen.has(key)) return;
    seen.add(key);

    parsedSwaps += 1;
    if (swap.source === 'logs') logParsed += 1;
    else txFallback += 1;

    if (options.verbose) {
      console.log(
        [
          'swap',
          `pool=${swap.pool}`,
          `source=${swap.source}`,
          `side=${swap.side}`,
          `price=${swap.priceNative.toFixed(8)}`,
          `base=${swap.amountBase.toFixed(6)}`,
          `quote=${swap.amountQuote.toFixed(6)}`,
          `sig=${swap.signature}`,
        ].join(' ')
      );
    }
  });
  ingester.on('parseMiss', () => {
    observedNotifications += 1;
  });
  ingester.on('fallbackQueued', () => {
    fallbackQueued += 1;
  });
  ingester.on('fallbackSkipped', () => {
    fallbackSkipped += 1;
  });
  ingester.on('fallbackDropped', () => {
    fallbackDropped += 1;
  });
  ingester.on('fallbackResult', ({ outcome }: { outcome: 'parsed' | 'unparsed' | 'error' }) => {
    if (outcome === 'error') fallbackErrors += 1;
    if (outcome === 'unparsed') fallbackUnparsed += 1;
  });
  ingester.on('error', ({ pool, error }: { pool: string; error: unknown }) => {
    errors += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error pool=${pool} message=${message}`);
  });

  const finish = async () => {
    await ingester.stop().catch(() => {});
    observedNotifications += logParsed;
    const parseRatePct = observedNotifications > 0 ? (logParsed / observedNotifications) * 100 : 0;

    console.log(JSON.stringify({
      pools: options.pools,
      duration_sec: options.durationSec,
      observed_notifications: observedNotifications,
      total_swaps: parsedSwaps,
      log_parsed: logParsed,
      tx_fallback: txFallback,
      parse_rate_pct: Number(parseRatePct.toFixed(2)),
      fallback_queued: fallbackQueued,
      fallback_skipped: fallbackSkipped,
      fallback_dropped: fallbackDropped,
      fallback_errors: fallbackErrors,
      fallback_unparsed: fallbackUnparsed,
      errors,
    }, null, 2));
  };

  process.on('SIGINT', async () => {
    await finish();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await finish();
    process.exit(0);
  });

  await ingester.subscribePools(options.pools);
  await new Promise((resolve) => setTimeout(resolve, options.durationSec * 1000));
  await finish();
}

function parseArgs(args: string[]): CliOptions {
  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const pools = getMultiArg(args, '--pool');
  if (pools.length === 0) {
    console.error('At least one --pool <POOL_ADDRESS> is required.');
    process.exit(1);
  }

  const rpcHttpUrl = getArg(args, '--http-url')
    || process.env.SOLANA_RPC_URL
    || '';
  if (!rpcHttpUrl) {
    console.error('SOLANA_RPC_URL or --http-url is required.');
    process.exit(1);
  }

  const rpcWsUrl = getArg(args, '--ws-url')
    || process.env.HELIUS_WS_URL
    || deriveWsUrl(rpcHttpUrl);

  return {
    pools,
    durationSec: numArg(args, '--duration', 300),
    rpcHttpUrl,
    rpcWsUrl,
    maxSubscriptions: Math.max(pools.length, numArg(args, '--max-subscriptions', pools.length)),
    fallbackConcurrency: numArg(args, '--fallback-concurrency', 2),
    fallbackRequestsPerSecond: numArg(args, '--fallback-rps', 4),
    fallbackBatchSize: numArg(args, '--fallback-batch-size', 5),
    maxFallbackQueue: numArg(args, '--max-fallback-queue', 1000),
    verbose: args.includes('--verbose'),
    dexId: getArg(args, '--dex-id'),
    baseMint: getArg(args, '--base-mint'),
    quoteMint: getArg(args, '--quote-mint'),
    baseDecimals: optionalNumArg(args, '--base-decimals'),
    quoteDecimals: optionalNumArg(args, '--quote-decimals'),
  };
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function getMultiArg(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === flag && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return [...new Set(values)];
}

function numArg(args: string[], flag: string, fallback: number): number {
  const raw = getArg(args, flag);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid number for ${flag}: "${raw}"`);
    process.exit(1);
  }
  return parsed;
}

function optionalNumArg(args: string[], flag: string): number | undefined {
  const raw = getArg(args, flag);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`Invalid number for ${flag}: "${raw}"`);
    process.exit(1);
  }
  return parsed;
}

function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) {
    return `wss://${httpUrl.slice('https://'.length)}`;
  }
  if (httpUrl.startsWith('http://')) {
    return `ws://${httpUrl.slice('http://'.length)}`;
  }
  return httpUrl;
}

function printHelp() {
  console.log(`
Usage:
  npx ts-node scripts/test-helius-ws.ts --pool <POOL_ADDRESS> [--pool <POOL_ADDRESS>...] [options]

Options:
  --duration <sec>             Observation window in seconds (default: 300)
  --http-url <url>             Override HTTP RPC URL (default: SOLANA_RPC_URL)
  --ws-url <url>               Override WebSocket RPC URL (default: HELIUS_WS_URL or derived from HTTP URL)
  --max-subscriptions <n>      Subscription cap passed to HeliusWSIngester
  --fallback-concurrency <n>   Transaction fallback concurrency (default: 2)
  --fallback-rps <n>           Transaction fallback requests/sec (default: 4)
  --fallback-batch-size <n>    Transactions fetched per fallback RPC call (default: 5)
  --max-fallback-queue <n>     Max queued fallback tx fetches (default: 1000)
  --dex-id <id>                Optional pool dexId metadata (ex: raydium)
  --base-mint <address>        Optional base token mint for log-only parsing
  --quote-mint <address>       Optional quote token mint for log-only parsing
  --base-decimals <n>          Optional base token decimals override
  --quote-decimals <n>         Optional quote token decimals override
  --verbose                    Print each parsed swap

Output:
  JSON summary with observed_notifications, total_swaps, log_parsed,
  tx_fallback, parse_rate_pct, fallback_queued, fallback_skipped,
  fallback_dropped, fallback_errors, fallback_unparsed, errors
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
