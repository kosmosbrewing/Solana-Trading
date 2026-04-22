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
      reconnectCooldownMs: 0, // cooldown 비활성화하여 첫 reconnect 즉시 실행
    });

    await ingester.subscribePools(['pool-1']);
    await jest.advanceTimersByTimeAsync(1_000);

    expect(mockRemoveOnLogsListener).toHaveBeenCalledWith(1);
    expect(mockOnLogs).toHaveBeenCalledTimes(2);
  });

  it('[2026-04-21 P0] reconnect cooldown prevents back-to-back re-subscribes during idle watchlist', async () => {
    // 운영 관측: 60s watchdog + watchlist 전체 idle → 매 분 reconnect 루프 → subscription 소실.
    // cooldown 5분 이면 watchdog 이 두 번째 발화해도 재실행 skip.
    mockOnLogs.mockReturnValueOnce(10).mockReturnValueOnce(11);
    const ingester = new HeliusWSIngester({
      rpcHttpUrl: 'https://rpc.example.com',
      rpcWsUrl: 'wss://rpc.example.com',
      maxSubscriptions: 4,
      watchdogIntervalMs: 1_000,
      reconnectCooldownMs: 10_000, // 10초 쿨다운
    });

    await ingester.subscribePools(['pool-1']);

    // 첫 watchdog 발화 (1s) → reconnect 1회 발생
    await jest.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    const onLogsAfterFirst = mockOnLogs.mock.calls.length;
    expect(onLogsAfterFirst).toBe(2); // 초기 구독 1 + reconnect 1

    // 두 번째 watchdog 발화 (쿨다운 내) — reconnect skip, onLogs 호출 추가 없음
    await jest.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    // cooldown 안에서 추가 reconnect 없음
    expect(mockOnLogs).toHaveBeenCalledTimes(onLogsAfterFirst);
  });

  it('[2026-04-21 P0] reconnect race fix: subscription map cleared BEFORE new onLogs', async () => {
    // 이전 bug: await unsubscribePool (순차) → new onLogs 호출 → 일부 ID 가 map 에 섞임.
    // Fix: map 을 snapshot 후 먼저 clear → removeOnLogsListener 는 fire-and-forget.
    mockOnLogs.mockReturnValueOnce(100).mockReturnValueOnce(200);
    // removeOnLogsListener 는 느리게 resolve 하는 편 — race 재현
    let removeResolve: (() => void) | null = null;
    mockRemoveOnLogsListener.mockImplementationOnce(
      () => new Promise<void>((resolve) => { removeResolve = () => resolve(); })
    );

    const ingester = new HeliusWSIngester({
      rpcHttpUrl: 'https://rpc.example.com',
      rpcWsUrl: 'wss://rpc.example.com',
      maxSubscriptions: 4,
      watchdogIntervalMs: 1_000,
      reconnectCooldownMs: 0,
    });

    await ingester.subscribePools(['pool-1']);
    // 첫 watchdog 발화
    await jest.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    // reconnect 안에서 removeOnLogsListener 가 pending 이어도 subscribePools 가 진행되어
    // 새 onLogs 가 호출되고 map 에 등록됨 → 기존 ID 덮어쓰지 않음.
    expect(mockOnLogs).toHaveBeenCalledTimes(2);

    // 이제 remove resolve — "Ignored unsubscribe" 가 에러로 전파되지 않아야 함 (catch silenced)
    if (removeResolve) (removeResolve as () => void)();
    await Promise.resolve();
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
