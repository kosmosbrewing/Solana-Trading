/**
 * Helius Credit Usage Ledger (2026-05-01, Stream A).
 *
 * ADR: docs/exec-plans/active/helius-credit-edge-plan-2026-05-01.md §6 Stream A
 * Research Ledger ADR §13 footnote: 본 ledger 는 별도 namespace (`helius-credit-usage/v1`),
 *                                    `trade-outcome/v1` / `kol-call-funnel/v1` 와 무관.
 *
 * 정책:
 *   - sidecar ops trace ledger — schema v1 동결 외 별도 namespace
 *   - **fail-open** — append 실패 시 throw 안 함, log warn + boolean 결과 반환 (mission §3 wallet floor 우선)
 *   - **append-only** — 한 번 쓴 row 는 수정 안 함
 *   - 운영 path 에서 호출되지만 (Stream A 는 호출자 0, 후속 PR 에서 wiring) trading 결정에 영향 0
 *
 * 출력: `data/realtime/helius-credit-usage.jsonl`
 */

import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import {
  HELIUS_COST_CATALOG_VERSION,
  estimateCostFallback,
  estimateWssCredits,
  getCostByMethodAndSurface,
} from './heliusCreditCost';
import type {
  HeliusCreditPurpose,
  HeliusApiSurface,
} from './heliusCreditCost';

const log = createModuleLogger('HeliusCreditLedger');

const LEDGER_FILENAME = 'helius-credit-usage.jsonl';

export const HELIUS_CREDIT_USAGE_SCHEMA_VERSION = 'helius-credit-usage/v1' as const;

/**
 * 단일 Helius API call usage row.
 *
 * Note: Codex Research Ledger ADR S2.5 와 동일한 fail-open / unique key 패턴 적용.
 *       다만 별도 namespace 라 dedupe key 는 단순 — caller 가 nonce 부여.
 */
export interface HeliusCreditUsageRecord {
  schemaVersion: typeof HELIUS_CREDIT_USAGE_SCHEMA_VERSION;
  catalogVersion: typeof HELIUS_COST_CATALOG_VERSION;
  /** ISO timestamp of recording */
  timestamp: string;
  /** 호출 목적 — allocation cohort */
  purpose: HeliusCreditPurpose;
  /** API surface (standard_rpc / enhanced_tx / das / wallet_api / priority_fee / webhook / wss / sender / staked_connection) */
  surface: HeliusApiSurface;
  /** Helius method name (e.g. getParsedTransaction) */
  method: string;
  /** estimated credits 합 (call 1 회당 cost × requestCount, WSS 면 byte 기반) */
  estimatedCredits: number;
  /** 호출 횟수 (batch / loop 시 합산 가능) */
  requestCount: number;
  /** WSS 만 — 실제 metered byte 수 */
  wssBytes?: number;
  /** Optional context (debug / cohort) */
  tokenMint?: string;
  walletAddress?: string;
  txSignature?: string;
  /** 정확도 source — 'estimate' (catalog 기반) vs 'dashboard_reconcile' (운영자 수동 보정) */
  source: 'estimate' | 'dashboard_reconcile';
  /** caller 가 부여한 trace id (debug). dedupe 용도 아님. */
  traceId?: string;
}

export interface AppendCreditUsageResult {
  appended: boolean;
  error?: string;
}

function resolveLedgerDir(overrideDir?: string): string {
  return overrideDir ?? (config as { realtimeDataDir: string }).realtimeDataDir;
}

async function ensureDir(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    return true;
  } catch (err) {
    log.error(`[HELIUS_CREDIT_LEDGER] mkdir failed dir=${dir}: ${String(err)}`);
    return false;
  }
}

/**
 * Append helper — fail-open. throw 안 함.
 */
async function appendJsonl(filePath: string, record: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const line = JSON.stringify(record) + '\n';
    await appendFile(filePath, line, 'utf8');
    return { ok: true };
  } catch (err) {
    const msg = String(err);
    log.error(`[HELIUS_CREDIT_LEDGER] append failed file=${filePath}: ${msg}`);
    return { ok: false, error: msg };
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Helius credit usage row append (sidecar ledger).
 *
 * fail-open 정책 — 어떤 실패도 throw 안 함. caller 는 result.appended 로 분기.
 */
export async function appendHeliusCreditUsage(
  record: HeliusCreditUsageRecord,
  options: { ledgerDir?: string } = {},
): Promise<AppendCreditUsageResult> {
  const dir = resolveLedgerDir(options.ledgerDir);
  const dirOk = await ensureDir(dir);
  if (!dirOk) {
    return { appended: false, error: 'ledger_dir_unavailable' };
  }
  const result = await appendJsonl(path.join(dir, LEDGER_FILENAME), record);
  return { appended: result.ok, error: result.error };
}

/**
 * Build helper — caller 가 필드 일부만 줘도 catalog 기반 estimate 자동 계산.
 *
 * 사용 예 (script):
 *   const row = buildHeliusCreditUsage({
 *     purpose: 'markout_backfill',
 *     surface: 'standard_rpc',
 *     method: 'getParsedTransaction',
 *     requestCount: 1,
 *     tokenMint: 'XYZ',
 *   });
 *   await appendHeliusCreditUsage(row);
 */
export function buildHeliusCreditUsage(input: {
  purpose: HeliusCreditPurpose;
  surface: HeliusApiSurface;
  method: string;
  requestCount: number;
  wssBytes?: number;
  tokenMint?: string;
  walletAddress?: string;
  txSignature?: string;
  source?: 'estimate' | 'dashboard_reconcile';
  traceId?: string;
  timestamp?: string;
}): HeliusCreditUsageRecord {
  const requestCount = Math.max(0, Math.floor(input.requestCount || 0));
  let estimatedCredits = 0;

  if (input.surface === 'wss') {
    // WSS 는 byte 기반 metering — wssBytes 필수
    estimatedCredits = estimateWssCredits(input.wssBytes ?? 0);
  } else {
    const catalog = getCostByMethodAndSurface(input.method, input.surface);
    const perCall = catalog?.creditsPerCall ?? estimateCostFallback(input.surface);
    estimatedCredits = perCall * requestCount;
  }

  return {
    schemaVersion: HELIUS_CREDIT_USAGE_SCHEMA_VERSION,
    catalogVersion: HELIUS_COST_CATALOG_VERSION,
    timestamp: input.timestamp ?? new Date().toISOString(),
    purpose: input.purpose,
    surface: input.surface,
    method: input.method,
    estimatedCredits,
    requestCount,
    wssBytes: input.wssBytes,
    tokenMint: input.tokenMint,
    walletAddress: input.walletAddress,
    txSignature: input.txSignature,
    source: input.source ?? 'estimate',
    traceId: input.traceId,
  };
}

/**
 * 다중 row 한 번에 append (script 의 batch backfill 용).
 * 각 row 별 fail-open 결과 반환 — 일부 실패해도 나머지 진행.
 *
 * Optimization (QA-1): ensureDir 를 batch 시작 시 1회만 호출 (N row → 1 mkdir).
 *   appendHeliusCreditUsage 호출 시마다 mkdir recursive 가 idempotent 통과하지만 syscall 줄임.
 */
export async function appendHeliusCreditUsageBatch(
  records: HeliusCreditUsageRecord[],
  options: { ledgerDir?: string } = {},
): Promise<{ totalAppended: number; failures: number }> {
  if (records.length === 0) return { totalAppended: 0, failures: 0 };

  const dir = resolveLedgerDir(options.ledgerDir);
  const dirOk = await ensureDir(dir);
  if (!dirOk) {
    return { totalAppended: 0, failures: records.length };
  }

  const filePath = path.join(dir, LEDGER_FILENAME);
  let totalAppended = 0;
  let failures = 0;
  for (const r of records) {
    const result = await appendJsonl(filePath, r);
    if (result.ok) totalAppended += 1;
    else failures += 1;
  }
  return { totalAppended, failures };
}
