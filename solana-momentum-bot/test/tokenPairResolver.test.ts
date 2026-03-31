import { DexScreenerPair } from '../src/scanner/dexScreenerClient';
import { HeliusPoolRegistry } from '../src/scanner/heliusPoolRegistry';
import { CompositeTokenPairResolver } from '../src/scanner/tokenPairResolver';

describe('HeliusPoolRegistry', () => {
  it('returns highest-liquidity pair for a token from the internal registry', async () => {
    const registry = new HeliusPoolRegistry();
    registry.upsertPairs([
      makePair('pair-low', 'mint-1', 50_000, 10_000),
      makePair('pair-high', 'mint-1', 150_000, 5_000),
    ]);

    await expect(registry.getBestPoolAddress('mint-1')).resolves.toBe('pair-high');
    await expect(registry.getTokenPairs('mint-1')).resolves.toEqual([
      expect.objectContaining({ pairAddress: 'pair-high' }),
      expect.objectContaining({ pairAddress: 'pair-low' }),
    ]);
  });

  it('stores observed pair metadata by both base and quote token addresses', async () => {
    const registry = new HeliusPoolRegistry();
    registry.upsertObservedPair({
      pairAddress: 'pair-observed',
      dexId: 'raydium',
      baseTokenAddress: 'mint-1',
      baseTokenSymbol: 'TEST',
      quoteTokenAddress: 'So11111111111111111111111111111111111111112',
      quoteTokenSymbol: 'SOL',
      liquidityUsd: 42_000,
    });

    await expect(registry.getBestPoolAddress('mint-1')).resolves.toBe('pair-observed');
    await expect(registry.getBestPoolAddress('So11111111111111111111111111111111111111112'))
      .resolves.toBe('pair-observed');
  });
});

describe('CompositeTokenPairResolver', () => {
  it('does not call fallback when the primary registry already has pairs', async () => {
    const registry = new HeliusPoolRegistry();
    registry.upsertObservedPair({
      pairAddress: 'pair-observed',
      dexId: 'raydium',
      baseTokenAddress: 'mint-1',
      baseTokenSymbol: 'TEST',
      quoteTokenAddress: 'So11111111111111111111111111111111111111112',
      quoteTokenSymbol: 'SOL',
      liquidityUsd: 90_000,
      volume24hUsd: 15_000,
    });

    const fallback = {
      getTokenPairs: jest.fn().mockResolvedValue([
        makePair('pair-fallback', 'mint-1', 125_000, 7_000),
      ]),
    };

    const resolver = new CompositeTokenPairResolver(registry, fallback);
    await expect(resolver.getBestPoolAddress('mint-1')).resolves.toBe('pair-observed');
    expect(fallback.getTokenPairs).not.toHaveBeenCalled();
  });

  it('falls back to the secondary lookup when the primary registry misses', async () => {
    const primary = {
      getTokenPairs: jest.fn().mockResolvedValue([]),
    };

    const fallback = {
      getTokenPairs: jest.fn().mockResolvedValue([
        makePair('pair-fallback', 'mint-1', 125_000, 7_000),
      ]),
    };

    const resolver = new CompositeTokenPairResolver(primary, fallback);
    await expect(resolver.getBestPoolAddress('mint-1')).resolves.toBe('pair-fallback');
    await expect(resolver.getTokenPairs('mint-1')).resolves.toEqual([
      expect.objectContaining({ pairAddress: 'pair-fallback' }),
    ]);
  });
});

function makePair(
  pairAddress: string,
  tokenAddress: string,
  liquidityUsd: number,
  volume24h: number
): DexScreenerPair {
  return {
    chainId: 'solana',
    dexId: 'raydium',
    pairAddress,
    baseToken: { address: tokenAddress, name: 'Test', symbol: 'TEST' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' },
    priceUsd: 1,
    liquidity: { usd: liquidityUsd, base: 1000, quote: 1000 },
    volume: { h24: volume24h },
    priceChange: {},
    txns: { h24: { buys: 10, sells: 5 } },
    marketCap: 1_000_000,
    pairCreatedAt: Date.now(),
  };
}
