import {
  computeSharpeMoments,
  sigmaSharpe,
  expectedMaxSr,
  computeDSR,
  computeCSCV,
  standardNormalCdf,
  inverseStandardNormalCdf,
} from '../scripts/dsr-validator';

// Deterministic LCG so PBO assertions are stable across machines.
function makeRng(seed = 42): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function gaussian(rng: () => number, mu = 0, sigma = 1): number {
  // Box-Muller; one draw per call (the second is discarded by design).
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

describe('standard normal helpers', () => {
  it('cdf(0) = 0.5 and bounds saturate at ±5σ', () => {
    expect(Math.abs(standardNormalCdf(0) - 0.5)).toBeLessThan(1e-6);
    expect(standardNormalCdf(5)).toBeGreaterThan(0.9999);
    expect(standardNormalCdf(-5)).toBeLessThan(0.0001);
  });

  it('inverse-cdf is the right inverse of cdf', () => {
    for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const z = inverseStandardNormalCdf(p);
      expect(Math.abs(standardNormalCdf(z) - p)).toBeLessThan(1e-3);
    }
  });
});

describe('computeSharpeMoments — degenerate cases', () => {
  it('returns zeros for an empty series', () => {
    const m = computeSharpeMoments([]);
    expect(m.count).toBe(0);
    expect(m.sharpeRatio).toBe(0);
  });

  it('returns SR=0 for a constant series (stdev=0)', () => {
    const m = computeSharpeMoments([0.05, 0.05, 0.05, 0.05]);
    expect(m.stdev).toBe(0);
    expect(m.sharpeRatio).toBe(0);
  });

  it('matches a hand-computed SR for a small symmetric series', () => {
    // returns = [-1, 1] → mean 0, stdev sqrt(2) → SR = 0
    const m = computeSharpeMoments([-1, 1]);
    expect(m.sharpeRatio).toBe(0);
  });

  it('recovers approximately the population SR for a Gaussian draw', () => {
    const rng = makeRng(7);
    const xs: number[] = [];
    for (let i = 0; i < 5000; i++) xs.push(gaussian(rng, 0.05, 0.5));
    const m = computeSharpeMoments(xs);
    // True SR = 0.05/0.5 = 0.1; allow ±0.03 sampling error
    expect(Math.abs(m.sharpeRatio - 0.1)).toBeLessThan(0.03);
    expect(Math.abs(m.skewness)).toBeLessThan(0.2);
    expect(Math.abs(m.kurtosis - 3)).toBeLessThan(0.4);
  });
});

describe('sigmaSharpe + expectedMaxSr', () => {
  it('σ(SR) ≈ 1/sqrt(T-1) for normal IID returns (γ3=0, γ4=3, SR=0)', () => {
    const moments = { count: 101, mean: 0, stdev: 1, skewness: 0, kurtosis: 3, sharpeRatio: 0 };
    expect(Math.abs(sigmaSharpe(moments) - Math.sqrt(1 / 100))).toBeLessThan(1e-9);
  });

  it('expectedMaxSr is 0 when N=1 (no multiple-testing penalty)', () => {
    expect(expectedMaxSr(1, 0.2)).toBe(0);
  });

  it('expectedMaxSr grows with N and with γ_SR', () => {
    const a = expectedMaxSr(10, 0.2);
    const b = expectedMaxSr(100, 0.2);
    const c = expectedMaxSr(100, 0.4);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});

describe('computeDSR', () => {
  it('flags a strong single-trial signal as PASS', () => {
    const rng = makeRng(11);
    const xs: number[] = [];
    for (let i = 0; i < 200; i++) xs.push(gaussian(rng, 0.04, 0.1)); // SR ~ 0.4
    const dsr = computeDSR(xs, [0.4]);
    expect(dsr.moments.count).toBe(200);
    expect(dsr.moments.sharpeRatio).toBeGreaterThan(0.2);
    expect(dsr.dsrProbability).toBeGreaterThan(0.95);
  });

  it('penalises a weak signal under heavy multiple-testing', () => {
    const rng = makeRng(23);
    const candidate: number[] = [];
    for (let i = 0; i < 100; i++) candidate.push(gaussian(rng, 0.005, 0.1)); // SR ~ 0.05
    // 20 fake competing trials with high SR dispersion
    const trialsSr = Array.from({ length: 20 }, (_, i) => 0.04 + 0.02 * (i - 10));
    const dsr = computeDSR(candidate, trialsSr, 20);
    expect(dsr.dsrProbability).toBeLessThan(0.95);
    expect(dsr.sr0).toBeGreaterThan(0);
  });

  it('handles T<2 by returning a non-throwing zero result', () => {
    const dsr = computeDSR([], [0]);
    expect(dsr.moments.sharpeRatio).toBe(0);
    expect(Number.isFinite(dsr.dsrProbability)).toBe(true);
  });

  it('handles all-zero returns without throwing', () => {
    const dsr = computeDSR([0, 0, 0, 0, 0], [0]);
    expect(dsr.moments.sharpeRatio).toBe(0);
    expect(dsr.dsrProbability).toBeLessThan(0.95);
  });
});

describe('computeCSCV', () => {
  it('returns a low PBO when one arm dominates uniformly across blocks', () => {
    const rng = makeRng(101);
    const blocks = 8; // smaller for test speed
    const T = blocks * 8; // 64 samples per arm
    const armA: number[] = [];
    const armB: number[] = [];
    const armC: number[] = [];
    for (let i = 0; i < T; i++) {
      armA.push(gaussian(rng, 0.05, 0.05)); // dominant
      armB.push(gaussian(rng, 0, 0.05));
      armC.push(gaussian(rng, -0.01, 0.05));
    }
    const r = computeCSCV([armA, armB, armC], { blocks });
    expect(r.partitions).toBeGreaterThan(0);
    expect(r.pbo).toBeLessThan(0.5);
    expect(r.meanOosRankFraction).toBeGreaterThan(0.5);
  });

  it('returns a high PBO when arms are noise-only (no real edge)', () => {
    const rng = makeRng(202);
    const blocks = 8;
    const T = blocks * 8;
    const arms: number[][] = [];
    for (let a = 0; a < 5; a++) {
      const arr: number[] = [];
      for (let i = 0; i < T; i++) arr.push(gaussian(rng, 0, 0.1));
      arms.push(arr);
    }
    const r = computeCSCV(arms, { blocks });
    expect(r.partitions).toBeGreaterThan(0);
    // With noise-only arms the in-sample winner is essentially random OOS.
    expect(r.pbo).toBeGreaterThan(0.3);
  });

  it('is a no-op when there are fewer than 2 arms', () => {
    const r = computeCSCV([[1, 2, 3]]);
    expect(r.partitions).toBe(0);
    expect(r.pbo).toBe(0);
  });

  it('rejects an odd block count', () => {
    expect(() => computeCSCV([[1], [1]], { blocks: 7 })).toThrow();
  });
});
