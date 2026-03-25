import {
  detectRealtimeDiscoveryMismatch,
  detectRealtimePoolProgramMismatch,
  RAYDIUM_V4_PROGRAM,
} from '../src/realtime';

describe('detectRealtimeDiscoveryMismatch', () => {
  it('flags unsupported dex ids before realtime onboarding', () => {
    expect(detectRealtimeDiscoveryMismatch({
      dexId: 'meteora',
      quoteTokenAddress: 'So11111111111111111111111111111111111111112',
    })).toBe('unsupported_dex');
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
});
