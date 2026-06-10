import { buildKolCandleCoverageTarget } from '../src/realtime/kolCandleCoverageResolver';
import { PUMP_SWAP_PROGRAM } from '../src/realtime/pumpSwapParser';
import { PUMP_FUN_BONDING_CURVE_PROGRAM } from '../src/realtime/migrationEventDetector';
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
  it('uses explicit KOL tx pool evidence first when the program is WS-supported', () => {
    const target = buildKolCandleCoverageTarget({
      tokenMint: TOKEN,
      poolAddress: POOL,
      dexId: 'pumpswap',
      dexProgram: PUMP_SWAP_PROGRAM,
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

  it('skips kol_tx_pool when the program is not WS-parseable (zero-candle slot 방지)', () => {
    // pump.fun bonding curve — 추출은 되지만 WS candle parser 미지원 → 직행 구독 금지.
    const blocked = buildKolCandleCoverageTarget({
      tokenMint: TOKEN,
      poolAddress: POOL,
      dexId: 'pumpfun',
      dexProgram: PUMP_FUN_BONDING_CURVE_PROGRAM,
      contexts: [],
    });
    expect(blocked).toBeNull();

    // dexProgram 미상이면 (provenance 없는 pool 주소) 동일하게 직행 금지 — fallback 경로 사용.
    const unknownProgram = buildKolCandleCoverageTarget({
      tokenMint: TOKEN,
      poolAddress: POOL,
      dexId: 'pumpswap',
      contexts: [],
      resolvedPair: pair(),
    });
    expect(unknownProgram).toMatchObject({ pairSource: 'token_pair_resolver' });
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
