import bs58 from 'bs58';
import {
  isLikelyPumpSwapFallbackLog,
  METEORA_DLMM_PROGRAM,
  parseSwapFromTransaction,
  PUMP_SWAP_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  shouldForceFallbackToTransaction,
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

  it('parses direct PumpSwap instructions from a transaction when pool metadata is present', () => {
    const buyInstructionData = encodePumpInstruction(
      [102, 6, 61, 18, 1, 218, 235, 234],
      1_250_000n,
      250_000_000n,
    );
    const parsed = parseSwapFromTransaction({
      blockTime: 1_700_000_200,
      meta: {
        err: null,
        fee: 5_000,
        innerInstructions: [],
        loadedAddresses: { readonly: [], writable: [] },
        logMessages: ['Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]'],
        postBalances: [],
        postTokenBalances: [],
        preBalances: [],
        preTokenBalances: [],
        rewards: [],
        status: { Ok: null },
      },
      slot: 999,
      transaction: {
        message: {
          accountKeys: [],
          instructions: [{
            programId: { toBase58: () => PUMP_SWAP_PROGRAM },
            accounts: [
              { toBase58: () => 'pool-pump' },
              { toBase58: () => 'user-1' },
            ],
            data: buyInstructionData,
          }],
          recentBlockhash: 'hash',
        },
        signatures: ['sig-pump'],
      },
    } as any, {
      poolAddress: 'pool-pump',
      signature: 'sig-pump',
      slot: 999,
      poolMetadata: {
        dexId: 'pumpswap',
        baseMint: 'mint-base',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 6,
        quoteDecimals: 9,
        poolProgram: PUMP_SWAP_PROGRAM,
      },
    });

    expect(parsed).toMatchObject({
      pool: 'pool-pump',
      signature: 'sig-pump',
      side: 'buy',
      amountBase: 1.25,
      amountQuote: 0.25,
      slot: 999,
      dexProgram: PUMP_SWAP_PROGRAM,
      source: 'transaction',
    });
    expect(parsed?.priceNative).toBeCloseTo(0.2, 12);
  });

  it('skips PumpSwap log parsing to force transaction fallback', () => {
    const parsed = tryParseSwapFromLogs([
      'Program log: buy',
      'Program log: base_amount_out=21.108798',
      'Program log: quote_amount_in=498.64046463',
    ], {
      poolAddress: 'pool-pump',
      signature: 'sig-pump-log',
      slot: 1_001,
      timestamp: 1_700_000_201,
      poolMetadata: {
        dexId: 'pumpswap',
        baseMint: 'mint-base',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 6,
        quoteDecimals: 9,
        poolProgram: PUMP_SWAP_PROGRAM,
      },
    });

    expect(parsed).toBeNull();
  });

  it('forces fallback for PumpSwap pools even when logs are opaque', () => {
    expect(shouldForceFallbackToTransaction({
      dexId: 'pumpswap',
      baseMint: 'mint-base',
      quoteMint: 'So11111111111111111111111111111111111111112',
      poolProgram: PUMP_SWAP_PROGRAM,
    })).toBe(true);
  });

  it('forces transaction fallback for Raydium CPMM pools', () => {
    expect(shouldForceFallbackToTransaction({
      dexId: 'raydium',
      baseMint: 'mint-base',
      quoteMint: 'So11111111111111111111111111111111111111112',
      poolProgram: RAYDIUM_CPMM_PROGRAM,
    })).toBe(true);
  });

  it('forces transaction fallback for Meteora pools', () => {
    expect(shouldForceFallbackToTransaction({
      dexId: 'meteora',
      baseMint: 'mint-base',
      quoteMint: 'So11111111111111111111111111111111111111112',
      poolProgram: METEORA_DLMM_PROGRAM,
    })).toBe(true);
  });

  it('identifies likely PumpSwap fallback logs and skips noisy ones', () => {
    expect(isLikelyPumpSwapFallbackLog([
      'Program ComputeBudget111111111111111111111111111111 invoke [1]',
      'Program FsU1rcaEC361jBr9JE5wm7bpWRSTYeAMN4R2MCs11rNF invoke [1]',
      'Program log: pi: 1, sbps: -121, asbps: -121, cbbps: 75, d: 0',
    ])).toBe(true);

    expect(isLikelyPumpSwapFallbackLog([
      'Program 11111111111111111111111111111111 invoke [1]',
      'Program PrntZBCXvR3VPW1cG8kxqASXCnQhmJpP6FEe3r4sA5g invoke [1]',
      'Program log: No arbitrage...',
    ])).toBe(false);
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

  it('does not use generic log parsing when pool metadata is present but specialized parsing fails', () => {
    const parsed = tryParseSwapFromLogs([
      'Program log: side=buy',
      'Program log: base_amount=4472054486131',
      'Program log: quote_amount=3086451325',
    ], {
      poolAddress: 'pool-1',
      signature: 'sig-meta-log',
      slot: 999,
      timestamp: 1_700_000_300,
      poolMetadata: {
        dexId: 'raydium',
        baseMint: 'mint-base',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 6,
        quoteDecimals: 9,
        poolProgram: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      },
    });

    expect(parsed).toBeNull();
  });

  it('does not use heuristic transaction parsing when pool metadata is present but mint deltas do not match', () => {
    const parsed = parseSwapFromTransaction({
      blockTime: 1_700_000_400,
      meta: {
        err: null,
        fee: 5_000,
        innerInstructions: [],
        loadedAddresses: { readonly: [], writable: [] },
        logMessages: ['Program log: swap'],
        postBalances: [900_000_000, 0],
        postTokenBalances: [{
          accountIndex: 1,
          mint: 'other-mint',
          owner: 'owner-1',
          programId: 'token-program',
          uiTokenAmount: { amount: '1500', decimals: 3, uiAmount: 1.5, uiAmountString: '1.5' },
        }],
        preBalances: [1_000_000_000, 0],
        preTokenBalances: [{
          accountIndex: 1,
          mint: 'other-mint',
          owner: 'owner-1',
          programId: 'token-program',
          uiTokenAmount: { amount: '0', decimals: 3, uiAmount: 0, uiAmountString: '0' },
        }],
        rewards: [],
        status: { Ok: null },
      },
      slot: 2,
      transaction: {
        message: {
          accountKeys: [],
          instructions: [],
          recentBlockhash: 'hash',
        },
        signatures: ['sig-meta-tx'],
      },
    } as any, {
      poolAddress: 'pool-1',
      signature: 'sig-meta-tx',
      slot: 999,
      poolMetadata: {
        dexId: 'raydium',
        baseMint: 'mint-base',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 6,
        quoteDecimals: 9,
        poolProgram: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      },
    });

    expect(parsed).toBeNull();
  });

  it('uses raw token amounts to avoid float dust false positives with pool metadata', () => {
    const parsed = parseSwapFromTransaction({
      blockTime: 1_700_000_500,
      meta: {
        err: null,
        fee: 5_000,
        innerInstructions: [],
        loadedAddresses: { readonly: [], writable: [] },
        logMessages: ['Program log: swap'],
        postBalances: [],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: 'mint-base',
            owner: 'owner-1',
            programId: 'token-program',
            uiTokenAmount: {
              amount: '10000000000000000',
              decimals: 9,
              uiAmount: 10000000,
              uiAmountString: '10000000',
            },
          },
          {
            accountIndex: 2,
            mint: 'mint-base',
            owner: 'owner-2',
            programId: 'token-program',
            uiTokenAmount: {
              amount: '2',
              decimals: 9,
              uiAmount: 0.000000002,
              uiAmountString: '0.000000002',
            },
          },
          {
            accountIndex: 3,
            mint: 'mint-quote',
            owner: 'owner-3',
            programId: 'token-program',
            uiTokenAmount: {
              amount: '750000000',
              decimals: 9,
              uiAmount: 0.75,
              uiAmountString: '0.75',
            },
          },
        ],
        preBalances: [],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: 'mint-base',
            owner: 'owner-1',
            programId: 'token-program',
            uiTokenAmount: {
              amount: '10000000000000001',
              decimals: 9,
              uiAmount: 10000000.000000002,
              uiAmountString: '10000000.000000001',
            },
          },
          {
            accountIndex: 2,
            mint: 'mint-base',
            owner: 'owner-2',
            programId: 'token-program',
            uiTokenAmount: {
              amount: '1',
              decimals: 9,
              uiAmount: 0.000000001,
              uiAmountString: '0.000000001',
            },
          },
          {
            accountIndex: 3,
            mint: 'mint-quote',
            owner: 'owner-3',
            programId: 'token-program',
            uiTokenAmount: {
              amount: '1000000000',
              decimals: 9,
              uiAmount: 1,
              uiAmountString: '1',
            },
          },
        ],
        rewards: [],
        status: { Ok: null },
      },
      slot: 3,
      transaction: {
        message: {
          accountKeys: [],
          instructions: [],
          recentBlockhash: 'hash',
        },
        signatures: ['sig-raw-delta'],
      },
    } as any, {
      poolAddress: 'pool-1',
      signature: 'sig-raw-delta',
      slot: 1_000,
      poolMetadata: {
        dexId: 'raydium',
        baseMint: 'mint-base',
        quoteMint: 'mint-quote',
        baseDecimals: 9,
        quoteDecimals: 9,
        poolProgram: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      },
    });

    expect(parsed).toBeNull();
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

function encodePumpInstruction(discriminator: number[], first: bigint, second: bigint): string {
  const buffer = Buffer.alloc(24);
  Buffer.from(discriminator).copy(buffer, 0);
  buffer.writeBigUInt64LE(first, 8);
  buffer.writeBigUInt64LE(second, 16);
  return bs58.encode(buffer);
}
