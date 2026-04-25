/**
 * kolWalletTracker pure function tests (Option 5 Phase 1b)
 * Full WS subscription 은 integration test 범위 밖 — detectSwapFromWalletPerspective 만 단위.
 */
jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { detectSwapFromWalletPerspective } from '../src/ingester/kolWalletTracker';
import { SOL_MINT, LAMPORTS_PER_SOL } from '../src/utils/constants';

const WALLET = 'Wa11111111111111111111111111111111111111111';
const TOKEN_MINT = 'Tk11111111111111111111111111111111111111111';

// ParsedTransactionWithMeta 는 복잡한 타입 — 필요한 필드만 최소 mock
function mockTx(
  opts: {
    walletIdx: number;
    preSolLamports: number;
    postSolLamports: number;
    preTokens?: Array<{ owner: string; mint: string; uiAmount: number }>;
    postTokens?: Array<{ owner: string; mint: string; uiAmount: number }>;
    err?: unknown;
  }
): any {
  const accountKeys = new Array(opts.walletIdx + 1).fill(null).map((_, i) => ({
    pubkey: { toBase58: () => (i === opts.walletIdx ? WALLET : `other_${i}`) },
  }));
  const preBalances = new Array(opts.walletIdx + 1).fill(0);
  const postBalances = new Array(opts.walletIdx + 1).fill(0);
  preBalances[opts.walletIdx] = opts.preSolLamports;
  postBalances[opts.walletIdx] = opts.postSolLamports;
  return {
    transaction: { message: { accountKeys } },
    meta: {
      err: opts.err ?? null,
      preBalances,
      postBalances,
      preTokenBalances: (opts.preTokens ?? []).map((t) => ({
        owner: t.owner,
        mint: t.mint,
        uiTokenAmount: { uiAmount: t.uiAmount },
      })),
      postTokenBalances: (opts.postTokens ?? []).map((t) => ({
        owner: t.owner,
        mint: t.mint,
        uiTokenAmount: { uiAmount: t.uiAmount },
      })),
    },
  };
}

describe('detectSwapFromWalletPerspective', () => {
  it('null tx → null', () => {
    expect(detectSwapFromWalletPerspective(null, WALLET)).toBeNull();
  });

  it('tx err → null (실패한 tx 무시)', () => {
    const tx = mockTx({
      walletIdx: 0,
      preSolLamports: 1e9,
      postSolLamports: 0.9e9,
      err: { code: 1 },
    });
    expect(detectSwapFromWalletPerspective(tx, WALLET)).toBeNull();
  });

  it('wallet 이 tx 에 없음 → null', () => {
    const tx = mockTx({
      walletIdx: 0,
      preSolLamports: 1e9,
      postSolLamports: 0.9e9,
    });
    expect(detectSwapFromWalletPerspective(tx, 'Other_11111111111111111111111111111111111')).toBeNull();
  });

  it('buy swap: SOL 지불, token 수령 → action=buy', () => {
    const tx = mockTx({
      walletIdx: 2,
      preSolLamports: 2 * LAMPORTS_PER_SOL,
      postSolLamports: 1.9 * LAMPORTS_PER_SOL, // 0.1 SOL 지불
      postTokens: [{ owner: WALLET, mint: TOKEN_MINT, uiAmount: 1000 }],
      preTokens: [],
    });
    const result = detectSwapFromWalletPerspective(tx, WALLET);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('buy');
    expect(result!.tokenMint).toBe(TOKEN_MINT);
    expect(result!.solAmount).toBeCloseTo(0.1, 3);
  });

  it('sell swap: SOL 수령, token 감소 → action=sell', () => {
    const tx = mockTx({
      walletIdx: 2,
      preSolLamports: 1 * LAMPORTS_PER_SOL,
      postSolLamports: 1.1 * LAMPORTS_PER_SOL, // 0.1 SOL 수령
      preTokens: [{ owner: WALLET, mint: TOKEN_MINT, uiAmount: 1000 }],
      postTokens: [{ owner: WALLET, mint: TOKEN_MINT, uiAmount: 0 }],
    });
    const result = detectSwapFromWalletPerspective(tx, WALLET);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('sell');
    expect(result!.tokenMint).toBe(TOKEN_MINT);
  });

  it('SOL delta 매우 작으면 (< 10k lamports) swap 아님', () => {
    const tx = mockTx({
      walletIdx: 0,
      preSolLamports: 1e9,
      postSolLamports: 1e9 - 5000, // fee 수준
    });
    expect(detectSwapFromWalletPerspective(tx, WALLET)).toBeNull();
  });

  it('Token delta 없음 → null', () => {
    const tx = mockTx({
      walletIdx: 0,
      preSolLamports: 2 * LAMPORTS_PER_SOL,
      postSolLamports: 1.9 * LAMPORTS_PER_SOL,
    });
    expect(detectSwapFromWalletPerspective(tx, WALLET)).toBeNull();
  });

  it('WSOL token delta 는 swap 후보에서 제외 (SOL_MINT)', () => {
    const tx = mockTx({
      walletIdx: 0,
      preSolLamports: 2 * LAMPORTS_PER_SOL,
      postSolLamports: 1.9 * LAMPORTS_PER_SOL,
      postTokens: [{ owner: WALLET, mint: SOL_MINT, uiAmount: 0.1 }],
    });
    expect(detectSwapFromWalletPerspective(tx, WALLET)).toBeNull();
  });

  it('inconsistent direction (SOL 감소 + token 감소) → null', () => {
    const tx = mockTx({
      walletIdx: 0,
      preSolLamports: 2 * LAMPORTS_PER_SOL,
      postSolLamports: 1.9 * LAMPORTS_PER_SOL,
      preTokens: [{ owner: WALLET, mint: TOKEN_MINT, uiAmount: 500 }],
      postTokens: [{ owner: WALLET, mint: TOKEN_MINT, uiAmount: 400 }], // 감소
    });
    expect(detectSwapFromWalletPerspective(tx, WALLET)).toBeNull();
  });
});
