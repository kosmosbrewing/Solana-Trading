/**
 * Bleed Model — venue-specific round-trip cost adapters (DEX_TRADE Phase 2, 2026-04-18)
 *
 * Why: probe viability floor 와 daily bleed budget 이 의미 있으려면 **venue 별로 다른**
 * round-trip cost 모델이 필요. 현재 `estimatePaperCost()` 는 전역 flat 0.45%. DEX_TRADE.md
 * Section 8 요구: `bleed_model_cpmm / clmm / dlmm / pumpswap`.
 *
 * 공식:
 *   bleed_total = base_fee + priority_fee + tip + venue_fee
 *                + expected_entry_slippage + expected_quick_exit_slippage
 *
 * 단위: 모두 **SOL** 기준 (wallet 관점). ticket 크기 × %cost 로 환산해서 합산.
 *
 * 현재 지원 venue:
 *   - raydium (CPMM/CLMM/CPMM amm)
 *   - pumpswap (canonical pool)
 *   - meteora (DLMM/DAMM v1/v2)
 *   - orca (Whirlpool)
 *   - unknown (default flat fallback)
 */

export type Venue = 'raydium' | 'pumpswap' | 'meteora' | 'orca' | 'unknown';

export interface BleedInputs {
  /** ticket 크기 (SOL) — 매수 투입 SOL */
  ticketSol: number;
  /** priority fee estimate (SOL). 미지정 시 default 사용 */
  priorityFeeSol?: number;
  /** tip (Jito bundle 등) SOL. 기본 0 */
  tipSol?: number;
  /** entry slippage 추정 (bps). 보통 gate 측정 probe 결과 주입. 미지정 시 default 50bps (0.5%) */
  entrySlippageBps?: number;
  /** quick exit slippage 추정 (bps). PROBE 30s 내 청산 가정. 미지정 시 entry × 1.5 */
  quickExitSlippageBps?: number;
}

export interface BleedBreakdown {
  venue: Venue;
  ticketSol: number;
  baseFeeSol: number;              // Solana network tx fee (base)
  priorityFeeSol: number;
  tipSol: number;
  venueFeeSol: number;             // AMM fee % × ticket (양쪽 = entry+exit, 따라서 ×2)
  entrySlippageSol: number;
  quickExitSlippageSol: number;
  totalSol: number;                // 모든 항목 합계
  totalPct: number;                // totalSol / ticketSol (round-trip)
}

const SOLANA_BASE_FEE_SOL = 0.000005;           // 5k lamports per signature
// 2026-04-18: default 0.0005 → 0.0001 (실 운영 관측: Jupiter+Jito 조합 평균).
// 너무 크면 0.01 ticket 대비 10% 점유 → viability floor 과잉 rejection.
const DEFAULT_PRIORITY_FEE_SOL = 0.0001;
const DEFAULT_ENTRY_SLIPPAGE_BPS = 50;          // 0.5%
const DEFAULT_QUICK_EXIT_SLIPPAGE_MULTIPLIER = 1.5;

// Venue-specific AMM fee (per side, %).
// 실측 기반으로 조정. 초기값은 공개 docs 기반 approximation.
const VENUE_FEE_PCT: Record<Venue, number> = {
  raydium: 0.0025,        // 0.25% per side (V4/CLMM/CPMM 평균)
  pumpswap: 0.01,         // 1% per side (canonical pool — pump.fun graduated)
  meteora: 0.003,         // 0.3% per side (DLMM 평균; DAMM은 pool-specific)
  orca: 0.003,            // 0.3% per side (Whirlpool 평균)
  unknown: 0.005,         // conservative fallback 0.5%
};

function computeBleed(venue: Venue, inputs: BleedInputs): BleedBreakdown {
  const { ticketSol } = inputs;
  const baseFeeSol = SOLANA_BASE_FEE_SOL * 2;            // entry + exit
  const priorityFeeSol = (inputs.priorityFeeSol ?? DEFAULT_PRIORITY_FEE_SOL) * 2;  // 양쪽
  const tipSol = (inputs.tipSol ?? 0) * 2;
  const venueFeePct = VENUE_FEE_PCT[venue] ?? VENUE_FEE_PCT.unknown;
  const venueFeeSol = venueFeePct * ticketSol * 2;       // entry + exit

  const entryBps = inputs.entrySlippageBps ?? DEFAULT_ENTRY_SLIPPAGE_BPS;
  const exitBps = inputs.quickExitSlippageBps ?? entryBps * DEFAULT_QUICK_EXIT_SLIPPAGE_MULTIPLIER;
  const entrySlippageSol = (entryBps / 10_000) * ticketSol;
  const quickExitSlippageSol = (exitBps / 10_000) * ticketSol;

  const totalSol = baseFeeSol + priorityFeeSol + tipSol + venueFeeSol + entrySlippageSol + quickExitSlippageSol;
  const totalPct = ticketSol > 0 ? totalSol / ticketSol : 0;

  return {
    venue,
    ticketSol,
    baseFeeSol,
    priorityFeeSol,
    tipSol,
    venueFeeSol,
    entrySlippageSol,
    quickExitSlippageSol,
    totalSol,
    totalPct,
  };
}

/** CPMM / CLMM / Raydium AMM family */
export function bleedRaydium(inputs: BleedInputs): BleedBreakdown {
  return computeBleed('raydium', inputs);
}

/** PumpSwap canonical pool (graduated pump.fun tokens) */
export function bleedPumpSwap(inputs: BleedInputs): BleedBreakdown {
  return computeBleed('pumpswap', inputs);
}

/** Meteora (DLMM / DAMM v1/v2) */
export function bleedMeteora(inputs: BleedInputs): BleedBreakdown {
  return computeBleed('meteora', inputs);
}

/** Orca Whirlpool */
export function bleedOrca(inputs: BleedInputs): BleedBreakdown {
  return computeBleed('orca', inputs);
}

/** Unknown / fallback — conservative estimate */
export function bleedUnknown(inputs: BleedInputs): BleedBreakdown {
  return computeBleed('unknown', inputs);
}

/**
 * Dispatcher — venue-specific adapter 자동 선택.
 * dexId 는 normalized canonical id (raydium/orca/pumpswap/meteora) 을 받는다.
 */
export function estimateBleed(
  venue: Venue | string | undefined,
  inputs: BleedInputs
): BleedBreakdown {
  switch (venue) {
    case 'raydium': return bleedRaydium(inputs);
    case 'pumpswap': return bleedPumpSwap(inputs);
    case 'meteora': return bleedMeteora(inputs);
    case 'orca': return bleedOrca(inputs);
    default: return bleedUnknown(inputs);
  }
}

/** Phase 2 helper — 전체 bleed 가 budget 초과 여부 */
export function exceedsBleedBudget(
  breakdown: BleedBreakdown,
  bleedBudgetSol: number
): boolean {
  return breakdown.totalSol > bleedBudgetSol;
}
