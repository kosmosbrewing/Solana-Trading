/**
 * Sell Quote Probe tests (Survival Layer Tier B-1, 2026-04-21).
 *
 * 검증 대상:
 *  - Jupiter `tokenMint → SOL` quote 요청
 *  - no_sell_route → reject (honeypot 신호)
 *  - impact > maxImpactPct → reject
 *  - round-trip minimum 체크 (optional)
 *  - quote 실패 / 429 → observability only (approved=true, quoteFailed=true)
 *  - result cache 동작
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

import {
  evaluateSellQuoteProbe,
  resetSellQuoteProbeStateForTests,
} from '../src/gate/sellQuoteProbe';

describe('sellQuoteProbe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSellQuoteProbeStateForTests();
  });

  it('approves normal sell quote with impact within threshold', async () => {
    // 0.01 SOL 지출 → 100 token 받음 (decimals 6) → 100e6 raw.
    // 팔면 0.0095 SOL 받음 (5% impact). impact reported as 2.0%.
    mockAxiosGet.mockResolvedValue({
      data: {
        outAmount: String(9_500_000), // 0.0095 SOL
        priceImpactPct: '2.0',
      },
    });

    const r = await evaluateSellQuoteProbe(
      {
        tokenMint: 'TokenMintNormal11111111111111111111111111111',
        probeTokenAmountRaw: 100_000_000n, // 100 tokens × 10^6
        expectedSolReceive: 0.01,
      },
      { maxImpactPct: 0.10 }
    );

    expect(r.approved).toBe(true);
    expect(r.routeFound).toBe(true);
    expect(r.observedOutSol).toBeCloseTo(0.0095, 6);
    expect(r.observedImpactPct).toBeCloseTo(0.02, 4);
    expect(r.roundTripPct).toBeCloseTo(0.95, 4);
  });

  it('rejects when Jupiter returns no sell route (honeypot-by-liquidity)', async () => {
    mockAxiosGet.mockResolvedValue({ data: { error: 'No routes found' } });

    const r = await evaluateSellQuoteProbe(
      {
        tokenMint: 'TokenMintNoRoute2222222222222222222222222222',
        probeTokenAmountRaw: 100_000_000n,
        expectedSolReceive: 0.01,
      },
      { maxImpactPct: 0.10 }
    );

    expect(r.approved).toBe(false);
    expect(r.routeFound).toBe(false);
    expect(r.reason).toBe('no_sell_route');
  });

  it('rejects when sell impact exceeds maxImpactPct (slippage bomb)', async () => {
    // impact 25% — 허용 10% 초과
    mockAxiosGet.mockResolvedValue({
      data: {
        outAmount: String(7_500_000),
        priceImpactPct: '25.0',
      },
    });

    const r = await evaluateSellQuoteProbe(
      {
        tokenMint: 'TokenMintHighImpact33333333333333333333333333',
        probeTokenAmountRaw: 100_000_000n,
        expectedSolReceive: 0.01,
      },
      { maxImpactPct: 0.10 }
    );

    expect(r.approved).toBe(false);
    expect(r.routeFound).toBe(true);
    expect(r.reason).toMatch(/sell_impact/);
    expect(r.observedImpactPct).toBeCloseTo(0.25, 4);
  });

  it('[minRoundTripPct gate] rejects when round-trip < configured minimum', async () => {
    // 0.01 SOL 지출 → sell 시 0.004 SOL (40%) 복구. maxImpact pass (2%), 그러나 round-trip 40% < 50%.
    mockAxiosGet.mockResolvedValue({
      data: {
        outAmount: String(4_000_000),
        priceImpactPct: '2.0',
      },
    });

    const r = await evaluateSellQuoteProbe(
      {
        tokenMint: 'TokenMintLowRoundTrip44444444444444444444444',
        probeTokenAmountRaw: 100_000_000n,
        expectedSolReceive: 0.01,
      },
      { maxImpactPct: 0.10, minRoundTripPct: 0.50 }
    );

    expect(r.approved).toBe(false);
    expect(r.reason).toMatch(/round_trip/);
    expect(r.roundTripPct).toBeCloseTo(0.4, 4);
  });

  it('[minRoundTripPct=0 skip] does not check round-trip when disabled', async () => {
    // 40% 복구지만 minRoundTripPct=0 으로 skip → approved
    mockAxiosGet.mockResolvedValue({
      data: {
        outAmount: String(4_000_000),
        priceImpactPct: '2.0',
      },
    });

    const r = await evaluateSellQuoteProbe(
      {
        tokenMint: 'TokenMintDisabled5555555555555555555555555555',
        probeTokenAmountRaw: 100_000_000n,
        expectedSolReceive: 0.01,
      },
      { maxImpactPct: 0.10, minRoundTripPct: 0 }
    );

    expect(r.approved).toBe(true);
    expect(r.roundTripPct).toBeCloseTo(0.4, 4);
  });

  it('approves (quoteFailed=true) when Jupiter throws (observability only, no trade block)', async () => {
    mockAxiosGet.mockRejectedValue(new Error('timeout of 3000ms exceeded'));

    const r = await evaluateSellQuoteProbe(
      {
        tokenMint: 'TokenMintTimeout666666666666666666666666666',
        probeTokenAmountRaw: 100_000_000n,
        expectedSolReceive: 0.01,
      },
      { maxImpactPct: 0.10, timeoutMs: 3_000 }
    );

    expect(r.approved).toBe(true);
    expect(r.quoteFailed).toBe(true);
    expect(r.reason).toMatch(/quote_error/);
  });

  it('rejects invalid input (probeTokenAmountRaw = 0)', async () => {
    const r = await evaluateSellQuoteProbe(
      {
        tokenMint: 'T',
        probeTokenAmountRaw: 0n,
        expectedSolReceive: 0.01,
      }
    );
    expect(r.approved).toBe(true); // gate pass
    expect(r.reason).toBe('invalid_input');
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('[result cache] second call within TTL reuses cached result', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        outAmount: String(9_500_000),
        priceImpactPct: '2.0',
      },
    });
    const input = {
      tokenMint: 'TokenMintCache777777777777777777777777777777',
      probeTokenAmountRaw: 100_000_000n,
      expectedSolReceive: 0.01,
    };
    await evaluateSellQuoteProbe(input, { maxImpactPct: 0.10 });
    await evaluateSellQuoteProbe(input, { maxImpactPct: 0.10 });

    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
  });

  it('[rate-limit circuit breaker] skips axios call during 429 cooldown', async () => {
    const err: Error & { response?: { status: number } } = new Error('Request failed with status code 429');
    err.response = { status: 429 };
    mockAxiosGet.mockRejectedValueOnce(err);

    const input = {
      tokenMint: 'TokenMintRateLimit888888888888888888888888888',
      probeTokenAmountRaw: 100_000_000n,
      expectedSolReceive: 0.01,
    };

    const first = await evaluateSellQuoteProbe(input, { rateLimitCooldownMs: 2_000 });
    expect(first.quoteFailed).toBe(true);

    const second = await evaluateSellQuoteProbe(
      { ...input, tokenMint: 'DifferentToken999999999999999999999999999999' },
      { rateLimitCooldownMs: 2_000 }
    );
    expect(second.cacheStatus).toBe('rate_limited');
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
  });
});
