/**
 * Lane Edge Statistics tests — Kelly Controller P1 (2026-04-26)
 *
 * Mathematical correctness 검증 (Wilson LCB / bootstrap p10 / Kelly).
 */
import {
  wilsonLowerBound,
  bootstrapRewardRiskP10,
  conservativeKelly,
  rawKelly,
  mean,
  median,
  maxStreak,
  logGrowth,
} from '../src/risk/paper/laneEdgeStatistics';

describe('wilsonLowerBound', () => {
  it('n=0 → 0', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it('100% wins, n=10 → ≈0.72 (Wilson 95% LCB)', () => {
    const lcb = wilsonLowerBound(10, 10);
    expect(lcb).toBeGreaterThan(0.7);
    expect(lcb).toBeLessThan(0.74);
  });

  it('50% wins, n=100 → ≈0.40 LCB (Normal approx 와 ~동일)', () => {
    const lcb = wilsonLowerBound(50, 100);
    expect(lcb).toBeGreaterThan(0.39);
    expect(lcb).toBeLessThan(0.41);
  });

  it('표본 작을수록 LCB 가 winRate 보다 훨씬 낮음', () => {
    const lcbSmall = wilsonLowerBound(8, 10);
    const lcbLarge = wilsonLowerBound(80, 100);
    // Both 80% raw
    expect(lcbSmall).toBeLessThan(lcbLarge);
  });

  it('0% wins → 0', () => {
    expect(wilsonLowerBound(0, 100)).toBe(0);
  });

  it('99% z-score 사용 시 LCB 가 더 낮음', () => {
    const lcb95 = wilsonLowerBound(50, 100, 1.96);
    const lcb99 = wilsonLowerBound(50, 100, 2.58);
    expect(lcb99).toBeLessThan(lcb95);
  });

  it('잘못된 입력 (wins > n) → 0', () => {
    expect(wilsonLowerBound(15, 10)).toBe(0);
    expect(wilsonLowerBound(-1, 10)).toBe(0);
  });
});

describe('bootstrapRewardRiskP10', () => {
  it('빈 입력 → 0', () => {
    expect(bootstrapRewardRiskP10([], [])).toBe(0);
    expect(bootstrapRewardRiskP10([1, 2], [])).toBe(0);
    expect(bootstrapRewardRiskP10([], [1, 2])).toBe(0);
  });

  it('deterministic — 같은 seed → 같은 결과', () => {
    const wins = [0.01, 0.02, 0.03, 0.04];
    const losses = [0.01, 0.005, 0.015];
    const a = bootstrapRewardRiskP10(wins, losses, 500, 42);
    const b = bootstrapRewardRiskP10(wins, losses, 500, 42);
    expect(a).toBe(b);
  });

  it('clear winner cohort → p10 > 1', () => {
    const wins = [0.05, 0.05, 0.05, 0.05]; // mean = 0.05
    const losses = [0.01, 0.01, 0.01, 0.01]; // mean = 0.01
    const p10 = bootstrapRewardRiskP10(wins, losses, 1000, 42);
    expect(p10).toBeGreaterThan(2.5); // RR ≈ 5, p10 보수적
  });

  it('clear loser cohort → p10 < 1', () => {
    const wins = [0.005, 0.005];
    const losses = [0.05, 0.05];
    const p10 = bootstrapRewardRiskP10(wins, losses, 1000, 42);
    expect(p10).toBeLessThan(0.5);
  });
});

describe('rawKelly', () => {
  it('p=0.6, RR=2 → 0.6 - 0.4/2 = 0.4', () => {
    expect(rawKelly(0.6, 2)).toBeCloseTo(0.4, 4);
  });
  it('p=0.5, RR=1 → 0', () => {
    expect(rawKelly(0.5, 1)).toBe(0);
  });
  it('p=0 → 0', () => {
    expect(rawKelly(0, 5)).toBe(0);
  });
  it('RR=0 → 0', () => {
    expect(rawKelly(0.5, 0)).toBe(0);
  });
});

describe('conservativeKelly', () => {
  it('보수적 입력 (LCB 낮음 + p10 RR 낮음) → 0', () => {
    expect(conservativeKelly(0.4, 0.5)).toBe(0); // 0.4 - 0.6/0.5 = -0.8 → 0
  });
  it('LCB > 0.5 + RR p10 > 1 → 양수 Kelly', () => {
    const k = conservativeKelly(0.6, 2);
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThanOrEqual(1);
  });
  it('Kelly 결과 항상 [0, 1] clamp', () => {
    expect(conservativeKelly(0.99, 100)).toBeLessThanOrEqual(1);
    expect(conservativeKelly(0.01, 0.01)).toBe(0);
  });
});

describe('aggregation helpers', () => {
  it('mean / median', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
  });

  it('maxStreak — 연속 true 최대 길이', () => {
    expect(maxStreak([1, -1, -1, -1, 1, -1, -1], (x) => x < 0)).toBe(3);
    expect(maxStreak([1, 1, 1], (x) => x < 0)).toBe(0);
    expect(maxStreak([], (x) => x < 0)).toBe(0);
  });

  it('logGrowth', () => {
    expect(logGrowth(1, Math.E)).toBeCloseTo(1, 4);
    expect(logGrowth(2, 1)).toBeCloseTo(Math.log(0.5), 4);
    expect(logGrowth(0, 1)).toBe(0);
    expect(logGrowth(1, 0)).toBe(-Infinity);
  });
});
