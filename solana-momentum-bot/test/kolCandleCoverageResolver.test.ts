import { buildKolCandleCoverageTarget } from '../src/realtime/kolCandleCoverageResolver';
import { SOL_MINT } from '../src/utils/constants';
import type { DexScreenerPair } from '../src/scanner/dexScreenerClient';

const TOKEN = 'Token111111111111111111111111111111111111111';
const POOL = 'Pool1111111111111111111111111111111111111111';

function pair(overrides: Partial<DexScreenerPair> = {}): DexScreenerPair {
  return {
    chainId: 'solana',
    dexId: 'pumpswap',
    pairAddress: POOL,
    baseToken: { address: TOKEN, name: 'Token', symbol: 'TKN' },
    quoteToken: { address: SOL_MINT, name: 'Solana', symbol: 'SOL' },
    priceUsd: 0,
    liquidity: { usd: 100_000, base: 0, quote: 0 },
    volume: {},
    priceChange: {},
    txns: {},
    ...overrides,
  };
}

describe('kolCandleCoverageResolver', () => {
  it('uses explicit KOL tx pool evidence first', () => {
    const target = buildKolCandleCoverageTarget({
      tokenMint: TOKEN,
      poolAddress: POOL,
      dexId: 'pumpswap',
      inputMint: SOL_MINT,
      outputMint: TOKEN,
      contexts: [],
    });

    expect(target).toMatchObject({
      subscriptionPair: POOL,
      pairSource: 'kol_tx_pool',
      metadata: {
        dexId: 'pumpswap',
        baseMint: TOKEN,
        quoteMint: SOL_MINT,
      },
    });
  });

  it('falls back to registry context when tx pool is absent', () => {
    const target = buildKolCandleCoverageTarget({
      tokenMint: TOKEN,
      contexts: [{
        tokenAddress: TOKEN,
        pairAddress: POOL,
        dexId: 'raydium',
        firstObservedAtMs: 1,
        lastObservedAtMs: 2,
      }],
    });

    expect(target).toMatchObject({
      subscriptionPair: POOL,
      pairSource: 'registry_context',
      metadata: {
        dexId: 'raydium',
        baseMint: TOKEN,
        quoteMint: SOL_MINT,
      },
    });
  });

  it('uses token pair resolver output when no direct or registry evidence exists', () => {
    const target = buildKolCandleCoverageTarget({
      tokenMint: TOKEN,
      contexts: [],
      resolvedPair: pair(),
    });

    expect(target).toMatchObject({
      subscriptionPair: POOL,
      pairSource: 'token_pair_resolver',
      metadata: {
        dexId: 'pumpswap',
        baseMint: TOKEN,
        quoteMint: SOL_MINT,
      },
    });
  });

  it('returns null when no pool evidence exists', () => {
    const target = buildKolCandleCoverageTarget({
      tokenMint: TOKEN,
      contexts: [],
    });

    expect(target).toBeNull();
  });
});
