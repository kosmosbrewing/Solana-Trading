import { Keypair } from '@solana/web3.js';
import { walletExternalDeltaInternalsForTests } from '../src/risk/walletExternalDeltaClassifier';

const { classifyTx, buildSummary } = walletExternalDeltaInternalsForTests;

function makeParsedTx(input: {
  wallet: string;
  deltaLamports: number;
  feeLamports?: number;
  instructions?: unknown[];
  preTokenAmount?: number;
  postTokenAmount?: number;
}) {
  return {
    blockTime: 1_777_000_000,
    meta: {
      preBalances: [1_000_000_000],
      postBalances: [1_000_000_000 + input.deltaLamports],
      fee: input.feeLamports ?? 5_000,
      preTokenBalances: input.preTokenAmount == null ? [] : [{
        accountIndex: 1,
        mint: 'Mint111111111111111111111111111111111111111',
        owner: input.wallet,
        uiTokenAmount: { uiAmount: input.preTokenAmount, uiAmountString: String(input.preTokenAmount) },
      }],
      postTokenBalances: input.postTokenAmount == null ? [] : [{
        accountIndex: 1,
        mint: 'Mint111111111111111111111111111111111111111',
        owner: input.wallet,
        uiTokenAmount: { uiAmount: input.postTokenAmount, uiAmountString: String(input.postTokenAmount) },
      }],
      innerInstructions: [],
    },
    transaction: {
      message: {
        accountKeys: [{ pubkey: { toBase58: () => input.wallet } }],
        instructions: input.instructions ?? [],
      },
    },
  };
}

describe('walletExternalDeltaClassifier internals', () => {
  it('classifies SPL closeAccount credit as rent_reclaim', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const tx = makeParsedTx({
      wallet,
      deltaLamports: 2_039_280,
      instructions: [{
        program: 'spl-token',
        parsed: { type: 'closeAccount', info: { destination: wallet, owner: wallet } },
      }],
    });

    const classified = classifyTx(tx as any, 'rent-sig', wallet);

    expect(classified?.kind).toBe('rent_reclaim');
    expect(classified?.deltaSol).toBeCloseTo(0.00203928, 9);
  });

  it('does not treat manual transfer as safe adjustment', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const tx = makeParsedTx({
      wallet,
      deltaLamports: 50_000_000,
      instructions: [{
        program: 'system',
        parsed: { type: 'transfer', info: { source: Keypair.generate().publicKey.toBase58(), destination: wallet } },
      }],
    });
    const classified = classifyTx(tx as any, 'manual-in', wallet);
    const summary = buildSummary({
      walletName: 'main',
      walletAddress: wallet,
      windowStartMs: 1000,
      windowEndMs: 2000,
      rawDriftSol: 0.05,
      knownBotTxCount: 0,
      txs: classified ? [classified] : [],
    });

    expect(classified?.kind).toBe('manual_transfer_in');
    expect(summary.manualTransferInSol).toBeCloseTo(0.05, 9);
    expect(summary.safeAdjustmentSol).toBe(0);
  });

  it('marks non-ledger token balance changes as unlogged_bot_tx', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const tx = makeParsedTx({
      wallet,
      deltaLamports: 10_000_000,
      preTokenAmount: 10,
      postTokenAmount: 0,
    });

    const classified = classifyTx(tx as any, 'unlogged-sig', wallet);

    expect(classified?.kind).toBe('unlogged_bot_tx');
  });

  it('does not mark closeAccount with token balance change as safe rent reclaim', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const tx = makeParsedTx({
      wallet,
      deltaLamports: 10_000_000,
      preTokenAmount: 10,
      postTokenAmount: 0,
      instructions: [{
        program: 'spl-token',
        parsed: { type: 'closeAccount', info: { destination: wallet, owner: wallet } },
      }],
    });

    const classified = classifyTx(tx as any, 'unlogged-close-sig', wallet);

    expect(classified?.kind).toBe('unlogged_bot_tx');
  });
});
