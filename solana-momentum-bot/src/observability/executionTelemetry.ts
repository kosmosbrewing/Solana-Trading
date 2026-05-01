/**
 * Execution Telemetry (2026-05-01, Stream F).
 *
 * ADR: docs/exec-plans/active/helius-credit-edge-plan-2026-05-01.md §6 Stream F
 *
 * 목적: live entry/exit 시점에 priority fee + landing latency + slot delta + account contention 을
 *       observe-only 로 수집 → "signal loss vs execution loss" 분리 (Plan §14 Q6).
 *
 * 정책:
 *   - **observe-only** — 자동 fee escalation 0 (rollout rule 5)
 *   - executor 의 기존 `landingLatencyMs` 재사용 (QA M7: no duplicate latency field)
 *   - copyability flag 는 운영자 분석용 — 정책 변경 0
 *
 * 의존: 없음 (pure data join). I/O 없음.
 */

import type { PriorityFeeLevel } from '../ingester/heliusPriorityFeeClient';

/**
 * Execution telemetry 의 통합 view.
 * Plan §6 Stream F field list 정합 + executor 기존 필드 재사용.
 */
export interface ExecutionTelemetryRecord {
  /** Helius 추정값 (microLamports/CU). undefined = priority fee 미수집 */
  priorityFeeEstimateMicroLamports?: number;
  /** Plan §6 Stream F 의 6 level enum 분류 */
  priorityFeeLevel?: PriorityFeeLevel;
  /** Executor 가 채우는 기존 필드 (재사용 — QA M7) */
  landingLatencyMs?: number;
  /** anchor slot 과 confirmed slot 의 차이 — late landing 측정 */
  landingSlotDelta?: number;
  /** account contention hint (Helius Sender / staked path 정보) */
  accountContentionHint?: string;
  /**
   * copyability flag — 운영자 cohort 분석용 분류.
   *  'fee_underpaid'   priority fee 추정 < quote level
   *  'late_landing'    landingLatencyMs > threshold
   *  'slot_drift'      landingSlotDelta > threshold
   *  'normal'          정상 path
   */
  executionCopyabilityFlag?: 'fee_underpaid' | 'late_landing' | 'slot_drift' | 'normal';
}

/**
 * 입력 정합 helper — executor 결과 + priority fee estimate 을 join 해서 ExecutionTelemetryRecord 산출.
 *
 * 사용 예:
 *   const telemetry = buildExecutionTelemetry({
 *     priorityFeeEstimateMicroLamports: estimate.priorityFeeEstimate,
 *     priorityFeeLevel: classifyPriorityFee(estimate.priorityFeeEstimate),
 *     landingLatencyMs: executorResult.landingLatencyMs,
 *     anchorSlot: someSlot, confirmedSlot: tx.slot,
 *   });
 */
export function buildExecutionTelemetry(input: {
  priorityFeeEstimateMicroLamports?: number;
  priorityFeeLevel?: PriorityFeeLevel;
  landingLatencyMs?: number;
  /** anchor 시점의 slot — confirmedSlot 과 차이 = landingSlotDelta */
  anchorSlot?: number;
  confirmedSlot?: number;
  accountContentionHint?: string;
  /** copyability flag 분류 임계 (default 사용 가능) */
  thresholds?: {
    /** late landing 임계 (ms) — default 5000 */
    landingLatencyMsHigh?: number;
    /** slot drift 임계 — default 8 (~3.2s @ 400ms slots) */
    slotDeltaHigh?: number;
  };
}): ExecutionTelemetryRecord {
  const landingSlotDelta = computeSlotDelta(input.anchorSlot, input.confirmedSlot);
  const flag = classifyCopyability({
    landingLatencyMs: input.landingLatencyMs,
    landingSlotDelta,
    landingLatencyMsHigh: input.thresholds?.landingLatencyMsHigh ?? 5000,
    slotDeltaHigh: input.thresholds?.slotDeltaHigh ?? 8,
  });
  return {
    priorityFeeEstimateMicroLamports: input.priorityFeeEstimateMicroLamports,
    priorityFeeLevel: input.priorityFeeLevel,
    landingLatencyMs: input.landingLatencyMs,
    landingSlotDelta,
    accountContentionHint: input.accountContentionHint,
    executionCopyabilityFlag: flag,
  };
}

function computeSlotDelta(anchor?: number, confirmed?: number): number | undefined {
  if (typeof anchor !== 'number' || typeof confirmed !== 'number') return undefined;
  if (!Number.isFinite(anchor) || !Number.isFinite(confirmed)) return undefined;
  if (confirmed < anchor) return 0; // backward slot — clamp to 0 (defensive)
  return confirmed - anchor;
}

/**
 * Copyability flag 분류 — 정책 변경 0, 분석용 cohort.
 *
 * priority:
 *   1) late_landing (landingLatencyMs > threshold)
 *   2) slot_drift (landingSlotDelta > threshold)
 *   3) normal
 *
 * 'fee_underpaid' 는 정확한 quote level 비교 input 이 필요 — buildExecutionTelemetry 의 단순 input
 * 으로는 산출 안 함. 별도 classifyFeeUnderpaid helper 가 받음.
 */
export function classifyCopyability(input: {
  landingLatencyMs?: number;
  landingSlotDelta?: number;
  landingLatencyMsHigh: number;
  slotDeltaHigh: number;
}): ExecutionTelemetryRecord['executionCopyabilityFlag'] {
  if (typeof input.landingLatencyMs === 'number' && input.landingLatencyMs > input.landingLatencyMsHigh) {
    return 'late_landing';
  }
  if (typeof input.landingSlotDelta === 'number' && input.landingSlotDelta > input.slotDeltaHigh) {
    return 'slot_drift';
  }
  return 'normal';
}

/**
 * fee_underpaid 분류 — Helius quote level 보다 실제 paid 가 낮으면 emit.
 *
 * @param paidMicroLamports 운영 path 가 실제 지불한 priority fee
 * @param recommendedMicroLamports Helius quote 의 medium/high level
 */
export function classifyFeeUnderpaid(
  paidMicroLamports: number | undefined,
  recommendedMicroLamports: number | undefined,
): boolean {
  if (typeof paidMicroLamports !== 'number' || !Number.isFinite(paidMicroLamports)) return false;
  if (typeof recommendedMicroLamports !== 'number' || !Number.isFinite(recommendedMicroLamports)) return false;
  return paidMicroLamports < recommendedMicroLamports;
}
