import { ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { recordHeliusRpcCredit } from '../observability/heliusRpcAttribution';
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
  allowSingleFetchFallback?: boolean;
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
  recordHeliusRpcCredit({
    purpose: 'pool_prewarm',
    method: 'getSignaturesForAddress',
    feature: 'recent_swap_backfill',
    traceId: `recent-sigs-${pool.slice(0, 8)}`,
  });
  const signatures = await connection.getSignaturesForAddress(poolKey, {
    limit: options.maxSignatures ?? DEFAULT_MAX_SIGNATURES,
  });

  const recent = signatures
    .filter((entry) => entry.blockTime == null || entry.blockTime >= sinceSec)
    .reverse();
  if (recent.length === 0) return [];

  const transactions = await loadParsedTransactions(
    connection,
    recent.map((entry) => entry.signature),
    options.allowSingleFetchFallback ?? true
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
  signatures: string[],
  allowSingleFetchFallback: boolean
): Promise<Array<ParsedTransactionWithMeta | null>> {
  if (signatures.length === 0) return [];

  try {
    recordHeliusRpcCredit({
      purpose: 'pool_prewarm',
      method: 'getParsedTransaction',
      requestCount: signatures.length,
      feature: 'recent_swap_backfill_batch',
      traceId: `recent-batch-${signatures.length}`,
    });
    const txs = await connection.getParsedTransactions(signatures, PARSED_TX_OPTIONS);
    return txs;
  } catch (error) {
    if (!allowSingleFetchFallback && isBatchUnsupportedError(error)) {
      return signatures.map(() => null);
    }
    if (!allowSingleFetchFallback) {
      throw error;
    }
    return Promise.all(
      signatures.map(async (signature) => {
        recordHeliusRpcCredit({
          purpose: 'pool_prewarm',
          method: 'getParsedTransaction',
          feature: 'recent_swap_backfill_single',
          txSignature: signature,
          traceId: `recent-single-${signature.slice(0, 8)}`,
        });
        const tx = await connection.getParsedTransaction(signature, PARSED_TX_OPTIONS);
        return tx;
      })
    );
  }
}

function isBatchUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Batch requests are only available for paid plans')
    || message.includes('code":-32403');
}
