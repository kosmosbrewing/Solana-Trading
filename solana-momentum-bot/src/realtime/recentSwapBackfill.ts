import { ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { parseSwapFromTransaction } from './swapParser';
import { ParsedSwap, RealtimePoolMetadata } from './types';

interface SignatureInfoLike {
  signature: string;
  slot: number;
  blockTime?: number | null;
}

interface RecentSwapBackfillConnection {
  getSignaturesForAddress(
    pubkey: PublicKey,
    options?: { limit?: number }
  ): Promise<SignatureInfoLike[]>;
  getParsedTransactions(
    signatures: string[],
    options: { commitment: 'confirmed'; maxSupportedTransactionVersion: 0 }
  ): Promise<Array<ParsedTransactionWithMeta | null>>;
  getParsedTransaction(
    signature: string,
    options: { commitment: 'confirmed'; maxSupportedTransactionVersion: 0 }
  ): Promise<ParsedTransactionWithMeta | null>;
}

export interface RecentSwapBackfillOptions {
  lookbackSec: number;
  maxSignatures?: number;
  nowSec?: number;
}

const DEFAULT_MAX_SIGNATURES = 80;
const PARSED_TX_OPTIONS = {
  commitment: 'confirmed' as const,
  maxSupportedTransactionVersion: 0 as const,
};

export async function fetchRecentSwapsForPool(
  connection: RecentSwapBackfillConnection,
  pool: string,
  poolMetadata: RealtimePoolMetadata | undefined,
  options: RecentSwapBackfillOptions
): Promise<ParsedSwap[]> {
  if (!poolMetadata) return [];

  let poolKey: PublicKey;
  try {
    poolKey = new PublicKey(pool);
  } catch {
    return [];
  }

  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - options.lookbackSec;
  const signatures = await connection.getSignaturesForAddress(poolKey, {
    limit: options.maxSignatures ?? DEFAULT_MAX_SIGNATURES,
  });

  const recent = signatures
    .filter((entry) => entry.blockTime == null || entry.blockTime >= sinceSec)
    .reverse();
  if (recent.length === 0) return [];

  const transactions = await loadParsedTransactions(
    connection,
    recent.map((entry) => entry.signature)
  );

  return recent
    .map((entry, index) => {
      const tx = transactions[index];
      if (!tx) return null;
      return parseSwapFromTransaction(tx, {
        poolAddress: pool,
        signature: entry.signature,
        slot: entry.slot,
        poolMetadata,
      });
    })
    .filter((swap): swap is ParsedSwap => swap !== null)
    .sort((left, right) => left.timestamp - right.timestamp || left.slot - right.slot);
}

async function loadParsedTransactions(
  connection: RecentSwapBackfillConnection,
  signatures: string[]
): Promise<Array<ParsedTransactionWithMeta | null>> {
  if (signatures.length === 0) return [];

  try {
    return await connection.getParsedTransactions(signatures, PARSED_TX_OPTIONS);
  } catch {
    return Promise.all(
      signatures.map((signature) => connection.getParsedTransaction(signature, PARSED_TX_OPTIONS))
    );
  }
}
