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

import { PaperPriceFeed, type PriceTick } from '../src/kol/paperPriceFeed';
import { SOL_MINT } from '../src/utils/constants';

const TOKEN = 'TokenMint11111111111111111111111111111111111';

function makeFeed(): PaperPriceFeed {
  return new PaperPriceFeed({
    jupiterApiUrl: 'https://api.test/swap/v1',
    pollIntervalMs: 99_999,
    probeSolAmount: 0.01,
    rateLimitCooldownMs: 50,
    timeoutMs: 1_000,
    slippageBps: 200,
  });
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('PaperPriceFeed', () => {
  beforeEach(() => {
    mockAxiosGet.mockReset();
    mockRecord429.mockReset();
  });

  it('refreshNow fetches a fresh quote, updates subscribed cache, and emits the tick', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: { outAmount: String(1_000_000), outputDecimals: 6 },
    });
    const feed = makeFeed();
    feed.subscribe(TOKEN);
    await flushPromises();

    mockAxiosGet.mockClear();
    mockAxiosGet.mockResolvedValueOnce({
      data: { outAmount: String(500_000), outputDecimals: 6 },
    });
    const events: PriceTick[] = [];
    feed.on('price', (tick: PriceTick) => events.push(tick));

    const tick = await feed.refreshNow(TOKEN);

    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    expect(mockAxiosGet).toHaveBeenCalledWith(
      'https://api.test/swap/v1/quote',
      expect.objectContaining({
        params: {
          inputMint: SOL_MINT,
          outputMint: TOKEN,
          amount: '10000000',
          slippageBps: 200,
        },
        timeout: 1_000,
      })
    );
    expect(tick).not.toBeNull();
    expect(tick?.price).toBeCloseTo(0.02, 6);
    expect(tick?.outAmountUi).toBeCloseTo(0.5, 6);
    expect(tick?.outputDecimals).toBe(6);
    expect(tick?.probeSolAmount).toBe(0.01);

    const cached = feed.getLastTick(TOKEN);
    expect(cached?.price).toBeCloseTo(0.02, 6);
    expect(cached?.timestamp).toBe(tick?.timestamp);
    expect(cached?.outputDecimals).toBe(6);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(tick);
    expect(mockRecord429).not.toHaveBeenCalled();

    feed.stopAll();
  });
});
