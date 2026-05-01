/**
 * Holder Distribution 단위 테스트 (2026-05-01, Decu Phase B.2).
 */
import {
  computeHolderDistribution,
  computeHolderRiskFlags,
  detectTopHolderOverlap,
  DEFAULT_HOLDER_THRESHOLDS,
} from '../src/observability/holderDistribution';

describe('holderDistribution', () => {
  describe('computeHolderDistribution', () => {
    it('빈 입력 → sampleSize 0', () => {
      const m = computeHolderDistribution([], 1000);
      expect(m.sampleSize).toBe(0);
      expect(m.top1HolderPct).toBeUndefined();
    });

    it('total 0 (음수 amount) → sampleSize 만 반환', () => {
      const m = computeHolderDistribution([{ amount: 0 }, { amount: 0 }], 0);
      expect(m.sampleSize).toBe(2);
      expect(m.top1HolderPct).toBeUndefined();
    });

    it('단일 holder + supply 동일 → top1 = 100%, HHI = 1', () => {
      const m = computeHolderDistribution([{ amount: 1000 }], 1000);
      expect(m.top1HolderPct).toBe(1);
      expect(m.holderHhi).toBe(1);
      expect(m.top10HolderPct).toBe(1);
      expect(m.sampleBased).toBe(false);
    });

    it('균등 5 holder × 20% (supply=500) → HHI = 0.2, top1 = 0.2', () => {
      const m = computeHolderDistribution(Array(5).fill(0).map(() => ({ amount: 100 })), 500);
      expect(m.top1HolderPct).toBeCloseTo(0.2, 4);
      expect(m.top5HolderPct).toBeCloseTo(1, 4);
      expect(m.holderHhi).toBeCloseTo(0.2, 4);
    });

    it('top1 50% + 나머지 균등 (supply=1000) → top1=0.5, HHI > 0.25', () => {
      const m = computeHolderDistribution([
        { amount: 500 }, { amount: 100 }, { amount: 100 }, { amount: 100 }, { amount: 100 }, { amount: 100 },
      ], 1000);
      expect(m.top1HolderPct).toBeCloseTo(0.5, 4);
      expect(m.holderHhi).toBeGreaterThan(0.25);
    });

    it('정렬 안 된 입력도 정확히 산출 (큰 holder 부터 자동 정렬)', () => {
      const m = computeHolderDistribution([
        { amount: 100 }, { amount: 500 }, { amount: 200 },
      ], 800);
      // top1=500/800=0.625
      expect(m.top1HolderPct).toBeCloseTo(0.625, 4);
    });

    // 2026-05-01 (codex F-B fix) regression: supply 가 sample 합계의 10x 일 때 top10HolderPct
    //   는 0.10 이어야 한다. 이전 sample-분모 코드는 1.0 (false HIGH flag) 산출.
    it('supply >> sample sum → 비율은 supply 기준', () => {
      const m = computeHolderDistribution(
        [{ amount: 100 }, { amount: 100 }, { amount: 100 }, { amount: 100 }, { amount: 100 }],
        5000, // sample 합계 500 의 10 배
      );
      expect(m.top10HolderPct).toBeCloseTo(0.10, 4);
      expect(m.top1HolderPct).toBeCloseTo(0.02, 4);
      // HHI 는 sample 안 분포 — 균등이라 1/n = 0.2
      expect(m.holderHhi).toBeCloseTo(0.20, 4);
      expect(m.sampleBased).toBe(false);
    });

    // legacy fallback: supply 미제공 시 sample 합계 분모 + sampleBased=true 마커
    it('supply 미제공 → fallback + sampleBased=true', () => {
      const m = computeHolderDistribution([{ amount: 1000 }, { amount: 1000 }]);
      expect(m.top1HolderPct).toBeCloseTo(0.5, 4);
      expect(m.sampleBased).toBe(true);
    });
  });

  describe('computeHolderRiskFlags', () => {
    it('top1 0.21 (>0.20 default) → HOLDER_TOP1_HIGH', () => {
      const flags = computeHolderRiskFlags({ top1HolderPct: 0.21, sampleSize: 1 });
      expect(flags).toContain('HOLDER_TOP1_HIGH');
    });

    it('top10 0.81 → HOLDER_TOP10_HIGH', () => {
      const flags = computeHolderRiskFlags({ top10HolderPct: 0.81, sampleSize: 10 });
      expect(flags).toContain('HOLDER_TOP10_HIGH');
    });

    it('HHI 0.30 → HOLDER_HHI_HIGH (default 0.25)', () => {
      const flags = computeHolderRiskFlags({ holderHhi: 0.30, sampleSize: 5 });
      expect(flags).toContain('HOLDER_HHI_HIGH');
    });

    it('정상 범위 (top1=0.10, top10=0.50, HHI=0.10) → flag 0', () => {
      const flags = computeHolderRiskFlags({
        top1HolderPct: 0.10, top10HolderPct: 0.50, holderHhi: 0.10, sampleSize: 5,
      });
      expect(flags).toHaveLength(0);
    });

    it('threshold custom override 동작', () => {
      const flags = computeHolderRiskFlags(
        { top1HolderPct: 0.15, sampleSize: 1 },
        { ...DEFAULT_HOLDER_THRESHOLDS, top1HighPct: 0.10 },
      );
      expect(flags).toContain('HOLDER_TOP1_HIGH');
    });
  });

  describe('detectTopHolderOverlap', () => {
    it('dev address 가 top10 안 → DEV_IN_TOP_HOLDER', () => {
      const flags = detectTopHolderOverlap(
        [{ amount: 1000, address: 'dev1' }, { amount: 500, address: 'user1' }],
        { devAddresses: new Set(['dev1']) },
      );
      expect(flags).toContain('DEV_IN_TOP_HOLDER');
    });

    it('pool address 가 top10 안 → LP_OR_POOL_IN_TOP_HOLDER', () => {
      const flags = detectTopHolderOverlap(
        [{ amount: 1000, address: 'poolA' }],
        { poolAddresses: new Set(['poolA']) },
      );
      expect(flags).toContain('LP_OR_POOL_IN_TOP_HOLDER');
    });

    it('overlap 없음 → flag 0', () => {
      const flags = detectTopHolderOverlap(
        [{ amount: 1000, address: 'user1' }],
        { devAddresses: new Set(['dev1']) },
      );
      expect(flags).toHaveLength(0);
    });
  });
});
