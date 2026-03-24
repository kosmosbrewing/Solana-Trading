import { EventEmitter } from 'events';
import { attachScannerFreshListingSource, mapScannerFreshEntry } from '../src/scanner/listingSourceAdapter';

describe('scanner listing source adapter', () => {
  it('maps fresh scanner entries into generic listing candidates', () => {
    const candidate = mapScannerFreshEntry({
      tokenMint: 'mint-1',
      pairAddress: 'pair-1',
      symbol: 'TEST',
      discoverySource: 'dex_boost',
      lane: 'B',
      watchlistScore: {
        totalScore: 42,
        grade: 'C',
        components: {
          trendingScore: 0,
          marketingScore: 0,
          volumeScore: 15,
          liquidityScore: 12,
          momentumScore: 15,
        },
      },
      poolInfo: {
        pairAddress: 'pair-1',
        tokenMint: 'mint-1',
        tvl: 25_000,
        dailyVolume: 120_000,
        tradeCount24h: 20,
        spreadPct: 0.01,
        tokenAgeHours: 0.5,
        top10HolderPct: 0.2,
        lpBurned: null,
        ownershipRenounced: null,
        rankScore: 42,
      },
      addedAt: new Date('2026-03-24T00:00:00.000Z'),
      lastPriceUsd: 0.012,
      lastUpdatedAt: new Date('2026-03-24T00:01:00.000Z'),
    });

    expect(candidate).toMatchObject({
      address: 'mint-1',
      symbol: 'TEST',
      price: 0.012,
      liquidity: 25_000,
      source: 'scanner_dex_boost',
    });
    expect(candidate.raw).toMatchObject({
      discoverySource: 'dex_boost',
    });
  });

  it('forwards only lane B candidates', async () => {
    const scanner = new EventEmitter() as EventEmitter & { on: EventEmitter['on'] };
    const received: Array<{ address: string; source: string }> = [];

    attachScannerFreshListingSource(scanner as never, async (candidate) => {
      received.push({ address: candidate.address, source: candidate.source });
    });

    scanner.emit('candidateDiscovered', {
      tokenMint: 'mint-a',
      pairAddress: 'pair-a',
      symbol: 'A',
      discoverySource: 'gecko_trending',
      lane: 'A',
      watchlistScore: { totalScore: 10, grade: 'C', components: { trendingScore: 0, marketingScore: 0, volumeScore: 0, liquidityScore: 0, momentumScore: 10 } },
      addedAt: new Date(),
      lastUpdatedAt: new Date(),
    });
    scanner.emit('candidateDiscovered', {
      tokenMint: 'mint-b',
      pairAddress: 'pair-b',
      symbol: 'B',
      discoverySource: 'dex_token_profile',
      lane: 'B',
      watchlistScore: { totalScore: 20, grade: 'C', components: { trendingScore: 0, marketingScore: 0, volumeScore: 5, liquidityScore: 5, momentumScore: 10 } },
      addedAt: new Date(),
      lastUpdatedAt: new Date(),
    });
    await new Promise(resolve => setImmediate(resolve));

    expect(received).toEqual([{ address: 'mint-b', source: 'scanner_dex_token_profile' }]);
  });
});
