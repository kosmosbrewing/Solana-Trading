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

import { evaluateQuoteGate } from '../src/gate/quoteGate';

describe('quoteGate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes root Jupiter URL to keyless swap path', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        outAmount: '123456',
        priceImpactPct: '0.1',
        routePlan: [{ swapInfo: { ammKey: 'amm-1' } }],
      },
    });

    await evaluateQuoteGate('TokenMint1111111111111111111111111111111111', 1, {
      jupiterApiUrl: 'https://api.jup.ag',
    });

    expect(mockAxiosGet).toHaveBeenCalledWith(
      'https://lite-api.jup.ag/swap/v1/quote',
      expect.objectContaining({
        headers: {},
      })
    );
  });

  it('uses keyed swap path and API key header when configured', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        outAmount: '123456',
        priceImpactPct: '0.1',
        routePlan: [{ swapInfo: { ammKey: 'amm-1' } }],
      },
    });

    await evaluateQuoteGate('TokenMint1111111111111111111111111111111111', 1, {
      jupiterApiUrl: 'https://api.jup.ag',
      jupiterApiKey: 'test-key',
    });

    expect(mockAxiosGet).toHaveBeenCalledWith(
      'https://api.jup.ag/swap/v1/quote',
      expect.objectContaining({
        headers: {
          'X-API-Key': 'test-key',
        },
      })
    );
  });
});
