import axios from 'axios';
import { GeckoTerminalClient } from '../src/ingester/geckoTerminalClient';

jest.mock('axios', () => {
  const create = jest.fn();

  class AxiosError extends Error {
    response?: { status: number };

    constructor(message: string, status?: number) {
      super(message);
      if (status !== undefined) {
        this.response = { status };
      }
    }
  }

  return {
    __esModule: true,
    default: { create },
    AxiosError,
  };
});

describe('GeckoTerminalClient', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('serializes concurrent OHLCV requests through a shared queue', async () => {
    const get = jest.fn().mockResolvedValue({
      data: {
        data: {
          attributes: {
            ohlcv_list: [
              [60, 1, 1, 1, 1, 100],
            ],
          },
        },
      },
    });

    (axios.create as jest.Mock).mockReturnValue({ get });

    const client = new GeckoTerminalClient();

    const first = client.getOHLCV('pool-1', '1m', 0, 60);
    await jest.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);

    const second = client.getOHLCV('pool-2', '1m', 0, 60);
    await jest.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(3_000);
    expect(get).toHaveBeenCalledTimes(2);

    await Promise.all([first, second]);
  });

  it('deduplicates concurrent trending token fetches', async () => {
    const get = jest.fn().mockResolvedValue({
      data: {
        data: [{
          attributes: {
            name: 'AAA/USDC',
            reserve_in_usd: '100000',
            volume_usd: { h24: '200000' },
            transactions: { h24: { buys: 5, sells: 3 } },
          },
          relationships: {
            base_token: { data: { id: 'solana_mint-a' } },
          },
        }],
        included: [{
          id: 'solana_mint-a',
          attributes: { symbol: 'AAA', address: 'mint-a', name: 'AAA' },
        }],
      },
    });

    (axios.create as jest.Mock).mockReturnValue({ get });

    const client = new GeckoTerminalClient();

    const first = client.getTrendingTokens(20);
    const second = client.getTrendingTokens(20);
    await jest.advanceTimersByTimeAsync(0);

    const [a, b] = await Promise.all([first, second]);

    expect(get).toHaveBeenCalledTimes(1);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
