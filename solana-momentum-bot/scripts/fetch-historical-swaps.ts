/**
 * Historical Swap Backtest — Helius RPC 과거 swap 수집 + replay + Edge Score 산출
 *
 * Why: realtime shadow 데이터가 부족해 edge 판단이 불가. 온체인 과거 swap을
 * 수집하여 microReplayEngine으로 즉시 edge를 측정한다.
 *
 * Usage:
 *   npx ts-node scripts/fetch-historical-swaps.ts --pools <addr1,addr2> --days 3
 *   npx ts-node scripts/fetch-historical-swaps.ts --trending --days 3 --json
 *   npx ts-node scripts/fetch-historical-swaps.ts --top 100 --days 1 --json
 *   npx ts-node scripts/fetch-historical-swaps.ts --pools <addr> --days 1 --skip-replay
 *   npx ts-node scripts/fetch-historical-swaps.ts --pools <addr> --days 1 --dry-run
 */
import path from 'path';
import { writeFile, mkdir } from 'fs/promises';
import dotenv from 'dotenv';
import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  ConfirmedSignatureInfo,
} from '@solana/web3.js';

import { parseSwapFromTransaction } from '../src/realtime/swapParser';
import { RealtimeReplayStore, StoredRealtimeSwap } from '../src/realtime/replayStore';
import { RealtimePoolMetadata } from '../src/realtime/types';
import { replayRealtimeDataset, MicroReplayOptions } from '../src/backtest/microReplayEngine';
import axios from 'axios';
import { GeckoTerminalClient, GeckoPool } from '../src/ingester/geckoTerminalClient';
import { MomentumTriggerConfig } from '../src/strategy';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ─── Types ───

interface PoolTarget {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  baseSymbol: string;
  quoteSymbol: string;
}

interface PoolFetchResult {
  pool: PoolTarget;
  swapCount: number;
  signatureCount: number;
  parseFailed: number;
  creditEstimate: number;
}

interface PoolReplayResult {
  pool: string;
  symbol: string;
  swapCount: number;
  signalCount: number;
  replayResult: {
    edgeScore: number;
    avgReturnPct: number;
    avgMfePct: number;
    avgMaePct: number;
    decision: string;
  };
}

interface SummaryOutput {
  fetchedAt: string;
  pools: PoolReplayResult[];
  aggregate: {
    totalPools: number;
    totalSwaps: number;
    totalSignals: number;
    avgEdgeScore: number;
    positivePoolRatio: number;
    avgReturnPct: number;
    decision: string;
  };
  triggerConfig: MomentumTriggerConfig;
  creditUsed: number;
}

// ─── Rate Limiter ───

class RateLimiter {
  private lastRequestMs = 0;
  private backoffMs: number;
  constructor(
    private readonly minIntervalMs: number,
    private readonly concurrency: number,
  ) {
    this.backoffMs = minIntervalMs;
  }

  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestMs;
    if (elapsed < this.backoffMs) {
      await sleep(this.backoffMs - elapsed);
    }
    this.lastRequestMs = Date.now();
  }

  onSuccess(): void {
    this.backoffMs = this.minIntervalMs;
  }

  onRateLimit(): void {
    this.backoffMs = Math.min(this.backoffMs * 2, 5000);
  }

  getConcurrency(): number {
    return this.concurrency;
  }
}

// ─── Signature Fetching ───

// Why: getSignaturesForAddress는 시간 필터 불가, 최신→과거 역순.
// 최신부터 maxSigs개만 빠르게 수집하고, 파싱 후 시간 기반 window 분할한다.
async function fetchRecentSignatures(
  connection: Connection,
  pool: PublicKey,
  limiter: RateLimiter,
  maxSigs: number,
  // 2026-05-01 (Helius Stream A): pagination 횟수 별도 trace — 호출자가 credit estimate 합산.
  creditTrace?: { signatureFetchCalls: number },
): Promise<string[]> {
  const allSigs: string[] = [];
  let before: string | undefined;
  let page = 0;
  let retries = 0;

  while (allSigs.length < maxSigs) {
    await limiter.wait();
    page++;

    const options: { limit: number; before?: string } = { limit: 1000 };
    if (before) options.before = before;

    let batch: ConfirmedSignatureInfo[];
    try {
      batch = await connection.getSignaturesForAddress(pool, options);
      // 2026-05-01 (Helius Stream A): getSignaturesForAddress = Standard RPC 1 credit per call.
      if (creditTrace) creditTrace.signatureFetchCalls += 1;
      limiter.onSuccess();
      retries = 0;
    } catch (err: unknown) {
      if (isRateLimitError(err)) {
        limiter.onRateLimit();
        await sleep(2000);
        continue;
      }
      retries++;
      if (retries > 3) throw err;
      log(`    RPC error, retry ${retries}/3...`);
      await sleep(3000 * retries);
      continue;
    }

    if (batch.length === 0) break;

    for (const sig of batch) {
      if (!sig.err) {
        allSigs.push(sig.signature);
        if (allSigs.length >= maxSigs) break;
      }
    }

    if (page % 5 === 0) {
      log(`  Page ${page}: ${allSigs.length}/${maxSigs} sigs`);
    }

    if (batch.length < 1000 || allSigs.length >= maxSigs) break;
    before = batch[batch.length - 1].signature;
  }

  return allSigs;
}

// ─── Transaction Batch Parsing ───

async function fetchAndParseSwaps(
  connection: Connection,
  signatures: string[],
  poolTarget: PoolTarget,
  metadata: RealtimePoolMetadata,
  limiter: RateLimiter,
  maxTxs: number,
): Promise<{ swaps: StoredRealtimeSwap[]; parseFailed: number; creditEstimate: number }> {
  const limited = signatures.slice(0, maxTxs);
  const swaps: StoredRealtimeSwap[] = [];
  let parseFailed = 0;
  let creditEstimate = 0;
  const batchSize = limiter.getConcurrency();

  for (let i = 0; i < limited.length; i += batchSize) {
    const batch = limited.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (sig) => {
        await limiter.wait();
        // 2026-05-01 (Helius Stream A 보정): Standard RPC `getParsedTransaction` = 1 credit.
        //   이전 100 credits 가정은 Enhanced Transactions API 의 cost — 본 script 는 표준 RPC 사용.
        //   Source: https://www.helius.dev/docs/billing/credits — Standard RPC 1c, Enhanced parsing 100c.
        //   결과: 누적 estimate 100배 과대 → 실제 burn 의 1% 수준.
        creditEstimate += 1; // getParsedTransaction (Standard RPC) = 1 credit
        try {
          const tx = await connection.getParsedTransaction(sig, {
            maxSupportedTransactionVersion: 0,
          });
          limiter.onSuccess();
          return { sig, tx };
        } catch (err: unknown) {
          if (isRateLimitError(err)) {
            limiter.onRateLimit();
            return { sig, tx: null };
          }
          return { sig, tx: null };
        }
      }),
    );

    for (const { sig, tx } of results) {
      if (!tx) {
        parseFailed++;
        continue;
      }

      const parsed = parseSwapFromTransaction(tx, {
        poolAddress: poolTarget.poolAddress,
        signature: sig,
        slot: tx.slot,
        timestamp: tx.blockTime ?? undefined,
        poolMetadata: metadata,
      });

      if (parsed) {
        swaps.push({
          ...parsed,
          pairAddress: poolTarget.poolAddress,
          poolAddress: poolTarget.poolAddress,
          tokenMint: poolTarget.baseMint,
          tokenSymbol: poolTarget.baseSymbol,
        });
      } else {
        parseFailed++;
      }
    }

    if (i + batchSize < limited.length) {
      const pct = ((i + batchSize) / limited.length * 100).toFixed(0);
      log(`  Parsed ${i + batchSize}/${limited.length} txs (${pct}%) — ${swaps.length} swaps`);
    }
  }

  return { swaps, parseFailed, creditEstimate };
}

// ─── Pool Metadata Resolution ───

async function resolvePoolMetadata(
  connection: Connection,
  poolAddress: string,
  baseMint: string,
  quoteMint: string,
  limiter: RateLimiter,
): Promise<RealtimePoolMetadata> {
  // Pool program
  await limiter.wait();
  const poolInfo = await connection.getAccountInfo(new PublicKey(poolAddress));
  limiter.onSuccess();
  const poolProgram = poolInfo?.owner?.toBase58() ?? 'unknown';

  // Base decimals
  await limiter.wait();
  const baseInfo = await connection.getParsedAccountInfo(new PublicKey(baseMint));
  limiter.onSuccess();
  const baseDecimals = extractDecimals(baseInfo);

  // Quote decimals
  await limiter.wait();
  const quoteInfo = await connection.getParsedAccountInfo(new PublicKey(quoteMint));
  limiter.onSuccess();
  const quoteDecimals = extractDecimals(quoteInfo);

  return {
    dexId: mapProgramToDex(poolProgram),
    baseMint,
    quoteMint,
    baseDecimals,
    quoteDecimals,
    poolProgram,
  };
}

function extractDecimals(info: { value: unknown } | null): number | undefined {
  const value = info?.value as { data?: { parsed?: { info?: { decimals?: number } } } } | null;
  return value?.data?.parsed?.info?.decimals;
}

function mapProgramToDex(program: string): string {
  if (program.includes('675k')) return 'raydium';
  if (program.includes('CAMMCzo5YL8w4VFF8KVHr7Uh8gAo')) return 'raydium_clmm';
  if (program.includes('whirL')) return 'orca';
  return 'unknown';
}

// ─── GeckoTerminal Top Pools (paginated) ───

// Why: GeckoTerminal /pools endpoint returns top pools by volume, 20/page, max 10 pages
async function fetchTopPoolsFromGecko(count: number): Promise<PoolTarget[]> {
  const pagesNeeded = Math.min(Math.ceil(count / 20), 10); // max 10 pages = 200 pools
  const seen = new Set<string>();
  const targets: PoolTarget[] = [];

  for (let page = 1; page <= pagesNeeded && targets.length < count; page++) {
    log(`  Fetching GeckoTerminal top pools page ${page}/${pagesNeeded}...`);
    await sleep(2500); // GeckoTerminal rate limit: 30 req/min

    try {
      const res = await axios.get(
        `https://api.geckoterminal.com/api/v2/networks/solana/pools`,
        {
          params: { page, include: 'base_token,quote_token' },
          headers: { Accept: 'application/json' },
          timeout: 15_000,
        },
      );

      const data = res.data as {
        data?: Array<{
          id?: string;
          attributes?: {
            address?: string;
            name?: string;
            reserve_in_usd?: string;
            volume_usd?: Record<string, string>;
          };
          relationships?: {
            base_token?: { data?: { id?: string } };
            quote_token?: { data?: { id?: string } };
          };
        }>;
        included?: Array<{
          id?: string;
          attributes?: { symbol?: string; address?: string };
        }>;
      };

      if (!data?.data?.length) break;

      // Build token lookup
      const tokenMap = new Map<string, { symbol: string; address: string }>();
      if (Array.isArray(data.included)) {
        for (const token of data.included) {
          if (token.id && token.attributes) {
            tokenMap.set(token.id, {
              symbol: token.attributes.symbol ?? '',
              address: token.attributes.address ?? token.id.replace('solana_', ''),
            });
          }
        }
      }

      for (const pool of data.data) {
        if (targets.length >= count) break;
        const addr = pool.attributes?.address ?? pool.id?.replace('solana_', '') ?? '';
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);

        const baseTokenId = pool.relationships?.base_token?.data?.id;
        const quoteTokenId = pool.relationships?.quote_token?.data?.id;
        const baseToken = baseTokenId ? tokenMap.get(baseTokenId) : undefined;
        const quoteToken = quoteTokenId ? tokenMap.get(quoteTokenId) : undefined;

        // TVL 필터: 너무 작은 풀 제외
        const tvl = parseFloat(pool.attributes?.reserve_in_usd ?? '0') || 0;
        if (tvl < 10_000) continue;

        targets.push({
          poolAddress: addr,
          baseMint: baseToken?.address ?? baseTokenId?.replace('solana_', '') ?? '',
          quoteMint: quoteToken?.address ?? quoteTokenId?.replace('solana_', '') ?? '',
          baseSymbol: baseToken?.symbol ?? '',
          quoteSymbol: quoteToken?.symbol ?? '',
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  Warning: GeckoTerminal page ${page} failed: ${msg}`);
      if (page === 1) throw new Error('Cannot fetch top pools from GeckoTerminal');
      break;
    }
  }

  return targets;
}

// ─── Pool Source Resolution ───

async function resolvePoolTargets(args: CliArgs): Promise<PoolTarget[]> {
  if (args.pools.length > 0) {
    const gecko = new GeckoTerminalClient();
    const targets: PoolTarget[] = [];
    for (const addr of args.pools) {
      const pool = await gecko.getPoolInfo(addr);
      if (pool) {
        targets.push({
          poolAddress: pool.address,
          baseMint: pool.baseTokenAddress,
          quoteMint: pool.quoteTokenAddress,
          baseSymbol: pool.baseTokenSymbol,
          quoteSymbol: pool.quoteTokenSymbol,
        });
      } else {
        log(`Warning: Could not resolve pool ${addr}, skipping`);
      }
    }
    return targets;
  }

  // --top <N>: GeckoTerminal top pools by volume (paginated, max 200)
  if (args.top > 0) {
    return fetchTopPoolsFromGecko(args.top);
  }

  if (args.trending) {
    const gecko = new GeckoTerminalClient();
    const pools = await gecko.getTrendingPools();
    return pools.slice(0, args.trendingCount).map((p: GeckoPool) => ({
      poolAddress: p.address,
      baseMint: p.baseTokenAddress,
      quoteMint: p.quoteTokenAddress,
      baseSymbol: p.baseTokenSymbol,
      quoteSymbol: p.quoteTokenSymbol,
    }));
  }

  throw new Error('Specify --pools <addr,...>, --top <N>, or --trending');
}

// ─── Replay ───

// Why: window 기반 샘플링된 swaps는 시간 갭이 크므로, 연속 구간끼리 묶어 개별 replay
function splitIntoWindows(swaps: StoredRealtimeSwap[], maxGapSec = 120): StoredRealtimeSwap[][] {
  if (swaps.length === 0) return [];
  const sorted = [...swaps].sort((a, b) => a.timestamp - b.timestamp);
  const windows: StoredRealtimeSwap[][] = [[]];
  let current = windows[0];
  current.push(sorted[0]);

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].timestamp - sorted[i - 1].timestamp;
    if (gap > maxGapSec) {
      current = [];
      windows.push(current);
    }
    current.push(sorted[i]);
  }

  return windows.filter((w) => w.length >= 10);
}

async function runReplay(
  swaps: StoredRealtimeSwap[],
  triggerConfig: MomentumTriggerConfig,
  estimatedCostPct: number,
): Promise<PoolReplayResult['replayResult'] | null> {
  const windows = splitIntoWindows(swaps);
  if (windows.length === 0) {
    log(`  Skipping replay: no valid windows (need 10+ consecutive swaps)`);
    return null;
  }

  log(`  Replay: ${windows.length} windows, sizes: [${windows.map((w) => w.length).join(', ')}]`);

  const options: MicroReplayOptions = {
    triggerConfig,
    horizonsSec: [30, 60, 180, 300],
    gateMode: 'off',
    estimatedCostPct,
  };

  // Window별 replay 후 결과 합산
  let totalSignals = 0;
  let sumEdge = 0;
  let sumReturn = 0;
  let sumMfe = 0;
  let sumMae = 0;
  let windowsWithSignals = 0;

  for (const window of windows) {
    const result = await replayRealtimeDataset(window, options);
    const signals = result.summary.totalSignals;
    totalSignals += signals;
    if (signals > 0) {
      windowsWithSignals++;
      sumEdge += result.summary.assessment.edgeScore;
      sumReturn += result.summary.avgReturnPct;
      sumMfe += result.summary.avgMfePct;
      sumMae += result.summary.avgMaePct;
    }
  }

  if (windowsWithSignals === 0) {
    log(`  No signals across ${windows.length} windows`);
    return {
      edgeScore: 10,
      avgReturnPct: 0,
      avgMfePct: 0,
      avgMaePct: 0,
      decision: 'reject_gate',
    };
  }

  return {
    edgeScore: sumEdge / windowsWithSignals,
    avgReturnPct: sumReturn / windowsWithSignals,
    avgMfePct: sumMfe / windowsWithSignals,
    avgMaePct: sumMae / windowsWithSignals,
    decision: sumEdge / windowsWithSignals >= 70 ? 'ready_for_paper'
      : sumEdge / windowsWithSignals >= 50 ? 'keep_watch' : 'needs_tuning',
  };
}

// ─── CLI ───

interface CliArgs {
  pools: string[];
  top: number;
  trending: boolean;
  trendingCount: number;
  days: number;
  primaryInterval: number;
  confirmInterval: number;
  volumeMultiplier: number;
  estimatedCostPct: number;
  outputDir: string;
  json: boolean;
  skipReplay: boolean;
  dryRun: boolean;
  maxTxsPerPool: number;
  concurrency: number;
  minIntervalMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  return {
    pools: getArg(argv, '--pools')?.split(',').filter(Boolean) ?? [],
    top: numArg(argv, '--top', 0),
    trending: argv.includes('--trending'),
    trendingCount: numArg(argv, '--trending-count', 10),
    days: numArg(argv, '--days', 3),
    primaryInterval: numArg(argv, '--primary-interval', 15),
    confirmInterval: numArg(argv, '--confirm-interval', 60),
    volumeMultiplier: numArg(argv, '--volume-multiplier', 3.0),
    estimatedCostPct: numArg(argv, '--estimated-cost-pct', 0.0065),
    outputDir: getArg(argv, '--output') || 'data/historical-swaps',
    json: argv.includes('--json'),
    skipReplay: argv.includes('--skip-replay'),
    dryRun: argv.includes('--dry-run'),
    maxTxsPerPool: numArg(argv, '--max-txs-per-pool', 5000),
    concurrency: numArg(argv, '--concurrency', 2),
    minIntervalMs: numArg(argv, '--min-interval-ms', 200),
  };
}

// ─── Main ───

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    printHelp();
    return;
  }

  const args = parseArgs(argv);
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error('SOLANA_RPC_URL env required');

  const connection = new Connection(rpcUrl, 'confirmed');
  const limiter = new RateLimiter(args.minIntervalMs, args.concurrency);

  const now = Math.floor(Date.now() / 1000);
  const fromTimestamp = now - args.days * 86400;
  const toTimestamp = now;

  const triggerConfig: MomentumTriggerConfig = {
    primaryIntervalSec: args.primaryInterval,
    confirmIntervalSec: args.confirmInterval,
    volumeSurgeLookback: 20,
    volumeSurgeMultiplier: args.volumeMultiplier,
    priceBreakoutLookback: 20,
    confirmMinBars: 3,
    confirmMinPriceChangePct: 0.02,
    cooldownSec: 300,
  };

  log('Resolving pool targets...');
  const targets = await resolvePoolTargets(args);
  log(`Found ${targets.length} pools`);

  // Credit budget warning
  const worstCaseCredits = targets.length * args.maxTxsPerPool * 100;
  log(`Credit budget (worst case): ~${(worstCaseCredits / 1_000_000).toFixed(1)}M credits`);
  if (worstCaseCredits > 8_000_000) {
    log(`WARNING: Estimated credits exceed 8M (monthly limit 10M). Consider:`);
    log(`  --max-txs-per-pool ${Math.floor(8_000_000 / targets.length / 100)}`);
    log(`  --days 1`);
    log(`  --dry-run (to check signature counts first)`);
  }

  const outputBase = path.resolve(args.outputDir);
  await mkdir(outputBase, { recursive: true });

  const poolResults: PoolReplayResult[] = [];
  let totalCreditUsed = 0;

  // Graceful shutdown — 이미 수집된 데이터 보존
  let aborted = false;
  const onSignal = () => {
    log('\nCtrl+C detected. Finishing current pool...');
    aborted = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  for (let idx = 0; idx < targets.length; idx++) {
    if (aborted) break;

    const target = targets[idx];
    const poolLabel = `${target.baseSymbol}/${target.quoteSymbol}`;
    log(`\n[pool ${idx + 1}/${targets.length}] ${poolLabel} (${target.poolAddress})`);

    // 1. Resolve metadata
    log('  Resolving pool metadata...');
    const metadata = await resolvePoolMetadata(
      connection,
      target.poolAddress,
      target.baseMint,
      target.quoteMint,
      limiter,
    );
    totalCreditUsed += 3; // 3 getAccountInfo calls
    log(`  Program: ${metadata.poolProgram} | Decimals: base=${metadata.baseDecimals} quote=${metadata.quoteDecimals}`);

    // 2. Fetch recent signatures (최신부터 maxTxsPerPool개)
    log('  Fetching recent signatures...');
    const sigCreditTrace = { signatureFetchCalls: 0 };
    const allSignatures = await fetchRecentSignatures(
      connection,
      new PublicKey(target.poolAddress),
      limiter,
      args.dryRun ? 1000 : args.maxTxsPerPool,
      sigCreditTrace,
    );
    // 2026-05-01 (Stream A 보정): getSignaturesForAddress = 1 credit per call (Standard RPC).
    //   이전 산식 `Math.ceil(allSignatures.length / 1000)` 은 정확하지만 lower bound — pagination 실패/빈 page 미반영.
    //   이제 호출 횟수 직접 trace 로 정확히 합산.
    totalCreditUsed += sigCreditTrace.signatureFetchCalls;
    log(`  Collected ${allSignatures.length} signatures (${sigCreditTrace.signatureFetchCalls} pagination calls)`);

    if (args.dryRun) {
      // 2026-05-01 (Stream A 보정): getParsedTransaction = 1 credit (Standard RPC), not 100c.
      log(`  [dry-run] Would fetch ${args.maxTxsPerPool} txs = ~${args.maxTxsPerPool} credits (Standard RPC 1c each)`);
      continue;
    }

    if (allSignatures.length === 0) {
      log('  No signatures found, skipping');
      continue;
    }

    // 3. Fetch + parse transactions
    log('  Fetching & parsing transactions...');
    const { swaps, parseFailed, creditEstimate } = await fetchAndParseSwaps(
      connection,
      allSignatures,
      target,
      metadata,
      limiter,
      args.maxTxsPerPool,
    );
    totalCreditUsed += creditEstimate;
    log(`  Parsed: ${swaps.length} swaps, ${parseFailed} failed, ~${creditEstimate} credits`);

    // 4. Save to disk
    const poolDir = path.join(outputBase, target.poolAddress.slice(0, 16));
    const store = new RealtimeReplayStore(poolDir);
    // Sort by timestamp for append order
    const sortedSwaps = [...swaps].sort((a, b) => a.timestamp - b.timestamp);
    for (const swap of sortedSwaps) {
      await store.appendSwap(swap);
    }

    const manifest = {
      pool: target.poolAddress,
      symbol: poolLabel,
      baseMint: target.baseMint,
      quoteMint: target.quoteMint,
      period: { from: new Date(fromTimestamp * 1000).toISOString(), to: new Date(toTimestamp * 1000).toISOString() },
      counts: { signatures: allSignatures.length, swaps: swaps.length, parseFailed },
      fetchedAt: new Date().toISOString(),
    };
    await writeFile(path.join(poolDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    log(`  Saved to ${poolDir}`);

    // 5. Replay
    if (!args.skipReplay && !aborted) {
      log('  Running replay...');
      const replay = await runReplay(sortedSwaps, triggerConfig, args.estimatedCostPct);

      poolResults.push({
        pool: target.poolAddress,
        symbol: poolLabel,
        swapCount: swaps.length,
        signalCount: replay ? Math.round(replay.edgeScore > 0 ? replay.edgeScore / 10 : 0) : 0,
        replayResult: replay ?? {
          edgeScore: 0,
          avgReturnPct: 0,
          avgMfePct: 0,
          avgMaePct: 0,
          decision: 'insufficient_data',
        },
      });

      if (replay) {
        log(`  Edge Score: ${replay.edgeScore.toFixed(1)} | Return: ${(replay.avgReturnPct * 100).toFixed(2)}% | Decision: ${replay.decision}`);
      }
    }
  }

  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);

  // 6. Aggregate summary
  if (!args.skipReplay && poolResults.length > 0) {
    const totalSwaps = poolResults.reduce((s, p) => s + p.swapCount, 0);
    const totalSignals = poolResults.reduce((s, p) => s + p.signalCount, 0);
    const positivePoolCount = poolResults.filter((p) => p.replayResult.avgReturnPct > 0).length;
    const avgEdge = poolResults.reduce((s, p) => s + p.replayResult.edgeScore, 0) / poolResults.length;
    const avgReturn = poolResults.reduce((s, p) => s + p.replayResult.avgReturnPct, 0) / poolResults.length;

    const summary: SummaryOutput = {
      fetchedAt: new Date().toISOString(),
      pools: poolResults,
      aggregate: {
        totalPools: poolResults.length,
        totalSwaps,
        totalSignals,
        avgEdgeScore: Math.round(avgEdge * 10) / 10,
        positivePoolRatio: poolResults.length > 0 ? positivePoolCount / poolResults.length : 0,
        avgReturnPct: avgReturn,
        decision: avgEdge >= 70 ? 'ready_for_paper' : avgEdge >= 50 ? 'keep_watch' : 'needs_tuning',
      },
      triggerConfig,
      creditUsed: totalCreditUsed,
    };

    await writeFile(path.join(outputBase, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printSummary(summary);
    }
  }

  log(`\nTotal estimated credits used: ${totalCreditUsed}`);
  log('Done.');
}

// ─── Output ───

function printSummary(summary: SummaryOutput): void {
  console.log('\n' + '='.repeat(72));
  console.log('Historical Swap Backtest Summary');
  console.log('='.repeat(72));

  for (const pool of summary.pools) {
    const r = pool.replayResult;
    console.log(
      `  ${pool.symbol.padEnd(15)} ` +
      `Swaps: ${String(pool.swapCount).padStart(5)} | ` +
      `Edge: ${r.edgeScore.toFixed(1).padStart(5)} | ` +
      `Return: ${(r.avgReturnPct * 100).toFixed(2).padStart(7)}% | ` +
      `${r.decision}`,
    );
  }

  const a = summary.aggregate;
  console.log('-'.repeat(72));
  console.log(
    `  AGGREGATE      ` +
    `Pools: ${a.totalPools} | Swaps: ${a.totalSwaps} | Signals: ${a.totalSignals}`,
  );
  console.log(
    `                 ` +
    `Avg Edge: ${a.avgEdgeScore.toFixed(1)} | ` +
    `Positive Pools: ${(a.positivePoolRatio * 100).toFixed(0)}% | ` +
    `Avg Return: ${(a.avgReturnPct * 100).toFixed(2)}%`,
  );
  console.log(`  Decision: ${a.decision}`);
  console.log(`  Credits used: ~${summary.creditUsed}`);
  console.log('='.repeat(72));
}

function printHelp(): void {
  console.log(`
Historical Swap Backtest — Helius RPC 과거 swap 수집 + replay

Usage:
  npx ts-node scripts/fetch-historical-swaps.ts [options]

Source (택 1):
  --pools <addr1,addr2,...>    풀 주소 직접 지정
  --top <N>                    GeckoTerminal 거래량 상위 N개 (최대 200, TVL>$10K)
  --trending                   GeckoTerminal trending 자동
  --trending-count <N>         trending에서 N개 선택 (기본: 10)

Period:
  --days <N>                   최근 N일 (기본: 3)

Replay:
  --primary-interval <sec>     15 (기본)
  --confirm-interval <sec>     60 (기본)
  --volume-multiplier <N>      3.0 (기본)
  --estimated-cost-pct <N>     0.0065 (기본)

Output:
  --output <dir>               저장 디렉토리 (기본: data/historical-swaps)
  --json                       JSON 요약 출력
  --skip-replay                수집만, replay 생략

Safety:
  --dry-run                    시그니처만 수집, 트랜잭션 fetch 생략
  --max-txs-per-pool <N>       풀당 최대 트랜잭션 수 (기본: 5000)
  --concurrency <N>            동시 요청 수 (기본: 5)
  --min-interval-ms <N>        요청 간격 ms (기본: 25)
`);
}

// ─── Helpers ───

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function numArg(args: string[], flag: string, fallback: number): number {
  const raw = getArg(args, flag);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number for ${flag}: "${raw}"`);
  return parsed;
}

function log(msg: string): void {
  console.error(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { message?: string; status?: number; statusCode?: number };
  if (e.status === 429 || e.statusCode === 429) return true;
  return typeof e.message === 'string' && (e.message.includes('429') || e.message.includes('rate limit'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
