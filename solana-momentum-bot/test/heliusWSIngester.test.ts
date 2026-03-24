const mockOnLogs = jest.fn();
const mockRemoveOnLogsListener = jest.fn();
const mockGetParsedTransaction = jest.fn();
const mockGetParsedTransactions = jest.fn();
const mockGetAccountInfo = jest.fn();
const mockGetParsedAccountInfo = jest.fn();

jest.mock('@solana/web3.js', () => {
  class PublicKey {
    constructor(private readonly value: string) {}

    toBase58(): string {
      return this.value;
    }
  }

  class Connection {
    onLogs = mockOnLogs;
    removeOnLogsListener = mockRemoveOnLogsListener;
    getParsedTransaction = mockGetParsedTransaction;
    getParsedTransactions = mockGetParsedTransactions;
    getAccountInfo = mockGetAccountInfo;
    getParsedAccountInfo = mockGetParsedAccountInfo;

    constructor(_url: string, _config: unknown) {}
  }

  return {
    Connection,
    PublicKey,
  };
});

import { HeliusWSIngester } from '../src/realtime';

interface HeliusTestInternals {
  enqueueFallback: (pool: string, signature: string, slot: number) => void;
  enrichSwapsFromTxBatch: (
    batch: Array<{ pool: string; signature: string; slot: number }>
  ) => Promise<Map<string, unknown>>;
}

describe('HeliusWSIngester', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockOnLogs.mockReturnValue(1);
    mockRemoveOnLogsListener.mockResolvedValue(undefined);
    mockGetParsedTransaction.mockResolvedValue(null);
    mockGetParsedTransactions.mockResolvedValue([null]);
    mockGetAccountInfo.mockResolvedValue(null);
    mockGetParsedAccountInfo.mockResolvedValue({ value: null });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reconnects active subscriptions when the watchdog detects a silent socket', async () => {
    const ingester = new HeliusWSIngester({
      rpcHttpUrl: 'https://rpc.example.com',
      rpcWsUrl: 'wss://rpc.example.com',
      maxSubscriptions: 4,
      watchdogIntervalMs: 1_000,
    });

    await ingester.subscribePools(['pool-1']);
    await jest.advanceTimersByTimeAsync(1_000);

    expect(mockRemoveOnLogsListener).toHaveBeenCalledWith(1);
    expect(mockOnLogs).toHaveBeenCalledTimes(2);
  });

  it('retries fallback transaction fetches for transient fetch failures', async () => {
    const ingester = new HeliusWSIngester({
      rpcHttpUrl: 'https://rpc.example.com',
      rpcWsUrl: 'wss://rpc.example.com',
      maxSubscriptions: 4,
      fallbackConcurrency: 1,
      fallbackRequestsPerSecond: 10,
      fallbackBatchSize: 1,
      fallbackMaxRetries: 2,
      watchdogIntervalMs: 0,
    });
    const testIngester = ingester as unknown as HeliusTestInternals;
    const retries: Array<{ pool: string; signature: string; retries: number; delayMs: number }> = [];
    const errors: unknown[] = [];
    const results: Array<{ outcome: string }> = [];

    mockGetParsedTransaction
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(null);

    ingester.on('fallbackRetry', (event) => retries.push(event));
    ingester.on('error', ({ error }) => errors.push(error));
    ingester.on('fallbackResult', (event) => results.push(event));

    testIngester.enqueueFallback('pool-1', 'sig-1', 123);
    await jest.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(retries).toHaveLength(1);
    expect(retries[0]).toEqual(expect.objectContaining({
      pool: 'pool-1',
      signature: 'sig-1',
      retries: 1,
      delayMs: 1_000,
    }));
    expect(errors).toHaveLength(0);
    expect(results).toContainEqual(expect.objectContaining({ outcome: 'unparsed' }));
  });

  it('suppresses single-request fallback when batch parsed transactions are unavailable', async () => {
    const ingester = new HeliusWSIngester({
      rpcHttpUrl: 'https://rpc.example.com',
      rpcWsUrl: 'wss://rpc.example.com',
      maxSubscriptions: 4,
      fallbackConcurrency: 1,
      fallbackRequestsPerSecond: 10,
      fallbackBatchSize: 2,
      fallbackMaxRetries: 0,
      disableSingleTxFallbackOnBatchUnsupported: true,
      watchdogIntervalMs: 0,
    });
    const testIngester = ingester as unknown as HeliusTestInternals;

    mockGetParsedTransactions.mockRejectedValueOnce(
      new Error('Batch requests are only available for paid plans')
    );

    const results = await testIngester.enrichSwapsFromTxBatch([
      { pool: 'pool-1', signature: 'sig-1', slot: 123 },
      { pool: 'pool-1', signature: 'sig-2', slot: 124 },
    ]);

    expect(mockGetParsedTransactions).toHaveBeenCalledTimes(1);
    expect(mockGetParsedTransaction).not.toHaveBeenCalled();
    expect(results.get('pool-1:sig-1')).toBeNull();
    expect(results.get('pool-1:sig-2')).toBeNull();
  });
});
