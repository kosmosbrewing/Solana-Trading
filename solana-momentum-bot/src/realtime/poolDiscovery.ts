import { EventEmitter } from 'events';
import { Connection, Logs, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { SOL_MINT } from '../utils/constants';
import { createModuleLogger } from '../utils/logger';
import { ObservedPairCandidate } from '../utils/observedPair';
import {
  METEORA_DAMM_V1_PROGRAM,
  METEORA_DAMM_V2_PROGRAM,
  METEORA_DLMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  PUMP_SWAP_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  RAYDIUM_V4_PROGRAM,
} from './swapParser';

const log = createModuleLogger('HeliusPoolDiscovery');
const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdmsQZpLSA9THh2o1hZ9M6wE7wz3D42Zct7mG',
]);
const INIT_ACTION_PATTERN = /\b(initialize|initialize2|create|open)\b/i;
const INIT_OBJECT_PATTERN = /\b(pool|pair|whirlpool|amm|lb)\b/i;
const EXPLICIT_INIT_PATTERNS = [
  /instruction:\s*initialize/i,
  /instruction:\s*create/i,
  /initialize.*whirlpool/i,
  /\blb\s+pair\b/i,
];

const SUPPORTED_POOL_DISCOVERY_PROGRAMS = [
  RAYDIUM_V4_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  PUMP_SWAP_PROGRAM,
  METEORA_DLMM_PROGRAM,
  METEORA_DAMM_V1_PROGRAM,
  METEORA_DAMM_V2_PROGRAM,
] as const;

const PROGRAM_TO_DEX_ID = new Map<string, string>([
  [RAYDIUM_V4_PROGRAM, 'raydium'],
  [RAYDIUM_CLMM_PROGRAM, 'raydium'],
  [RAYDIUM_CPMM_PROGRAM, 'raydium'],
  [ORCA_WHIRLPOOL_PROGRAM, 'orca'],
  [PUMP_SWAP_PROGRAM, 'pumpswap'],
  [METEORA_DLMM_PROGRAM, 'meteora'],
  [METEORA_DAMM_V1_PROGRAM, 'meteora'],
  [METEORA_DAMM_V2_PROGRAM, 'meteora'],
]);

interface PoolDiscoveryConfig {
  rpcHttpUrl: string;
  rpcWsUrl: string;
  programIds?: string[];
  concurrency?: number;
  requestSpacingMs?: number;
  queueLimit?: number;
  rateLimitCooldownMs?: number;
  transientFailureCooldownMs?: number;
}

interface AccountKeyMeta {
  pubkey: string;
  signer: boolean;
  writable: boolean;
}

interface QueuedPoolDiscoveryLog {
  programId: string;
  logs: Logs;
  slot: number;
  seenKey: string;
}

export class HeliusPoolDiscovery extends EventEmitter {
  private readonly connection: Connection;
  private readonly programIds: string[];
  private readonly concurrency: number;
  private readonly requestSpacingMs: number;
  private readonly queueLimit: number;
  private readonly rateLimitCooldownMs: number;
  private readonly transientFailureCooldownMs: number;
  private readonly subscriptions = new Map<string, number>();
  private readonly seenSignatures = new Set<string>();
  private static readonly MAX_SEEN_SIGNATURES = 10_000;
  private readonly pendingSignatures = new Set<string>();
  private readonly queue: QueuedPoolDiscoveryLog[] = [];
  private inFlight = 0;
  private cooldownUntil = 0;
  private lastRequestAt = 0;
  private queueOverflowWarnedAt = 0;
  private overflowDroppedCount = 0;
  private lastCapacityEmitAt = 0;
  private permitChain: Promise<void> = Promise.resolve();

  constructor(config: PoolDiscoveryConfig) {
    super();
    this.connection = new Connection(config.rpcHttpUrl, {
      commitment: 'confirmed',
      wsEndpoint: config.rpcWsUrl,
    });
    this.programIds = config.programIds ?? [...SUPPORTED_POOL_DISCOVERY_PROGRAMS];
    this.concurrency = Math.max(1, config.concurrency ?? 4);
    this.requestSpacingMs = config.requestSpacingMs ?? 500;
    this.queueLimit = config.queueLimit ?? 200;
    this.rateLimitCooldownMs = config.rateLimitCooldownMs ?? 30_000;
    this.transientFailureCooldownMs = config.transientFailureCooldownMs ?? 5_000;
  }

  async start(): Promise<void> {
    for (const programId of this.programIds) {
      if (this.subscriptions.has(programId)) continue;
      const subscriptionId = this.connection.onLogs(
        new PublicKey(programId),
        (logs, ctx) => {
          this.enqueueProgramLogs(programId, logs, ctx.slot);
        },
        'confirmed'
      );
      this.subscriptions.set(programId, subscriptionId);
    }
  }

  async stop(): Promise<void> {
    for (const [programId, subscriptionId] of this.subscriptions.entries()) {
      await this.connection.removeOnLogsListener(subscriptionId);
      this.subscriptions.delete(programId);
    }
    this.queue.length = 0;
    this.pendingSignatures.clear();
    this.inFlight = 0;
  }

  private enqueueProgramLogs(programId: string, logs: Logs, slot: number): void {
    if (logs.err || !looksLikePoolInitLogs(logs.logs)) return;
    const seenKey = `${programId}:${logs.signature}`;
    if (this.seenSignatures.has(seenKey) || this.pendingSignatures.has(seenKey)) return;
    if (this.queue.length >= this.queueLimit) {
      const dropped = this.queue.shift();
      if (dropped) {
        this.pendingSignatures.delete(dropped.seenKey);
        this.overflowDroppedCount += 1;
      }
      const now = Date.now();
      // capacity emit과 warn 모두 60초 throttle — write storm 방지
      if (now - this.lastCapacityEmitAt >= 60_000) {
        this.lastCapacityEmitAt = now;
        this.emit('capacity', {
          source: 'helius_pool_discovery',
          reason: 'queue_overflow',
          detail: `limit=${this.queueLimit} inFlight=${this.inFlight} queued=${this.queue.length} dropped=${this.overflowDroppedCount}`,
        });
      }
      if (now - this.queueOverflowWarnedAt >= 60_000) {
        this.queueOverflowWarnedAt = now;
        const droppedCount = this.overflowDroppedCount;
        this.overflowDroppedCount = 0;
        log.warn(
          `Pool discovery queue overflow: limit=${this.queueLimit} inFlight=${this.inFlight} ` +
          `queued=${this.queue.length} dropped=${droppedCount}. Oldest discovery logs were evicted to keep recent ones.`
        );
      }
    }

    this.pendingSignatures.add(seenKey);
    this.queue.push({ programId, logs, slot, seenKey });
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) return;

      this.inFlight += 1;
      void this.processQueueEntry(entry).finally(() => {
        this.inFlight -= 1;
        if (this.queue.length > 0) {
          void this.processQueue();
        }
      });
    }
  }

  private async processQueueEntry(entry: QueuedPoolDiscoveryLog): Promise<void> {
    try {
      await this.acquirePermit();
      await this.handleProgramLogs(entry.programId, entry.logs, entry.slot);
    } finally {
      this.pendingSignatures.delete(entry.seenKey);
      this.seenSignatures.add(entry.seenKey);
      if (this.seenSignatures.size > HeliusPoolDiscovery.MAX_SEEN_SIGNATURES) {
        const toDelete = this.seenSignatures.size - HeliusPoolDiscovery.MAX_SEEN_SIGNATURES;
        const iterator = this.seenSignatures.values();
        for (let i = 0; i < toDelete; i++) {
          this.seenSignatures.delete(iterator.next().value!);
        }
      }
    }
  }

  private async acquirePermit(): Promise<void> {
    const previous = this.permitChain;
    let release!: () => void;
    this.permitChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const remainingCooldownMs = this.cooldownUntil - Date.now();
      if (remainingCooldownMs > 0) {
        await sleep(remainingCooldownMs);
      }

      const spacingMs = this.lastRequestAt + this.requestSpacingMs - Date.now();
      if (spacingMs > 0) {
        await sleep(spacingMs);
      }
      this.lastRequestAt = Date.now();
    } finally {
      release();
    }
  }

  private async handleProgramLogs(programId: string, logs: Logs, slot: number): Promise<void> {
    try {
      const tx = await this.connection.getParsedTransaction(logs.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) return;

      const ownerMap = await this.resolveWritableOwners(tx);
      const candidate = extractObservedPoolCandidate(tx, programId, ownerMap);
      if (!candidate) return;

      this.emit('poolDiscovered', candidate);
    } catch (error) {
      const rateLimited = isRateLimitError(error);
      const transientFailure = !rateLimited && isTransientPoolDiscoveryError(error);
      const cooldownMs = rateLimited
        ? this.rateLimitCooldownMs
        : transientFailure
          ? this.transientFailureCooldownMs
          : 0;

      if (cooldownMs > 0) {
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + cooldownMs);
      }

      const cooldownSuffix = cooldownMs > 0 ? ` (cooldown ${cooldownMs}ms)` : '';
      log.warn(`Pool discovery parse failed for ${programId} ${logs.signature}: ${formatError(error)}${cooldownSuffix}`);
      this.emit('error', {
        programId,
        signature: logs.signature,
        slot,
        error,
        rateLimited,
        cooldownMs,
      });
    }
  }

  private async resolveWritableOwners(tx: ParsedTransactionWithMeta): Promise<Map<string, string | null>> {
    const accountKeys = extractAccountKeys(tx).filter((account) => account.writable);
    const pubkeys = accountKeys.map((account) => account.pubkey).filter(Boolean);
    const infos = await this.connection.getMultipleAccountsInfo(
      pubkeys.map((pubkey) => new PublicKey(pubkey)),
      'confirmed'
    );
    return new Map(pubkeys.map((pubkey, index) => [pubkey, infos[index]?.owner?.toBase58() ?? null]));
  }
}

export function looksLikePoolInitLogs(logs: string[]): boolean {
  const joined = logs.join('\n');
  return EXPLICIT_INIT_PATTERNS.some((pattern) => pattern.test(joined))
    || (INIT_ACTION_PATTERN.test(joined) && INIT_OBJECT_PATTERN.test(joined));
}

export function extractObservedPoolCandidate(
  tx: ParsedTransactionWithMeta,
  programId: string,
  ownerByAccount: Map<string, string | null>
): ObservedPairCandidate | null {
  const mints = [
    ...new Set([
      ...(tx.meta?.postTokenBalances ?? []).map((balance) => balance.mint).filter(Boolean),
      ...(tx.meta?.preTokenBalances ?? []).map((balance) => balance.mint).filter(Boolean),
    ]),
  ];
  const mintPair = selectMintPair(mints);
  if (!mintPair) return null;

  const poolAddress = extractAccountKeys(tx)
    .filter((account) => account.writable && !account.signer)
    .map((account) => account.pubkey)
    .find((pubkey) =>
      pubkey !== mintPair.baseTokenAddress
      && pubkey !== mintPair.quoteTokenAddress
      && ownerByAccount.get(pubkey) === programId
      && !TOKEN_PROGRAMS.has(pubkey)
    );
  if (!poolAddress) return null;

  return {
    pairAddress: poolAddress,
    dexId: PROGRAM_TO_DEX_ID.get(programId) ?? 'unknown',
    baseTokenAddress: mintPair.baseTokenAddress,
    quoteTokenAddress: mintPair.quoteTokenAddress,
    quoteTokenSymbol: mintPair.quoteTokenAddress === SOL_MINT ? 'SOL' : undefined,
    pairCreatedAt: tx.blockTime ? tx.blockTime * 1000 : undefined,
  };
}

function selectMintPair(mints: string[]): Pick<ObservedPairCandidate, 'baseTokenAddress' | 'quoteTokenAddress'> | null {
  if (mints.length < 2) return null;
  if (mints.includes(SOL_MINT)) {
    const baseTokenAddress = mints.find((mint) => mint !== SOL_MINT);
    if (!baseTokenAddress) return null;
    return {
      baseTokenAddress,
      quoteTokenAddress: SOL_MINT,
    };
  }
  const sorted = [...mints].sort((left, right) => left.localeCompare(right));
  return {
    baseTokenAddress: sorted[0],
    quoteTokenAddress: sorted[1],
  };
}

function extractAccountKeys(tx: ParsedTransactionWithMeta): AccountKeyMeta[] {
  return tx.transaction.message.accountKeys.map((account: any) => {
    if (typeof account === 'string') {
      return { pubkey: account, signer: false, writable: false };
    }
    if ('pubkey' in account) {
      const pubkey = typeof account.pubkey === 'string'
        ? account.pubkey
        : account.pubkey.toBase58();
      return {
        pubkey,
        signer: 'signer' in account ? Boolean(account.signer) : false,
        writable: 'writable' in account ? Boolean(account.writable) : false,
      };
    }
    return { pubkey: String(account), signer: false, writable: false };
  });
}

function isRateLimitError(error: unknown): boolean {
  const message = formatError(error).toLowerCase();
  return message.includes('429')
    || message.includes('too many requests')
    || message.includes('rate limited');
}

function isTransientPoolDiscoveryError(error: unknown): boolean {
  const message = formatError(error).toLowerCase();
  return message.includes('fetch failed')
    || message.includes('timeout')
    || message.includes('connection terminated')
    || message.includes('socket hang up')
    || message.includes('econnreset');
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.toString();
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export { SUPPORTED_POOL_DISCOVERY_PROGRAMS };
