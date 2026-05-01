/**
 * Global Fee Observer 단위 테스트 (2026-05-01, Decu Phase B.4).
 */
import {
  computeGlobalFeeMetrics,
  computeFeeRiskFlags,
  resolveVenueFeeRate,
  VENUE_FEE_RATES,
  DEFAULT_FEE_THRESHOLDS,
} from '../src/observability/globalFeeObserver';

describe('globalFeeObserver', () => {
  describe('resolveVenueFeeRate', () => {
    it('pumpfun bonding curve → 1%', () => {
      expect(resolveVenueFeeRate('Pump.fun')).toBe(0.01);
      expect(resolveVenueFeeRate('pumpfun_bonding')).toBe(0.01);
    });
    it('pumpswap canonical → 0.25%', () => {
      expect(resolveVenueFeeRate('PumpSwap')).toBe(0.0025);
    });
    it('raydium → 0.25%', () => {
      expect(resolveVenueFeeRate('raydium')).toBe(0.0025);
    });
    it('orca whirlpool → 0.30%', () => {
      expect(resolveVenueFeeRate('orca')).toBe(0.0030);
      expect(resolveVenueFeeRate('whirlpool')).toBe(0.0030);
    });
    it('jupiter aggregator → 0% (router)', () => {
      expect(resolveVenueFeeRate('jupiter')).toBe(0);
    });
    it('unknown → 보수적 default 0.25%', () => {
      expect(resolveVenueFeeRate('unknown_dex')).toBe(VENUE_FEE_RATES.unknown);
      expect(resolveVenueFeeRate(undefined)).toBe(VENUE_FEE_RATES.unknown);
    });
  });

  describe('computeGlobalFeeMetrics', () => {
    it('volume × venueFee = estimatedGlobalFees', () => {
      const m = computeGlobalFeeMetrics({
        rollingVolume5mSol: 100,
        venue: 'pumpswap',
      });
      expect(m.estimatedGlobalFees5mSol).toBeCloseTo(0.25, 4);  // 100 × 0.0025
    });

    it('feeToLiquidity 산출 — liquidity > 0', () => {
      const m = computeGlobalFeeMetrics({
        rollingVolume5mSol: 100,
        venueFeeRateOverride: 0.01,
        liquiditySol: 50,
      });
      // fees = 1, feeToLiquidity = 1 / 50 = 0.02
      expect(m.feeToLiquidity).toBeCloseTo(0.02, 4);
      expect(m.volumeToLiq).toBeCloseTo(2, 4);  // 100 / 50
    });

    it('liquidity = 0 → feeToLiquidity undefined (zero division 가드)', () => {
      const m = computeGlobalFeeMetrics({
        rollingVolume5mSol: 100,
        venueFeeRateOverride: 0.01,
        liquiditySol: 0,
      });
      expect(m.feeToLiquidity).toBeUndefined();
      expect(m.volumeToLiq).toBeUndefined();
    });

    it('liquidity 음수 → undefined', () => {
      const m = computeGlobalFeeMetrics({
        rollingVolume5mSol: 100,
        liquiditySol: -10,
      });
      expect(m.feeToLiquidity).toBeUndefined();
    });

    it('marketCap > 0 → feeToMcap', () => {
      const m = computeGlobalFeeMetrics({
        rollingVolume5mSol: 100,
        venueFeeRateOverride: 0.01,
        marketCapSol: 1000,
      });
      expect(m.feeToMcap).toBeCloseTo(0.001, 6);  // 1 / 1000
    });

    it('tokenAge > 0 → feeVelocity', () => {
      const m = computeGlobalFeeMetrics({
        rollingVolume5mSol: 100,
        venueFeeRateOverride: 0.01,
        tokenAgeMinutes: 10,
      });
      expect(m.feeVelocity).toBeCloseTo(0.1, 4);  // 1 / 10
    });

    it('venueFeeRateOverride 가 venue 보다 우선', () => {
      const m = computeGlobalFeeMetrics({
        rollingVolume5mSol: 100,
        venue: 'pumpfun_bonding',  // 1%
        venueFeeRateOverride: 0.005,  // 0.5% override
      });
      expect(m.estimatedGlobalFees5mSol).toBeCloseTo(0.5, 4);
    });
  });

  describe('computeFeeRiskFlags', () => {
    it('feeToLiquidity 0.06 (>0.05 default) → FEE_TO_LIQUIDITY_HIGH', () => {
      const flags = computeFeeRiskFlags({ feeToLiquidity: 0.06 });
      expect(flags).toContain('FEE_TO_LIQUIDITY_HIGH');
    });

    it('volumeToLiq 6 (>5 default = 600% in 5min, wash trading 의심) → VOLUME_TO_LIQ_HIGH', () => {
      const flags = computeFeeRiskFlags({ volumeToLiq: 6 });
      expect(flags).toContain('VOLUME_TO_LIQ_HIGH');
    });

    it('feeToMcap 0.02 → FEE_TO_MCAP_HIGH', () => {
      const flags = computeFeeRiskFlags({ feeToMcap: 0.02 });
      expect(flags).toContain('FEE_TO_MCAP_HIGH');
    });

    it('정상 범위 → flag 0', () => {
      const flags = computeFeeRiskFlags({
        feeToLiquidity: 0.01, feeToMcap: 0.001, feeVelocity: 0.001, volumeToLiq: 1,
      });
      expect(flags).toHaveLength(0);
    });

    it('threshold custom override', () => {
      const flags = computeFeeRiskFlags(
        { feeToLiquidity: 0.03 },
        { ...DEFAULT_FEE_THRESHOLDS, feeToLiquidityHigh: 0.02 },
      );
      expect(flags).toContain('FEE_TO_LIQUIDITY_HIGH');
    });
  });
});
