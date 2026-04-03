import { Candle } from '../src/utils/types';
import { RealtimeSignalRecord } from '../src/reporting/realtimeMeasurement';
import { RealtimeSignalSink } from '../src/reporting/realtimeSignalLogger';
import { RealtimeOutcomeTracker } from '../src/reporting/realtimeOutcomeTracker';

// ─── Helpers ───

const BASE_TIME_SEC = 1000;

function makeRecord(overrides: Partial<Omit<RealtimeSignalRecord, 'horizons' | 'summary'>> = {}): Omit<RealtimeSignalRecord, 'horizons' | 'summary'> {
  return {
    version: 1,
    id: 'sig-1',
    source: 'runtime',
    strategy: 'volume_spike',
    pairAddress: 'pool-1',
    signalTimestamp: new Date(BASE_TIME_SEC * 1000).toISOString(),
    referencePrice: 1.0,
    estimatedCostPct: 0.01,
    trigger: {
      primaryIntervalSec: 15,
      confirmIntervalSec: 60,
      primaryCandleCloseSec: BASE_TIME_SEC,
    },
    gate: {
      startedAt: new Date(BASE_TIME_SEC * 1000).toISOString(),
      endedAt: new Date(BASE_TIME_SEC * 1000).toISOString(),
      latencyMs: 50,
      rejected: false,
    },
    processing: {
      startedAt: new Date(BASE_TIME_SEC * 1000).toISOString(),
      endedAt: new Date(BASE_TIME_SEC * 1000).toISOString(),
      latencyMs: 100,
      status: 'executed_paper',
    },
    ...overrides,
  };
}

function makeCandle(offsetSec: number, ohlcv: { open: number; high: number; low: number; close: number }): Candle {
  return {
    pairAddress: 'pool-1',
    timestamp: new Date((BASE_TIME_SEC + offsetSec) * 1000),
    intervalSec: 15,
    open: ohlcv.open,
    high: ohlcv.high,
    low: ohlcv.low,
    close: ohlcv.close,
    volume: 100,
    buyVolume: 60,
    sellVolume: 40,
    tradeCount: 10,
  };
}

class MockSink implements RealtimeSignalSink {
  records: RealtimeSignalRecord[] = [];
  async log(record: RealtimeSignalRecord): Promise<void> {
    this.records.push(record);
  }
}

// ─── Tests ───

describe('RealtimeOutcomeTracker', () => {
  it('computes MFE/MAE from candle.close, not high/low', async () => {
    const sink = new MockSink();
    const tracker = new RealtimeOutcomeTracker(
      { horizonsSec: [30], observationIntervalSec: 15 },
      sink
    );

    tracker.track(makeRecord());

    // candle with outlier high=8.63 but close=1.03 (정상 1~3% 변동)
    await tracker.onCandle(makeCandle(0, { open: 1.0, high: 8.63, low: 0.95, close: 1.03 }));
    // horizon을 충족시키는 candle
    await tracker.onCandle(makeCandle(15, { open: 1.03, high: 1.05, low: 0.98, close: 1.02 }));

    expect(sink.records).toHaveLength(1);
    const outcome = sink.records[0].horizons[0];

    // close 기반: maxHigh = max(1.0, 1.03, 1.02) = 1.03 → MFE = 3%
    // high 기반이었다면: maxHigh = 8.63 → MFE = 763% (버그)
    expect(outcome.mfePct).toBeCloseTo(0.03, 4);
    // close 기반: minLow = min(1.0, 1.03, 1.02) = 1.0 → MAE = 0%
    expect(outcome.maePct).toBeCloseTo(0, 4);
  });

  it('clamps MFE at MAX_MFE_PCT (9.0 = +900%)', async () => {
    const sink = new MockSink();
    const tracker = new RealtimeOutcomeTracker(
      { horizonsSec: [15], observationIntervalSec: 15 },
      sink
    );

    // referencePrice=1.0, close=15.0 → raw MFE = 1400% > 900%
    tracker.track(makeRecord());
    await tracker.onCandle(makeCandle(0, { open: 1.0, high: 20.0, low: 1.0, close: 15.0 }));

    expect(sink.records).toHaveLength(1);
    // clamp: min(14.0, 9.0) = 9.0
    expect(sink.records[0].horizons[0].mfePct).toBe(9.0);
  });

  it('clamps MAE at MAX_MAE_PCT (-0.99 = -99%)', async () => {
    const sink = new MockSink();
    const tracker = new RealtimeOutcomeTracker(
      { horizonsSec: [15], observationIntervalSec: 15 },
      sink
    );

    // referencePrice=1.0, close=0.001 → raw MAE = -99.9% < -99%
    tracker.track(makeRecord());
    await tracker.onCandle(makeCandle(0, { open: 1.0, high: 1.0, low: 0.0001, close: 0.001 }));

    expect(sink.records).toHaveLength(1);
    // clamp: max(-0.999, -0.99) = -0.99
    expect(sink.records[0].horizons[0].maePct).toBe(-0.99);
  });

  it('tracks MFE correctly across multiple candles', async () => {
    const sink = new MockSink();
    const tracker = new RealtimeOutcomeTracker(
      { horizonsSec: [45], observationIntervalSec: 15 },
      sink
    );

    tracker.track(makeRecord());

    // 점진적 상승: close 1.02 → 1.05 → 1.03
    await tracker.onCandle(makeCandle(0, { open: 1.0, high: 1.10, low: 0.95, close: 1.02 }));
    await tracker.onCandle(makeCandle(15, { open: 1.02, high: 1.08, low: 1.01, close: 1.05 }));
    await tracker.onCandle(makeCandle(30, { open: 1.05, high: 1.06, low: 1.02, close: 1.03 }));

    expect(sink.records).toHaveLength(1);
    const outcome = sink.records[0].horizons[0];

    // maxHigh from closes: max(1.0, 1.02, 1.05, 1.03) = 1.05 → MFE = 5%
    expect(outcome.mfePct).toBeCloseTo(0.05, 4);
    // minLow from closes: min(1.0, 1.02, 1.05, 1.03) = 1.0 → MAE = 0%
    expect(outcome.maePct).toBeCloseTo(0, 4);
    // returnPct: (1.03 - 1.0) / 1.0 = 3%
    expect(outcome.returnPct).toBeCloseTo(0.03, 4);
  });

  it('uses close-based MFE for recentCandles passed to track()', async () => {
    const sink = new MockSink();
    const tracker = new RealtimeOutcomeTracker(
      { horizonsSec: [15], observationIntervalSec: 15 },
      sink
    );

    // recentCandles에 outlier high 포함된 candle 주입
    const outlierCandle = makeCandle(0, { open: 1.0, high: 10.0, low: 0.1, close: 1.05 });
    tracker.track(makeRecord(), [outlierCandle]);

    expect(sink.records).toHaveLength(1);
    // close 기반: maxClose = max(1.0, 1.05) = 1.05 → MFE = 5%
    // high 기반이었다면: 10.0 → MFE = 900%
    expect(sink.records[0].horizons[0].mfePct).toBeCloseTo(0.05, 4);
    // close 기반: minClose = min(1.0, 1.05) = 1.0 → MAE = 0%
    // low 기반이었다면: 0.1 → MAE = -90%
    expect(sink.records[0].horizons[0].maePct).toBeCloseTo(0, 4);
  });

  it('ignores candles with different intervalSec', async () => {
    const sink = new MockSink();
    const tracker = new RealtimeOutcomeTracker(
      { horizonsSec: [15], observationIntervalSec: 15 },
      sink
    );

    tracker.track(makeRecord());

    // 60sec interval candle — should be ignored by onCandle
    const wrongInterval: Candle = {
      ...makeCandle(0, { open: 1.0, high: 5.0, low: 0.5, close: 2.0 }),
      intervalSec: 60,
    };
    await tracker.onCandle(wrongInterval);

    // 정상 15sec candle
    await tracker.onCandle(makeCandle(0, { open: 1.0, high: 1.02, low: 0.99, close: 1.01 }));

    expect(sink.records).toHaveLength(1);
    // wrongInterval candle의 close=2.0이 반영되지 않아야 함
    expect(sink.records[0].horizons[0].mfePct).toBeCloseTo(0.01, 4);
  });
});
