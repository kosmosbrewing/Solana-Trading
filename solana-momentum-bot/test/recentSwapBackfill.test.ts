import { ParsedTransactionWithMeta } from '@solana/web3.js';
import { fetchRecentSwapsForPool } from '../src/realtime';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const RAYDIUM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const QUOTE_MINT = 'mint-quote';

function makeParsedTransaction(
  signature: string,
  blockTime: number,
  amountBaseRaw: string,
  amountQuoteRaw: string
): ParsedTransactionWithMeta {
  const amountBase = Number(amountBaseRaw) / 1_000_000;
  const amountQuote = Number(amountQuoteRaw) / 1_000_000;

  return {
    blockTime,
    meta: {
      err: null,
      fee: 5000,
      innerInstructions: [],
      loadedAddresses: { readonly: [], writable: [] },
      logMessages: ['Program log: swap'],
      postBalances: [1_000_000_000, 0],
      postTokenBalances: [{
        accountIndex: 1,
        mint: 'mint-base',
        owner: 'owner-1',
        programId: 'token-program',
        uiTokenAmount: {
          amount: amountBaseRaw,
          decimals: 6,
          uiAmount: amountBase,
          uiAmountString: `${amountBase}`,
        },
      }, {
        accountIndex: 2,
        mint: QUOTE_MINT,
        owner: 'owner-1',
        programId: 'token-program',
        uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
      }],
      preBalances: [1_000_000_000, 0],
      preTokenBalances: [{
        accountIndex: 1,
        mint: 'mint-base',
        owner: 'owner-1',
        programId: 'token-program',
        uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
      }, {
        accountIndex: 2,
        mint: QUOTE_MINT,
        owner: 'owner-1',
        programId: 'token-program',
        uiTokenAmount: {
          amount: amountQuoteRaw,
          decimals: 6,
          uiAmount: amountQuote,
          uiAmountString: `${amountQuote}`,
        },
      }],
      rewards: [],
      status: { Ok: null },
    },
    slot: blockTime,
    transaction: {
      message: {
        accountKeys: [],
        instructions: [],
        recentBlockhash: 'hash',
      },
      signatures: [signature],
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe('fetchRecentSwapsForPool', () => {
  it('returns parsed recent swaps oldest-first', async () => {
    const txBySignature = new Map([
      ['sig-new', makeParsedTransaction('sig-new', 200, '2500000', '150000')],
      ['sig-old', makeParsedTransaction('sig-old', 100, '1500000', '100000')],
    ]);

    const swaps = await fetchRecentSwapsForPool({
      getSignaturesForAddress: async () => [
        { signature: 'sig-new', slot: 200, blockTime: 200 },
        { signature: 'sig-old', slot: 100, blockTime: 100 },
      ],
      getParsedTransactions: async (signatures) =>
        signatures.map((signature) => txBySignature.get(signature) ?? null),
      getParsedTransaction: async (signature) => txBySignature.get(signature) ?? null,
    }, SOL_MINT, {
      dexId: 'raydium',
      baseMint: 'mint-base',
      quoteMint: QUOTE_MINT,
      baseDecimals: 6,
      quoteDecimals: 6,
      poolProgram: RAYDIUM_V4_PROGRAM,
    }, {
      lookbackSec: 150,
      nowSec: 220,
    });

    expect(swaps).toHaveLength(2);
    expect(swaps.map((swap) => swap.signature)).toEqual(['sig-old', 'sig-new']);
    expect(swaps[0]).toMatchObject({
      side: 'buy',
      amountBase: 1.5,
      amountQuote: 0.1,
    });
    expect(swaps[1]).toMatchObject({
      side: 'buy',
      amountBase: 2.5,
      amountQuote: 0.15,
    });
  });

  it('filters signatures outside the lookback window', async () => {
    const swaps = await fetchRecentSwapsForPool({
      getSignaturesForAddress: async () => [
        { signature: 'sig-too-old', slot: 50, blockTime: 50 },
      ],
      getParsedTransactions: async () => [],
      getParsedTransaction: async () => null,
    }, SOL_MINT, {
      dexId: 'raydium',
      baseMint: 'mint-base',
      quoteMint: QUOTE_MINT,
      baseDecimals: 6,
      quoteDecimals: 6,
      poolProgram: RAYDIUM_V4_PROGRAM,
    }, {
      lookbackSec: 30,
      nowSec: 200,
    });

    expect(swaps).toEqual([]);
  });
});
