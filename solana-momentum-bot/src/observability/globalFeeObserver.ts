/**
 * Global Fee Observer (2026-05-01, Decu Quality Layer Phase B.4).
 *
 * ADR §4.5 정합. Axiom UI "Global Fees Paid" 의 proxy.
 *
 * 정의 (ADR §4.5):
 *   estimatedGlobalFees5mSol = rollingObservedVolume5mSol × venueFeeRate
 *   feeToLiquidity = estimatedGlobalFees5mSol / liquiditySol
 *   feeToMcap      = estimatedGlobalFees5mSol / marketCapSol
 *   feeVelocity    = estimatedGlobalFees5mSol / tokenAgeMinutes
 *   volumeToLiq    = rollingVolume5mSol / liquiditySol
 *
 * Pump.fun bonding curve / PumpSwap canonical pool fee tier 별도 적용.
 *
 * 모든 ratio 는 zero-division 가드 — liquiditySol / marketCapSol / tokenAgeMinutes 가
 * 0 또는 음수 시 undefined 반환.
 */

// ─── Venue fee rates (ADR §4.5) ─────────────────────────

/** Pump.fun bonding curve / PumpSwap / Raydium / Meteora 등의 venue 별 fee rate. */
export type VenueFeeKind =
  | 'pumpfun_bonding'   // Pump.fun bonding curve (1% buy, 1% sell)
  | 'pumpswap'          // PumpSwap canonical (0.25%)
  | 'raydium_amm'       // 0.25%
  | 'meteora'           // 0.25% (DLMM 변동 — 보수적)
  | 'orca_whirlpool'    // 0.30%
  | 'jupiter_aggregator' // 0% (router, 실제 fee 는 underlying venue)
  | 'unknown';

export const VENUE_FEE_RATES: Record<VenueFeeKind, number> = {
  pumpfun_bonding: 0.01,
  pumpswap: 0.0025,
  raydium_amm: 0.0025,
  meteora: 0.0025,
  orca_whirlpool: 0.0030,
  jupiter_aggregator: 0,
  unknown: 0.0025,  // 보수적 default
};

export function resolveVenueFeeRate(venue?: string): number {
  if (!venue) return VENUE_FEE_RATES.unknown;
  const normalized = venue.toLowerCase();
  if (normalized.includes('pumpfun') || normalized.includes('pump.fun') || normalized.includes('bonding')) {
    return VENUE_FEE_RATES.pumpfun_bonding;
  }
  if (normalized.includes('pumpswap')) return VENUE_FEE_RATES.pumpswap;
  if (normalized.includes('raydium')) return VENUE_FEE_RATES.raydium_amm;
  if (normalized.includes('meteora')) return VENUE_FEE_RATES.meteora;
  if (normalized.includes('orca') || normalized.includes('whirlpool')) return VENUE_FEE_RATES.orca_whirlpool;
  if (normalized.includes('jupiter')) return VENUE_FEE_RATES.jupiter_aggregator;
  return VENUE_FEE_RATES.unknown;
}

// ─── Global fee proxy ─────────────────────────────────

export interface GlobalFeeInput {
  /** 5분 rolling observed volume (SOL). */
  rollingVolume5mSol: number;
  /** venue / dexId — fee rate 결정 입력 */
  venue?: string;
  /** 직접 지정 fee rate. 지정 시 venue 무시. */
  venueFeeRateOverride?: number;

  /** divisor — pool liquidity (SOL). 0 또는 음수 시 ratio 미산출 */
  liquiditySol?: number;
  /** divisor — market cap (SOL). */
  marketCapSol?: number;
  /** divisor — token age (분). pump.fun freshpair 의 fee velocity 측정 */
  tokenAgeMinutes?: number;
}

export interface GlobalFeeMetrics {
  estimatedGlobalFees5mSol?: number;
  feeToLiquidity?: number;
  feeToMcap?: number;
  feeVelocity?: number;
  volumeToLiq?: number;
}

export interface FeeRiskThresholds {
  /** FEE_TO_LIQUIDITY_HIGH (default 0.05 = 5% per 5min) */
  feeToLiquidityHigh: number;
  /** FEE_TO_MCAP_HIGH (default 0.01 = 1% per 5min) */
  feeToMcapHigh: number;
  /** FEE_VELOCITY_HIGH (default 0.005 SOL / minute) */
  feeVelocityHigh: number;
  /** VOLUME_TO_LIQ_HIGH (default 5.0 = 500% per 5min — wash trading 의심) */
  volumeToLiqHigh: number;
}

export const DEFAULT_FEE_THRESHOLDS: FeeRiskThresholds = {
  feeToLiquidityHigh: 0.05,
  feeToMcapHigh: 0.01,
  feeVelocityHigh: 0.005,
  volumeToLiqHigh: 5.0,
};

/**
 * Estimated global fees 산출 + 비율 지표.
 * zero-division 가드: liquidity / mcap / tokenAge 0 또는 음수 시 undefined.
 */
export function computeGlobalFeeMetrics(input: GlobalFeeInput): GlobalFeeMetrics {
  const venueFee = input.venueFeeRateOverride ?? resolveVenueFeeRate(input.venue);
  const fees = input.rollingVolume5mSol * venueFee;
  const out: GlobalFeeMetrics = {
    estimatedGlobalFees5mSol: fees,
  };
  if (input.liquiditySol != null && input.liquiditySol > 0) {
    out.feeToLiquidity = fees / input.liquiditySol;
    out.volumeToLiq = input.rollingVolume5mSol / input.liquiditySol;
  }
  if (input.marketCapSol != null && input.marketCapSol > 0) {
    out.feeToMcap = fees / input.marketCapSol;
  }
  if (input.tokenAgeMinutes != null && input.tokenAgeMinutes > 0) {
    out.feeVelocity = fees / input.tokenAgeMinutes;
  }
  return out;
}

export function computeFeeRiskFlags(
  metrics: GlobalFeeMetrics,
  thresholds: FeeRiskThresholds = DEFAULT_FEE_THRESHOLDS,
): string[] {
  const flags: string[] = [];
  if (metrics.feeToLiquidity != null && metrics.feeToLiquidity > thresholds.feeToLiquidityHigh) {
    flags.push('FEE_TO_LIQUIDITY_HIGH');
  }
  if (metrics.feeToMcap != null && metrics.feeToMcap > thresholds.feeToMcapHigh) {
    flags.push('FEE_TO_MCAP_HIGH');
  }
  if (metrics.feeVelocity != null && metrics.feeVelocity > thresholds.feeVelocityHigh) {
    flags.push('FEE_VELOCITY_HIGH');
  }
  if (metrics.volumeToLiq != null && metrics.volumeToLiq > thresholds.volumeToLiqHigh) {
    flags.push('VOLUME_TO_LIQ_HIGH');
  }
  return flags;
}
