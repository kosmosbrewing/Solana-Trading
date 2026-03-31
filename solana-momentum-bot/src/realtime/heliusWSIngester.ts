import { EventEmitter } from 'events';
import { Connection, Logs, PublicKey } from '@solana/web3.js';
import { SOL_MINT } from '../utils/constants';
import { createModuleLogger } from '../utils/logger';
import { fetchRecentSwapsForPool } from './recentSwapBackfill';
import { RealtimeSwapSanitizer } from './swapSanitizer';
import { HeliusWSConfig, ParsedSwap, RealtimePoolMetadata } from './types';
import {
  isLikelyPumpSwapFallbackLog,
  parseSwapFromTransaction,
  shouldForceFallbackToTransaction,
  shouldFallbackToTransaction,
  tryParseSwapFromLogs,
} from './swapParser';

const log = createModuleLogger('HeliusWSIngester');

export class HeliusWSIngester extends EventEmitter {
  private readonly connection: Connection;
  private readonly maxSubscriptions: number;
  private readonly fallbackConcurrency: number;
  private readonly fallbackRequestsPerSecond: number;
  private readonly fallbackBatchSize: number;
  private readonly maxFallbackQueue: number;
  private readonly disableSingleTxFallbackOnBatchUnsupported: boolean;
  private readonly watchdogIntervalMs: number;
  private readonly fallbackMaxRetries: number;
  private readonly subscriptions = new Map<string, number>();
  private readonly poolMetadata = new Map<string, RealtimePoolMetadata>();
  private readonly mintDecimals = new Map<string, number>();
  private readonly swapSanitizer = new RealtimeSwapSanitizer();
  private readonly fallbackQueue: Array<{ pool: string; signature: string; slot: number; retries: number }> = [];
  private readonly pendingFallbacks = new Set<string>();
  private readonly fallbackStartsAt: number[] = [];
  private inFlightFallbacks = 0;
  private batchFallbackSupported = true;
  private batchUnsupportedWarned = false;
  private fallbackTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private lastRateLimitWarnAt = 0;
  private lastNotificationAt = 0;

  constructor(config: HeliusWSConfig) {
    super();
    this.connection = new Connection(config.rpcHttpUrl, {
      commitment: 'confirmed',
      wsEndpoint: config.rpcWsUrl,
    });
    this.maxSubscriptions = config.maxSubscriptions;
    this.fallbackConcurrency = config.fallbackConcurrency ?? 2;
    this.fallbackRequestsPerSecond = config.fallbackRequestsPerSecond ?? 4;
    this.fallbackBatchSize = Math.max(1, config.fallbackBatchSize ?? 5);
    this.maxFallbackQueue = config.maxFallbackQueue ?? 200;
    this.disableSingleTxFallbackOnBatchUnsupported =
      config.disableSingleTxFallbackOnBatchUnsupported ?? true;
    this.watchdogIntervalMs = config.watchdogIntervalMs ?? 60_000;
    this.fallbackMaxRetries = config.fallbackMaxRetries ?? 3;
  }

  setPoolMetadata(pool: string, metadata: RealtimePoolMetadata): void {
    this.poolMetadata.set(pool, metadata);
  }

  clearPoolMetadata(pool: string): void {
    this.poolMetadata.delete(pool);
  }

  async backfillRecentSwaps(
    pool: string,
    options: { lookbackSec: number; maxSignatures?: number; allowSingleFetchFallback?: boolean }
  ): Promise<ParsedSwap[]> {
    const poolMetadata = await this.resolvePoolMetadata(pool);
    const swaps = await fetchRecentSwapsForPool(this.connection, pool, poolMetadata, options);
    return this.swapSanitizer.seed(swaps).swaps;
  }

  async subscribePools(pools: string[]): Promise<void> {
    const targetPools = [...new Set(pools)].slice(0, this.maxSubscriptions);
    const targetSet = new Set(targetPools);

    for (const existingPool of [...this.subscriptions.keys()]) {
      if (!targetSet.has(existingPool)) {
        await this.unsubscribePool(existingPool);
      }
    }

    for (const pool of targetPools) {
      if (this.subscriptions.has(pool)) continue;
      try {
        const publicKey = new PublicKey(pool);
        const subscriptionId = this.connection.onLogs(
          publicKey,
          (logs, ctx) => {
            void this.handleLogNotification(pool, logs, ctx.slot);
          },
          'confirmed'
        );
        this.subscriptions.set(pool, subscriptionId);
      } catch (error) {
        this.emit('error', { pool, error });
      }
    }

    if (this.subscriptions.size > 0) {
      this.emit('connected');
      log.info(`Helius WS subscriptions active: ${this.subscriptions.size}`);
      // 최초 구독 시각을 기준점으로 설정 — 이후 silentMs 계산의 baseline
      if (this.lastNotificationAt === 0) {
        this.lastNotificationAt = Date.now();
      }
      this.startWatchdog();
    }
  }

  async unsubscribePools(pools: string[]): Promise<void> {
    for (const pool of pools) {
      await this.unsubscribePool(pool);
    }
  }

  async stop(): Promise<void> {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = undefined;
    }
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    this.fallbackQueue.length = 0;
    this.pendingFallbacks.clear();
    await this.unsubscribePools([...this.subscriptions.keys()]);
    this.emit('disconnected');
  }

  private async unsubscribePool(pool: string): Promise<void> {
    const subscriptionId = this.subscriptions.get(pool);
    if (subscriptionId == null) return;
    await this.connection.removeOnLogsListener(subscriptionId);
    this.subscriptions.delete(pool);
  }

  private startWatchdog(): void {
    if (this.watchdogIntervalMs <= 0) return;
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);

    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = undefined;
      const silentMs = Date.now() - this.lastNotificationAt;
      if (silentMs >= this.watchdogIntervalMs && this.subscriptions.size > 0) {
        log.warn(`WS silent for ${Math.round(silentMs / 1000)}s — re-subscribing`);
        this.emit('stale', { silentMs });
        // 현재 구독 목록을 실제로 재연결해야 silent socket을 복구할 수 있음
        void this.reconnectSubscriptions().catch((error) => {
          log.warn(`Watchdog re-subscribe failed: ${error}`);
          this.emit('error', { pool: 'watchdog', error });
        });
      } else {
        this.startWatchdog();
      }
    }, this.watchdogIntervalMs);
  }

  private async handleLogNotification(pool: string, logs: Logs, slot: number): Promise<void> {
    this.lastNotificationAt = Date.now();
    this.startWatchdog(); // 매 알림마다 watchdog 리셋
    if (logs.err) return;

    const poolMetadata = await this.resolvePoolMetadata(pool);
    const parsedFromLogs = tryParseSwapFromLogs(logs.logs, {
      poolAddress: pool,
      signature: logs.signature,
      slot,
      poolMetadata,
    });
    if (parsedFromLogs) {
      this.emitSwap(parsedFromLogs);
      return;
    }

    this.emit('parseMiss', { pool, signature: logs.signature, slot });
    const forceFallback = shouldForceFallbackToTransaction(poolMetadata);
    if (forceFallback) {
      const joined = logs.logs.join('\n');
      if (/no arbitrage/i.test(joined) || /is_cashback_coin=false/i.test(joined)) {
        this.emit('fallbackSkipped', { pool, signature: logs.signature, reason: 'pump_noise_log' });
        return;
      }
      const queueUtilization = this.maxFallbackQueue > 0
        ? this.fallbackQueue.length / this.maxFallbackQueue
        : 0;
      if (queueUtilization >= 0.5 && !isLikelyPumpSwapFallbackLog(logs.logs)) {
        this.emit('fallbackSkipped', { pool, signature: logs.signature, reason: 'pump_backpressure_skip' });
        return;
      }
    }

    if (!forceFallback && !shouldFallbackToTransaction(logs.logs)) {
      this.emit('fallbackSkipped', { pool, signature: logs.signature, reason: 'not_swap_like' });
      return;
    }
    this.enqueueFallback(pool, logs.signature, slot);
  }

  private enqueueFallback(pool: string, signature: string, slot: number, retries = 0): void {
    const key = `${pool}:${signature}`;
    if (this.pendingFallbacks.has(key)) return;

    if (this.fallbackQueue.length >= this.maxFallbackQueue) {
      this.emit('fallbackDropped', { pool, signature, reason: 'queue_full' });
      return;
    }

    this.pendingFallbacks.add(key);
    this.fallbackQueue.push({ pool, signature, slot, retries });
    this.emit('fallbackQueued', { pool, signature, queueSize: this.fallbackQueue.length });
    this.processFallbackQueue();
  }

  private processFallbackQueue(): void {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = undefined;
    }

    const now = Date.now();
    while (
      this.fallbackStartsAt.length > 0 &&
      now - this.fallbackStartsAt[0] >= 1000
    ) {
      this.fallbackStartsAt.shift();
    }

    while (
      this.fallbackQueue.length > 0 &&
      this.inFlightFallbacks < this.fallbackConcurrency &&
      this.fallbackStartsAt.length < this.fallbackRequestsPerSecond
    ) {
      const batchSize = this.batchFallbackSupported ? this.fallbackBatchSize : 1;
      const batch = this.fallbackQueue.splice(0, batchSize);
      this.inFlightFallbacks += 1;
      this.fallbackStartsAt.push(Date.now());
      for (const next of batch) {
        this.emit('fallbackAttempt', { pool: next.pool, signature: next.signature });
      }

      // catch/finally 공유 — 429 retry 예약된 키 추적용
      const retryKeys = new Set<string>();
      void this.enrichSwapsFromTxBatch(batch)
        .then((results) => {
          for (const next of batch) {
            const fallback = results.get(`${next.pool}:${next.signature}`) ?? null;
            if (fallback) {
              this.emit('fallbackResult', {
                pool: next.pool,
                signature: next.signature,
                outcome: 'parsed',
              });
              this.emitSwap(fallback);
              continue;
            }
            this.emit('fallbackResult', {
              pool: next.pool,
              signature: next.signature,
              outcome: 'unparsed',
            });
          }
        })
        .catch((error) => {
          const retryable = this.isRetryableFallbackError(error);
          const isRateLimited = this.isRateLimitedFallbackError(error);
          if (!isRateLimited || Date.now() - this.lastRateLimitWarnAt > 5000) {
            log.warn(`Swap fallback batch failed: ${error}`);
            this.lastRateLimitWarnAt = Date.now();
          }
          for (const next of batch) {
            if (retryable && next.retries < this.fallbackMaxRetries) {
              // 재시도 가능한 fetch/429 오류는 지수 백오프로 복구
              const key = `${next.pool}:${next.signature}`;
              const delayMs = this.getFallbackRetryDelayMs(error, next.retries);
              retryKeys.add(key);
              this.pendingFallbacks.delete(key);
              setTimeout(() => {
                this.enqueueFallback(next.pool, next.signature, next.slot, next.retries + 1);
              }, delayMs);
              this.emit('fallbackRetry', {
                pool: next.pool,
                signature: next.signature,
                retries: next.retries + 1,
                delayMs,
              });
            } else {
              this.emit('error', { pool: next.pool, error });
              this.emit('fallbackResult', {
                pool: next.pool,
                signature: next.signature,
                outcome: 'error',
              });
            }
          }
        })
        .finally(() => {
          this.inFlightFallbacks -= 1;
          for (const next of batch) {
            const key = `${next.pool}:${next.signature}`;
            // retry 예약된 항목은 catch에서 이미 삭제 + setTimeout으로 재추가 예정
            if (!retryKeys.has(key)) {
              this.pendingFallbacks.delete(key);
            }
          }
          this.processFallbackQueue();
        });
    }

    if (
      this.fallbackQueue.length > 0 &&
      this.inFlightFallbacks < this.fallbackConcurrency &&
      this.fallbackStartsAt.length >= this.fallbackRequestsPerSecond
    ) {
      const delayMs = Math.max(50, 1000 - (now - this.fallbackStartsAt[0]));
      this.fallbackTimer = setTimeout(() => {
        this.fallbackTimer = undefined;
        this.processFallbackQueue();
      }, delayMs);
    }
  }

  private async enrichSwapsFromTxBatch(
    batch: Array<{ pool: string; signature: string; slot: number }>
  ): Promise<Map<string, ParsedSwap | null>> {
    let txs;
    if (!this.batchFallbackSupported && this.disableSingleTxFallbackOnBatchUnsupported) {
      txs = batch.map(() => null);
    } else if (!this.batchFallbackSupported || batch.length === 1) {
      txs = await Promise.all(batch.map((entry) => this.fetchParsedTransaction(entry.signature)));
    } else {
      try {
        txs = await this.connection.getParsedTransactions(
          batch.map((entry) => entry.signature),
          {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          }
        );
      } catch (error) {
        if (this.isBatchUnsupportedError(error)) {
          this.batchFallbackSupported = false;
          if (this.disableSingleTxFallbackOnBatchUnsupported) {
            if (!this.batchUnsupportedWarned) {
              log.warn(
                'Parsed transaction batch RPC unavailable on current plan; suppressing single-request fallback to avoid rate-limit storms'
              );
              this.batchUnsupportedWarned = true;
            }
            txs = batch.map(() => null);
          } else {
            log.info('Parsed transaction batch RPC unavailable on current plan; falling back to single-request mode');
            txs = await Promise.all(batch.map((entry) => this.fetchParsedTransaction(entry.signature)));
          }
        } else {
          throw error;
        }
      }
    }

    const metadataCache = new Map<string, RealtimePoolMetadata | undefined>();
    const results = new Map<string, ParsedSwap | null>();

    for (let index = 0; index < batch.length; index += 1) {
      const entry = batch[index];
      const tx = txs[index];
      if (!tx) {
        results.set(`${entry.pool}:${entry.signature}`, null);
        continue;
      }

      if (!metadataCache.has(entry.pool)) {
        metadataCache.set(entry.pool, await this.resolvePoolMetadata(entry.pool));
      }
      const poolMetadata = metadataCache.get(entry.pool);
      results.set(
        `${entry.pool}:${entry.signature}`,
        parseSwapFromTransaction(tx, {
          poolAddress: entry.pool,
          signature: entry.signature,
          slot: entry.slot,
          poolMetadata,
        })
      );
    }

    return results;
  }

  private fetchParsedTransaction(signature: string) {
    return this.connection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
  }

  private async reconnectSubscriptions(): Promise<void> {
    const pools = [...this.subscriptions.keys()];
    if (pools.length === 0) return;

    this.lastNotificationAt = Date.now();
    await this.unsubscribePools(pools);
    await this.subscribePools(pools);
  }

  private isBatchUnsupportedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('Batch requests are only available for paid plans')
      || message.includes('code":-32403');
  }

  private isRetryableFallbackError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return this.isRateLimitedFallbackError(error) || [
      'fetch failed',
      'network error',
      'timeout',
      'timed out',
      'socket hang up',
      'econnreset',
      'econnrefused',
      'eai_again',
      'enotfound',
    ].some((token) => message.includes(token));
  }

  private isRateLimitedFallbackError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('429');
  }

  private getFallbackRetryDelayMs(error: unknown, retries: number): number {
    if (this.isRateLimitedFallbackError(error)) {
      return 5_000 * (2 ** retries);
    }
    return 1_000 * (2 ** retries);
  }

  private emitSwap(swap: ParsedSwap): void {
    if (!Number.isFinite(swap.priceNative) || swap.priceNative <= 0) return;
    if (!Number.isFinite(swap.amountBase) || !Number.isFinite(swap.amountQuote)) return;
    if (!this.swapSanitizer.accept(swap)) {
      this.emit('swapRejected', { pool: swap.pool, signature: swap.signature, reason: 'price_outlier' });
      return;
    }
    this.emit('swap', swap);
  }

  private async resolvePoolMetadata(pool: string): Promise<RealtimePoolMetadata | undefined> {
    const metadata = this.poolMetadata.get(pool);
    if (!metadata) return undefined;
    if (
      metadata.baseDecimals != null &&
      metadata.quoteDecimals != null &&
      metadata.poolProgram
    ) {
      return metadata;
    }

    const resolved: RealtimePoolMetadata = { ...metadata };
    if (!resolved.poolProgram) {
      try {
        const accountInfo = await this.connection.getAccountInfo(new PublicKey(pool), 'confirmed');
        resolved.poolProgram = accountInfo?.owner.toBase58();
      } catch (error) {
        log.warn(`Failed to resolve pool owner for ${pool}: ${error}`);
      }
    }
    if (resolved.baseDecimals == null) {
      resolved.baseDecimals = await this.getMintDecimals(resolved.baseMint);
    }
    if (resolved.quoteDecimals == null) {
      resolved.quoteDecimals = resolved.quoteMint === SOL_MINT
        ? 9
        : await this.getMintDecimals(resolved.quoteMint);
    }
    this.poolMetadata.set(pool, resolved);
    return resolved;
  }

  private async getMintDecimals(mint: string): Promise<number | undefined> {
    const cached = this.mintDecimals.get(mint);
    if (cached != null) return cached;

    try {
      const accountInfo = await this.connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
      const parsed = accountInfo.value?.data as {
        parsed?: { info?: { decimals?: number } };
      } | undefined;
      const decimals = parsed?.parsed?.info?.decimals;
      if (typeof decimals === 'number') {
        this.mintDecimals.set(mint, decimals);
        return decimals;
      }
    } catch (error) {
      log.warn(`Failed to resolve mint decimals for ${mint}: ${error}`);
    }

    return undefined;
  }
}
