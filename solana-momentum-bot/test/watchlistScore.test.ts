import { calcWatchlistScore, mergeWatchlistScore, WatchlistScoreInput, WatchlistScoreResult } from '../src/scanner/watchlistScore';

describe('calcVolMcapScore tiers', () => {
  const base: WatchlistScoreInput = {
    trendingRank: 1,
    volume24hUsd: 100_000,
    liquidityUsd: 100_000,
  };

  it.each([
    // [vol, mcap, expectedVolMcapScore]
    [6_600_000, 3_900_000, 15],   // BURNIE 169% → ≥1.5
    [2_100_000, 385_000, 15],     // Dunald 545% → ≥1.5
    [1_500_000, 228_000, 15],     // ELUN 658% → ≥1.5
    [500_000, 500_000, 10],       // 100% → ≥0.5
    [200_000, 1_000_000, 6],      // 20% → ≥0.2
    [100_000, 1_000_000, 3],      // 10% → ≥0.1
    [50_000, 1_000_000, 0],       // 5% → <0.1
    [100_000, 0, 0],              // zero mcap → 0
    [0, 100_000, 0],              // zero volume → 0
  ])('vol=%d mcap=%d → volMcapScore=%d', (vol, mcap, expected) => {
    const result = calcWatchlistScore({ ...base, volume24hUsd: vol, marketCap: mcap });
    expect(result.components.volMcapScore).toBe(expected);
  });

  it('no marketCap → volMcapScore=0', () => {
    const result = calcWatchlistScore({ ...base, marketCap: undefined });
    expect(result.components.volMcapScore).toBe(0);
  });
});

describe('volMcapScore affects watchlist ranking', () => {
  it('high vol/mcap token ranks above similar token without vol/mcap data', () => {
    const withoutMcap = calcWatchlistScore({
      trendingRank: 5,
      volume24hUsd: 500_000,
      liquidityUsd: 100_000,
    });
    const withHighRatio = calcWatchlistScore({
      trendingRank: 5,
      volume24hUsd: 500_000,
      liquidityUsd: 100_000,
      marketCap: 200_000, // ratio = 2.5 → 15점
    });

    expect(withHighRatio.totalScore).toBeGreaterThan(withoutMcap.totalScore);
    expect(withHighRatio.totalScore - withoutMcap.totalScore).toBe(15);
  });

  it('low vol/mcap ratio gives no ranking advantage', () => {
    const lowRatio = calcWatchlistScore({
      trendingRank: 5,
      volume24hUsd: 50_000,
      liquidityUsd: 100_000,
      marketCap: 1_000_000, // ratio = 0.05 → 0점
    });
    const noMcap = calcWatchlistScore({
      trendingRank: 5,
      volume24hUsd: 50_000,
      liquidityUsd: 100_000,
    });

    expect(lowRatio.totalScore).toBe(noMcap.totalScore);
  });

  it('promotes grade from B to A with sufficient vol/mcap ratio', () => {
    // trendingRank=3→30, vol 500K→20, liq 100K→9, momentum priceChange100%→8 = 67 → B
    const baseline = calcWatchlistScore({
      trendingRank: 3,
      volume24hUsd: 500_000,
      liquidityUsd: 100_000,
      priceChange24hPct: 100,
    });
    expect(baseline.totalScore).toBe(67);
    expect(baseline.grade).toBe('B');

    // +15 volMcap → 82 → A
    const promoted = calcWatchlistScore({
      trendingRank: 3,
      volume24hUsd: 500_000,
      liquidityUsd: 100_000,
      priceChange24hPct: 100,
      marketCap: 200_000, // ratio = 2.5 → 15점
    });
    expect(promoted.grade).toBe('A');
    expect(promoted.totalScore).toBe(baseline.totalScore + 15);
  });
});

describe('mergeWatchlistScore preserves existing components', () => {
  const existing: WatchlistScoreResult = {
    totalScore: 68,
    grade: 'B',
    components: {
      trendingScore: 24,    // from trendingRank=5
      marketingScore: 0,
      volumeScore: 20,      // 500K vol
      liquidityScore: 9,    // 100K liq
      momentumScore: 15,    // momentum + social
      volMcapScore: 0,
    },
  };

  it('preserves trending and momentum scores during enrichment', () => {
    const merged = mergeWatchlistScore(existing, {
      boostAmount: 500,
      hasPaidOrders: true,
      volume24hUsd: 500_000,
      liquidityUsd: 100_000,
      marketCap: 200_000,
    });

    // trending/momentum 보존
    expect(merged.components.trendingScore).toBe(24);
    expect(merged.components.momentumScore).toBe(15);
    // marketing 갱신 (8 paid + 7 boost500 = 15)
    expect(merged.components.marketingScore).toBe(15);
    // volMcap 신규 반영 (ratio=2.5 → 15)
    expect(merged.components.volMcapScore).toBe(15);
    // total = 24+15+20+9+15+15 = 98 → cap 98
    expect(merged.totalScore).toBe(98);
    expect(merged.grade).toBe('A');
  });

  it('marketing only increases, never decreases', () => {
    const withExistingMarketing: WatchlistScoreResult = {
      ...existing,
      components: { ...existing.components, marketingScore: 12 },
    };
    const merged = mergeWatchlistScore(withExistingMarketing, {
      boostAmount: 50, // 3점 only → 기존 12보다 낮음
      hasPaidOrders: false,
    });

    expect(merged.components.marketingScore).toBe(12); // 보존
  });

  it('preserves volMcapScore when marketCap not provided in enrichment', () => {
    const withVolMcap: WatchlistScoreResult = {
      ...existing,
      components: { ...existing.components, volMcapScore: 10 },
    };
    const merged = mergeWatchlistScore(withVolMcap, {
      boostAmount: 100,
      hasPaidOrders: true,
    });

    expect(merged.components.volMcapScore).toBe(10); // 기존 유지
  });

  it('updates volume and liquidity from enrichment poolInfo', () => {
    const merged = mergeWatchlistScore(existing, {
      volume24hUsd: 1_000_000,  // 25점 (기존 20)
      liquidityUsd: 500_000,    // 15점 (기존 9)
    });

    expect(merged.components.volumeScore).toBe(25);
    expect(merged.components.liquidityScore).toBe(15);
  });
});
