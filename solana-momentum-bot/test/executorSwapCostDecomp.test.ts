/**
 * Sprint Z+ (2026-05-01) — Codex 권고 R1 회귀 테스트.
 *
 * Jito fallback 시점에 jitoTipPaidSol 차감이 정확한지 단위 검증:
 *   - Jito 성공 → declaredJitoTipSol > 0 → swapInputSol 에서 차감
 *   - Jito 실패 후 standard RPC fallback → caller 가 declaredJitoTipSol=0 전달 → 차감 없음
 *   - F2 sanity: newlyFunded > 0.05 SOL → ATA 외 의심 → fallback (분해 0)
 *
 * decomposeSwapCost 는 RPC `connection.getTransaction` mock 으로 격리.
 */
jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { decomposeSwapCost } from '../src/executor/executor';
import type { Connection } from '@solana/web3.js';

function makeConnectionMock(opts: {
  fee: number;
  newlyFundedSols: number[];   // signer 외 신규 funded account 의 SOL 합계 (lamports 분할 가능)
}): Connection {
  // signer = index 0, 그 외 신규 funded accounts
  const signerKey = { toBase58: () => 'SignerKeyMock' };
  const otherKeys = opts.newlyFundedSols.map((_, i) => ({
    toBase58: () => `NewAcct${i}`,
  }));
  const accountKeys = {
    get: (i: number) => (i === 0 ? signerKey : (otherKeys[i - 1] ?? null)),
    length: 1 + otherKeys.length,
  };
  const preBal = [1_000_000_000, ...otherKeys.map(() => 0)];
  const postBal = [
    1_000_000_000 - opts.fee * 1e9 - opts.newlyFundedSols.reduce((a, b) => a + b, 0) * 1e9,
    ...opts.newlyFundedSols.map((s) => s * 1e9),
  ];
  const mockTx = {
    meta: { fee: opts.fee * 1e9, preBalances: preBal, postBalances: postBal },
    transaction: { message: { getAccountKeys: () => accountKeys } },
  };
  return {
    getTransaction: jest.fn().mockResolvedValue(mockTx),
  } as unknown as Connection;
}

describe('decomposeSwapCost (Sprint X+Z + Codex R1 regression)', () => {
  it('정상 path — ATA rent + fee 차감, swap input 정확', async () => {
    const conn = makeConnectionMock({ fee: 0.000105, newlyFundedSols: [0.002074] });
    const result = await decomposeSwapCost(conn, 'sig123', 0.022179, 0);
    expect(result.networkFeeSol).toBeCloseTo(0.000105, 6);
    expect(result.ataRentSol).toBeCloseTo(0.002074, 6);
    expect(result.jitoTipSol).toBe(0);
    // swap input = wallet - fee - rent - tip = 0.022179 - 0.000105 - 0.002074 - 0 = 0.020000
    expect(result.swapInputSol).toBeCloseTo(0.020, 5);
    expect(result.walletInputSol).toBe(0.022179);
  });

  // Codex R1 권고 — Jito fallback regression
  it('Jito 성공 (declaredJitoTipSol > 0) → swap input 에서 tip 추가 차감', async () => {
    const conn = makeConnectionMock({ fee: 0.000105, newlyFundedSols: [0.002074] });
    const result = await decomposeSwapCost(conn, 'sig-jito', 0.024179, 0.002);  // wallet 에 tip 포함
    expect(result.jitoTipSol).toBe(0.002);
    // swap = wallet - fee - rent - tip = 0.024179 - 0.000105 - 0.002074 - 0.002 = 0.020000
    expect(result.swapInputSol).toBeCloseTo(0.020, 5);
  });

  it('Jito 실패 후 standard RPC fallback → caller 가 declaredJitoTipSol=0 전달 → 차감 안 됨', async () => {
    const conn = makeConnectionMock({ fee: 0.000105, newlyFundedSols: [0.002074] });
    // wallet delta 는 fallback path 에서 tip 미지불 → 정상 swap input + rent + fee 만 차감.
    const result = await decomposeSwapCost(conn, 'sig-fallback', 0.022179, 0);
    expect(result.jitoTipSol).toBe(0);  // 핵심: tip 차감 안 됨
    expect(result.swapInputSol).toBeCloseTo(0.020, 5);
    // walletInputSol 에서 tip 분 추정 차감 안 함 → token-only entry price 정확
    const tokenEntryPriceUnit = result.swapInputSol / 79362;
    const walletEntryPriceUnit = result.walletInputSol / 79362;
    expect(walletEntryPriceUnit).toBeGreaterThan(tokenEntryPriceUnit);  // wallet 이 rent 만큼 inflated
  });

  it('F2 sanity — newlyFunded > 0.05 SOL → escrow 의심, fallback (rent 0)', async () => {
    const conn = makeConnectionMock({ fee: 0.000105, newlyFundedSols: [0.06] });  // > 0.05 cap
    const result = await decomposeSwapCost(conn, 'sig-escrow', 0.063, 0);
    expect(result.ataRentSol).toBe(0);  // sanity 초과 → 분해 0 (fallback)
    // swap = wallet - fee - 0 - 0 = 0.063 - 0.000105 = 0.062895 (escrow 잘못 차감 안 함)
    expect(result.swapInputSol).toBeCloseTo(0.062895, 5);
  });

  it('RPC timeout / 실패 → fallback (walletInputSol 그대로)', async () => {
    const conn = {
      getTransaction: jest.fn().mockRejectedValue(new Error('RPC timeout')),
    } as unknown as Connection;
    const result = await decomposeSwapCost(conn, 'sig-fail', 0.022179, 0.002);
    // fallback: swap = wallet 그대로, rent/fee 0, jitoTip = declared
    expect(result.swapInputSol).toBe(0.022179);
    expect(result.ataRentSol).toBe(0);
    expect(result.networkFeeSol).toBe(0);
    expect(result.jitoTipSol).toBe(0.002);
    expect(result.walletInputSol).toBe(0.022179);
  });

  it('null transaction result is not cached, so later retry can recover meta', async () => {
    const conn = makeConnectionMock({ fee: 0.000105, newlyFundedSols: [0.002074] });
    const getTransaction = conn.getTransaction as jest.Mock;
    getTransaction
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        meta: {
          fee: 0.000105 * 1e9,
          preBalances: [1_000_000_000, 0],
          postBalances: [997_821_000, 2_074_000],
        },
        transaction: {
          message: {
            getAccountKeys: () => ({
              get: (i: number) => i === 0
                ? { toBase58: () => 'SignerKeyMock' }
                : (i === 1 ? { toBase58: () => 'NewAcctRetry' } : null),
              length: 2,
            }),
          },
        },
      });

    const first = await decomposeSwapCost(conn, 'sig-null-retry', 0.022179, 0);
    const second = await decomposeSwapCost(conn, 'sig-null-retry', 0.022179, 0);

    expect(first.swapInputSol).toBe(0.022179);
    expect(second.swapInputSol).toBeCloseTo(0.020, 5);
    expect(getTransaction).toHaveBeenCalledTimes(2);
  });

  it('재진입 (newly funded 0) → ATA rent 0', async () => {
    const conn = makeConnectionMock({ fee: 0.000105, newlyFundedSols: [] });
    const result = await decomposeSwapCost(conn, 'sig-rentry', 0.020105, 0);
    expect(result.ataRentSol).toBe(0);
    expect(result.swapInputSol).toBeCloseTo(0.020, 5);
  });

  it('versioned tx with lookup table addresses passes loadedAddresses to getAccountKeys', async () => {
    const signerKey = { toBase58: () => 'SignerKeyMock' };
    const ataKey = { toBase58: () => 'NewAtaViaLookup' };
    const accountKeys = {
      get: (i: number) => (i === 0 ? signerKey : (i === 1 ? ataKey : null)),
      length: 2,
    };
    const getAccountKeys = jest.fn((args?: { accountKeysFromLookups?: unknown }) => {
      if (!args?.accountKeysFromLookups) throw new Error('missing lookup addresses');
      return accountKeys;
    });
    const conn = {
      getTransaction: jest.fn().mockResolvedValue({
        meta: {
          fee: 0.000105 * 1e9,
          preBalances: [1_000_000_000, 0],
          postBalances: [997_821_000, 2_074_000],
          loadedAddresses: { writable: [], readonly: [] },
        },
        transaction: {
          message: { getAccountKeys },
        },
      }),
    } as unknown as Connection;

    const result = await decomposeSwapCost(conn, 'sig-alt', 0.022179, 0);
    expect(getAccountKeys).toHaveBeenCalledWith({
      accountKeysFromLookups: { writable: [], readonly: [] },
    });
    expect(result.ataRentSol).toBeCloseTo(0.002074, 6);
    expect(result.swapInputSol).toBeCloseTo(0.020, 5);
  });
});
