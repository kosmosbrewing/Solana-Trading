/**
 * Missed Alpha Observer tests (2026-04-22, mission-refinement P0+P2)
 *
 * 설계 anchor: src/observability/missedAlphaObserver.ts
 * - reject event 를 T+60s/300s/1800s 에 Jupiter quote 로 관측 → JSONL append.
 * - dedup 창 내 중복 tokenMint 는 drop.
 * - 하드 inflight cap 초과 시 drop.
 * - env kill-switch (enabled=false) 시 no-op.
 * - Jupiter 429 시 쓰이는 cooldown 동안 관측 skip 하고 기록 status='rate_limited'.
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

const mockAppendFile = jest.fn().mockResolvedValue(undefined);
const mockMkdir = jest.fn().mockResolvedValue(undefined);
jest.mock('fs/promises', () => ({
  appendFile: (...args: unknown[]) => mockAppendFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

import {
  trackRejectForMissedAlpha,
  resetMissedAlphaObserverState,
  getMissedAlphaObserverStats,
  type MissedAlphaObserverConfig,
} from '../src/observability/missedAlphaObserver';

const BASE_CFG: Partial<MissedAlphaObserverConfig> = {
  enabled: true,
  offsetsSec: [60, 300, 1800],
  jitterPct: 0, // tests 에서는 deterministic
  maxInflight: 50,
  dedupWindowSec: 30,
  outputFile: '/tmp/missed-alpha-test.jsonl',
  jupiterApiUrl: 'https://api.test/swap/v1',
  timeoutMs: 5_000,
  slippageBps: 200,
  rateLimitCooldownMs: 5_000,
};

async function flushAsync(): Promise<void> {
  // Fake timer + async chain: microtask 를 N번 손으로 돌려준다 (setImmediate 도 fake 라 못 씀).
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

describe('missedAlphaObserver', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    resetMissedAlphaObserverState();
  });
  afterEach(() => {
    jest.useRealTimers();
    resetMissedAlphaObserverState();
  });

  it('schedules N probes per reject event (one per offset)', () => {
    trackRejectForMissedAlpha(
      {
        rejectCategory: 'entry_drift',
        rejectReason: 'test',
        tokenMint: 'Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump',
        lane: 'pure_ws_breakout',
        signalPrice: 0.003,
        probeSolAmount: 0.01,
      },
      BASE_CFG
    );
    const stats = getMissedAlphaObserverStats();
    expect(stats.scheduled).toBe(3);
    expect(stats.inflight).toBe(3);
  });

  it('writes one JSONL record per probe tick with computed deltaPct (winner miss)', async () => {
    // signal 0.003, T+60s pool price 0.006 (+100%) — 우리가 놓친 winner.
    // probeSol 0.01 / outUi 1.6666... → observedPrice 0.006.
    mockAxiosGet.mockResolvedValue({
      data: {
        outAmount: (1.6666667 * 1e6).toFixed(0), // decimals 6 → 1.6666 UI tokens
        outputDecimals: 6,
      },
    });

    trackRejectForMissedAlpha(
      {
        rejectCategory: 'entry_drift',
        rejectReason: 'suspicious_favorable_drift',
        tokenMint: 'MINT11111111111111111111111111111111111111',
        lane: 'pure_ws_breakout',
        signalPrice: 0.003,
        probeSolAmount: 0.01,
        tokenDecimals: 6,
      },
      { ...BASE_CFG, offsetsSec: [60] }
    );

    await jest.advanceTimersByTimeAsync(61_000);
    await flushAsync();

    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    const [, payload] = mockAppendFile.mock.calls[0];
    const record = JSON.parse(String(payload).trim());
    expect(record.tokenMint).toBe('MINT11111111111111111111111111111111111111');
    expect(record.rejectCategory).toBe('entry_drift');
    expect(record.probe.offsetSec).toBe(60);
    expect(record.probe.quoteStatus).toBe('ok');
    // observedPrice ≈ 0.006, deltaPct = (0.006 - 0.003)/0.003 = +1.0
    expect(record.probe.observedPrice).toBeCloseTo(0.006, 4);
    expect(record.probe.deltaPct).toBeCloseTo(1.0, 2);
  });

  it('drops duplicate tokenMint within dedup window', () => {
    const event = {
      rejectCategory: 'survival' as const,
      rejectReason: 'top_holder',
      tokenMint: 'DUPEMINT1111111111111111111111111111111111',
      lane: 'pure_ws_breakout',
      signalPrice: 0.01,
      probeSolAmount: 0.01,
    };

    trackRejectForMissedAlpha(event, { ...BASE_CFG, offsetsSec: [60] });
    trackRejectForMissedAlpha(event, { ...BASE_CFG, offsetsSec: [60] });
    trackRejectForMissedAlpha(event, { ...BASE_CFG, offsetsSec: [60] });

    const stats = getMissedAlphaObserverStats();
    expect(stats.scheduled).toBe(1); // 두 번째·세 번째 호출은 dedup 으로 drop.
    expect(stats.inflight).toBe(1);
  });

  it('is a no-op when enabled=false', () => {
    trackRejectForMissedAlpha(
      {
        rejectCategory: 'entry_drift',
        rejectReason: 'x',
        tokenMint: 'OFFMINT1111111111111111111111111111111111',
        lane: 'pure_ws_breakout',
        signalPrice: 0.01,
        probeSolAmount: 0.01,
      },
      { ...BASE_CFG, enabled: false }
    );
    expect(getMissedAlphaObserverStats().scheduled).toBe(0);
  });

  it('drops event when inflight + offsets would exceed maxInflight', () => {
    // maxInflight=4, offsets 3 → 첫 이벤트 OK (3 inflight). 두 번째는 3+3=6 > 4 → drop.
    const makeEvent = (id: string) => ({
      rejectCategory: 'survival' as const,
      rejectReason: 'x',
      tokenMint: id.padEnd(44, '1'),
      lane: 'pure_ws_breakout',
      signalPrice: 0.01,
      probeSolAmount: 0.01,
    });
    trackRejectForMissedAlpha(makeEvent('A'), { ...BASE_CFG, maxInflight: 4 });
    trackRejectForMissedAlpha(makeEvent('B'), { ...BASE_CFG, maxInflight: 4 });
    expect(getMissedAlphaObserverStats().scheduled).toBe(3);
  });

  it('records quoteStatus=rate_limited and trips observer cooldown on 429', async () => {
    const err = Object.assign(new Error('Request failed with status code 429'), {
      response: { status: 429 },
    });
    mockAxiosGet.mockRejectedValue(err);

    // offsets 60, 62 → 간격 2s. cooldown 5s 안에 두 번째 probe firing → HTTP skip 예상.
    trackRejectForMissedAlpha(
      {
        rejectCategory: 'entry_drift',
        rejectReason: 'x',
        tokenMint: 'MINT429111111111111111111111111111111111111',
        lane: 'pure_ws_breakout',
        signalPrice: 0.003,
        probeSolAmount: 0.01,
      },
      { ...BASE_CFG, offsetsSec: [60, 62], rateLimitCooldownMs: 5_000 }
    );

    await jest.advanceTimersByTimeAsync(61_000);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(2_000);
    await flushAsync();

    expect(mockAppendFile).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(mockAppendFile.mock.calls[0][1]).trim());
    const second = JSON.parse(String(mockAppendFile.mock.calls[1][1]).trim());
    expect(first.probe.quoteStatus).toBe('rate_limited');
    // 두 번째 probe 는 cooldown 이 열려있는 동안 firing 됨 → 여전히 rate_limited.
    expect(second.probe.quoteStatus).toBe('rate_limited');
    expect(mockAxiosGet).toHaveBeenCalledTimes(1); // 쿨다운 때문에 두 번째 probe 는 HTTP 호출 skip.
  });

  it('records no_route when Jupiter returns empty quote', async () => {
    mockAxiosGet.mockResolvedValue({ data: {} });

    trackRejectForMissedAlpha(
      {
        rejectCategory: 'viability',
        rejectReason: 'no_route_upstream',
        tokenMint: 'MINTNOROUTE1111111111111111111111111111111',
        lane: 'pure_ws_breakout',
        signalPrice: 0.01,
        probeSolAmount: 0.01,
      },
      { ...BASE_CFG, offsetsSec: [60] }
    );
    await jest.advanceTimersByTimeAsync(61_000);
    await flushAsync();

    const record = JSON.parse(String(mockAppendFile.mock.calls[0][1]).trim());
    expect(record.probe.quoteStatus).toBe('no_route');
    expect(record.probe.observedPrice).toBeNull();
    expect(record.probe.deltaPct).toBeNull();
  });

  it('safely serializes Infinity / NaN / BigInt in extras', async () => {
    mockAxiosGet.mockResolvedValue({ data: { outAmount: '1000000', outputDecimals: 6 } });

    trackRejectForMissedAlpha(
      {
        rejectCategory: 'sell_quote_probe',
        rejectReason: 'impact_too_high',
        tokenMint: 'MINTEDGE1111111111111111111111111111111111',
        lane: 'pure_ws_breakout',
        signalPrice: 0.01,
        probeSolAmount: 0.01,
        tokenDecimals: 6,
        extras: {
          roundTripPct: Number.POSITIVE_INFINITY, // sellQuoteProbe 경계 케이스
          impactPct: Number.NaN,
          rawOut: BigInt(123456789012345),
        },
      },
      { ...BASE_CFG, offsetsSec: [60] }
    );
    await jest.advanceTimersByTimeAsync(61_000);
    await flushAsync();

    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    const raw = String(mockAppendFile.mock.calls[0][1]);
    expect(() => JSON.parse(raw.trim())).not.toThrow();
    const record = JSON.parse(raw.trim());
    expect(record.extras.roundTripPct).toBeNull();
    expect(record.extras.impactPct).toBeNull();
    expect(record.extras.rawOut).toBe('123456789012345');
  });

  it('accepts post-entry close categories (P2-1b extension)', async () => {
    // close-site category 5개 — probe_hard_cut / probe_reject_timeout / probe_flat_cut /
    // quick_reject_classifier_exit / hold_phase_sentinel_degraded_exit
    mockAxiosGet.mockResolvedValue({ data: { outAmount: '2000000', outputDecimals: 6 } });

    trackRejectForMissedAlpha(
      {
        rejectCategory: 'probe_reject_timeout',
        rejectReason: 'flat_timeout@30s',
        tokenMint: 'MINTCLOSE11111111111111111111111111111111',
        lane: 'pure_ws_breakout',
        signalPrice: 0.003,
        probeSolAmount: 0.01,
        tokenDecimals: 6,
        extras: {
          closeState: 'PROBE',
          elapsedSecAtClose: 31,
          mfePctAtClose: 0.02,
          maePctAtClose: -0.005,
        },
      },
      { ...BASE_CFG, offsetsSec: [60] }
    );
    await jest.advanceTimersByTimeAsync(61_000);
    await flushAsync();

    const record = JSON.parse(String(mockAppendFile.mock.calls[0][1]).trim());
    expect(record.rejectCategory).toBe('probe_reject_timeout');
    expect(record.extras.closeState).toBe('PROBE');
    expect(record.extras.elapsedSecAtClose).toBe(31);
    // observedPrice = 0.01 / 2.0 = 0.005. deltaPct = (0.005 - 0.003)/0.003 = +0.667 (아직 냠 가능했던 winner)
    expect(record.probe.deltaPct).toBeCloseTo(0.667, 2);
  });

  it('rejects invalid input silently (no schedule, no throw)', () => {
    expect(() =>
      trackRejectForMissedAlpha(
        {
          rejectCategory: 'entry_drift',
          rejectReason: 'x',
          tokenMint: '',
          lane: 'pure_ws_breakout',
          signalPrice: 0,
          probeSolAmount: 0,
        },
        BASE_CFG
      )
    ).not.toThrow();
    expect(getMissedAlphaObserverStats().scheduled).toBe(0);
  });
});
