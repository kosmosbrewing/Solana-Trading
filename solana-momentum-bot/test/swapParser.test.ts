import {
  parseSwapFromTransaction,
  shouldFallbackToTransaction,
  tryParseSwapFromLogs,
} from '../src/realtime';

describe('swapParser', () => {
  it('parses swap data directly from structured logs', () => {
    const parsed = tryParseSwapFromLogs([
      'Program log: side=buy',
      'Program log: base_amount=1250',
      'Program log: quote_amount=2.5',
      'Program log: price_native=0.002',
    ], {
      poolAddress: 'pool-1',
      signature: 'sig-1',
      slot: 123,
      timestamp: 1_700_000_000,
    });

    expect(parsed).toMatchObject({
      pool: 'pool-1',
      signature: 'sig-1',
      side: 'buy',
      priceNative: 0.002,
      amountBase: 1250,
      amountQuote: 2.5,
      slot: 123,
      source: 'logs',
    });
  });

  it('parses Raydium ray_log with pool metadata into native amounts', () => {
    const parsed = tryParseSwapFromLogs([
      'Program routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS invoke [1]',
      'Program log: process_swap_base_in_with_user_account:RouteSwapBaseInArgs { amount_in: 125113437, minimum_amount_out: 19211303 }',
      'Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [2]',
      'Program log: ray_log: A10UdQcAAAAAAAAAAAAAAAABAAAAAAAAAF0UdQcAAAAAPMW5qT8jAAAithFHTyEAAAgn3wcAAAAA',
      'Program log: 125113437 -> 132065032',
    ], {
      poolAddress: 'pool-1',
      signature: 'sig-ray',
      slot: 321,
      timestamp: 1_700_000_001,
      poolMetadata: {
        dexId: 'raydium',
        baseMint: 'mint-base',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 6,
        quoteDecimals: 9,
        poolProgram: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      },
    });

    expect(parsed).toMatchObject({
      pool: 'pool-1',
      signature: 'sig-ray',
      side: 'buy',
      amountBase: 132.065032,
      amountQuote: 0.125113437,
      slot: 321,
      dexProgram: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      source: 'logs',
    });
    expect(parsed?.priceNative).toBeCloseTo(0.125113437 / 132.065032, 12);
  });

  it('parses Raydium CLMM SwapEvent logs when the subscribed pool is CLMM-owned', () => {
    const parsed = tryParseSwapFromLogs([
      'Program routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS invoke [1]',
      'Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK invoke [2]',
      'Program data: QMbN6CYIceIRTG6ayGJiNpKyNY9MROK+tKCwgbHboOh8/E9rRpdDcwW65ZV/SLUO2S2vbsX63ybBtLOmL5LEaCA7mh5uT9ek0VZbZxxyIigu4YZQSRZo8RRF/FZtXASzQyAeS5qL6pfzztUdz9T3u5NyCBh9HAEDj5F9R0xV5gd7qNQbv6jbHQgn3wcAAAAAAAAAAAAAAAAtGigBAAAAAAAAAAAAAAAAAW+SjP701ydiAAAAAAAAAACsqGOvry4AAAAAAAAAAAAAGrX//w==',
      'Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK success',
    ], {
      poolAddress: '2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2',
      signature: 'sig-clmm',
      slot: 654,
      timestamp: 1_700_000_002,
      poolMetadata: {
        dexId: 'raydium',
        baseMint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 6,
        quoteDecimals: 9,
        poolProgram: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
      },
    });

    expect(parsed).toMatchObject({
      pool: '2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2',
      signature: 'sig-clmm',
      side: 'buy',
      amountBase: 19.405357,
      amountQuote: 0.132065032,
      slot: 654,
      dexProgram: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
      source: 'logs',
    });
    expect(parsed?.priceNative).toBeCloseTo(0.132065032 / 19.405357, 12);
  });

  it('falls back to token and lamport deltas when parsing from a transaction', () => {
    const parsed = parseSwapFromTransaction({
      blockTime: 1_700_000_100,
      meta: {
        err: null,
        fee: 5_000,
        innerInstructions: [],
        loadedAddresses: { readonly: [], writable: [] },
        logMessages: ['Program log: swap'],
        postBalances: [900_000_000, 0],
        postTokenBalances: [{
          accountIndex: 1,
          mint: 'mint-1',
          owner: 'owner-1',
          programId: 'token-program',
          uiTokenAmount: { amount: '1500', decimals: 3, uiAmount: 1.5, uiAmountString: '1.5' },
        }],
        preBalances: [1_000_000_000, 0],
        preTokenBalances: [{
          accountIndex: 1,
          mint: 'mint-1',
          owner: 'owner-1',
          programId: 'token-program',
          uiTokenAmount: { amount: '0', decimals: 3, uiAmount: 0, uiAmountString: '0' },
        }],
        rewards: [],
        status: { Ok: null },
      },
      slot: 1,
      transaction: {
        message: {
          accountKeys: [],
          instructions: [],
          recentBlockhash: 'hash',
        },
        signatures: ['sig-2'],
      },
    } as any, {
      poolAddress: 'pool-1',
      signature: 'sig-2',
      slot: 456,
    });

    expect(parsed).toMatchObject({
      pool: 'pool-1',
      signature: 'sig-2',
      side: 'buy',
      amountBase: 1.5,
      amountQuote: 0.1,
      priceNative: 0.1 / 1.5,
      slot: 456,
      source: 'transaction',
    });
  });

  it('marks router and explicit swap logs as fallback candidates', () => {
    expect(shouldFallbackToTransaction([
      'Program routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS invoke [1]',
      'Program log: process_swap_base_in_with_user_account:RouteSwapBaseInArgs { amount_in: 100 }',
    ])).toBe(true);

    expect(shouldFallbackToTransaction([
      'Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [2]',
      'Program log: ray_log: AAAA',
    ])).toBe(true);
  });

  it('skips opaque logs that do not look like swaps', () => {
    expect(shouldFallbackToTransaction([
      'Program HVi6VyyLvTtFTA8f8atavxVjUKi8WjmnydfKgoZKzt7H invoke [1]',
      'Program HVi6VyyLvTtFTA8f8atavxVjUKi8WjmnydfKgoZKzt7H success',
    ])).toBe(false);
  });
});
