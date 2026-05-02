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

const mockAppendFile = jest.fn().mockResolvedValue(undefined);
const mockMkdir = jest.fn().mockResolvedValue(undefined);
const mockReadFile = jest.fn();
jest.mock('fs/promises', () => ({
  appendFile: (...args: unknown[]) => mockAppendFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

import {
  getTradeMarkoutObserverStats,
  hydrateTradeMarkoutSchedulesFromLedger,
  resetTradeMarkoutObserverState,
  trackTradeMarkout,
  type TradeMarkoutObserverConfig,
} from '../src/observability/tradeMarkoutObserver';

const BASE_CFG: Partial<TradeMarkoutObserverConfig> = {
  enabled: true,
  offsetsSec: [30],
  jitterPct: 0,
  maxInflight: 10,
  dedupWindowSec: 30,
  outputFile: '/tmp/trade-markouts.jsonl',
  jupiterApiUrl: 'https://api.test/swap/v1',
  timeoutMs: 5_000,
  slippageBps: 200,
  rateLimitCooldownMs: 5_000,
};

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('tradeMarkoutObserver', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-02T01:00:00.000Z'));
    jest.clearAllMocks();
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    resetTradeMarkoutObserverState();
  });

  afterEach(() => {
    jest.useRealTimers();
    resetTradeMarkoutObserverState();
  });

  it('records a buy markout row at the configured horizon', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        outAmount: String(2_000_000), // 2 tokens at 6 decimals
        outputDecimals: 6,
      },
    });

    trackTradeMarkout(
      {
        anchorType: 'buy',
        positionId: 'pos-1',
        tokenMint: 'Mint111111111111111111111111111111111111',
        anchorTxSignature: 'entry-sig',
        anchorAtMs: Date.now(),
        anchorPrice: 0.01,
        anchorPriceKind: 'entry_token_only',
        probeSolAmount: 0.02,
        tokenDecimals: 6,
      },
      BASE_CFG,
    );

    expect(getTradeMarkoutObserverStats().scheduled).toBe(1);
    await jest.advanceTimersByTimeAsync(30_001);
    await flushAsync();

    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    const [, payload] = mockAppendFile.mock.calls[0];
    const record = JSON.parse(String(payload).trim());
    expect(record.schemaVersion).toBe('trade-markout/v1');
    expect(record.anchorType).toBe('buy');
    expect(record.positionId).toBe('pos-1');
    expect(record.horizonSec).toBe(30);
    expect(record.quoteStatus).toBe('ok');
    expect(record.observedPrice).toBeCloseTo(0.01);
    expect(record.deltaPct).toBeCloseTo(0);
  });

  it('falls back to anchor tokenDecimals when Jupiter omits outputDecimals', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { outAmount: String(4_000_000) },
    });

    trackTradeMarkout(
      {
        anchorType: 'sell',
        positionId: 'pos-2',
        tokenMint: 'Mint222222222222222222222222222222222222',
        anchorTxSignature: 'exit-sig',
        anchorAtMs: Date.now(),
        anchorPrice: 0.01,
        anchorPriceKind: 'exit_token_only',
        probeSolAmount: 0.02,
        tokenDecimals: 6,
      },
      BASE_CFG,
    );

    await jest.advanceTimersByTimeAsync(30_001);
    await flushAsync();

    const [, payload] = mockAppendFile.mock.calls[0];
    const record = JSON.parse(String(payload).trim());
    expect(record.quoteStatus).toBe('ok');
    expect(record.outputDecimals).toBe(6);
    expect(record.observedPrice).toBeCloseTo(0.005);
    expect(record.deltaPct).toBeCloseTo(-0.5);
  });

  it('keeps separate markouts for multiple sell anchors on one position', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { outAmount: String(2_000_000), outputDecimals: 6 },
    });

    for (const sig of ['sell-sig-1', 'sell-sig-2']) {
      trackTradeMarkout(
        {
          anchorType: 'sell',
          positionId: 'pos-multi-sell',
          tokenMint: 'Mint333333333333333333333333333333333333',
          anchorTxSignature: sig,
          anchorAtMs: Date.now(),
          anchorPrice: 0.01,
          anchorPriceKind: 'exit_token_only',
          probeSolAmount: 0.02,
          tokenDecimals: 6,
        },
        BASE_CFG,
      );
    }

    expect(getTradeMarkoutObserverStats().scheduled).toBe(2);
    await jest.advanceTimersByTimeAsync(30_001);
    await flushAsync();

    expect(mockAppendFile).toHaveBeenCalledTimes(2);
    const records = mockAppendFile.mock.calls.map(([, payload]) => JSON.parse(String(payload).trim()));
    expect(records.map((row) => row.anchorTxSignature).sort()).toEqual(['sell-sig-1', 'sell-sig-2']);
  });

  it('retries inflight-cap probes instead of writing a final rate_limited row immediately', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    mockAxiosGet
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({
        data: { outAmount: String(2_000_000), outputDecimals: 6 },
      });

    for (const positionId of ['pos-cap-1', 'pos-cap-2']) {
      trackTradeMarkout(
        {
          anchorType: 'buy',
          positionId,
          tokenMint: 'MintCap111111111111111111111111111111111',
          anchorTxSignature: `${positionId}-sig`,
          anchorAtMs: Date.now(),
          anchorPrice: 0.01,
          anchorPriceKind: 'entry_token_only',
          probeSolAmount: 0.02,
          tokenDecimals: 6,
        },
        { ...BASE_CFG, maxInflight: 1 },
      );
    }

    await jest.advanceTimersByTimeAsync(30_001);
    await flushAsync();

    expect(mockAppendFile).not.toHaveBeenCalled();
    expect(getTradeMarkoutObserverStats().scheduled).toBe(1);

    resolveFirst({
      data: { outAmount: String(2_000_000), outputDecimals: 6 },
    });
    await flushAsync();
    expect(mockAppendFile).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5_001);
    await flushAsync();

    expect(mockAppendFile).toHaveBeenCalledTimes(2);
    const records = mockAppendFile.mock.calls.map(([, payload]) => JSON.parse(String(payload).trim()));
    expect(records.every((row) => row.quoteStatus === 'ok')).toBe(true);
    expect(records.some((row) => row.quoteReason === 'observer_inflight_cap')).toBe(false);
  });

  it('writes observer_inflight_cap_exhausted after retry window is exhausted', async () => {
    mockAxiosGet.mockImplementationOnce(() => new Promise(() => {}));

    for (const positionId of ['pos-exhaust-hold', 'pos-exhaust-cap']) {
      trackTradeMarkout(
        {
          anchorType: 'buy',
          positionId,
          tokenMint: 'MintCap222222222222222222222222222222222',
          anchorTxSignature: `${positionId}-sig`,
          anchorAtMs: Date.now(),
          anchorPrice: 0.01,
          anchorPriceKind: 'entry_token_only',
          probeSolAmount: 0.02,
          tokenDecimals: 6,
        },
        { ...BASE_CFG, maxInflight: 1 },
      );
    }

    await jest.advanceTimersByTimeAsync(30_001);
    await flushAsync();
    expect(mockAppendFile).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(35_001);
    await flushAsync();

    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(mockAppendFile.mock.calls[0][1]).trim());
    expect(record.positionId).toBe('pos-exhaust-cap');
    expect(record.quoteStatus).toBe('rate_limited');
    expect(record.quoteReason).toBe('observer_inflight_cap_exhausted');
  });

  it('does not hydrate exhausted rate-limited rows as retryable existing markouts', async () => {
    mockReadFile.mockImplementation(async (file: string) => {
      if (file.endsWith('executed-buys.jsonl')) {
        return JSON.stringify({
          strategy: 'kol_hunter',
          positionId: 'pos-exhausted-existing',
          pairAddress: 'MintExhausted111111111111111111111111',
          txSignature: 'buy-sig-exhausted',
          recordedAt: '2026-05-02T00:59:30.000Z',
          buyCompletedAtMs: Date.parse('2026-05-02T00:59:30.000Z'),
          actualEntryPrice: 0.01,
          entryPriceTokenOnly: 0.01,
          swapInputUiAmount: 0.02,
          outputDecimals: 6,
        }) + '\n';
      }
      if (file.endsWith('trade-markouts.jsonl')) {
        return JSON.stringify({
          positionId: 'pos-exhausted-existing',
          anchorType: 'buy',
          anchorTxSignature: 'buy-sig-exhausted',
          anchorAt: '2026-05-02T00:59:30.000Z',
          horizonSec: 30,
          quoteStatus: 'rate_limited',
          quoteReason: 'observer_inflight_cap_exhausted',
          recordedAt: '2026-05-02T01:01:00.000Z',
        }) + '\n';
      }
      return '';
    });

    const summary = await hydrateTradeMarkoutSchedulesFromLedger({
      realtimeDir: '/tmp/realtime',
      config: BASE_CFG,
      lookbackHours: 2,
    });

    expect(summary.loadedBuys).toBe(1);
    expect(summary.skippedExisting).toBe(1);
    expect(summary.scheduled).toBe(0);
  });

  it('writes an anchor ledger row before delayed markout probes', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { outAmount: String(2_000_000), outputDecimals: 6 },
    });

    trackTradeMarkout(
      {
        anchorType: 'buy',
        positionId: 'paper-open-pos',
        tokenMint: 'MintOpen11111111111111111111111111111111',
        anchorAtMs: Date.now(),
        anchorPrice: 0.01,
        anchorPriceKind: 'entry_token_only',
        probeSolAmount: 0.02,
        tokenDecimals: 6,
        extras: { mode: 'paper', eventType: 'paper_entry' },
      },
      { ...BASE_CFG, anchorOutputFile: '/tmp/trade-markout-anchors.jsonl' },
    );

    await flushAsync();
    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    expect(String(mockAppendFile.mock.calls[0][0])).toContain('trade-markout-anchors.jsonl');
    const anchorRecord = JSON.parse(String(mockAppendFile.mock.calls[0][1]).trim());
    expect(anchorRecord.schemaVersion).toBe('trade-markout-anchor/v1');
    expect(anchorRecord.extras.eventType).toBe('paper_entry');

    await jest.advanceTimersByTimeAsync(30_001);
    await flushAsync();
    expect(mockAppendFile).toHaveBeenCalledTimes(2);
    expect(String(mockAppendFile.mock.calls[1][0])).toContain('trade-markouts.jsonl');
  });

  it('hydrates open paper entry anchors from the anchor ledger', async () => {
    mockReadFile.mockImplementation(async (file: string) => {
      if (file.endsWith('trade-markout-anchors.jsonl')) {
        return JSON.stringify({
          schemaVersion: 'trade-markout-anchor/v1',
          anchorType: 'buy',
          positionId: 'paper-open-pos',
          tokenMint: 'MintOpen11111111111111111111111111111111',
          anchorAt: '2026-05-02T00:59:40.000Z',
          anchorPrice: 0.01,
          anchorPriceKind: 'entry_token_only',
          probeSolAmount: 0.02,
          tokenDecimals: 6,
          extras: { mode: 'paper', eventType: 'paper_entry' },
        }) + '\n';
      }
      return '';
    });
    mockAxiosGet.mockResolvedValue({
      data: { outAmount: String(2_000_000), outputDecimals: 6 },
    });

    const summary = await hydrateTradeMarkoutSchedulesFromLedger({
      realtimeDir: '/tmp/realtime',
      config: { ...BASE_CFG, anchorOutputFile: '/tmp/realtime/trade-markout-anchors.jsonl' },
      lookbackHours: 2,
    });

    expect(summary.loadedAnchorRecords).toBe(1);
    expect(summary.scheduled).toBe(1);

    await jest.advanceTimersByTimeAsync(10_001);
    await flushAsync();

    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(mockAppendFile.mock.calls[0][1]).trim());
    expect(record.positionId).toBe('paper-open-pos');
    expect(record.anchorType).toBe('buy');
  });

  it('hydrates missing markouts from executed ledgers without duplicate existing rows', async () => {
    mockReadFile.mockImplementation(async (file: string) => {
      if (file.endsWith('executed-buys.jsonl')) {
        return JSON.stringify({
          strategy: 'kol_hunter',
          positionId: 'pos-buy',
          pairAddress: 'MintBuy11111111111111111111111111111111',
          txSignature: 'buy-sig',
          recordedAt: '2026-05-02T00:59:40.000Z',
          actualEntryPrice: 0.01,
          entryPriceTokenOnly: 0.01,
          swapInputUiAmount: 0.02,
          outputDecimals: 6,
        }) + '\n';
      }
      if (file.endsWith('executed-sells.jsonl')) {
        return JSON.stringify({
          strategy: 'kol_hunter',
          positionId: 'pos-sell',
          pairAddress: 'MintSell111111111111111111111111111111',
          txSignature: 'sell-sig',
          recordedAt: '2026-05-02T00:59:40.000Z',
          exitPriceTokenOnly: 0.01,
          swapInputSol: 0.02,
        }) + '\n';
      }
      if (file.endsWith('kol-live-trades.jsonl')) {
        return JSON.stringify({ positionId: 'pos-sell', tokenDecimals: 6 }) + '\n';
      }
      if (file.endsWith('trade-markouts.jsonl')) {
        return JSON.stringify({
          positionId: 'pos-buy',
          anchorType: 'buy',
          anchorTxSignature: 'buy-sig',
          anchorAt: '2026-05-02T00:59:40.000Z',
          horizonSec: 30,
        }) + '\n';
      }
      return '';
    });
    mockAxiosGet.mockResolvedValue({
      data: { outAmount: String(2_000_000), outputDecimals: 6 },
    });

    const summary = await hydrateTradeMarkoutSchedulesFromLedger({
      realtimeDir: '/tmp/realtime',
      config: BASE_CFG,
      lookbackHours: 2,
    });

    expect(summary.loadedBuys).toBe(1);
    expect(summary.loadedSells).toBe(1);
    expect(summary.skippedExisting).toBe(1);
    expect(summary.scheduled).toBe(1);

    await jest.advanceTimersByTimeAsync(10_001);
    await flushAsync();

    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    const [, payload] = mockAppendFile.mock.calls[0];
    const record = JSON.parse(String(payload).trim());
    expect(record.anchorType).toBe('sell');
    expect(record.positionId).toBe('pos-sell');
  });

  it('hydrates paper close and partial-take anchors', async () => {
    mockReadFile.mockImplementation(async (file: string) => {
      if (file.endsWith('kol-paper-trades.jsonl')) {
        return JSON.stringify({
          strategy: 'kol_hunter',
          positionId: 'paper-pos',
          tokenMint: 'MintPaper111111111111111111111111111111',
          closedAt: '2026-05-02T00:59:40.000Z',
          holdSec: 20,
          entryPriceTokenOnly: 0.01,
          exitPriceTokenOnly: 0.012,
          ticketSol: 0.02,
          tokenDecimals: 6,
          armName: 'kol_hunter_smart_v3',
        }) + '\n';
      }
      if (file.endsWith('kol-partial-takes.jsonl')) {
        return JSON.stringify({
          strategy: 'kol_hunter',
          positionId: 'paper-pos',
          tokenMint: 'MintPaper111111111111111111111111111111',
          promotedAt: '2026-05-02T00:59:50.000Z',
          exitPrice: 0.011,
          lockedTicketSol: 0.006,
          eventType: 'partial_take',
          armName: 'kol_hunter_smart_v3',
        }) + '\n';
      }
      return '';
    });
    mockAxiosGet.mockResolvedValue({
      data: { outAmount: String(2_000_000), outputDecimals: 6 },
    });

    const summary = await hydrateTradeMarkoutSchedulesFromLedger({
      realtimeDir: '/tmp/realtime',
      config: BASE_CFG,
      lookbackHours: 2,
    });

    expect(summary.loadedPaperCloses).toBe(1);
    expect(summary.loadedPartialTakes).toBe(1);
    expect(summary.scheduled).toBe(3);

    await jest.advanceTimersByTimeAsync(30_001);
    await flushAsync();

    expect(mockAppendFile).toHaveBeenCalledTimes(3);
    const records = mockAppendFile.mock.calls.map(([, payload]) => JSON.parse(String(payload).trim()));
    expect(records.map((row) => row.anchorType).sort()).toEqual(['buy', 'sell', 'sell']);
    expect(records.every((row) => row.positionId === 'paper-pos')).toBe(true);
  });
});
