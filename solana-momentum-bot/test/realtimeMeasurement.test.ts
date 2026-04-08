import { RealtimeSignalRecord, summarizeRealtimeSignals, summarizeRealtimeSignalsByStrategy } from '../src/reporting';

function makeRecord(): RealtimeSignalRecord {
  return {
    version: 1,
    id: 'sample-1',
    source: 'runtime',
    strategy: 'volume_spike',
    pairAddress: 'pool-1',
    poolAddress: 'pool-1',
    tokenMint: 'pool-1',
    signalTimestamp: '2026-03-22T00:00:00.000Z',
    referencePrice: 1,
    estimatedCostPct: 0.01,
    trigger: {
      primaryIntervalSec: 15,
      confirmIntervalSec: 60,
      primaryCandleCloseSec: 100,
      volumeRatio: 3.2,
      breakoutHigh: 0.98,
      atr: 0.04,
    },
    orderPreview: {
      stopLoss: 0.94,
      takeProfit1: 1.09,
      takeProfit2: 1.18,
      trailingStop: 0.06,
      plannedRiskPct: 0.06,
    },
    gate: {
      startedAt: '2026-03-22T00:00:00.000Z',
      endedAt: '2026-03-22T00:00:00.120Z',
      latencyMs: 120,
      rejected: false,
      breakoutScore: 78,
      breakoutGrade: 'A',
    },
    processing: {
      startedAt: '2026-03-22T00:00:00.120Z',
      endedAt: '2026-03-22T00:00:00.280Z',
      latencyMs: 160,
      status: 'executed_paper',
      txSignature: 'PAPER_TRADE',
    },
    context: {
      discoveryTimestamp: '2026-03-21T23:59:30.000Z',
      triggerWarmupLatencyMs: 30000,
    },
    horizons: [
      {
        horizonSec: 180,
        observedAt: '2026-03-22T00:03:00.000Z',
        price: 1.15,
        returnPct: 0.15,
        adjustedReturnPct: 0.14,
        mfePct: 0.18,
        maePct: -0.02,
      },
    ],
    summary: {
      completedAt: '2026-03-22T00:03:00.000Z',
      maxObservedSec: 180,
      mfePct: 0.18,
      maePct: -0.02,
    },
  };
}

describe('summarizeRealtimeSignals', () => {
  it('computes latency and measurement scores from realtime records', () => {
    const summary = summarizeRealtimeSignals([makeRecord()], 180);

    expect(summary.totalSignals).toBe(1);
    expect(summary.executedSignals).toBe(1);
    expect(summary.avgAdjustedReturnPct).toBeCloseTo(0.14, 6);
    expect(summary.avgGateLatencyMs).toBe(120);
    expect(summary.avgSignalToFillLatencyMs).toBe(280);
    expect(summary.avgTriggerWarmupLatencyMs).toBe(30000);
    expect(summary.assessment.edgeScore).toBeGreaterThan(0);
  });
});

describe('summarizeRealtimeSignalsByStrategy', () => {
  it('provides overall + per-strategy breakdown for mixed strategies', () => {
    const vsRecord = makeRecord();
    const fbRecord: RealtimeSignalRecord = {
      ...makeRecord(),
      id: 'sample-2',
      strategy: 'fib_pullback',
      horizons: [
        {
          horizonSec: 180,
          observedAt: '2026-03-22T00:03:00.000Z',
          price: 0.92,
          returnPct: -0.08,
          adjustedReturnPct: -0.09,
          mfePct: 0.01,
          maePct: -0.10,
        },
      ],
    };

    const breakdown = summarizeRealtimeSignalsByStrategy([vsRecord, fbRecord], 180);

    expect(breakdown.overall.totalSignals).toBe(2);
    expect(Object.keys(breakdown.byStrategy)).toEqual(
      expect.arrayContaining(['volume_spike', 'fib_pullback'])
    );
    expect(breakdown.byStrategy['volume_spike'].totalSignals).toBe(1);
    expect(breakdown.byStrategy['volume_spike'].avgAdjustedReturnPct).toBeCloseTo(0.14, 6);
    expect(breakdown.byStrategy['fib_pullback'].totalSignals).toBe(1);
    expect(breakdown.byStrategy['fib_pullback'].avgAdjustedReturnPct).toBeCloseTo(-0.09, 6);
  });

  it('returns single strategy in byStrategy for uniform input', () => {
    const breakdown = summarizeRealtimeSignalsByStrategy([makeRecord()], 180);

    expect(breakdown.overall.totalSignals).toBe(1);
    expect(Object.keys(breakdown.byStrategy)).toEqual(['volume_spike']);
  });

  it('groups signals into byCohort and zero-fills missing cohorts', () => {
    // Why: Phase 1 fresh-cohort instrumentation — cohort 축 집계가 signal 관점에서도
    //      유지되어야 fresh 분포를 리포트에서 바로 읽을 수 있다.
    const freshRecord: RealtimeSignalRecord = { ...makeRecord(), id: 'fresh-1', cohort: 'fresh' };
    const matureRecord: RealtimeSignalRecord = { ...makeRecord(), id: 'mature-1', cohort: 'mature' };
    // cohort 미지정 → 'unknown' 으로 귀속되어야 한다.
    const legacyRecord: RealtimeSignalRecord = { ...makeRecord(), id: 'legacy-1' };

    const breakdown = summarizeRealtimeSignalsByStrategy(
      [freshRecord, matureRecord, legacyRecord],
      180
    );

    expect(breakdown.byCohort).toBeDefined();
    const byCohort = breakdown.byCohort!;
    expect(byCohort.fresh.totalSignals).toBe(1);
    expect(byCohort.mature.totalSignals).toBe(1);
    expect(byCohort.unknown.totalSignals).toBe(1);
    // 빈 cohort 도 zero-filled summary 로 키가 존재해야 한다 (downstream optional-chain 제거용).
    expect(byCohort.mid).toBeDefined();
    expect(byCohort.mid.totalSignals).toBe(0);

    // Why: empty mid slot 이 다른 slot 과 참조 공유가 아니어야 한다 (mutation footgun 방지).
    //      같은 factory 로 독립 인스턴스가 만들어져 서로 다른 참조를 가져야 한다.
    expect(byCohort.mid).not.toBe(byCohort.unknown);
  });

  it('builds byCohortStrategy cross-aggregation keyed by `${cohort}:${strategy}`', () => {
    const freshVolume: RealtimeSignalRecord = {
      ...makeRecord(),
      id: 'fv-1',
      cohort: 'fresh',
      strategy: 'volume_spike',
    };
    const matureVolume: RealtimeSignalRecord = {
      ...makeRecord(),
      id: 'mv-1',
      cohort: 'mature',
      strategy: 'volume_spike',
    };
    const freshFib: RealtimeSignalRecord = {
      ...makeRecord(),
      id: 'ff-1',
      cohort: 'fresh',
      strategy: 'fib_pullback',
    };

    const breakdown = summarizeRealtimeSignalsByStrategy(
      [freshVolume, matureVolume, freshFib],
      180
    );

    expect(breakdown.byCohortStrategy).toBeDefined();
    const cross = breakdown.byCohortStrategy!;
    // 3 개 cross 키가 존재해야 하고, 비어있는 조합은 포함되지 않아야 한다.
    expect(Object.keys(cross).sort()).toEqual([
      'fresh:fib_pullback',
      'fresh:volume_spike',
      'mature:volume_spike',
    ]);
    expect(cross['fresh:volume_spike'].totalSignals).toBe(1);
    expect(cross['mature:volume_spike'].totalSignals).toBe(1);
    expect(cross['fresh:fib_pullback'].totalSignals).toBe(1);
  });

  it('labels records missing cohort as "unknown:<strategy>" in cross breakdown', () => {
    const breakdown = summarizeRealtimeSignalsByStrategy([makeRecord()], 180);
    expect(breakdown.byCohortStrategy).toBeDefined();
    expect(Object.keys(breakdown.byCohortStrategy!)).toEqual(['unknown:volume_spike']);
  });

  it('omits byCohort / byCohortStrategy entirely when input is empty', () => {
    const breakdown = summarizeRealtimeSignalsByStrategy([], 180);
    expect(breakdown.byCohort).toBeUndefined();
    expect(breakdown.byCohortStrategy).toBeUndefined();
  });
});
