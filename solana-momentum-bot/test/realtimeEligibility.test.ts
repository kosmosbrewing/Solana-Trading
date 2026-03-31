import {
  detectRealtimeDiscoveryMismatch,
  detectRealtimePoolProgramMismatch,
  METEORA_DLMM_PROGRAM,
  RAYDIUM_V4_PROGRAM,
  selectRealtimeEligiblePair,
} from '../src/realtime';
import { SOL_MINT } from '../src/utils/constants';

describe('detectRealtimeDiscoveryMismatch', () => {
  it('allows Meteora SOL quote pairs after realtime onboarding', () => {
    expect(detectRealtimeDiscoveryMismatch({
      dexId: 'meteora',
      quoteTokenAddress: 'So11111111111111111111111111111111111111112',
    })).toBeNull();
  });

  it('flags non-SOL quote pairs before realtime onboarding', () => {
    expect(detectRealtimeDiscoveryMismatch({
      dexId: 'raydium',
      quoteTokenAddress: 'usdcmint',
    })).toBe('non_sol_quote');
  });

  it('allows supported SOL quote pairs', () => {
    expect(detectRealtimeDiscoveryMismatch({
      dexId: 'raydium',
      quoteTokenAddress: 'So11111111111111111111111111111111111111112',
    })).toBeNull();
  });

  it('flags unsupported pool programs when dex is supported but owner is wrong', () => {
    expect(detectRealtimePoolProgramMismatch({
      dexId: 'raydium',
      poolOwner: '11111111111111111111111111111111',
    })).toBe('unsupported_pool_program');
  });

  it('allows supported pool programs when owner matches dex', () => {
    expect(detectRealtimePoolProgramMismatch({
      dexId: 'raydium',
      poolOwner: RAYDIUM_V4_PROGRAM,
    })).toBeNull();
  });

  it('accepts Meteora pool programs when owner matches the normalized dex', () => {
    expect(detectRealtimePoolProgramMismatch({
      dexId: 'meteora-dlmm',
      poolOwner: METEORA_DLMM_PROGRAM,
    })).toBeNull();
  });
});

describe('selectRealtimeEligiblePair', () => {
  it('chooses the highest-liquidity supported SOL pair', () => {
    const result = selectRealtimeEligiblePair([
      {
        dexId: 'raydium',
        pairAddress: 'pair-low',
        quoteToken: { address: SOL_MINT },
        liquidity: { usd: 100_000 },
      },
      {
        dexId: 'raydium',
        pairAddress: 'pair-high',
        quoteToken: { address: SOL_MINT },
        liquidity: { usd: 250_000 },
      },
    ]);

    expect(result.eligible).toBe(true);
    expect(result.pair?.pairAddress).toBe('pair-high');
  });

  it('returns unsupported_dex when all pairs are unsupported', () => {
    const result = selectRealtimeEligiblePair([
      {
        dexId: 'lifinity',
        pairAddress: 'pair-unsupported',
        quoteToken: { address: SOL_MINT },
        liquidity: { usd: 100_000 },
      },
    ]);

    expect(result).toEqual({
      eligible: false,
      reason: 'unsupported_dex',
    });
  });

  it('returns non_sol_quote when no SOL quote pair exists', () => {
    const result = selectRealtimeEligiblePair([
      {
        dexId: 'raydium',
        pairAddress: 'pair-usdc',
        quoteToken: { address: 'usdcmint' },
        liquidity: { usd: 100_000 },
      },
    ]);

    expect(result).toEqual({
      eligible: false,
      reason: 'non_sol_quote',
    });
  });

  it('uses owner matching to pick a supported pool program', () => {
    const result = selectRealtimeEligiblePair(
      [
        {
          dexId: 'raydium',
          pairAddress: 'pair-bad-owner',
          quoteToken: { address: SOL_MINT },
          liquidity: { usd: 300_000 },
        },
        {
          dexId: 'raydium',
          pairAddress: 'pair-good-owner',
          quoteToken: { address: SOL_MINT },
          liquidity: { usd: 120_000 },
        },
      ],
      new Map([
        ['pair-bad-owner', '11111111111111111111111111111111'],
        ['pair-good-owner', RAYDIUM_V4_PROGRAM],
      ])
    );

    expect(result.eligible).toBe(true);
    expect(result.pair?.pairAddress).toBe('pair-good-owner');
  });

  it('normalizes pump swap aliases on the live selector path', () => {
    const result = selectRealtimeEligiblePair([
      {
        dexId: 'pumpfun',
        pairAddress: 'pair-pump',
        quoteToken: { address: SOL_MINT },
        liquidity: { usd: 75_000 },
      },
    ]);

    expect(result.eligible).toBe(true);
    expect(result.pair?.pairAddress).toBe('pair-pump');
  });

  it('normalizes Meteora aliases on the live selector path', () => {
    const result = selectRealtimeEligiblePair([
      {
        dexId: 'meteora-dlmm',
        pairAddress: 'pair-meteora',
        quoteToken: { address: SOL_MINT },
        liquidity: { usd: 90_000 },
      },
    ]);

    expect(result.eligible).toBe(true);
    expect(result.pair?.pairAddress).toBe('pair-meteora');
  });
});
