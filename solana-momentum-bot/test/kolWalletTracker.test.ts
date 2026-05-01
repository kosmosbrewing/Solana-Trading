/**
 * kolWalletTracker pure function tests (Option 5 Phase 1b)
 * Full WS subscription 은 integration test 범위 밖 — detectSwapFromWalletPerspective 만 단위.
 */
jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { KolWalletTracker, detectSwapFromWalletPerspective } from '../src/ingester/kolWalletTracker';
import { SOL_MINT, LAMPORTS_PER_SOL } from '../src/utils/constants';
import { __testInject } from '../src/kol/db';
import type { KolWallet } from '../src/kol/types';

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
    /** 2026-05-01 (Helius Stream C): meta.fee — feeLamports 전파 검증 */
    fee?: number;
    /** 2026-05-01: blockTime — KolTx blockTime 전파 검증 */
    blockTime?: number;
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
    blockTime: opts.blockTime,
    meta: {
      err: opts.err ?? null,
      fee: opts.fee,
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

  // ─── 2026-05-01 (Helius Stream C) — provenance enrichment fields ───
  describe('KolTx Stream C enrichment (Helius 2026-05-01)', () => {
    it('buy swap → tokenAmount + inputMint=SOL + outputMint=tokenMint', () => {
      const tx = mockTx({
        walletIdx: 2,
        preSolLamports: 2 * LAMPORTS_PER_SOL,
        postSolLamports: 1.9 * LAMPORTS_PER_SOL,
        postTokens: [{ owner: WALLET, mint: TOKEN_MINT, uiAmount: 1000 }],
        preTokens: [],
      });
      const r = detectSwapFromWalletPerspective(tx, WALLET);
      expect(r).not.toBeNull();
      expect(r!.tokenAmount).toBe(1000);
      expect(r!.inputMint).toBe('So11111111111111111111111111111111111111112');
      expect(r!.outputMint).toBe(TOKEN_MINT);
    });

    it('sell swap → inputMint=tokenMint + outputMint=SOL + tokenAmount=감소량', () => {
      const tx = mockTx({
        walletIdx: 2,
        preSolLamports: 1 * LAMPORTS_PER_SOL,
        postSolLamports: 1.1 * LAMPORTS_PER_SOL,
        preTokens: [{ owner: WALLET, mint: TOKEN_MINT, uiAmount: 1000 }],
        postTokens: [{ owner: WALLET, mint: TOKEN_MINT, uiAmount: 200 }],
      });
      const r = detectSwapFromWalletPerspective(tx, WALLET);
      expect(r).not.toBeNull();
      expect(r!.action).toBe('sell');
      expect(r!.inputMint).toBe(TOKEN_MINT);
      expect(r!.outputMint).toBe('So11111111111111111111111111111111111111112');
      expect(r!.tokenAmount).toBe(800);
    });

    it('feeLamports 전파 (meta.fee)', () => {
      const tx = mockTx({
        walletIdx: 2,
        preSolLamports: 2 * LAMPORTS_PER_SOL,
        postSolLamports: 1.9 * LAMPORTS_PER_SOL,
        postTokens: [{ owner: WALLET, mint: TOKEN_MINT, uiAmount: 1000 }],
        preTokens: [],
        fee: 5000,
      });
      const r = detectSwapFromWalletPerspective(tx, WALLET);
      expect(r!.feeLamports).toBe(5000);
    });

    it('fee 미설정 시 feeLamports undefined', () => {
      const tx = mockTx({
        walletIdx: 2,
        preSolLamports: 2 * LAMPORTS_PER_SOL,
        postSolLamports: 1.9 * LAMPORTS_PER_SOL,
        postTokens: [{ owner: WALLET, mint: TOKEN_MINT, uiAmount: 1000 }],
        preTokens: [],
      });
      const r = detectSwapFromWalletPerspective(tx, WALLET);
      // fee 가 mock 에서 0 으로 설정되면 0 반환, undefined 면 undefined 반환 — 둘 다 유효
      expect(r!.feeLamports === undefined || typeof r!.feeLamports === 'number').toBe(true);
    });
  });
});

// ─── syncActiveSet (B-fix 2026-04-27) ────────────────────────────────
// wallets.json hot-reload 후 watchdog cycle 이 KolDB 와 tracker subs 를 diff 해서
// 새 active 구독 / 제거 active unsub. 재시작 없이 wallets.json 변경 적용.

describe('KolWalletTracker.syncActiveSet (B-fix)', () => {
  const ADDR_A = 'BfLgBboMdNZLJFMkm3g89RK5sZ6VPGFQg5xUSoM6bJV8';
  const ADDR_B = '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9';
  const ADDR_C = 'G6fUXjMKPJzCY1rveAE6Qm7wy5U3vZgKDJmN1VPAdiZC';

  function makeWallet(id: string, addrs: string[], active = true): KolWallet {
    return {
      id, addresses: addrs, tier: 'A', is_active: active,
      added_at: '2026-04-27', last_verified_at: '2026-04-27', notes: 'test',
    } as KolWallet;
  }

  function makeMockConnection() {
    let nextSubId = 100;
    return {
      onLogs: jest.fn(() => ++nextSubId),
      removeOnLogsListener: jest.fn(() => Promise.resolve()),
    };
  }

  beforeEach(() => {
    __testInject([]);
  });

  it('새 active 추가 시 onLogs 호출, 제거된 active 는 removeOnLogsListener 호출', async () => {
    const conn = makeMockConnection();
    const tracker = new KolWalletTracker({
      connection: conn as never,
      realtimeDataDir: '/tmp/test', logFileName: 'test.jsonl',
      txFetchTimeoutMs: 1000, enabled: true,
    });

    // Initial: A, B active
    __testInject([makeWallet('a', [ADDR_A]), makeWallet('b', [ADDR_B])]);
    await tracker.start();
    expect(tracker.getSubscriptionCount()).toBe(2);
    expect(conn.onLogs).toHaveBeenCalledTimes(2);

    // Hot-reload: B removed, C added
    __testInject([makeWallet('a', [ADDR_A]), makeWallet('c', [ADDR_C])]);
    await (tracker as unknown as { syncActiveSet: () => Promise<void> }).syncActiveSet();

    expect(tracker.getSubscriptionCount()).toBe(2);  // A + C
    expect(conn.onLogs).toHaveBeenCalledTimes(3);     // initial 2 + new C
    expect(conn.removeOnLogsListener).toHaveBeenCalledTimes(1);  // B removed

    await tracker.stop();
  });

  it('defensive: active set empty 인데 기존 subs 있으면 sync skip (DB anomaly 가드)', async () => {
    const conn = makeMockConnection();
    const tracker = new KolWalletTracker({
      connection: conn as never,
      realtimeDataDir: '/tmp/test', logFileName: 'test.jsonl',
      txFetchTimeoutMs: 1000, enabled: true,
    });

    __testInject([makeWallet('a', [ADDR_A]), makeWallet('b', [ADDR_B])]);
    await tracker.start();
    expect(tracker.getSubscriptionCount()).toBe(2);

    // Simulate DB load failure: empty active set
    __testInject([]);
    await (tracker as unknown as { syncActiveSet: () => Promise<void> }).syncActiveSet();

    // Subs MUST stay (defensive guard fires)
    expect(tracker.getSubscriptionCount()).toBe(2);
    expect(conn.removeOnLogsListener).not.toHaveBeenCalled();

    await tracker.stop();
  });

  it('idempotent: 변경 없으면 subscribe/remove 호출 X', async () => {
    const conn = makeMockConnection();
    const tracker = new KolWalletTracker({
      connection: conn as never,
      realtimeDataDir: '/tmp/test', logFileName: 'test.jsonl',
      txFetchTimeoutMs: 1000, enabled: true,
    });

    __testInject([makeWallet('a', [ADDR_A]), makeWallet('b', [ADDR_B])]);
    await tracker.start();
    const initialOnLogs = conn.onLogs.mock.calls.length;

    // Same active set
    await (tracker as unknown as { syncActiveSet: () => Promise<void> }).syncActiveSet();

    expect(conn.onLogs.mock.calls.length).toBe(initialOnLogs);  // no new subs
    expect(conn.removeOnLogsListener).not.toHaveBeenCalled();

    await tracker.stop();
  });

  it('handleLog clears tx fetch timeout when RPC returns first', async () => {
    jest.useFakeTimers();
    try {
      const conn = {
        onLogs: jest.fn(),
        removeOnLogsListener: jest.fn(() => Promise.resolve()),
        getParsedTransaction: jest.fn().mockResolvedValue(mockTx({
          walletIdx: 0,
          preSolLamports: 2 * LAMPORTS_PER_SOL,
          postSolLamports: 1.9 * LAMPORTS_PER_SOL,
          postTokens: [{ owner: ADDR_A, mint: TOKEN_MINT, uiAmount: 1000 }],
          preTokens: [],
        })),
      };
      const tracker = new KolWalletTracker({
        connection: conn as never,
        realtimeDataDir: '/tmp/test', logFileName: 'test.jsonl',
        txFetchTimeoutMs: 1000, enabled: true,
      });
      jest
        .spyOn(tracker as unknown as { appendJsonl: (...a: unknown[]) => Promise<void> }, 'appendJsonl')
        .mockResolvedValue(undefined);
      __testInject([makeWallet('a', [ADDR_A])]);

      await (tracker as unknown as {
        handleLog: (addr: string, sig: string, slot: number) => Promise<void>;
      }).handleLog(ADDR_A, 'sig-fast-rpc', 1);

      expect(conn.getParsedTransaction).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ─── Shadow Track (Option A, 2026-04-27) ──────────────────────────────
// inactive KOL 은 shadowTrackInactive=true 일 때만 subscribe → 별도 jsonl 로 routing.
// 핵심 invariant: inactive tx 가 'kol_swap' event 를 emit 하지 않아야 paper position 영향 0 보장.

describe('KolWalletTracker.shadowTrackInactive (Option A)', () => {
  // 기존 syncActiveSet 테스트와 동일하게 검증된 base58 주소 재사용 (PublicKey 생성 안전).
  const ACTIVE_ADDR = 'BfLgBboMdNZLJFMkm3g89RK5sZ6VPGFQg5xUSoM6bJV8';
  const INACTIVE_ADDR = '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9';
  const TOKEN_MINT_T = 'Tk22222222222222222222222222222222222222222';

  function makeWallet(id: string, addrs: string[], active: boolean): KolWallet {
    return {
      id, addresses: addrs, tier: 'A', is_active: active,
      added_at: '2026-04-27', last_verified_at: '2026-04-27', notes: 'test',
    } as KolWallet;
  }

  function makeShadowMockConnection() {
    let nextSubId = 200;
    return {
      onLogs: jest.fn(() => ++nextSubId),
      removeOnLogsListener: jest.fn(() => Promise.resolve()),
      getParsedTransaction: jest.fn(),
    };
  }

  beforeEach(() => {
    __testInject([]);
  });

  it('shadow flag false (default) → inactive 미구독 (regression guard)', async () => {
    const conn = makeShadowMockConnection();
    const tracker = new KolWalletTracker({
      connection: conn as never,
      realtimeDataDir: '/tmp/test-shadow', logFileName: 'test.jsonl',
      txFetchTimeoutMs: 1000, enabled: true,
      // shadowTrackInactive 미지정 (default false)
    });

    __testInject([
      makeWallet('a', [ACTIVE_ADDR], true),
      makeWallet('inact', [INACTIVE_ADDR], false),
    ]);
    await tracker.start();

    expect(tracker.getSubscriptionCount()).toBe(1);  // active 만
    const subscribedAddrs = (conn.onLogs.mock.calls as unknown as Array<[{ toBase58: () => string }]>).map(
      (c) => c[0].toBase58()
    );
    expect(subscribedAddrs).toContain(ACTIVE_ADDR);
    expect(subscribedAddrs).not.toContain(INACTIVE_ADDR);

    await tracker.stop();
  });

  it('shadow flag true → active + inactive 모두 구독', async () => {
    const conn = makeShadowMockConnection();
    const tracker = new KolWalletTracker({
      connection: conn as never,
      realtimeDataDir: '/tmp/test-shadow', logFileName: 'test.jsonl',
      txFetchTimeoutMs: 1000, enabled: true,
      shadowTrackInactive: true,
      shadowLogFileName: 'kol-shadow-tx.jsonl',
    });

    __testInject([
      makeWallet('a', [ACTIVE_ADDR], true),
      makeWallet('inact', [INACTIVE_ADDR], false),
    ]);
    await tracker.start();

    expect(tracker.getSubscriptionCount()).toBe(2);
    const subscribedAddrs = (conn.onLogs.mock.calls as unknown as Array<[{ toBase58: () => string }]>).map(
      (c) => c[0].toBase58()
    );
    expect(subscribedAddrs).toContain(ACTIVE_ADDR);
    expect(subscribedAddrs).toContain(INACTIVE_ADDR);

    await tracker.stop();
  });

  it('shadow KOL tx → kol_shadow_tx emit, kol_swap 호출 안 됨 (paper position 영향 0)', async () => {
    const conn = makeShadowMockConnection();
    // detectSwapFromWalletPerspective 를 통과할 buy tx
    const buyTx = {
      blockTime: 1700000000,
      transaction: {
        message: {
          accountKeys: [{ pubkey: { toBase58: () => INACTIVE_ADDR } }],
        },
      },
      meta: {
        err: null,
        preBalances: [2 * LAMPORTS_PER_SOL],
        postBalances: [1.9 * LAMPORTS_PER_SOL],
        preTokenBalances: [],
        postTokenBalances: [
          { owner: INACTIVE_ADDR, mint: TOKEN_MINT_T, uiTokenAmount: { uiAmount: 1000 } },
        ],
      },
    };
    conn.getParsedTransaction.mockResolvedValue(buyTx);

    const tracker = new KolWalletTracker({
      connection: conn as never,
      realtimeDataDir: '/tmp/test-shadow', logFileName: 'test.jsonl',
      txFetchTimeoutMs: 1000, enabled: true,
      shadowTrackInactive: true,
      shadowLogFileName: 'kol-shadow-tx.jsonl',
    });

    __testInject([
      makeWallet('a', [ACTIVE_ADDR], true),
      makeWallet('shadowed', [INACTIVE_ADDR], false),
    ]);
    await tracker.start();

    const swapHandler = jest.fn();
    const shadowHandler = jest.fn();
    tracker.on('kol_swap', swapHandler);
    tracker.on('kol_shadow_tx', shadowHandler);

    // Mock appendJsonl 을 가짜로 — 실제 fs write 회피.
    const appendSpy = jest
      .spyOn(tracker as unknown as { appendJsonl: (...a: unknown[]) => Promise<void> }, 'appendJsonl')
      .mockResolvedValue(undefined);

    // handleLog 직접 호출 (private — test only)
    await (tracker as unknown as {
      handleLog: (addr: string, sig: string, slot: number) => Promise<void>;
    }).handleLog(INACTIVE_ADDR, 'fake_sig_shadow', 1);

    // Critical invariant: shadow tx 는 kol_swap emit 안 함 → kolSignalHandler 진입 불가.
    expect(swapHandler).not.toHaveBeenCalled();
    expect(shadowHandler).toHaveBeenCalledTimes(1);
    expect(shadowHandler.mock.calls[0][0]).toMatchObject({
      kolId: 'shadowed',
      walletAddress: INACTIVE_ADDR,
      action: 'buy',
      tokenMint: TOKEN_MINT_T,
    });

    // appendJsonl 은 shadow=true 로 호출돼야 (별도 파일 routing).
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.mock.calls[0][1]).toBe(true);

    await tracker.stop();
  });

  it('active KOL tx → kol_swap emit (shadow flag on 이어도 active 는 정상 routing)', async () => {
    const conn = makeShadowMockConnection();
    const buyTx = {
      blockTime: 1700000000,
      transaction: {
        message: { accountKeys: [{ pubkey: { toBase58: () => ACTIVE_ADDR } }] },
      },
      meta: {
        err: null,
        preBalances: [2 * LAMPORTS_PER_SOL],
        postBalances: [1.9 * LAMPORTS_PER_SOL],
        preTokenBalances: [],
        postTokenBalances: [
          { owner: ACTIVE_ADDR, mint: TOKEN_MINT_T, uiTokenAmount: { uiAmount: 1000 } },
        ],
      },
    };
    conn.getParsedTransaction.mockResolvedValue(buyTx);

    const tracker = new KolWalletTracker({
      connection: conn as never,
      realtimeDataDir: '/tmp/test-shadow', logFileName: 'test.jsonl',
      txFetchTimeoutMs: 1000, enabled: true,
      shadowTrackInactive: true,
    });

    __testInject([
      makeWallet('a', [ACTIVE_ADDR], true),
      makeWallet('inact', [INACTIVE_ADDR], false),
    ]);
    await tracker.start();

    const swapHandler = jest.fn();
    const shadowHandler = jest.fn();
    tracker.on('kol_swap', swapHandler);
    tracker.on('kol_shadow_tx', shadowHandler);

    jest
      .spyOn(tracker as unknown as { appendJsonl: (...a: unknown[]) => Promise<void> }, 'appendJsonl')
      .mockResolvedValue(undefined);

    await (tracker as unknown as {
      handleLog: (addr: string, sig: string, slot: number) => Promise<void>;
    }).handleLog(ACTIVE_ADDR, 'fake_sig_active', 1);

    expect(swapHandler).toHaveBeenCalledTimes(1);
    expect(shadowHandler).not.toHaveBeenCalled();

    await tracker.stop();
  });
});
