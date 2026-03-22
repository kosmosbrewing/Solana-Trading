import { SOL_MINT } from '../src/utils/constants';
import { PUMP_SWAP_PROGRAM, selectRealtimeEligiblePair } from '../src/realtime';

function makePair(overrides: Record<string, unknown> = {}) {
  return {
    dexId: 'raydium',
    pairAddress: 'pair-1',
    baseToken: { address: 'token-1', symbol: 'AAA' },
    quoteToken: { address: SOL_MINT, symbol: 'SOL' },
    liquidity: { usd: 1000 },
    ...overrides,
  };
}

describe('selectRealtimeEligiblePair', () => {
  it('returns the highest-liquidity supported SOL-quote pair', () => {
    const result = selectRealtimeEligiblePair([
      makePair({ pairAddress: 'pair-low', liquidity: { usd: 100 } }),
      makePair({ pairAddress: 'pair-high', liquidity: { usd: 5000 } }),
      makePair({ pairAddress: 'pair-unsupported', dexId: 'meteora', liquidity: { usd: 10000 } }),
    ]);

    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
    expect(result.pair?.pairAddress).toBe('pair-high');
  });

  it('rejects pairs when no supported dex is available', () => {
    const result = selectRealtimeEligiblePair([
      makePair({ dexId: 'meteora' }),
    ]);

    expect(result).toEqual({
      eligible: false,
      reason: 'unsupported_dex',
    });
  });

  it('rejects pairs when supported dex exists but quote token is not SOL', () => {
    const result = selectRealtimeEligiblePair([
      makePair({
        quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' },
      }),
    ]);

    expect(result).toEqual({
      eligible: false,
      reason: 'non_sol_quote',
    });
  });

  it('prefers the highest-liquidity pair whose owner matches the supported program', () => {
    const result = selectRealtimeEligiblePair([
      makePair({ pairAddress: 'pair-v4', liquidity: { usd: 1000 } }),
      makePair({ pairAddress: 'pair-bad-owner', liquidity: { usd: 5000 } }),
    ], new Map([
      ['pair-v4', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'],
      ['pair-bad-owner', 'HVi6VyyLvTtFTA8f8atavxVjUKi8WjmnydfKgoZKzt7H'],
    ]));

    expect(result.eligible).toBe(true);
    expect(result.pair?.pairAddress).toBe('pair-v4');
  });

  it('rejects pairs when all supported dex candidates have unsupported pool owners', () => {
    const result = selectRealtimeEligiblePair([
      makePair({ pairAddress: 'pair-1' }),
      makePair({ pairAddress: 'pair-2', dexId: 'orca' }),
    ], new Map([
      ['pair-1', 'HVi6VyyLvTtFTA8f8atavxVjUKi8WjmnydfKgoZKzt7H'],
      ['pair-2', '11111111111111111111111111111111'],
    ]));

    expect(result).toEqual({
      eligible: false,
      reason: 'unsupported_pool_program',
    });
  });

  it('normalizes PumpSwap dex aliases and accepts supported pool owners', () => {
    const result = selectRealtimeEligiblePair([
      makePair({
        dexId: 'pumpfun',
        pairAddress: 'pair-pump',
      }),
    ], new Map([
      ['pair-pump', PUMP_SWAP_PROGRAM],
    ]));

    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
    expect(result.pair?.pairAddress).toBe('pair-pump');
    expect(result.pair?.dexId).toBe('pumpswap');
  });
});
