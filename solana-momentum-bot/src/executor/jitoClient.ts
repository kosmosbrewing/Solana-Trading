import axios, { AxiosInstance } from 'axios';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('JitoClient');

/**
 * Jito tip accounts — one is selected randomly per bundle.
 * https://jito-labs.gitbook.io/mev/
 */
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bPg4W3Cn1LpAt34ETYDrrJ',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSLkCenZCY1ev8HzJYV',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

/** Minimum tip to participate in Jito bundles */
const MIN_TIP_LAMPORTS = 1_000;

export interface JitoConfig {
  /** Jito block engine URL */
  jitoRpcUrl: string;
  /** Tip amount in SOL (added to last TX in bundle) */
  tipSol: number;
  /** Solana RPC for lookups */
  solanaRpcUrl: string;
  /** Enable DontFront MEV protection */
  enableDontFront: boolean;
  /** Timeout for bundle submission (ms) */
  timeoutMs: number;
}

const DEFAULT_CONFIG: JitoConfig = {
  jitoRpcUrl: 'https://mainnet.block-engine.jito.wtf',
  tipSol: 0.001,
  solanaRpcUrl: '',
  enableDontFront: true,
  timeoutMs: 30_000,
};

/**
 * DontFront account — adding this as read-only in an instruction
 * signals Jito searchers not to sandwich the transaction.
 */
const DONT_FRONT_ACCOUNT = new PublicKey('JitoDontFronta1111111111111111111111111111');

export interface BundleResult {
  bundleId: string;
  txSignatures: string[];
}

/**
 * Jito Bundle Client — MEV protection for on-chain transactions.
 *
 * Features:
 *   - Bundle submission (up to 5 TXs, all-or-nothing atomic execution)
 *   - Tip management (random tip account selection)
 *   - DontFront MEV protection
 *   - Bundle status polling
 *
 * Phase 3: Required for Strategy D (New LP Sniper).
 * Optional for Strategy A/C (reduces MEV risk on swaps).
 */
export class JitoClient {
  private config: JitoConfig;
  private client: AxiosInstance;
  private connection: Connection;

  constructor(config: Partial<JitoConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.client = axios.create({
      baseURL: this.config.jitoRpcUrl,
      timeout: this.config.timeoutMs,
    });
    this.connection = new Connection(this.config.solanaRpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
  }

  /**
   * Submit a bundle of signed transactions to Jito.
   * The tip transaction is automatically appended.
   *
   * @param signedTxs Array of signed VersionedTransaction (max 4, tip is 5th)
   * @param wallet Keypair for signing the tip transaction
   */
  async submitBundle(
    signedTxs: VersionedTransaction[],
    wallet: Keypair
  ): Promise<BundleResult> {
    if (signedTxs.length === 0) {
      throw new Error('Bundle must contain at least one transaction');
    }
    if (signedTxs.length > 4) {
      throw new Error('Bundle can contain max 4 user transactions (+ 1 tip)');
    }

    // Create tip transaction
    const tipTx = await this.createTipTransaction(wallet);

    // Combine user TXs + tip TX
    const allTxs = [...signedTxs, tipTx];

    // Serialize all transactions to base58
    const encodedTxs = allTxs.map(tx =>
      bs58.encode(tx.serialize())
    );

    // Submit bundle
    const response = await this.client.post('/api/v1/bundles', {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [encodedTxs],
    });

    if (response.data.error) {
      throw new Error(`Jito bundle error: ${JSON.stringify(response.data.error)}`);
    }

    const bundleId = response.data.result;
    const txSignatures = allTxs.map(tx =>
      bs58.encode(tx.signatures[0])
    );

    log.info(`Bundle submitted: ${bundleId} (${allTxs.length} txs)`);

    return { bundleId, txSignatures };
  }

  /**
   * Submit a single transaction as a Jito bundle (TX + tip).
   * Simplest integration path for existing Jupiter swap flow.
   */
  async submitSingleTx(
    signedTx: VersionedTransaction,
    wallet: Keypair
  ): Promise<BundleResult> {
    return this.submitBundle([signedTx], wallet);
  }

  /**
   * Check bundle status.
   */
  async getBundleStatus(bundleId: string): Promise<BundleStatus> {
    const response = await this.client.post('/api/v1/bundles', {
      jsonrpc: '2.0',
      id: 1,
      method: 'getBundleStatuses',
      params: [[bundleId]],
    });

    if (response.data.error) {
      throw new Error(`Jito status error: ${JSON.stringify(response.data.error)}`);
    }

    const statuses = response.data.result?.value;
    if (!statuses || statuses.length === 0) {
      return { status: 'pending', slot: 0 };
    }

    const s = statuses[0];
    return {
      status: s.confirmation_status ?? 'pending',
      slot: s.slot ?? 0,
      err: s.err ?? undefined,
    };
  }

  /**
   * Wait for bundle confirmation with polling.
   */
  async waitForConfirmation(
    bundleId: string,
    maxWaitMs = 30_000,
    pollIntervalMs = 2_000
  ): Promise<BundleStatus> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const status = await this.getBundleStatus(bundleId);
      if (status.status === 'confirmed' || status.status === 'finalized') {
        log.info(`Bundle ${bundleId} confirmed (slot: ${status.slot})`);
        return status;
      }
      if (status.err) {
        throw new Error(`Bundle failed: ${JSON.stringify(status.err)}`);
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    throw new Error(`Bundle ${bundleId} confirmation timed out after ${maxWaitMs}ms`);
  }

  /**
   * Get a random Jito tip account.
   */
  private getRandomTipAccount(): PublicKey {
    const idx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return new PublicKey(JITO_TIP_ACCOUNTS[idx]);
  }

  /**
   * Create a tip transaction (SOL transfer to random Jito tip account).
   */
  private async createTipTransaction(wallet: Keypair): Promise<VersionedTransaction> {
    const tipLamports = Math.max(
      MIN_TIP_LAMPORTS,
      Math.round(this.config.tipSol * 1e9)
    );

    const tipAccount = this.getRandomTipAccount();

    const { blockhash } = await this.connection.getLatestBlockhash('finalized');

    const instructions = [
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: tipAccount,
        lamports: tipLamports,
      }),
    ];

    // DontFront MEV protection: add read-only account reference
    if (this.config.enableDontFront) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: DONT_FRONT_ACCOUNT,
          lamports: 0,
        })
      );
    }

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([wallet]);

    return tx;
  }
}

export interface BundleStatus {
  status: 'pending' | 'confirmed' | 'finalized' | 'failed';
  slot: number;
  err?: unknown;
}
