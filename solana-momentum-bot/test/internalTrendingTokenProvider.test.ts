import { InternalCandleSource } from '../src/candle/internalCandleSource';
import { HeliusPoolRegistry } from '../src/scanner/heliusPoolRegistry';
import { InternalTrendingTokenProvider } from '../src/discovery/internalTrendingTokenProvider';
import type { Candle } from '../src/utils/types';

describe('InternalTrendingTokenProvider', () => {
  it('builds ranked internal activity candidates from registry pairs and candles', async () => {
    const registry = new HeliusPoolRegistry();
    registry.upsertObservedPair({
      pairAddress: 'pair-hot',
      dexId: 'raydium',
      baseTokenAddress: 'mint-hot',
      baseTokenSymbol: 'HOT',
      quoteTokenAddress: 'So11111111111111111111111111111111111111112',
      quoteTokenSymbol: 'SOL',
      liquidityUsd: 120_000,
      volume24hUsd: 300_000,
      marketCap: 900_000,
    });
    registry.upsertObservedPair({
      pairAddress: 'pair-calm',
      dexId: 'meteora',
      baseTokenAddress: 'mint-calm',
      baseTokenSymbol: 'CALM',
      quoteTokenAddress: 'So11111111111111111111111111111111111111112',
      quoteTokenSymbol: 'SOL',
      liquidityUsd: 90_000,
      volume24hUsd: 100_000,
      marketCap: 400_000,
    });

    const candleStore = {
      getRecentCandles: jest.fn(async (pairAddress: string) => {
        if (pairAddress === 'pair-hot') {
          return buildCandles(pairAddress, [
            [1.0, 1.1, 2_000, 12],
            [1.1, 1.2, 2_500, 15],
            [1.2, 1.4, 3_000, 18],
          ]);
        }
        return buildCandles(pairAddress, [
          [1.0, 1.01, 200, 2],
          [1.01, 1.0, 150, 1],
          [1.0, 1.02, 220, 3],
        ]);
      }),
      getCandlesInRange: jest.fn(),
    };

    const source = new InternalCandleSource(candleStore as never);
    const provider = new InternalTrendingTokenProvider(registry, source, {
      intervalSec: 300,
      lookbackBars: 3,
      maxCandidateAgeMs: 10 * 60_000,
    });

    const tokens = await provider.getTrendingTokens(10);

    expect(tokens.map((token) => token.address)).toEqual(['mint-hot', 'mint-calm']);
    expect(tokens[0]).toMatchObject({
      symbol: 'HOT',
      rank: 1,
      source: 'token_trending',
      raw: expect.objectContaining({
        discovery_source: 'internal_activity',
        pair_address: 'pair-hot',
      }),
    });
  });
});

function buildCandles(
  pairAddress: string,
  rows: Array<[number, number, number, number]>
): Candle[] {
  const startMs = Date.now() - rows.length * 5 * 60_000;
  return rows.map(([open, close, volume, tradeCount], index) => ({
    pairAddress,
    timestamp: new Date(startMs + index * 5 * 60_000),
    intervalSec: 300,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume,
    buyVolume: volume * 0.6,
    sellVolume: volume * 0.4,
    tradeCount,
  }));
}
