/**
 * Helius RPC Attribution (2026-05-09).
 *
 * Purpose: record Standard RPC / DAS usage by feature without changing trading
 * decisions. All writes are best-effort and fire-and-forget.
 */

import type { HeliusApiSurface, HeliusCreditPurpose } from './heliusCreditCost';
import {
  appendHeliusCreditUsage,
  buildHeliusCreditUsage,
} from './heliusCreditLedger';

export interface HeliusRpcAttributionInput {
  purpose: HeliusCreditPurpose;
  surface?: HeliusApiSurface;
  method: string;
  requestCount?: number;
  feature: string;
  lane?: string;
  tokenMint?: string;
  walletAddress?: string;
  txSignature?: string;
  traceId?: string;
}

export function recordHeliusRpcCredit(input: HeliusRpcAttributionInput): void {
  if (process.env.NODE_ENV === 'test' && process.env.HELIUS_CREDIT_LEDGER_IN_TEST !== 'true') {
    return;
  }
  const row = buildHeliusCreditUsage({
    purpose: input.purpose,
    surface: input.surface ?? 'standard_rpc',
    method: input.method,
    requestCount: input.requestCount ?? 1,
    feature: input.feature,
    lane: input.lane,
    tokenMint: input.tokenMint,
    walletAddress: input.walletAddress,
    txSignature: input.txSignature,
    traceId: input.traceId,
  });
  void appendHeliusCreditUsage(row).catch(() => {});
}
