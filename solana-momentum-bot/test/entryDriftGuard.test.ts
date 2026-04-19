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

import { evaluateEntryDriftGuard, resetEntryDriftGuardState } from '../src/gate/entryDriftGuard';

describe('entryDriftGuard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetEntryDriftGuardState();
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

  // ─── P0-2 Jupiter 429 방어 회귀 ───
  // Why: 2026-04-19 8h 관측 3,998건 quote 429 — sub-ms burst 의 동일 pair 반복 호출이 원인.

  it('[P0-2] collapses concurrent burst on same pair into a single Jupiter call', async () => {
    // 단일 Promise 를 직접 제어하여 "pending 중 128 call" burst 를 재현.
    let resolveQuote: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveQuote = resolve;
    });
    mockAxiosGet.mockReturnValueOnce(pending);

    const input = {
      tokenMint: 'BurstToken111111111111111111111111111111111',
      signalPrice: 0.00011, // 90M tokens → 0.01/90 = 0.000111 → drift +1%
      probeSolAmount: 0.01,
    };
    // 128 concurrent call — 실제 04:09:42.144-.153 window 재현.
    const promises = Array.from({ length: 128 }, () =>
      evaluateEntryDriftGuard(input, { maxDriftPct: 0.02 })
    );
    resolveQuote({ data: { outAmount: '90000000', outputDecimals: 6 } });
    const results = await Promise.all(promises);

    // In-flight dedup + result cache 로 axios call 은 1 회.
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    // 모두 approve (drift +1% < 2%)
    expect(results.every((r) => r.approved === true)).toBe(true);
    // 첫 번째만 miss, 나머지는 in_flight_join 또는 result_hit
    const joined = results.filter(
      (r) => r.cacheStatus === 'in_flight_join' || r.cacheStatus === 'result_hit'
    );
    expect(joined.length).toBe(127);
  });

  it('[P0-2] trips rate-limit circuit breaker on 429 and short-circuits subsequent calls', async () => {
    // 1st call: 429 throw. 2nd call: cooldown 기간 내 — axios 호출 자체 skip.
    const err: Error & { response?: { status: number } } = new Error('Request failed with status code 429');
    err.response = { status: 429 };
    mockAxiosGet.mockRejectedValueOnce(err);

    const input = {
      tokenMint: 'RateLimitToken222222222222222222222222222222',
      signalPrice: 0.0001,
      probeSolAmount: 0.01,
    };
    const first = await evaluateEntryDriftGuard(input, {
      maxDriftPct: 0.02,
      rateLimitCooldownMs: 5_000,
      resultCacheTtlMs: 0, // result cache 영향 제거 — circuit breaker 단독 검증.
    });
    expect(first.quoteFailed).toBe(true);
    expect(first.reason).toMatch(/quote_error/);

    const second = await evaluateEntryDriftGuard(
      {
        tokenMint: 'DifferentToken3333333333333333333333333333333',
        signalPrice: 0.0001,
        probeSolAmount: 0.01,
      },
      { maxDriftPct: 0.02, rateLimitCooldownMs: 5_000, resultCacheTtlMs: 0 }
    );
    expect(mockAxiosGet).toHaveBeenCalledTimes(1); // 2nd call 은 axios 건드리지 않음
    expect(second.quoteFailed).toBe(true);
    expect(second.reason).toBe('rate_limited_cooldown');
    expect(second.cacheStatus).toBe('rate_limited');
    expect(second.approved).toBe(true); // fail-open — entry 차단 금지 (observability only)
  });

  it('[P0-2] caches successful quote for TTL window, skipping repeat Jupiter calls', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: { outAmount: '90000000', outputDecimals: 6 },
    });

    const input = {
      tokenMint: 'CachedToken4444444444444444444444444444444444',
      signalPrice: 0.00011,
      probeSolAmount: 0.01,
    };
    const first = await evaluateEntryDriftGuard(input, {
      maxDriftPct: 0.02,
      resultCacheTtlMs: 5_000,
    });
    const second = await evaluateEntryDriftGuard(input, {
      maxDriftPct: 0.02,
      resultCacheTtlMs: 5_000,
    });

    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    expect(first.cacheStatus).toBe('miss');
    expect(second.cacheStatus).toBe('result_hit');
    expect(second.approved).toBe(true);
  });
});
