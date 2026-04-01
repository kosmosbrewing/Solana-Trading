const mockOnLogs = jest.fn();
const mockRemoveOnLogsListener = jest.fn();
const mockGetParsedTransaction = jest.fn();
const mockGetMultipleAccountsInfo = jest.fn();

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
    getMultipleAccountsInfo = mockGetMultipleAccountsInfo;

    constructor(_url: string, _config: unknown) {}
  }

  return {
    Connection,
    PublicKey,
  };
});

import { HeliusPoolDiscovery } from '../src/realtime';

describe('HeliusPoolDiscovery', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockOnLogs.mockReturnValue(1);
    mockRemoveOnLogsListener.mockResolvedValue(undefined);
    mockGetMultipleAccountsInfo.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('backs off queued discovery fetches after a rate-limit error', async () => {
    const discovery = new HeliusPoolDiscovery({
      rpcHttpUrl: 'https://rpc.example.com',
      rpcWsUrl: 'wss://rpc.example.com',
      programIds: ['program-1'],
      concurrency: 1,
      requestSpacingMs: 0,
      rateLimitCooldownMs: 1_000,
      transientFailureCooldownMs: 100,
    });
    const errors: Array<{ rateLimited?: boolean; cooldownMs?: number }> = [];

    mockGetParsedTransaction
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockResolvedValueOnce(null);

    discovery.on('error', (event) => errors.push(event));

    await discovery.start();
    const onLogsHandler = mockOnLogs.mock.calls[0][1];

    onLogsHandler({
      err: null,
      logs: ['Instruction: Initialize pool'],
      signature: 'sig-1',
    }, { slot: 1 });
    onLogsHandler({
      err: null,
      logs: ['Instruction: Initialize pool'],
      signature: 'sig-2',
    }, { slot: 2 });

    await jest.advanceTimersByTimeAsync(0);
    expect(mockGetParsedTransaction).toHaveBeenCalledTimes(1);
    expect(errors[0]).toEqual(expect.objectContaining({
      rateLimited: true,
      cooldownMs: 1_000,
    }));

    await jest.advanceTimersByTimeAsync(999);
    expect(mockGetParsedTransaction).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(mockGetParsedTransaction).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest queued discovery when the queue is saturated', async () => {
    const discovery = new HeliusPoolDiscovery({
      rpcHttpUrl: 'https://rpc.example.com',
      rpcWsUrl: 'wss://rpc.example.com',
      programIds: ['program-1'],
      concurrency: 1,
      requestSpacingMs: 1_000,
      queueLimit: 2,
    });

    mockGetParsedTransaction.mockResolvedValue(null);
    const capacityEvents: Array<{ source?: string; reason?: string; detail?: string }> = [];

    discovery.on('capacity', (event) => capacityEvents.push(event));
    await discovery.start();
    const onLogsHandler = mockOnLogs.mock.calls[0][1];

    onLogsHandler({
      err: null,
      logs: ['Instruction: Initialize pool'],
      signature: 'sig-1',
    }, { slot: 1 });
    onLogsHandler({
      err: null,
      logs: ['Instruction: Initialize pool'],
      signature: 'sig-2',
    }, { slot: 2 });
    onLogsHandler({
      err: null,
      logs: ['Instruction: Initialize pool'],
      signature: 'sig-3',
    }, { slot: 3 });
    onLogsHandler({
      err: null,
      logs: ['Instruction: Initialize pool'],
      signature: 'sig-4',
    }, { slot: 4 });

    await jest.advanceTimersByTimeAsync(0);
    expect(mockGetParsedTransaction).toHaveBeenCalledTimes(1);
    expect(mockGetParsedTransaction).toHaveBeenNthCalledWith(1, 'sig-1', expect.any(Object));

    await jest.advanceTimersByTimeAsync(1_000);
    expect(mockGetParsedTransaction).toHaveBeenCalledTimes(2);
    expect(mockGetParsedTransaction).toHaveBeenNthCalledWith(2, 'sig-3', expect.any(Object));

    await jest.advanceTimersByTimeAsync(1_000);
    expect(mockGetParsedTransaction).toHaveBeenCalledTimes(3);
    expect(mockGetParsedTransaction).toHaveBeenNthCalledWith(3, 'sig-4', expect.any(Object));
    expect(capacityEvents).toEqual([
      expect.objectContaining({
        source: 'helius_pool_discovery',
        reason: 'queue_overflow',
      }),
    ]);
  });
});
