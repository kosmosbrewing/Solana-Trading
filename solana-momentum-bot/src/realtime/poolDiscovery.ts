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
}

interface AccountKeyMeta {
  pubkey: string;
  signer: boolean;
  writable: boolean;
}

export class HeliusPoolDiscovery extends EventEmitter {
  private readonly connection: Connection;
  private readonly programIds: string[];
  private readonly subscriptions = new Map<string, number>();
  private readonly seenSignatures = new Set<string>();

  constructor(config: PoolDiscoveryConfig) {
    super();
    this.connection = new Connection(config.rpcHttpUrl, {
      commitment: 'confirmed',
      wsEndpoint: config.rpcWsUrl,
    });
    this.programIds = config.programIds ?? [...SUPPORTED_POOL_DISCOVERY_PROGRAMS];
  }

  async start(): Promise<void> {
    for (const programId of this.programIds) {
      if (this.subscriptions.has(programId)) continue;
      const subscriptionId = this.connection.onLogs(
        new PublicKey(programId),
        (logs, ctx) => {
          void this.handleProgramLogs(programId, logs, ctx.slot);
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
  }

  private async handleProgramLogs(programId: string, logs: Logs, slot: number): Promise<void> {
    if (logs.err || !looksLikePoolInitLogs(logs.logs)) return;
    const seenKey = `${programId}:${logs.signature}`;
    if (this.seenSignatures.has(seenKey)) return;
    this.seenSignatures.add(seenKey);

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
      log.warn(`Pool discovery parse failed for ${programId} ${logs.signature}: ${error}`);
      this.emit('error', { programId, signature: logs.signature, slot, error });
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

export { SUPPORTED_POOL_DISCOVERY_PROGRAMS };
