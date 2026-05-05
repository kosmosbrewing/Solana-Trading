/**
 * Helius getTransfersByAddress client (2026-05-05).
 *
 * 목적: KOL/dev wallet 행동분포 구축의 1차 저비용 인덱서.
 * 정책:
 *   - live trading path 에 연결하지 않는다.
 *   - 실패는 throw 하지 않고 undefined 반환.
 *   - 호출 시 credit ledger 에 getTransfersByAddress=10c estimate 를 남긴다.
 *
 * Docs:
 *   https://www.helius.dev/docs/api-reference/rpc/http/gettransfersbyaddress
 */

import {
  appendHeliusCreditUsage,
  buildHeliusCreditUsage,
} from '../observability/heliusCreditLedger';
import type { HeliusCreditPurpose } from '../observability/heliusCreditCost';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('HeliusTransferClient');

export type HeliusTransferDirection = 'in' | 'out' | 'any';
export type HeliusTransferSolMode = 'merged' | 'separate';
export type HeliusTransferCommitment = 'finalized' | 'confirmed';
export type HeliusTransferSortOrder = 'asc' | 'desc';

export type HeliusTransferType =
  | 'transfer'
  | 'transferFee'
  | 'mint'
  | 'burn'
  | 'wrap'
  | 'unwrap'
  | 'changeOwner'
  | 'changeAccountOwner'
  | 'withdrawWithheldFee'
  | string;

export interface HeliusTransferAmountFilter {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

export interface HeliusTransferRangeFilter {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

export interface HeliusTransferFilters {
  amount?: HeliusTransferAmountFilter;
  blockTime?: HeliusTransferRangeFilter;
  slot?: HeliusTransferRangeFilter;
}

export interface HeliusTransfersConfig {
  with?: string;
  direction?: HeliusTransferDirection;
  mint?: string;
  solMode?: HeliusTransferSolMode;
  filters?: HeliusTransferFilters;
  limit?: number;
  paginationToken?: string;
  commitment?: HeliusTransferCommitment;
  sortOrder?: HeliusTransferSortOrder;
}

export interface HeliusTransferRecord {
  signature: string;
  slot: number;
  blockTime?: number;
  type: HeliusTransferType;
  fromUserAccount: string | null;
  toUserAccount: string | null;
  fromTokenAccount?: string;
  toTokenAccount?: string;
  mint: string;
  amount: string;
  feeAmount?: string;
  decimals: number;
  uiAmount: string;
  feeUiAmount?: string;
  confirmationStatus?: HeliusTransferCommitment;
  transactionIdx?: number;
  instructionIdx?: number;
  innerInstructionIdx?: number;
}

export interface HeliusTransferPage {
  data: HeliusTransferRecord[];
  paginationToken?: string | null;
}

export interface GetTransfersByAddressInput {
  address: string;
  config?: HeliusTransfersConfig;
}

export interface GetTransfersByAddressOptions {
  traceId?: string;
  purpose?: HeliusCreditPurpose;
  creditLedgerDir?: string;
  recordCreditUsage?: boolean;
  fetchImpl?: typeof fetch;
}

export async function getTransfersByAddress(
  rpcUrl: string,
  input: GetTransfersByAddressInput,
  options: GetTransfersByAddressOptions = {},
): Promise<HeliusTransferPage | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const traceId = options.traceId ?? `gtba-${Date.now()}`;
  const body = {
    jsonrpc: '2.0',
    id: traceId,
    method: 'getTransfersByAddress',
    params: [
      input.address,
      sanitizeConfig(input.config ?? {}),
    ],
  };
  let creditRecorded = false;

  try {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await recordCreditUsage(input.address, traceId, options);
    creditRecorded = true;

    if (!res.ok) {
      log.warn(`[HELIUS_TRANSFERS] HTTP ${res.status} — fail-open undefined`);
      return undefined;
    }
    const json = await res.json() as { result?: unknown; error?: unknown };
    if (json.error) {
      log.warn(`[HELIUS_TRANSFERS] RPC error: ${JSON.stringify(json.error)}`);
      return undefined;
    }
    const parsed = parseGetTransfersByAddressResult(json.result);
    if (!parsed) {
      log.warn('[HELIUS_TRANSFERS] parse failed');
      return undefined;
    }
    return parsed;
  } catch (err) {
    if (!creditRecorded) {
      await recordCreditUsage(input.address, traceId, options);
    }
    log.warn(`[HELIUS_TRANSFERS] fetch failed: ${String(err)}`);
    return undefined;
  }
}

function sanitizeConfig(config: HeliusTransfersConfig): HeliusTransfersConfig {
  const out: HeliusTransfersConfig = { ...config };
  if (out.limit != null) {
    out.limit = Math.max(1, Math.min(100, Math.floor(out.limit)));
  }
  return out;
}

async function recordCreditUsage(
  walletAddress: string,
  traceId: string,
  options: GetTransfersByAddressOptions,
): Promise<void> {
  if (options.recordCreditUsage === false) return;
  const row = buildHeliusCreditUsage({
    purpose: options.purpose ?? 'wallet_style_backfill',
    surface: 'wallet_api',
    method: 'getTransfersByAddress',
    requestCount: 1,
    walletAddress,
    traceId,
  });
  await appendHeliusCreditUsage(row, { ledgerDir: options.creditLedgerDir }).catch(() => {});
}

export function parseGetTransfersByAddressResult(result: unknown): HeliusTransferPage | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as { data?: unknown; paginationToken?: unknown };
  if (!Array.isArray(r.data)) return undefined;
  const rows = r.data
    .map(parseTransferRecord)
    .filter((x): x is HeliusTransferRecord => Boolean(x));
  return {
    data: rows,
    paginationToken: typeof r.paginationToken === 'string' ? r.paginationToken : null,
  };
}

function parseTransferRecord(input: unknown): HeliusTransferRecord | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const r = input as Record<string, unknown>;
  if (
    typeof r.signature !== 'string' ||
    typeof r.slot !== 'number' ||
    typeof r.type !== 'string' ||
    typeof r.mint !== 'string' ||
    typeof r.amount !== 'string' ||
    typeof r.decimals !== 'number' ||
    typeof r.uiAmount !== 'string'
  ) {
    return undefined;
  }
  return {
    signature: r.signature,
    slot: r.slot,
    blockTime: typeof r.blockTime === 'number' ? r.blockTime : undefined,
    type: r.type,
    fromUserAccount: typeof r.fromUserAccount === 'string' ? r.fromUserAccount : null,
    toUserAccount: typeof r.toUserAccount === 'string' ? r.toUserAccount : null,
    fromTokenAccount: typeof r.fromTokenAccount === 'string' ? r.fromTokenAccount : undefined,
    toTokenAccount: typeof r.toTokenAccount === 'string' ? r.toTokenAccount : undefined,
    mint: r.mint,
    amount: r.amount,
    feeAmount: typeof r.feeAmount === 'string' ? r.feeAmount : undefined,
    decimals: r.decimals,
    uiAmount: r.uiAmount,
    feeUiAmount: typeof r.feeUiAmount === 'string' ? r.feeUiAmount : undefined,
    confirmationStatus: r.confirmationStatus === 'confirmed' || r.confirmationStatus === 'finalized'
      ? r.confirmationStatus
      : undefined,
    transactionIdx: typeof r.transactionIdx === 'number' ? r.transactionIdx : undefined,
    instructionIdx: typeof r.instructionIdx === 'number' ? r.instructionIdx : undefined,
    innerInstructionIdx: typeof r.innerInstructionIdx === 'number' ? r.innerInstructionIdx : undefined,
  };
}

export function classifyTransferDirection(
  record: Pick<HeliusTransferRecord, 'fromUserAccount' | 'toUserAccount'>,
  walletAddress: string,
): 'in' | 'out' | 'self' | 'unknown' {
  const from = record.fromUserAccount;
  const to = record.toUserAccount;
  const isFrom = from === walletAddress;
  const isTo = to === walletAddress;
  if (isFrom && isTo) return 'self';
  if (isFrom) return 'out';
  if (isTo) return 'in';
  return 'unknown';
}
