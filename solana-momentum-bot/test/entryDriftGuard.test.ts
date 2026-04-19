/**
 * Entry Drift Guard tests (2026-04-19)
 *
 * Regression anchor: VPS 2026-04-18 16:10:33 pure_ws trade 재현.
 * - signal price = 0.0000876
 * - probe = 0.01 SOL
 * - Jupiter response: outAmount=89510867 (decimals=6 가정) → 89.510867 UI tokens
 * - expected fill = 0.01 / 89.510867 = 0.00011171
 * - drift = (0.00011171 - 0.0000876) / 0.0000876 = +27.5%
 * - guard threshold 2% → reject 기대.
 */
jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: mockAxiosGet },
  get: mockAxiosGet,
}));

import { evaluateEntryDriftGuard } from '../src/gate/entryDriftGuard';

describe('entryDriftGuard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects when Jupiter expected fill > signal price by threshold — 2026-04-18 pippin regression', () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        outAmount: '89510867',
        outputDecimals: 6,
      },
    });
    return evaluateEntryDriftGuard(
      {
        tokenMint: 'ACtfUWtgvaXrQGNMiohTusi5jcx5RJf5zwu9aAxkpump',
        signalPrice: 0.0000876,
        probeSolAmount: 0.01,
      },
      { maxDriftPct: 0.02 }
    ).then((r) => {
      expect(r.routeFound).toBe(true);
      expect(r.quoteFailed).toBe(false);
      expect(r.approved).toBe(false);
      expect(r.observedDriftPct).toBeGreaterThan(0.2); // 실측치 ~27.5%
      expect(r.reason).toMatch(/entry_drift/);
    });
  });

  it('approves when fill price within ±2% of signal', async () => {
    // probe 0.01 SOL / 90M tokens (decimals 6 → 90 UI) → 0.00011111
    // signal 0.00011 → drift = (0.00011111 - 0.00011) / 0.00011 ≈ +1.0%
    mockAxiosGet.mockResolvedValue({
      data: {
        outAmount: '90000000',
        outputDecimals: 6,
      },
    });
    const r = await evaluateEntryDriftGuard(
      {
        tokenMint: 'TokenMint1111111111111111111111111111111111',
        signalPrice: 0.00011,
        probeSolAmount: 0.01,
      },
      { maxDriftPct: 0.02 }
    );
    expect(r.approved).toBe(true);
    expect(Math.abs(r.observedDriftPct)).toBeLessThan(0.02);
  });

  it('approves (with quoteFailed=true) when decimals unknown — decimals-invariant fallback', async () => {
    // outputDecimals 누락 + caller hint 없음 → 정밀 비교 불가 → gate 통과
    mockAxiosGet.mockResolvedValue({
      data: {
        outAmount: '89510867',
      },
    });
    const r = await evaluateEntryDriftGuard(
      {
        tokenMint: 'TokenMintDecimalsUnknown22222222222222222222',
        signalPrice: 0.0000876,
        probeSolAmount: 0.01,
      },
      { maxDriftPct: 0.02 }
    );
    expect(r.approved).toBe(true);
    expect(r.quoteFailed).toBe(true);
    expect(r.reason).toBe('decimals_unknown');
  });

  it('uses caller tokenDecimals hint when quote lacks outputDecimals', async () => {
    // outputDecimals 누락 + caller hint=6 → 정밀 비교 가능
    mockAxiosGet.mockResolvedValue({
      data: {
        outAmount: '89510867',
      },
    });
    const r = await evaluateEntryDriftGuard(
      {
        tokenMint: 'TokenMintHint3333333333333333333333333333333',
        signalPrice: 0.0000876,
        probeSolAmount: 0.01,
        tokenDecimals: 6,
      },
      { maxDriftPct: 0.02 }
    );
    expect(r.approved).toBe(false);
    expect(r.observedDriftPct).toBeGreaterThan(0.2);
  });

  it('approves (with quoteFailed=true) when Jupiter returns no route', async () => {
    mockAxiosGet.mockResolvedValue({ data: { error: 'No routes' } });
    const r = await evaluateEntryDriftGuard(
      {
        tokenMint: 'TokenMintNoRoute44444444444444444444444444444',
        signalPrice: 0.0001,
        probeSolAmount: 0.01,
      },
      { maxDriftPct: 0.02 }
    );
    expect(r.approved).toBe(true);
    expect(r.quoteFailed).toBe(true);
    expect(r.reason).toBe('no_route');
  });

  it('approves when Jupiter throws (timeout) — observability only, no trade block', async () => {
    mockAxiosGet.mockRejectedValue(new Error('timeout of 5000ms exceeded'));
    const r = await evaluateEntryDriftGuard(
      {
        tokenMint: 'TokenMintTimeout55555555555555555555555555555',
        signalPrice: 0.0001,
        probeSolAmount: 0.01,
      },
      { maxDriftPct: 0.02, timeoutMs: 5_000 }
    );
    expect(r.approved).toBe(true);
    expect(r.quoteFailed).toBe(true);
    expect(r.reason).toMatch(/quote_error/);
  });

  it('[2026-04-19 QA Q3] asymmetric — negative drift (favorable fill) is ALLOWED, warn only', async () => {
    // Convexity 원칙: 유리 fill 은 기회 — reject 하면 convex payoff 를 놓침.
    // outAmount 200M / 10^6 = 200 UI, 0.01 SOL / 200 = 0.00005 fill vs signal 0.0001
    // drift = -50%, but approved=true (warn only).
    mockAxiosGet.mockResolvedValue({
      data: {
        outAmount: '200000000',
        outputDecimals: 6,
      },
    });
    const r = await evaluateEntryDriftGuard(
      {
        tokenMint: 'TokenMintFavorable66666666666666666666666666',
        signalPrice: 0.0001,
        probeSolAmount: 0.01,
      },
      { maxDriftPct: 0.02 }
    );
    expect(r.approved).toBe(true);
    expect(r.observedDriftPct).toBeLessThan(-0.4);
  });

  it('rejects invalid input (zero signal price)', async () => {
    const r = await evaluateEntryDriftGuard(
      {
        tokenMint: 'T',
        signalPrice: 0,
        probeSolAmount: 0.01,
      }
    );
    expect(r.approved).toBe(true); // gate 는 통과하지만
    expect(r.reason).toBe('invalid_input');
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });
});
