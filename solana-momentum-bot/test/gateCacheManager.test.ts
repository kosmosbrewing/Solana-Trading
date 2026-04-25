import { GateCacheManager, CachedGateResult } from '../src/gate/gateCacheManager';

const makeCacheResult = (overrides?: Partial<CachedGateResult>): CachedGateResult => ({
  tokenSecurityData: {
    isHoneypot: false,
    isFreezable: false,
    isMintable: false,
    hasTransferFee: false,
    freezeAuthorityPresent: false,
    top10HolderPct: 0.3,
    creatorPct: 0.05,
  },
  exitLiquidityData: {
    exitLiquidityUsd: 50_000,
    sellVolume24h: 10_000,
    buyVolume24h: 20_000,
    sellBuyRatio: 0.5,
  },
  ...overrides,
});

describe('GateCacheManager', () => {
  let cache: GateCacheManager;

  afterEach(() => {
    cache?.destroy();
  });

  it('should return null for missing keys', () => {
    cache = new GateCacheManager(30_000);
    expect(cache.get('unknown_token')).toBeNull();
    expect(cache.getStats().misses).toBe(1);
  });

  it('should return cached data after set', () => {
    cache = new GateCacheManager(30_000);
    const data = makeCacheResult();
    cache.set('TOKEN_A', data);

    const result = cache.get('TOKEN_A');
    expect(result).not.toBeNull();
    expect(result!.tokenSecurityData!.isHoneypot).toBe(false);
    expect(result!.exitLiquidityData!.exitLiquidityUsd).toBe(50_000);
    expect(cache.getStats().hits).toBe(1);
  });

  it('should return null after TTL expires', () => {
    // TTL = 50ms for fast test
    cache = new GateCacheManager(50);
    cache.set('TOKEN_B', makeCacheResult());

    // Immediate get → hit
    expect(cache.get('TOKEN_B')).not.toBeNull();

    // Wait for TTL to expire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cache.get('TOKEN_B')).toBeNull();
        expect(cache.getStats().misses).toBeGreaterThan(0);
        resolve();
      }, 100);
    });
  });

  it('should invalidate entries', () => {
    cache = new GateCacheManager(30_000);
    cache.set('TOKEN_C', makeCacheResult());
    expect(cache.get('TOKEN_C')).not.toBeNull();

    cache.invalidate('TOKEN_C');
    expect(cache.get('TOKEN_C')).toBeNull();
  });

  it('should prune expired entries', () => {
    // Phase 6 P2-6 (2026-04-25): prune 기준은 staleFallbackMs — fresh + stale 둘 다 짧게.
    cache = new GateCacheManager(50, 50);
    cache.set('TOKEN_D', makeCacheResult());
    cache.set('TOKEN_E', makeCacheResult());

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        cache.pruneExpired();
        expect(cache.getStats().size).toBe(0);
        resolve();
      }, 100);
    });
  });

  it('should track hit/miss stats correctly', () => {
    cache = new GateCacheManager(30_000);
    cache.set('TOKEN_F', makeCacheResult());

    cache.get('TOKEN_F'); // hit
    cache.get('TOKEN_F'); // hit
    cache.get('TOKEN_MISSING'); // miss

    const stats = cache.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
    expect(stats.hitRate).toBe('66.7%');
  });

  it('should handle null security data', () => {
    cache = new GateCacheManager(30_000);
    cache.set('TOKEN_G', makeCacheResult({
      tokenSecurityData: null,
      exitLiquidityData: null,
    }));

    const result = cache.get('TOKEN_G');
    expect(result).not.toBeNull();
    expect(result!.tokenSecurityData).toBeNull();
    expect(result!.exitLiquidityData).toBeNull();
  });

  // Phase 6 P2-6 (2026-04-25): stale fallback regression.
  it('getStaleFallback returns expired data within stale TTL window', async () => {
    cache = new GateCacheManager(50, 5_000); // fresh 50ms / stale 5s
    cache.set('TOKEN_STALE', makeCacheResult());
    await new Promise((r) => setTimeout(r, 100)); // expire fresh
    expect(cache.get('TOKEN_STALE')).toBeNull(); // fresh miss
    const stale = cache.getStaleFallback('TOKEN_STALE');
    expect(stale).not.toBeNull();
    expect(cache.getStats().staleFallbacks).toBe(1);
  });

  it('getStaleFallback returns null after stale TTL window', async () => {
    cache = new GateCacheManager(50, 100); // fresh 50ms / stale 100ms
    cache.set('TOKEN_GONE', makeCacheResult());
    await new Promise((r) => setTimeout(r, 200));
    expect(cache.getStaleFallback('TOKEN_GONE')).toBeNull();
  });
});
