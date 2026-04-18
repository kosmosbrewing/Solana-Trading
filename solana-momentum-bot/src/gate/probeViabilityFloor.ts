/**
 * Probe Viability Floor (DEX_TRADE Phase 2, 2026-04-18)
 *
 * Why: Phase 1 의 RR gate 는 retire. 대신 "진입 불가능한 토큰까지 다 사는 것"을 방지하는
 * 최소 viability floor 필요. DEX_TRADE.md Section 8.
 *
 * Check (순서 중요 — cheap 먼저):
 *   1. ticket 최소값
 *   2. 기대 round-trip bleed <= probe bleed budget
 *   3. daily bleed budget (누적) 여유
 *   4. (선택) route 존재 + sell impact cap
 *
 * route / sell impact probe 는 async + rpc call → latency 비용. Phase 2 에서는 **미리 준비된 quote
 * metadata** 가 있으면 사용. 없으면 skip (Phase 3 후보: 상시 reverse quote prefetch).
 *
 * 본 모듈은 **동기 / 값 기반** check 만 담당. 호출자가 quote 데이터를 inputs 로 주입한다.
 */
import type { Venue, BleedBreakdown } from '../execution/bleedModel';
import { estimateBleed } from '../execution/bleedModel';

export interface ProbeViabilityInputs {
  venue: Venue | string | undefined;
  ticketSol: number;
  priorityFeeSol?: number;
  tipSol?: number;
  /** Jupiter quote probe 로 측정한 entry slippage (optional) */
  entrySlippageBps?: number;
  /** exit 측 slippage probe (optional, 권장). 없으면 entry × 1.5 */
  quickExitSlippageBps?: number;
  /** sell impact measurement (%), gate 에서 수집된 값 (optional) */
  sellImpactPct?: number;
}

export interface ProbeViabilityConfig {
  /** probe 최소 ticket 크기 (SOL). 너무 작으면 bleed 가 ticket 을 넘음 */
  minTicketSol: number;
  /** round-trip bleed 한계 (ticket 대비 %). 초과 시 reject */
  maxBleedPct: number;
  /** sell impact hard cap (%). 초과 시 reject. 0 이면 check 비활성 */
  maxSellImpactPct: number;
  /** 오늘 남은 daily bleed budget (SOL). 호출자가 runtime 에서 주입 */
  remainingDailyBudgetSol: number;
}

export type ProbeViabilityReason =
  | 'ok'
  | 'ticket_too_small'
  | 'bleed_over_probe_cap'
  | 'sell_impact_too_high'
  | 'daily_bleed_budget_exhausted';

export interface ProbeViabilityResult {
  allow: boolean;
  reason: ProbeViabilityReason;
  bleed: BleedBreakdown;
}

export function checkProbeViabilityFloor(
  inputs: ProbeViabilityInputs,
  config: ProbeViabilityConfig
): ProbeViabilityResult {
  const bleed = estimateBleed(inputs.venue, {
    ticketSol: inputs.ticketSol,
    priorityFeeSol: inputs.priorityFeeSol,
    tipSol: inputs.tipSol,
    entrySlippageBps: inputs.entrySlippageBps,
    quickExitSlippageBps: inputs.quickExitSlippageBps,
  });

  // 1. ticket 최소값
  if (inputs.ticketSol < config.minTicketSol) {
    return { allow: false, reason: 'ticket_too_small', bleed };
  }

  // 2. round-trip bleed 초과 (probe 당)
  if (bleed.totalPct > config.maxBleedPct) {
    return { allow: false, reason: 'bleed_over_probe_cap', bleed };
  }

  // 3. daily bleed budget
  if (config.remainingDailyBudgetSol <= 0) {
    return { allow: false, reason: 'daily_bleed_budget_exhausted', bleed };
  }
  if (bleed.totalSol > config.remainingDailyBudgetSol) {
    return { allow: false, reason: 'daily_bleed_budget_exhausted', bleed };
  }

  // 4. sell impact hard cap (optional)
  if (
    config.maxSellImpactPct > 0 &&
    inputs.sellImpactPct != null &&
    inputs.sellImpactPct > config.maxSellImpactPct
  ) {
    return { allow: false, reason: 'sell_impact_too_high', bleed };
  }

  return { allow: true, reason: 'ok', bleed };
}
