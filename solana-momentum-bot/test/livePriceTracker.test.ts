/**
 * livePriceTracker tests — Phase 2 P1-1.
 *
 * Verifies subscribe / unsubscribe / quote-based MFE computation / 429 cooldown.
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

const mockRecord429 = jest.fn();
jest.mock('../src/observability/jupiterRateLimitMetric', () => ({
  recordJupiter429: (...args: unknown[]) => mockRecord429(...args),
}));

import { LivePriceTracker } from '../src/observability/livePriceTracker';

const TOKEN = 'TokenMint11111111111111111111111111111111111';

function makeTracker() {
  return new LivePriceTracker({
    jupiterApiUrl: 'https://api.test/swap/v1',
    pollIntervalMs: 99_999, // disable timer for unit test
    rateLimitCooldownMs: 50,
    timeoutMs: 1_000,
  });
}

describe('LivePriceTracker', () => {
  beforeEach(() => {
    mockAxiosGet.mockReset();
    mockRecord429.mockReset();
  });

  it('subscribe + emits reverse_quote with mfe = (solOut - entryNotional) / entryNotional', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: { outAmount: String(2_000_000_000), outputDecimals: 9 }, // 2 SOL out (lamports)
    });
    const tracker = makeTracker();
    const events: any[] = [];
    tracker.on('reverse_quote', (t) => events.push(t));

    tracker.subscribe({
      tokenMint: TOKEN,
      quantityUi: 1000,
      decimals: 6,
      entryNotionalSol: 1.0,
    });
    // Poll directly via private — use timer firing simulation
    await (tracker as any).poll(TOKEN);

    expect(events).toHaveLength(1);
    expect(events[0].solOut).toBeCloseTo(2.0, 6);
    expect(events[0].entryNotionalSol).toBe(1.0);
    expect(events[0].mfeVsEntry).toBeCloseTo(1.0, 6); // (2 - 1) / 1 = +100%
    tracker.stopAll();
  });

  it('429 → record + cooldown blocks subsequent poll', async () => {
    const tracker = makeTracker();
    mockAxiosGet.mockRejectedValueOnce({ response: { status: 429 } });

    tracker.subscribe({
      tokenMint: TOKEN,
      quantityUi: 100,
      decimals: 6,
      entryNotionalSol: 0.5,
    });
    await (tracker as any).poll(TOKEN);

    expect(mockRecord429).toHaveBeenCalledWith('live_price_tracker');
    // 두 번째 poll 은 cooldown 으로 skip → axios 호출 1회만.
    await (tracker as any).poll(TOKEN);
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    tracker.stopAll();
  });

  it('unsubscribe drops subscription + clears timer', () => {
    const tracker = makeTracker();
    tracker.subscribe({ tokenMint: TOKEN, quantityUi: 1, decimals: 6, entryNotionalSol: 0.01 });
    expect(tracker.getActiveSubscriptionCount()).toBe(1);
    tracker.unsubscribe(TOKEN);
    expect(tracker.getActiveSubscriptionCount()).toBe(0);
  });

  it('rejects invalid input silently (no subscribe)', () => {
    const tracker = makeTracker();
    tracker.subscribe({ tokenMint: TOKEN, quantityUi: 0, decimals: 6, entryNotionalSol: 0.01 });
    expect(tracker.getActiveSubscriptionCount()).toBe(0);
    tracker.subscribe({ tokenMint: TOKEN, quantityUi: 1, decimals: 6, entryNotionalSol: 0 });
    expect(tracker.getActiveSubscriptionCount()).toBe(0);
  });
});
