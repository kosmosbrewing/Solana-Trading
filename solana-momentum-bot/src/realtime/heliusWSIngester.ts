import { EventEmitter } from 'events';
import { Connection, Logs, PublicKey } from '@solana/web3.js';
import { SOL_MINT } from '../utils/constants';
import { createModuleLogger } from '../utils/logger';
import { HeliusWSConfig, ParsedSwap, RealtimePoolMetadata } from './types';
import {
  parseSwapFromTransaction,
  shouldFallbackToTransaction,
  tryParseSwapFromLogs,
} from './swapParser';

const log = createModuleLogger('HeliusWSIngester');

export class HeliusWSIngester extends EventEmitter {
  private readonly connection: Connection;
  private readonly maxSubscriptions: number;
  private readonly fallbackConcurrency: number;
  private readonly fallbackRequestsPerSecond: number;
  private readonly maxFallbackQueue: number;
  private readonly subscriptions = new Map<string, number>();
  private readonly poolMetadata = new Map<string, RealtimePoolMetadata>();
  private readonly mintDecimals = new Map<string, number>();
  private readonly fallbackQueue: Array<{ pool: string; signature: string; slot: number }> = [];
  private readonly pendingFallbacks = new Set<string>();
  private readonly fallbackStartsAt: number[] = [];
  private inFlightFallbacks = 0;
  private fallbackTimer?: NodeJS.Timeout;
  private lastRateLimitWarnAt = 0;

  constructor(config: HeliusWSConfig) {
    super();
    this.connection = new Connection(config.rpcHttpUrl, {
      commitment: 'confirmed',
      wsEndpoint: config.rpcWsUrl,
    });
    this.maxSubscriptions = config.maxSubscriptions;
    this.fallbackConcurrency = config.fallbackConcurrency ?? 2;
    this.fallbackRequestsPerSecond = config.fallbackRequestsPerSecond ?? 4;
    this.maxFallbackQueue = config.maxFallbackQueue ?? 200;
  }

  setPoolMetadata(pool: string, metadata: RealtimePoolMetadata): void {
    this.poolMetadata.set(pool, metadata);
  }

  clearPoolMetadata(pool: string): void {
    this.poolMetadata.delete(pool);
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

  private async handleLogNotification(pool: string, logs: Logs, slot: number): Promise<void> {
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
    if (!shouldFallbackToTransaction(logs.logs)) {
      this.emit('fallbackSkipped', { pool, signature: logs.signature, reason: 'not_swap_like' });
      return;
    }
    this.enqueueFallback(pool, logs.signature, slot);
  }

  private enqueueFallback(pool: string, signature: string, slot: number): void {
    const key = `${pool}:${signature}`;
    if (this.pendingFallbacks.has(key)) return;

    if (this.fallbackQueue.length >= this.maxFallbackQueue) {
      this.emit('fallbackDropped', { pool, signature, reason: 'queue_full' });
      return;
    }

    this.pendingFallbacks.add(key);
    this.fallbackQueue.push({ pool, signature, slot });
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
      const next = this.fallbackQueue.shift()!;
      this.inFlightFallbacks += 1;
      this.fallbackStartsAt.push(Date.now());
      this.emit('fallbackAttempt', { pool: next.pool, signature: next.signature });

      void this.enrichSwapFromTx(next.pool, next.signature, next.slot)
        .then((fallback) => {
          if (fallback) {
            this.emit('fallbackResult', {
              pool: next.pool,
              signature: next.signature,
              outcome: 'parsed',
            });
            this.emitSwap(fallback);
          } else {
            this.emit('fallbackResult', {
              pool: next.pool,
              signature: next.signature,
              outcome: 'unparsed',
            });
          }
        })
        .finally(() => {
          this.inFlightFallbacks -= 1;
          this.pendingFallbacks.delete(`${next.pool}:${next.signature}`);
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

  private async enrichSwapFromTx(
    pool: string,
    signature: string,
    slot: number
  ): Promise<ParsedSwap | null> {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) return null;
      return parseSwapFromTransaction(tx, {
        poolAddress: pool,
        signature,
        slot,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRateLimited = message.includes('429');
      if (!isRateLimited || Date.now() - this.lastRateLimitWarnAt > 5000) {
        log.warn(`Swap fallback failed for ${pool}: ${error}`);
        this.lastRateLimitWarnAt = Date.now();
        this.emit('error', { pool, error });
      }
      this.emit('fallbackResult', {
        pool,
        signature,
        outcome: 'error',
      });
      return null;
    }
  }

  private emitSwap(swap: ParsedSwap): void {
    if (!Number.isFinite(swap.priceNative) || swap.priceNative <= 0) return;
    if (!Number.isFinite(swap.amountBase) || !Number.isFinite(swap.amountQuote)) return;
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
