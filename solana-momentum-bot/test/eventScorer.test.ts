import { AttentionScorer } from '../src/event/eventScorer';
import { TrendingEventCandidate } from '../src/event/types';

function buildCandidate(overrides: Partial<TrendingEventCandidate> = {}): TrendingEventCandidate {
  return {
    address: 'Mint111111111111111111111111111111111111111',
    symbol: 'TEST',
    name: 'Test Token',
    rank: 2,
    price: 0.42,
    priceChange24hPct: 88,
    volume24hUsd: 1_250_000,
    liquidityUsd: 320_000,
    marketCap: 4_500_000,
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    source: 'token_trending',
    raw: {},
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('AttentionScorer', () => {
  const scorer = new AttentionScorer({
    expiryMinutes: 180,
    minLiquidityUsd: 25_000,
  });

  it('assigns a high score to strong, fresh trending tokens', () => {
    const score = scorer.score(buildCandidate());

    expect(score.attentionScore).toBeGreaterThanOrEqual(70);
    expect(score.confidence).toBe('high');
    expect(score.components.narrativeStrength).toBeGreaterThanOrEqual(20);
    expect(score.tokenSymbol).toBe('TEST');
  });

  it('downgrades stale or weak candidates', () => {
    const score = scorer.score(buildCandidate({
      rank: 25,
      priceChange24hPct: 4,
      volume24hUsd: 8_000,
      liquidityUsd: 3_000,
      marketCap: 40_000,
      updatedAt: new Date(Date.now() - 8 * 60 * 60_000).toISOString(),
    }));

    expect(score.attentionScore).toBeLessThan(40);
    expect(score.confidence).toBe('low');
    expect(score.components.timing).toBeLessThanOrEqual(3);
  });

  it('clamps scores within documented component ranges', () => {
    const score = scorer.score(buildCandidate({
      rank: 1,
      priceChange24hPct: 500,
      volume24hUsd: 9_999_999,
      liquidityUsd: 9_999_999,
      marketCap: 99_999_999,
    }));

    expect(score.components.narrativeStrength).toBeLessThanOrEqual(30);
    expect(score.components.sourceQuality).toBeLessThanOrEqual(20);
    expect(score.components.timing).toBeLessThanOrEqual(20);
    expect(score.components.tokenSpecificity).toBeLessThanOrEqual(15);
    expect(score.components.historicalPattern).toBeLessThanOrEqual(15);
    expect(score.attentionScore).toBeLessThanOrEqual(100);
  });

  it('uses discovery source labels in narrative and sources', () => {
    const score = scorer.score(buildCandidate({
      raw: {
        discovery_source: 'internal_activity',
      },
    }));

    expect(score.sources).toEqual(['internal_activity']);
    expect(score.narrative).toContain('internal_activity rank');
  });
});
