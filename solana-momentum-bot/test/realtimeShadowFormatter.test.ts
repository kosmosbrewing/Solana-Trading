import { buildRealtimeShadowSummaryMessage } from '../src/notifier/realtimeShadowFormatter';
import { RealtimeShadowReport } from '../src/reporting';

describe('buildRealtimeShadowSummaryMessage', () => {
  it('formats a realtime shadow digest for Telegram', () => {
    const report: RealtimeShadowReport = {
      generatedAt: '2026-03-22T00:00:00.000Z',
      datasetDir: '/tmp/realtime-session-1',
      horizonSec: 30,
      counts: {
        swaps: 120,
        candles: 40,
        signals: 2,
      },
      summary: {
        totalSignals: 2,
        executedSignals: 1,
        gateRejectedSignals: 1,
        avgGateLatencyMs: 12,
        p50GateLatencyMs: 10,
        p95GateLatencyMs: 20,
        avgSignalToFillLatencyMs: 80,
        p50SignalToFillLatencyMs: 80,
        p95SignalToFillLatencyMs: 90,
        selectedHorizonSec: 30,
        avgReturnPct: 0.012,
        avgAdjustedReturnPct: 0.011,
        avgMfePct: 0.02,
        avgMaePct: -0.01,
        assessment: {
          edgeScore: 62,
          stageScore: 68,
          decision: 'retune',
          gateStatus: 'pass',
          gateReasons: [],
          breakdown: {
            netPnl: 10,
            expectancy: 15,
            profitFactor: 12,
            sharpe: 10,
            maxDrawdown: 8,
            totalTrades: 13,
            total: 68,
            maxPossible: 100,
            normalized: 68,
          },
        },
      },
      statusCounts: [
        { status: 'executed_paper', count: 1 },
        { status: 'gate_rejected', count: 1 },
      ],
      reasonCounts: [
        { reason: 'insufficient_primary_candles', count: 1 },
      ],
      latestSignal: {
        id: 'sig-1',
        pairAddress: 'PAIR1234567890',
        signalTimestamp: '2026-03-22T00:00:00.000Z',
        completedAt: '2026-03-22T00:01:00.000Z',
        status: 'executed_paper',
        adjustedReturnPct: 0.015,
      },
      admission: {
        trackedPools: 4,
        allowedPools: 3,
        blockedPools: 1,
        blockedDetails: [
          {
            pool: 'BLOCKEDPOOL123456789',
            observedNotifications: 88,
            parseRatePct: 0,
            skippedRatePct: 96.59,
          },
        ],
      },
    };

    const message = buildRealtimeShadowSummaryMessage(report);

    expect(message).toContain('📡 <b>Realtime Shadow Report</b>');
    expect(message).toContain('swaps 120 / candles 40 / signals 2');
    expect(message).toContain('Horizon 30s: avg +1.1%');
    expect(message).toContain('executed_paper: 1');
    expect(message).toContain('insufficient_primary_candles: 1');
    expect(message).toContain('PAIR1234...7890');
    expect(message).toContain('tracked 4 / allowed 3 / blocked 1');
  });
});
