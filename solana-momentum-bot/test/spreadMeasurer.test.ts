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

import { SpreadMeasurer } from '../src/gate/spreadMeasurer';

describe('spreadMeasurer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes legacy quote host to keyless swap path for buy and sell quotes', async () => {
    mockAxiosGet
      .mockResolvedValueOnce({
        data: {
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: 'TokenMint1111111111111111111111111111111111',
          inAmount: '100000000',
          outAmount: '500000000',
          priceImpactPct: '0.2',
          routePlan: [{ swapInfo: { ammKey: 'amm-1', feeAmount: '1000', inAmount: '100000000' } }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: 'TokenMint1111111111111111111111111111111111',
          inAmount: '100000000',
          outAmount: '500000000',
          priceImpactPct: '0.2',
          routePlan: [{ swapInfo: { ammKey: 'amm-1', feeAmount: '1000', inAmount: '100000000' } }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          inputMint: 'TokenMint1111111111111111111111111111111111',
          outputMint: 'So11111111111111111111111111111111111111112',
          inAmount: '500000000',
          outAmount: '99000000',
          priceImpactPct: '0.3',
          routePlan: [{ swapInfo: { ammKey: 'amm-1', feeAmount: '1000', inAmount: '500000000' } }],
        },
      });

    const measurer = new SpreadMeasurer({
      jupiterApiUrl: 'https://quote-api.jup.ag/v6',
    });

    const result = await measurer.measure('TokenMint1111111111111111111111111111111111');

    expect(result).not.toBeNull();
    expect(mockAxiosGet).toHaveBeenNthCalledWith(
      1,
      'https://lite-api.jup.ag/swap/v1/quote',
      expect.any(Object)
    );
    expect(mockAxiosGet).toHaveBeenNthCalledWith(
      2,
      'https://lite-api.jup.ag/swap/v1/quote',
      expect.any(Object)
    );
    expect(mockAxiosGet).toHaveBeenNthCalledWith(
      3,
      'https://lite-api.jup.ag/swap/v1/quote',
      expect.any(Object)
    );
  });

  it('uses keyed swap path and API key header when configured', async () => {
    mockAxiosGet
      .mockResolvedValueOnce({
        data: {
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: 'TokenMint1111111111111111111111111111111111',
          inAmount: '100000000',
          outAmount: '500000000',
          priceImpactPct: '0.2',
          routePlan: [{ swapInfo: { ammKey: 'amm-1', feeAmount: '1000', inAmount: '100000000' } }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: 'TokenMint1111111111111111111111111111111111',
          inAmount: '100000000',
          outAmount: '500000000',
          priceImpactPct: '0.2',
          routePlan: [{ swapInfo: { ammKey: 'amm-1', feeAmount: '1000', inAmount: '100000000' } }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          inputMint: 'TokenMint1111111111111111111111111111111111',
          outputMint: 'So11111111111111111111111111111111111111112',
          inAmount: '500000000',
          outAmount: '99000000',
          priceImpactPct: '0.3',
          routePlan: [{ swapInfo: { ammKey: 'amm-1', feeAmount: '1000', inAmount: '500000000' } }],
        },
      });

    const measurer = new SpreadMeasurer({
      jupiterApiUrl: 'https://api.jup.ag',
      jupiterApiKey: 'test-key',
    });

    await measurer.measure('TokenMint1111111111111111111111111111111111');

    expect(mockAxiosGet).toHaveBeenNthCalledWith(
      1,
      'https://api.jup.ag/swap/v1/quote',
      expect.objectContaining({
        headers: {
          'X-API-Key': 'test-key',
        },
      })
    );
  });
});
