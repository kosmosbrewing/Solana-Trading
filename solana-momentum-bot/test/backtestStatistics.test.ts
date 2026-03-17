import { bootstrapMeanCI, permutationTestPValue } from '../src/backtest/statistics';

function makeDeterministicRandom(seed = 123456789): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('backtest statistics', () => {
  it('returns a degenerate bootstrap interval for a constant sample', () => {
    const ci = bootstrapMeanCI([2, 2, 2, 2], {
      nResamples: 100,
      random: makeDeterministicRandom(),
    });

    expect(ci.mean).toBe(2);
    expect(ci.lower).toBe(2);
    expect(ci.upper).toBe(2);
  });

  it('returns zero bootstrap interval for an empty sample', () => {
    expect(bootstrapMeanCI([])).toEqual({ mean: 0, lower: 0, upper: 0 });
  });

  it('reports high p-value for identical samples', () => {
    const pValue = permutationTestPValue([1, 2, 3], [1, 2, 3], {
      nPermutations: 500,
      alternative: 'two-sided',
      random: makeDeterministicRandom(),
    });

    expect(pValue).toBe(1);
  });

  it('reports low p-value for clearly separated samples', () => {
    const pValue = permutationTestPValue([0.2, 0.22, 0.21, 0.19], [-0.1, -0.12, -0.08, -0.11], {
      nPermutations: 5000,
      alternative: 'greater',
      random: makeDeterministicRandom(),
    });

    expect(pValue).toBeLessThan(0.05);
  });
});
