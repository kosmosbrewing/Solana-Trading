/**
 * Block 2 (2026-04-18): DEX ID alias normalization coverage expansion.
 * DexScreener 가 같은 AMM 을 다양한 태그로 반환 → 이전엔 `unsupported_dex` 로 100% 차단.
 * 확장된 alias 집합이 `pumpswap`/`raydium`/`orca`/`meteora` 로 정상 수렴하는지 검증.
 */
import {
  selectRealtimeEligiblePair,
  detectRealtimeDiscoveryMismatch,
  SUPPORTED_REALTIME_DEX_IDS,
} from '../src/realtime/realtimeEligibility';
import { SOL_MINT } from '../src/utils/constants';

const basePair = {
  pairAddress: 'Pair1',
  baseToken: { address: 'TOKEN', symbol: 'T' },
  quoteToken: { address: SOL_MINT, symbol: 'SOL' },
  liquidity: { usd: 10_000 },
};

describe('DEX ID alias normalization (Block 2)', () => {
  describe('PumpSwap aliases', () => {
    const pumpswapVariants = [
      'pumpswap',
      'pumpfun',
      'pump-swap',
      'pump.fun',
      'pump_swap',
      'pumpdotfun',
      'pumpswap-amm',
      'pumpfun-amm',
      'PUMP.FUN',
      'PumpSwap',
    ];
    for (const variant of pumpswapVariants) {
      it(`accepts '${variant}'`, () => {
        const result = selectRealtimeEligiblePair([{ ...basePair, dexId: variant }]);
        expect(result.eligible).toBe(true);
        expect(result.pair?.dexId).toBe('pumpswap');
      });
    }
  });

  describe('Meteora aliases', () => {
    const meteoraVariants = [
      'meteora',
      'meteora-dlmm',
      'meteora-damm-v1',
      'meteora-damm-v2',
      'meteoradbc',
      'meteora-dbc',
      'meteora_dlmm',
      'dlmm',
      'damm-v1',
      'damm-v2',
      'damm_v1',
    ];
    for (const variant of meteoraVariants) {
      it(`accepts '${variant}'`, () => {
        const result = selectRealtimeEligiblePair([{ ...basePair, dexId: variant }]);
        expect(result.eligible).toBe(true);
        expect(result.pair?.dexId).toBe('meteora');
      });
    }
  });

  describe('Raydium aliases', () => {
    const raydiumVariants = [
      'raydium',
      'raydium-v4',
      'raydium_v4',
      'raydium-clmm',
      'raydium-cpmm',
      'raydium-launchpad',
      'raydium-launchlab',
      'raydium-amm',
    ];
    for (const variant of raydiumVariants) {
      it(`accepts '${variant}'`, () => {
        const result = selectRealtimeEligiblePair([{ ...basePair, dexId: variant }]);
        expect(result.eligible).toBe(true);
        expect(result.pair?.dexId).toBe('raydium');
      });
    }
  });

  describe('Orca aliases', () => {
    const orcaVariants = ['orca', 'orca-whirlpool', 'orca_whirlpool', 'whirlpool'];
    for (const variant of orcaVariants) {
      it(`accepts '${variant}'`, () => {
        const result = selectRealtimeEligiblePair([{ ...basePair, dexId: variant }]);
        expect(result.eligible).toBe(true);
        expect(result.pair?.dexId).toBe('orca');
      });
    }
  });

  describe('unknown DEX still rejected (security)', () => {
    // 2026-04-18 QA fix: overly-generic aliases `pump`, `damm` removed from accept list.
    // They should now be rejected as unsupported_dex.
    const unknownVariants = ['phoenix', 'lifinity', 'saber', 'solfi', 'random-dex', 'pump', 'damm'];
    for (const variant of unknownVariants) {
      it(`rejects '${variant}' as unsupported_dex`, () => {
        const result = selectRealtimeEligiblePair([{ ...basePair, dexId: variant }]);
        expect(result.eligible).toBe(false);
        expect(result.reason).toBe('unsupported_dex');
      });
    }
  });

  describe('discovery mismatch detection', () => {
    it('passes known alias through normalize', () => {
      expect(detectRealtimeDiscoveryMismatch({ dexId: 'pump.fun', quoteTokenAddress: SOL_MINT })).toBeNull();
      expect(detectRealtimeDiscoveryMismatch({ dexId: 'raydium-launchpad', quoteTokenAddress: SOL_MINT })).toBeNull();
    });

    it('flags still-unsupported DEX', () => {
      expect(detectRealtimeDiscoveryMismatch({ dexId: 'phoenix', quoteTokenAddress: SOL_MINT })).toBe('unsupported_dex');
    });

    it('flags non-SOL quote even on supported DEX', () => {
      expect(
        detectRealtimeDiscoveryMismatch({ dexId: 'pumpswap', quoteTokenAddress: 'USDC...' })
      ).toBe('non_sol_quote');
    });
  });

  it('canonical set is minimal (4 entries — post-normalize 결과만)', () => {
    // 2026-04-18 Block 2 QA fix: canonical set 은 normalize 결과와 정확히 일치.
    expect([...SUPPORTED_REALTIME_DEX_IDS].sort()).toEqual(['meteora', 'orca', 'pumpswap', 'raydium']);
  });
});
