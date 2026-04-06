import { ScannerEngine, WatchlistEntry } from '../src/scanner/scannerEngine';

// Why: idle eviction 로직만 단위 테스트 — scanner 내부 watchlist 직접 조작

function makeMinimalConfig(overrides: Record<string, unknown> = {}) {
  return {
    geckoClient: { getTrendingTokens: jest.fn().mockResolvedValue([]) } as never,
    dexScreenerClient: null,
    maxWatchlistSize: 20,
    minWatchlistScore: 0,
    trendingPollIntervalMs: 3_600_000,
    geckoNewPoolIntervalMs: 3_600_000,
    dexDiscoveryIntervalMs: 3_600_000,
    dexEnrichIntervalMs: 3_600_000,
    laneAMinAgeSec: 3600,
    laneBMaxAgeSec: 1200,
    minLiquidityUsd: 1000,
    minimumResidencyMs: 180_000,
    ...overrides,
  };
}

function injectEntry(scanner: ScannerEngine, partial: Partial<WatchlistEntry> & { tokenMint: string }) {
  const entry: WatchlistEntry = {
    pairAddress: partial.pairAddress ?? partial.tokenMint,
    symbol: partial.symbol ?? 'TEST',
    discoverySource: partial.discoverySource ?? 'gecko_trending',
    lane: partial.lane ?? 'A',
    watchlistScore: partial.watchlistScore ?? {
      totalScore: 50,
      grade: 'C' as const,
      components: { trendingScore: 10, marketingScore: 0, volumeScore: 10, liquidityScore: 10, momentumScore: 10, volMcapScore: 10 },
    },
    addedAt: partial.addedAt ?? new Date(),
    lastActivityAt: partial.lastActivityAt,
    lastUpdatedAt: partial.lastUpdatedAt ?? new Date(),
    tokenMint: partial.tokenMint,
  };
  // Why: private watchlist 접근 — 테스트 전용
  (scanner as unknown as { watchlist: Map<string, WatchlistEntry> }).watchlist.set(entry.tokenMint, entry);
}

describe('ScannerEngine idle eviction', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('evicts entries idle beyond threshold', () => {
    const scanner = new ScannerEngine(makeMinimalConfig({
      idleEvictionMs: 600_000,
      minimumResidencyMs: 0,
    }));

    // addedAt 11분 전 → idle 초과
    injectEntry(scanner, {
      tokenMint: 'idle-mint',
      addedAt: new Date(Date.now() - 660_000),
    });

    const evicted: Array<{ mint: string; reason?: string }> = [];
    scanner.on('candidateEvicted', (mint: string, reason?: string) => evicted.push({ mint, reason }));

    const count = scanner.evictIdlePairs();
    expect(count).toBe(1);
    expect(evicted).toEqual([{ mint: 'idle-mint', reason: 'idle' }]);
    expect(scanner.getWatchlist()).toHaveLength(0);
  });

  it('respects residency protection', () => {
    const scanner = new ScannerEngine(makeMinimalConfig({
      idleEvictionMs: 600_000,
      minimumResidencyMs: 180_000,
    }));

    // addedAt 방금 → residency 보호
    injectEntry(scanner, {
      tokenMint: 'fresh-mint',
      addedAt: new Date(),
    });

    const count = scanner.evictIdlePairs();
    expect(count).toBe(0);
    expect(scanner.getWatchlist()).toHaveLength(1);
  });

  it('updateActivity resets idle clock', () => {
    const scanner = new ScannerEngine(makeMinimalConfig({
      idleEvictionMs: 600_000,
      minimumResidencyMs: 0,
    }));

    // addedAt 15분 전이지만 lastActivityAt 방금
    injectEntry(scanner, {
      tokenMint: 'active-mint',
      addedAt: new Date(Date.now() - 900_000),
    });

    scanner.updateActivity('active-mint');

    const count = scanner.evictIdlePairs();
    expect(count).toBe(0);
    expect(scanner.getWatchlist()).toHaveLength(1);
  });

  it('exempts manual entries from idle eviction', () => {
    const scanner = new ScannerEngine(makeMinimalConfig({
      idleEvictionMs: 600_000,
      minimumResidencyMs: 0,
    }));

    injectEntry(scanner, {
      tokenMint: 'manual-mint',
      discoverySource: 'manual',
      addedAt: new Date(Date.now() - 1_200_000),
    });

    const count = scanner.evictIdlePairs();
    expect(count).toBe(0);
    expect(scanner.getWatchlist()).toHaveLength(1);
  });

  it('does nothing when idleEvictionMs is 0 (disabled)', () => {
    const scanner = new ScannerEngine(makeMinimalConfig({
      idleEvictionMs: 0,
      minimumResidencyMs: 0,
    }));

    injectEntry(scanner, {
      tokenMint: 'old-mint',
      addedAt: new Date(Date.now() - 1_200_000),
    });

    const count = scanner.evictIdlePairs();
    expect(count).toBe(0);
    expect(scanner.getWatchlist()).toHaveLength(1);
  });
});
