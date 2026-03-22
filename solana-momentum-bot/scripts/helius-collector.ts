#!/usr/bin/env ts-node
/**
 * helius-collector.ts
 *
 * 24시간 Helius WS 수집기
 * - GeckoTerminal trending 풀 자동 감지 (30분마다 갱신)
 * - 풀별 raw-swaps.jsonl → data/realtime-swaps/{poolAddress}/raw-swaps.jsonl
 * - PM2로 실행: pm2 start ecosystem.config.cjs
 */

import fs from 'fs';
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { HeliusWSIngester, ParsedSwap } from '../src/realtime';
import { GeckoTerminalClient } from '../src/ingester/geckoTerminalClient';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.resolve(ROOT_DIR, 'data/realtime-swaps');
const POOL_REFRESH_MS = 30 * 60 * 1000; // 30분
const STATUS_LOG_MS = 5 * 60 * 1000; // 5분
const MAX_SUBSCRIPTIONS = parseInt(process.env.REALTIME_MAX_SUBSCRIPTIONS ?? '30', 10);

async function fetchTargetPools(gecko: GeckoTerminalClient): Promise<string[]> {
  // 환경변수로 pool file 지정 시 우선 사용
  const poolFile = process.env.COLLECTOR_POOL_FILE;
  if (poolFile) {
    const abs = path.resolve(ROOT_DIR, poolFile);
    if (fs.existsSync(abs)) {
      const lines = fs.readFileSync(abs, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      console.log(`[collector] pool file: ${abs} (${lines.length} pools)`);
      return lines;
    }
  }

  console.log('[collector] Fetching GeckoTerminal trending pools...');
  const pools = await gecko.getTrendingPools();
  const addresses = pools.map((p) => p.address).filter(Boolean);
  console.log(`[collector] Trending pools: ${addresses.length}`);
  return addresses;
}

async function appendSwapLine(poolAddress: string, swap: ParsedSwap): Promise<void> {
  const dir = path.join(OUTPUT_DIR, poolAddress);
  await mkdir(dir, { recursive: true });
  const record = JSON.stringify({ ...swap, poolAddress, collectedAt: Date.now() });
  await appendFile(path.join(dir, 'raw-swaps.jsonl'), record + '\n', 'utf8');
}

async function main(): Promise<void> {
  const rpcHttpUrl = process.env.SOLANA_RPC_URL ?? '';
  const rpcWsUrl = process.env.HELIUS_WS_URL ?? deriveWsUrl(rpcHttpUrl);

  if (!rpcHttpUrl) {
    console.error('[collector] SOLANA_RPC_URL is required');
    process.exit(1);
  }

  console.log(`[collector] Starting — output: ${OUTPUT_DIR}`);
  console.log(`[collector] RPC: ${rpcHttpUrl}`);
  console.log(`[collector] maxSubscriptions: ${MAX_SUBSCRIPTIONS}`);

  await mkdir(OUTPUT_DIR, { recursive: true });

  const gecko = new GeckoTerminalClient();
  const ingester = new HeliusWSIngester({
    rpcHttpUrl,
    rpcWsUrl,
    maxSubscriptions: MAX_SUBSCRIPTIONS,
  });

  let swapCount = 0;
  let errorCount = 0;
  let writeErrors = 0;

  ingester.on('connected', () => {
    console.log('[collector] WS connected');
  });

  ingester.on('disconnected', () => {
    console.log('[collector] WS disconnected');
  });

  ingester.on('swap', (swap: ParsedSwap) => {
    swapCount++;
    appendSwapLine(swap.pool, swap).catch((err: unknown) => {
      writeErrors++;
      if (writeErrors <= 10) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[collector] write error pool=${swap.pool}: ${msg}`);
      }
    });
  });

  ingester.on('error', ({ pool, error }: { pool: string; error: unknown }) => {
    errorCount++;
    if (errorCount <= 20) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[collector] WS error pool=${pool}: ${msg}`);
    }
  });

  const subscribeTrending = async (): Promise<void> => {
    try {
      const pools = await fetchTargetPools(gecko);
      if (pools.length > 0) {
        await ingester.subscribePools(pools);
        console.log(`[collector] Subscribed to ${Math.min(pools.length, MAX_SUBSCRIPTIONS)} pools`);
      } else {
        console.warn('[collector] No pools found — skipping subscription refresh');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[collector] Pool refresh failed: ${msg}`);
    }
  };

  // 초기 구독
  await subscribeTrending();

  // 30분마다 풀 목록 갱신
  const refreshInterval = setInterval(() => {
    console.log(`[collector] Refreshing pool list (swaps=${swapCount})...`);
    void subscribeTrending();
  }, POOL_REFRESH_MS);

  // 5분마다 상태 로그
  const statusInterval = setInterval(() => {
    console.log(
      `[collector] status swaps=${swapCount} errors=${errorCount} writeErrors=${writeErrors} ts=${new Date().toISOString()}`
    );
  }, STATUS_LOG_MS);

  const shutdown = async (): Promise<void> => {
    clearInterval(refreshInterval);
    clearInterval(statusInterval);
    console.log(`[collector] Shutting down... total swaps=${swapCount}`);
    await ingester.stop().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // PM2가 재시작하지 않도록 무한 대기
  await new Promise<never>(() => {});
}

function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) return `wss://${httpUrl.slice('https://'.length)}`;
  if (httpUrl.startsWith('http://')) return `ws://${httpUrl.slice('http://'.length)}`;
  return httpUrl;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
