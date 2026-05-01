/**
 * Helius Priority Fee API client (2026-05-01, Stream F).
 *
 * ADR: docs/exec-plans/active/helius-credit-edge-plan-2026-05-01.md §6 Stream F
 *
 * 목적: 운영 path 의 priority fee estimate 를 observe-only 로 수집 →
 *       signal loss vs execution loss 분리 (Plan §14 Q6).
 *
 * 정책:
 *   - **observe-only**: 자동 fee escalation 0 (Plan §11 rollout rule 5).
 *   - **fail-open**: 실패 시 throw 안 함, undefined 반환.
 *   - **credit ledger trace**: 호출 시 Stream A 의 heliusCreditLedger 와 join.
 *
 * Helius docs:
 *   - https://www.helius.dev/docs/priority-fee-api
 *   - cost: 1 credit per call
 */

import { createModuleLogger } from '../utils/logger';
import {
  appendHeliusCreditUsage,
  buildHeliusCreditUsage,
} from '../observability/heliusCreditLedger';

const log = createModuleLogger('HeliusPriorityFee');

/** Helius docs: 6 levels Min / Low / Medium / High / VeryHigh / UnsafeMax */
export type PriorityFeeLevel = 'Min' | 'Low' | 'Medium' | 'High' | 'VeryHigh' | 'UnsafeMax';

export interface PriorityFeeEstimate {
  /** Helius 가 추천한 microLamports/CU value */
  priorityFeeEstimate: number;
  /** Optional level enum (Helius 가 반환할 때만) */
  level?: PriorityFeeLevel;
  /** Optional tier breakdown — Helius 가 반환할 수 있음 */
  priorityFeeLevels?: Partial<Record<PriorityFeeLevel, number>>;
}

export interface PriorityFeeRequestInput {
  /** transaction account list (base58 strings). 비어있으면 시장 전체 estimate */
  accountKeys?: string[];
  /** request 추적용 trace id */
  traceId?: string;
  /** credit ledger 기록 여부 (default true) */
  recordCreditUsage?: boolean;
}

/**
 * Helius `getPriorityFeeEstimate` HTTP wrapper.
 *
 * 본 함수는 fetch 기반 — 실제 Connection.getPriorityFeeEstimate 가 web3.js 에 없어 RPC method 직접 호출.
 * 의존: helius RPC URL — config.solanaRpcUrl 또는 별도 env (Stream F 는 동일 endpoint 재사용).
 *
 * fail-open: response 실패 / parse 실패 시 undefined 반환. caller 가 분기.
 */
export async function getPriorityFeeEstimate(
  rpcUrl: string,
  input: PriorityFeeRequestInput = {},
): Promise<PriorityFeeEstimate | undefined> {
  // Helius RPC 의 priority fee method:
  //   { method: "getPriorityFeeEstimate", params: [{ accountKeys, options: { includeAllPriorityFeeLevels: true }}] }
  const body = {
    jsonrpc: '2.0',
    id: input.traceId ?? `pf-${Date.now()}`,
    method: 'getPriorityFeeEstimate',
    params: [
      {
        accountKeys: input.accountKeys ?? [],
        options: {
          includeAllPriorityFeeLevels: true,
        },
      },
    ],
  };

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.warn(`[HELIUS_PRIORITY_FEE] HTTP ${res.status} — fail-open undefined`);
      return undefined;
    }
    const json = (await res.json()) as { result?: unknown; error?: unknown };
    if (json.error) {
      log.warn(`[HELIUS_PRIORITY_FEE] RPC error: ${JSON.stringify(json.error)}`);
      return undefined;
    }
    const parsed = parsePriorityFeeResponse(json.result);
    if (!parsed) {
      log.warn(`[HELIUS_PRIORITY_FEE] parse failed`);
      return undefined;
    }

    // credit ledger trace
    if (input.recordCreditUsage !== false) {
      const row = buildHeliusCreditUsage({
        purpose: 'execution_telemetry',
        surface: 'priority_fee',
        method: 'getPriorityFeeEstimate',
        requestCount: 1,
        traceId: input.traceId,
      });
      // fire-and-forget
      void appendHeliusCreditUsage(row).catch(() => {});
    }
    return parsed;
  } catch (err) {
    log.warn(`[HELIUS_PRIORITY_FEE] fetch failed: ${String(err)}`);
    return undefined;
  }
}

/**
 * Helius RPC response → PriorityFeeEstimate 변환.
 * pure function — test 용이.
 *
 * Helius response shape:
 *   {
 *     priorityFeeEstimate: number,
 *     priorityFeeLevels?: { min, low, medium, high, veryHigh, unsafeMax }
 *   }
 */
export function parsePriorityFeeResponse(result: unknown): PriorityFeeEstimate | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as { priorityFeeEstimate?: unknown; priorityFeeLevels?: unknown };
  if (typeof r.priorityFeeEstimate !== 'number' || !Number.isFinite(r.priorityFeeEstimate)) {
    return undefined;
  }
  const levels = parseLevels(r.priorityFeeLevels);
  return {
    priorityFeeEstimate: r.priorityFeeEstimate,
    priorityFeeLevels: levels,
  };
}

const LEVEL_KEY_MAP: Record<string, PriorityFeeLevel> = {
  min: 'Min',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  veryhigh: 'VeryHigh',
  unsafemax: 'UnsafeMax',
};

function parseLevels(input: unknown): Partial<Record<PriorityFeeLevel, number>> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const out: Partial<Record<PriorityFeeLevel, number>> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const lvl = LEVEL_KEY_MAP[k.toLowerCase()];
    if (lvl && typeof v === 'number' && Number.isFinite(v)) {
      out[lvl] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 추정 fee 의 percentile-like classification.
 * 운영자가 priority fee 추정값으로 cohort 분리할 때 사용.
 *
 * Heuristic:
 *   < 1_000 microLamports/CU       → 'Min'
 *   < 10_000                        → 'Low'
 *   < 50_000                        → 'Medium'
 *   < 200_000                       → 'High'
 *   < 1_000_000                     → 'VeryHigh'
 *   ≥ 1_000_000                     → 'UnsafeMax'
 */
export function classifyPriorityFee(microLamportsPerCu: number): PriorityFeeLevel | undefined {
  if (!Number.isFinite(microLamportsPerCu) || microLamportsPerCu < 0) return undefined;
  if (microLamportsPerCu < 1_000) return 'Min';
  if (microLamportsPerCu < 10_000) return 'Low';
  if (microLamportsPerCu < 50_000) return 'Medium';
  if (microLamportsPerCu < 200_000) return 'High';
  if (microLamportsPerCu < 1_000_000) return 'VeryHigh';
  return 'UnsafeMax';
}
