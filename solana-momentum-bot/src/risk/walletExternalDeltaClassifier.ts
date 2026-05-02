import { appendFile, mkdir, readFile } from 'fs/promises';
import path from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('WalletExternalDelta');

export type WalletExternalDeltaKind =
  | 'rent_reclaim'
  | 'manual_transfer_in'
  | 'manual_transfer_out'
  | 'fee_only'
  | 'unlogged_bot_tx'
  | 'unknown_external';

export interface WalletExternalDeltaTx {
  signature: string;
  blockTime: number | null;
  deltaSol: number;
  feeSol: number;
  kind: WalletExternalDeltaKind;
  reason: string;
}

export interface WalletExternalDeltaSummary {
  schemaVersion: 'wallet-external-delta/v1';
  walletName: string;
  walletAddress: string;
  windowStartMs: number;
  windowEndMs: number;
  rawDriftSol: number;
  knownBotTxCount: number;
  externalTxCount: number;
  rentReclaimSol: number;
  manualTransferInSol: number;
  manualTransferOutSol: number;
  feeOnlySol: number;
  unloggedBotTxSol: number;
  unknownExternalSol: number;
  safeAdjustmentSol: number;
  txs: WalletExternalDeltaTx[];
}

export interface WalletExternalDeltaClassifyInput {
  sinceMs: number;
  untilMs: number;
  rawDriftSol: number;
}

export interface WalletExternalDeltaClassifier {
  classify(input: WalletExternalDeltaClassifyInput): Promise<WalletExternalDeltaSummary | null>;
}

interface CreateClassifierOptions {
  connection: Connection;
  walletName: string;
  walletPublicKey: PublicKey;
  realtimeDataDir: string;
  maxSignatures?: number;
  rpcTimeoutMs?: number;
}

interface TokenBalanceLike {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: {
    uiAmount?: number | null;
    uiAmountString?: string;
    amount?: string;
    decimals?: number;
  };
}

interface ParsedInstructionLike {
  program?: string;
  parsed?: unknown;
}

interface ParsedTxLike {
  blockTime?: number | null;
  meta: {
    preBalances: number[];
    postBalances: number[];
    fee?: number;
    preTokenBalances?: TokenBalanceLike[];
    postTokenBalances?: TokenBalanceLike[];
    innerInstructions?: Array<{ instructions: ParsedInstructionLike[] }>;
  } | null;
  transaction: {
    message: {
      accountKeys: Array<{ pubkey: { toBase58(): string } | string }>;
      instructions: ParsedInstructionLike[];
    };
  };
}

const LEDGER_FILE = 'wallet-external-deltas.jsonl';
const SIGNATURE_PAGE_LIMIT = 100;
const DEFAULT_MAX_SIGNATURES = 60;
const DEFAULT_RPC_TIMEOUT_MS = 2500;
const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_CHANGE_EPSILON = 1e-9;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pubkeyToString(value: { toBase58(): string } | string): string {
  return typeof value === 'string' ? value : value.toBase58();
}

function instructionList(tx: ParsedTxLike): ParsedInstructionLike[] {
  const inner = tx.meta?.innerInstructions?.flatMap((item) => item.instructions) ?? [];
  return [...tx.transaction.message.instructions, ...inner];
}

function parsedObject(ix: ParsedInstructionLike): { type?: unknown; info?: unknown } | null {
  if (!ix.parsed || typeof ix.parsed !== 'object') return null;
  return ix.parsed as { type?: unknown; info?: unknown };
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function isCloseAccountForWallet(ix: ParsedInstructionLike, walletAddress: string): boolean {
  const parsed = parsedObject(ix);
  if (parsed?.type !== 'closeAccount') return false;
  const info = parsed.info;
  if (!info || typeof info !== 'object') return false;
  const record = info as Record<string, unknown>;
  return [
    stringField(record, 'destination'),
    stringField(record, 'owner'),
    stringField(record, 'multisigOwner'),
  ].some((value) => value === walletAddress);
}

function transferDirection(ix: ParsedInstructionLike, walletAddress: string): 'in' | 'out' | null {
  const parsed = parsedObject(ix);
  if (ix.program !== 'system' || parsed?.type !== 'transfer') return null;
  const info = parsed.info;
  if (!info || typeof info !== 'object') return null;
  const record = info as Record<string, unknown>;
  const source = stringField(record, 'source');
  const destination = stringField(record, 'destination');
  if (destination === walletAddress && source !== walletAddress) return 'in';
  if (source === walletAddress && destination !== walletAddress) return 'out';
  return null;
}

function tokenAmount(balance: TokenBalanceLike | undefined): number {
  if (!balance?.uiTokenAmount) return 0;
  const explicit = balance.uiTokenAmount.uiAmount;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  const fromString = Number(balance.uiTokenAmount.uiAmountString);
  return Number.isFinite(fromString) ? fromString : 0;
}

function hasWalletTokenBalanceChange(tx: ParsedTxLike, walletAddress: string): boolean {
  const byKey = new Map<string, { pre: number; post: number }>();
  const add = (side: 'pre' | 'post', balances: TokenBalanceLike[] | undefined) => {
    for (const balance of balances ?? []) {
      if (balance.owner !== walletAddress) continue;
      const key = `${balance.accountIndex ?? -1}:${balance.mint ?? ''}`;
      const item = byKey.get(key) ?? { pre: 0, post: 0 };
      item[side] += tokenAmount(balance);
      byKey.set(key, item);
    }
  };
  add('pre', tx.meta?.preTokenBalances);
  add('post', tx.meta?.postTokenBalances);
  for (const item of byKey.values()) {
    if (Math.abs(item.post - item.pre) > TOKEN_CHANGE_EPSILON) return true;
  }
  return false;
}

function classifyTx(tx: ParsedTxLike, signature: string, walletAddress: string): WalletExternalDeltaTx | null {
  if (!tx.meta) return null;
  const accountKeys = tx.transaction.message.accountKeys;
  const walletIndex = accountKeys.findIndex((key) => pubkeyToString(key.pubkey) === walletAddress);
  if (walletIndex < 0) return null;
  const preLamports = tx.meta.preBalances[walletIndex] ?? 0;
  const postLamports = tx.meta.postBalances[walletIndex] ?? 0;
  const deltaSol = (postLamports - preLamports) / LAMPORTS_PER_SOL;
  const feeSol = (tx.meta.fee ?? 0) / LAMPORTS_PER_SOL;
  const instructions = instructionList(tx);
  const hasCloseAccount = instructions.some((ix) => isCloseAccountForWallet(ix, walletAddress));
  const systemDirections = instructions
    .map((ix) => transferDirection(ix, walletAddress))
    .filter((item): item is 'in' | 'out' => item != null);
  const tokenBalanceChanged = hasWalletTokenBalanceChange(tx, walletAddress);

  let kind: WalletExternalDeltaKind = 'unknown_external';
  let reason = 'external wallet delta did not match known bot tx or rent/transfer pattern';
  if (hasCloseAccount && deltaSol > 0 && !tokenBalanceChanged) {
    kind = 'rent_reclaim';
    reason = 'SPL closeAccount credited SOL to wallet';
  } else if (Math.abs(deltaSol + feeSol) < 1e-9) {
    kind = 'fee_only';
    reason = 'wallet delta equals transaction fee';
  } else if (tokenBalanceChanged && Math.abs(deltaSol) > 0.003) {
    kind = 'unlogged_bot_tx';
    reason = 'wallet token balance changed but tx is not in executed ledger';
  } else if (systemDirections.includes('in') && deltaSol > 0) {
    kind = 'manual_transfer_in';
    reason = 'SystemProgram transfer into wallet';
  } else if (systemDirections.includes('out') && deltaSol < 0) {
    kind = 'manual_transfer_out';
    reason = 'SystemProgram transfer out of wallet';
  }

  return {
    signature,
    blockTime: tx.blockTime ?? null,
    deltaSol,
    feeSol,
    kind,
    reason,
  };
}

async function readKnownBotSignatures(realtimeDataDir: string): Promise<Set<string>> {
  const known = new Set<string>();
  for (const file of ['executed-buys.jsonl', 'executed-sells.jsonl']) {
    let text = '';
    try {
      text = await readFile(path.join(realtimeDataDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        for (const key of ['txSignature', 'entryTxSignature', 'txEntry', 'txExit']) {
          const value = row[key];
          if (typeof value === 'string' && value.length > 20) known.add(value);
        }
      } catch {
        // malformed ledger row — ignore
      }
    }
  }
  return known;
}

async function fetchSignaturesInWindow(
  connection: Connection,
  walletPublicKey: PublicKey,
  sinceMs: number,
  untilMs: number,
  maxSignatures: number,
  rpcTimeoutMs: number,
): Promise<string[]> {
  const signatures: string[] = [];
  let before: string | undefined;
  let reachedStart = false;
  while (signatures.length < maxSignatures && !reachedStart) {
    const page = await withTimeout(
      connection.getSignaturesForAddress(walletPublicKey, {
        limit: Math.min(SIGNATURE_PAGE_LIMIT, maxSignatures - signatures.length),
        before,
      }),
      rpcTimeoutMs,
      'getSignaturesForAddress',
    );
    if (page.length === 0) break;
    for (const item of page) {
      const blockMs = item.blockTime == null ? null : item.blockTime * 1000;
      if (blockMs != null && blockMs > untilMs + 1000) continue;
      if (blockMs != null && blockMs < sinceMs - 1000) {
        reachedStart = true;
        break;
      }
      signatures.push(item.signature);
    }
    before = page[page.length - 1]?.signature;
    if (page.length < SIGNATURE_PAGE_LIMIT) break;
  }
  return signatures;
}

async function appendSummary(realtimeDataDir: string, summary: WalletExternalDeltaSummary): Promise<void> {
  try {
    await mkdir(realtimeDataDir, { recursive: true });
    await appendFile(path.join(realtimeDataDir, LEDGER_FILE), `${JSON.stringify(summary)}\n`, 'utf8');
  } catch (err) {
    log.warn(`[WALLET_EXTERNAL_DELTA] append failed: ${String(err)}`);
  }
}

function buildSummary(input: {
  walletName: string;
  walletAddress: string;
  windowStartMs: number;
  windowEndMs: number;
  rawDriftSol: number;
  knownBotTxCount: number;
  txs: WalletExternalDeltaTx[];
}): WalletExternalDeltaSummary {
  const sumByKind = (kind: WalletExternalDeltaKind) =>
    input.txs.filter((tx) => tx.kind === kind).reduce((sum, tx) => sum + tx.deltaSol, 0);
  const rentReclaimSol = sumByKind('rent_reclaim');
  const manualTransferInSol = sumByKind('manual_transfer_in');
  const manualTransferOutSol = sumByKind('manual_transfer_out');
  const feeOnlySol = sumByKind('fee_only');
  const unloggedBotTxSol = sumByKind('unlogged_bot_tx');
  const unknownExternalSol = sumByKind('unknown_external');
  return {
    schemaVersion: 'wallet-external-delta/v1',
    walletName: input.walletName,
    walletAddress: input.walletAddress,
    windowStartMs: input.windowStartMs,
    windowEndMs: input.windowEndMs,
    rawDriftSol: input.rawDriftSol,
    knownBotTxCount: input.knownBotTxCount,
    externalTxCount: input.txs.length,
    rentReclaimSol,
    manualTransferInSol,
    manualTransferOutSol,
    feeOnlySol,
    unloggedBotTxSol,
    unknownExternalSol,
    safeAdjustmentSol: Math.max(0, rentReclaimSol),
    txs: input.txs,
  };
}

export function createWalletExternalDeltaClassifier(
  options: CreateClassifierOptions,
): WalletExternalDeltaClassifier {
  const walletAddress = options.walletPublicKey.toBase58();
  const maxSignatures = options.maxSignatures ?? DEFAULT_MAX_SIGNATURES;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  return {
    async classify(input: WalletExternalDeltaClassifyInput): Promise<WalletExternalDeltaSummary | null> {
      const knownBotSignatures = await readKnownBotSignatures(options.realtimeDataDir);
      const signatures = await fetchSignaturesInWindow(
        options.connection,
        options.walletPublicKey,
        input.sinceMs,
        input.untilMs,
        maxSignatures,
        rpcTimeoutMs,
      );
      const externalTxs: WalletExternalDeltaTx[] = [];
      let knownBotTxCount = 0;
      for (const signature of signatures) {
        if (knownBotSignatures.has(signature)) {
          knownBotTxCount++;
          continue;
        }
        const parsed = await withTimeout(
          options.connection.getParsedTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          }),
          rpcTimeoutMs,
          `getParsedTransaction:${signature.slice(0, 8)}`,
        ).catch((err) => {
          log.warn(`[WALLET_EXTERNAL_DELTA] tx parse skipped sig=${signature.slice(0, 12)} err=${String(err)}`);
          return null;
        });
        if (!parsed) continue;
        const classified = classifyTx(parsed as unknown as ParsedTxLike, signature, walletAddress);
        if (classified) externalTxs.push(classified);
      }
      const summary = buildSummary({
        walletName: options.walletName,
        walletAddress,
        windowStartMs: input.sinceMs,
        windowEndMs: input.untilMs,
        rawDriftSol: input.rawDriftSol,
        knownBotTxCount,
        txs: externalTxs,
      });
      await appendSummary(options.realtimeDataDir, summary);
      return summary;
    },
  };
}

export const walletExternalDeltaInternalsForTests = {
  classifyTx,
  buildSummary,
};
