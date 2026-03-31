import {
  extractObservedPoolCandidate,
  looksLikePoolInitLogs,
  RAYDIUM_CPMM_PROGRAM,
} from '../src/realtime';
import { SOL_MINT } from '../src/utils/constants';

describe('looksLikePoolInitLogs', () => {
  it('matches explicit pool initialization logs', () => {
    expect(looksLikePoolInitLogs([
      'Program log: Instruction: Initialize',
      'Program log: create pool',
    ])).toBe(true);
  });

  it('ignores swap logs', () => {
    expect(looksLikePoolInitLogs([
      'Program log: Instruction: Swap',
      'Program log: ray_log: abc123',
    ])).toBe(false);
  });
});

describe('extractObservedPoolCandidate', () => {
  it('extracts SOL quote pool metadata from a parsed pool init transaction', () => {
    const candidate = extractObservedPoolCandidate(
      {
        blockTime: 1_711_111_111,
        meta: {
          preTokenBalances: [],
          postTokenBalances: [
            { accountIndex: 4, mint: 'base-mint' },
            { accountIndex: 5, mint: SOL_MINT },
          ],
        },
        transaction: {
          message: {
            accountKeys: [
              { pubkey: 'payer', signer: true, writable: true },
              { pubkey: 'pool-address', signer: false, writable: true },
              { pubkey: 'vault-base', signer: false, writable: true },
              { pubkey: 'vault-quote', signer: false, writable: true },
              { pubkey: 'base-mint', signer: false, writable: false },
              { pubkey: SOL_MINT, signer: false, writable: false },
            ],
          },
        },
      } as any,
      RAYDIUM_CPMM_PROGRAM,
      new Map([
        ['pool-address', RAYDIUM_CPMM_PROGRAM],
        ['vault-base', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
        ['vault-quote', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
      ])
    );

    expect(candidate).toEqual({
      pairAddress: 'pool-address',
      dexId: 'raydium',
      baseTokenAddress: 'base-mint',
      quoteTokenAddress: SOL_MINT,
      quoteTokenSymbol: 'SOL',
      pairCreatedAt: 1_711_111_111_000,
    });
  });

  it('returns null when no program-owned pool account is found', () => {
    const candidate = extractObservedPoolCandidate(
      {
        blockTime: 1_711_111_111,
        meta: {
          preTokenBalances: [],
          postTokenBalances: [
            { accountIndex: 1, mint: 'base-mint' },
            { accountIndex: 2, mint: SOL_MINT },
          ],
        },
        transaction: {
          message: {
            accountKeys: [
              { pubkey: 'payer', signer: true, writable: true },
              { pubkey: 'vault-base', signer: false, writable: true },
              { pubkey: 'vault-quote', signer: false, writable: true },
            ],
          },
        },
      } as any,
      RAYDIUM_CPMM_PROGRAM,
      new Map([
        ['vault-base', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
        ['vault-quote', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
      ])
    );

    expect(candidate).toBeNull();
  });
});
